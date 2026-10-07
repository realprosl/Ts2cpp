#!/usr/bin/env bash
#
# scripts/build-curl.sh — Compila libcurl estaticamente desde
# third_party/curl/ hacia build/libs/curl/, enlazando contra la
# BoringSSL vendoreada (PR #124).
#
# libcurl es la libreria cliente HTTP/HTTPS estandar de facto.
# Se compila estaticamente para OpenSSL (compatible con BoringSSL
# gracias a la API equivalente).
#
# Uso: scripts/build-curl.sh
#
# Salidas:
#   - build/libs/curl/lib/libcurl.a  (~6 MB)
#   - build/libs/curl/include/curl/ (12 headers)
#
# Por que local (no apt install libcurl4-openssl-dev):
#   - Cross-distro: mismo repo funciona en Debian/Ubuntu/Arch/macOS/Windows.
#   - Reproducibilidad: pineado a commit especifico.
#   - Cold compile cacheado, no recompila.
#   - Cero dependencias del sistema (solo cmake + make).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CURL_SRC="${REPO_ROOT}/third_party/curl"
BORINGSSL="${REPO_ROOT}/build/libs/boringssl"
BUILD_WORK="${CURL_SRC}/build"
INSTALL_DIR="${REPO_ROOT}/build/libs/curl"

# Validar submódulos.
if [[ ! -d "${CURL_SRC}/include" ]]; then
    echo "ERROR: third_party/curl/ no esta inicializado."
    echo "       Ejecuta: git submodule update --init --recursive"
    exit 1
fi
if [[ ! -f "${BORINGSSL}/lib/libssl.a" ]]; then
    echo "ERROR: BoringSSL vendoreada no encontrada en ${BORINGSSL}."
    echo "       Ejecuta: scripts/build-boringssl.sh primero."
    exit 1
fi

# Validar cmake.
if ! command -v cmake >/dev/null 2>&1; then
    echo "ERROR: cmake no esta instalado."
    exit 1
fi

# Cache HIT: si libcurl.a existe, saltar.
LIBCURL_A="${INSTALL_DIR}/lib/libcurl.a"
if [[ -f "${LIBCURL_A}" ]]; then
    SIZE=$(du -h "${LIBCURL_A}" | cut -f1)
    echo "==> Cache HIT: libcurl ya compilado (${SIZE})"
    echo "    Para forzar recompilacion: rm -rf ${INSTALL_DIR}"
    exit 0
fi

# Build via cmake. Optimizado: solo libcurl_static target (no binario CLI).
echo "==> Configurando libcurl con cmake (vs BoringSSL vendoreada)"
mkdir -p "${BUILD_WORK}"
(cd "${BUILD_WORK}" && cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    -DBUILD_TESTING=OFF \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_EXAMPLES=OFF \
    -DCMAKE_INSTALL_PREFIX="${INSTALL_DIR}" \
    -DOPENSSL_ROOT_DIR="${BORINGSSL}" \
    -DCURL_USE_OPENSSL=ON \
    -DCURL_DISABLE_LDAP=ON \
    -DCURL_DISABLE_LDAPS=ON \
    -DCURL_USE_LIBPSL=OFF \
    -DCURL_USE_LIBIDN2=OFF \
    -DCURL_USE_NGHTTP2=OFF \
    -DCURL_USE_ZLIB=OFF \
    -DCURL_USE_BROTLI=OFF \
    -DCURL_USE_RUSTLS=OFF \
    -DCURL_USE_MBEDTLS=OFF \
    -DCURL_USE_WOLFSSL=OFF \
    > /dev/null)

echo "==> Compilando libcurl_static (target, no el binario CLI)"
(cd "${BUILD_WORK}" && make -j"$(nproc)" libcurl_static > /dev/null)

# Instalar manualmente: make install falla porque intenta construir
# el binario CLI de curl, que necesita paquetes extra.
mkdir -p "${INSTALL_DIR}/lib" "${INSTALL_DIR}/include/curl"
cp "${BUILD_WORK}/lib/libcurl.a" "${LIBCURL_A}"
cp "${CURL_SRC}/include/curl/"*.h "${INSTALL_DIR}/include/curl/"

# Limpiar artefactos del build.
rm -rf "${BUILD_WORK}"

# Verificar.
if [[ ! -f "${LIBCURL_A}" ]]; then
    echo "ERROR: libcurl.a no se genero correctamente"
    exit 1
fi

SIZE=$(du -h "${LIBCURL_A}" | cut -f1)
HEADER_COUNT=$(ls "${INSTALL_DIR}/include/curl/" | wc -l)
echo "==> OK: libcurl vendoreado"
echo "    libcurl.a: ${SIZE}"
echo "    Headers: ${HEADER_COUNT} archivos en ${INSTALL_DIR}/include/curl/"
echo ""
echo "Uso:"
echo "  g++ -I${INSTALL_DIR}/include programa.cpp ${LIBCURL_A} \\"
echo "     ${BORINGSSL}/lib/libssl.a ${BORINGSSL}/lib/libcrypto.a \\"
echo "     -lpthread -ldl -o programa"