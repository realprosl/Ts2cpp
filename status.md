# Ts2cpp — Status

## Última fase cerrada: Fase 1.6 (Parámetros opcionales `?`) · commit bb6c360

- **Tests**: 126/126 PASS (78 unit + 48 integration)
- **Cambios**:
  - AST: `Parameter.optional?: boolean`.
  - Parser: `name?: T` aceptado en `functionDeclaration`, `classDeclaration` y `interfaceDeclaration`.
  - Type-checker: `p.optional` ⇒ tipo efectivo `Optional<T>` (sin doble envoltorio). `matchOverload.requiredCount` ignora opcionales.
  - Codegen: firma C++ envuelve en `ets::Optional<T>` si `optional=true`. Call sites rellenan args omitidos con `Optional<T>::none()`.
- **Bug colateral**: `JSON_HELPERS` y `OPTIONAL_HELPERS` heredaban de `Object.prototype` (igual que `KEYWORDS` antes). Llamar a `toString`, `hasOwnProperty`, etc., entraba al chequeo JSON/OPTIONAL con el método heredado y crasheaba. Arreglado con `Object.assign(Object.create(null), {...})`.
- **Próxima fase**: Fase 1.7 — Template literals con `${expr}` interpolado.

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
| 1.7 | Template literals con `${expr}` interpolado | ⏳ **siguiente** |
| 1.8 | `for await...of` | ⏳ |
| 1.9 | `using` / RAII declarativo (TC39 stage 3) | ⏳ |
| 1.10 | Match expressions (TC39 stage 2) | ⏳ |
| 1.11 | `satisfies` operator | ⏳ |
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
