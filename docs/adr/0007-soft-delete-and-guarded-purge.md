# ADR-0007: Make Normal Deletion Soft and Purge Guarded

- Status: Accepted
- Date: 2026-08-24
- Decision owners: Control-plane maintainers
- Requirements: `SRS-FR-051` through `SRS-FR-056`, `SRS-NFR-019`, `SRS-ARC-006`, `SAFE-006`, `SAFE-028`

## Context

Deleting a virtual machine is irreversible and control-plane state can be stale, duplicated, or temporarily inconsistent with provider state. A tenant-facing delete operation must not turn an authorization bug, copied identifier, delayed event, or ambiguous provider response into immediate data loss.

The lab still needs a way to reclaim resources. Permanent retention would hide lifecycle and recovery responsibilities rather than solve them.

## Decision

Normal deletion is a soft-delete workflow. It transitions the instance to `RETAINED`, revokes tenant mutation access, disables automatic start where supported, applies retained provider metadata, and records a retention deadline. It does not destroy the provider VM.

IPv4 handling is stage-aware: a lease may be released only when the workflow has proven that doing so will not create conflicting ownership for a still-accessible VM. Otherwise it is quarantined for administrator review. Instance identity, operations, provider references, observations, audit, and ownership evidence remain retained.

Permanent deletion is a distinct administrative `PURGE` operation. Immediately before calling the provider, purge must prove all of the following:

- Authenticated administrator with a recorded reason
- Database instance and provider identity match
- Complete live ownership-marker set matches environment, project, instance, and creation operation
- VMID is inside the enabled provider profile's allowed range
- Retention deadline has passed
- No active instance workflow or unresolved unknown outcome exists
- Current provider observation identifies exactly one target

Any missing, stale, or conflicting proof prevents deletion and creates manual review. A successful provider deletion is observed before the lifecycle reaches `PURGED`. Purge evidence and audit history remain after resource removal.

The default lab retention window is 24 hours and is a reviewed environment policy, not caller input.

## Consequences

### Positive

- Common tenant mistakes and asynchronous inconsistencies do not immediately destroy data.
- Ownership and retention checks produce strong failure-injection and audit evidence.
- Recovery and purge are separately authorized and observable workflows.

### Negative

- Soft-deleted VMs continue consuming provider capacity during retention.
- IP release and quarantine rules add lifecycle states and operational review.
- Administrators need a purge queue, alert, and runbook.

## Rejected Alternatives

### Delete the provider VM on a tenant delete request

Rejected because provider mutation is irreversible and the request path cannot prove live ownership and exclusivity safely enough.

### Never purge automatically or manually

Rejected because the lab needs bounded capacity and a complete resource lifecycle.

### Purge based only on the database provider reference

Rejected because database state alone cannot prove the current live resource is the originally created VM.

## Verification

- Tenant delete never invokes the provider delete method.
- Purge tests independently fail every precondition and assert zero destructive calls.
- Copied, missing, partial, and conflicting provider markers always enter manual review.
- Successful purge retains operation and audit evidence while the provider absence is observed.
