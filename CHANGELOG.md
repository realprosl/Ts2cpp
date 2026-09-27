# Changelog

Todas las versiones siguen [Semantic Versioning](https://semver.org/).

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
