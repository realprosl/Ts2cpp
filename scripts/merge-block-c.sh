#!/usr/bin/env bash
# merge-block-c.sh — automatiza el merge de los 3 PRs del Bloque C al main local.
#
# Uso: ./scripts/merge-block-c.sh
#
# Asume:
# - main local sincronizado con origin.
# - 3 worktrees: ../Ts2cpp-modules, ../Ts2cpp-filesystem, ../Ts2cpp-networking.
# - Cada uno con su rama agent/issue-7-<bucket> y al menos 1 commit listo.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO=$(pwd)

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

step() { echo -e "${GREEN}==>${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC}  $1"; }
fail() { echo -e "${RED}✗${NC}  $1"; exit 1; }

# 1. Verificar que estamos en main limpio
step "Verificando estado de main..."
git checkout main >/dev/null 2>&1
git pull --ff-only >/dev/null 2>&1 || warn "Pull no fue fast-forward. Continuando con local."

# 2. Merge de modules (menor riesgo, solo tests)
step "Merging agent/issue-7-modules..."
git merge --no-ff agent/issue-7-modules -m "merge: bucket modules (Issue #11)" || fail "Merge de modules falló"
npm test >/tmp/merge-modules.log 2>&1 && step "Tests verdes tras modules" || { fail "Tests rojos tras modules. Ver /tmp/merge-modules.log"; }

# 3. Merge de filesystem (modifica runtime/ + type-checker)
step "Merging agent/issue-7-filesystem..."
git merge --no-ff agent/issue-7-filesystem -m "merge: bucket filesystem (Issue #13)" || fail "Merge de filesystem falló"
npm test >/tmp/merge-fs.log 2>&1 && step "Tests verde tras filesystem" || { fail "Tests rojos tras filesystem. Ver /tmp/merge-fs.log"; }

# 4. Merge de networking (modifica runtime/ + type-checker)
step "Merging agent/issue-7-networking..."
git merge --no-ff agent/issue-7-networking -m "merge: bucket networking (Issue #14)" || fail "Merge de networking falló"
npm test >/tmp/merge-net.log 2>&1 && step "Tests verde tras networking" || { fail "Tests rojos tras networking. Ver /tmp/merge-net.log"; }

# 5. Resumen
step "Merge completo."
echo "Commits añadidos al main:"
git log --oneline main -10
echo ""
echo "Issues a cerrar: #11, #13, #14"
echo "Próximo: V0 (cimiento semántico). Crear rama feature/v0-1-resolved-type."
