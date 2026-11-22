#!/usr/bin/env bash
# Replay a pcap through the B6 TCP state machine. Usage: tools/state-replay.sh [file.pcap]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PCAP="${1:-${SCRIPT_DIR}/../apps/proxy/capture.pcap}"

if [[ ! -f "$PCAP" ]]; then
  echo "error: pcap not found: $PCAP" >&2
  exit 1
fi

exec "${SCRIPT_DIR}/../apps/proxy/node_modules/.bin/tsx" "${SCRIPT_DIR}/state-replay.ts" "$PCAP"
