# Cross-machine runbook (F7)

One command on Laptop A brings the whole stack up; one command tears it down. The
generator runs on Laptop B and reaches A over Tailscale. Redis never leaves the
compose network.

```
Laptop A (proxy side)                         Laptop B (generator side)
┌──────────────────────────────┐              ┌────────────────────────┐
│ Docker Compose:              │              │ stress-test generator  │
│  proxy / stub / dashboard /  │  <-- health  │                        │
│  Redis / collector           │      checks  │ posts aggregates       │
└──────────────┬───────────────┘              └───────────┬────────────┘
               │                                          │
               │   Tailscale private tunnel (no LAN port-forward,
               │   no Redis exposure)                      │
               └──────────── aggregates ───────────────────┘

tc netem shapes A's physical NIC and is removed on teardown, including on failure.
```

## Prerequisites

On both laptops:

- `pnpm install && pnpm build` — the generator runs from `stress-test/dist/index.js`.
- Tailscale installed and **running**. `tailscale status --self` must not say
  "Tailscale is stopped". The harness detects the IPv4 address with
  `tailscale ip -4`; `--tailscale-ip <ip>` overrides detection.
- `tshark` for the NIC sanity check (`wireshark-cli`).

On Laptop A only:

- `.env` copied from `.env.example`, with `CAPTURE_IFACE` set to the physical NIC.
- Docker access. If `docker info` fails without root, run the harness with
  `SUDO=1`. It will tell you which step needed it.
- Root/`CAP_NET_ADMIN` for netem unless you pass `--netem off`.

## Bring up

```bash
SUDO=1 ./up.sh --remote          # full run: Tailscale bindings + netem wan
SUDO=1 ./up.sh --lan             # LAN bindings, no Tailscale needed
./up.sh --netem off              # local smoke without root
```

You do not supply an IP for either mode. `--remote` detects the tailnet IP with
`tailscale ip -4` and exits with a clear message if Tailscale is stopped;
`--lan` detects the LAN IPv4 with `hostname -I`. The IP flags below are overrides
only, for machines where auto-detection picks the wrong interface.

`./up.sh` is the same command via `pnpm stack:up`. Flags:

`--remote` uses Compose's `!override` tag to replace the base loopback port list,
so the same container port is never published twice on the same host port.
It requires Compose v2.24+; `docker compose version` on this machine is 5.6.1.

The override also sets `displayUrl` on the dashboard and proxy service entries:
health probes still use internal Compose addresses (`127.0.0.1` inside the
dashboard container, `proxy:8080` for the proxy), while the UI shows the
Tailscale URL you should actually open.

| Flag | Meaning |
| ---- | ------- |
| `--remote` | Publish proxy and dashboard on the detected Tailscale IP instead of loopback |
| `--lan` | Publish proxy and dashboard on all interfaces (`0.0.0.0`) for a LAN run |
| `--lan-ip <ip>` | Override the LAN IP printed in the summary and dashboard UI |
| `--tailscale-ip <ip>` | Override `tailscale ip -4` detection |
| `--netem <wan\|mild\|fast\|lossy\|off>` | Profile for `tools/netem-up.sh`; `off` skips it |
| `--iface <name>` | Physical NIC for capture and netem (default `CAPTURE_IFACE`) |
| `--no-capture-check` | Skip the NIC traffic sanity check |

The harness checks, in order:

1. `.env` exists, Docker daemon answers, compose config parses, and the ports
   published in the selected mode are free (loopback in local mode; Tailscale
   IP for proxy/dashboard and loopback for stub in `--remote` mode).
2. `tools/capture-check.sh` — if it sees zero packets that is a **warning**, not
   a failure: there is no generator traffic until you start Laptop B. A 5 s
   timeout is reported as "no traffic yet".
3. `docker compose up -d --wait --scale stub=3` — three stub replicas by
   default, publishing host ports 3001-3003 and round-robinned by the proxy.
   Build manually before running the harness; `./up.sh` deliberately does not
   rebuild images.
4. Host-side HTTP checks: `GET /health` on the proxy and `GET /api/time` on the
   collector, then `GET /api/services` for every configured service.
5. Collector contract check: `/api/time` must return JSON with a numeric `now`,
   and `POST /api/aggregates` must answer `{"ok":true}`. A stale image answers
   with an HTML 404 here and the harness fails with that diagnosis.
6. netem applied, followed by `tc qdisc show dev <iface>` asserting a netem qdisc.
7. Prints the dashboard URL and the exact generator command for Laptop B.

Every step prints `STEP <name>: <command>` and either `OK <name>` or
`FAILED <name>: <exit code and last output lines>`. Nothing hides which check
failed or how it was checked. If anything after `compose up` starts fails, the
harness tears down the partial stack automatically and reports that rollback too.

### Why capture-check runs before the stack

`tools/capture-check.sh` passively listens on the host NIC for 5 s with
`tshark`. It is a diagnostic, not a gate: it distinguishes "this interface sees
no packets" from "the parser is broken". Zero packets is printed as a warning
because the generator on Laptop B has not started yet. It does not touch the
proxy or the network.

The proxy itself no longer worries about the host interface. Compose clears
`CAPTURE_IFACE` inside the container, so capture starts disabled with one
informational line instead of a `wlp0s20f3: No such device` error. The dashboard
logs the address it actually bound (`http://0.0.0.0:3000`) rather than a
hardcoded `127.0.0.1`, and its service cards show the public Tailscale/LAN URL.

### Two facts about the qdisc

- **netem is egress-only** (established in PR #31). The `wan` profile delays
  packets leaving A by ~20 ms once per packet, so a request/response RTT lands
  around 8–33 ms (~21 ms mean), **not** 40–50 ms. Do not "fix" a 21 ms RTT by
  doubling the delay.
- **Every interface already has a default qdisc** — `mq` on a physical NIC,
  `noqueue` on loopback. `tools/netem-down.sh` removes only a qdisc that
  actually says `netem`. The harness therefore asserts "no netem remains", not
  "no qdisc exists". A `mq` line after teardown is correct.

## Run the generator on Laptop B

The harness prints these with the detected Tailscale IP substituted:

```bash
curl http://<TAILSCALE_IP>:8080/health
node stress-test/dist/index.js \
  --target http://<TAILSCALE_IP>:8080 \
  --collector http://<TAILSCALE_IP>:3000 \
  --duration 30000 --concurrency 64 --ramp 5000 --label cross-machine
```

`--collector` reaches the dashboard's `/api/time` and `/api/aggregates` routes.
A is never asked to reach B's Redis. Verify the network path from B:

```bash
ss -tnp | grep <generator-pid> | grep 6379    # must be empty
```

If `/health` fails from B, check in order: Tailscale running on both hosts
(`tailscale status`), the proxy binding (`ss -tlnp | grep 8080` must show the
Tailscale IP, never `0.0.0.0`), then ufw FORWARD policy. Do not fall back to a
LAN port-forward.

## LAN mode (no Tailscale)

If you do not want to use Tailscale, run:

```bash
SUDO=1 ./up.sh --lan
```

This applies `compose.lan-harness.yml`, which replaces the loopback bindings
with `0.0.0.0:8080` on the proxy and `0.0.0.0:3000` on the dashboard. Redis
stays on the compose network. The harness detects your LAN IPv4 with
`hostname -I` and prints the Laptop B commands with that address; `--lan-ip`
overrides detection.

This is a wider exposure than Tailscale. On university WiFi, client isolation
often blocks TCP between laptops even when ICMP works; Tailscale is the safer
default. If you use LAN mode, run it only on a network you trust and remove the
binding with `SUDO=1 ./down.sh` afterwards.

## What this run will and will not show

`POST /api/aggregates` is currently a **sink**: it logs
`collector: phase=... label=...` in the dashboard container and returns
`{"ok":true}`. It does not publish to Redis or render an aggregates panel yet,
so "no output on the dashboard regarding aggregates" is expected. To see the
reports were accepted:

```bash
SUDO=1 docker compose logs dashboard | grep collector
```

Connections, TCP state, retransmits and RTT are derived from captured packets,
not from the generator's HTTP latency. Two constraints apply to the Tailscale
run:

- The proxy container has no physical NIC and no `CAP_NET_RAW`, so its live
  pcap capture never opens.
- Tailscale traffic arrives as raw IP and the parser is Ethernet-oriented, so
  even with host capture those packets are skipped.

That is why Frames can be active while the other views stay empty — exactly the
behaviour documented in the README's cross-machine notes. To populate those
views, capture on the host from LAN traffic and replay offline:

```bash
tshark -i "$CAPTURE_IFACE" -f 'tcp port 8080' -F pcap -w /tmp/lan.pcap -a duration:45
tools/state-replay.sh /tmp/lan.pcap
tools/rtt-replay.sh /tmp/lan.pcap
tools/retransmit-replay.sh /tmp/lan.pcap
tools/handshake-replay.sh /tmp/lan.pcap
```

## Tear down

```bash
SUDO=1 ./down.sh
```

`./down.sh` is the same command via `pnpm stack:down`. It removes netem **first**,
then runs `docker compose down -v --remove-orphans`. If either step fails it
still runs the other and reports both failures. Confirm with:

```bash
tc qdisc show dev "$CAPTURE_IFACE"     # default qdisc only, no netem
docker ps --filter label=com.docker.compose.project=lambda
```

## Acceptance checklist

- [x] One command brings up the full stack from a clean machine — `./up.sh`
- [x] One command tears it down with no orphans and no netem left — `./down.sh`
- [x] `capture-check.sh` reports "traffic present" and "no traffic"
      (`pnpm test:harness` exercises both with a fake `tshark`)
- [ ] Full cross-machine run: generator on B, proxy/stub/dashboard on A
- [ ] Runbook followed by someone who did not write it
- [x] Readiness uses healthchecks, not fixed sleeps
- [x] A never reaches B's Redis — B only posts HTTP aggregates
- [x] Failure prints which component failed and how it was checked

The two unchecked items need the physical two-laptop rig; a local run does not
substitute for them.

## Troubleshooting

- **`address already in use`**: a previous run left containers or another
  process on 3000/3001/8080. The port preflight now names the owner before
  starting anything. Run `SUDO=1 ./down.sh`, then retry.
- **`docker info` denied**: run with `SUDO=1`, or add your user to the `docker`
  group. The harness stops before changing anything.
- **"Tailscale is stopped"**: start the service, or pass `--tailscale-ip`.
- **Empty capture**: loopback traffic never reaches the physical NIC. Generate
  from B; a local `curl` on A produces an empty capture that looks like a parser
  bug.
- **Generator reports 100% transport errors on B**: it defaults to
  `http://127.0.0.1:3001`. Always pass `--target` explicitly.
- **Latency looks like 40 ms**: check `tc qdisc show`; if two netem instances are
  applied (one per host), remove the one on B. Only A should be shaped.
