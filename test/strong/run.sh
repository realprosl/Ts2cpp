#!/usr/bin/env bash
# V30.52: Test runner para los proyectos de test/strong/.
# Compila cada proyecto con etsc, lo compila con g++, lo ejecuta y
# compara el output con el esperado.

set -e

cd "$(dirname "$0")/../.."

ETS="/root/.hermes/tools/node-26.7.0-linux-x64/bin/etsc"
GXX="g++ -std=c++20 -O2 -DNDEBUG -pthread -fno-exceptions"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
INCLUDE="-I${ROOT_DIR} -I${ROOT_DIR}/runtime"
RUNTIME_OBJ="${ROOT_DIR}/build/runtime_ets_libuv.o"

PASS=0
FAIL=0

# test_strong <project_dir> <expected_output>
test_strong() {
  local dir="$1"
  local expected="$2"
  echo "--- test/strong/$dir ---"
  cd "test/strong/$dir" || return 1
  rm -f main.cpp test_app
  local actual
  set +e
  $ETS main.ets > /tmp/etsc_out.txt 2>&1
  if [[ $? -ne 0 ]]; then
    echo "etsc failed:"
    cat /tmp/etsc_out.txt
    cd - >/dev/null
    FAIL=$((FAIL + 1))
    return 1
  fi
  $GXX $INCLUDE main.cpp $RUNTIME_OBJ -luv -o test_app > /tmp/gxx_out.txt 2>&1
  if [[ $? -ne 0 ]]; then
    echo "g++ failed:"
    cat /tmp/gxx_out.txt
    cd - >/dev/null
    FAIL=$((FAIL + 1))
    return 1
  fi
  actual=$(./test_app 2>&1)
  if [[ $? -ne 0 ]]; then
    echo "run failed"
    cd - >/dev/null
    FAIL=$((FAIL + 1))
    return 1
  fi
  set -e
  rm -f main.cpp test_app
  cd - >/dev/null
  if [[ "$actual" == "$expected" ]]; then
    echo "PASS: $dir"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $dir"
    echo "Expected:"
    echo "$expected" | sed 's/^/  /'
    echo "Actual:"
    echo "$actual" | sed 's/^/  /'
    FAIL=$((FAIL + 1))
  fi
}

# app_basic: cross-module @comptime + comptime()
test_strong "app_basic" "factorial(5) =
120
fib(10) =
89
isPrime(17) = true
isPrime(24) = false
gcd(48, 18) =
6
pow(2, 10) =
1024
comptime(6*7) =
42"

# app_generated: cross-module @cppgen + @etsgen
test_strong "app_generated" "0
1
2
hello from cppgen
done"

# app_collections: cross-module con arrays, strings, comptime()
test_strong "app_collections" "joined:
hola, mundo, foo, bar
sum:
150
count > 25:
3
comptime sum:
15"

# app_string_ops: V30.55 builtins de string + as cast + arr[i]=x
test_strong "app_string_ops" "h
6
world
4
100
300
foo"

echo ""
echo "=== test/strong summary ==="
echo "PASS: $PASS"
echo "FAIL: $FAIL"
exit $FAIL
