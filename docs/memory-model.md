# Memory Model v2

> V22 introduce un modelo de memoria explícito. La semántica visible de
> Estatic determina exactamente **copia**, **ownership** y **préstamo**,
> sin optimizaciones ABI ocultas.

## Tabla resumen

| Quiero…                              | Tipo        | C++                              |
|--------------------------------------|-------------|----------------------------------|
| Una copia independiente              | `T`         | `T`                              |
| Modificar temporalmente otro objeto  | `ref<T>`    | `T&`                             |
| Leer temporalmente sin copiar        | `constRef<T>` | `const T&`                     |
| Poseer dinámicamente un objeto       | `ptr<T>`    | `std::unique_ptr<T>`             |
| Poseer pero exponerlo readonly       | `constPtr<T>` | `std::unique_ptr<const T>`    |

## Reglas

### 1. `T` significa copia

Este es el cambio semántico principal. **Antes de V22**, el dialecto
convertía automáticamente parámetros no triviales a `const T&`. Eso era
una optimización ABI oculta. **V22 la elimina**.

```ets
function foo(value: User): void {
    value.name = "changed";  // copia local
}
let user: User = new User("original");
foo(user);
print(user.name);  // "original" — la copia no afectó al caller
```

### 2. `ref<T>` es un préstamo mutable

`ref<T>` modela una referencia C++ mutable (`T&`). El caller mantiene el
ownership; el callee puede mutar el valor durante la llamada.

```ets
function increment(counter: ref<Counter>): void {
    counter.value = counter.value + 1;
}
```

**No incrementa** reference count, no participa en ownership. **No puede
ser null**.

### 3. `constRef<T>` es un préstamo readonly

`constRef<T>` modela `const T&`. El caller mantiene el ownership; el
callee solo lee.

```ets
function inspect(user: constRef<User>): void {
    print(user.name);
}
```

### 4. `ptr<T>` es ownership exclusivo mutable

`ptr<T>` se traduce a `std::unique_ptr<T>`. Es **move-only**, **owning**,
**nullable** (después de move).

```ets
function make(): ptr<Counter> {
    return new Counter(42);
}
```

El destructor del objeto se llama automáticamente cuando el último owner
sale del scope (RAII). `ptr<T>` no se copia; se transfiere vía `move()`.

### 5. `constPtr<T>` es ownership exclusivo readonly

`constPtr<T>` se traduce a `std::unique_ptr<const T>`. El callee puede
leer el valor pero no mutarlo.

```ets
function inspect(c: constPtr<Counter>): number {
    return c.value;  // OK
    // c.value = 1;  // ERROR
}
```

## Matriz de conversión V1

| Desde ↓ / hacia → | T        | ptr<T>      | constPtr<T> | ref<T>      | constRef<T>  |
|-------------------|----------|-------------|-------------|-------------|--------------|
| `T`               | copy     | ❌          | ❌          | **borrow**  | **borrow**   |
| `ptr<T>`          | ❌       | move        | move        | borrow      | borrow       |
| `constPtr<T>`     | ❌       | ❌          | move        | ❌          | borrow       |
| `ref<T>`          | copy*    | ❌          | ❌          | borrow      | borrow       |
| `constRef<T>`     | copy*    | ❌          | ❌          | ❌          | borrow       |

\* solo si `T` es copy-constructible.

**Nunca se permite** `borrow → owner`: un préstamo no puede adquirir
ownership.

## Borrado de APIs legacy

V22 elimina las siguientes APIs. El type-checker emite diagnósticos
E4400-E4406:

| Legacy       | Reemplazo V22                | Diagnóstico |
|--------------|------------------------------|-------------|
| `mut`        | `ref<T>`                     | E4400       |
| `Mut<T>`     | `ptr<T>` o `ref<T>`          | E4401       |
| `MutRef<T>`  | `ref<T>`                     | E4402       |
| `Unq<T>`     | `ptr<T>`                     | E4403       |
| `Rc<T>`      | `ptr<T>` (warning)           | E4404       |
| `out T`      | `Result<T>` (soft, warning)  | E4405       |
| `class ptr`  | (reservado)                  | E4406       |

## Estado actual de V22 (sub-PRs entregados)

| Sub-PR | Estado | Resumen |
|--------|--------|---------|
| **PR#1 — Tipos** | ✅ entregado (v0.27.0) | `ptr<T>`, `constPtr<T>`, `ref<T>`, `constRef<T>` + matriz de conversión |
| **PR#2 — Value semantics** | ✅ entregado | Coerción `T` → `ptr<T>` cuando el destino se declara `ptr<T>` y el initializer es `new T(...)`. El codegen emite `std::make_unique<T>(...)` automáticamente |
| **PR#3 — Borrows (V1)** | 🟡 parcial | Implementadas: `no fields ref<T>` (E4203), `no retornos ref<T>` (E42xx), `no borrows en async` (E4204), `no borrows como argumentos genéricos` (E4205). Pendiente: aliasing mutable (ref + ref) — ver PR#6 |
| **PR#4 — make_unique** | ✅ entregado | Emisión automática en declaraciones `let x: ptr<T> = new T(...)` y `const x: ptr<T> = new T(...)` |
| **PR#5 — Moves** | ✅ entregado | `move(x)` se reconoce y emite `std::move(x)`. El checker marca la variable como `moved`/`maybe-moved` y rechaza usos posteriores con E4102/E4103. Join correcto entre ramas de `if/else` (preserva `Available` o degrada a `maybe-moved`) |
| **PR#6 — Borrow conflicts** | ❌ pendiente | Aliasing mutable (`ref + ref`, `ref + constRef`) no se detecta aún |

## Diagnósticos implementados

| Código | Significado |
|--------|-------------|
| **E4102** | Uso de una variable `ptr<T>` después de haber sido movida (`move(x)`) |
| **E4103** | Uso de una variable `ptr<T>` después de `move()` cuando puede estar movida (rama `if/else`) |
| **E4203** | `ref<T>` / `constRef<T>` almacenado en un campo de clase — los préstamos no pueden sobrevivir al owner |
| **E4204** | `ref<T>` / `constRef<T>` como parámetro en una función `async` — podrían colgar durante una suspensión |
| **E4205** | `ref<T>` / `constRef<T>` como argumento de tipo en un genérico (`Array<ref<T>>` no tiene sentido) |
| **E42xx** | `ref<T>` / `constRef<T>` como tipo de retorno — requiere análisis de lifetimes, no soportado aún |
| **E4400–E4406** | APIs legacy rechazadas (`mut`, `Mut<T>`, `MutRef<T>`, `Unq<T>`, `Rc<T>`, `out`) |

## Lo que V22 **no** soporta todavía

Ver `LIMITATIONS.md` §"Memory Model v2 — pendiente" para la lista
completa. Resumen del trabajo restante:

- **PR#6 — Borrow conflicts**: aliasing mutable (`ref + ref`, `ref +
  constRef`) no se detecta aún.
- **PR#7 — Async/closures/generics**: las restricciones V1 (no capturas
  escaping de `ref<T>`, no copy de move-only en generics) no se enforce.
- **`Rc<T>`** (shared ownership): rediseñado con `weak<T>` en PR futuro.
- **Lifetime parameters** (`<'a>`): no soportados.
- **Non-lexical lifetimes**: solo se implementará el modelo léxico
  básico (el préstamo termina al salir del bloque).

## Cómo migrar

Ver `CHANGELOG.md` § v0.27.0 para la guía de migración mecánica.
Resumen:

```diff
- function foo(mut x: User): void {}
+ function foo(x: ref<User>): void {}

// MutRef<T> → ref<T>
// Mut<T>   → ref<T> o ptr<T> (depende del caso)
// Unq<T>   → ptr<T>
// Rc<T>    → ptr<T> (warning)
```
