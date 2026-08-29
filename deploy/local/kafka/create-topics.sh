#!/usr/bin/env bash
set -euo pipefail

for topic in provisioning.commands.v1 provisioning.events.v1 provisioning.dlq.v1 audit.events.v1 reconciliation.events.v1; do
  /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server kafka:29092 \
    --create --if-not-exists \
    --topic "${topic}" \
    --partitions 6 \
    --replication-factor 1 \
    --config message.timestamp.type=LogAppendTime
done
