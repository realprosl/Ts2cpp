# Bootstrap: Migración del compilador Ts2cpp a Estatic

**Estado**: Wave 0 (preparación)
**Inicio**: 2026-10-02

## Objetivo

Re-escribir el compilador Ts2cpp (TypeScript → C++) completamente en
Estatic. El compilador Estatic debe producir los mismos binarios que el
compilador TS para los mismos inputs.

## Estructura de carpetas

```
bootstrap/
├── core/           # Diagnostic, Span — Wave 1
├── ast/            # AST nodes — Wave 1
├── lexer/          # Lexer — Wave 1
├── parser/         # Parser — Wave 2
├── types/          # Type system (helpers) — Wave 3
├── semantic/       # Type-checker — Wave 3
├── codegen/        # C++ codegen — Wave 4
├── modules/        # Module loader — Wave 5
├── build/          # Incremental builder — Wave 5
├── test/
│   ├── golden/     # ASTs + .cpp snapshots de los 65 ejemplos
│   └── benchmark/  # Tiempos del compilador TS baseline
└── docs/
    ├── ROADMAP.md  # Este archivo
    ├── PROGRESS.md # Estado por wave
    └── BENCHMARK-RESULTS.md # Datos de Wave 0
```

## Estado de las waves

- [x] **Wave 0**: setup, golden tests, benchmark baseline
- [ ] **Wave 1**: hojas — core, ast, lexer
- [ ] **Wave 2**: parser
- [ ] **Wave 3**: type system + semantic
- [ ] **Wave 4**: codegen
- [ ] **Wave 5**: build + CLI + modules
- [ ] **Wave 6**: self-hosting estable

## Convención de nombrado

Cada archivo migrado tiene prefijo de wave:

- `bootstrap/core/diagnostic.ets` — el .ets a crear
- `bootstrap/core/diagnostic.notes.md` — notas de la migración
- `bootstrap/core/diagnostic.test.ts` — tests específicos (si son nuevos)

Los archivos .ets empiezan **vacíos** (solo cabecera) y se van poblando
durante la wave correspondiente.

## Cómo verificar el progreso

En cada wave:

1. Migrar un archivo .ts a .ets
2. Compilar el .ets con el compilador TS actual
3. Comparar el output con el TS original (hash)
4. Si difiere: rollback + reportar el gap del dialecto

Si un archivo no se puede migrar, queda en `.ts` y se documenta el
problema en `bootstrap/docs/GAPS.md`.

## Referencia

- Compilador TS original: `src/`
- Tests: `test/unit/*.test.ts` (166 tests), `examples/*.ets` (65 ejemplos)
- Golden tests: `bootstrap/test/golden/`