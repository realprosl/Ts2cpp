# `scripts/` — utilidades de build

Tres scripts bash invocados manualmente (no los usa `npm start`). Tratan solo
las dependencias externas (`third_party/`) y el dumper de AST.

## `build-tree-sitter.sh`

Compila los tres objetos `.o` de Tree-sitter con `gcc` (o el equivalente del
`cxx`):

```
build-tree-sitter.sh [output_dir] [cxx]   # por defecto build/.estatic/native, g++
```

Salidas:

- `tree-sitter-runtime.o`
- `tree-sitter-typescript-parser.o`
- `tree-sitter-typescript-scanner.o`

Solo recompila si el `.c` es más nuevo que el `.o` correspondiente.

Usado por `build-ast-dump.sh` y, en la mayoría de builds, por el compilador
de Tree-sitter que enlaza contra `runtime/ets_syntax.hpp`.

## `regenerate-tree-sitter.sh`

Refresca la copia local de la grammar Estatic cuando cambia
`third_party/tree-sitter-typescript/`:

1. Copia `define-grammar.js` y `scanner.h` desde el vendoreado a
   `editors/tree-sitter-estatic/`.
2. Genera el parser con `tree-sitter generate`.
3. Corre el corpus `tree-sitter test`.

Requiere `tree-sitter` CLI (global o `npm install` en
`editors/tree-sitter-estatic/`).

## `build-ast-dump.sh`

> **Estado actual:** roto. El script referencia `tools/ets-ast-dump.cpp`, que
> no existe en el repositorio. Mantenerlo documentado por si se reactiva.

Iba a compilar una herramienta `ets-ast-dump` reutilizando los `.o` de
`build-tree-sitter.sh`. Si se necesita dumper de AST a futuro, hay que:

- Añadir `tools/ets-ast-dump.cpp` con un `main()` que use
  `runtime/ets_syntax.hpp`.
- Reajustar flags para reflejar el código real.
