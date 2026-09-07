/**
 * The application layer's ports — every seam between business logic and the outside world.
 *
 * PATTERN — Ports and adapters (hexagonal). Each interface here declares what the
 * application *needs*; the implementations live in `packages/postgres-adapter` and are
 * injected at startup by each service's `app.module.ts`. Nothing in this file may import a
 * database driver, a NestJS symbol, or a vendor type.
 *
 * That constraint is what lets `ControlPlaneApplication` and `CreateInstanceWorkflow` be
 * tested without a container or a database, and what will let the planned AWS path swap
 * PostgreSQL for DynamoDB without touching business logic
 * (ADR 0003).
 *
 * **If you are looking for "the service layer", start here and in `control-plane.ts`.**
 *
 * @see docs/architecture/glossary.md#ports-and-adapters-hexagonal-architecture
 */
import type { components } from '@private-cloud/contracts';
import type {
  EventEnvelope,
  InstanceCreateRequestedV1,
  InstancePowerRequestedV1,
  InstanceResizeRequestedV1,
  InstanceRetentionRequestedV1,
  InstancePurgeRequestedV1,
  InstanceMutationCompletedV1,
  InstanceMutationFailedV1,
  ProvisioningDeadLetteredV1,
  ProvisioningReplayResolvedV1,
  ProvisioningReplayRequestedV1,
  SnapshotCreateRequestedV1,
  SnapshotDeleteRequestedV1,
  SnapshotRollbackRequestedV1,
  WorkflowProgressedV1,
} from '@private-cloud/contracts';
import type { WorkflowAction, WorkflowStage } from './workflow-stage.js';
import type { ApplicationTraceContext } from './telemetry.js';

/*
 * The view types below are aliases of the generated OpenAPI schemas rather than hand-written
 * shapes. WHY: the REST contract is the authority (ADR 0010). Aliasing means a contract
 * change surfaces as a compile error in the store implementations, instead of as a response
 * that silently no longer matches its published schema.
 */

/** A tenant project, as published by the REST and gRPC contracts. */
export type ProjectView = components['schemas']['Project'];
/** Quota limits alongside their current measured usage. */
export type QuotaView = components['schemas']['QuotaSet'];
/** A bootable image offered by the project catalog. */
export type ImageView = components['schemas']['Image'];
/** A CPU, memory, and disk sizing template. */
export type FlavorView = components['schemas']['Flavor'];
/** A network an instance may attach to, with its IPv4 pool. */
export type NetworkView = components['schemas']['Network'];
/** An instance's desired state, observed state, lease, and drift classification. */
export type InstanceView = components['schemas']['Instance'];
/** The asynchronous progress record a client polls after a mutation is accepted. */
export type OperationView = components['schemas']['Operation'];
/** The `202 Accepted` body: what was accepted, and where to poll for its outcome. */
export type AcceptedMutation = components['schemas']['MutationAccepted'];
/** One snapshot, as published by the REST and gRPC contracts. */
export type SnapshotView = components['schemas']['Snapshot'];
/** Retention configuration, as published by the administrative REST API. */
export type RetentionPolicyView = components['schemas']['RetentionPolicy'];
/** Administrative dead-letter evidence returned by the REST API. */
export type DeadLetterView = components['schemas']['DeadLetter'];
/** One attributed audit fact, as published to administrators. */
export type AuditEventView = components['schemas']['AuditEvent'];
/**
 * An operation enriched with the recovery metadata only an administrator may see.
 *
 * Superset of `OperationView`: it adds correlation, causation, trace, retry, checkpoint,
 * dead-letter, and provider-task fields that are restricted-operational rather than tenant
 * facing.
 */
export type AdministrativeOperationView = components['schemas']['AdministrativeOperation'];

/** Durable broker coordinates used for inbox identity and operational evidence. */
export interface MessageDeliveryIdentity {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly replayGeneration: number;
  /** Physical owner-outbox row propagated by the Debezium Event Router. */
  readonly outboxId?: string;
}

/**
 * An authenticated caller and the authorization claims carried by its token.
 *
 * Populated by the transport layer from a verified OIDC token; the application layer treats
 * it as trusted input and never re-verifies signatures.
 */
export interface Actor {
  /** The `sub` claim — stable caller identity, used for audit and idempotency scoping. */
  readonly subject: string;
  /** Roles claim. Phase 3 recognises `tenant_developer` only. */
  readonly roles: readonly string[];
  /** Project IDs this caller may act on. Membership is required for every operation. */
  readonly projects: readonly string[];
}

/**
 * A validated create-instance request, ready to be committed as durable intent.
 *
 * Distinct from `CreateInstanceInput` in `control-plane.ts`: by the time a command reaches
 * the store, `ControlPlaneApplication` has already authorized the actor, validated the
 * fields, and materialised `sshPublicKeys` into a definite array.
 */
export interface CreateInstanceCommand {
  /** The authenticated caller. Part of the idempotency scope. */
  readonly actor: Actor;
  /** Target project. Already checked against the actor's membership. */
  readonly projectId: string;
  /** Caller-supplied key that makes retries of this exact request safe. */
  readonly idempotencyKey: string;
  /** Client-supplied or generated UUID tying related operations together in telemetry. */
  readonly correlationId: string;
  /** W3C trace context propagated to the provider call for distributed tracing. */
  readonly traceparent: string;
  /** Optional W3C vendor state propagated with `traceparent`. */
  readonly tracestate?: string;
  /** Catalog image slug. */
  readonly imageId: string;
  /** Catalog flavor slug, resolved to concrete CPU/memory/disk at acceptance. */
  readonly flavorId: string;
  /** Catalog network slug; an IPv4 address is reserved from its pool at acceptance. */
  readonly networkId: string;
  /** Guest hostname, also used as the provider resource name. */
  readonly hostname: string;
  /** Zero to five unique SSH public keys injected via cloud-init. */
  readonly sshPublicKeys: readonly string[];
}

/** Optional narrowing applied to an administrative audit-event read. */
export interface AuditEventFilter {
  /** Restricts to facts recorded against one project. */
  readonly projectId?: string;
  /** Restricts to facts recorded against one operation. */
  readonly operationId?: string;
}

/**
 * A validated power request, ready to be committed as durable intent.
 *
 * Shares the mutation-identity fields with {@link CreateInstanceCommand} but names an existing
 * instance rather than describing a new one, so the store guards it with the per-instance
 * concurrency lock instead of a quota and address reservation.
 */
export interface PowerInstanceCommand {
  readonly actor: Actor;
  readonly projectId: string;
  /** The instance to act on. Must already exist and be idle. */
  readonly instanceId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
  /** The requested transition, already narrowed by the domain validator. */
  readonly action: 'start' | 'shutdown' | 'stop' | 'reboot';
}

/**
 * A validated resize request, ready to be committed as durable intent.
 *
 * Names a flavor rather than raw sizing: SAFE-027 requires sizing to come from server-side catalog
 * data, not from caller-supplied numbers.
 */
export interface ResizeInstanceCommand {
  readonly actor: Actor;
  readonly projectId: string;
  readonly instanceId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
  /** Catalog flavor defining the target sizing. */
  readonly flavorId: string;
  /**
   * Requested disk size in GiB, independent of the flavor.
   *
   * Absent means "leave the disk as it is". Present and smaller than the current size is refused;
   * the flavor's minimum remains a floor either way.
   */
  readonly diskGiB?: number;
}

/**
 * What happens to an instance's IPv4 address when its lifecycle ends.
 *
 * `quarantine_until_purge` keeps the address reserved while the retained VM still exists, so it
 * cannot be handed to a new instance while an old one is still answering on it.
 * `release_on_retain` returns it to the pool immediately, which is only safe when the provider
 * resource's network configuration has genuinely been detached.
 */
export type LeaseReleaseMode = 'quarantine_until_purge' | 'release_on_retain';

/** A validated request to create a snapshot of an instance. */
export interface CreateSnapshotCommand {
  readonly actor: Actor;
  readonly projectId: string;
  readonly instanceId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
  /** Caller-supplied name, already validated against the reserved and malformed sets. */
  readonly name: string;
  readonly description?: string;
}

/** A validated request to roll back to, or delete, an existing snapshot. */
export interface SnapshotActionCommand {
  readonly actor: Actor;
  readonly projectId: string;
  readonly instanceId: string;
  readonly snapshotId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
}

/** A validated request to soft-delete an instance. */
export interface RetainInstanceCommand {
  readonly actor: Actor;
  readonly projectId: string;
  readonly instanceId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
}

/** A validated administrator request to destroy a retained instance. */
export interface PurgeInstanceCommand {
  readonly actor: Actor;
  readonly instanceId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
  /** Free-text justification, retained in the audit trail. */
  readonly reason: string;
  /** The instance id repeated by the caller, guarding against a mis-pasted identifier. */
  readonly confirmInstanceId: string;
}

/** One instance a reconciliation sweep should observe, with the desired state to compare. */
export interface ReconciliationCandidate {
  readonly instanceId: string;
  readonly projectId: string;
  readonly providerProfileId: string;
  readonly createOperationId: string;
  readonly providerResourceId: string;
  readonly lifecycleState: string;
  readonly desiredPowerState: string;
  readonly desiredCpuCount: number;
  readonly desiredMemoryMiB: number;
  readonly desiredDiskGiB: number;
}

/** What a reconciliation observed and concluded about one instance. */
export interface ReconciliationOutcome {
  readonly instanceId: string;
  readonly projectId: string;
  readonly drift: string;
  readonly dangerous: boolean;
  readonly exists: boolean;
  readonly powerState: string;
  readonly markerMatch: boolean;
  readonly observedAt: Date;
}

/**
 * Persistence for the reconciler.
 *
 * Deliberately narrow, and deliberately incapable of destruction. SAFE-029 forbids reconciliation
 * from destroying, shrinking, detaching, or overwriting a provider resource, and the port a
 * reconciler is given should make that impossible rather than merely discouraged: there is no
 * method here that removes anything.
 */
export interface ReconciliationStore {
  /**
   * Claims the instances least recently reconciled.
   *
   * @param limit How many to take in one sweep, bounding both provider load and transaction size.
   * @param staleAfter Only instances not reconciled within this window are returned.
   */
  claimStaleInstances(limit: number, staleAfter: Date): Promise<readonly ReconciliationCandidate[]>;
  /** Records what a sweep observed, and publishes the drift finding. */
  recordObservation(outcome: ReconciliationOutcome): Promise<void>;
}

/** Validated administrator request to replay one governed dead letter. */
export interface ReplayDeadLetterCommand {
  readonly actor: Actor;
  readonly originalEventId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
  readonly reason: string;
}

/**
 * A request for one page of results.
 *
 * PATTERN — Keyset (seek) pagination. The cursor names the last row of the previous page, not
 * an offset, so a projection updated between two requests cannot make the caller skip or
 * repeat rows. For these tables that is the normal case, not an edge case.
 */
export interface PageRequest {
  /** Clamped page size; the store must never return more than this many rows. */
  readonly limit: number;
  /**
   * Opaque continuation token from a previous `page.nextCursor`.
   *
   * Absent on the first page. The store owns its encoding, so the application layer passes it
   * through without inspecting it.
   */
  readonly cursor?: string;
}

/** One page of read-model rows plus the token needed to continue. */
export interface Page<T> {
  /** The rows on this page. */
  readonly items: readonly T[];
  /** Applied limit and the cursor for the following page, if any. */
  readonly page: { readonly limit: number; readonly nextCursor: string | null };
}

/**
 * Persistence for synchronous command acceptance and project readback.
 *
 * Implemented by `PostgresControlPlaneStore`; consumed by `ControlPlaneApplication`, which
 * is in turn consumed by the REST and gRPC controllers in `apps/control-api`.
 *
 * The `get*` methods return `null` rather than throwing for a missing row. Mapping absence
 * to an error code is an application-layer decision, not a persistence one — see
 * `ControlPlaneApplication.required`.
 */
export interface ControlPlaneStore {
  /**
   * Commits a create request as durable intent, or replays a previous identical one.
   *
   * PATTERN — Transactional outbox. In one transaction this writes the instance, the
   * operation, the IPv4 lease, the audit entry, the idempotency record, both read
   * projections, **and** the outbox row that will drive provisioning. Either the caller gets
   * `202 Accepted` and the work is guaranteed queued, or nothing is written at all.
   *
   * Idempotent on `(actor, project, 'create_instance', idempotencyKey)`. A repeat of the
   * same request returns the original response with `replayed: true` and creates no second
   * resource; a repeat of the *key* with different content is a conflict.
   *
   * @param requestHash Canonical hash of the request, used to distinguish an honest retry
   *   from a key being reused for different input.
   * @throws DomainError `IDEMPOTENCY_CONFLICT`, `PROJECT_NOT_FOUND`, `PROJECT_ACCESS_DENIED`,
   *   `PROFILE_DISABLED`, `QUOTA_EXCEEDED`, or `VALIDATION_FAILED`.
   */
  acceptCreate(command: CreateInstanceCommand, requestHash: string): Promise<AcceptedMutation>;
  /**
   * Commits a power request as durable intent, or replays a previous identical one.
   *
   * Unlike {@link ControlPlaneStore.acceptCreate}, this takes the per-instance concurrency lock:
   * the instance already exists, so a second concurrent request must be refused with
   * `INSTANCE_BUSY` rather than queued behind the first.
   *
   * @throws DomainError `INSTANCE_NOT_FOUND`, `INSTANCE_BUSY`, or `IDEMPOTENCY_CONFLICT`.
   */
  acceptPowerAction(command: PowerInstanceCommand, requestHash: string): Promise<AcceptedMutation>;
  /**
   * Commits a resize as durable intent, or replays a previous identical one.
   *
   * Quota is checked against the change the resize makes, not its absolute target, because the
   * instance's current sizing is already counted in the project total.
   *
   * @throws DomainError `INSTANCE_NOT_FOUND`, `INSTANCE_BUSY`, `VALIDATION_FAILED`,
   *   `DISK_SHRINK_FORBIDDEN`, `QUOTA_EXCEEDED`, or `IDEMPOTENCY_CONFLICT`.
   */
  acceptResize(command: ResizeInstanceCommand, requestHash: string): Promise<AcceptedMutation>;
  /**
   * Moves an instance's IPv4 lease out of `active`.
   *
   * Idempotent: a lease already in the requested state is left alone, so a redelivered retention
   * or purge command cannot double-release an address.
   *
   * @param instanceId The instance whose lease is ending.
   * @param mode Whether the address is held until purge or returned to the pool now.
   * @returns The lease's resulting state, or `null` when the instance never held one.
   */
  releaseIpv4Lease(
    instanceId: string,
    mode: LeaseReleaseMode,
  ): Promise<'quarantined' | 'released' | null>;
  /** Reads the configured retention policy, which supplies the default release mode. */
  getRetentionPolicy(): Promise<RetentionPolicyView>;
  /**
   * Commits a snapshot creation as durable intent, or replays a previous identical one.
   *
   * @throws DomainError `INSTANCE_NOT_FOUND`, `INSTANCE_BUSY`, `QUOTA_EXCEEDED`,
   *   `VALIDATION_FAILED` for a duplicate name on the instance, or `IDEMPOTENCY_CONFLICT`.
   */
  acceptSnapshotCreate(
    command: CreateSnapshotCommand,
    requestHash: string,
  ): Promise<AcceptedMutation>;
  /**
   * Commits a rollback or delete of an existing snapshot.
   *
   * @param action Which of the two destructive snapshot actions to accept.
   * @throws DomainError `INSTANCE_NOT_FOUND`, `INSTANCE_BUSY`, `SNAPSHOT_NOT_FOUND`,
   *   `SNAPSHOT_OWNERSHIP_MISMATCH`, or `IDEMPOTENCY_CONFLICT`.
   */
  acceptSnapshotAction(
    action: 'rollback_snapshot' | 'delete_snapshot',
    command: SnapshotActionCommand,
    requestHash: string,
  ): Promise<AcceptedMutation>;
  /**
   * Commits a soft deletion as durable intent, or replays a previous identical one.
   *
   * Reads the retention policy inside the transaction, so the deadline and lease-release mode
   * recorded on the command are the ones in force at acceptance rather than whatever they become
   * later.
   *
   * @throws DomainError `INSTANCE_NOT_FOUND`, `INSTANCE_BUSY`, or `IDEMPOTENCY_CONFLICT`.
   */
  acceptRetention(command: RetainInstanceCommand, requestHash: string): Promise<AcceptedMutation>;
  /**
   * Commits an administrative purge as durable intent.
   *
   * Enforces the database half of SAFE-006 plus the retention deadline; the live provider
   * ownership half is proven by the workflow immediately before it destroys anything.
   *
   * Not project-scoped: an administrator purges across projects, and the authorization is the
   * administrator role rather than membership.
   *
   * @throws DomainError `INSTANCE_NOT_FOUND`, `VALIDATION_FAILED` when the confirmation does not
   *   match, `INSTANCE_BUSY` when the instance is not retained or is already working, or
   *   `IDEMPOTENCY_CONFLICT`.
   */
  acceptPurge(command: PurgeInstanceCommand, requestHash: string): Promise<AcceptedMutation>;
  /**
   * Marks an instance for reconciliation on the next sweep.
   *
   * WHY this does not run an observation itself: reconciliation is a sweep with its own provider
   * budget and its own non-destructive port. Letting an administrative request trigger an
   * immediate provider call would put an unbounded, un-batched load behind an HTTP handler.
   *
   * @returns `true` when the instance was marked, `false` when it does not exist.
   */
  requestReconciliation(instanceId: string): Promise<boolean>;
  /** Lists an instance's snapshots from the read projection. */
  listSnapshots(
    projectId: string,
    instanceId: string,
    page: PageRequest,
  ): Promise<Page<SnapshotView>>;
  /** Lists projected dead-letter evidence for administrators. */
  listDeadLetters(page: PageRequest): Promise<Page<DeadLetterView>>;
  /**
   * Lists attributed audit facts, most recent first.
   *
   * The audit trail is append-only and administrator-scoped; there is no project-membership
   * filter because an administrator reads across projects by design. Narrowing is the caller's
   * choice, not an access control.
   */
  listAuditEvents(filter: AuditEventFilter, page: PageRequest): Promise<Page<AuditEventView>>;
  /**
   * Reads one operation with its recovery metadata, across every project, or `null`.
   *
   * Distinct from `getOperation`, which is project-scoped and tenant-facing. An administrator
   * authorizing a replay is frequently not a member of the affected project, so a
   * project-scoped read would make the `statusUrl` of their own action unreachable.
   */
  getAdministrativeOperation(operationId: string): Promise<AdministrativeOperationView | null>;
  /** Reads the failed trace carrier used only to link a new administrative replay trace. */
  getDeadLetterTraceContext(originalEventId: string): Promise<ApplicationTraceContext | null>;
  /** Atomically records replay intent and its outbox command. */
  requestDeadLetterReplay(
    command: ReplayDeadLetterCommand,
    requestHash: string,
  ): Promise<AcceptedMutation>;
  /** Reads a project, or `null` when it does not exist. */
  getProject(projectId: string): Promise<ProjectView | null>;
  /** Reads quota limits with freshly measured usage, or `null` when the project has none. */
  getQuota(projectId: string): Promise<QuotaView | null>;
  /** Lists enabled catalog images. Reads `control.*` directly — catalog data is static. */
  listImages(projectId: string, page: PageRequest): Promise<Page<ImageView>>;
  /** Lists enabled catalog flavors. */
  listFlavors(projectId: string, page: PageRequest): Promise<Page<FlavorView>>;
  /** Lists enabled catalog networks. */
  listNetworks(projectId: string, page: PageRequest): Promise<Page<NetworkView>>;
  /** Reads one instance from the read projection, or `null`. */
  getInstance(projectId: string, instanceId: string): Promise<InstanceView | null>;
  /** Lists instances from the read projection, most recently updated first. */
  listInstances(projectId: string, page: PageRequest): Promise<Page<InstanceView>>;
  /** Reads one operation from the read projection, or `null`. */
  getOperation(projectId: string, operationId: string): Promise<OperationView | null>;
  /** Lists operations from the read projection, most recently updated first. */
  listOperations(projectId: string, page: PageRequest): Promise<Page<OperationView>>;
}

/**
 * A workflow claimed for exclusive processing, with the lease proving that exclusivity.
 *
 * Everything needed to execute exactly one transition. The worker must not cache this across
 * transitions — after a checkpoint the lease is released and the state must be re-claimed.
 */
/**
 * Any command that can admit a workflow.
 *
 * The union grows with each capability. `action` on the claim is the discriminator, not the
 * payload's shape, because the dispatcher must route before it narrows.
 */
export type LifecycleCommand =
  | InstanceCreateRequestedV1
  | InstancePowerRequestedV1
  | InstanceResizeRequestedV1
  | SnapshotCreateRequestedV1
  | SnapshotRollbackRequestedV1
  | SnapshotDeleteRequestedV1
  | InstanceRetentionRequestedV1
  | InstancePurgeRequestedV1;

/**
 * Everything needed to execute exactly one transition, handed over by a successful claim.
 *
 * The worker must not cache this across transitions — after a checkpoint the lease is released
 * and the state has to be re-claimed, with a fresh fencing token.
 */
export interface ClaimedWorkflow<TCommand extends LifecycleCommand = LifecycleCommand> {
  /**
   * Which capability this workflow executes.
   *
   * Carried on the claim rather than derived from `command.schemaName` so the dispatcher can route
   * before narrowing the payload, and so a workflow whose action this build does not implement
   * fails at the claim instead of part-way through execution.
   */
  readonly action: WorkflowAction;
  /** The original accepted command, replayed verbatim from the outbox. */
  readonly command: TCommand;
  /** Latest durable W3C parent for the next short-lived workflow stage span. */
  readonly traceContext: InstanceCreateRequestedV1['traceContext'];
  /** Persisted position in the state machine — where to resume. */
  readonly stage: WorkflowStage;
  /** Monotonic claim counter used for operational evidence. */
  readonly attempt: number;
  /** Number of consecutive retryable provider failures at the current stage. */
  readonly stageAttempt: number;
  /** Start of the current persisted retry budget, absent after forward progress. */
  readonly retryStartedAt?: Date;
  /**
   * Monotonic token proving this claim is the newest.
   *
   * Every subsequent write must present it. A worker that stalled past its lease holds a
   * stale token and is rejected — see the fencing discussion in the glossary.
   */
  readonly fencingToken: bigint;
  /** Provider-assigned resource identifier, present once the create has been submitted. */
  readonly providerResourceId?: string;
  /** Handle for an in-flight asynchronous provider task, present during `polling_*`. */
  readonly providerTaskReference?: string;
}

/**
 * Why a physical command delivery failed its durable authorization check.
 *
 * These are distinct operator situations, not severities, and each one names a different
 * recovery. Collapsing them loses the only signal that separates a forged redelivery from a
 * legitimate command that arrived against state which has since moved on.
 */
export type CommandRejectionCode =
  /** A receipt already exists for this generation carrying a different canonical payload. */
  | 'REPLAY_COMMAND_IDENTITY_CONFLICT'
  /** No live authorization row matches this command's hash and physical outbox identity. */
  | 'REPLAY_COMMAND_UNAUTHORIZED'
  /** Authority matched, but the target workflow is no longer in a state this replay can reopen. */
  | 'REPLAY_COMMAND_STATE_CONFLICT';

/**
 * Outcome of admitting one physical command delivery.
 *
 * A rejection carries its reason so the consumer can attribute the quarantine truthfully
 * instead of guessing a single hardcoded cause.
 */
export type CommandAdmission =
  | { readonly outcome: 'accepted' }
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'rejected'; readonly failureCode: CommandRejectionCode };

/** Any event the workflow may emit to the workflow outbox. */
export type WorkflowEvent =
  | WorkflowProgressedV1
  | InstanceMutationCompletedV1
  | InstanceMutationFailedV1
  | ProvisioningReplayResolvedV1;

/**
 * Persistence for leased, fenced workflow execution.
 *
 * Implemented by `PostgresWorkflowStore`; consumed by `CreateInstanceWorkflow`.
 *
 * PATTERN — Inbox, lease with fencing token, and transactional outbox together. Every method
 * is a single transaction, and both writing methods emit their event in that same
 * transaction, so a stage can never advance without the event that explains it.
 *
 * @see docs/architecture/glossary.md#lease-and-fencing-token
 */
export interface WorkflowStore {
  /** Atomically records a Kafka inbox receipt and creates the workflow on first delivery. */
  admitCommand(
    command: LifecycleCommand,
    delivery: MessageDeliveryIdentity,
  ): Promise<CommandAdmission>;
  /** Authorizes a replay and atomically writes its restored command to the owner outbox. */
  admitReplayRequest(
    request: ProvisioningReplayRequestedV1,
    delivery: MessageDeliveryIdentity,
  ): Promise<'accepted' | 'duplicate' | 'rejected'>;
  /** Persists a raw poison-record hash and coordinates; raw bytes are never retained. */
  quarantineRecord(input: {
    readonly delivery: MessageDeliveryIdentity;
    readonly payloadHash: string;
    readonly failureCode: string;
    readonly safeMessage: string;
  }): Promise<'quarantined' | 'duplicate'>;
  /** Persists governed DLQ evidence and its outbox event after bounded retries are exhausted. */
  deadLetterCommand(input: {
    readonly event: EventEnvelope;
    readonly delivery: MessageDeliveryIdentity;
    readonly attempts: number;
    readonly failureCode: string;
    readonly safeMessage: string;
    readonly replayAllowed: boolean;
  }): Promise<'dead_lettered' | 'duplicate'>;
  /**
   * Claims the next ready workflow, or returns `null` when none is due.
   *
   * Also acts as the inbox: if no workflow is ready, an unconsumed create command is pulled
   * from `control.outbox` and converted into a workflow exactly once.
   *
   * The caller holds the lease for `leaseSeconds` and must present the returned
   * `fencingToken` on every write. Callers must execute exactly one transition and claim
   * again rather than looping — see {@link CreateInstanceWorkflow.runOne}.
   *
   * @throws Error if `workerId` is empty or `leaseSeconds` is outside 5–300.
   */
  claimNext(
    workerId: string,
    leaseSeconds: number,
    action: WorkflowAction,
  ): Promise<ClaimedWorkflow | null>;
  /**
   * Advances the workflow to a new stage and records the event that caused it.
   *
   * Releases the lease on success, so the next transition requires a fresh claim.
   *
   * @throws Error if the fencing token is stale or the lease has expired or been taken.
   */
  checkpoint(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly fencingToken: bigint;
    readonly stage: WorkflowStage;
    readonly providerResourceId?: string;
    /** `null` explicitly clears a completed task reference; omitting it leaves it unchanged. */
    readonly providerTaskReference?: string | null;
    /** Delays the next claim. Its presence also marks the workflow as `retry_wait`. */
    readonly nextAttemptAt?: Date;
    /** Persisted retry state. Omission resets retry state after a successful provider call. */
    readonly retry?: {
      readonly attempt: number;
      readonly startedAt: Date;
      readonly errorCategory: string;
      readonly errorCode: string;
    };
    readonly event: WorkflowEvent;
  }): Promise<void>;
  /**
   * Atomically terminates a safely retryable workflow after policy exhaustion and publishes both
   * its operation failure and governed dead-letter evidence.
   */
  deadLetterWorkflow(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly fencingToken: bigint;
    readonly attempts: number;
    readonly failureCode: string;
    readonly safeMessage: string;
    readonly lastErrorCategory: string;
    readonly lastErrorCode: string;
    readonly event: InstanceMutationFailedV1;
  }): Promise<void>;
  /**
   * Terminates the workflow and marks its command receipt consumed.
   *
   * `manual_review` is not a failure — it records that the provider outcome could not be
   * proven, which no automated path may resolve by guessing.
   *
   * @throws Error if the fencing token is stale or the lease has expired or been taken.
   */
  complete(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly fencingToken: bigint;
    readonly status: 'succeeded' | 'failed' | 'manual_review';
    readonly event: WorkflowEvent;
  }): Promise<void>;
}

/**
 * Applies workflow events to the read model.
 *
 * PATTERN — Read projection (CQRS). Implemented by `PostgresProjectionStore` and driven by
 * `ProjectionConsumer` in `apps/control-api`, which reads the Kafka event and DLQ topics.
 *
 * @see docs/architecture/glossary.md#read-projection-cqrs
 */
export interface ProjectionStore {
  /** Applies one Kafka-delivered workflow event and commits its inbox receipt atomically. */
  applyWorkflowEvent(
    event: WorkflowEvent,
    delivery: MessageDeliveryIdentity,
  ): Promise<'applied' | 'duplicate'>;
  /** Projects a governed dead-letter event for administrative readback. */
  applyDeadLetterEvent(
    event: ProvisioningDeadLetteredV1,
    delivery: MessageDeliveryIdentity,
  ): Promise<'applied' | 'duplicate'>;
  /**
   * Projects a reconciliation drift finding for administrator readback.
   *
   * Records the classification on the instance document only. It never changes desired state or
   * lifecycle: SAFE-029 makes reconciliation a reporter, and a projection that acted on a finding
   * would be the correction that rule forbids.
   */
  applyDriftEvent(
    event: EventEnvelope & { readonly data?: unknown },
    delivery: MessageDeliveryIdentity,
  ): Promise<'applied' | 'duplicate'>;
  /** Persists a projection poison-record hash and coordinates without retaining raw bytes. */
  quarantineRecord(input: {
    readonly delivery: MessageDeliveryIdentity;
    /** Trusted envelope identity when decoding succeeded; absent for raw poison bytes. */
    readonly eventId?: string;
    readonly payloadHash: string;
    readonly failureCode: string;
    readonly safeMessage: string;
  }): Promise<'quarantined' | 'duplicate'>;
}
