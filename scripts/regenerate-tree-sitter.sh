#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
grammar_dir="$project_dir/editors/tree-sitter-estatic"

# La copia del plugin es autocontenida, pero la fuente canónica vive junto al
# parser vendorizado para que futuras actualizaciones upstream sean mecánicas.
cp "$project_dir/third_party/tree-sitter-typescript/common/define-grammar.js" "$grammar_dir/define-grammar.js"
cp "$project_dir/third_party/tree-sitter-typescript/common/scanner.h" "$grammar_dir/src/scanner.h"

tree_sitter_command=""
if command -v tree-sitter >/dev/null 2>&1; then
  tree_sitter_command="$(command -v tree-sitter)"
elif [[ -x "$grammar_dir/node_modules/.bin/tree-sitter" ]]; then
  tree_sitter_command="$grammar_dir/node_modules/.bin/tree-sitter"
else
  echo "Falta tree-sitter-cli. Ejecute 'npm install' en $grammar_dir o instálelo globalmente." >&2
  exit 2
fi

cd "$grammar_dir"
"$tree_sitter_command" generate
"$tree_sitter_command" test

echo "Parser Estatic generado y corpus validado en $grammar_dir/src"
