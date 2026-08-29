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
