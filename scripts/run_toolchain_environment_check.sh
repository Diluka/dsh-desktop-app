#!/usr/bin/env bash
set -euo pipefail

deno_bin="$(command -v deno)"
env -i \
  HOME="${HOME}" \
  SHELL="${SHELL:?SHELL is required}" \
  PATH="/usr/bin:/bin" \
  DENO_NO_UPDATE_CHECK="1" \
  EXPECTED_NODE_PATH_FRAGMENT="${EXPECTED_NODE_PATH_FRAGMENT:?expected path fragment is required}" \
  EXPECTED_LAUNCHER="${EXPECTED_LAUNCHER:-npx}" \
  "${deno_bin}" run --permission-set=app scripts/verify_toolchain_environment.ts
