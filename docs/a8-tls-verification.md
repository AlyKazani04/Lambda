# A8 — TLS termination, SNI routing and two-layer frame logging

Parent: issue #3 (Track A) · item **A8** · branch `a8-tls-termination`

## What landed

- `apps/proxy/src/config.ts` — `TLS_ENABLED`, `TLS_PORT`, `TLS_CERT_FILE`, `TLS_KEY_FILE`, `TLS_SNI_ROUTES`, `TLS_LOG_SECRETS`. All certificate paths come from config; startup fails on missing key material.
- `apps/proxy/src/l7/tls.ts` — pure ClientHello/SNI parser with incomplete vs malformed distinction.
- `apps/proxy/src/l7/gateway.ts` — one TLS front door. It peeks SNI before decryption, then either:
  - **decrypt:** builds a server-side `TLSSocket` over a `Duplex` bridge and emits it into the ordinary `http.Server`, so the existing `handleRequest`, frame logger and A4 watchdog are reused;
  - **passthrough:** pipes raw bytes to a TLS upstream with no key and no decryption, publishing an `SniRouteEvent` that deliberately has no method/path/headers.
- `apps/proxy/src/index.ts` — TLS and plaintext share the same router and frame recorder; SNI selects the upstream group for TLS.
- `packages/shared-types` + `apps/dashboard` — frames carry `tlsMode`, `sni` and (redacted) `headers`; a new **SNI Routes** view subscribes to the `sni-routes` channel and backfills its history.
- `tools/generate-certs.sh`, `tools/tls-verify.ts`, compose/Dockerfile exposure, `.env.example`, `.gitignore` — local cert generation, a wire-level verification harness, and key material kept out of git.

Design choices: TLS is off by default, listens on 8443, advertises `http/1.1` via ALPN (no h2), masks `Authorization`/`Cookie` unless `TLS_LOG_SECRETS=true`, and the internal hop to the stub stays plaintext so the two-layer comparison is real.

## Verification actually run

| Check | Command | Result |
| --- | --- | --- |
| Unit tests | `pnpm run test` | proxy 111/111, dashboard 12/12, other workspaces 0 failures |
| Lint | `pnpm run lint` | exit 0 |
| Typecheck | `pnpm run typecheck` | exit 0 |
| Build | `pnpm run build` | exit 0, dashboard routes emitted |
| Compose shape | `docker compose config -q` | exit 0 |
| Cert script syntax | `bash -n tools/generate-certs.sh` | exit 0 |
| Key material ignored | `git check-ignore -v certs/secure.example-key.pem` | `.gitignore:36:certs/` |
| Wire-level TLS | `cd apps/proxy && node --import tsx ../../tools/tls-verify.ts` | `A8 VERIFIED: decrypt + SNI frame, raw passthrough, no decrypted passthrough frame` |

The wire harness starts a plaintext upstream and a separate TLS origin, sends real HTTPS requests through the gateway with certificate verification on, and asserts:

- the decrypt hostname produces exactly one frame with `tlsMode=decrypt`, the correct SNI, and the `Authorization` header (with `TLS_LOG_SECRETS=true`);
- the passthrough hostname reaches the TLS origin byte-for-byte and produces **no** decrypted frame, only an `SniRouteEvent`.

## Demo recipe

1. Generate certificates:

   ```bash
   bash tools/generate-certs.sh
   ```

   With `mkcert` installed the CA is trusted locally and browsers show no warning. Without it the script falls back to self-signed certificates and prints a warning; those are fine for the wire test but browsers will warn.

2. Start a TLS origin for the passthrough hostname (any TLS server on 8444 works):

   ```bash
   openssl s_server -accept 8444 \
     -cert certs/tunnel.example.pem \
     -key certs/tunnel.example-key.pem -www
   ```

3. Start the proxy on the host (point `UPSTREAM_TARGETS` at a running stub):

   ```bash
   TLS_ENABLED=true TLS_PORT=8443 \
   TLS_CERT_FILE="$PWD/certs/secure.example.pem" \
   TLS_KEY_FILE="$PWD/certs/secure.example-key.pem" \
   TLS_SNI_ROUTES='[{"host":"secure.example","mode":"decrypt","group":"api"},{"host":"tunnel.example","mode":"passthrough","target":"127.0.0.1:8444"}]' \
   TLS_LOG_SECRETS=true SLOWLORIS_ENABLED=false \
   UPSTREAM_TARGETS=127.0.0.1:3001 CAPTURE_IFACE='' \
   pnpm --filter proxy dev
   ```

4. Decrypted request (the proxy terminates TLS and logs the plaintext request):

   ```bash
   curl --cacert certs/secure.example.pem \
     --resolve secure.example:8443:127.0.0.1 \
     -H 'Authorization: Bearer demo-token' \
     https://secure.example:8443/api/timeline
   ```

   With mkcert-trusted certificates, drop `--cacert`:

   ```bash
   curl --resolve secure.example:8443:127.0.0.1 \
     -H 'Authorization: Bearer demo-token' \
     https://secure.example:8443/api/timeline
   ```

5. SNI-only passthrough (the proxy holds no key for this hostname):

   ```bash
   curl --cacert certs/tunnel.example.pem \
     --resolve tunnel.example:8443:127.0.0.1 \
     https://tunnel.example:8443/
   ```

6. Plaintext through the same proxy:

   ```bash
   curl http://127.0.0.1:8080/api/timeline
   ```

7. Dashboard: open `http://127.0.0.1:3000`, then **Frames** for the TLS/SNI/header columns and **SNI Routes** for the passthrough row.

## Not verified here

- **Browser certificate warning.** `mkcert` is not installed on this machine, so the generated certificates are self-signed and a browser will warn. The criterion needs a run of `tools/generate-certs.sh` with mkcert installed and a browser check. The wire harness does verify certificate validation against the supplied CA at the TLS client layer.
- **Wire ciphertext (`tcpdump`).** This macOS host has no `tcpdump`/`tshark`. On the Linux target box, capture during a request and confirm no plaintext appears:

  ```bash
  sudo tcpdump -i <iface> -nn -s0 -w /tmp/a8.pcap 'tcp port 8443'
  strings /tmp/a8.pcap | grep -F 'demo-token'   # must find nothing
  strings /tmp/a8.pcap | grep -F 'GET /api'     # must find nothing
  ```

- **Compose runtime with TLS enabled.** Only `docker compose config -q` ran. Docker needs sudo here and no containers were running. The compose mount uses `/certs` inside the container and `host.docker.internal:8444` for the demo origin; neither path was exercised at runtime.
- **Dashboard visual state.** Build, typecheck, payload validators and the sidebar registration were verified; the page was not opened in a browser against a live Redis backfill.

## Security notes

No private key or certificate is committed — `certs/` and `*.pem`/`*.key` are gitignored and `git check-ignore` confirms it. Certificate headers are masked by default; `TLS_LOG_SECRETS=true` is a deliberate demo opt-in and writes credentials into the Redis frame history, so do not leave it on outside a local demo. Certificates expire; re-run the generator before a later demo.
