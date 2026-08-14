# Capability Assessment

## Purpose

This assessment treats the two prior systems as behavioral evidence. It does not preserve their framework, database, user-interface, or commercial abstractions. Each capability records the observable contract, durable state, external effects, failure handling, test evidence, and its disposition in the new control plane.

## Disposition

| Value | Meaning |
| --- | --- |
| `core` | Required for the MVP evidence set |
| `stretch` | Valuable only after every core completion gate passes |
| `reference` | Reuse the invariant or test idea, not the feature or implementation |
| `removed` | Deliberately excluded |

## Evidence Key

| Key | Authored evidence |
| --- | --- |
| `PV-ENTRY` | `proxmox-vps/modules/servers/proxmoxvemosalam/proxmoxvemosalam.php` |
| `PV-PROV` | `proxmox-vps/modules/servers/proxmoxvemosalam/lib/Provisioner.php` |
| `PV-IP` | `proxmox-vps/modules/servers/proxmoxvemosalam/lib/IpPool.php`, `IpPoolConfig.php`, `ServiceRepository.php` |
| `PV-QUEUE` | `proxmox-vps/modules/servers/proxmoxvemosalam/lib/TaskQueue.php`, `TaskReporter.php`, `worker.php` |
| `PV-PROVIDER` | `proxmox-vps/modules/servers/proxmoxvemosalam/lib/ProxmoxClient.php` |
| `PV-SAFETY` | `BillingPolicy.php`, `ConsoleAccess.php`, `OutputSanitizer.php`, cleanup hooks |
| `PV-PLACE` | `PlacementPlanner.php`, `PlacementRules.php`, `PlacementScorer.php` |
| `PV-TEST` | `proxmox-vps/tests/Unit`, `tests/Integration`, and `tests/e2e` |
| `INV-AGENT` | `proxmox-whmcs-cluster-ip-pool-manager/apps/agent/src` |
| `INV-INGEST` | `apps/api/src/agent`, `apps/api/src/database/inventory.service.ts` |
| `INV-IP` | `apps/api/src/manual`, `apps/api/src/dashboard`, `packages/shared/src` |
| `INV-AUTH` | `apps/api/src/auth`, `apps/api/src/finance`, `apps/web/src` |
| `INV-TEST` | `apps/agent/test`, `apps/api/test`, `apps/web/test`, `packages/shared/test` |

## Source Capability Matrix

| ID | Capability | Input and output | Persisted state | Provider or external effects | Failure and recovery behavior | Evidence and tests | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SRC-001 | Pending service registration | Service and product settings in; pending record out | Service row with node, network, storage, state | None | Idempotent first-or-create | `PV-ENTRY`; provisioning flow tests | `reference`: replace with project-scoped instance aggregate |
| SRC-002 | Full-clone VM creation | Template, CPU, RAM, disk, network, credentials in; VM and task references out | VMID, template, resources, IP, state, provider task IDs | Next-ID read, clone, config, disk grow, start | Validate before mutation; cleanup VM and newly created IP lease after partial failure | `PV-PROV`; provisioning integration tests | `core`: provider-neutral create workflow |
| SRC-003 | Image-template catalog | Human label and template ID in; approved selection out | Product template map | Template config reads | Unknown or missing mapping rejects before clone | `PV-ENTRY`, `PV-PROV`; module-config tests | `core`: image catalog with allowlisted provider mapping |
| SRC-004 | Resource entitlements | Product limits and active add-ons in; effective CPU/RAM limits out | Product/add-on configuration | None | Reject ambiguous mapping and over-limit input | `ResourceEntitlements.php`; entitlement tests | `reference`: use flavors and project quotas; remove commercial add-ons |
| SRC-005 | Weighted node placement | Requested resources and node telemetry in; selected node out | Placement configuration | Node, network, template, storage, and status reads | Reject nodes that fail thresholds; return generic capacity error | `PV-PLACE`; placement rule and integration tests | `removed`: explicit provider profile placement only |
| SRC-006 | Multi-CIDR pool parsing | CIDR definitions in; normalized non-overlapping pools out | Product IP-pool configuration | None | Reject malformed and overlapping ranges | `PV-IP`; IP-pool config tests | `reference`: network validation rules |
| SRC-007 | IPv4 availability | Pool, gateway, leases, and live VM config in; available IPs out | Allocation rows with unique IP | Read VM configs across allowed nodes | Exclude gateways, allocations, and live collisions | `PV-IP`; multi-CIDR availability tests | `core`: one atomic IPv4 lease per instance |
| SRC-008 | Race-safe IP reservation | Service and selected IP in; lease result out | Unique allocation row | None | Unique constraint rejects concurrent ownership; same owner can reuse | `ServiceRepository.php`; collision tests | `core` |
| SRC-009 | Late collision recheck | Reserved IP and cloned VM in; acceptance or failure out | Existing lease and operation state | Re-read VM configs before cloud-init write | Cleanup new VM; release only a newly created lease | `PV-PROV`; forged-IP and cluster-scan tests | `core` |
| SRC-010 | Instance status and config | Instance reference in; provider status/config out | Last-known instance data | VM status and config reads | Missing or ambiguous location stops mutation | `PV-PROV`; migration-flow tests | `core` |
| SRC-011 | Provider performance charts | Instance and time window in; RRD values out | None | RRD and guest-agent reads | Partial chart failure remains non-fatal | `PV-PROV`; renderer coverage | `removed`: platform telemetry replaces provider RRD dashboard |
| SRC-012 | Power actions | Instance and start/stop/shutdown/reboot in; completed operation out | Task and last-error state | Provider power endpoint and task polling | Per-instance lock; safe error persistence | `PV-PROV`; migration and lifecycle tests | `core` |
| SRC-013 | Suspend and resume | Instance and administrative state in; updated state out | Service state and task history | Suspend, resume, or start | No-op when already in target state | `PV-PROV`; lifecycle callbacks | `removed`: not a separate product lifecycle in MVP |
| SRC-014 | CPU and memory resize | Requested sizes in; updated resources out | Service resource values and task history | VM config mutation | Limits revalidated in worker; per-instance lock | `PV-PROV`, `PV-QUEUE`; resize tests | `core` |
| SRC-015 | Disk growth | Requested size in; grown disk out | Disk size and task history | Primary-disk lookup and resize | Disk shrink rejected before queue or mutation | `PV-PROV`; resize tests | `core` |
| SRC-016 | Snapshot lifecycle | Instance and snapshot identity in; snapshot/result out | Task history | Create, list, rollback, delete | Validate names; stop before rollback when required; lock instance | `PV-PROV`; lifecycle documentation and fake provider routes | `core` |
| SRC-017 | Backup lifecycle | Instance or backup volume in; progress/result out | Durable queue, task progress, logs | Backup create/list/restore/delete | Validate volume belongs to VM; stop before restore; long timeout | `PV-PROV`, `PV-QUEUE`; queue tests | `stretch` |
| SRC-018 | Adopt existing VM | Node, VMID, and IP in; attached instance out | Service and IP ownership | Cluster scan, config, status, guest IP reads | Reject duplicate ownership, ambiguous IP, and non-project IP | `PV-PROV`; import tests | `stretch` |
| SRC-019 | Location detection and repair | Stored node and VMID in; one live node or drift result out | Corrected node reference | Cluster node and VM list reads | Missing or multiple matches stop mutation | `PV-PROV`; migration-flow tests | `reference`: desired/observed drift classification |
| SRC-020 | Live migration | Instance and target node in; moved instance out | Updated node and task history | Target validation and migrate task | Reject current, missing, offline, or incompatible node | `PV-PROV`, `PV-QUEUE`; migration tests | `removed` |
| SRC-021 | Browser console | Running instance in; restricted console session out | Per-user encrypted console credential | Provider role, user, ACL, login, and native console | Limit permissions; revoke ACL on detach | `ConsoleAccess.php`, `PV-PROV`; console tests | `stretch`: use short-lived session design, not stored user passwords |
| SRC-022 | Durable long-operation queue | Action and payload in; queued ID and progress out | Queue rows, logs, progress, timestamps | Worker invokes provider actions | One running task per service; stale worker marked failed | `PV-QUEUE`; queue-flow tests | `reference`: replace process spawning with Kafka and checkpoints |
| SRC-023 | Provider task tracking | Provider task ID in; progress and final status out | Task records, logs, exit state | Provider task status and log polling | Timeout becomes explicit failure | `PV-QUEUE`, `PV-PROVIDER`; fake provider tests | `core` |
| SRC-024 | Per-instance concurrency lock | Instance and operation in; exclusive lease out | Lock expiry on service row | None | Reject overlapping actions; unlock in finally block | `ServiceRepository.php`; queue and lifecycle tests | `core` |
| SRC-025 | Failed-create compensation | Partially created VM and lease in; cleanup result out | Failed state and original error | Stop and destroy only newly created VM | Cleanup is best effort; original failure remains authoritative | `PV-PROV`; provisioning tests | `core` with unknown-outcome guard |
| SRC-026 | Soft termination | Instance in; retained detached resource out | Terminated state and released IP | Remove guest IP, disable on-boot, pause, revoke console access | Does not destroy normal resources | `PV-PROV`; lifecycle tests | `core`: soft delete with retention |
| SRC-027 | Remove and rebuild | Instance in; pending state with retained old VM out | VM fields cleared; IP retained | Stop VM, clear provider network, revoke console access | Old resource kept for manual deletion | `PV-PROV`; lifecycle tests | `removed`: overlaps soft delete and new create semantics |
| SRC-028 | Billing automation policy | Billing state in; auto-suspend override out | Billing fields | None | Handles legacy database zero-date behavior | `BillingPolicy.php`; billing tests | `removed` |
| SRC-029 | Hosting checkout and admin hooks | Form state in; adjusted hosting UI out | Product supplemental settings | Browser-side form behavior | CSRF checks and isolated cleanup | Hook files; unit and browser tests | `removed` |
| SRC-030 | Module-row cleanup | Deleted customer/service in; owned rows removed | Module tables | No provider calls | Idempotent and tolerant of missing tables | Cleanup hook; cleanup tests | `reference`: ownership-scoped retention and purge |
| SRC-031 | Customer-safe error redaction | Raw provider error in; bounded redacted text out | Sanitized logs/errors | None | Removes credentials, tickets, raw task identifiers | `OutputSanitizer.php`; sanitizer and browser tests | `core` |
| SRC-032 | Provider HTTP client | Method, path, and payload in; decoded response out | Auth ticket in memory | Provider authentication and API requests | Bounded timeout; error translation; task polling | `PV-PROVIDER`; fake router integration tests | `core`: isolate inside provider adapter |
| SRC-033 | Network and cloud-init configuration | Bridge, MTU, IP, DNS, user, password, keys in; configured VM out | Applied network/resource state | Preserve and update `net0`; write cloud-init | Reject missing NIC, invalid user/key, or unsafe IP | `PV-PROV`; initialization tests | `core`, simplified to one NIC and IPv4 |
| SRC-034 | Read-only node inventory | Node identity in; bridge, QEMU, LXC, status, and IP snapshot out | None locally before enqueue | Strictly allowlisted read-only host commands | Optional inspection errors retained without losing static facts | `INV-AGENT`; parser, command, and snapshot tests | `stretch`, QEMU only if implemented |
| SRC-035 | Full and partial inventory scans | Timer or affected IDs in; full/partial snapshot out | Pending affected set | Read-only commands with bounded concurrency | Full scan repairs missed events; partial scan debounces bursts | `INV-AGENT`; agent tests | `reference`: reconciler cadence and bounded reads |
| SRC-036 | Local durable callback outbox | Snapshot bytes in; delivered callback out | SQLite payload, idempotency key, attempts, next retry | Signed HTTP callback | Exponential backoff capped at 30 minutes; survives restart | `INV-AGENT`; queue and client tests | `reference`: durability and exact-byte retry semantics |
| SRC-037 | Signed agent ingestion | Raw body and headers in; authenticated context out | None before validation | HMAC verification | Reject missing headers, stale timestamps, altered bytes | `INV-INGEST`; signing and ingestion tests | `reference`: optional inventory-agent trust boundary |
| SRC-038 | Idempotent snapshot receipt | Snapshot and idempotency key in; processed/duplicate out | Event receipt, payload hash, status | None | Same key/different body conflicts; failed same-body delivery can retry | `INV-INGEST`; ingestion tests | `core` pattern for Kafka inbox receipts |
| SRC-039 | Inventory projection rebuild | Authoritative pools and observations in; pool projection out | Nodes, resources, assignments, pool read model | None | Deterministic bulk rebuild; observations cannot create authority | `INV-INGEST`, `INV-IP`; inventory tests | `reference`: desired/observed projections |
| SRC-040 | Conflict and stale detection | Assignments and heartbeats in; classified rows out | Derived read model | None | Conflict takes precedence; stale data remains visible | `INV-IP`; dashboard rule tests | `core`: drift and stale-operation signals |
| SRC-041 | Range-based free capacity | CIDR and reservations in; exact count and compressed ranges out | None | None | Avoids expanding large CIDRs; reserves gateways | Shared IPv4/range code; CIDR tests | `reference`: IPv4 lease math |
| SRC-042 | Manual reservation write-through | IP, owner, and resource in; reservation out | External allocation plus local mirror | External SQL write | Compensating external delete if mirror write fails | `INV-IP`; manual-service tests | `removed`: single PostgreSQL owner eliminates dual-write |
| SRC-043 | Session authentication and roles | Credentials/token in; admin, finance, or read-only session out | Users and token claims | None | Generic auth failures and expiry | `INV-AUTH`; auth tests | `reference`: use established identity integration later; no custom identity platform |
| SRC-044 | Inventory web dashboard | Filters and mutations in; pool and finance views out | Browser cache only | REST API | Handles empty, error, stale, and read-only states | `apps/web`; browser tests | `stretch`: minimal read-only UI only |
| SRC-045 | Commercial database synchronization | Hosting database rows in; reservations/customers/products out | Cached projections and sync state | MySQL reads and writes | Retains last error; periodic retry | `apps/api/src/whmcs`; mapper/service tests | `removed` |
| SRC-046 | Finance and margin reporting | Revenue, payments, and costs in; margins out | Finance settings and overrides | Commercial database reads | Role-restricted settings and normalized currency | `apps/api/src/finance`; finance tests | `removed` |
| SRC-047 | API description artifacts | Controllers and schemas in; OpenAPI/Postman output out | Generated/static documents | None | Contract tests catch drift | OpenAPI sources and API docs | `core`: OpenAPI plus protobuf and AsyncAPI |
| SRC-048 | Container and pipeline delivery | Source revision in; tested images and deployment out | Image tags and runtime files | Registry and remote host deployment | Lint, test, build, health check, rollback guidance | CI workflows and deployment docs | `reference`: replace with immutable images and GitOps promotion |

## New Platform Capabilities

| ID | Capability | Origin | Decision |
| --- | --- | --- | --- |
| NEW-001 | Project-scoped domain and authorization | Product need: replace commercial account ownership | `core` |
| NEW-002 | Provider-neutral REST and gRPC contracts | Architecture decision: keep Proxmox behind an adapter | `core` |
| NEW-003 | Versioned Kafka command, event, audit, and dead-letter contracts | Reliability need: asynchronous workflows and replay | `core` |
| NEW-004 | PostgreSQL desired state, operation journal, idempotency, outbox, and inbox | Reliability need: one transactional source of truth | `core` |
| NEW-005 | Debezium outbox publication | Architecture decision: avoid application dual-write | `core` |
| NEW-006 | Persisted orchestration checkpoints and retry classification | Derived from `SRC-022`, `SRC-023`, and unknown provider outcomes | `core` |
| NEW-007 | Desired-versus-observed reconciler | Derived from `SRC-019`, `SRC-035`, `SRC-039`, and `SRC-040` | `core` |
| NEW-008 | OpenTelemetry propagation across HTTP, gRPC, database, outbox, Kafka, and provider calls | Portfolio and operability need | `core` |
| NEW-009 | Prometheus, Tempo, Loki, and Grafana evidence | Operability need | `core` |
| NEW-010 | Kafka-lag autoscaling with KEDA and provider concurrency protection | Backpressure need | `core` |
| NEW-011 | GitOps promotion by immutable image digest | Delivery and ownership need | `core` |
| NEW-012 | Deterministic failure-injectable fake provider | Safe load and recovery validation need | `core` |
| NEW-013 | DynamoDB transactional command store and stream outbox | AWS architecture evidence | `core` reference slice |
| NEW-014 | SQS FIFO, dead-letter queue, timeout watchdog, and audit archive | AWS reliability evidence | `core` reference slice |
| NEW-015 | Hybrid SQS-to-Kafka bridge with temporary AWS credentials | Optional hybrid-cloud evidence | `stretch` |

## Extracted Boundary Decisions

1. Prior source remains evidence only and is never imported as a runtime package.
2. No public or domain contract contains commercial billing or hosting-service concepts.
3. Proxmox is an adapter; a fake provider must satisfy the same provider contract first.
4. PostgreSQL is the Kubernetes source of truth. MongoDB is not carried forward.
5. The main event path uses Kafka. The AWS slice uses DynamoDB Streams and SQS without duplicating the full platform.
6. Reliability claims depend on idempotency, ownership, checkpoints, and recovery evidence, not an exactly-once claim.
7. The number of supported provider endpoints is secondary to complete failure, telemetry, test, and recovery behavior.
