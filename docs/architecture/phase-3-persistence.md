# Phase 3 Persistence

## Ownership

Phase 3 uses one PostgreSQL database with logical schemas and single-writer rules. The temporary database pollers read immutable outbox rows and write receipts only in their own schema; they do not update another service's authoritative tables.

| Schema | Writer | Phase 3 records | Cross-boundary access |
| --- | --- | --- | --- |
| `control` | Control API | Project, quota, catalog, provider profile, instance intent, operation, IPv4 lease, idempotency, command outbox | Orchestrator may select immutable outbox rows |
| `workflow` | Provisioning Orchestrator | Command receipt, fenced instance lease, checkpoint, provider resource/task reference, result outbox | Control API projection worker may select immutable outbox rows |
| `projection` | Control API projection worker | Event receipts and project-readable instance and operation documents | Read through the public API only |
| `audit` | Originating application transaction | Attributed mutation evidence | Administrative read path is implemented later |

## Acceptance Transaction

| Record | Required fields | Concurrency rule |
| --- | --- | --- |
| Idempotency | Actor, project, operation type, key, target, canonical hash, original response, expiry | Transaction advisory lock serializes one idempotency scope |
| Instance intent | UUID, project, catalog IDs, provider profile ID, hostname, requested resources and power | Aggregate version begins at one |
| IPv4 lease | Network, address, prefix, gateway, state, owning instance | Network advisory lock plus partial unique active-address index |
| Operation | UUID, target, action, state, stage, progress, timestamps | Terminal state is immutable in later projection handling |
| Command outbox | Event identity, schema/version, aggregate, partition key, exact contract payload | Immutable after commit |
| Audit | Actor, role, project, action, target, outcome, operation | Append only |
| Initial projections | Contract-shaped instance and operation documents | Updated only from deduplicated workflow events |

The API acknowledges only after all records commit. A rollback leaves no instance, lease, operation, audit entry, idempotency record, or outbox message.

## Seed Boundary

The base seed creates project UUID `00000000-0000-4000-8000-000000000001` with the name `lab-sandbox`, a documentation-address network, one fake profile, one image, and one flavor. It contains no live Proxmox endpoint, credential, node, template VMID, storage, bridge, or allocatable production address.
