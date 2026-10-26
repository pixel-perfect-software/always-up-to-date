#!/bin/sh
# Test-only TLS material for the registry client tests. Valid 100 years. Rerun to regenerate.
set -eu; cd "$(dirname "$0")"; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
printf '[req]\ndistinguished_name=dn\n[dn]\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' > "$tmp/ca.cnf"
openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/ca.key"
openssl req -x509 -new -key "$tmp/ca.key" -sha256 -days 36500 -subj "/CN=autd test CA" -config "$tmp/ca.cnf" -extensions v3_ca -out ca.pem
leaf() { openssl ecparam -name prime256v1 -genkey -noout -out "$1.key"
  openssl req -new -key "$1.key" -subj "/CN=$2" -out "$tmp/$1.csr"
  printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=%s\n%s' "$3" "${4:+subjectAltName=$4\n}" > "$tmp/$1.ext"
  openssl x509 -req -in "$tmp/$1.csr" -CA ca.pem -CAkey "$tmp/ca.key" -CAcreateserial -CAserial "$tmp/ca.srl" -days 36500 -sha256 -extfile "$tmp/$1.ext" -out "$1.pem"; }
leaf server localhost serverAuth "DNS:localhost,IP:127.0.0.1"
leaf client "autd test client" clientAuth
