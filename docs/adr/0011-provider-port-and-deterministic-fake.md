# ADR-0011: Isolate Providers Behind a Deterministic Lifecycle Port

- Status: Accepted
- Date: 2026-08-25
- Decision owners: Control-plane maintainers
- Requirements: `SRS-FR-008`, `SRS-FR-011`, `SRS-FR-013`, `SRS-FR-029`, `SRS-FR-032` through `SRS-FR-036`, `SRS-FR-039`, `SRS-FR-041` through `SRS-FR-055`, `SRS-FR-069` through `SRS-FR-074`, `SRS-NFR-003` through `SRS-NFR-007`, `SRS-NFR-012`, `SRS-NFR-027`, `SRS-NFR-038`, `SRS-ARC-004`, `SRS-ARC-005`

## Context

Provider mutations are asynchronous and can succeed even when a client observes a timeout. Directly exposing vendor resources, task formats, or error payloads would couple orchestration and public contracts to the first adapter. Testing these failure cases against a live hypervisor would be slow, unsafe, and non-deterministic.

## Decision

All provider adapters implement the `ProviderPort` defined by the provider-neutral protobuf and TypeScript SDK. Requests carry stable request, operation, project, instance, correlation, profile, and ownership identities. Mutations return normalized `ACCEPTED`, `SUCCEEDED`, `REJECTED`, or `UNKNOWN` results; transport errors never assert that a mutation failed.

The test-only fake provider implements the entire port in memory. A scripted call may inject deterministic latency, a classified rejection, a timeout before apply, a timeout after apply, or an unknown outcome with optional application. Repeating the same request ID and canonical input returns the cached result without a second logical mutation. Reusing the request ID with changed input is a non-retryable protocol error.

The fake enforces ownership markers, disk-growth-only resize, task polling, snapshot ownership, and purge authorization inputs. Its clock and sleeper are injectable so tests do not depend on wall-clock timing.

## Consequences

### Positive

- Orchestration can be completed and failure-tested before any Proxmox call exists.
- Unknown outcomes and duplicate delivery become normal contract cases rather than exceptional test setup.
- The Proxmox adapter is an anti-corruption layer with a measurable conformance target.
- Load tests can exercise control-plane behavior without risking live infrastructure.

### Negative

- The fake models contract semantics, not provider capacity, task scheduling, or performance.
- Each real adapter still requires integration tests for translation and provider-specific failure classification.
- Adapter implementations must preserve request identity beyond transient process memory.

## Rejected Alternatives

### Mock individual Proxmox HTTP calls in orchestrator tests

Rejected because vendor details would leak across the port and tests would validate request mechanics instead of control-plane semantics.

### Retry every timed-out provider mutation

Rejected because a lost response can follow a committed provider mutation and create a duplicate resource.

### Use a random failure injector

Rejected because non-reproducible scenarios make CI and resilience evidence unreliable.

## Verification

- The provider SDK and fake compile without any Proxmox package or vendor type.
- The conformance suite covers accepted tasks, observations, duplicate delivery, identity conflict, latency, rejection, both timeout positions, and applied unknown outcomes.
- A provider-specific implementation can be substituted anywhere a `ProviderPort` is accepted.
