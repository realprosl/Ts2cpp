#!/usr/bin/env bash
# V30.54: Test runner para el CLI `todo` (multi-modulo, in-memory storage).
# Ejecuta varios comandos en procesos separados. Cada proceso es
# independiente (storage in-memory) — para esta demo solo verificamos
# que el binario ejecuta correctamente, parsea args, y produce
# el output esperado.
#
# Nota: el codegen actual retorna 0 desde int main aunque el
# dispatch() retorne un codigo de error (el user imprime "EXIT=N"
# pero el proceso retorna 0). Los tests verifican el output
# (incluyendo "EXIT=N") en lugar del exit code del proceso.

set -e

cd "$(dirname "$0")" || exit 1

ETS="/root/.hermes/tools/node-26.7.0-linux-x64/bin/etsc"
GXX="g++ -std=c++20 -O2 -DNDEBUG -pthread -fno-exceptions"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# run.sh vive en test/apps/todo/, asi que necesitamos 3 niveles
# para llegar al repo root (Ts2cpp/).
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
INCLUDE="-I${ROOT_DIR} -I${ROOT_DIR}/runtime"
RUNTIME_OBJ="${ROOT_DIR}/build/runtime_ets_libuv.o"

PASS=0
FAIL=0

# Compila. g++ se invoca desde el repo root para que los includes
# del cpp generado (`#include "runtime/ets_runtime.hpp"`) se
# resuelvan correctamente.
rm -f todo.cpp todo
${ETS} todo.ets > /tmp/etsc_out.txt 2>&1 || { echo "etsc failed"; cat /tmp/etsc_out.txt; exit 1; }
if ! (cd "${ROOT_DIR}" && ${GXX} ${INCLUDE} "${SCRIPT_DIR}/todo.cpp" ${RUNTIME_OBJ} -luv -o "${SCRIPT_DIR}/todo") > /tmp/gxx_out.txt 2>&1; then
  echo "g++ failed"
  cat /tmp/gxx_out.txt
  exit 1
fi

# Test 1: sin args -> usage + EXIT=1.
out=$(./todo 2>&1) || true
if [[ "$out" == *"uso: todo"* ]] && [[ "$out" == *"EXIT=1"* ]]; then
  echo "PASS: sin args muestra usage y EXIT=1"
  PASS=$((PASS + 1))
else
  echo "FAIL: sin args (out=$out)"
  FAIL=$((FAIL + 1))
fi

# Test 2: help -> usage + EXIT=0.
out=$(./todo help 2>&1) || true
if [[ "$out" == *"uso: todo"* ]] && [[ "$out" == *"EXIT=0"* ]]; then
  echo "PASS: help retorna EXIT=0"
  PASS=$((PASS + 1))
else
  echo "FAIL: help (out=$out)"
  FAIL=$((FAIL + 1))
fi

# Test 3: add sin texto -> error + EXIT=1.
out=$(./todo add 2>&1) || true
if [[ "$out" == *"requiere"* ]] && [[ "$out" == *"EXIT=1"* ]]; then
  echo "PASS: add sin texto retorna error y EXIT=1"
  PASS=$((PASS + 1))
else
  echo "FAIL: add sin texto (out=$out)"
  FAIL=$((FAIL + 1))
fi

# Test 4: add con texto -> ok + EXIT=0.
out=$(./todo add 'comprar pan' low 2>&1) || true
if [[ "$out" == *"added: 1"* ]] && [[ "$out" == *"EXIT=0"* ]]; then
  echo "PASS: add con texto retorna added: 1 y EXIT=0"
  PASS=$((PASS + 1))
else
  echo "FAIL: add con texto (out=$out)"
  FAIL=$((FAIL + 1))
fi

# Test 5: list -> header + EXIT=0.
out=$(./todo list 2>&1) || true
if [[ "$out" == *"ID  PRIO  STATUS  TEXT"* ]] && [[ "$out" == *"EXIT=0"* ]]; then
  echo "PASS: list muestra header y EXIT=0"
  PASS=$((PASS + 1))
else
  echo "FAIL: list (out=$out)"
  FAIL=$((FAIL + 1))
fi

# Test 6: done con id invalido -> error + EXIT=1.
out=$(./todo done 99 2>&1) || true
if [[ "$out" == *"error"* ]] && [[ "$out" == *"EXIT=1"* ]]; then
  echo "PASS: done invalido retorna error y EXIT=1"
  PASS=$((PASS + 1))
else
  echo "FAIL: done invalido (out=$out)"
  FAIL=$((FAIL + 1))
fi

# Test 7: clear -> ok + EXIT=0.
out=$(./todo clear 2>&1) || true
if [[ "$out" == *"cleared"* ]] && [[ "$out" == *"EXIT=0"* ]]; then
  echo "PASS: clear retorna cleared y EXIT=0"
  PASS=$((PASS + 1))
else
  echo "FAIL: clear (out=$out)"
  FAIL=$((FAIL + 1))
fi

# Test 8: comando desconocido -> error + EXIT=1.
out=$(./todo foo 2>&1) || true
if [[ "$out" == *"desconocido"* ]] && [[ "$out" == *"EXIT=1"* ]]; then
  echo "PASS: comando desconocido retorna error y EXIT=1"
  PASS=$((PASS + 1))
else
  echo "FAIL: comando desconocido (out=$out)"
  FAIL=$((FAIL + 1))
fi

# Limpia.
rm -f todo.cpp todo

echo ""
echo "=== test/apps/todo summary ==="
echo "PASS: $PASS"
echo "FAIL: $FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
