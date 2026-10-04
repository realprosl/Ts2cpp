#!/bin/bash
# run-benchmarks-all.sh — bateria de benchmarks V23 dialecto vs C++ nativo.
#
# Compila cada par (.ets vs .cpp) y los ejecuta con hyperfine. El
# objetivo es medir el OVERHEAD del codegen V23 (y de todo el dialecto)
# respecto a C++ nativo escrito a mano.
#
# Requiere: hyperfine, g++ con C++20, node 22+ (para el CLI del dialecto).

set -e

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$BENCH_DIR/../.." && pwd)"
SCRATCH="$ROOT_DIR/.scratch/bench"

mkdir -p "$SCRATCH"

# Compila cada par .ets/.cpp a binarios
echo "=== Compilando ==="
for src in "$BENCH_DIR"/*.ets; do
    name="$(basename "$src" .ets)"
    echo "--- $name ---"

    # Generar .cpp del dialecto
    node --experimental-strip-types --no-warnings \
        "$ROOT_DIR/src/cli.ts" "$src" -o "$SCRATCH/$name.cpp" 2>&1 | head -3

    # Compilar binario del dialecto
    g++ -O2 -std=c++20 -I"$ROOT_DIR" "$SCRATCH/$name.cpp" -o "$SCRATCH/$name" 2>&1 | head -3

    # Compilar binario nativo
    g++ -O2 -std=c++20 -I"$ROOT_DIR" "$BENCH_DIR/$name.cpp" -o "$SCRATCH/$name-native" 2>&1 | head -3
done

# Ejecutar hyperfine
echo ""
echo "=== Ejecutando hyperfine ==="
for src in "$BENCH_DIR"/*.ets; do
    name="$(basename "$src" .ets)"
    echo ""
    echo "--- $name ---"
    hyperfine -N --warmup 3 --runs 10 \
        --export-csv "$SCRATCH/$name.csv" \
        -n "ets" "$SCRATCH/$name" \
        -n "cpp" "$SCRATCH/$name-native" \
        2>&1 | tail -25
done

echo ""
echo "=== Generando RESULTS.md ==="
python3 "$BENCH_DIR/parse-results.py"
