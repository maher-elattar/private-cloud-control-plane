# ADR-0001: Keep the Control Plane Provider-Neutral

- Status: Accepted
- Date: 2026-08-24
- Decision owners: Control-plane maintainers
- Requirements: `SRS-FR-007` through `SRS-FR-013`, `SRS-FR-024`, `SRS-FR-069` through `SRS-FR-074`, `SRS-NFR-027`, `SRS-ARC-005`

## Context

The MVP provisions a Proxmox lab, but the product boundary is a private-cloud control plane rather than a Proxmox API facade. Allowing provider identifiers, task formats, or client-library types into the domain would couple the catalog, public API, workflow, tests, and future providers to one implementation.

Provider-neutrality must not produce a lowest-common-denominator interface or hide operationally important behavior. Long-running tasks, unknown outcomes, observed state, ownership evidence, and provider-specific diagnostics still need explicit representation.

## Decision

The public REST API, domain package, event contracts, orchestration workflows, and reconciliation logic use provider-neutral identifiers and types.

The Proxmox Provider is the only Kubernetes deployable that imports a Proxmox client or constructs Proxmox requests. It implements a versioned internal gRPC provider contract that exposes bounded capabilities:

- Validate provider profile and discover permitted inventory
- Create and configure an instance
- Read a submitted task and observe an instance
- Apply power operations
- Grow compute or disk within domain limits
- Create, list, roll back, and delete instance-owned snapshots
- Mark an instance retained and perform a separately authorized purge

The contract represents an accepted provider task with a stable provider reference. It classifies outcomes as success, safe transient failure, permanent failure, or unknown. Provider-native diagnostic detail remains access-controlled inside the adapter; callers receive a stable domain error category and bounded message.

Provider profiles and catalog mappings translate provider-neutral image, flavor, and network selections into allowlisted endpoint, node, template, storage, bridge, VMID, and network configuration. Callers cannot supply those provider values.

The provider contract includes capability discovery or configuration-time validation so unsupported operations fail before workflow execution. Provider-specific extensions require a separate versioned extension contract and cannot leak into the core aggregate.

## Consequences

### Positive

- Domain and contract tests run without a Proxmox installation or client library.
- A fake provider can exercise scale, failure, timeout, and recovery behavior deterministically.
- A later provider can implement the same capability and outcome model without changing tenant contracts.
- Security review has one narrow boundary that holds provider credentials and management-network access.

### Negative

- Translation and error normalization add code and contract tests.
- Provider features outside the common product scope cannot be exposed ad hoc.
- Provider task semantics must be modeled carefully instead of passed through as opaque API responses.

## Rejected Alternatives

### Expose Proxmox API fields through the public API

Rejected because it makes catalog, workflow, and tenant contracts provider-specific and permits unsafe caller control of placement details.

### Put Proxmox calls directly in the Orchestrator

Rejected because the workflow would hold both domain coordination and provider credentials, increasing coupling and compromise impact.

### Create a generic key-value provider request

Rejected because untyped provider parameters evade validation, compatibility checks, and the server-side allowlist.

## Verification

- Dependency rules fail CI if domain or public contract packages import Proxmox types.
- Provider contract tests run against both the fake and Proxmox adapters.
- Public contract fixtures contain no node, storage, bridge, VMID, endpoint, or provider credential field.
- Unknown-outcome and ownership-marker behavior is tested at the provider boundary.
