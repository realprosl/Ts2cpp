# Estatic para Neovim

Plugin de filetype, Tree-sitter y consultas para archivos `.ts` y `.ets`.

Primero genere el parser:

```bash
scripts/regenerate-tree-sitter.sh
```

Después añada `editors/neovim` a `runtimepath` y configure la ruta absoluta:

```lua
require("estatic").setup({
  grammar_dir = "/ruta/al/proyecto/editors/tree-sitter-estatic",
})

vim.cmd("TSInstall estatic")
```

El plugin registra el filetype, el parser y las queries de resaltado, locales,
indentación y folding. Un futuro `estatic-lsp` podrá conectarse mediante el
cliente LSP nativo sin cambiar esta integración.
