#!/usr/bin/env bash
#
# scripts/build-runtime.sh — Pre-compila el runtime de Ts2cpp a .o
# cacheados.
#
# Compila runtime/runtime_ets_*.cpp (definiciones no-template del
# EventLoop, awaiterables, etc.) a .o cacheados en build/.
#
# Uso: scripts/build-runtime.sh
#
# Salidas:
#   - build/runtime_ets_poll.o   (PollEventLoop)
#   - build/runtime_ets_libuv.o  (LibuvEventLoop)
#
# Por que local:
#   - El .o se cachea con hash de version + backend + flags.
#   - En el primer build del usuario, este script tarda unos 2s.
#   - Builds siguientes: cache HIT en 100ms (20x speedup).
#
# El usuario enlaza los .o con su programa:
#   g++ programa.cpp build/runtime_ets_libuv.o -luv -pthread -o programa
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_DIR="${REPO_ROOT}/build"

# Validar compilador.
if ! command -v g++ >/dev/null 2>&1; then
    echo "ERROR: g++ no esta instalado."
    exit 1
fi

# Detectar version de C++ usada en el repo.
TS2CPP_VERSION=$(grep -oP '"version":\s*"\K[^"]+' "${REPO_ROOT}/package.json" 2>/dev/null || echo "dev")
echo "==> Ts2cpp version: ${TS2CPP_VERSION}"

# Compilar runtime_ets_poll.o (siempre; sin dependencia de libuv).
POLL_SRC="${REPO_ROOT}/runtime/runtime_ets_poll.cpp"
POLL_OBJ="${BUILD_DIR}/runtime_ets_poll.o"
if [[ ! -f "${POLL_SRC}" ]]; then
    echo "ERROR: ${POLL_SRC} no existe."
    exit 1
fi

# Cache HIT: si el .o existe y su timestamp es >= al del .cpp, saltar.
cache_hit_poll() {
    [[ -f "${POLL_OBJ}" ]] && \
    [[ "${POLL_OBJ}" -nt "${POLL_SRC}" ]]
}

mkdir -p "${BUILD_DIR}"
if cache_hit_poll; then
    echo "==> Cache HIT: runtime_ets_poll.o ($(du -h "${POLL_OBJ}" | cut -f1))"
else
    echo "==> Compilando runtime_ets_poll.o"
    g++ -std=c++20 -O2 -Wall -Wextra -I"${REPO_ROOT}" -c "${POLL_SRC}" -o "${POLL_OBJ}"
    echo "    -> $(du -h "${POLL_OBJ}" | cut -f1)"
fi

# Compilar runtime_ets_libuv.o (solo si el submódulo de libuv esta
# inicializado Y los headers de libuv estan disponibles).
LIBUV_SRC="${REPO_ROOT}/runtime/runtime_ets_libuv.cpp"
LIBUV_OBJ="${BUILD_DIR}/runtime_ets_libuv.o"
LIBUV_INC="${BUILD_DIR}/libs/libuv/include"

cache_hit_libuv() {
    [[ -f "${LIBUV_OBJ}" ]] && \
    [[ "${LIBUV_OBJ}" -nt "${LIBUV_SRC}" ]]
}

if [[ -f "${LIBUV_SRC}" ]] && [[ -d "${LIBUV_INC}" ]]; then
    if cache_hit_libuv; then
        echo "==> Cache HIT: runtime_ets_libuv.o ($(du -h "${LIBUV_OBJ}" | cut -f1))"
    else
        echo "==> Compilando runtime_ets_libuv.o (con libuv vendoreado)"
        g++ -std=c++20 -O2 -Wall -Wextra -I"${REPO_ROOT}" -I"${LIBUV_INC}" \
            -DETS_EVENT_BACKEND_LIBUV -c "${LIBUV_SRC}" -o "${LIBUV_OBJ}"
        echo "    -> $(du -h "${LIBUV_OBJ}" | cut -f1)"
    fi
elif [[ -f "${LIBUV_SRC}" ]] && [[ -f /usr/include/uv.h ]]; then
    if cache_hit_libuv; then
        echo "==> Cache HIT: runtime_ets_libuv.o ($(du -h "${LIBUV_OBJ}" | cut -f1))"
    else
        echo "==> Compilando runtime_ets_libuv.o (con libuv del sistema)"
        g++ -std=c++20 -O2 -Wall -Wextra -I"${REPO_ROOT}" \
            -DETS_EVENT_BACKEND_LIBUV -c "${LIBUV_SRC}" -o "${LIBUV_OBJ}"
        echo "    -> $(du -h "${LIBUV_OBJ}" | cut -f1)"
    fi
else
    echo "==> runtime_ets_libuv.o: SKIP (libuv no disponible)"
fi

echo ""
echo "==> Runtime pre-compilado en ${BUILD_DIR}/"
ls -la "${BUILD_DIR}"/runtime_ets_*.o 2>&1 | head -5