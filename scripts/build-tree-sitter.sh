#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="${1:-$project_dir/build/.estatic/native}"
cxx="${2:-g++}"
mkdir -p "$output_dir"

case "$(basename "$cxx")" in
  clang++*) c_compiler="${cxx%++}" ;;
  g++*) c_compiler="gcc" ;;
  *) c_compiler="${CC:-cc}" ;;
esac

compile_if_needed() {
  local source="$1"
  local output="$2"
  shift 2
  if [[ ! -f "$output" || "$source" -nt "$output" ]]; then
    "$c_compiler" -std=c11 -O2 -D_DEFAULT_SOURCE "$@" -c "$source" -o "$output"
  fi
}

compile_if_needed "$project_dir/third_party/tree-sitter/src/lib.c" "$output_dir/tree-sitter-runtime.o" \
  -I"$project_dir/third_party/tree-sitter/include" -I"$project_dir/third_party/tree-sitter/src"
compile_if_needed "$project_dir/third_party/tree-sitter-typescript/typescript/src/parser.c" "$output_dir/tree-sitter-typescript-parser.o" \
  -I"$project_dir/third_party/tree-sitter-typescript/typescript/src"
compile_if_needed "$project_dir/third_party/tree-sitter-typescript/typescript/src/scanner.c" "$output_dir/tree-sitter-typescript-scanner.o" \
  -I"$project_dir/third_party/tree-sitter-typescript/typescript/src" -I"$project_dir/third_party/tree-sitter-typescript"
