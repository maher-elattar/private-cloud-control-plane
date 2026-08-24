# ADR-0006: Use Explicit Provider Placement for the MVP

- Status: Accepted
- Date: 2026-08-24
- Decision owners: Control-plane maintainers
- Requirements: `SRS-FR-007` through `SRS-FR-013`, `SRS-FR-024` through `SRS-FR-031`, `SRS-NFR-016`, `SRS-ARC-005`

## Context

Automated placement across nodes, clusters, storage pools, networks, and capacity failure domains is a separate scheduling product. A credible placement engine needs current inventory, reservations, admission, scoring, anti-affinity, maintenance state, race handling, and an explainable override model.

The MVP has one approved Proxmox lab target. Building a shallow scoring algorithm would increase destructive and capacity risk without improving the distributed-systems, reliability, or observability outcomes this control plane is intended to demonstrate.

## Decision

Placement is explicit and server-controlled.

An enabled provider profile maps a provider-neutral catalog selection to exactly one approved cluster and, for the MVP, one node, template, storage target, bridge, VMID range, and IPv4 pool. Image, flavor, and network records select the profile and bounded resource values. No caller can submit or override provider placement identifiers.

The profile has no permissive defaults. It remains mutation-disabled until the lab activation gate verifies endpoint identity, certificate trust, credential scope, inventory existence, full-clone support, storage and bridge suitability, non-overlapping network, free or owned VMID range, and fake-provider safety tests.

Placement admission checks quotas and known allocation conflicts before command acceptance. The workflow rechecks live collisions and relevant provider availability immediately before mutation. A changed or ambiguous target fails closed; it does not fall back to another node or storage automatically.

Adding a second placement target requires a new provider profile and an explicit catalog mapping. Automated selection, scoring, balancing, affinity, and migration remain outside the MVP.

## Consequences

### Positive

- Every provider mutation has an explainable, reviewable destination.
- Safety tests can prove exact endpoint, node, template, storage, bridge, VMID, and network bounds.
- Capacity scheduling does not distract from asynchronous workflow and failure semantics.
- A future scheduler has a clear placement decision interface to replace, not scattered heuristics.

### Negative

- The control plane does not balance workload or survive target capacity exhaustion automatically.
- Operators must maintain catalog-to-profile mappings.
- Multi-cluster placement requires future design and migration work.

## Rejected Alternatives

### Score nodes by current CPU and memory

Rejected because instantaneous utilization is not reserved capacity and omits storage, network, failure-domain, maintenance, and concurrent-decision correctness.

### Let Proxmox select a target implicitly

Rejected because destination and safety bounds would be less explicit and harder to audit.

### Allow tenants to choose provider nodes and storage

Rejected because it exposes provider internals and bypasses server-side policy.

## Verification

- Activation fails for every missing, ambiguous, mismatched, or colliding allowlist value.
- Contract tests prove provider placement fields are absent from tenant requests.
- Dry-run evidence resolves exactly one destination for the lab catalog selection.
- A provider inventory change between acceptance and execution fails closed before mutation.
