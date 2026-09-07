# Phase 6 Deployment Metric Catalog

Phase 4 established the metric contract for the application: OTLP to a Collector, one consolidated
scrape target, and exact SDK views bounding every instrument's attributes. That catalog is in
[Phase 4 Metric Catalog](phase-4-metric-catalog.md) and none of it changed.

Phase 6 adds a **second** metric path, for one reason: the promotion gate has to distinguish the
green environment from the blue one, and a pipeline that aggregates across every pod of a service
cannot. This document covers that path, the series the analysis actually queries, and the alerts
built on top of them.

## Why there are two paths

| | Phase 4 path | Phase 6 path |
| --- | --- | --- |
| Transport | OTLP push to the Collector | Prometheus scrape of each pod |
| Granularity | Per service, aggregated across pods | Per pod, and therefore per environment |
| Enabled by | `OTEL_EXPORTER_OTLP_ENDPOINT` | `PROMETHEUS_METRICS_PORT` |
| Consumer | Dashboards, traces, existing alerts | `AnalysisTemplate` queries |
| Selected by | The Collector's own scrape config | `ServiceMonitor` on the active and preview Services |

Both readers run at once over the same meter provider. The scrape endpoint is an addition, not a
replacement, and turning it off (by unsetting `PROMETHEUS_METRICS_PORT`) leaves Phase 4's pipeline
untouched — it only removes the gate's ability to see.

## The scraped instrument

One instrument carries the entire promotion decision.

| Scrape name | Type | Unit | Attributes | Cardinality limit |
| --- | --- | --- | --- | --- |
| `http_server_request_duration` | Histogram | `s` | `http.request.method`, `http.response.status_code`, `http.route`, `error.type` | 512 |

It is the OpenTelemetry HTTP instrumentation's `http.server.request.duration`, bounded by an
explicit SDK view in `packages/observability/src/runtime.ts`. The attribute list is an allow-list
processor, not a convention: an attribute the instrumentation adds and this list omits is dropped
before it reaches the exporter. That is SAFE-034 enforced at the same point the package already
enforces it for the custom instruments — no project, instance, operation, address, or hostname value
ever becomes a label.

**Two naming details that matter when writing a query:**

- The counter series is `http_server_request_duration_count`, **not**
  `http_server_request_duration_seconds_count`. The OpenTelemetry Prometheus exporter omits the unit
  suffix for a histogram whose boundaries are already in seconds. A query using the `_seconds_`
  form returns nothing, silently.
- Attribute names are translated to Prometheus form: `http.response.status_code` becomes
  `http_response_status_code`.

### What is deliberately absent

`resourceDetectors: []` is set on the SDK. The Prometheus exporter publishes resource attributes as
a `target_info` series, and the default detectors put the host name, the process owner, the process
command line, and the executable path into it. On the OTLP path those attributes go to a Collector
inside the trust boundary; on a scrape endpoint they are readable by anything that can reach the
pod. The unit test in `runtime.spec.ts` asserts their absence by name.

## Scrape configuration

| ServiceMonitor | Selects | Interval | Why |
| --- | --- | --- | --- |
| `control-plane-preview` | Services labelled `private-cloud.io/rollout-role: preview` | 10s | The gate takes four measurements 20s apart; a 30s scrape would give it one sample per measurement |
| `control-plane-active` | Services labelled `private-cloud.io/rollout-role: active` | 10s | Symmetry, so a comparison between environments is not comparing resolutions |
| `otel-collector` | The in-cluster Collector | 15s / 30s | Pipeline health, not promotion evidence |

All three carry `release: my-kube-prometheus-stack`, which is the label the existing Prometheus
selects on. Nothing about the monitoring stack is modified to accommodate them.

The cluster default scrape interval is 30s. These monitors set their own, which is the whole reason
they exist as separate objects rather than relying on a namespace-wide scrape.

## The analysis queries

Each `AnalysisTemplate` runs against the cluster Prometheus and reduces to a single scalar that a
`successCondition` compares. All three are in `deploy/kubernetes/applications/analysis-templates.yaml`.

| Template | Metric name in the run | Success condition | Question |
| --- | --- | --- | --- |
| `green-http-success-rate` | `green-http-200-rate` | `result[0] >= 0.90` | Is green returning HTTP 200 for at least 90% of what it is asked? |
| `green-traffic-floor` | `green-request-rate` | `result[0] >= 0.10` | Is green being asked anything at all? |
| `green-scrape-health` | `green-ready-replicas` | `result[0] >= 2` | Is Prometheus actually able to measure green? |

All three use `initialDelay: 45s`, `interval: 20s`, `count: 4`, `failureLimit: 1`. One bad
measurement is noise; two is a verdict.

### PromQL that survives an empty result

```promql
sum(rate(http_server_request_duration_count{
      namespace="private-cloud", service="control-api-preview",
      http_response_status_code="200"}[1m])) or vector(0)
/
clamp_min(sum(rate(http_server_request_duration_count{
      namespace="private-cloud", service="control-api-preview"}[1m])), 0.001)
```

Both guards are load-bearing and neither is decoration:

- `or vector(0)` — PromQL returns an *empty vector*, not zero, when nothing matches. A green
  environment that has served no successful request would otherwise produce no result at all, and
  an `AnalysisRun` with no result is an **Error**, not a **Failure**. Those are different outcomes
  with different messages, and the confusing one would be the one you got.
- `clamp_min(…, 0.001)` — dividing by an empty or zero denominator yields `NaN`, and `NaN >= 0.90`
  is false. The gate would fail, but for the wrong reason and with an unreadable measurement. The
  clamp makes "no traffic" evaluate to a success rate of 0.

## Alerts

Five rules in `deploy/kubernetes/dashboards/prometheus-rules.yaml`, all labelled for the existing
Prometheus operator.

| Alert | Severity | For | Fires when |
| --- | --- | --- | --- |
| `RolloutDegraded` | critical | 2m | A control-plane rollout reports the Degraded phase |
| `RolloutStuckPaused` | warning | 15m | A rollout has been paused far longer than an analysis takes |
| `GreenSuccessRateBelowGate` | warning | 5m | A preview environment is below the 90% gate — the early warning that the *next* promotion will be refused |
| `ArgoApplicationOutOfSync` | warning | 10m | An application has not converged, which is also the signature of a controller-owned field missing from `ignoreDifferences` |
| `OutboxNotDraining` | critical | 10m | The transactional outbox backlog is not falling — a Phase 4 invariant, re-alerted here because the deployment can break it |

`RolloutDegraded` and `GreenSuccessRateBelowGate` overlap deliberately. The first says a promotion
already failed; the second says the environment is unhealthy *now*, whether or not a rollout is in
progress. An operator who only has the first learns about the problem at the least convenient
moment.

## Dashboard

`dashboards/grafana-dashboard.yaml` provisions a dashboard with uid `private-cloud-bluegreen` into
the existing Grafana by the `grafana_dashboard: '1'` label. Eight panels, arranged around the one
question the deployment exists to answer: which environment is serving, and would the other one be
allowed to.
