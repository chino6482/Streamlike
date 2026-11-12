#!/bin/sh
# Se ejecuta automáticamente al arrancar LocalStack (docker-entrypoint-initaws.d).
# Crea el bucket S3 si no existe para que la subida y el worker funcionen.
set -e

BUCKET="${S3_BUCKET:-streamlike-bucket}"

echo "[localstack-init] Asegurando bucket S3: ${BUCKET}"
awslocal s3 mb "s3://${BUCKET}" 2>/dev/null || echo "[localstack-init] El bucket ya existe"
echo "[localstack-init] Listo"
