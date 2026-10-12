#!/usr/bin/env bash
#
# scripts/postinstall.sh — Se ejecuta automaticamente tras `npm install`.
#
# 1. Detecta la distribucion del sistema operativo.
# 2. Comprueba que las librerias de sistema que usa el runtime estan
#    instaladas:
#      - libuv   (event loop async, tcp/dns/timers/fs watchers)
#      - libcurl (cliente HTTP, V30.3+)
#      - openssl (TLS, V30.5+)
#    Si faltan, aborta con un mensaje claro indicando el comando
#    exacto que el usuario debe ejecutar para su distro. Esto evita
#    que el primer build del usuario falle con errores de linker
#    crípticos.
# 3. Pre-compila el runtime a `.o` cacheados en `build/`. Asi el
#    primer build del usuario no tarda 14 segundos compilando el
#    runtime; los .o ya estan listos.
#
# Banderas:
#   --skip-sysdeps  Salta el chequeo de librerias de sistema (asume
#                   que ya estan instaladas). Util para CI o si
#                   el usuario las instalo manualmente.
#   --with-sysdeps  Intenta instalar las dependencias via el package
#                   manager de la distro. Requiere sudo en Linux.
#                   PELIGRO: modifica el sistema del usuario.
#   --help          Muestra esta ayuda.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_DIR="${REPO_ROOT}/build"

SKIP_SYSDEPS=0
WITH_SYSDEPS=0
for arg in "$@"; do
  case "${arg}" in
    --skip-sysdeps) SKIP_SYSDEPS=1 ;;
    --with-sysdeps) WITH_SYSDEPS=1 ;;
    --help|-h)
      sed -n '2,30p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) echo "ERROR: argumento desconocido: ${arg}" >&2; exit 2 ;;
  esac
done

echo "==> Ts2cpp postinstall (version $(grep -oP '"version":\s*"\K[^"]+' "${REPO_ROOT}/package.json"))"

# ──────────────────────────────────────────────────────────────────
# 1. Detectar distro.
# ──────────────────────────────────────────────────────────────────

DISTRO=""
DISTRO_LIKE=""
PKG_MANAGER=""
PKG_INSTALL_CMD=""
PKG_CHECK_PRESENT=""

if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
  DISTRO="${ID:-unknown}"
  DISTRO_LIKE="${ID_LIKE:-}"
elif [[ "$(uname -s 2>/dev/null)" == "Darwin" ]]; then
  DISTRO="macos"
  DISTRO_LIKE=""
fi

case "${DISTRO}:${DISTRO_LIKE}" in
  # V30.9.1: derivadas de Ubuntu (Linux Mint, Pop!_OS, elementary OS,
  # KDE neon, Zorin OS, etc.) se tratan como debian porque comparten
  # apt + los mismos nombres de paquetes (libuv1-dev, libcurl4-openssl-dev,
  # libssl-dev). Antes solo `ID=ubuntu` o `ID=debian` matcheaban, lo que
  # dejaba a Linux Mint y Pop!_OS en el bucket `unknown`.
  #
  # El patron `*:ubuntu|*:*ubuntu*` cubre tanto `ID=ubuntu` como
  # `ID_LIKE="ubuntu debian"` (Pop!_OS, elementary) — la parte `*:*ubuntu*`
  # matchea cualquier `DISTRO_LIKE` que contenga "ubuntu" como substring.
  debian:*|ubuntu:*|linuxmint:*|pop:*|elementary:*|neon:*|zorinos:*|*:debian|*:ubuntu*)
    DISTRO="debian"
    PKG_MANAGER="apt"
    PKG_INSTALL_CMD="sudo apt-get install -y"
    PKG_CHECK_PRESENT="dpkg -l"
    PKG_NAMES=(libuv1-dev libcurl4-openssl-dev libssl-dev)
    ;;
  fedora:*|rhel:*|centos:*|rocky:*|almalinux:*)
    DISTRO="fedora"
    PKG_MANAGER="dnf"
    PKG_INSTALL_CMD="sudo dnf install -y"
    PKG_CHECK_PRESENT="rpm -q"
    PKG_NAMES=(libuv-devel libcurl-devel openssl-devel)
    ;;
  arch:*|manjaro:*|endeavouros:*)
    DISTRO="arch"
    PKG_MANAGER="pacman"
    PKG_INSTALL_CMD="sudo pacman -S --needed --noconfirm"
    PKG_CHECK_PRESENT="pacman -Q"
    PKG_NAMES=(libuv openssl curl)
    ;;
  alpine:*)
    DISTRO="alpine"
    PKG_MANAGER="apk"
    PKG_INSTALL_CMD="sudo apk add"
    PKG_CHECK_PRESENT="apk info -e"
    PKG_NAMES=(libuv-dev curl-dev openssl-dev)
    ;;
  macos:*)
    DISTRO="macos"
    PKG_MANAGER="brew"
    PKG_INSTALL_CMD="brew install"
    PKG_CHECK_PRESENT="brew list"
    PKG_NAMES=(libuv openssl curl)
    ;;
  *)
    DISTRO="unknown"
    ;;
esac

echo "==> Sistema: ${DISTRO} (package manager: ${PKG_MANAGER:-n/a})"

# ──────────────────────────────────────────────────────────────────
# 2. Comprobar dependencias del sistema.
# ──────────────────────────────────────────────────────────────────

if [[ "${SKIP_SYSDEPS}" -eq 1 ]]; then
  echo "==> --skip-sysdeps: saltando chequeo de librerias de sistema"
else
  if [[ -z "${PKG_MANAGER}" ]]; then
    echo ""
    echo "ERROR: distribucion no reconocida."
    echo "  Ts2cpp necesita: libuv-dev, libcurl-dev (con ssl), openssl-dev."
    echo "  Instala manualmente para tu distro y vuelve a ejecutar 'npm install'."
    echo "  Para saltarte este chequeo: 'npm install --skip-sysdeps'."
    exit 1
  fi

  MISSING_PKGS=()
  for pkg in "${PKG_NAMES[@]}"; do
    if ! ${PKG_CHECK_PRESENT} "${pkg}" >/dev/null 2>&1; then
      MISSING_PKGS+=("${pkg}")
    fi
  done

  if [[ ${#MISSING_PKGS[@]} -gt 0 ]]; then
    echo ""
    echo "ERROR: faltan librerias de sistema requeridas por el runtime:"
    for pkg in "${MISSING_PKGS[@]}"; do
      echo "  - ${pkg}"
    done
    echo ""
    if [[ "${WITH_SYSDEPS}" -eq 1 ]]; then
      echo "==> --with-sysdeps: instalando con ${PKG_MANAGER}..."
      ${PKG_INSTALL_CMD} "${MISSING_PKGS[@]}"
    else
      echo "Para instalarlas en ${DISTRO} ejecuta:"
      echo "  ${PKG_INSTALL_CMD} ${MISSING_PKGS[*]}"
      echo ""
      echo "O vuelve a ejecutar este script con --with-sysdeps para que lo haga automaticamente:"
      echo "  npm install --with-sysdeps"
      echo "  # equivalente a: bash scripts/postinstall.sh --with-sysdeps"
      echo ""
      echo "Si ya las tienes instaladas pero el chequeo falla (p.ej. version diferente),"
      echo "ejecuta con --skip-sysdeps:"
      echo "  npm install --skip-sysdeps"
      exit 1
    fi
  else
    echo "==> Dependencias del sistema OK: ${PKG_NAMES[*]}"
  fi
fi

# ──────────────────────────────────────────────────────────────────
# 3. Pre-compilar el runtime a .o cacheados.
#    (Delega en scripts/build-runtime.sh.)
# ──────────────────────────────────────────────────────────────────

# V29.3 (PR #157): libuv es el unico backend. Los .cpp de poll
# (runtime_ets_poll.cpp, runtime_ets_net.cpp) fueron borrados.
# build-runtime.sh tiene referencias obsoletas; las limpiamos aqui.
# (TODO: limpiar build-runtime.sh en un PR separado.)

echo "==> Pre-compilando runtime a .o cacheados en ${BUILD_DIR}/..."

# V30.9.1: crear el directorio de cache si no existe. En instalaciones
# limpias (npm install desde cero), build/ puede no existir, y g++
# falla con "No existe el archivo o el directorio" al hacer -o.
mkdir -p "${BUILD_DIR}"

# Compilar cada .cpp que exista.
RUNTIME_SRC=(
  "runtime_ets_libuv.cpp"
  "runtime_ets_net_libuv.cpp"
)
for src in "${RUNTIME_SRC[@]}"; do
  src_path="${REPO_ROOT}/runtime/${src}"
  obj_path="${BUILD_DIR}/${src%.cpp}.o"
  if [[ ! -f "${src_path}" ]]; then
    echo "    SKIP ${src} (no existe)"
    continue
  fi
  if [[ -f "${obj_path}" && "${obj_path}" -nt "${src_path}" ]]; then
    echo "    HIT  ${src} ($(du -h "${obj_path}" | cut -f1))"
    continue
  fi
  echo "    COMP ${src}"
  g++ -std=c++20 -O2 -Wall -Wextra -I"${REPO_ROOT}" \
      -DETS_EVENT_BACKEND_LIBUV \
      -c "${src_path}" -o "${obj_path}"
done

echo ""
echo "==> Ts2cpp postinstall completo."
echo "    Ahora puedes ejecutar 'npm start' o 'npm test' o usar la CLI directamente."

# ──────────────────────────────────────────────────────────────────
# 4. Ofrecer instalar el CLI globalmente con `npm link` (opcional).
#    Solo en TTY. Si el usuario acepta, crea un symlink en
#    $(npm prefix -g)/bin/estatic para que `estatic` esté disponible
#    en cualquier proyecto sin tener que ejecutar `tsx src/cli.ts`.
#    En CI / no-TTY / --yes=no, se omite y se imprime cómo hacerlo.
# ──────────────────────────────────────────────────────────────────

if [[ -t 1 && -t 0 ]]; then
  # Comprobar si el comando `etsc` ya esta disponible globalmente.
  if command -v etsc >/dev/null 2>&1; then
    echo "==> El comando 'etsc' ya esta disponible en PATH (link global existente). Saltando."
  else
    echo ""
    read -r -p "¿Instalar el comando 'etsc' globalmente con npm link? (y/n) " REPLY
    if [[ "${REPLY}" =~ ^[YySs]$ ]]; then
      echo "==> Ejecutando 'npm link'..."
      if npm link 2>&1 | tail -10; then
        echo "==> Listo. Ahora puedes usar 'etsc' desde cualquier directorio."
      else
        echo "WARN: 'npm link' fallo. Para hacerlo manualmente: 'npm run setup:link'."
      fi
    else
      echo "==> OK. Para instalar el comando 'etsc' mas tarde: 'npm run setup:link'"
    fi
  fi
else
  echo ""
  echo "INFO: no TTY detectado; saltando prompt de 'npm link'."
  echo "      Para usar 'etsc' globalmente ejecuta: 'npm run setup:link'"
fi
