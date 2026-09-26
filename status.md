# Ts2cpp — Status

## Última fase cerrada: Bloque 7 (JSON.parse trees) · commit 5587184

- **Tests**: 121/121 PASS (78 unit + 43 integration, 4:12 min)
- **Cambios**:
  - Runtime: `ets_json_value` (variant opaco), `ets_json_parser` recursivo, `parseValue(string) → Value`, `stringify(Value)` recursivo, 12 helpers globales (`jsonIsString`, `jsonAsString`, `jsonArrayGet`, `jsonObjectGet`, etc.).
  - Dialecto: `JSON.parseValue(s) → JsonValue`, `JsonValue` como tipo concreto reconocido, dispatch en codegen.
  - Compatibilidad: `JSON.parse` legacy (→ `string`) sigue funcionando.
  - Ejemplo: `examples/json-tree-demo.ets` con 3 escenarios.
- **Limitaciones conocidas**:
  - Static-init con `JSON.parseValue` no funciona (C++ static init order es indefinido). El ejemplo encapsula las llamadas en funciones para evitar el problema.
  - Unicode `\uXXXX` en JSON escapa a `'?'` (runtime mínimo).
  - `jsonObjectKeys` no expone keys en orden estable (`std::map` ordena por clave).

## Plan en cola

### Fase 1 — Sintaxis TS que el dialecto puede asumir

| # | Feature | Decisión | Estado |
|---|---|---|---|
| 1.1 | `>>>` (logical right shift) | **rechazado** (tras reconsideración del usuario) | ⛔ |
| 1.2 | `Optional<T>` runtime + dialecto | pendiente | ⏳ **siguiente** |
| 1.3 | `??` (nullish coalescing) sobre `Optional<T>` | pendiente | ⏳ bloqueado por 1.2 |
| 1.4 | `?.` (optional chaining) sobre `Optional<T>` | pendiente | ⏳ bloqueado por 1.2 |
| 1.5 | Decoradores (TC39 stage 3) | pendiente | ⏳ |
| 1.6 | Optional `?` en parámetros | pendiente | ⏳ |
| 1.7 | Template literals con `${expr}` interpolado | pendiente | ⏳ |
| 1.8 | `for await...of` | pendiente | ⏳ |
| 1.9 | `using` / RAII declarativo (TC39 stage 3) | pendiente | ⏳ |
| 1.10 | Match expressions (TC39 stage 2) | pendiente | ⏳ |
| 1.11 | `satisfies` operator | pendiente | ⏳ |
| 1.12 | Variadic tuples `[T, ...U]` | pendiente | ⏳ |
| 1.13 | `Promise.all` / `Promise.race` / cancellation | pendiente | ⏳ |
| 1.14 | `const` generics | pendiente | ⏳ |
| 1.15 | Named/default exports round-trip | pendiente | ⏳ |

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
- ~~`??`/`?.` rechazados~~ → **reabiertos** condicionalmente a la introducción de `Optional<T>` (Fase 1.2).
