# Lambda (λ)

A Custom Reverse Proxy with Real-Time Packet Capture and Traffic Analysis.

## Notes

1. **Package Manager**: `pnpm`
2. **Node Version**: Using `v26.7.0` locally (see `.nvmrc`)
3. **Ports**: Proxy `:8080`, Stub `:3001`, Dashboard `:3000`, Redis `:6379`

## Getting started

```bash
pnpm install
cp .env.example .env
```

### Docker access

```bash
sudo docker compose up -d      # not: pnpm infra:up
```

`pnpm infra:up` currently runs `docker compose` without `sudo` and will fail
with `permission denied ... /var/run/docker.sock`. Prefix with `sudo` for now,
or update the script once decided which way to go.

### Watch mode

```bash
sudo docker compose -f docker-compose.yml -f compose.dev.yml up --build
```

Only `apps/proxy/src` and `apps/stub/src` are bind-mounted, and `tsx watch`
restarts those two services on a source edit. The dashboard stays on its
production build: `server.ts` owns the `/ws` upgrade, so `next dev` cannot run
behind it. If file events do not cross the Docker Desktop mount on macOS,
restart the affected container manually — verify watch behaviour before relying
on it.

The overlay tags its images `lambda/proxy:local-dev` and `lambda/stub:local-dev`
rather than reusing the production `:dev` tags. That keeps the production images
untouched, so a plain `sudo docker compose up -d` afterwards starts the
production build without needing `--build` or a cache clear.

Dockerfile installs are keyed on manifests only and use BuildKit cache mounts,
so a source edit no longer triggers a `pnpm install` in either stage.

## Environment

`.env` holds machine-specific config. Two values matter most:

| Variable          | Notes                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPTURE_IFACE`   | **Must be the physical NIC, never `lo`.** A container's loopback is namespace-isolated and sees no host traffic — capture goes silent in a way that looks identical to a broken parser |
| `PROXY_PORT` etc. | Change only if a port is genuinely taken                                                                                                                                               |

Redis is reached over the compose network and is **not** published to the host
or LAN. It has no authentication and no TLS, so keep it that way.

## Storage

There is no database in v1. Recent history lives in a capped Redis list —
`LPUSH frames <json>` followed by `LTRIM frames 0 <HISTORY_LIMIT>` — which
cannot grow without bound. Postgres was cut deliberately; see issue #5.

## Repository layout

```text
apps/
  proxy/       L7 reverse proxy  (src/l7 = Track A, src/l4 = Track B)
  stub/        traffic-shaping upstream
  dashboard/   Next.js real-time dashboard
packages/
  config/      shared tsconfig
stress-test/   load generator (runs on the second laptop)
tools/         capture-check, netem, parser validation
```

## Proxy core (F2 / A1)

`apps/proxy` accepts a request, resolves its path prefix to an upstream group,
picks the next instance in that group's rotation, and pipes the request and
response through. The pieces:

| File           | Responsibility                                              |
| -------------- | ----------------------------------------------------------- |
| `config.ts`    | routing table, upstream targets and counts from environment |
| `router.ts`    | longest-prefix match on segment boundaries; 404 on no match |
| `upstream.ts`  | round-robin pools, per group, with DNS instance discovery   |
| `forwarder.ts` | header filtering, piping, client-abort propagation          |
| `index.ts`     | server, `/health`, per-request upstream log                 |

Default routing table: `/api/*` and `/timeline/*` both go to the stub service.
`GET /health` is answered by the proxy itself and never forwarded.

### Configuration

| Variable                         | Default     | Notes                                                       |
| -------------------------------- | ----------- | ----------------------------------------------------------- |
| `PROXY_PORT`                     | `8080`      | Bind port                                                   |
| `PROXY_HOST`                     | `0.0.0.0`   | Loopback binds are unreachable from Laptop B                |
| `ROUTES`                         | see above   | JSON array of `{ prefix, group }`                           |
| `UPSTREAM_HOST`                  | `127.0.0.1` | Service name or address; resolved to the instance list      |
| `UPSTREAM_PORT`                  | `3001`      |                                                             |
| `UPSTREAM_INSTANCES`             | `3`         | Cap on resolved instances; must be >= replica count         |
| `UPSTREAM_DISCOVERY_INTERVAL_MS` | `5000`      | Re-resolve interval; `0` disables                           |
| `UPSTREAM_TARGETS`               | unset       | `host:port,...` (a bare port means loopback). Pins the list |
| `UPSTREAM_TARGETS_<GROUP>`       | unset       | Per-group override, e.g. `UPSTREAM_TARGETS_TIMELINE`        |

### Load balancing across N instances

The instance list comes from resolving `UPSTREAM_HOST`, so scaling the stub
service scales the rotation — no code change and no list to maintain:

```bash
# The base compose file publishes the stub on a fixed host port for the CI
# smoke test, and N replicas cannot share one host port, so drop that mapping
# for a scaled run (compose.override.yml is the place to do it).
docker compose -f docker-compose.yml -f compose.override.yml up -d --scale stub=3
docker compose logs -f proxy | grep group=api     # one line per request
```

Every request logs `upstream=<host:port> group=<group> <method> <url>`. That one
line is the whole diagnosis when the rotation looks wrong, and it is the
evidence for "6 consecutive requests rotate across all three instances".

Two gotchas worth knowing before you debug a rotation that never advances:

- **`depends_on: service_healthy` waits for one replica of a service, not all
  N.** The proxy can therefore start, resolve the service name while only one
  replica has registered, and cache a one-address list. Re-resolution on
  `UPSTREAM_DISCOVERY_INTERVAL_MS` closes that race and logs each change
  (`upstream discovery: group=api instances [...] -> [...]`). If you see the
  rotation collapsed to one instance, check whether that line has fired.
- **`UPSTREAM_INSTANCES` is a cap, not a demand.** If it is lower than the
  replica count, the surplus replicas are simply never selected — nothing warns
  you, because from the proxy's side the list is exactly as configured.

## L4 handshake analysis (B3)

`apps/proxy/src/l4/` holds the transport-layer work:

| File               | Responsibility                                            |
| ------------------ | --------------------------------------------------------- |
| `capture.ts`       | B1 — `@audc/pcap` session on the physical NIC             |
| `packet-parser.ts` | B2 — Ethernet/IPv4/TCP decode, flags, seq/ack, options    |
| `handshake.ts`     | B3 — SYN → SYN-ACK → ACK deltas per 5-tuple               |
| `pcap-writer.ts`   | B9 — 24-byte global header + 16-byte per-packet header    |

`handshake.ts` keeps one record per connection, keyed by the direction-insensitive
endpoint pair so the SYN and the SYN-ACK land on the same record. It verifies the
ACK numbers (the SYN-ACK must acknowledge SYN+1; the final ACK must acknowledge
SYN-ACK+1), counts retransmitted SYNs without treating them as new connections,
and expires in-progress connections that never complete. Results leave through a
`HandshakePublisher` port:

- `publishConnection` — one event per completed handshake
- `publishAggregate` — completed/in-progress/stale counts, ACK-mismatch counters,
  and min/max/mean/p50/p95/p99 for the total and RTT-estimate timings

`rttEstimateMs` is `totalMs / 2`. It is an **estimate**, not a measurement: it
assumes a symmetric path, which real WiFi/LAN paths are not. B5's per-packet RTT
estimation does not rely on that assumption.

Until the Redis transport (F5) merges, `createConsoleHandshakePublisher` prints
one line per handshake and one aggregate line per second:

```text
handshake 127.0.0.1:37364>127.0.0.1:8080 syn→synack=0ms synack→ack=0ms total=0ms rtt≈0.0ms retrans=0
handshake-aggregate completed=2 inProgress=0 stale=0 rtt p50=0.0 p95=0.0 p99=0.0 max=0.0
```

### Verifying B3

```bash
pnpm test                  # unit tests over synthetic frames
tools/handshake-replay.sh  # replay a capture through the same decode + analyse path
```

The replay tool needs no capture privileges: it reads a `.pcap` and runs the
exact decode + analyse path, so a netem run can be evaluated offline and
reproducibly.

**In the Docker deployment the proxy cannot produce that pcap.** Its container
netns has only `eth0`/`lo` (so `CAPTURE_IFACE=wlp0s20f3` does not exist) and it
runs with `CapEff=0` (so libpcap has no `CAP_NET_RAW`). Capture on the host
physical NIC instead, then replay:

1. `tshark -i "$CAPTURE_IFACE" -f 'tcp port 8080' -F pcap -w /tmp/lan.pcap -a duration:45`
2. `sudo tools/netem-up.sh "$CAPTURE_IFACE" wan` — 20 ms ± 5 ms.
3. Drive traffic through the proxy from the second machine (see
   [Cross-machine rig](#cross-machine-rig-laptop-a--laptop-b)).
4. `tools/handshake-replay.sh /tmp/lan.pcap` — RTT p50 should be ~20 ms, not ~2 ms.
5. `sudo tools/netem-down.sh "$CAPTURE_IFACE"`.

The live dashboard view is deferred until the Redis transport (F5) merges; the
publisher port is the seam it plugs into.

## A4 — slowloris detection

`apps/proxy/src/l7/slowloris.ts` watches each client socket with one re-armable
timer. Any received byte resets it, so a client on a slow link is judged by
*progress*, not by total connection age. Four phases have separate thresholds:
`ttfb` (no first byte), `headers`, `body`, and `idle` (after the response on a
keep-alive connection). Timers are per request on a reused connection. Node's
own `headersTimeout`, `requestTimeout` and `keepAliveTimeout` remain as a
backstop one second above the longest threshold. The watchdog normally fires
first and records a reason; the backstop bounds a socket if its timer never
runs.

A tripped connection is destroyed, the reason is logged with phase, elapsed
idle time and bytes received, and a `slowloris` event is published through the
Redis bus. The dashboard's **Slowloris** view shows those events; `traceId` and
`path` are attached only when the request reached route matching.

`bytesReceived` is per phase, not per connection: `enterPhase` resets the
counter, so a client that sends a header and then stalls reports a small byte
count even though it has already sent data.

Thresholds are environment settings, not constants: `SLOWLORIS_ENABLED`,
`SLOWLORIS_TTFB_MS`, `SLOWLORIS_HEADERS_MS`, `SLOWLORIS_BODY_MS` and
`SLOWLORIS_IDLE_MS` (defaults 10 s / 15 s / 30 s / 60 s). Shorten them for a
local demo; keep them well above the netem path latency for real runs.

`SLOWLORIS_ENABLED=false` switches off progress detection and its reason
logging, leaving only the coarse Node-level backstop. The safe operating point
is `SLOWLORIS_ENABLED=true` with the defaults above.

### Verifying A4

```bash
pnpm test                                   # watchdog phases, resets, cleanup

# Against a proxy started with 1500 ms thresholds:
tools/slowloris-attack.sh --mode headers --interval 2500 --duration 4000
tools/slowloris-attack.sh --mode body --duration 4000
tools/slowloris-attack.sh --mode idle --duration 4000
# The control must NOT be killed:
tools/slowloris-attack.sh --mode trickle --interval 200 --duration 4000
```

Each attack mode exits zero when at least one connection was closed; the
`trickle` control exits zero only when none were. The `body` mode needs an
upstream that waits for the full request body before responding — the stock
stub answers immediately, which moves the connection into the idle phase
instead. Point `UPSTREAM_TARGETS_API` at such an upstream when demoing that
variant; the unit test covers the body timer without one.

The full load generator must
then run with detection enabled and produce zero false positives:

```bash
node stress-test/dist/index.js --target http://127.0.0.1:8080 \
  --duration 30000 --concurrency 64 --ramp 5000
```

The netem variant of that check (20 ms ± 5 ms on the physical NIC, traffic
from the second laptop) still needs the two-laptop rig; a local run does not
substitute for it. Do not run the load test with the shortened demo thresholds:
a 1.5 s idle limit is below the natural gap between keep-alive requests under
concurrency and will trip the detector. Use the defaults for that check.

## B9 — exporting a capture

The proxy records every captured packet (B1) into `PCAP_EXPORT_PATH`
(`capture.pcap` by default) as a standard libpcap file. The dashboard's
**Export .pcap** button downloads a snapshot of that file; capture continues
into a fresh file immediately afterwards.

```text
dashboard /export  ->  GET /api/export  ->  proxy GET /api/export.pcap  ->  .pcap bytes
```

`PROXY_EXPORT_URL` tells the dashboard where the proxy is. It defaults to
`http://127.0.0.1:8080` for host runs and is set to `http://proxy:8080` in
compose. Capture must be enabled and at least one packet must have arrived,
or the proxy endpoint returns `503 capture_not_ready`. The dashboard maps that
to a `502` with the same detail so the UI can show the reason.

The link-layer type comes from the capture session, never a hardcoded `1`.
The writer maps `@audc/pcap`'s `LinkType` to the pcap value: Ethernet 1, raw IP
101, Linux SLL 113, NULL 0, radiotap 127. A WiFi NIC reports radiotap —
writing 1 there makes Wireshark dissect every frame as Ethernet, which is
exactly the failure this issue exists to prevent.

The writer also stores the capture's own microsecond timestamps and clamps
`incl_len` to `snaplen` while preserving `orig_len`. That is what makes a
spot-check against `tshark` agree instead of drifting by a millisecond.

### Verifying B9 without a capture device

```bash
# tsx is a workspace-package dev dependency, so run it through the proxy package.
pnpm --filter proxy exec tsx ../../tools/pcap-selftest.ts /tmp/lambda-selftest.pcap 10000
tools/pcap-verify.sh /tmp/lambda-selftest.pcap
```

The first command writes 10,000 valid Ethernet/IPv4/TCP frames through the
same `PcapWriter` the proxy uses. The second checks packet count, malformed
packets, encapsulation, chronological timestamps and both length fields with
`capinfos`/`tshark`.

For the full demo, generate traffic through the proxy (including
`/api/reset`), click **Download .pcap**, open the file in Wireshark and filter
`tcp.flags.reset == 1`. The HTTP request that caused it is in the Frames view
with the same trace ID — that correlation is the project's thesis.

Mind the capture constraint from [Verifying B3](#verifying-b3): inside the
proxy container the WiFi NIC is absent and libpcap has no `CAP_NET_RAW`. Set
`CAPTURE_IFACE=eth0` on the proxy container to export bridge traffic, or run
the proxy on the host with its physical NIC to export host traffic.

## F8 — differential parser validation

`tools/validate-parser.sh` proves the hand-written packet parser (B2) produces
the *same answer* as `tshark` on the same capture file, and logs the comparison
to `docs/parser-validation.md`. Wireshark is not the competitor here; it is the
verifier. Any disagreement is a bug in one implementation or the other.

```bash
tools/validate-parser.sh                 # validate every committed fixture
tools/validate-parser.sh a.pcap b.pcap   # validate specific captures
```

It runs non-interactively and exits non-zero on any mismatch — no capture
privileges needed. Fixtures are committed in `tools/parser-fixtures/`: a real
loopback capture plus synthetic resets, retransmissions/out-of-order, chunked
transfers, and TCP-option/truncation/sequence-wrap edge cases. Regenerate the
synthetic ones (they are written by the same `PcapWriter` the proxy uses):

```bash
pnpm --filter proxy exec tsx ../../tools/make-parser-fixtures.ts
```

Two tshark settings are essential and easy to get wrong:

- `-o tcp.relative_sequence_numbers:false` — tshark defaults to *relative*
  seq/ack, but the parser reads the absolute wire values. The script runs a
  negative control that omits this flag to prove the harness catches the
  resulting mismatch.
- compare `tcp.window_size_value` (the raw 16-bit field), not `tcp.window_size`
  (the value scaled by the negotiated window-scale factor).

The pure comparison logic lives in `apps/proxy/src/l4/parser-validation.ts`
(unit-tested over known inputs); `tools/validate-parser.ts` and the shell script
are the file I/O around it. Timestamps are compared to microsecond tolerance,
and frames are aligned by `frame.number` so the IPv6 frames the parser skips
line up with the ones tshark's `ip && tcp` filter omits.

## B6 — TCP connection state

`apps/proxy/src/l4/state-machine.ts` reconstructs each connection's TCP lifecycle
from captured packets. Connections are keyed by a canonical 5-tuple, so packets
in either direction map to one record. Each endpoint runs its own state machine —
they are complementary (a FIN puts the sender in `FIN_WAIT_1` and the receiver in
`CLOSE_WAIT`):

```
handshake   SYN_SENT / SYN_RCVD → ESTABLISHED
active      ESTABLISHED → FIN_WAIT_1 → FIN_WAIT_2 → TIME_WAIT
passive     ESTABLISHED → CLOSE_WAIT → LAST_ACK
simultaneous close           → CLOSING → TIME_WAIT
any state + RST              → CLOSED (counted)
```

`TIME_WAIT` is retained for 2 × MSL (120 s) and never expired early. Idle
connections expire after 15 s, and the registry is hard-capped at 10 000 records;
both bounds are configurable. Illegal transitions (e.g. a retransmitted SYN after
`ESTABLISHED`) are logged no-ops, not state regressions.

Every change is published to the `tcp-state` Redis channel and appears in the
dashboard's **Connections** view as current state per endpoint plus full history.
The proxy associates each request's `X-Request-ID` with its client endpoint, so
the `CLOSED` event from a `/api/reset` RST carries the same trace ID and path —
the frame in the Frames view and the reset connection can be linked directly.

Replay a capture without capture privileges:

```bash
tools/state-replay.sh tools/parser-fixtures/reset.pcap
```

Set `REDIS_URL` to publish the same events into the dashboard:

```bash
REDIS_URL=redis://<redis-ip>:6379 tools/state-replay.sh tools/parser-fixtures/reset.pcap
```

Two deployment notes:

- Redis is exposed on the compose network, not published to the host. Find the
  container IP with `sudo docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' lambda-redis-1`.
- Live state events require the capture path, which does not work inside the
  proxy container (no physical NIC, no `CAP_NET_RAW`). Run the proxy on the host
  with `CAPTURE_IFACE` set to the physical NIC and traffic arriving from another
  machine. Tailscale traffic arrives as raw IP and is skipped by the
  Ethernet-oriented parser, so a phone-over-Tailscale load test will populate
  Frames but not Connections.

## B5 — RTT estimation (RFC 6298)

`apps/proxy/src/l4/rtt.ts` measures round-trip time from captured packets and
smooths it with RFC 6298. Each connection is keyed by the direction-insensitive
5-tuple, so request and acknowledgement land on the same record.

The estimator keeps `SRTT`, `RTTVAR` and the timer separately:

```
first sample R:  SRTT = R, RTTVAR = R/2, RTO = SRTT + 4×RTTVAR
later samples:   RTTVAR = (1−β)×RTTVAR + β×|SRTT−R|
                 SRTT   = (1−α)×SRTT   + α×R
                 RTO    = SRTT + max(G, 4×RTTVAR)
bounds:          1 s ≤ RTO ≤ 60 s
retransmission:  timer ×2; reset to SRTT + 4×RTTVAR on ACK
```

`α = 1/8`, `β = 1/4`, multiplier `4`, min `1 s`, max `60 s` — verified against
RFC 6298 §2.2–2.4 and §5.5. Note the issue text says "β/4 = 1/16"; that
contradicts the RFC's `β` term, which is applied directly (`β = 1/4`). The
implementation follows the RFC. `G` is the clock granularity, which is
negligible against our millisecond capture timestamps, so `max(G, 4×RTTVAR)`
reduces to `4×RTTVAR`.

Two details matter more than the formula: `RTTVAR` must be updated using the
*old* `SRTT` before `SRTT` is updated, and backoff must be applied to the timer,
not to the stored estimate. Backing off the stored `RTO` permanently corrupts
it; this implementation doubles a separate timer value and clears it on a new
sample or a pure ACK.

Samples come from two paths:

1. **Timestamp option (preferred).** A data segment carrying `TSval` is held;
   the opposite direction's `TSecr` echo matches it unambiguously. RTT is the
   difference of the two *capture* timestamps, so the timestamp option's tick
   rate never has to be assumed.
2. **Sequence/ACK matching (fallback).** When timestamps are absent, an ACK of
   `seq + payloadLen` closes the sample. Pure ACKs carry no payload and never
   open a sample; unrelated ACKs are ignored rather than guessed at.

A repeated data sequence is treated as a retransmission and backs the timer
off. That is a deliberately simple heuristic until B4 lands; it cannot
distinguish a reorder from a retransmission, so B7's reordering work will make
it sharper. Both the pending-sample queue and per-connection sequence history
are bounded (64 entries each), and connections expire after 15 s idle.

Every sample publishes an `rtt` event through the same Redis bus and capped
history list as the other L4 channels. Each event carries the raw sample plus
`SRTT`, `RTTVAR`, base RTO, current timer and backoff state. The dashboard's
**RTT** view shows the latest estimate per connection alongside the raw samples
so the smoothing is visible. `kind` distinguishes `sample`, `backoff` and
`ack` events.

### Verifying B5

```bash
pnpm test                  # hand-computed SRTT/RTTVAR at 400/800/200 ms samples
tools/rtt-replay.sh tools/parser-fixtures/chunked.pcap   # 2 ms seq/ack samples
tools/rtt-replay.sh tools/parser-fixtures/options.pcap   # timestamp-echo sample
REDIS_URL=redis://<redis-ip>:6379 tools/rtt-replay.sh tools/parser-fixtures/chunked.pcap
```

The replay tool needs no capture privileges and prints one line per event.
The hand-computed test is the important one: after samples 400, 800 and 200 ms,
SRTT must be 418.75 ms and RTTVAR 250 ms. If those numbers drift, the constants
are wrong.

For the live check, capture on the host physical NIC with traffic driven from
the second machine (see [Verifying B3](#verifying-b3)); `netem-up.sh wan` adds
20 ms ± 5 ms on the interface's root qdisc, i.e. the egress direction only, so
the RTT observed at the capture point settles near 20 ms, not 2 ms. Shape both
directions and it will double. Cross-check the smoothed RTT against B3's
`rttEstimateMs`, which is `totalMs / 2` and assumes a symmetric path.

## B4 — retransmission detection

`apps/proxy/src/l4/retransmit.ts` decides which captured segments were sent
twice, and why. It keeps a bounded set of sequence ranges per connection and
per direction. A new data segment is a retransmission when it **overlaps** a
range already seen:

- **full** — same start and end; **partial** — any other overlap, reported with
  the overlapping byte count.

All range arithmetic uses the signed 32-bit difference from `shared-types`, so
a range crossing `0xffffffff` is compared correctly. A segment that arrives
late but does not overlap anything is reordering (B7's job), not a
retransmission, and is not counted. Truncated captures (`capturedLength <
originalLength`) are flagged on the event rather than trusted for length
comparisons.

Cause is decided from duplicate ACKs. Pure ACKs repeating the same cumulative
ack number increment a per-direction counter; an advancing ACK resets it.
Three or more duplicate ACKs covering the retransmitted bytes mean **fast
retransmit** (the sender did not wait for a timer); otherwise it is **timeout**.
Only timeout events carry `observedRtoMs`, because the gap before a fast
retransmit is roughly one RTT, not the RTO. B5's RTT estimate is the reference
for that distinction.

Each event carries the per-connection and global retransmission rate, where
the denominator is observed data segments. With netem `loss 0.5%` the global
rate should settle near 0.5%; that is the acceptance check with ground truth
we injected ourselves. Sequence history is capped at 256 ranges per direction,
retained events at 1,000 and connections at 10,000; idle connections expire
after 15 s.

Events publish to the `retransmit` Redis channel and the dashboard's
**Retransmits** view lists kind, cause, overlap, delay, observed RTO, duplicate
ACK count and rate. It is an observer: nothing is retransmitted or blocked.

### Verifying B4

```bash
pnpm test
tools/retransmit-replay.sh tools/parser-fixtures/retransmit.pcap
REDIS_URL=redis://<redis-ip>:6379 tools/retransmit-replay.sh tools/parser-fixtures/retransmit.pcap
```

The committed fixture produces one full/fast event (three duplicate ACKs) and
one partial/timeout event. For the live check, run the load generator through
the proxy with `netem loss 0.5%` applied to the physical NIC (see
[Verifying B3](#verifying-b3)), then compare the dashboard's global rate with
the injected loss. Always run `netem-down.sh` afterwards.

## Stress-test generator (F4)

`stress-test/` generates a controlled flood of HTTP traffic at the proxy and
reports what it measured. It runs on the second laptop and is the source of
every latency, throughput and error-rate figure in the report.

| File            | Responsibility                                                |
| --------------- | ------------------------------------------------------------- |
| `config.ts`     | CLI flags, defaults and validation                            |
| `scenarios.ts`  | weighted scenario table, seeded RNG, request bodies           |
| `probe.ts`      | one measured request: status, latency, bytes in/out           |
| `aggregator.ts` | tiered latency histogram, percentiles, cross-worker merge     |
| `worker.ts`     | one `worker_thread`: concurrency pool, ramp, per-worker tally |
| `generator.ts`  | spawns workers, merges their histograms, ships reports        |
| `clock.ts`      | clock offset against the collector, measured before the run   |
| `reporter.ts`   | POSTs aggregates over HTTP — never Redis                      |
| `index.ts`      | CLI entry and the printed summary                             |

### Running it

```bash
pnpm build
node stress-test/dist/index.js --target http://127.0.0.1:8080 \
  --duration 30000 --concurrency 64 --ramp 5000
```

Against the proxy on the other laptop — A must be exposed on the LAN first, see
[Cross-machine rig](#cross-machine-rig-laptop-a--laptop-b):

```bash
node stress-test/dist/index.js --target http://<laptop-a>:8080 \
  --duration 30000 --concurrency 64 --ramp 5000 --label lan-a
```

Omit `--collector`: the collector endpoints are part of F5 and do not exist yet,
so a run that passes it logs the clock offset as `unavailable` and ships nothing.

### Configuration

| Flag                | Default                 | Notes                                                      |
| ------------------- | ----------------------- | ---------------------------------------------------------- |
| `--target`          | `http://127.0.0.1:3001` | Base URL. Must change between local and cross-machine runs |
| `--duration`        | `10000`                 | Run length in ms                                           |
| `--concurrency`     | `50`                    | Target in-flight requests, split across workers            |
| `--ramp`            | `2000`                  | Ramp window in ms; `0` starts at full concurrency          |
| `--workers`         | `0`                     | Worker threads; `0` means one per CPU core                 |
| `--seed`            | `12345`                 | RNG seed, recorded in the report so runs are comparable    |
| `--weights`         | unset                   | Scenario overrides, e.g. `like:20,follow:5`                |
| `--collector`       | unset                   | POST aggregates here; omit to skip shipping                |
| `--report-interval` | `2000`                  | Periodic report cadence in ms; `0` = end of run only       |
| `--label`           | `run`                   | Run label carried in every report                          |

### Measurement decisions

- **Latency is client-side and includes queueing at the proxy.** The proxy's own
  overhead needs logging separately (A2) or the two get conflated.
- **Percentiles, not the average.** 99 requests at 10 ms and one at 3 s average
  39.9 ms, which describes no request anyone made; P99 is 3 s.
- **The histogram is tiered** — 50 µs buckets below 10 ms, coarser above.
- **Percentiles overestimate by at most one bucket width**, since a bucket
  reports its upper edge. 50 µs at the fast end.
- **The generator is closed-loop**, so a slow server throttles it and P99 is
  understated (_coordinated omission_). The summary prints the loop mode.
- **`bytesIn` is measured, not read from `Content-Length`** — chunked responses
  have no such header, and a truncated response's header describes what was
  intended rather than what arrived.
- **A failed request still contributes its latency**, so a 3-second timeout does
  not vanish from the tail. Transport failures record as status `0` / key
  `transport`, distinct from a real 5xx.

### Scenario mix

Five weighted scenarios, retained from the spec. Each drives a stub behaviour.

| Scenario        | Weight | Endpoint           | Behaviour            |
| --------------- | ------ | ------------------ | -------------------- |
| `read_timeline` | 40%    | `/timeline/home`   | ~1 KB JSON           |
| `post_tweet`    | 25%    | `/api/small`       | chunked, 8 chunks    |
| `like`          | 15%    | `/api/small`       | ~1 KB JSON           |
| `follow`        | 10%    | `/api/slow?ms=250` | delayed 250 ms       |
| `view_profile`  | 10%    | `/api/status`      | rotating 2xx/4xx/5xx |

The observed mix prints next to the configured weights.

### Two failure modes

- **A Redis connection from the generator.** Pub/Sub does not cross machines, so
  a remote publish fails silently. Aggregates go over HTTP. Verify with
  `ss -tnp | grep <generator-pid> | grep 6379`; it must be empty.
- **`ulimit -n`.** Hundreds of concurrent sockets can exhaust file descriptors,
  surfacing as an `EMFILE` partway through a long run.

### Clock offset

`clock.ts` records the offset against the collector at run start. Correlating a
generator timestamp with a proxy timestamp requires the two clocks to agree. The
collector endpoints (`GET /time`, `POST /aggregates`) are part of F5 and do not
exist yet — until they do, a run with `--collector` logs the offset as
`unavailable` and continues with zero, which degrades cross-machine correlation
rather than the load itself.

## Commands

| Command                          | Purpose                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `pnpm install`                   | Install workspace dependencies                                     |
| `pnpm typecheck`                 | Typecheck all packages                                             |
| `pnpm build`                     | Build all packages                                                 |
| `pnpm lint`                      | Lint all packages                                                  |
| `pnpm infra:up` / `infra:down`   | Start/stop Docker services (**needs `sudo`** — see above)          |
| `node stress-test/dist/index.js` | Run the load generator (needs `pnpm build` first; see flags above) |
| `tools/validate-parser.sh`       | Differential parser validation against tshark (see F8)            |
| `tools/state-replay.sh`          | Replay a pcap through the B6 state machine (see B6)                |
| `tools/rtt-replay.sh`            | Replay a pcap through the B5 RTT estimator (see B5)                |
| `tools/retransmit-replay.sh`     | Replay a pcap through B4 retransmission detection (see B4)         |

## Continuous integration

`.github/workflows/ci.yml` runs on every PR to `main` in two jobs:

- **`verify`** — typecheck, build and lint.
- **`docker`** — `docker compose config`, builds both images, starts the stack,
  asserts `/health` on the proxy and stub, asserts the proxy container runs as
  non-root, and asserts libpcap is present in the runtime image.

The `docker` job exists because the TypeScript job is blind to container
problems. A musl/glibc mismatch, a missing `pnpm` install, or a build context
that cannot reach `pnpm-lock.yaml` all build fine locally on the right
hardware and only fail in the image — so without it, those reach `main`
unnoticed.

`.github/workflows/codeql.yml` runs CodeQL security scanning (daily PR +
weekly).

Two things CI deliberately does **not** do:

- **Live pcap capture.** Needs `CAP_NET_RAW` and a host interface, which
  GitHub-hosted runners do not grant. The `test` step stays commented until
  there are unit tests that need no privileges — the packet parser, RTT
  estimator and reassembly buffer are pure functions over known inputs, and
  those are where the test value is anyway.
- **Port-forwarded or `NET_ADMIN` behaviour checks beyond the smoke test.**
  The `NET_ADMIN` grant is asserted by capability, not by running `tc`.

`pnpm install --frozen-lockfile` in CI means **a PR that edits `package.json`
without regenerating `pnpm-lock.yaml` will fail.** Run `pnpm install` and commit
the lockfile alongside dependency changes.

One gotcha worth knowing: a workspace package with **zero dependencies** gets
no `importers[...]` entry in the lockfile, which then fails
`--frozen-lockfile`. Every workspace package needs at least one devDependency.

## Dependency notes

- `@audc/pcap` — libpcap bindings, ships linux-x64 prebuilds so no compiler
  toolchain is needed in CI. Requires `allowBuilds` in `pnpm-workspace.yaml`.
- TypeScript is pinned to `~5.9`. `typescript-eslint` does not yet support TS 7.

## Cross-Machine Testing Notes

*Proxy capture in Docker deployment:* The container's netns has only `eth0`/`lo` (`/proc/<pid>/root/sys/class/net`). `CAPTURE_IFACE=wlp0s20f3` does not exist there; `createSession` throws `No such device exists`. The container runs with `CapEff=0` and `CapBnd=0xa80435fb`. Docker does not give non-root containers effective capabilities, so `cap_add: NET_ADMIN` is inert and libpcap cannot open a packet socket (`CAP_NET_RAW may be required`). Consequences: the proxy's live handshake publisher prints nothing; the `.pcap` writer never opens; `apps/proxy/capture.pcap` on the host is stale.

*Host capture + replay workaround:* The working route is host-side capture plus offline replay — the same decode and analyse path, no capture privileges needed by the analyser:
```bash
# on A, on the physical NIC
tshark -i "$CAPTURE_IFACE" -f 'tcp port 8080' -F pcap -w /tmp/lan.pcap -a duration:45
# on B, drive traffic
node stress-test/dist/index.js --target http://<laptop-a>:8080 --duration 30000 ...
# on A, analyse
tools/handshake-replay.sh /tmp/lan.pcap
```
`dumpcap`/`tshark` can capture unprivileged here because `dumpcap` carries file capabilities (`cap_net_raw=eip`) and is `setgid wireshark`. `@audc/pcap` inside the container cannot.

Wireshark writes **nanosecond** pcaps by default (magic `0xa1b23c4d`); the replay tool now accepts microsecond and nanosecond, in both byte orders.

*Two traps that look like a broken parser:*
- **Loopback:** Traffic to A's own IP is delivered over `lo` and never touches the WiFi NIC, so a local `curl` produces an empty capture. The traffic must come from B.
- **netem scope:** `netem-up.sh` shapes the whole physical interface, not just the test flow. 20 ms is harmless; the `lossy` profile will degrade an interactive SSH session. Always `netem-down.sh` afterwards.

*Default-target trap:* The generator defaults to `http://127.0.0.1:3001` — the stub. Run on B with a blank `--target`, it aims at B's own loopback, where nothing listens, and reports 100% transport errors within a couple of seconds. Always pass `--target http://<laptop-a>:8080` on B.

*Exposing the proxy on the LAN:* `docker-compose.yml` binds the proxy to `127.0.0.1:8080` only. For a LAN run, layer the local override:
```bash
docker compose -f docker-compose.yml -f compose.lan.yml up -d proxy
ss -tlnp | grep 8080     # must show 0.0.0.0:8080, not 127.0.0.1:8080
```
`compose.lan.yml` is machine-local and gitignored; it replaces the port mapping with `0.0.0.0:8080:8080`. From B:
```bash
curl -sS -m 5 http://<laptop-a>:8080/health     # {"status":"ok",...}
```
If that fails, two causes in order:
- **ufw:** A runs ufw with `DEFAULT_FORWARD_POLICY=DROP`. Docker's FORWARD rules normally accept published ports; verify with `sudo ufw status verbose`, and if needed `sudo ufw allow 8080/tcp`.
- **Client isolation:** University WiFi often allows ICMP between clients but blocks TCP. Fall back to Tailscale (the original design; currently stopped) or a mobile hotspot.

*Evidence from the 2026-11-16 run:* With the proxy still bound to loopback, `/health` reported 1494 api + 996 timeline selections — exactly a 2484-request local smoke run plus six manual `/api/small` curls. Zero off-box requests reached the proxy. This is the expected state before `compose.lan.yml` is applied.
