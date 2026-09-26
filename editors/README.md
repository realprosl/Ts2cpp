# `editors/` — soporte de editor para Estatic

Plugins y gramática para colorear/parsear `.ets` en distintos editores.

## Subcarpetas

- **`tree-sitter-estatic/`** — grammar Estatic basada en la de TypeScript
  (vendoreada en `third_party/tree-sitter-typescript/`). Provee `parser.c`
  para los editores y, regenerada, los objetos `.o` consumidos por
  `runtime/ets_syntax.hpp`. Ver `editors/tree-sitter-estatic/README.md`.
- **`neovim/`** — plugin Neovim.
- **`vscode/`** — extensión VS Code.

Cada subcarpeta tiene su propio `README.md` con instrucciones de instalación.

## Mantenimiento

Cuando cambie la gramática TypeScript upstream (en
`third_party/tree-sitter-typescript/`), refresca la copia usada por
`editors/tree-sitter-estatic/` ejecutando:

```
./scripts/regenerate-tree-sitter.sh
```
