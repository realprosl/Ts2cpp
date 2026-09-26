# Estatic Language Support para VS Code

Extensión sintáctica inicial para `.ets`:

- identificación del lenguaje;
- resaltado TypeScript reutilizado;
- resaltado específico de `mut` y `out`;
- comentarios, brackets, indentación y folding;
- snippets de funciones mutables y `Result<T>`.

Para probarla, abra `editors/vscode` con VS Code y ejecute `Extension
Development Host`. Para empaquetar:

```bash
npx @vscode/vsce package
```

Los diagnósticos, navegación y autocompletado semántico se añadirán mediante un
único servidor `estatic-lsp`, reutilizable también por Neovim.
