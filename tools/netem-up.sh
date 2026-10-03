#!/usr/bin/env bash
#
# Apply Linux traffic-control emulation to a network interface.
#
# WHAT THIS DOES
#   Loopback has no congestion control, no meaningful round-trip time, and
#   effectively never retransmits. Measuring on loopback produces flat,
#   unconvincing numbers. `netem` (part of Linux's `tc`, traffic control)
#   imposes delay / loss / reordering on packets leaving an interface, so we
#   can reproduce WAN-like conditions *reproducibly* — we choose the numbers,
#   which means we know the ground truth we injected.
#
#   This is a SIMULATION. Anything measured under it must be labelled as
#   emulated in the report. See issue #14 (N1).
#
# ROOT REQUIRED
#   tc needs CAP_NET_ADMIN. Either run this under `sudo`, or run it inside the
#   proxy container, which compose grants NET_ADMIN to. On this machine
#   (Omarchy) the user is deliberately not in the `docker` group, so the
#   container route avoids `sudo` entirely.
#
# USAGE
#   tools/netem-up.sh                      # defaults: wlp0s20f3 + wan profile
#   tools/netem-up.sh <iface> <profile>   # e.g. wlp0s20f3 wan
#   tools/netem-up.sh lo fast             # 2ms, no loss
#
# PROFILES (see profile_delay/profile_jitter/... below)
#   wan    20ms ± 5ms, 0.5% loss, correlated  -> realistic, our headline
#   mild    5ms ± 1ms, 0.1% loss              -> gentler smoke test
#   fast    2ms ± 0ms, no loss                -> sanity check that tc works at all
#   lossy  50ms ±10ms, 5.0% loss              -> stress reassembly (issue #26)
#
# TEARDOWN
#   Always run netem-down.sh when finished. The qdisc affects the WHOLE
#   interface, so a leftover qdisc silently inflates every later measurement.
#   netem-up.sh is safe to run twice (see "replace" note below).

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

# Interface to emulate. Read from .env so the same script works on either
# laptop. `lo` is NEVER correct: a container's loopback is namespace-isolated
# and carries no host traffic.
DEFAULT_IFACE="${CAPTURE_IFACE:-wlp0s20f3}"

# Default profile used when the caller names none.
DEFAULT_PROFILE="wan"

# ---------------------------------------------------------------------------
# Profile table
# ---------------------------------------------------------------------------
# Bash associative array: name -> "delay jitter distribution loss correlate"
#
# WHY NAMED PROFILES
#   Different experiments need different ground truth. Reassembly (#26) needs
#   burst loss to be interesting at all; a smoke test needs almost none. Hard-
#   coding one setting means every run reports numbers for conditions nobody
#   asked for. Record which profile produced which figure in the report.
#
# WHY "distribution normal" MATTERS
#   Without it, the jitter is UNIFORM — every delay equally likely. Real delay
#   variation is bell-shaped. Uniform jitter is easy for a sloppy RTT estimator
#   to average out correctly, so uniform jitter lets a buggy implementation
#   pass by luck. Pair delay + jitter + distribution, always.
#
# WHY "correlate" MATTERS
#   correlate 25% makes losses arrive in BURSTS, which is what real links do.
#   Independent random loss produces single missing segments that a simple
#   reorder buffer handles easily. Correlated loss removes a contiguous RANGE
#   of sequence numbers at once — that is the case sequence-space reassembly
#   is actually about. Skipping it makes #26 look far easier than it is.
declare -A PROFILES=(
  #           delay jitter dist    loss    correlation
  # `wan` is the project's headline profile — the one whose numbers go in the
  # report, and the one B5's RTT estimator is validated against.
  [wan]="20ms 5ms normal 0.5% 25%"
  # `mild` is a gentler smoke test; enough variation that a smoothing bug shows.
  [mild]="5ms 1ms normal 0.1% 10%"
  # `fast` checks only that tc is wired up at all: near-zero delay, no loss.
  # NOTE the correlation column is a BARE NUMBER, not a percentage — the
  # man page grammar is `loss random PERCENT [ CORRELATION ]`, so `0%` here
  # would be a syntax error. It is a percentage *of the loss events*, not a
  # percentage of packets.
  [fast]="2ms 0ms normal 0% 0"
  # `lossy` stresses reassembly (issue #26): bursty loss over a long delay.
  [lossy]="50ms 10ms normal 5.0% 25%"
)

# ---------------------------------------------------------------------------
# Argument handling
# ---------------------------------------------------------------------------
# "${1:-default}" means "use $1 if set, otherwise use the literal default".
# Without the :- form, `set -u` aborts the script when an argument is absent.
IFACE="${1:-$DEFAULT_IFACE}"
PROFILE="${2:-$DEFAULT_PROFILE}"

# Validate the profile name BEFORE touching the kernel. An unknown key in a
# bash associative array silently yields an empty string rather than erroring,
# which would otherwise pass an empty delay straight to tc.
if [[ -z "${PROFILES[$PROFILE]:-}" ]]; then
  echo "error: unknown profile '$PROFILE'" >&2
  echo "available: ${!PROFILES[*]}" >&2
  exit 1
fi

read -r DELAY JITTER DIST LOSS CORR <<<"${PROFILES[$PROFILE]}"

# Reject `lo` BEFORE the root check, and before touching the kernel. The whole
# point is to emulate the LONG leg of the path; loopback has no meaningful delay
# to add, and inside a container it is namespace-isolated so it carries no
# traffic at all. Doing this first also means a bad argument is reported as a
# bad argument, rather than being masked by a "needs sudo" message.
if [[ "$IFACE" == "lo" ]]; then
  echo "error: refusing to emulate loopback — use the physical NIC (see .env CAPTURE_IFACE)" >&2
  exit 1
fi

# The interface must actually exist. Checked via sysfs rather than `ip link`,
# so the script has no dependency on iproute2 being installed — it needs `tc`
# (also from iproute2) to do its job, but it should not fail with a confusing
# "ip: command not found" before it has even validated its arguments.
#
#   -d on the directory tests existence. /sys/class/net/<iface> is a symlink
#   the kernel creates for every network interface.
if [[ ! -d "/sys/class/net/$IFACE" ]]; then
  echo "error: interface '$IFACE' not found on this host. Available:" >&2
  for iface in /sys/class/net/*; do
    printf '  %s\n' "$(basename "$iface")" >&2
  done
  exit 1
fi

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

# tc needs root. Checked last, so argument problems surface first — being told
# "use sudo" for a script invoked with a bad argument is actively misleading.
# The failure here is a clear sentence rather than a raw RTNETLINK error that
# looks like a networking bug.
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  cat >&2 <<EOF
error: netem requires root (CAP_NET_ADMIN).

  sudo $0 $IFACE $PROFILE

or run inside the proxy container, which compose already grants NET_ADMIN:
  docker compose exec proxy $0 $IFACE $PROFILE
EOF
  exit 1
fi

# Remove any existing root qdisc first. `tc qdisc add` FAILS with "File exists"
# if one is already installed, which is confusing when the real problem is just
# a leftover from a previous run. `replace` would also work, but deleting first
# makes the intent explicit and matches netem-down.sh.
tc qdisc del dev "$IFACE" root >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------
# tc qdisc add dev IFACE root netem <conditions>
#
#   qdisc  = queueing discipline: the rule the kernel uses to decide the order
#            packets leave an interface. `root` = replace the discipline at the
#            top of the queue. Only ONE root qdisc can exist per interface.
#   netem  = the network emulator we attach as that discipline.
#
# Conditions, in the order tc's grammar expects them. This is NOT free-form —
# tc parses positionally, and a misplaced token makes it print usage and change
# nothing (see the "silent failure" note below).
#
#   delay DELAY JITTER distribution NAME  — delay each packet by DELAY, plus a
#                                         random extra amount in [0, JITTER)
#                                         drawn from the named distribution
#   loss random LOSS [CORRELATION]        — drop LOSS% of packets; CORRELATION
#                                         (if given) groups them into bursts
#
# `correlate` IS NOT A KEYWORD. From `man netem`, the grammar is literally
#   loss random PERCENT [ CORRELATION ]
# so the correlation value is a BARE POSITIONAL argument after the percentage.
# Writing `loss 0.5% correlate 25%` makes tc print its usage and apply nothing.
#
# WHY CORRELATION MATTERS (this is the whole point of it)
#   With INDEPENDENT random loss, single segments go missing and a reorder
#   buffer copes easily. With CORRELATED loss, a burst is lost and a large
#   CONTIGUOUS range of sequence numbers must be recovered in one piece —
#   gaps, not holes. That is the case sequence-space reassembly (issue #26) is
#   actually about. Skip it and #26 looks far easier than it is, and the demo
#   is unconvincing.
#
# WHY `random` IS EXPLICIT
#   `loss` alone defaults to the random model, but stating it documents intent
#   and matches the man page. The alternative models (state, gemodel) exist
#   for reproducing specific real-world loss traces.
#
# SILENT-FAILURE WARNING
#   `tc qdisc add` with a bad token prints usage to stderr and exits non-zero
#   WITHOUT touching the kernel. The interface is left exactly as it was. So a
#   typo here looks like "netem applied" unless you read the exit code — which
#   is why `set -e` at the top of this script matters, and why you should check
#   `tc qdisc show` afterwards rather than trusting the absence of an error.
echo "applying netem on $IFACE (profile=$PROFILE)"
echo "  delay ${DELAY} ± ${JITTER} (${DIST})"
echo "  loss  ${LOSS}, burst correlation ${CORR}"

tc qdisc add dev "$IFACE" root netem \
  delay "$DELAY" "$JITTER" distribution "$DIST" \
  loss random "$LOSS" "$CORR"

echo
echo "applied. current state:"
tc qdisc show dev "$IFACE"
echo
echo "REMEMBER: run tools/netem-down.sh when finished."
echo "This affects the whole interface, not just our traffic."
