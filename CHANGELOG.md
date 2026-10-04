# Changelog

Todas las versiones siguen [Semantic Versioning](https://semver.org/).

## v0.27.1 (2026-10-04) — V22 subtareas: make_unique, move(), diagnósticos de borrows

### Added

- **V22 — `std::make_unique<T>(...)` automático**: cuando una declaración
  `let`/`const` tiene `declaredType = ptr<T>` (o `constPtr<T>`) y el
  initializer es un `new T(...)`, el codegen emite
  `std::make_unique<T>(args)` automáticamente. Antes era obligatorio
  llamar al helper manualmente. Ver test e2e `ownership/ptr-from-new`.
- **V22 — `move<T>(x)` global helper**: transfiere ownership de un
  `ptr<T>`. El codegen emite `std::move(x)` y el checker marca la
  variable como `moved`/`maybe-moved` para rechazar usos posteriores.
  El receptor (sea un parámetro `ptr<T>` o una variable local) recibe
  el unique_ptr por valor con la semántica correcta. Ver test e2e
  `ownership/move-transfer`.
- **V22 — diagnósticos de borrows**:
  - **E4102**: uso de un `ptr<T>` después de haber sido movido.
  - **E4103**: uso de un `ptr<T>` que *puede* haber sido movido en una
    rama de `if/else`.
  - **E4203**: `ref<T>` / `constRef<T>` almacenado en un campo de clase.
  - **E4204**: `ref<T>` / `constRef<T>` como parámetro de una función
    `async`.
  - **E4205**: `ref<T>` / `constRef<T>` como argumento de tipo en una
    instanciación genérica.
  - **E42xx**: `ref<T>` / `constRef<T>` como tipo de retorno (en
    `FunctionDeclaration`, métodos de clase y métodos de interface).
- **V22 — `identifierTypes` map en el codegen**: para que el acceso a
  miembros (`p.value`) sobre un identificador de tipo `ptr<T>` se
  emita como `p->value` (no `p.value`).
- **V22 — inferencia de `declaredType` en `NewExpression`**: el
  codegen propaga el `declaredType` de la declaración al `NewExpression`
  para que el helper `make_unique` use el target ownership correcto.

### Fixed

- **V22 — `argumentExpectsPtrPointer` ya no añade `&` automático**:
  antes buscaba `genericBase === "ptr"` y añadía `&` al lvalue, lo que
  en V22 rompía la compilación porque `ptr<T>` se traduce a
  `std::unique_ptr<T>` (por valor), no a `T*`. La función ahora
  devuelve `false` siempre y se documenta como hook histórico.
- **V22 — `examples/constructor-demo.ets` migrado**: usaba la sintaxis
  legacy `function increment(mut counter: Counter)`. Ahora usa
  `counter: ref<Counter>` (consistente con `mut-demo.ets`).
- **V22 — `init-project` template**: el `estatic.d.ts` generado ahora
  declara los 4 modificadores (`ptr<T>`, `constPtr<T>`, `ref<T>`,
  `constRef<T>`) + el global `move(x: ptr<T>)`. Antes declaraba los
  tipos legacy (`Mut<T>`, `MutRef<T>`, `Unq<T>`, `Rc<T>`) que V22
  rechaza.

### Tests

- Unit tests: **194/194 verde**. Dos tests nuevos en `type-checker`:
  - `type-checker V22: uso de variable movida genera E4102`
  - `type-checker V22: move en if sin else deja la variable como
    maybe-moved (E4103)`
- E2E bucket `ownership`: **7/7 verde** (los 4 V22 originales +
  `move-transfer` + `ptr-from-new` + `un-none` reorganizado).

## v0.27.0 (2026-10-04) — BREAKING: Memory Model v2

### Breaking

- **V22 — `T` significa copia**. El dialecto ya no convierte automáticamente
  un parámetro `T` a `const T&`. Si quieres evitar la copia, declara el
  parámetro con `ref<T>` o `constRef<T>`.
- **V22 — `mut` eliminado**. `function foo(mut x: T)` ya no se acepta; usa
  `function foo(x: ref<T>)`.
- **V22 — `Mut<T>`, `MutRef<T>`, `Unq<T>` eliminados**. Reemplazos:
  - `Mut<T>` → `ptr<T>` (unique ownership) o `ref<T>` (mutable borrow)
  - `MutRef<T>` → `ref<T>` (T&)
  - `Unq<T>` → `ptr<T>` (std::unique_ptr<T>)
- **V22 — `Rc<T>` deprecado**. El checker emite warning. Reemplazo: `ptr<T>`
  para ownership exclusivo; shared ownership se rediseñará con `weak<T>`.
- **V22 — `out` deprecado** (soft). `out T` se mantiene por compatibilidad
  con el mecanismo de resultados; se prefiere `Result<T>`.

### Added

- **V22 — `ptr<T>`**: ownership exclusivo mutable. Se traduce a
  `std::unique_ptr<T>`.
- **V22 — `constPtr<T>`**: ownership exclusivo readonly. Se traduce a
  `std::unique_ptr<const T>`.
- **V22 — `ref<T>`**: préstamo mutable no-null. Se traduce a `T&`.
- **V22 — `constRef<T>`**: préstamo readonly no-null. Se traduce a
  `const T&`.
- **V22 — diagnósticos E4400-E4406**: rechazo de `mut`, `Mut<T>`, `MutRef<T>`,
  `Unq<T>`, `Rc<T>` (warning) y `out` (warning).
- **V22 — `docs/memory-model.md`**: especificación canónica del modelo de
  memoria.
- **V22 — ejemplos**: `memory-values.ets`, `memory-borrows.ets`,
  `memory-ownership.ets`. Los ejemplos legacy (`mut-demo`, `mutref-demo`,
  `rc-demo`, `un-demo`) se migraron a las nuevas APIs.

### Changed

- `ParameterPassing` reducido a `"value" | "out"`. Los valores legacy
  `"automatic"`, `"mut"`, `"move"` se eliminan.
- `cppInputType` ya no aplica lowering implícito a `const T&`.
- `parameterIsMutableReference` simplificado: solo `ref<T>` califica.
- `cppMemoryType(name, inner)`: helper centralizado para mapear los 4
  modificadores a sus tipos C++.

### Migration

Migración mecánica de código existente:

```diff
- function foo(mut x: User): void {}
+ function foo(x: ref<User>): void {}

// MutRef<T> → ref<T>
- function bar(x: MutRef<Counter>): void {}
+ function bar(x: ref<Counter>): void {}

// Mut<T> — depende del caso:
//   si era valor mutable → ref<T>
//   si era puntero (transferencia) → ptr<T>
- function baz(x: Mut<Counter>): void {}
+ function baz(x: ptr<Counter>): void {}

// Unq<T> → ptr<T>
- function make(): Unq<Counter> { return unSome<Counter>(new Counter(42)); }
+ function make(): ptr<Counter> { return new Counter(42); }

// Rc<T> → ptr<T> (deprecation warning por ahora)
- function share(): Rc<Counter> { return rcShare<Counter>(new Counter(7)); }
+ function share(): ptr<Counter> { return new Counter(7); }
```

## v0.26.0 (2026-09-27) — Features TS completas + productividad del compilador

### Added (Fase 1 — features TypeScript)

- **1.2 `Optional<T>`**: runtime en `ets_optional.hpp` + helpers globales (`optionalSome`, `optionalNone`, `optionalValueOr`, `optionalAndThen`, `optionalMap`).
- **1.3 `??`**: nullish coalescing sobre `Optional<T>` con propagación contextual.
- **1.4 `?.`**: optional chaining sobre `Optional<T>`.
- **1.5 Decoradores**: `@deprecated` (warning) + `@sealed` (rechaza herencia).
- **1.6 Parámetros opcionales `name?: T`**: en funciones y métodos.
- **1.7 Template literals**: ya implementados, ahora documentados formalmente.
- **1.8 `for await...of`**: desazucarado a loop con `co_await` por elemento.
- **1.9 `using`**: declaración TC39 stage 3 con RAII automático.
- **1.10 Match expressions**: TC39 stage 2 (`match (expr) { when (pat) => res; ... }`) con wildcard `_`.
- **1.11 `satisfies`**: type-check con cast implícito (TS 4.9).
- **1.13 `Promise.all/race`**: helpers sobre `Promise<T>[]` (`Task<T>[]`).
- **1.15 Named/default exports**: `export { x as y }` y `export default function/class/const/...`.

### Added (Fase 2 — productividad del compilador)

- **2.1 Error reporting legible**: colores ANSI, multi-line spans con carets extendidos, did-you-mean (Levenshtein ≤ 2). Respeta `NO_COLOR` y `FORCE_COLOR`.
- **2.2 Documentación**: `LIMITATIONS.md` (149 líneas) con rechazos exhaustivos + reorganización de `README.md`.
- **2.3 Build incremental pulido**: `--verbose`/`-v` flag, timings por fase, diagnóstico claro de cache miss, resumen final con tamaño del binario.
- **2.4 Página web de demos**: `scripts/build-demo-page.ts` (337 LOC) + `docs/demos.html` (2587 líneas, 50 demos en 13 categorías). Comando `npm run demos`.

### Added (Fase 3 — productividad del desarrollo)

- **3.1 Watch mode**: `scripts/watch.ts` (120 LOC) con debounce 100ms y spawn del CLI. Comando `npm run watch`.
- **3.2 Skip tests de red**: `SKIP_NETWORK=1` para CI.
- **3.3 Worker pool paralelo**: `TEST_CONCURRENCY=N` (default `cpus().length`). 2.85x speedup (5:00 → 1:44).

### Changed

- `KEYWORDS`, `JSON_HELPERS`, `OPTIONAL_HELPERS`, `ASYNC_PRIMITIVE_HELPERS` usan `Object.create(null)` para evitar herencia de `Object.prototype`.
- `match`/`when`/`satisfies` añadidos como keywords.

### Discarded (no aplican al dialecto)

- **1.12 `abstract` classes** y **1.14 `override` modifier**: requieren herencia, que el dialecto prohíbe.

### Performance

| Métrica | Antes (v0.25) | Ahora (v0.26) | Speedup |
|---|---|---|---|
| Suite tests | 5:00 | 1:44 | 2.85x |
| Tests | 117 | 133 | +14% |
| Demos | 34 | 50 | +47% |

## v0.25.0 (anterior)

Baseline de features TS estándar + suite de tests golden.
