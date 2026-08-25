# Contracts and Provider Port

## Communication Model

![Contract communication sequence](../diagrams/rendered/contract-communication.mermaid.svg)

The synchronous contract accepts identity and durable intent. The asynchronous contract carries versioned commands and facts. The provider contract accepts only provider-neutral lifecycle values and returns normalized evidence. An HTTP or gRPC acceptance response never waits for provider completion.

## Authoritative Sources

| Boundary | Source | Generated TypeScript | Human-readable table | Compatibility authority |
| --- | --- | --- | --- | --- |
| External REST | `packages/contracts/openapi/control-plane.v1.yaml` | `packages/contracts/src/generated/openapi.ts` | [REST API](../contracts/rest-api.md) | OpenAPI major version and ADR-0010 |
| External gRPC | `packages/contracts/proto/privatecloud/controlplane/v1/control_plane.proto` | `packages/contracts/src/generated/proto/privatecloud/controlplane/v1/control_plane.pb.ts` | [gRPC API](../contracts/grpc-api.md) | Protobuf package version and Buf breaking rules |
| Provider gRPC | `packages/contracts/proto/privatecloud/provider/v1/provider.proto` | `packages/contracts/src/generated/proto/privatecloud/provider/v1/provider.pb.ts` | [gRPC API](../contracts/grpc-api.md) | Provider port version and conformance suite |
| Kafka | `packages/contracts/asyncapi/control-plane.v1.yaml` | `packages/contracts/src/generated/events.ts` | [Kafka events](../contracts/events.md) | Topic major version and JSON Schema |
| Stable errors | OpenAPI problem schema and RPC policy | Generated with the owning contract | [Error catalog](../contracts/errors.md) | Stable code or canonical status |
| Fields | OpenAPI, protobuf, and JSON Schema | Generated with the owning contract | [Field catalog](../contracts/fields.md) | Owning schema |

## Boundary Rules

| Rule | Enforcement |
| --- | --- |
| No provider placement or credential fields in tenant create input | Contract invariant test rejects provider field names |
| Every mutation has a stable request identity | Required REST idempotency header, gRPC mutation context, and provider request ID |
| A provider deadline is not a failed mutation | Provider transport error type and unknown-outcome workflow |
| Duplicate event delivery is expected | Event ID plus inbox receipt; aggregate ID is the Kafka key |
| Destructive operations require ownership evidence | Provider ownership markers and explicit purge authorization fields |
| Contract data is bounded | 65,536-byte REST bodies and 262,144-byte Kafka payloads |
| Sensitive data does not become telemetry | Per-field classification and telemetry metadata |

## Fake Provider

![Deterministic fake-provider outcomes](../diagrams/rendered/fake-provider-outcomes.mermaid.svg)

| Scenario | Configuration | Expected contract result | Side effect |
| --- | --- | --- | --- |
| Success | `mode: success` | Accepted task and observable resource | Applied once |
| Deterministic latency | `latencyMs` or default latency | Result after injected sleeper completes | Depends on result mode |
| Classified failure | `mode: failure` plus optional failure code | `REJECTED` with safe normalized failure | None |
| Duplicate request | Repeat request ID and canonical input | Cached original response | No second logical mutation |
| Request-ID conflict | Repeat request ID with changed input | Non-retryable protocol error | No second logical mutation |
| Timeout before apply | `mode: timeout` | Transport deadline with no outcome claim | None |
| Timeout after apply | Timeout with `applyBeforeResponse: true` | Transport deadline; retry returns cached accepted result | Applied once |
| Unknown before apply | `mode: unknown-outcome` | `UNKNOWN` and evidence ID | None |
| Unknown after apply | Unknown outcome with `applyBeforeResponse: true` | `UNKNOWN`; observation can prove the resource | Applied once |

The fake is test-only and does not model real-provider capacity or performance. A production adapter must pass the same semantic conformance cases and add provider-specific integration tests.

## Reproduction

```bash
pnpm run contracts:generate
pnpm run contracts:validate
pnpm run contracts:docs
pnpm nx run testing:test
```

The complete decision rationale is in [ADR-0010](../adr/0010-versioned-contracts-and-compatibility.md) and [ADR-0011](../adr/0011-provider-port-and-deterministic-fake.md).
