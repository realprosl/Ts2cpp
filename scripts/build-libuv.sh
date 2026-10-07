#!/usr/bin/env bash
#
# scripts/build-libuv.sh — Compila libuv estáticamente desde
# third_party/libuv/ hacia build/libs/libuv/.
#
# Uso: scripts/build-libuv.sh [VERSION]
#   VERSION: tag de libuv a usar (default: v1.48.0).
#
# Salidas:
#   - build/libs/libuv/lib/libuv.a      (librería estática)
#   - build/libs/libuv/include/uv*.h    (cabeceras)
#
# Por qué local (no apt install libuv-dev):
#   - Cross-distro: mismo repo funciona en Debian/Ubuntu/Arch/macOS.
#   - Reproducibilidad: pinned a un tag específico.
#   - Cold compile cacheado en build/libs/, no recompila cada build.
#   - Cero dependencias del sistema (solo cmake + make).
#
set -euo pipefail

# Versión por defecto.
VERSION="${1:-v1.48.0}"

# Paths.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LIBUV_SRC="${REPO_ROOT}/third_party/libuv"
BUILD_DIR="${REPO_ROOT}/build/libs/libuv"
BUILD_WORK="${LIBUV_SRC}/build"

# Validar que el submódulo está inicializado.
if [[ ! -d "${LIBUV_SRC}/include" ]]; then
    echo "ERROR: third_party/libuv/ no está inicializado."
    echo "       Ejecuta: git submodule update --init --recursive"
    exit 1
fi

# Validar versión.
CURRENT_TAG=$(cd "${LIBUV_SRC}" && git describe --tags --exact-match 2>/dev/null || echo "unknown")
if [[ "${CURRENT_TAG}" != "${VERSION}" ]]; then
    echo "==> Checkout libuv ${VERSION} (estaba en ${CURRENT_TAG})"
    (cd "${LIBUV_SRC}" && git fetch --tags --quiet && git checkout "${VERSION}" --quiet)
fi

# Validar cmake.
if ! command -v cmake >/dev/null 2>&1; then
    echo "ERROR: cmake no está instalado. Instala con:"
    echo "  - Debian/Ubuntu: apt install cmake"
    echo "  - macOS:         brew install cmake"
    echo "  - Fedora:        dnf install cmake"
    exit 1
fi

# Build via cmake (configura, compila, instala).
echo "==> Configurando libuv ${VERSION} con cmake"
mkdir -p "${BUILD_WORK}"
(cd "${BUILD_WORK}" && cmake .. \
    -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    -DCMAKE_INSTALL_PREFIX="${BUILD_DIR}" \
    -DCMAKE_BUILD_TYPE=Release \
    > /dev/null)

echo "==> Compilando libuv (esto puede tardar 1-2 min en cold cache)"
(cd "${BUILD_WORK}" && make -j"$(nproc)" > /dev/null)

echo "==> Instalando en ${BUILD_DIR}"
(cd "${BUILD_WORK}" && make install > /dev/null)

# Limpiar artefactos del build (no los queremos en el repo).
rm -rf "${BUILD_WORK}"

# Verificar.
STATIC_LIB="${BUILD_DIR}/lib/libuv.a"
if [[ ! -f "${STATIC_LIB}" ]]; then
    echo "ERROR: build/libs/libuv/lib/libuv.a no se generó"
    exit 1
fi

SIZE=$(du -h "${STATIC_LIB}" | cut -f1)
echo "==> OK: libuv estática en ${STATIC_LIB} (${SIZE})"
echo "    Headers en ${BUILD_DIR}/include/"
echo ""
echo "Uso:"
echo "  g++ -I${BUILD_DIR}/include programa.cpp ${STATIC_LIB} -lpthread -ldl -o programa"