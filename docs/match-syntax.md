# Sintaxis `match` del dialecto Estatic

V23 introduce la forma TS-compatible `match(value, [when(...), ...])` y
mantiene la forma V2 destructurada `match (r) { case { kind: ..., ... }:
...; }`. Esta página documenta las dos formas y cómo se relacionan.

## TL;DR

```ets
// V23: sintaxis TS-compatible. Expresiones, no statements.
const label: string = match(n, [
  when(0, (v: number): string => "cero"),
  when(1, (v: number): string => "uno"),
  otherwise((): string => "otro"),
]);

// V2: pattern destructuring sobre tagged unions. Exhaustivo.
const msg: string = match (r) {
  case { kind: "Success", s }: "ok:" + s;
  case { kind: "Failure", n }: "err:" + numberToString(n);
};
```

**Cuándo usar cada una**:

| Caso                                                              | Forma       |
|-------------------------------------------------------------------|-------------|
| Dispatch por valor (`when(0, ...)`, `when("a", ...)`)             | V23 nueva   |
| Dispatch por tipo sobre union (`whenType<T>`)                    | V23 nueva (V23.2) |
| Tagged unions con payload que extraer                             | V2 actual   |
| Type dispatching sin acceso al valor narrowed                     | V23 nueva (`whenType` con 0 args) |
| Exhaustividad enforced en compilación                             | V2 actual   |

## V23: `match(value, [...])`

### Forma 1: value matching (sin discriminator)

```ets
match(value, [
  when(pattern1, callback1),
  when(pattern2, callback2),
  otherwise(defaultCallback),
])
```

Cada `when(p, cb)` se compila a `if (value == p) return cb(value);` (o
`cb()` si el callback tiene 0 parámetros). El último `otherwise(cb)` (o
el primer `whenType`, en orden de aparición) se usa como `else` del
último `if`. Si no hay `otherwise` ni `whenType`, el else final es
`std::abort()`.

**Sin narrowing para `when` por valor**: `match(value, [...])` con
`when(0, cb)` no usa `std::holds_alternative`; solo compara con `==`.
Para type dispatching real, usa `whenType` (que sí narrowa en V23.2) o
la forma V2.

### Forma 2: con discriminator (string key)

```ets
match(value, "key", [
  when("a", (v: T): R => ...),
  when("b", (v: T): R => ...),
])
```

El codegen emite `if (value.key == "a") return cb(value); else if
(value.key == "b") return cb(value);`. Útil para clases con campo
`kind`:

```ets
class Fake { kind: string; payload: number; }

function f(r: Fake): string {
  return match(r, "kind", [
    when("a", (x: Fake): string => "A:" + numberToString(x.payload)),
    when("b", (x: Fake): string => "B:" + numberToString(x.payload)),
  ]);
}
```

### `whenType<T>(callback)` — V23.2 narrowa con unions

```ets
function f(v: number | string): string {
  return match(v, [
    whenType<number>(() => "num"),
    whenType<string>(() => "str"),
  ]);
}

print(f(42));     // "num"
print(f("hi"));   // "str"
```

**V23.2**: cuando el subject es una union (`T1 | T2 | ...`), el codegen
emite `std::holds_alternative<T_i>(v)` encadenado para cada `whenType<T_i>`.
Esto es narrowing real (a nivel de C++, no solo del LSP). El primer
`whenType` que matchea ejecuta su callback.

**Limitación**: el callback se invoca **sin argumentos** (no se le pasa
el subject narrowed a `T`). Si necesitas acceder al valor narrowed en
el callback, usa la forma V2 destructurada:

```ets
union V = S(string) | N(number);
function f(v: V): string {
  return match (v) {
    case { kind: "S", value }: "string:" + value;  // value es string aqui
    case { kind: "N", value }: "number:" + numberToString(value);
  };
}
```

Si el subject NO es union (caso degenerado: `whenType<number>` sobre un
`v: number` puro), el `whenType` cae al comportamiento legacy: solo el
primero es la rama activa, los siguientes se marcan como `unreachable`.

### Tabla de los 3 intrinsics

| Intrinsic                | Argumentos                              | Callback  | Semántica                                                                 |
|--------------------------|-----------------------------------------|-----------|---------------------------------------------------------------------------|
| `when(pattern, callback)`| `pattern: T`, `callback: (T) => R` u `() => R` | 0 o 1 | Si `value == pattern`, ejecuta el callback pasando `value`.               |
| `whenType<T>(callback)`  | `callback: () => R`                     | 0         | Si subject es union: `holds_alternative<T>` + `get<T>` (V23.2). Si no, primer `whenType` siempre-activo. |
| `otherwise(callback)`    | `callback: (any) => R` u `() => R`      | 0 o 1     | Default. Se ejecuta si ningún `when` previo matcheó.                      |

### Arrow functions requieren tipo explícito

El dialecto NO infiere el tipo del parámetro en arrow functions (no
hay inference contextual como en TypeScript). Esto significa:

```ets
// Correcto: tipo explícito en el lambda.
when(0, (v: number): string => "cero")

// Error de parser: "Los parámetros de una función flecha necesitan tipo".
when(0, (v) => "cero")
```

## V2: `match (subject) { case ...; case ... }`

La forma V2 sigue intacta. Se usa para tagged unions:

```ets
union Result<T, E> = Ok(T) | Err(E);

function unwrap<T, E>(r: Result<T, E>): T {
  return match (r) {
    case { kind: "Ok", value }: value;
    case { kind: "Err", error }: throw("unwrapped an Err: " + error);
  };
}
```

**Exhaustividad enforced**: el type-checker rechaza el programa si
alguna variante no está cubierta y no hay wildcard `case _:`.

## Diagnósticos

| Código  | Significado                                                                |
|---------|----------------------------------------------------------------------------|
| E4400   | `when (p) => r` dentro de `match` V2 (TC39 eliminado en V23).              |
| E4401   | `when`/`whenType`/`otherwise` usado fuera de un `match(...)`.              |
| E4402   | `match` espera un array de cases como 2º (o 3º) argumento.                |
| E4403   | `match` con 3 argumentos espera un string literal como discriminator.     |
| E4404   | `when` espera 2 args (pattern, callback); `whenType`/`otherwise` 1 arg.  |
| E4405   | `whenType`/`otherwise` callback debe ser arrow function.                   |
| E4406   | `when`/`whenType`/`otherwise` callback debe tener 0 o 1 parámetros.       |
| E4407   | `whenType<T>` requiere exactamente 1 type argument.                        |
| E4408   | `match` cases no admite spread elements (`...`).                          |
| E4409   | `match` cases deben ser `when`/`whenType`/`otherwise`.                    |

## Limitaciones V23.2

- **`whenType<T>(cb)` pasa el callback sin args**: aunque el codegen
  narrowa correctamente el subject cuando es una union, NO se pasa
  el valor narrowed al callback. Si necesitas acceder al valor
  narrowed (p.ej. para llamar a métodos del tipo), usa la forma V2
  destructurada que SI narrowa en el body del callback.
- **`whenType` sobre subject no-union**: solo el primer `whenType` es
  la rama activa; los siguientes se marcan como `unreachable`.
- **Sin exhaustividad enforced**: si no hay `otherwise` y el subject
  no matchea ningún `when`, el runtime hace `std::abort()`. El
  compilador no avisa.
- **Sin pattern destructuring en `when`**: `when` solo compara
  igualdad (`==`). Para destructuring, usa la forma V2.
- **Sin ranges**: `when(0..10, cb)` no se soporta. Usa varios `when`
  consecutivos.
- **Sin guards**: `when(x, x > 0, cb)` no se soporta. Usa una
  función helper o un `if` antes del `match`.

## Migración desde V1.10 (TC39)

```ets
// V1.10 (eliminado en V23):
function classify(x: number): string {
  return match (x) {
    when (0) => "zero";
    when (1) => "one";
    when (_) => "many";
  };
}

// V23:
function classify(x: number): string {
  return match(x, [
    when(0, (v: number): string => "zero"),
    when(1, (v: number): string => "one"),
    otherwise((): string => "many"),
  ]);
}
```

Notas de la migración:
- `when (p) => r` → `when(p, (v: T): R => r)`. El callback lleva tipo
  explícito.
- `when (_) => r` → `otherwise((): R => r)`.
- Los paréntesis alrededor del sujeto (`match (x)`) se quitan; la
  nueva forma es `match(x, [...])` sin paréntesis extra.
- Las llaves `{ ... }` se reemplazan por corchetes `[ ... ]`.

## Cómo se compila

El codegen intercepta la `CallExpression` con `matchedKind === "match"`
(que el type-checker marca durante la fase semántica) y emite un IIFE
estilo:

```cpp
auto __ets_match_result = ([&]() -> R {
    auto&& __ets_match_subj = (value);
    if (__ets_match_subj == p1) return cb1(__ets_match_subj);
    else if (__ets_match_subj == p2) return cb2(__ets_match_subj);
    else return default(__ets_match_subj);
}());
```

(El nombre de la variable temporal y la captura pueden variar entre
versiones; lo importante es la estructura: IIFE con if/else chain.)

Para la forma con discriminator, `__ets_match_subj.<key>` reemplaza al
subject directo. Para `whenType` con subject union (V23.2), el codegen
emite `std::holds_alternative<T_i>` + `std::get<T_i>` encadenados
(cada `whenType` discrimina por su T). Para `whenType` con subject
no-union, cae al comportamiento legacy (callback sin args).
