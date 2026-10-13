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
or update the script once you decide which way to go.

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

| File          | Responsibility                                              |
| ------------- | ----------------------------------------------------------- |
| `config.ts`   | routing table, upstream targets and counts from environment  |
| `router.ts`   | longest-prefix match on segment boundaries; 404 on no match  |
| `upstream.ts` | round-robin pools, per group, with DNS instance discovery    |
| `forwarder.ts`| header filtering, piping, client-abort propagation           |
| `index.ts`    | server, `/health`, per-request upstream log                  |

Default routing table: `/api/*` and `/timeline/*` both go to the stub service.
`GET /health` is answered by the proxy itself and never forwarded.

### Configuration

| Variable                         | Default      | Notes                                                           |
| -------------------------------- | ------------ | --------------------------------------------------------------- |
| `PROXY_PORT`                     | `8080`       | Bind port                                                       |
| `PROXY_HOST`                     | `0.0.0.0`    | Loopback binds are unreachable from Laptop B                    |
| `ROUTES`                         | see above    | JSON array of `{ prefix, group }`                                |
| `UPSTREAM_HOST`                  | `127.0.0.1`  | Service name or address; resolved to the instance list          |
| `UPSTREAM_PORT`                  | `3001`       |                                                                  |
| `UPSTREAM_INSTANCES`             | `3`          | Cap on resolved instances; must be >= replica count             |
| `UPSTREAM_DISCOVERY_INTERVAL_MS` | `5000`       | Re-resolve interval; `0` disables                                |
| `UPSTREAM_TARGETS`               | unset        | `host:port,...` (a bare port means loopback). Pins the list      |
| `UPSTREAM_TARGETS_<GROUP>`       | unset        | Per-group override, e.g. `UPSTREAM_TARGETS_TIMELINE`            |

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

### Verifying the proxy core

`tools/verify-proxy-core.mjs` exercises the built artifacts end to end: it
starts its own stub instances, a recording upstream, and several proxy
processes, then asserts each acceptance criterion and prints the observable it
based the verdict on.

```bash
pnpm build
node tools/verify-proxy-core.mjs
```

## Stress-test generator (F4)

`stress-test/` generates a controlled flood of HTTP traffic at the proxy and
reports what it measured. It runs on the second laptop and is the source of
every latency, throughput and error-rate figure in the report.

| File             | Responsibility                                            |
| ---------------- | ---------------------------------------------------------- |
| `config.ts`      | CLI flags, defaults and validation                         |
| `scenarios.ts`   | weighted scenario table, seeded RNG, request bodies        |
| `probe.ts`       | one measured request: status, latency, bytes in/out        |
| `aggregator.ts`  | tiered latency histogram, percentiles, cross-worker merge  |
| `worker.ts`      | one `worker_thread`: concurrency pool, ramp, per-worker tally |
| `generator.ts`   | spawns workers, merges their histograms, ships reports     |
| `clock.ts`       | clock offset against the collector, measured before the run |
| `reporter.ts`    | POSTs aggregates over HTTP — never Redis                   |
| `index.ts`       | CLI entry and the printed summary                          |

### Running it

```bash
pnpm build
node stress-test/dist/index.js --target http://127.0.0.1:8080 \
  --duration 30000 --concurrency 64 --ramp 5000
```

Against the proxy on the other laptop, with netem applied and a collector
receiving progress:

```bash
node stress-test/dist/index.js --target http://<laptop-a>:8080 \
  --collector http://<laptop-a>:3000 --report-interval 2000
```

### Configuration

| Flag                    | Default                 | Notes                                                          |
| ----------------------- | ----------------------- | -------------------------------------------------------------- |
| `--target`              | `http://127.0.0.1:3001` | Base URL. Must change between local and cross-machine runs      |
| `--duration`            | `10000`                 | Run length in ms                                                |
| `--concurrency`         | `50`                    | Target in-flight requests, split across workers                 |
| `--ramp`                | `2000`                  | Ramp window in ms; `0` starts at full concurrency               |
| `--workers`             | `0`                     | Worker threads; `0` means one per CPU core                      |
| `--seed`                | `12345`                 | RNG seed, recorded in the report so runs are comparable         |
| `--weights`             | unset                   | Scenario overrides, e.g. `like:20,follow:5`                     |
| `--collector`           | unset                   | POST aggregates here; omit to skip shipping                     |
| `--report-interval`     | `2000`                  | Periodic report cadence in ms; `0` = end of run only            |
| `--label`               | `run`                   | Run label carried in every report                               |

### Measurement decisions worth knowing

- **Latency is client-side and includes queueing at the proxy.** That is the
  end-to-end number we want, but it means the proxy's own overhead has to be
  logged separately (A2) or the two get conflated.
- **Percentiles, never the average.** 99 requests at 10 ms and one at 3 s gives
  an average of 39.9 ms, which describes no request anyone made. P99 is 3 s.
  The histogram is tiered — 50 µs buckets below 10 ms, coarser above — so
  sub-millisecond resolution survives where it matters.
- **Percentiles overestimate by at most one bucket width**, because a bucket
  reports its upper edge. At the fast end that is 50 µs.
- **The generator is closed-loop**, so a slow server throttles it and P99 is
  understated (*coordinated omission*). The summary prints the loop mode
  explicitly; state it whenever you quote a number.
- **`bytesIn` is measured, not read from `Content-Length`.** Chunked responses
  have no such header, and on a truncated response the header describes what was
  intended rather than what arrived.
- **A failed request still contributes its latency**, otherwise a 3-second
  timeout vanishes from the tail and biases P99 downward. Transport failures are
  recorded as status `0` / key `transport`, so they stay distinguishable from a
  real 5xx.

### Scenario mix

Five weighted scenarios, retained from the spec. Each drives a stub behaviour so
the run exercises a mix rather than a uniform hammer.

| Scenario        | Weight | Endpoint              | Behaviour          |
| --------------- | ------ | --------------------- | ------------------ |
| `read_timeline` | 40%    | `/timeline/home`      | ~1 KB JSON         |
| `post_tweet`    | 25%    | `/api/small`          | chunked, 8 chunks  |
| `like`          | 15%    | `/api/small`          | ~1 KB JSON         |
| `follow`        | 10%    | `/api/slow?ms=250`    | delayed 250 ms     |
| `view_profile`  | 10%    | `/api/status`         | rotating 2xx/4xx/5xx |

The observed mix is printed next to the configured weights, so a run proves its
own shape rather than asserting it.

### Two things that will look like bugs

- **The generator must never open a Redis connection.** Pub/Sub does not cross
  machines, so a remote publish fails silently with no error — the worst kind of
  failure. Aggregates go over HTTP. Verify with
  `ss -tnp | grep <generator-pid> | grep 6379`; it must be empty.
- **`ulimit -n`.** Hundreds of concurrent sockets can exhaust file descriptors,
  and the symptom is a mystifying `EMFILE` partway through a long run.

### Clock offset

`clock.ts` asks the collector for its time and records the offset at run start.
Correlating "this request was slow" (generator timestamp) with "this connection
retransmitted" (proxy timestamp) is only valid if the two clocks agree. The
collector endpoint (`GET /time`, `POST /aggregates`) is part of F5 and does not
exist yet — until it does, a run with `--collector` logs the offset as
`unavailable` and continues with zero, which degrades cross-machine correlation
rather than the load itself.

## Commands

| Command                        | Purpose                                                   |
| ------------------------------ | --------------------------------------------------------- |
| `pnpm install`                 | Install workspace dependencies                            |
| `pnpm typecheck`               | Typecheck all packages                                    |
| `pnpm build`                   | Build all packages                                        |
| `pnpm lint`                    | Lint all packages                                         |
| `pnpm infra:up` / `infra:down` | Start/stop Docker services (**needs `sudo`** — see above) |
| `node tools/verify-proxy-core.mjs` | Behavioural verification of the proxy core (needs `pnpm build` first) |
| `node stress-test/dist/index.js` | Run the load generator (needs `pnpm build` first; see flags above) |

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
