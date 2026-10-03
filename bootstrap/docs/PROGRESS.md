# Progreso por wave

## Wave 0 — Setup + golden tests + benchmark ✅

**Status**: COMPLETADO
**Inicio**: 2026-10-02

### Tareas

- [x] Crear estructura `bootstrap/`
- [x] Documentar roadmap
- [x] Golden tests — serializar ASTs + diagnósticos + .cpp
- [x] Benchmark baseline del compilador TS
- [x] Validar estabilidad de golden tests (100% bit-by-bit)
- [x] Medir límites del dialecto (recursion, generics)
- [x] Documentar resultados

### Archivos creados

```
bootstrap/
├── docs/
│   ├── ROADMAP.md                  # Visión general
│   ├── PROGRESS.md                 # Este archivo
│   ├── BENCHMARK-RESULTS.md        # Métricas Wave 0
│   └── GAPS.md                     # 6 gaps detectados
├── test/
│   ├── golden/
│   │   ├── INDEX.json              # sha256 + size de cada ejemplo
│   │   └── *.cpp (69 archivos)     # ~103 KB total
│   └── benchmark/
│       └── TS-baseline.json        # Tiempos baseline
├── core/                           # Wave 1 migraciones
│   ├── span.ets
│   └── diagnostic.ets
```

### Métricas Wave 0

- **Total LOC migrables**: 7,207
- **Tiempo baseline**: 25.30s (suma mediana, 69 ejemplos)
- **Promedio por ejemplo**: 367ms
- **Tamaño total .cpp**: 106 KB
- **Goldens**: 69 archivos, 100% estables entre runs

### Gaps detectados (6)

1. `import type` (alta) — cerrado en PR #89
2. `array.push()` (alta) — cerrado en PR #89
3. Object spread (media) — pendiente
4. Generic constraint completo (media) — verificado que ya funcionaba
5. Union con payload (baja) — tenemos alternativa (`Result<T>`)
6. Self-recursive interfaces (baja) — pendiente

---

## Wave 0.5 — Cerrar gaps bloqueantes ✅

**Status**: COMPLETADO

### Gaps cerrados

- **#1 — `import type`** (issue #86): parser consume `import [type] { ... } from "..."`.
- **#2 — `array.push()` y `array.length`** (issue #87): push añadido a ARRAY_METHODS, codegen emite `push_back()` y `size()`.
- **#4 — `<T extends Foo>`** (issue #88): verificado que ya funcionaba.

### Tests

- 166/166 unit verde
- E2E con push + length funcionando

### Commits

- PR #89 con los 3 fixes.

---

## Wave 1 — Hojas: span, diagnostic ✅ parcial

**Status**: EN PROGRESO (W1.1 cerrado, W1.2/W1.3 aplazados)

### W1.1 — `core/span.ts` + `core/diagnostic.ts` ✅

**Archivos migrados**:

- `bootstrap/core/span.ets` (28 LOC) — `Position`, `Span`, `span()`.
- `bootstrap/core/diagnostic.ets` (200 LOC) — `Diagnostic`, `DiagnosticError`, `formatDiagnostic`, `formatDiagnostics`.

**Cambios del dialecto documentados**:

- `interface X { fields }` → `class X { fields }` (interfaces solo métodos).
- `string.length` → `length(str)` built-in.
- `string.split('\n')` → manual con `splitLines()`.
- `Number → String` cast → `numberToString(n)` built-in.
- `process.env.X` → eliminado (se devuelve false siempre en `useColors()`).
- `extends Error` → wrapper manual (sin herencia).
- `out` keyword → `result`.
- `X as Type` cast → eliminado.
- `??` y `||` funcionan igual.

**Pendiente de migrar**:

- **W1.2 — `ast/nodes.ts`** (129 LOC): aplazado. El archivo tiene 30+ interfaces con campos `TypeName[]`, `Parameter[]`, etc. y uniones string-literal. Requiere decisiones de diseño.
- **W1.3 — `lexer/lexer.ts`** (137 LOC): aplazado hasta tener `ast/nodes.ets` migrado (depende de los tipos `Token`, `TokenKind`).

**Decisión**: Wave 1 queda en este estado. Wave 2 (migración del parser) replanteará las prioridades: si el parser es difícil de migrar por las dependencias de tipos AST, paramos y volvemos a `ast/nodes.ts`.

---

## Wave 2 — Parser (PENDIENTE)

Bloqueada por decisión de diseño en `ast/nodes.ts`.

---

## Hitos alcanzados

- ✅ Estructura `bootstrap/` creada.
- ✅ Golden tests 100% estables.
- ✅ 3 gaps cerrados (#1, #2, #4).
- ✅ `core/span.ets` y `core/diagnostic.ets` migrados y compilando.