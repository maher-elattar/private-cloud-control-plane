#!/bin/sh
# Sends a steady, low request rate at one environment through the Gateway.
#
# GATEWAY      host:port of the Gateway's HTTP listener
# ROUTE_HOST   Host header the HTTPRoute matches on
# CANARY       when set, the value of the X-Canary header that selects the preview environment
# PATHS        space-separated request paths, cycled in order
# INTERVAL     seconds between requests
set -u
: "${INTERVAL:=1}"
: "${PATHS:=/health/ready}"
while true; do
  for path in $PATHS; do
    if [ -n "${CANARY:-}" ]; then
      curl --silent --show-error --max-time 5 --output /dev/null \
        --header "Host: ${ROUTE_HOST}" --header "X-Canary: ${CANARY}" \
        "http://${GATEWAY}${path}" || true
    else
      curl --silent --show-error --max-time 5 --output /dev/null \
        --header "Host: ${ROUTE_HOST}" \
        "http://${GATEWAY}${path}" || true
    fi
    sleep "${INTERVAL}"
  done
done
