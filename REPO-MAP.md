# Mapa del repositorio

Una sola página para localizar dónde vive cada cosa. Cada carpeta tiene su
propio `README.md` con detalle.

| Carpeta | Qué es | Más detalle |
|---|---|---|
| `src/` | **El transpilador.** TS sin dependencias npm, ~3K LOC en 26 ficheros. | [src/README.md](src/README.md) |
| `runtime/` | Cabeceras C++ (`inline namespace ets`) consumidas por el código generado. | [runtime/README.md](runtime/README.md) |
| `third_party/` | Tree-sitter y su grammar TypeScript vendoreadas. | [third_party/README.md](third_party/README.md) |
| `editors/` | Soporte de editor: grammar Estatic + plugins vscode/neovim. | [editors/README.md](editors/README.md) |
| `examples/` | Programas de prueba `.ets` y `.ts` — uno por característica. | [examples/README.md](examples/README.md) |
| `scripts/` | Tres utilidades bash: build-tree-sitter, regenerate-tree-sitter, build-ast-dump. | [scripts/README.md](scripts/README.md) |
| `build/` | Salidas generadas (no en git). `.cpp`, binarios, cache incremental, `transpiler-report.json`. | — |
| raíz | `package.json`, `tsconfig.json`, `estatic.config.ts`, `README.md` (Quickstart y referencia del lenguaje). | [README.md](README.md) |

## Flujo de un build

```
.ets / .ts  ──►  src/  ──►  .cpp + cabecera  ──►  g++ + runtime/  ──►  binario
                       ▲                          ▲
                       │                          │
              editor: examples/             third_party/ + scripts/
```

## Estado actual

- `src/` es la implementación canónica. Hay una fase 2 (autoalojado) pospuesta
  según [[project-status]] — no invertir esfuerzo en `/selfhost/` salvo que se
  pida.
- Build limpio en el árbol: `build/configured-app` imprime `26`.
