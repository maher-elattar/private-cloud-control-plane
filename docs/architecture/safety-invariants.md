# Safety Invariants

These rules are mandatory across REST, gRPC, Kafka consumers, reconciliation, administrative tooling, provider adapters, tests, and the AWS reference slice. A feature is incomplete until its tests prove the applicable invariants.

## Ownership and Scope

| ID | Invariant |
| --- | --- |
| SAFE-001 | Every mutation is authorized against a project before desired state changes or provider calls occur. |
| SAFE-002 | A provider mutation is allowed only through an enabled provider profile whose cluster, node, image, storage, bridge, and VMID constraints all match. |
| SAFE-003 | Provider profiles have no permissive defaults. Missing allowlist values keep mutation disabled. |
| SAFE-004 | Every managed provider resource carries the control-plane ownership marker, project ID, and instance ID. |
| SAFE-005 | Adoption never infers ownership from VMID, name, IP address, or node alone. |
| SAFE-006 | Administrative purge requires both database ownership and matching live provider ownership markers. |
| SAFE-007 | Tests never mutate resources outside the dedicated lab project and VMID range. |

## Command and Concurrency

| ID | Invariant |
| --- | --- |
| SAFE-008 | Every mutation requires an idempotency key scoped to project, operation type, and target aggregate. |
| SAFE-009 | Reusing an idempotency key with a different canonical request is rejected. |
| SAFE-010 | At most one mutating workflow holds the lease for an instance at a time. |
| SAFE-011 | The instance change, operation record, and outbox event commit in one database transaction. |
| SAFE-012 | Kafka delivery is treated as at-least-once; each consumer stores an inbox receipt before declaring completion. |
| SAFE-013 | Kafka partition keys preserve ordering for commands affecting the same instance. |
| SAFE-014 | A provider task reference is persisted before the workflow begins polling it. |
| SAFE-015 | Worker restart resumes a persisted provider task instead of submitting a second task. |

## Provider Outcomes and Recovery

| ID | Invariant |
| --- | --- |
| SAFE-016 | Validation and quota failures occur before provider mutation. |
| SAFE-017 | Retry policy distinguishes safe transient failures, permanent failures, and unknown outcomes. |
| SAFE-018 | An unknown provider outcome is not blindly retried. It enters reconciliation or manual review. |
| SAFE-019 | Compensation deletes only a resource proven to have been created by the current failed workflow. |
| SAFE-020 | Compensation failure never replaces the original operation failure; both outcomes remain observable. |
| SAFE-021 | Provider task timeout means the result is unknown until observed state proves success or failure. |
| SAFE-022 | Provider-specific errors are translated into stable domain error categories. |

## Resource Safety

| ID | Invariant |
| --- | --- |
| SAFE-023 | An IPv4 address has at most one active lease; allocation and release are transactional. |
| SAFE-024 | Gateways, network addresses, broadcast addresses, and addresses outside the project network are never leased. |
| SAFE-025 | IP availability is rechecked immediately before the provider network mutation. |
| SAFE-026 | Disk size can grow but never shrink. |
| SAFE-027 | Images, nodes, storage, and bridges are selected from server-side catalog and provider-profile data, never trusted from caller-supplied provider identifiers. |
| SAFE-028 | Normal delete is soft delete: it detaches access and retains the provider resource for review. |
| SAFE-029 | Reconciliation reports destructive drift but does not automatically destroy, shrink, detach, or overwrite a provider resource. |
| SAFE-030 | Live-provider load tests have a small explicit operation cap; high concurrency uses the fake provider. |

## Secrets and Observability

| ID | Invariant |
| --- | --- |
| SAFE-031 | Credentials, cloud-init secrets, authorization headers, console tickets, and provider session material never enter events, logs, traces, metrics, or API responses. |
| SAFE-032 | Customer-safe errors are bounded and redacted; detailed diagnostics remain access-controlled. |
| SAFE-033 | Every command carries operation, correlation, causation, project, and trace context through asynchronous boundaries. |
| SAFE-034 | Metrics use bounded labels. Project IDs, instance IDs, operation IDs, task IDs, IPs, and exception messages are not metric labels. |
| SAFE-035 | AWS workloads and CI use short-lived identities; static AWS access keys are prohibited. |
| SAFE-036 | Secret values never enter either application or GitOps history. Only names, references, and setup instructions are committed. |

## Required Verification Pattern

Every mutating capability must document and test:

1. Authorization and ownership checks
2. Idempotent first delivery and duplicate delivery
3. Instance-lock behavior
4. Provider timeout and unknown outcome
5. Worker termination and checkpoint resume
6. Safe compensation or explicit manual recovery
7. Redacted logs with trace and operation correlation
8. Non-destructive reconciliation behavior
