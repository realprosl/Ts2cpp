local M = {}

function M.setup(options)
  options = options or {}
  local grammar_dir = options.grammar_dir
  if not grammar_dir or grammar_dir == "" then
    error("estatic: setup necesita grammar_dir con la ruta de tree-sitter-estatic")
  end

  vim.filetype.add({ extension = { ts = "estatic", ets = "estatic" } })

  local ok, parsers = pcall(require, "nvim-treesitter.parsers")
  if not ok then
    vim.notify("estatic: nvim-treesitter no está disponible", vim.log.levels.WARN)
    return
  end

  local configurations = parsers.get_parser_configs()
  configurations.estatic = {
    install_info = {
      url = grammar_dir,
      files = { "src/parser.c", "src/scanner.c" },
      branch = "main",
    },
    filetype = "estatic",
  }

  vim.treesitter.language.register("estatic", "estatic")
end

return M
