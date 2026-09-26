#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="${1:-$project_dir/build/tools}"
cxx="${2:-g++}"
mkdir -p "$output_dir"

"$project_dir/scripts/build-tree-sitter.sh" "$output_dir/tree-sitter" "$cxx"
"$cxx" -std=c++20 -O2 -fno-exceptions -I"$project_dir" \
  "$project_dir/tools/ets-ast-dump.cpp" \
  "$output_dir/tree-sitter/tree-sitter-runtime.o" \
  "$output_dir/tree-sitter/tree-sitter-typescript-parser.o" \
  "$output_dir/tree-sitter/tree-sitter-typescript-scanner.o" \
  -o "$output_dir/ets-ast-dump"

echo "$output_dir/ets-ast-dump"
