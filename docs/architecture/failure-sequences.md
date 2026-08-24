# Failure Sequences

## Kafka Unavailable After Command Acceptance

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant API as Control API
    participant DB as PostgreSQL
    participant CDC as Debezium
    participant Kafka
    participant Alert as Alerting
    participant Orch as Orchestrator

    Client->>API: Submit mutation with idempotency key
    API->>DB: Commit desired state, operation, idempotency, and outbox
    API-->>Client: 202 Accepted with operation ID
    CDC->>DB: Read committed outbox change
    CDC-xKafka: Publication unavailable
    CDC->>CDC: Retain source offset and retry
    Alert->>DB: Observe old outbox age
    Alert-->>Client: Operator alert is active
    Client->>API: Read operation
    API-->>Client: Accepted and awaiting publication
    Kafka-->>CDC: Broker recovers
    CDC->>Kafka: Publish original event ID
    Kafka->>Orch: Deliver command
    Orch->>DB: Claim inbox and continue workflow
```

Required behavior:

- A committed command is not rolled back because Kafka is unavailable.
- The API does not publish directly and remains independent of broker latency.
- Debezium does not advance past unpublished work.
- Oldest outbox age and connector errors alert before storage exhaustion.
- Recovery publishes the original event identity; it does not manufacture a new command.

## Provider Timeout and Unknown Outcome

```mermaid
sequenceDiagram
    autonumber
    participant Orch as Orchestrator
    participant DB as PostgreSQL
    participant Provider as Proxmox Provider
    participant PVE as Proxmox VE
    participant Reconciler
    actor SRE

    Orch->>DB: Persist pre-provider checkpoint
    Orch->>Provider: Submit create request
    Provider->>PVE: Submit full clone
    PVE--xProvider: Response is lost after possible acceptance
    Provider-->>Orch: Unknown outcome with available correlation facts
    Orch->>DB: Persist unknown outcome and stop automatic create retry
    Reconciler->>Provider: Query by allowed VMID range and ownership markers
    Provider->>PVE: Read matching provider resources and tasks
    alt Exactly one matching owned VM proves success
        PVE-->>Provider: Owned VM and task state
        Provider-->>Reconciler: Verified late success
        Reconciler->>DB: Complete operation and update observed state
    else No conclusive owned result before review deadline
        PVE-->>Provider: Missing or ambiguous evidence
        Provider-->>Reconciler: Inconclusive result
        Reconciler->>DB: Create manual-review item
        SRE->>DB: Record authorized investigation and resolution
    end
```

Required behavior:

- Transport timeout is not interpreted as provider failure.
- Create is not resubmitted while the outcome is unknown.
- Reconciliation uses immutable ownership markers and the allowlisted VMID range, not VM name alone.
- Only conclusive observed evidence may convert the operation to success or confirmed failure.
- Ambiguity remains visible and requires an attributable operator decision.

## Duplicate Kafka Message

```mermaid
sequenceDiagram
    autonumber
    participant Kafka
    participant Orch as Orchestrator
    participant DB as PostgreSQL
    participant Provider as Proxmox Provider

    Kafka->>Orch: Deliver event E for instance I
    Orch->>DB: Insert inbox receipt E and claim workflow lease I
    Orch->>Provider: Execute provider step once
    Provider-->>Orch: Provider task reference and result
    Orch->>DB: Complete checkpoint, inbox receipt E, and result outbox
    Orch-->>Kafka: Commit consumed offset

    Kafka->>Orch: Redeliver event E
    Orch->>DB: Read completed inbox receipt E
    DB-->>Orch: Existing completed outcome
    Orch->>Orch: Reuse recorded outcome and skip side effects
    Orch-->>Kafka: Commit duplicate offset
```

Required behavior:

- The event ID, not the Kafka offset, is the durable deduplication identity.
- The inbox record stores enough outcome data to answer a duplicate deterministically.
- The duplicate path does not call the provider or emit a second logical result event.
- A crash before inbox completion resumes the checkpointed workflow rather than treating the event as new.

## Configuration Failure and Compensation

```mermaid
sequenceDiagram
    autonumber
    participant Orch as Orchestrator
    participant DB as PostgreSQL
    participant Provider as Proxmox Provider
    participant PVE as Proxmox VE
    actor SRE

    Orch->>Provider: Clone allowlisted template
    Provider->>PVE: Submit clone
    PVE-->>Provider: Clone task succeeds
    Provider-->>Orch: Proven owned VM identity
    Orch->>DB: Checkpoint created VM and ownership evidence
    Orch->>Provider: Apply network and cloud-init configuration
    Provider->>PVE: Submit configuration
    PVE-->>Provider: Permanent configuration failure
    Provider-->>Orch: Classified permanent failure
    Orch->>DB: Enter compensating state
    Orch->>Provider: Destroy only VM proven created by this workflow

    alt Compensation succeeds
        Provider->>PVE: Stop and destroy owned VM
        PVE-->>Provider: Destroyed
        Provider-->>Orch: Verified absence
        Orch->>DB: Release workflow-created IPv4 lease and mark operation failed
    else Compensation fails or outcome is unknown
        Provider--xPVE: Failure or lost result
        Provider-->>Orch: Compensation unknown or failed
        Orch->>DB: Quarantine IPv4 lease and enter manual review
        SRE->>DB: Record investigation and final disposition
    end
```

Required behavior:

- Compensation begins only after the workflow has durable proof that it created the target resource.
- Provider cleanup cannot target a pre-existing or unowned VM.
- Successful compensation releases only the lease created by the failed workflow.
- Failed or unknown compensation preserves the original error, records the cleanup error separately, and quarantines the lease.
- A compensation failure is not retried destructively without fresh ownership and observed-state verification.
