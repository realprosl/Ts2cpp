# tree-sitter-estatic

Gramática de Estatic derivada de `tree-sitter-typescript`. Reconoce formalmente
los modificadores contextuales `mut` y `out` mediante el campo `modifier` de
`required_parameter`.

```bash
npm install
npm run generate
npm test
```

El compilador conserva una ruta compatible de normalización mientras el parser
C generado no se haya actualizado. Los plugins de editor deben usar el parser
generado en este directorio.
