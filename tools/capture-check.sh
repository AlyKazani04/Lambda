#!/usr/bin/env bash
# Quick check: is there any traffic on the given interface?
# Usage: tools/capture-check.sh [iface] [seconds]
set -euo pipefail

IFACE="${1:-${CAPTURE_IFACE:-wlp0s20f3}}"
DURATION="${2:-5}"

if ! command -v tshark >/dev/null 2>&1; then
  echo "tshark not found; install wireshark-cli" >&2
  exit 2
fi

COUNT=$(timeout "$DURATION" tshark -i "$IFACE" -a "duration:$DURATION" 2>/dev/null | wc -l)

echo "interface=$IFACE packets=$COUNT duration=${DURATION}s"
if [ "$COUNT" -eq 0 ]; then
  echo "NO TRAFFIC on $IFACE"
  exit 1
fi
EOF