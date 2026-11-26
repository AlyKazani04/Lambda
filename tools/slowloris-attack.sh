#!/usr/bin/env bash
# A4 attack client. Usage: tools/slowloris-attack.sh [--mode headers|body|idle|trickle] [flags]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec "${SCRIPT_DIR}/../apps/proxy/node_modules/.bin/tsx" "${SCRIPT_DIR}/slowloris-attack.ts" "$@"
