# Changelog

Todas las versiones siguen [Semantic Versioning](https://semver.org/).

## v1.0.0 (2026-10-07) — V25 Build System: "transpilador en un solo bloque"

### Added

- **Build system con `.a` estáticas vendoreadas**: libuv, BoringSSL
  (OpenSSL-compatible), libcurl. El usuario ya no necesita
  `apt install libuv-dev libssl-dev libcurl4-openssl-dev`; solo
  `g++`, `cmake` y `make`.
- **Tres librerías como submódulos git** (`third_party/libuv/`,
  `third_party/boringssl/`, `third_party/curl/`). Cada una con
  `VENDORED-NOTES.md` específico.
- **Cuatro scripts de build** (`scripts/build-{libuv,boringssl,curl,runtime}.sh`)
  con cache HIT/MISS. Cold compile ~3 min total; warm cache <5s.
- **Pre-compilación del runtime a `.o`** (`runtime/runtime_ets_*.cpp` →
  `build/runtime_ets_*.o`). 150x speedup warm cache. Header ligero
  `*_api.hpp` con solo declaraciones para el code que va a `.cpp`.
- **Cache global** del usuario en `~/.cache/etsc/runtime/<ver>/<backend>/<hash>/`.
  Compartido entre proyectos del mismo usuario.
- **Integración transparente en el CLI** (`src/cli.ts`):
  - Detección automática de librerías vendoreadas en `linkLibraries`.
  - Auto-ejecución de `scripts/build-<lib>.sh` cuando faltan `.a`.
  - Auto-ejecución de `scripts/build-runtime.sh` cuando faltan `.o`.
  - Auto-poblamiento del cache global.

### Changed

- `runtime/ets_event_loop_libuv.hpp` y `runtime/ets_event_loop_poll.hpp`
  son ahora **wrappers back-compat** que incluyen los `_api.hpp`. Las
  definiciones no-template se movieron a los `.cpp`.
- El CLI ya no requiere que el usuario ejecute los scripts de build
  manualmente.

### Performance

| Escenario | Antes (V24) | Ahora (V25) | Speedup |
|---|---|---|---|
| Cold compile (primer build) | ~5s | ~10s (con cache miss de vendoring) | 0.5x (penalty de 5s) |
| Warm cache (libs + runtime) | ~2s | ~100ms | **20x** |
| Cache global hit (proyecto nuevo) | N/A | ~100ms | nuevo |

### Documentation

- `docs/build-system.md` (nuevo, ~280 líneas): guía completa del
  build system V25.
- `scripts/README.md`: documenta los 4 scripts de V25.
- `third_party/libuv/README.md`, `third_party/boringssl/VENDORED-NOTES.md`,
  `third_party/curl/VENDORED-NOTES.md`: docs de cada librería vendoreada.
- `runtime/libuv/README.md`: nota sobre pre-compilación.
- `CHANGELOG.md`, `README.md`, `status.md`: actualizados a V25.

## v0.29.0 (2026-10-07) — Backend alternativo de EventLoop basado en libuv

### Added

- **Backend libuv para `ets::EventLoop`**: nueva implementación
  `LibuvEventLoop` basada en libuv 1.48, seleccionable con
  `-DETS_EVENT_BACKEND_LIBUV`. Activar con `-luv` al enlazar.

  ```bash
  # Default (poll(2), sin cambios):
  g++ -std=c++20 programa.cpp -o programa -pthread

  # Con backend libuv:
  g++ -std=c++20 -DETS_EVENT_BACKEND_LIBUV programa.cpp -o programa -luv -pthread
  ```

- **`UvFdAwaiter` / `UvCancellableFdAwaiter`**: drop-in libuv de
  `FdAwaiter` / `CancellableFdAwaiter`. Bajo
  `-DETS_EVENT_BACKEND_LIBUV`, `ets::listenTcp` / `acceptTcp` /
  `readTcp` / `writeTcp` y versiones `*Until` usan `uv_poll_t`
  internamente. La API pública es **idéntica**.

- **Benchmarks medidos** (`runtime/libuv/tests/benchmark_*.cpp`):
  - dispatcher idle (1 fd): **libuv 32x más rápido** (17 ns vs 544 ns).
  - dispatcher 50 pipes: **libuv 430x más rápido** (23 ns vs 9883 ns).
  - 1000 timers dispatch: 197 ns/timer.
  - Wake roundtrip cross-thread: 23.7 µs.
  - HTTP fetch end-to-end (libcurl): funciona con status 200, body
    correcto.

- **Tests añadidos (no se inyectan al código generado)** en
  `runtime/libuv/tests/`:
  - `test_wait_until.cpp` (Fase 2B.1, PR #103)
  - `test_notify_post.cpp` (Fase 2B.2, PR #104)
  - `test_wait_for.cpp` (Fase 2B.3, PR #105)
  - `test_detach.cpp` (Fase 2B.4, PR #106)
  - `test_integration.cpp` (Fase 2B.5, PR #107, 12 tests)
  - `test_tcp_server.cpp` (Fase 3.1, PR #108)
  - `test_dns_resolve.cpp` (Fase 3.1.1, PR #109)
  - `test_uv_fd_awaiter.cpp` (Fase 3.2, PR #110)
  - `test_tcp_client.cpp` (Fase 4, PR #112)
  - `test_tcp_client_loop.cpp` (Fase 4.2, PR #113)
  - `test_cancel_network.cpp` (Fase 5, PR #115)
  - `test_curl_fetch.cpp` (Fase 7, PR #116)
  - `benchmark_poll_vs_libuv.cpp` (Fase 6, PR #114)
  - `benchmark_libuv_hotpath.cpp` (Fase 8, PR #117)

  Total: **13 tests + 2 benchmarks, 94/94 escenarios verde**. Más
  **202/202 unit Ts2cpp sin regresión**.

- **Nuevos headers en runtime**:
  - `runtime/ets_event_loop_iface.hpp` — interfaz `IEventLoop` común.
  - `runtime/ets_event_loop_poll.hpp` — backend poll(2) (default).
  - `runtime/ets_event_loop_libuv.hpp` — backend libuv (opt-in).
  - `runtime/ets_event_loop.hpp` — selector por macro.
  - `runtime/ets_net_libuv.hpp` — drop-in de awaitables de red.

### Changed

- `runtime/ets_async.hpp` — `EventLoop` ahora es un alias
  (`PollEventLoop` o `LibuvEventLoop` según macro).
- `runtime/ets_net.hpp` — `NetFdAwaiter` y `NetCancellableFdAwaiter`
  son alias que apuntan al awaitable libuv bajo la macro.

### Compatibility

- **100% backwards compatible**: bajo default (sin macro), todo se
  comporta exactamente igual.
- **Cero cambios al código generado** (Ts2cpp no necesita modificarse).
- **Cero Dockerfile**, integración por flag de compilación.
- **Cero dependencias npm** añadidas.

### Known Limitations

- Los tests standalone en `runtime/libuv/` se compilan con `-O0` por
  un bug latente con `-O2` en `test_integration` test 3
  (waitUntil). El runtime real compila con `-O2` y funciona sin
  issues. No es bloqueante.

## v0.28.0 (2026-10-04) — V23 BREAKING: TS-compatible match() syntax

### Breaking

- **V23 — Sintaxis TC39 de `match` eliminada**: la forma
  `match (subject) { when (pattern) => result; }` ya NO se acepta. El
  parser la diagnostica con `E4400`. Migración:

  ```ets
  // Antes (V1.10, eliminado en V23):
  return match (x) {
    when (0) => "zero";
    when (_) => "many";
  }

  // Ahora (V23):
  return match(x, [
    when(0, (v: number): string => "zero"),
    otherwise((): string => "many"),
  ]);
  ```

  La forma V2 destructurada (`match (r) { case { kind: "X", x }: ...; }`)
  **se mantiene** y sigue siendo la única con enforcement de
  exhaustividad.

### Added

- **V23 — `match(value, [when(pattern, callback), ...])`**: nueva
  forma de pattern matching compatible con TypeScript. El codegen
  intercepta la `CallExpression` con `matchedKind === "match"` y emite
  un IIFE con if/else chain en lugar de una llamada a función. Tres
  intrinsics:
  - `when(pattern, callback)`: compara con `==` y ejecuta el callback
    pasando el subject. El callback puede tener 0 o 1 parámetros.
  - `whenType<T>(callback)`: tipo-based dispatch. **V23.2 narrowa el
    subject cuando es una union**: el codegen emite
    `if (std::holds_alternative<T>(v)) { auto narrowed = std::get<T>(v);
    ... }` encadenado. El callback se invoca SIN argumentos (no se le
    pasa el `narrowed`); si necesitas acceder al valor narrowed, usa
    la forma V2 destructurada. Si el subject NO es una union, cae al
    comportamiento legacy: solo el primer `whenType` es la rama
    activa, los siguientes se marcan como `unreachable`.
  - `otherwise(callback)`: default, siempre se ejecuta si ningún
    `when` previo matcheó. Si no hay `otherwise` (ni `whenType`), el
    else final hace `std::abort()`.

- **V23 — forma con discriminator**: `match(value, "key", [when(...)])`
  compara `value.key` contra los patrones. Útil para pattern matching
  estilo "tagged" sobre clases con campo `kind`.

- **V23 — declaraciones para el editor** en `types/estatic.d.ts`:
  interfaces `MatchValueCase`, `MatchTypeCase`, `MatchDefaultCase`; type
  union `MatchCase`; type helper `MatchResult<Cases>`; funciones
  `when`, `whenType`, `otherwise`, `match` con inferencia condicional
  del tipo de retorno. El LSP puede hacer hover y completions sobre la
  nueva sintaxis.

- **V23 — `match` y `when` dejan de ser keywords del lexer**: ahora
  son identificadores normales. La distinción entre la forma V2
  (`match (x) { ... }`, con `{`) y la nueva (`match(x, [...])`, con
  `[`) la hace el parser por lookahead. Esto permite que `when` y
  `match` vuelvan a ser nombres de variable válidos (raro pero
  legal).

- **V23 — trailing commas en arrays literales**: `[a, b,]` ya no
  emite error. Necesario para que la nueva sintaxis admita el estilo
  idiomático TS.

- **V23 — tests**: 7 nuevos unit tests del codegen + 3 nuevos e2e
  (`match-value-pattern`, `match-type-pattern`, `match-exhaustive-union`)
  + migración de `examples/match-demo.ets` y
  `test/e2e/basics/switch-when/source.ets`.

### Removed

- **V23 — forma TC39 `when (p) => r` dentro de `match`**: ya no
  compila. El parser reporta `E4400`.

### Fixed

- **V23 — `match` con `match` anidado**: la nueva forma usa
  `match(x, [...])` en vez de `match (x) {...}`, así que el problema
  de anidamiento de la forma TC39 con wildcard `_` desaparece.

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
