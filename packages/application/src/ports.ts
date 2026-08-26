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
  InstanceCreateRequestedV1,
  InstanceMutationCompletedV1,
  InstanceMutationFailedV1,
  WorkflowProgressedV1,
} from '@private-cloud/contracts';
import type { WorkflowStage } from './workflow-stage.js';

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

/**
 * One page of results.
 *
 * `nextCursor` is always `null` in Phase 3 — the catalog and per-project instance counts are
 * bounded by quota, so cursor pagination is not yet needed. The field is present because the
 * REST contract publishes it and clients should be written against it from the start.
 */
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
  /** Reads a project, or `null` when it does not exist. */
  getProject(projectId: string): Promise<ProjectView | null>;
  /** Reads quota limits with freshly measured usage, or `null` when the project has none. */
  getQuota(projectId: string): Promise<QuotaView | null>;
  /** Lists enabled catalog images. Reads `control.*` directly — catalog data is static. */
  listImages(projectId: string, limit: number): Promise<Page<ImageView>>;
  /** Lists enabled catalog flavors. */
  listFlavors(projectId: string, limit: number): Promise<Page<FlavorView>>;
  /** Lists enabled catalog networks. */
  listNetworks(projectId: string, limit: number): Promise<Page<NetworkView>>;
  /** Reads one instance from the read projection, or `null`. */
  getInstance(projectId: string, instanceId: string): Promise<InstanceView | null>;
  /** Lists instances from the read projection, most recently updated first. */
  listInstances(projectId: string, limit: number): Promise<Page<InstanceView>>;
  /** Reads one operation from the read projection, or `null`. */
  getOperation(projectId: string, operationId: string): Promise<OperationView | null>;
  /** Lists operations from the read projection, most recently updated first. */
  listOperations(projectId: string, limit: number): Promise<Page<OperationView>>;
}

/**
 * A workflow claimed for exclusive processing, with the lease proving that exclusivity.
 *
 * Everything needed to execute exactly one transition. The worker must not cache this across
 * transitions — after a checkpoint the lease is released and the state must be re-claimed.
 */
export interface ClaimedCreateWorkflow {
  /** The original accepted command, replayed verbatim from the outbox. */
  readonly command: InstanceCreateRequestedV1;
  /** Persisted position in the state machine — where to resume. */
  readonly stage: WorkflowStage;
  /** Claim counter, used to widen the retry backoff. Not a per-stage counter. */
  readonly attempt: number;
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

/** Any event the workflow may emit to the workflow outbox. */
export type WorkflowEvent =
  | WorkflowProgressedV1
  | InstanceMutationCompletedV1
  | InstanceMutationFailedV1;

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
  claimNextCreate(workerId: string, leaseSeconds: number): Promise<ClaimedCreateWorkflow | null>;
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
    readonly event: WorkflowEvent;
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
 * `ProjectionWorker` in `apps/control-api`.
 *
 * @see docs/architecture/glossary.md#read-projection-cqrs
 */
export interface ProjectionStore {
  /**
   * Applies the oldest unconsumed workflow event, respecting per-aggregate ordering.
   *
   * @returns `true` if an event was applied — the caller should poll again immediately —
   *   or `false` when the queue is drained and the caller should back off.
   */
  applyNextWorkflowEvent(): Promise<boolean>;
}
