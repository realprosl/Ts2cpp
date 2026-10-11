#!/usr/bin/env bash
# Genera certificados self-signed para tests TLS.
# Los .pem resultantes NO son de producción; solo sirven para
# verificar que el handshake funciona y que los read/write de
# payloads encriptados son correctos.
#
# Uso:
#   ./generate_test_certs.sh [output_dir]
#
# Por defecto, los pone en tests/tls/ (mismo directorio que este
# script). Para regenerarlos: rm cert.pem key.pem && ./generate_test_certs.sh

set -euo pipefail

OUT="${1:-$(dirname "$0")}"

# SubjectAltName con DNS:localhost + IP:127.0.0.1 (los tests
# usan ambos endpoints). -nodes = no passphrase.
openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$OUT/key.pem" \
    -out "$OUT/cert.pem" \
    -days 3650 \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    2>/dev/null

chmod 600 "$OUT/key.pem"

echo "Generated:"
echo "  $OUT/cert.pem"
echo "  $OUT/key.pem"
