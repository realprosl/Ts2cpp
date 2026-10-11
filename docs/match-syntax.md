# Sintaxis `match` del dialecto Estatic (V30)

V30 unifico **toda la sintaxis de `match`** a la **forma V23** (intrinseca,
TS-compatible). La forma V2 destructurada (`match (r) { case { kind: "...",
bindings }: ...; }`) se elimino por completo en V30. Razon principal: la
sintaxis V2 no es TypeScript estandar, y el LSP de TS subrayaba `match`,
`case`, `kind:` con errores rojos aunque el codigo compilara bien.

## TL;DR — la UNICA forma valida

```ets
// Sin discriminator (match por valor):
const label: string = match(n, [
  when(0, (v: number): string => "cero"),
  when(1, (v: number): string => "uno"),
  otherwise((): string => "otro"),
]);

// Con discriminator (match por campo `kind`):
const msg: string = match(r, "kind", [
  when("Success", (v: R): string => "ok"),
  when("Failure", (v: R): string => "err"),
]);

// Con whenType<T> (narrowing real en C++):
const kind: string = match(v, [
  whenType<string>(() => "str"),
  whenType<number>(() => "num"),
]);
```

## Formas validas (V30)

| Forma                                  | C++ emitido                                    | Narrowing |
|----------------------------------------|------------------------------------------------|-----------|
| `match(v, [when(pat, cb)])`            | Cadena de `if/else` con comparacion            | No        |
| `match(v, "key", [when(pat, cb)])`    | `switch (v.key) { case pat: cb(); break; ...}`| No        |
| `match(v, [whenType<T>(cb)])`          | `if (std::holds_alternative<T>(v)) { ... }`    | **Si** (callback recibe valor narrowed) |
| `match(v, [otherwise(cb)])`            | Sin condicion (siempre ejecuta cb)             | No        |

`whenType<T>` narrowa el subject (con `std::holds_alternative<T>` +
`std::get<T>`) y pasa el valor narrowed al callback. Las demas formas
no narrowan; el callback recibe el subject entero.

## Por que se elimino la forma V2 (`match (v) { case { kind: ... }: ... }`)

- **No es TS-compatible**: el LSP subraya `match`, `case`, y `{ kind: ... }`
  con errores rojos. No compila ni en `tsc --noEmit`.
- **El narrowing real no se puede replicar sin extension** (TC39 stage 1).
- **Dificil de mantener**: requiere un parser de patterns destructurados
  paralelo al de TS.

V30 lo elimino. Si necesitas destructuring + narrowing, usa `whenType<T>`
o el callback con `if` adentro.

## Ejemplo completo

```ets
union FileError = NotFound(string) | PermissionDenied | IOError(string);

function describe(err: FileError): string {
  return match(err, "kind", [
    when("NotFound",        (e: FileError): string => "missing"),
    when("PermissionDenied", (e: FileError): string => "denied"),
    when("IOError",         (e: FileError): string => "io-error"),
    otherwise((): string => "other"),
  ]);
}
```

## Cuadro comparativo de la evolucion

| Version | Sintaxis                                       | TS-compatible | Narrowing |
|---------|------------------------------------------------|---------------|-----------|
| V1.10   | `match v { case 0: ...; case 1: ...; case _: ...; }` | No (con case keyword) | No |
| V2      | `match (r) { case { kind: "X", x }: ...; }`    | No            | **Si**    |
| V23     | `match(r, [when(pat, cb), otherwise(cb)])`     | **Si**        | Solo con `whenType<T>` |
| V30     | (V23 es la unica forma)                        | **Si**        | Solo con `whenType<T>` |

V30 **rompe** la sintaxis V2 deliberadamente. Migracion:

```ets
// Antes (V2, eliminado en V30):
return match (r) {
  case { kind: "Ok", v }: "ok:" + v;
  case { kind: "Err", e }: "err:" + e;
};

// Despues (V23, unica forma valida en V30):
return match(r, "kind", [
  when("Ok",  (x: R): string => {
    // narrowing manual con if + cast:
    if (x.kind === "Ok") return "ok";
    return "?";
  }),
  when("Err", (x: R): string => {
    return "err";
  }),
]);
```

## Migracion desde V1.10 (TC39)

```ets
// V1.10 (eliminado en V23):
function classify(x: number): string {
  return match (x) {
    when (0) => "zero";
    when (1) => "one";
    when (_) => "many";
  };
}

// V23 (y V30):
function classify(x: number): string {
  return match(x, [
    when(0, (v: number): string => "zero"),
    when(1, (v: number): string => "one"),
    otherwise((): string => "many"),
  ]);
}
```

Notas de la migracion:
- `when (p) => r` → `when(p, (v: T): R => r)`. El callback lleva tipo
  explicito.
- `when (_) => r` → `otherwise((): R => r)`.
- Los parentesis alrededor del sujeto (`match (x)`) se quitan; la
  nueva forma es `match(x, [...])` sin parentesis extra.
- Las llaves `{ ... }` se reemplazan por corchetes `[ ... ]`.

## Migracion desde V2 (a V30)

```ets
// V2 (eliminado en V30):
return match (r) {
  case { kind: "Ok", v }: v;
  case { kind: "Err", e }: e.length;
};

// V30:
return match(r, "kind", [
  when("Ok",  (x: R): string => {
    // x.kind === "Ok" aqui; x es R. Para acceder al payload narrowed
    // usa whenType o un cast.
    if (x.kind === "Ok") return "ok";
    return "?";
  }),
  when("Err", (x: R): string => {
    if (x.kind === "Err") return "err";
    return "?";
  }),
]);
```

## Intrinsics

| Intrinsic                | Argumentos                              | Callback  | Semantica                                                                 |
|--------------------------|-----------------------------------------|-----------|---------------------------------------------------------------------------|
| `when(pattern, callback)`| `pattern: T`, `callback: (T) => R` u `() => R` | 0 o 1 | Si `value == pattern`, ejecuta el callback pasando `value`.               |
| `whenType<T>(callback)`  | `callback: () => R`                     | 0         | Si subject es union: `holds_alternative<T>` + `get<T>` (V23.2). Si no, primer `whenType` siempre-activo. |
| `otherwise(callback)`    | `callback: (any) => R` u `() => R`      | 0 o 1     | Default. Se ejecuta si ningun `when` previo matcheo.                      |

## Arrow functions requieren tipo explicito

El dialecto NO infiere el tipo del parametro en arrow functions (no
hay inference contextual como en TypeScript). Esto significa:

```ets
// Correcto: tipo explicito en el lambda.
when(0, (v: number): string => "cero")

// Error de parser: "Los parametros de una funcion flecha necesitan tipo".
when(0, (v) => "cero")
```

## Diagnosticos

| Codigo  | Significado                                                                |
|---------|----------------------------------------------------------------------------|
| E4400   | `when (p) => r` dentro de `match` V2 (eliminado en V30).                   |
| E4401   | `when`/`whenType`/`otherwise` usado fuera de un `match(...)`.              |
| E4402   | `match` espera un array de cases como 2º (o 3º) argumento.                |
| E4403   | `match` con 3 argumentos espera un string literal como discriminator.     |
| E4404   | `when` espera 2 args (pattern, callback); `whenType`/`otherwise` 1 arg.  |
| E4405   | `whenType`/`otherwise` callback debe ser arrow function.                   |
| E4406   | `when`/`whenType`/`otherwise` callback debe tener 0 o 1 parametros.       |
| E4407   | `whenType<T>` requiere exactamente 1 type argument.                        |
| E4408   | `match` cases no admite spread elements (`...`).                          |
| E4409   | `match` cases deben ser `when`/`whenType`/`otherwise`.                    |
| E4410   | Forma V2 (`match (r) { case ... }`) eliminada en V30.                       |

## Limitaciones V23 (y V30)

- **`whenType` sobre subject no-union**: solo el primer `whenType` es
  la rama activa; los siguientes se marcan como `unreachable`.
  Cuando el subject ES union, todos los `whenType` participan (cada
  uno con su `T_i` via `std::holds_alternative<T>` + `std::get<T>`)
  y reciben el valor narrowed en el callback.
- **Sin exhaustividad enforced**: si no hay `otherwise` y el subject
  no matchea ningún `when`/`whenType`, el runtime hace `std::abort()`.
  El compilador no avisa (en V30, no enforce porque V2 se elimino).
  En compilacion se ve un warning de GCC/Clang
  `control reaches end of non-void function`.
- **Sin pattern destructuring en `when`**: `when` solo compara
  igualdad (`==`). Para destructuring, usa la API de `Result<>`.
- **Sin ranges**: `when(0..10, cb)` no se soporta. Usa varios `when`
  consecutivos.
- **Sin guards**: `when(x, x > 0, cb)` no se soporta. Usa una
  funcion helper o un `if` antes del `match`.

## Como se compila

El codegen intercepta la `CallExpression` con `matchedKind === "match"`
(que el type-checker marca durante la fase semantica) y emite un IIFE
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
