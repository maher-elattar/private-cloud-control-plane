# ADR-0010: Version External Contracts and Generate Language Types

- Status: Accepted
- Date: 2026-08-25
- Decision owners: Control-plane maintainers
- Requirements: `SRS-FR-014`, `SRS-FR-018` through `SRS-FR-023`, `SRS-FR-057` through `SRS-FR-059`, `SRS-FR-066`, `SRS-FR-067`, `SRS-NFR-011`, `SRS-NFR-017`, `SRS-NFR-018`, `SRS-NFR-027` through `SRS-NFR-031`

## Context

The control plane exposes REST and gRPC while four deployables communicate through Kafka and a provider gRPC port. Handwritten TypeScript shapes would permit each representation to drift, hide size or compatibility assumptions, and make provider-specific fields easy to leak into tenant APIs.

## Decision

OpenAPI 3.1 is authoritative for REST, protobuf is authoritative for public and provider gRPC, and AsyncAPI 3.1 plus JSON Schema 2020-12 is authoritative for Kafka messages. Generated TypeScript is committed so consumers can compile without generator tooling and CI can detect stale output.

All mutation operations require a stable idempotency identity. REST failures use RFC 9457 problem details and stable machine-readable codes; gRPC uses canonical status codes plus safe provider failure details. REST request bodies are limited to 65,536 bytes and Kafka messages to 262,144 encoded bytes.

Kafka topics and schema names carry a major version. Within `v1`, producers may add optional fields and consumers must tolerate them. Removing a field, changing its meaning or type, changing a partition key, making an optional field required, or changing an enum without a fallback requires a new major version. Unsupported major versions are rejected rather than guessed.

All contracts carry requirement links and document audience, authentication, idempotency, deadlines, stable errors, payload limits, classification, and telemetry handling. Generation and validation are deterministic repository quality gates.

## Consequences

### Positive

- Wire behavior is reviewable before service implementation.
- A second provider can compile against the provider port without importing vendor types.
- Contract and field tables are generated from source and cannot silently diverge.
- Sensitive fields have an explicit telemetry policy at the contract boundary.

### Negative

- Generated files add repository volume.
- Contract changes require generation, compatibility review, and documentation updates.
- JSON Schema and protobuf represent optionality differently, so semantic parity remains a reviewed obligation.

## Rejected Alternatives

### Handwrite TypeScript DTOs and document them later

Rejected because documentation and runtime types would have independent sources of truth.

### Use one schema language for every transport

Rejected because it would weaken native REST, gRPC, or Kafka tooling and hide transport-specific behavior such as gRPC deadlines and Kafka partitioning.

### Claim exactly-once delivery through the event contract

Rejected because Kafka redelivery remains possible; correctness comes from event identity, inbox receipts, and idempotent state transitions.

## Verification

- `pnpm run contracts:generate` reproduces committed TypeScript.
- `pnpm run contracts:validate` lints all three contract families and enforces cross-contract invariants.
- `pnpm run contracts:docs` reproduces endpoint, RPC, event, error, and field tables.
- CI fails when generated contract artifacts or generated tables differ from the committed output.
