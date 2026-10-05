#!/usr/bin/env bash
#
# Remove traffic-control emulation from a network interface.
#
# WHY THIS SCRIPT EXISTS
#   A netem qdisc affects the WHOLE interface, not just our traffic. A leftover
#   qdisc from an interrupted run silently inflates every later measurement —
#   the next person sees 40ms latencies and spends an hour wondering why. This
#   script is the guaranteed teardown, and it is IDEMPOTENT: running it twice,
#   or when nothing is applied, succeeds quietly instead of failing a CI step.
#
# USAGE
#   tools/netem-down.sh                    # interface from CAPTURE_IFACE
#   tools/netem-down.sh wlp0s20f3          # explicit interface
#
# ROOT REQUIRED
#   Same as netem-up.sh: tc needs CAP_NET_ADMIN. Run under sudo, or inside the
#   proxy container which compose grants NET_ADMIN to.

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
# "${1:-...}" = use $1 if the caller supplied one, else the fallback. Without
# the :- form, `set -u` aborts the script when the argument is missing.
IFACE="${1:-${CAPTURE_IFACE:-wlp0s20f3}}"

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

if [[ "$IFACE" == "lo" ]]; then
  echo "interface 'lo' never has a netem qdisc — nothing to do"
  exit 0
fi

# A missing interface is reported, but treated as success. If the interface is
# gone, whatever qdisc it carried went with it — the postcondition ("no netem
# on this interface") already holds. Checked via sysfs so the script does not
# depend on iproute2 being installed.
if [[ ! -d "/sys/class/net/$IFACE" ]]; then
  echo "interface '$IFACE' not found — nothing to remove"
  exit 0
fi

# ---------------------------------------------------------------------------
# Was anything applied?
# ---------------------------------------------------------------------------

# tc needs root. Checked after argument validation, so a bad interface is
# reported as a bad interface rather than masked by a "needs sudo" message.
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  cat >&2 <<EOF
error: removing a qdisc requires root (CAP_NET_ADMIN).

  sudo $0 $IFACE

or run inside the proxy container, which compose already grants NET_ADMIN:
  docker compose exec proxy $0 $IFACE
EOF
  exit 1
fi

# `tc qdisc show` is safe unprivileged and reports the current discipline. We
# check BEFORE deleting so the common case (nothing applied) exits quietly.
#
# WHY GREP FOR netem SPECIFICALLY
#   Every interface has a default qdisc — `noqueue` on loopback, `mq` on
#   physical NICs. Deleting those is not what we want. We only remove a qdisc
#   that is actually ours.
if ! tc qdisc show dev "$IFACE" 2>/dev/null | grep -q netem; then
  echo "no netem qdisc on $IFACE — nothing to do"
  exit 0
fi

# ---------------------------------------------------------------------------
# Remove
# ---------------------------------------------------------------------------
# tc qdisc del dev IFACE root
#
# `root` names the top of the queue. Only the root qdisc can be deleted this
# way; deleting always fails if no root qdisc exists, which is why we checked
# above.
echo "removing netem from $IFACE"
tc qdisc del dev "$IFACE" root

echo "removed. current state:"
tc qdisc show dev "$IFACE"
