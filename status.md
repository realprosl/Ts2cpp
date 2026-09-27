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
- **Próxima fase**: Fase 3 — piezas pendientes (pre-compiled headers del runtime, PGO del compilador mismo, worker pool).

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
- [ ] Worker pool para compilación paralela
- [x] Incremental watch mode que invalide solo módulos con hash cambiado → `npm run watch` (commit 1cafb31)
- [x] Skip tests de red en CI (`SKIP_NETWORK=1`) → commit 1cafb31
- [ ] Pre-compiled headers del runtime
- [ ] Profile-guided optimization del compilador mismo

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
