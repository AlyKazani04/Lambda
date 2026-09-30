# Lambda (λ)

A Custom Reverse Proxy with Real-Time Packet Capture and Traffic Analysis.

## Notes

1. **Package Manager**: `pnpm`
2. **Node Version**: Using `v26.7.0` locally (see `.nvmrc`)
3. **Ports**: Proxy `:8080`, Stub `:3001`, Dashboard `:3000`, Redis `:6379`, Postgres `:5432`

## Getting started

```bash
pnpm install
cp .env.example .env
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

| Command                        | Purpose                        |
| ------------------------------ | ------------------------------ |
| `pnpm install`                 | Install workspace dependencies |
| `pnpm typecheck`               | Typecheck all packages         |
| `pnpm build`                   | Build all packages             |
| `pnpm lint`                    | Lint all packages              |
| `pnpm infra:up` / `infra:down` | Start/stop Docker services     |

## Continuous integration

`.github/workflows/ci.yml` runs on every PR to `main`: typecheck, build and lint. `.github/workflows/codeql.yml` runs CodeQL security scanning
(daily PR + weekly).

`pnpm install --frozen-lockfile` in CI means **a PR that edits `package.json`
without regenerating `pnpm-lock.yaml` will fail.** Run `pnpm install` and commit
the lockfile alongside dependency changes.

Branch protection on `main` is required — see the project notes.

## Dependency notes

- `@audc/pcap` — libpcap bindings, ships linux-x64 prebuilds so no compiler
  toolchain is needed in CI. Requires `allowBuilds` in `pnpm-workspace.yaml`.
- TypeScript is pinned to `~5.9`. `typescript-eslint` does not yet support TS 7.
