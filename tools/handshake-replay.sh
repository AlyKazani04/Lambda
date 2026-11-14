#!/usr/bin/env bash
#
# Replay a pcap through the B3 handshake analyser.
#
# Usage:
#   tools/handshake-replay.sh [file.pcap]
#
# Defaults to apps/proxy/capture.pcap (the proxy's PCAP_EXPORT_PATH). Prints one
# line per completed handshake plus an aggregate. See tools/handshake-replay.ts
# for why this needs no capture privileges.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PCAP="${1:-${SCRIPT_DIR}/../apps/proxy/capture.pcap}"

if [[ ! -f "$PCAP" ]]; then
  echo "error: pcap not found: $PCAP" >&2
  exit 1
fi

exec "${SCRIPT_DIR}/../apps/proxy/node_modules/.bin/tsx" "${SCRIPT_DIR}/handshake-replay.ts" "$PCAP"
