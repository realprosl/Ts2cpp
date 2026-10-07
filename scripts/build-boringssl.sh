#!/usr/bin/env bash
#
# scripts/build-boringssl.sh — Compila BoringSSL estaticamente desde
# third_party/boringssl/ hacia build/libs/boringssl/.
#
# BoringSSL es un fork de OpenSSL mantenido por Google. Mas pequeno
# (~93MB vs ~200MB de OpenSSL upstream), compila mas rapido (~2 min
# vs ~5 min) y tiene una API compatible con OpenSSL 1.1.x.
#
# Uso: scripts/build-boringssl.sh
#
# Salidas:
#   - build/libs/boringssl/lib/libssl.a    (TLS)
#   - build/libs/boringssl/lib/libcrypto.a (primitivas)
#   - build/libs/boringssl/include/openssl/ (headers)
#
# Por que local (no apt install libssl-dev):
#   - Cross-distro: mismo repo funciona en Debian/Ubuntu/Arch/macOS/Windows.
#   - Reproducibilidad: pineado a commit especifico.
#   - Cold compile cacheado en build/libs/boringssl/, no recompila.
#   - Cero dependencias del sistema (solo cmake + make).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BSSL_SRC="${REPO_ROOT}/third_party/boringssl"
BUILD_WORK="${BSSL_SRC}/build"
INSTALL_DIR="${REPO_ROOT}/build/libs/boringssl"

# Validar submódulo.
if [[ ! -d "${BSSL_SRC}/include" ]]; then
    echo "ERROR: third_party/boringssl/ no esta inicializado."
    echo "       Ejecuta: git submodule update --init --recursive"
    exit 1
fi

# Validar cmake.
if ! command -v cmake >/dev/null 2>&1; then
    echo "ERROR: cmake no esta instalado."
    exit 1
fi

# Cache HIT: si libssl.a y libcrypto.a existen, saltar.
SSL_A="${INSTALL_DIR}/lib/libssl.a"
CRYPTO_A="${INSTALL_DIR}/lib/libcrypto.a"
if [[ -f "${SSL_A}" ]] && [[ -f "${CRYPTO_A}" ]]; then
    SIZE_SSL=$(du -h "${SSL_A}" | cut -f1)
    SIZE_CRYPTO=$(du -h "${CRYPTO_A}" | cut -f1)
    echo "==> Cache HIT: BoringSSL ya compilado"
    echo "    libssl.a: ${SIZE_SSL}, libcrypto.a: ${SIZE_CRYPTO}"
    echo "    Para forzar recompilacion: rm -rf ${INSTALL_DIR}"
    exit 0
fi

# Build via cmake.
echo "==> Configurando BoringSSL con cmake"
mkdir -p "${BUILD_WORK}"
(cd "${BUILD_WORK}" && cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    -DBUILD_TESTING=OFF \
    -DCMAKE_INSTALL_PREFIX="${INSTALL_DIR}" \
    > /dev/null)

echo "==> Compilando BoringSSL (esto puede tardar 2-5 min en cold cache)"
(cd "${BUILD_WORK}" && make -j"$(nproc)" ssl crypto > /dev/null)

echo "==> Instalando en ${INSTALL_DIR}"
(cd "${BUILD_WORK}" && make install > /dev/null)

# Limpiar artefactos del build.
rm -rf "${BUILD_WORK}"

# Limpiar .so* (no necesarios para enlace estatico).
rm -f "${INSTALL_DIR}"/lib/libssl.so* "${INSTALL_DIR}"/lib/libcrypto.so*

# Verificar.
if [[ ! -f "${SSL_A}" ]] || [[ ! -f "${CRYPTO_A}" ]]; then
    echo "ERROR: BoringSSL no se genero correctamente"
    exit 1
fi

SIZE_SSL=$(du -h "${SSL_A}" | cut -f1)
SIZE_CRYPTO=$(du -h "${CRYPTO_A}" | cut -f1)
echo "==> OK: BoringSSL estatico"
echo "    libssl.a: ${SIZE_SSL}"
echo "    libcrypto.a: ${SIZE_CRYPTO}"
echo "    Headers: ${INSTALL_DIR}/include/openssl/"
echo ""
echo "Uso:"
echo "  g++ -I${INSTALL_DIR}/include programa.cpp ${SSL_A} ${CRYPTO_A} -lpthread -ldl -o programa"