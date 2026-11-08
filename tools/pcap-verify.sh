#!/usr/bin/env bash
set -euo pipefail

PCAP="${1:-}"
if [[ -z "$PCAP" || ! -f "$PCAP" ]]; then
  echo "usage: $0 <file.pcap>" >&2
  exit 1
fi

command -v tshark >/dev/null || { echo "error: tshark is required" >&2; exit 1; }
command -v capinfos >/dev/null || { echo "error: capinfos is required" >&2; exit 1; }

fail=0
check() {
  if [[ "$2" -eq 0 ]]; then
    echo "PASS  $1"
  else
    echo "FAIL  $1"
    fail=1
  fi
}

count=$(capinfos -c -M "$PCAP" | awk -F': +' '/Number of packets:/{print $2}')
[[ "$count" =~ ^[0-9]+$ ]] || { echo "FAIL  packet count" >&2; exit 1; }
check "packet count > 0 ($count)" $([[ "$count" -gt 0 ]]; echo $?)

malformed=$(tshark -r "$PCAP" -V 2>/dev/null | grep -ci "malformed" || true)
check "no malformed packets ($malformed)" "$malformed"

encap=$(capinfos -E -M "$PCAP" | awk -F': +' '/File encapsulation:/{print $2}')
echo "INFO  encapsulation: $encap"

chrono=$(capinfos -o -M "$PCAP" 2>/dev/null | awk -F': +' '/Strict time order:/{print $2}')
check "timestamps chronological ($chrono)" $([[ "$chrono" == "True" ]]; echo $?)

snaplen=$(capinfos -l -M "$PCAP" | sed -n 's/.*file hdr: \([0-9]*\).*/\1/p')
oversize=$(tshark -r "$PCAP" -T fields -e frame.cap_len 2>/dev/null | awk -v s="$snaplen" '$1 > s {n++} END {print n+0}')
check "captured lengths within snaplen ($snaplen)" "$oversize"

shorted=$(tshark -r "$PCAP" -T fields -e frame.len -e frame.cap_len 2>/dev/null | awk '$2 > $1 {n++} END {print n+0}')
check "captured length <= original length" "$shorted"

echo "INFO  first 10 packets:"
tshark -r "$PCAP" -T fields -e frame.number -e frame.time_epoch -e frame.len -e frame.cap_len -e tcp.flags 2>/dev/null | head -10 | sed 's/^/      /'

exit "$fail"
