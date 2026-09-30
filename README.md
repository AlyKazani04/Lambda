# Lambda (λ)

A Custom Reverse Proxy with Real-Time Packet Capture and Traffic Analysis.

## Notes

1. **Package Manager**: `pnpm`
2. **Node Version**: Using `v26.7.0` locally (see `.nvmrc`)
3. **Ports**: Proxy `:8080`, Stub `:3001`, Dashboard `:3000`, Redis `:6379`, Postgres `:5432`

## Getting started

```bash
pnpm install
cp .env.example .env      # then edit CAPTURE_IFACE
pnpm smoke               # verifies packet capture works on this machine
```

### `CAPTURE_IFACE` — read this before the capture goes quiet

The proxy captures on the interface named in `CAPTURE_IFACE`. It defaults to `lo`
in `.env.example` because that works everywhere.

Find your interface with:

```bash
ip -br addr
```

Use your **physical** NIC (`wlp0s20f3` on one dev laptop) when another machine is
generating traffic. Capturing on `lo` while traffic arrives from a remote host
sees **nothing** — that is not a bug in the parser, it is the wrong interface.

When running inside Docker, a container's `lo` is namespace-isolated and also
sees no host traffic; capture on the physical NIC and give the container
`cap_add: [NET_ADMIN]`.

## Capturing requires elevated privileges

libpcap needs `CAP_NET_RAW`. Without it `pnpm smoke` exits 1 with an explicit
message rather than a cryptic errno.

```bash
# Option A: Docker (recommended — matches the deploy target)
#   cap_add: [NET_ADMIN] in docker-compose.yml

# Option B: grant the capability to node once
sudo setcap cap_net_raw,cap_net_admin=eip "$(which node)"

# Option C: run as root
sudo -E env "PATH=$PATH" pnpm smoke
```

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

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install workspace dependencies |
| `pnpm smoke` | Verify packet capture works (needs CAP_NET_RAW) |
| `pnpm typecheck` | Typecheck all packages |
| `pnpm build` | Build all packages |
| `pnpm lint` | Lint all packages |
| `pnpm test` | Run tests (currently the smoke check) |
| `pnpm infra:up` / `infra:down` | Start/stop Docker services |

## Continuous integration

`.github/workflows/ci.yml` runs on every PR to `main`: typecheck, build, lint,
and the smoke test. `.github/workflows/codeql.yml` runs CodeQL security scanning
(daily PR + weekly).

`pnpm install --frozen-lockfile` in CI means **a PR that edits `package.json`
without regenerating `pnpm-lock.yaml` will fail.** Run `pnpm install` and commit
the lockfile alongside dependency changes.

Branch protection on `main` is required — see the project notes.

## Dependency notes

- `@audc/pcap` — libpcap bindings, ships linux-x64 prebuilds so no compiler
  toolchain is needed in CI. Requires `allowBuilds` in `pnpm-workspace.yaml`.
- TypeScript is pinned to `~5.9`. `typescript-eslint` does not yet support TS 7.
