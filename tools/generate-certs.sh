#!/usr/bin/env bash
# A8: regenerate the local demo certificates. Generated material is ignored by
# git; never commit a private key, even for a throwaway project.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p certs
hosts=(secure.example tunnel.example)

if command -v mkcert >/dev/null 2>&1; then
  for host in "${hosts[@]}"; do
    mkcert -cert-file "certs/${host}.pem" -key-file "certs/${host}-key.pem" "$host"
  done
  echo "Generated mkcert-trusted certificates in certs/ (browser: no warning)."
else
  echo "mkcert not found: generating self-signed certificates for wire tests only." >&2
  echo "Browsers will warn. Install mkcert and re-run for the no-warning criterion." >&2
  for host in "${hosts[@]}"; do
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
      -keyout "certs/${host}-key.pem" -out "certs/${host}.pem" \
      -subj "/CN=${host}" \
      -addext "subjectAltName=DNS:${host}" >/dev/null 2>&1
  done
fi
