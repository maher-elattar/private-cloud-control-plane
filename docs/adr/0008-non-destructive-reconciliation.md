# ADR-0008: Keep Automatic Reconciliation Non-Destructive

- Status: Accepted
- Date: 2026-08-24
- Decision owners: Control-plane maintainers
- Requirements: `SRS-FR-069` through `SRS-FR-074`, `SRS-NFR-037`, `SRS-ARC-007`, `SAFE-029`

## Context

Provider state can diverge from desired state because of manual changes, incomplete operations, delayed tasks, credential outages, or control-plane defects. Reconciliation is necessary to discover late success and expose drift. Automatically forcing every difference back to desired state could delete, shrink, detach, overwrite, or adopt a resource when ownership or intent is uncertain.

The MVP's priority is visible and recoverable behavior under failure, not autonomous repair of every infrastructure difference.

## Decision

The Reconciler is read-oriented and non-destructive by default. It periodically or explicitly observes resources through the provider-neutral read interface and records:

- Provider existence and immutable ownership markers
- Power, CPU, memory, disk, network, and snapshot observations in supported scope
- Provider task state for incomplete or unknown operations
- Missing, identity mismatch, stale task, late success, power drift, network drift, and ambiguous state classifications
- Observation time, evidence identity, and any manual-review item

Reconciliation updates observed state and drift records only. It never overwrites desired state and cannot call provider delete, shrink, detach, overwrite, or adoption methods.

The Reconciler may resolve an unknown operation as successful only when current observation proves the intended result and full ownership identity. It may classify a proven failure, but ambiguous outcomes remain in manual review.

Safe corrective behavior is initiated as a new authorized, idempotent, audited command through the Control API and Orchestrator. Adding any automatic mutation requires a superseding ADR with operation-specific proof, rollback, rate limiting, and failure tests.

## Consequences

### Positive

- A read-path defect or stale observation cannot directly destroy provider resources.
- Desired and observed state remain independently inspectable.
- Late success and unknown outcomes have a controlled resolution mechanism.
- Operators receive explicit drift evidence rather than hidden corrective action.

### Negative

- Some drift persists until an operator approves a corrective command.
- Manual-review queues and runbooks become part of normal operations.
- The platform demonstrates detection and recovery more strongly than self-healing breadth.

## Rejected Alternatives

### Continuously force all provider state to desired state

Rejected because ownership ambiguity, stale observations, and irreversible provider actions make a generic convergence loop unsafe.

### Update desired state to match every observed manual change

Rejected because it silently converts out-of-band mutation into authorized tenant intent and destroys the audit distinction.

### Disable reconciliation

Rejected because unknown provider outcomes, late success, missing resources, and operational drift would remain invisible.

## Verification

- The Reconciler's provider client interface contains read methods only.
- Drift fixtures never produce a destructive provider call.
- Late-success resolution requires complete ownership and intended-state evidence.
- Ambiguous, missing-marker, and identity-mismatch cases create operator-visible review items with correlated traces and audit events.
