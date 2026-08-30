#!/bin/sh
set -eu

until curl --fail --silent http://debezium-connect:8083/connectors >/dev/null; do
  sleep 2
done

curl --fail --silent --show-error \
  -X PUT \
  -H 'Content-Type: application/json' \
  --data-binary @/config/outbox-connector.json \
  http://debezium-connect:8083/connectors/private-cloud-outbox/config >/dev/null

attempt=1
while [ "$attempt" -le 60 ]; do
  connector_status=$(curl --fail --silent \
    http://debezium-connect:8083/connectors/private-cloud-outbox/status || true)
  running_components=$(printf '%s' "$connector_status" | grep -o '"state":"RUNNING"' | wc -l)
  if [ "$running_components" -ge 2 ]; then
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done

printf '%s\n' "$connector_status" >&2
printf '%s\n' 'Debezium connector and task did not become RUNNING within 120 seconds.' >&2
exit 1
