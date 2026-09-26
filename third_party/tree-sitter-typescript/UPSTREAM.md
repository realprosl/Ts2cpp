# TypeScript grammar provenance

- Upstream: https://github.com/tree-sitter/tree-sitter-typescript
- Revision: `75b3874edb2dc714fb1fd77a32013d0f8699989f`
- License: MIT; see `LICENSE`.

## Cambios Estatic

`common/define-grammar.js` añade `parameter_modifier` con `mut` y `out` a los
parámetros requeridos y opcionales. El cambio se mantiene pequeño y aislado
para poder incorporar nuevas revisiones upstream y regenerar tanto el parser
`typescript` usado por el compilador como `tree-sitter-estatic` para editores.

The generated TypeScript parser is pinned so users do not need Node, Rust or
the Tree-sitter CLI to build Estatic. `grammar.js` and the JSON descriptions
are retained as the starting point for the `tree-sitter-estatic` fork.
