#!/usr/bin/env bash
set -euo pipefail

manager="${1:?manager name is required}"
profile="${HOME}/.bash_profile"

case "${manager}" in
  mise)
    manager_bin="$(command -v mise)"
    printf '\neval "$("%s" activate bash --shims)"\n' "${manager_bin}" >> "${profile}"
    expected_fragment="mise"
    ;;
  nvm)
    cat >> "${profile}" <<'EOF'

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use default >/dev/null
EOF
    expected_fragment=".nvm"
    ;;
  *)
    echo "Unsupported manager: ${manager}" >&2
    exit 1
    ;;
esac

{
  echo "SHELL=/bin/bash"
  echo "EXPECTED_NODE_PATH_FRAGMENT=${expected_fragment}"
} >> "${GITHUB_ENV:?GITHUB_ENV is required}"
