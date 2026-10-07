# Ts2cpp — Status

## Última fase cerrada: Fase 1.6 (Parámetros opcionales `?`) · commit bb6c360

- **Tests**: 126/126 PASS (78 unit + 48 integration)
- **Cambios**:
  - AST: `Parameter.optional?: boolean`.
  - Parser: `name?: T` aceptado en `functionDeclaration`, `classDeclaration` y `interfaceDeclaration`.
  - Type-checker: `p.optional` ⇒ tipo efectivo `Optional<T>` (sin doble envoltorio). `matchOverload.requiredCount` ignora opcionales.
  - Codegen: firma C++ envuelve en `ets::Optional<T>` si `optional=true`. Call sites rellenan args omitidos con `Optional<T>::none()`.
- **Bug colateral**: `JSON_HELPERS` y `OPTIONAL_HELPERS` heredaban de `Object.prototype` (igual que `KEYWORDS` antes). Llamar a `toString`, `hasOwnProperty`, etc., entraba al chequeo JSON/OPTIONAL con el método heredado y crasheaba. Arreglado con `Object.assign(Object.create(null), {...})`.
- **Próxima fase**: Fase 1.7 — Template literals con `${expr}`.

## Última fase cerrada: Fase 1.8 (`for await...of`) · commit 3801f73

- **Tests**: 127/127 PASS (78 unit + 49 integration)
- **Cambios**:
  - AST: `ForOfStatement.await?: boolean`.
  - Parser: dispatcher de `for` acepta `await` opcional entre `for` y `(`.
  - Type-checker: `await=true` requiere iterable `Promise<T>`; binding queda como `T`.
  - Codegen: `emitForOf` inyecta `co_await`/`syncWait` por elemento. Nombres `_iter`/`_awaited` evitan shadowing.
  - Codegen: `ArrayLiteralExpression` usa lambda con push_back para tipos move-only (Task/Optional/Result) en lugar de initializer_list.
  - Rechaza `for await...in` y `for await (init; cond; incr)`.
  - Ejemplo: `for-await-demo.ets` (3 escenarios: collect, sum, empty).
- **Próxima fase**: Fase 1.9 — `using` / RAII declarativo.

### Fase 1.7 — Template literals (verificado, sin cambios)

- **Tests**: el golden de `template-strings-demo.ets` coincide con stdout. Suite 126/126 PASS ya cubre el caso.
- **Estado**: ya estaba implementado antes de esta sesión:
  - Lexer: depth-tracking para `${...}` dentro de backticks (lexer.ts:104-134).
  - Parser: `templateLiteral()` parte el raw en `parts[]` y `expressions[]` reusando el sub-parser (parser.ts:645-681).
  - Type-checker: expresiones interpoladas se evalúan en su scope.
  - Runtime: `ets::concat(parts...)` en `runtime/ets_string.hpp` (variadic template con `(oss << ... << parts)`).
  - Codegen: emite `ets::concat(std::string("literal"), expr, ...)` (cpp-generator.ts:504-513).
- **Demo**: `examples/template-strings-demo.ets` (6 escenarios con strings, numbers, booleans, anidamiento).
- **Próxima fase**: Fase 1.8 — `for await...of`.

## Última fase cerrada: Fase 1.9 (`using`) · commit c546812

- **Tests**: 128/128 PASS (78 unit + 50 integration)
- **Cambios**:
  - Lexer: `using` como keyword.
  - AST: `UsingDeclaration { name, declaredType?, initializer, span }`.
  - Parser: dispatcher de statements; `usingDeclaration(keyword, exported)`.
  - Type-checker: binding inmutable (mutable=false), type-check estándar.
  - Codegen: `T name = expr` con RAII automático de C++.
  - Ejemplo: `using-demo.ets` (3 casos en demoBasic + scope-limit en demoScope).
- **Limitación**: como el dialecto no tiene destructores user-defined todavía, `using` es funcionalmente equivalente a `let` con scope-limit. La invocación explícita de `dispose()` se añadirá cuando se implemente destructores de usuario (Fase 3).
- **Próxima fase**: Fase 1.10 — Match expressions (TC39 stage 2).

## Última fase cerrada: Fase 1.10 (Match expressions) · commit 1f11737

- **Tests**: 129/129 PASS (78 unit + 51 integration)
- **Cambios**:
  - Lexer: `match`, `when` como keywords.
  - AST: `MatchArm`, `MatchExpression` con `subject` y `arms[]`.
  - Parser: `expression()` despacha `match` antes que `assignment`. `matchExpression()` parsea `match (subject) { when (pattern) => result; ... }`.
  - Type-checker: propaga el tipo del subject a los patterns (excepto wildcard `_`). Verifica que todos los arms devuelvan el mismo tipo.
  - Codegen: `emitMatch()` construye cadena de ternarios. Wildcard `_` se ignora en la comparación.
  - Ejemplo: `match-demo.ets` (8 escenarios, incluyendo match anidado).
- **Próxima fase**: Fase 1.11 — `satisfies` operator.

## Última fase cerrada: Fase 1.15 (named/default exports) · commit 5bb149a

- **Tests**: 130/130 PASS (78 unit + 52 integration)
- **Cambios**:
  - AST: `ExportSpecifier`, `ExportDefaultDeclaration`, `ExportNamedDeclaration`.
  - Parser: `exportDefaultDeclaration()` (acepta class/function/let/const/expresión), `exportNamedDeclaration()` (con `as <alias>` opcional y `from "<mod>"` opcional).
  - Type-checker: `ExportDefaultDeclaration` type-checkea la declaración interna; `ExportNamedDeclaration` verifica nombres y registra aliases en el scope.
  - Codegen: `exportAliases` map para resolver `y` → `x` cuando `export { x as y }`. Unwrap `ExportDefaultDeclaration` para que la declaración interna se procese como top-level directa.
- **Ejemplo**: `exports-demo.ets` (6 escenarios: `export const`, `export function`, `export default`, `export { ... as alias }`).
- **Limitación**: `import` NO está soportado (single-translation-unit). Los exports son marcas para tooling; en runtime el dialecto procesa todas las declaraciones como top-level.
## Última fase cerrada: Fase 2.1 — error reporting legible · commit 270050c

- **Tests**: 130/130 PASS (78 unit + 52 integration)
- **Cambios**:
  - `src/core/diagnostic.ts`: `DiagnosticPhase`, `DiagnosticSeverity` exportados. `formatDiagnostic` reescrito con colores ANSI (por fase y severidad), gutter con número de línea, carets multilínea y sección de notes/hints. `formatDiagnostics` agrupa diagnósticos. Respeta `NO_COLOR` (estándar) y soporta `FORCE_COLOR=1`.
  - `src/semantic/symbols.ts`: `Scope.names()` itera todos los nombres visibles (incluyendo padres).
  - `src/semantic/type-checker.ts`: función top-level `levenshtein(a, b)`. Método privado `suggestSimilar(name, candidates)` que devuelve hint `¿Quisiste decir 'X'?` si hay candidato a distancia ≤2. `report` sobrecargado con `hint?` y `notes?` opcionales. Aplicado a "Símbolo no definido" y "Función no definida".
  - `src/cli.ts`: usa `formatDiagnostics`.
- **Output ejemplo**:
  ```
  error[semantic]: Función no definida 'gret'
    --> /tmp/test-suggest.ets:4:1
  4 | gret();
    | ^^^^^^
    = hint: ¿Quisiste decir 'greet'?
  ```
## Última fase cerrada: Fase 2.2 — documentación completa · commit 89c4883

- **Tests**: 130/130 PASS (sin cambios en código)
- **Cambios**:
  - `LIMITATIONS.md` nuevo (149 líneas): documenta exhaustivamente rechazos irreversibles (sin Object/any/unknown, sin throw/try/catch, sin herencia, sin >>>, sin Object destructuring, sin BigInt, sin eval/arguments/with), posposiciones de Fase 1 (satisfies, variadic tuples, Promise.all, const generics) y limitaciones intencionales del diseño.
  - `README.md` actualizado:
    - Enlace prominente a `LIMITATIONS.md` al inicio.
    - Sección 'Limitaciones conocidas' reescrita: solo rechazos irreversibles; las features reabiertas en Fase 1 se mencionan con referencia al commit.
    - Nueva sección 'Ejemplos disponibles' con tabla categorizada de los 50 ejemplos y comandos para ejecutarlos.
## Última fase cerrada: Fase 2.3 — build incremental pulido · commit 4e84dc0

- **Tests**: 130/130 PASS en 4:32 (sin regresiones)
- **Cambios**:
  - `BuildProgress` class: reporter de progreso estilo cargo, mide tiempo por fase.
  - `IncrementalBuildOptions { verbose?: boolean }`.
  - `IncrementalBuildResult`: campos nuevos `durationMs` y `cacheResult: "hit" | "miss"`.
  - Diagnóstico de cache miss: distingue entre huella-cambió / no-existe-objeto / no-existe-binario.
  - Errores nativos envueltos con contexto: la excepción de g++/ld incluye la fase que falló y sugiere revisar flags/linkFlags en estatic.config.ts.
  - Resumen final: tamaño del binario.
  - `--verbose` / `-v` flag en el CLI.
- **Output ejemplo (verbose)**:
  ```
  Cargando grafo de módulos...
         1 módulo(s) cargado(s)
         Calculando digests (runtime + flags)... 0.01s
         runtime digest: 8acfe58deaebaf88, global digest: 5d206feb7ea8ce7a
         Cache miss: no existe el objeto cacheado
         Regenerando .cpp (parse + type-check + codegen)... 0.04s
         Compilando a objeto (g++)... 0.38s
         Enlazando binario (g++)... 5.62s
         Binario: /tmp/inc-build/build/app (28,000 bytes)
  Build incremental (miss): 1 módulo(s) compilado(s), 0 reutilizado(s), re-enlazado, 6305ms
  ```
- **Output ejemplo (cache hit, verbose)**: `Cache hit: huella coincide, reutilizando .../app.o` + `Build incremental (hit): ... 42ms` (150x más rápido).
## Última fase cerrada: Fase 2.4 — página web de demos · commit 0481f17

- **Tests**: 130/130 PASS (sin cambios en código)
- **Cambios**:
  - `scripts/build-demo-page.ts` (nuevo, ~340 LOC): generador que escanea `examples/*.ets` y `test/golden/*.expected.txt` y produce `docs/demos.html`. Sin deps npm.
  - `docs/demos.html` (nuevo, 2587 líneas): 50 demos en 13 categorías con CSS embebido (tema oscuro Catppuccin-inspired). Cada card colapsable con código fuente (cerrado por defecto) y salida golden (abierta por defecto). TOC con anchors. Badges `✓ output` / `⚠ sin golden`.
  - `package.json`: script `demos` añadido.
  - `README.md`: enlace prominente a `docs/demos.html` con comando `npm run demos`.
## Última fase cerrada: Fase 3 — watch mode + SKIP_NETWORK (1+2) · commit 1cafb31

- **Tests**: 130/130 PASS en 4:42
- **Cambios**:
  - `scripts/watch.ts` (nuevo, ~120 LOC): watch mode con debounce 100ms. Vigila recursivamente moduleRoots + directorio del entry. Filtra .ets/.ts, ignora node_modules y archivos bajo compilerRoot. Re-compila vía spawn del CLI. Output: timestamp + tiempo + ✓/✗.
  - `test/runner.ts`: `loadSkipList()` respeta `SKIP_NETWORK=1` (devuelve todos como compile-only).
  - `package.json`: script `watch` añadido.
- **Uso**:
  ```
  npm run watch         # vigila cambios y re-compila
  SKIP_NETWORK=1 npm test  # CI sin ejecutar demos de red
  ```
- **Output ejemplo**:
  ```
  watch: estatic.config.ts
  resolviendo entry...
  entry: main.ts
  vigilando:
    /tmp/inc-build
  → re-compilando (4:46:07 AM)
  Build incremental (hit): 0 módulo(s) compilado(s), 2 reutilizado(s), 38ms
  ✓ ok en 0.41s
  (Ctrl+C para terminar)
  cambio: /tmp/inc-build/main.ts
  → re-compilando (4:46:11 AM)
  Build incremental (hit): 0 módulo(s) compilado(s), 2 reutilizado(s), 32ms
  ✓ ok en 0.38s
  ```
## Última fase cerrada: Fase 3.3 — worker pool paralelo · commit 680e3f7

- **Tests**: 131/131 PASS en 1:44 (vs 4:42 en serie) → **2.85x speedup total**
- **Cambios**:
  - `test/runner.ts`: worker pool con `Promise` + índice compartido. Concurrency por defecto = `cpus().length - 1`. Configurable con `TEST_CONCURRENCY=N`.
  - Cada worker escribe en `test/scratch/wN/` (subdirectorios aislados).
  - `processDemo(name, isSkipNetwork, workerId)` ejecuta pipeline completo (transpile + compile + run + diff golden).
  - `runPool(items, workerCount, fn)` reparte items round-robin preservando orden de entrada.
  - Cwd de exec = SCRATCH_DIR raíz para que `process.cwd()`/`path.resolve('.')` vean el mismo entorno que en serie.
- **Speedup medido**:
  | Concurrencia | Tiempo demo (50) | Speedup |
  |---|---|---|
  | 1 (serie) | 282s (4:42) | 1x |
  | 4 (auto) | 76s (1:16) | **3.7x** |
  | 8 (over) | 85s | (más workers no ayuda con 4 cores) |
- **Próxima fase**: Consolidación — todas las piezas activas de Fase 3 cerradas.

## Plan en cola

### Fase 1 — Sintaxis TS que el dialecto puede asumir

| # | Feature | Estado |
|---|---|---|
| 1.1 | `>>>` (logical right shift) | ⛔ rechazado |
| 1.2 | `Optional<T>` runtime + dialecto | ✅ commit b0be64a |
| 1.3 | `??` (nullish coalescing) sobre `Optional<T>` | ✅ commit 4dcf28b |
| 1.4 | `?.` (optional chaining) sobre `Optional<T>` | ✅ commit 764317e |
| 1.5 | Decoradores (TC39 stage 3) | ✅ commit aac7c30 |
| 1.6 | Optional `?` en parámetros | ✅ commit bb6c360 |
| 1.7 | Template literals con `${expr}` interpolado | ✅ ya estaba, verificado |
| 1.8 | `for await...of` | ✅ commit 3801f73 |
| 1.9 | `using` / RAII declarativo | ✅ commit c546812 |
| 1.10 | Match expressions (TC39 stage 2) | ✅ commit 1f11737 |
| 1.11 | `satisfies` operator | ⏸️ pospuesto (dialecto no tiene inferencia vs tipo declarado distinto) |
| 1.12 | Variadic tuples `[T, ...U]` | ⏸️ pospuesto (requiere reificación de tuples) |
| 1.13 | `Promise.all` / `Promise.race` / cancellation | ⏸️ pospuesto (runtime complejo) |
| 1.14 | `const` generics | ⏸️ pospuesto (no aplica sin reificación) |
| 1.15 | Named/default exports round-trip | ✅ commit 5bb149a |

### Fase 2 — Pulido del dialecto

| # | Mejora | Estado |
|---|---|---|
| 2.1 | Error reporting legible (colores, multi-line, did you mean) | ✅ commit 270050c |
| 2.2 | Documentación completa (README, LIMITATIONS, ejemplos) | ✅ commit 89c4883 |
| 2.3 | Compilación incremental pulida (verbose, errores claros) | ✅ commit 4e84dc0 |
| 2.4 | Página web de demos | ✅ commit 0481f17 |

### Fase 3 — Compilación incremental

- [x] ~~Caché de tokens/AST entre invocaciones~~ → integrado con el incremental-builder (Fase Bloque A)
- [x] Worker pool para compilación paralela → `npm test` con auto-detect (commit 680e3f7)
- [x] Incremental watch mode que invalide solo módulos con hash cambiado → `npm run watch` (commit 1cafb31)
- [x] Skip tests de red en CI (`SKIP_NETWORK=1`) → commit 1cafb31
- [x] ~~Pre-compiled headers del runtime~~ → descartado (marginal con C++20)
- [x] ~~Profile-guided optimization del compilador mismo~~ → descartado (marginal)

### Fase 3 — Genéricos con capacidades (nombres por decidir)

- [ ] `Mut<T>` — envoltorio de referencia mutable tipada (encaja con el `mut` actual)
- [ ] `Uniq<T>` — ownership único (formaliza las reglas ad-hoc del dialecto)
- [ ] `Count<T>` (o nombre definitivo) — ownership contado single-thread

## Rechazos explícitos (mantenidos)

- **Herencia** de clases — incompatible con composición.
- **`Object`/`any`/`unknown`** dinámicos — reemplazados por `JsonValue` cuando hace falta.
- **Conversiones implícitas** fuera de `Path → string`.
- **Excepciones** — reemplazadas por `Result<T, E>`.

## Decisiones reconsideradas

- ~~`>>>` rechazado~~ → **mantenido rechazado** tras revisión.
- ~~`??`/`?.` rechazados~~ → **reabiertos** condicionalmente a `Optional<T>` (1.2 ✅).
- ~~`abstract` (1.12) y `override` (1.14)~~ → **descartados** porque requieren herencia y el dialecto la prohíbe.

## Release v0.26 (preparación)

Tras cerrar Fases 1.11 + 1.13 y descartar 1.12 + 1.14, todas las features
TS modernas del dialecto están implementadas. La sesión cierra con:

- **22 commits** desde `5b9b8dc` (Fase 3 setup) hasta `961c124` (Fase 1.13).
- **133/133 tests PASS** en 1:44 (vs 117/117 en 5:00 al inicio → 2.85x speedup).
- **50 demos** (16 nuevos esta sesión).
- **17 features Fase 1** cerradas (10 originales + 1.13 + 1.11 + extras del plan).
- **Tag `v0.26`** siguiente paso.

## Migración del runtime async: poll(2) → libuv (2026-10)

**Estado: COMPLETA (8/8 fases cerradas).** 17 PRs mergeadas (#101–#117).

Motivación: cross-platform (Windows IOCP, macOS kqueue), menos coste de
dispatcher, mejor integración con cancelación distribuida. La medición
demostró que libuv es **32x más rápido que poll(2) en dispatcher idle**
y **430x más rápido con 50 pipes registrados**.

Activación: compilar con `-DETS_EVENT_BACKEND_LIBUV -luv`. Default
sigue siendo `PollEventLoop` para no romper nada. La API pública
(`listenTcp`/`acceptTcp`/`readTcp`/`writeTcp` + versiones `*Until`) es
**idéntica** en ambos backends; solo cambia el awaitable interno
(`UvFdAwaiter` vs `FdAwaiter`).

Las 8 fases cerradas:

| Fase | Qué cubre | PR |
|------|-----------|----|
| 1 — Spike arquitectónico | Patrón callback→coroutine C++20 | #101 |
| 2A — Refactor `IEventLoop` | Selector de backend | #102 |
| 2B.1-2B.5 — Backend libuv | waitUntil/notify/post/waitFor/detach + LibuvEventLoop | #103-#107 |
| 3.1-3.1.1 — TCP/DNS standalone | uv_tcp + getaddrinfo | #108-#109 |
| 3.2-3.3 — Sustitución FdAwaiter | UvFdAwaiter drop-in | #110-#111 |
| 4-4.2 — TCP client | uv_getaddrinfo + uv_tcp_connect + raw_loop | #112-#113 |
| 5 — Cancelación end-to-end | acceptTcpUntil + CancellationSource cross-thread | #115 |
| 6 — Benchmark dispatcher | 32x–430x más rápido medido | #114 |
| 7 — Fetch HTTP con libcurl | HTTP client async (easy interface) | #116 |
| 8 — Benchmark hot path | 197 ns/timer, 19 ns/poll idle | #117 |

**Resultados medidos (este hardware)**:

- Dispatcher idle: 17 ns/libuv vs 544 ns/poll(2) → **32x más rápido**.
- Dispatcher 50 pipes: 23 ns/libuv vs 9883 ns/poll(2) → **430x más rápido**.
- Cancelación cross-thread: 49 ms (vs 10s del deadline).
- 1000 timers dispatch: 197 ns/timer.

**Tests añadidos (no se inyectan al código generado)**:

- 13 tests + 2 benchmarks en `runtime/libuv/tests/`.
- **94/94 escenarios verde** acumulado (más 202/202 unit Ts2cpp sin regresión).

Ver [`runtime/libuv/README.md`](./runtime/libuv/README.md) para detalle
completo de cada fase, PR, tabla de compatibilidad y notas para
mantenedores.

### Cambios en runtime (en producción)

- `runtime/ets_event_loop.hpp` — selector `#ifdef ETS_EVENT_BACKEND_LIBUV`.
- `runtime/ets_event_loop_libuv.hpp` — implementación libuv.
- `runtime/ets_event_loop_poll.hpp` — poll(2) backend (default).
- `runtime/ets_event_loop_iface.hpp` — interfaz `IEventLoop` común.
- `runtime/ets_net_libuv.hpp` — `UvFdAwaiter`/`UvCancellableFdAwaiter` como
  drop-in de `FdAwaiter`/`CancellableFdAwaiter`.
- `runtime/ets_net.hpp` — auto-swap `NetFdAwaiter`/`NetCancellableFdAwaiter`
  bajo `-DETS_EVENT_BACKEND_LIBUV`.

Sin cambios en código generado. Sin Dockerfile. Sin dependencias npm
añadidas.

### Limitación conocida (no bloqueante)

Los tests standalone se compilan con `-O0` por un bug latente con `-O2`
en `test_integration` test 3 (waitUntil dispara corutina tras deadline).
No es regresión de la migración (también fallaba con `-O2` antes). El
runtime real se compila con `-O2` en los tests e2e del dialecto y pasa
sin issues. Investigar en una fase posterior si se quiere `-O2` en los
benchmarks.

## V25 — Build System: "transpilador en un solo bloque" (2026-10)

**Estado: COMPLETO.** 7 PRs mergeadas (#119, #120, #121, #122, #123,
#124, #125), 1 PR abierta (#126 docs finales). Cierra el ciclo de
"transpilador en un solo bloque": el usuario **NO** necesita instalar
`libuv-dev`, `libssl-dev`, `libcurl4-openssl-dev`. Solo `g++`, `cmake`,
`make`, `git`.

### Fases entregadas

| Fase | PR | Descripción |
|---|---|---|
| 1 | #119 | Vendoring libuv (submódulo git) |
| 4 | #120 | Pre-compilar runtime a `.o` (150x speedup) |
| 4.6 | #121 | CLI integra `.o` (auto-build) |
| 5 | #122 | Cache global en `~/.cache/etsc/` |
| 6 | #123 | UX transparente (auto-build libs) |
| 2 | #124 | Vendoring BoringSSL (submódulo git) |
| 3 | #125 | Vendoring libcurl (submódulo git) |
| 7 | #126 | Documentación final (este doc) |

### Métricas finales

| Componente | Cold compile | Warm cache |
|---|---|---|
| libuv (`build-libuv.sh`) | ~35s | 28ms |
| BoringSSL (`build-boringssl.sh`) | ~2 min | 2s |
| libcurl (`build-curl.sh`) | ~30s | 1s |
| runtime `.o` (`build-runtime.sh`) | ~6s | 40ms |
| **Build completo de un programa Ts2cpp** | ~10s | **~100ms (20x)** |

### Tests verde (2026-10-07)

- **202/202 unit Ts2cpp**.
- **14/14 libuv** (94/94 escenarios) — incluye `benchmark_libuv_hotpath`
  con 182 ns/timer dispatch.
- **3/3 e2e runner**.

### Próximos pasos (no V25)

- **V26** (Alberto roadmap): reactor async O(conexiones) → O(eventos
  activos). Eliminar O(N) en detached_/cancel/cleanup. buffer pool.
- **V24.x**: memory model subtareas pendientes.
- **V23.x**: forma con discriminator en runtime.
