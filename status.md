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
| 1.11 | `satisfies` operator | ⏳ **siguiente** |
| 1.12 | Variadic tuples `[T, ...U]` | ⏳ |
| 1.13 | `Promise.all` / `Promise.race` / cancellation | ⏳ |
| 1.14 | `const` generics | ⏳ |
| 1.15 | Named/default exports round-trip | ⏳ |

### Fase 2 — Rendimiento del compilador

- [ ] Caché de tokens/AST entre invocaciones (daemon que escucha en socket)
- [ ] Worker pool para compilación paralela
- [ ] Incremental watch mode que invalide solo módulos con hash cambiado
- [ ] Skip tests de red en CI (`SKIP_NETWORK=1`)
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
