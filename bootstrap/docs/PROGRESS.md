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
```

### Métricas

- **Total LOC migrables**: 7,207
- **Tiempo baseline**: 25.30s (suma mediana, 69 ejemplos)
- **Promedio por ejemplo**: 367ms
- **Tamaño total .cpp**: 106 KB
- **Goldens**: 69 archivos, 100% estables entre runs

### Gaps detectados (6)

1. `import type` (alta) — bloquea Wave 1
2. `array.push()` (alta) — bloquea cualquier código con collections
3. Object spread (media) — bloquea codegen con object literals
4. Generic constraint completo (media) — bloquea type-system con bounds
5. Union con payload (baja) — tenemos alternativa (`Result<T>`)
6. Self-hosting falla por gap #1 (probado compilando `src/codegen/cpp-generator.ts`)

### Decisiones tomadas

- Estructura `bootstrap/` paralela a `src/` con subcarpetas por dominio
- Cada archivo migrado tiene cabecera mínima + notas (`.ets` + `.notes.md`)
- Golden tests con hash SHA-256 + JSON canonicalizado
- Verificación bit-by-bit como mecanismo de regresión
- Documentar gaps con prioridad + workaround

---

## Wave 1 — Hojas: core, ast, lexer (PENDIENTE)

**Bloqueada por**: Gap #1 (`import type`)

### Pre-requisitos

Cerrar gaps antes de empezar:
- [ ] Soporte `import type` en parser (15 min)
- [ ] `array.push()` como built-in (1 hora)
- [ ] Generic constraint completo (2-3 horas)

### Tareas

- [ ] Migrar `core/diagnostic.ts` (84 LOC)
- [ ] Migrar `ast/nodes.ts` (93 LOC)
- [ ] Migrar `lexer/lexer.ts` (137 LOC)
- [ ] Verificar con golden tests
- [ ] Medir rendimiento del lexer Estatic vs TS