/**
 * The application service for synchronous control-plane requests.
 *
 * **This is the service layer.** If you came looking for `InstancesService` or
 * `CatalogService` under `apps/control-api`, this is the file that does that job. It sits
 * here, not there, for one reason: it must not depend on NestJS.
 *
 * That gives two things. It can be unit-tested by constructing it with a stub store and no
 * container at all — see `control-plane.spec.ts`. And the planned AWS Lambda path can reuse
 * it unchanged, since it knows nothing about how a request reached it.
 *
 * The cost is that it carries no `@Injectable()`, so NestJS cannot construct it by type. It
 * is built explicitly in `apps/control-api/src/app/app.module.ts` through a `useFactory`
 * bound to the `CONTROL_PLANE_APPLICATION` token. That indirection is the price of the
 * independence, and is deliberate.
 *
 * Its job is narrow: authorize the caller, enforce input rules the transport cannot, and
 * delegate. Persistence lives behind {@link ControlPlaneStore}; provisioning is asynchronous
 * and belongs to {@link CreateInstanceWorkflow}.
 *
 * @see docs/architecture/glossary.md#ports-and-adapters-hexagonal-architecture
 * @see docs/architecture/code-reading-guide.md
 */
import {
  canonicalSha256,
  DomainError,
  validateCreateInstance,
  validatePowerAction,
  validateSnapshotName,
} from '@private-cloud/domain';
import type {
  AcceptedMutation,
  Actor,
  AdministrativeOperationView,
  AuditEventFilter,
  AuditEventView,
  ControlPlaneStore,
  CreateInstanceCommand,
  CreateSnapshotCommand,
  DeadLetterView,
  FlavorView,
  ImageView,
  InstanceView,
  NetworkView,
  OperationView,
  Page,
  PageRequest,
  PowerInstanceCommand,
  ProjectView,
  QuotaView,
  ReplayDeadLetterCommand,
  PurgeInstanceCommand,
  ResizeInstanceCommand,
  RetainInstanceCommand,
  SnapshotActionCommand,
  SnapshotView,
} from './ports.js';
import { NOOP_APPLICATION_TELEMETRY, type ApplicationTelemetry } from './telemetry.js';

/** Default page size when a caller does not ask for one. */
const DEFAULT_PAGE_LIMIT = 50;

/** Largest page a caller may request, to bound response size and query cost. */
const MAXIMUM_PAGE_LIMIT = 100;

/** Idempotency keys must be long enough to be unguessable and short enough to index. */
const IDEMPOTENCY_KEY_MINIMUM_LENGTH = 8;
/** Upper bound on idempotency key length. */
const IDEMPOTENCY_KEY_MAXIMUM_LENGTH = 128;

/**
 * A create request as it arrives from a transport, before it becomes a command.
 *
 * Differs from {@link CreateInstanceCommand} in that `sshPublicKeys` is optional here; the
 * service materialises it into a definite array before handing it to the store.
 */
/** A tenant request to change an instance's power state. */
export interface PowerInstanceInput {
  readonly actor: Actor;
  readonly projectId: string;
  /** The instance to act on. */
  readonly instanceId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
  /** Requested transition, validated against the supported set before acceptance. */
  readonly action: string;
}

/** A tenant request to snapshot an instance. */
export interface CreateSnapshotInput {
  readonly actor: Actor;
  readonly projectId: string;
  readonly instanceId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
  readonly name: string;
  readonly description?: string;
}

/** A tenant request to soft-delete an instance. */
export interface RetainInstanceInput {
  readonly actor: Actor;
  readonly projectId: string;
  readonly instanceId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
}

/** An administrator request to destroy a retained instance. */
export interface PurgeInstanceInput {
  readonly actor: Actor;
  readonly instanceId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
  readonly reason: string;
  readonly confirmInstanceId: string;
}

/** A tenant request to roll back to, or delete, an existing snapshot. */
export interface SnapshotActionInput {
  readonly actor: Actor;
  readonly projectId: string;
  readonly instanceId: string;
  readonly snapshotId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
}

/**
 * A tenant request to create an instance, as the transports supply it.
 *
 * Distinct from `CreateInstanceCommand` in `ports.ts`: this is the raw request, before the
 * application has authorized the actor, validated the fields, or bound the active trace.
 */
/** A tenant request to change an instance's sizing to a catalog flavor. */
export interface ResizeInstanceInput {
  readonly actor: Actor;
  readonly projectId: string;
  readonly instanceId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
  /** Catalog flavor defining the target sizing. */
  readonly flavorId: string;
  /** Requested disk size in GiB, independent of the flavor. Absent leaves the disk alone. */
  readonly diskGiB?: number;
}

/**
 * A tenant request to create an instance, as the transports supply it.
 *
 * Distinct from `CreateInstanceCommand` in `ports.ts`: this is the raw request, before the
 * application has authorized the actor, validated the fields, or bound the active trace.
 */
export interface CreateInstanceInput {
  /** Authenticated caller, populated by the transport from a verified OIDC token. */
  readonly actor: Actor;
  /** Target project. Checked against the actor's membership before anything else. */
  readonly projectId: string;
  /** Caller-supplied key making a retry of this exact request safe. */
  readonly idempotencyKey: string;
  /** UUID correlating related operations in telemetry. */
  readonly correlationId: string;
  /** W3C trace context, propagated all the way to the provider call. */
  readonly traceparent: string;
  /** Optional W3C vendor state paired with `traceparent`. */
  readonly tracestate?: string;
  /** Catalog image slug. */
  readonly imageId: string;
  /** Catalog flavor slug. */
  readonly flavorId: string;
  /** Catalog network slug. */
  readonly networkId: string;
  /** Guest hostname. */
  readonly hostname: string;
  /** Up to five unique SSH public keys. */
  readonly sshPublicKeys?: readonly string[];
}

/** Administrator replay request before it crosses the persistence port. */
export interface ReplayDeadLetterInput {
  readonly actor: Actor;
  readonly originalEventId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly traceparent: string;
  readonly tracestate?: string;
  readonly reason: string;
}

/**
 * Authorizes, validates, and delegates synchronous control-plane requests.
 *
 * Every public method authorizes first. There is no method here that reads or writes project
 * data without checking the actor's access to that project.
 */
export class ControlPlaneApplication {
  /**
   * @param store Persistence port, injected as `PostgresControlPlaneStore` at runtime.
   * @param telemetry Vendor-neutral telemetry port; tests use the no-op default.
   */
  public constructor(
    private readonly store: ControlPlaneStore,
    private readonly telemetry: ApplicationTelemetry = NOOP_APPLICATION_TELEMETRY,
  ) {}

  /**
   * Accepts a create request as durable intent and returns immediately.
   *
   * Returns as soon as the intent is committed — provisioning happens later, in
   * `provisioning-orchestrator`. The caller polls the returned operation for progress. This
   * is why the REST endpoint answers `202 Accepted` and not `201 Created`: at this point
   * nothing has been created, only promised.
   *
   * The `requestHash` built here is what makes idempotency meaningful. It is a canonical hash
   * of the *semantic* request, so two JSON bodies with keys in a different order — or SSH
   * keys in a different order — hash identically and are correctly recognised as the same
   * request. See `canonicalSha256` in `packages/domain`.
   *
   * @throws DomainError `PROJECT_ACCESS_DENIED`, `VALIDATION_FAILED`, `IDEMPOTENCY_CONFLICT`,
   *   `PROFILE_DISABLED`, `PROJECT_NOT_FOUND`, or `QUOTA_EXCEEDED`.
   */
  public async createInstance(input: CreateInstanceInput): Promise<AcceptedMutation> {
    return this.telemetry.trace(
      'controlplane.command.accept',
      {
        'command.type': 'create_instance',
        'cloud.project.id': input.projectId,
      },
      async () => {
        try {
          this.authorize(input.actor, input.projectId);

          this.assertIdempotencyKey(input.idempotencyKey);
          validateCreateInstance(input);

          const activeTrace = this.telemetry.currentTraceContext({
            traceparent: input.traceparent,
            ...(input.tracestate ? { tracestate: input.tracestate } : {}),
          });
          const command: CreateInstanceCommand = {
            ...input,
            traceparent: activeTrace.traceparent,
            ...(activeTrace.tracestate ? { tracestate: activeTrace.tracestate } : {}),
            sshPublicKeys: [...(input.sshPublicKeys ?? [])],
          };
          const requestHash = canonicalSha256({
            actor: input.actor.subject,
            projectId: input.projectId,
            operation: 'create_instance',
            imageId: input.imageId,
            flavorId: input.flavorId,
            networkId: input.networkId,
            hostname: input.hostname,
            // Sorted so that reordering the same set of keys is the same request, not a conflict.
            sshPublicKeys: [...(input.sshPublicKeys ?? [])].sort(),
          });
          const accepted = await this.store.acceptCreate(command, requestHash);
          this.telemetry.commandAccepted(
            'create_instance',
            accepted.replayed ? 'replayed' : 'accepted',
          );
          return accepted;
        } catch (error: unknown) {
          this.telemetry.commandAccepted('create_instance', 'rejected');
          throw error;
        }
      },
    );
  }

  /**
   * Accepts a power transition as durable intent.
   *
   * Follows the same eight steps as {@link ControlPlaneApplication.createInstance}: trace,
   * authorize, bound the idempotency key, validate, bind the active trace, build the command,
   * hash it, and delegate. The differences are that the domain validator narrows an action rather
   * than a whole request, and the store takes the per-instance concurrency lock.
   *
   * @throws DomainError `PROJECT_ACCESS_DENIED`, `VALIDATION_FAILED`, `INSTANCE_NOT_FOUND`,
   *   `INSTANCE_BUSY`, or `IDEMPOTENCY_CONFLICT`.
   */
  public async mutateInstancePower(input: PowerInstanceInput): Promise<AcceptedMutation> {
    return this.telemetry.trace(
      'controlplane.command.accept',
      {
        'command.type': 'power_instance',
        'cloud.project.id': input.projectId,
      },
      async () => {
        try {
          this.authorize(input.actor, input.projectId);
          this.assertIdempotencyKey(input.idempotencyKey);
          const action = validatePowerAction(input.action);

          const activeTrace = this.telemetry.currentTraceContext({
            traceparent: input.traceparent,
            ...(input.tracestate ? { tracestate: input.tracestate } : {}),
          });
          const command: PowerInstanceCommand = {
            actor: input.actor,
            projectId: input.projectId,
            instanceId: input.instanceId,
            idempotencyKey: input.idempotencyKey,
            correlationId: input.correlationId,
            traceparent: activeTrace.traceparent,
            ...(activeTrace.tracestate ? { tracestate: activeTrace.tracestate } : {}),
            action,
          };
          // WHY the instance is in the hash: reusing one key against a *different* instance is a
          // client bug, and replaying the first instance's response would report success for a
          // machine the caller never named.
          const requestHash = canonicalSha256({
            actor: input.actor.subject,
            projectId: input.projectId,
            operation: 'power_instance',
            instanceId: input.instanceId,
            action,
          });
          const accepted = await this.store.acceptPowerAction(command, requestHash);
          this.telemetry.commandAccepted(
            'power_instance',
            accepted.replayed ? 'replayed' : 'accepted',
          );
          return accepted;
        } catch (error: unknown) {
          this.telemetry.commandAccepted('power_instance', 'rejected');
          throw error;
        }
      },
    );
  }

  /**
   * Accepts a resize as durable intent.
   *
   * The sizing rules — no shrink, no no-op, quota headroom — live in the domain and the store
   * rather than here, because they need the instance's current sizing read under the acceptance
   * lock. This method's job is authorization, key bounds, and the request identity.
   *
   * @throws DomainError `PROJECT_ACCESS_DENIED`, `VALIDATION_FAILED`, `INSTANCE_NOT_FOUND`,
   *   `INSTANCE_BUSY`, `DISK_SHRINK_FORBIDDEN`, `QUOTA_EXCEEDED`, or `IDEMPOTENCY_CONFLICT`.
   */
  public async resizeInstance(input: ResizeInstanceInput): Promise<AcceptedMutation> {
    return this.telemetry.trace(
      'controlplane.command.accept',
      { 'command.type': 'resize_instance', 'cloud.project.id': input.projectId },
      async () => {
        try {
          this.authorize(input.actor, input.projectId);
          this.assertIdempotencyKey(input.idempotencyKey);

          const activeTrace = this.telemetry.currentTraceContext({
            traceparent: input.traceparent,
            ...(input.tracestate ? { tracestate: input.tracestate } : {}),
          });
          const command: ResizeInstanceCommand = {
            actor: input.actor,
            projectId: input.projectId,
            instanceId: input.instanceId,
            idempotencyKey: input.idempotencyKey,
            correlationId: input.correlationId,
            traceparent: activeTrace.traceparent,
            ...(activeTrace.tracestate ? { tracestate: activeTrace.tracestate } : {}),
            flavorId: input.flavorId,
            ...(input.diskGiB === undefined ? {} : { diskGiB: input.diskGiB }),
          };
          const requestHash = canonicalSha256({
            actor: input.actor.subject,
            projectId: input.projectId,
            operation: 'resize_instance',
            instanceId: input.instanceId,
            flavorId: input.flavorId,
            // Part of the identity: the same key with a different disk size is a different
            // request, and replaying the first response would report a growth that never happened.
            diskGiB: input.diskGiB ?? null,
          });
          const accepted = await this.store.acceptResize(command, requestHash);
          this.telemetry.commandAccepted(
            'resize_instance',
            accepted.replayed ? 'replayed' : 'accepted',
          );
          return accepted;
        } catch (error: unknown) {
          this.telemetry.commandAccepted('resize_instance', 'rejected');
          throw error;
        }
      },
    );
  }

  /**
   * Accepts a snapshot creation as durable intent.
   *
   * @throws DomainError `PROJECT_ACCESS_DENIED`, `VALIDATION_FAILED`, `INSTANCE_NOT_FOUND`,
   *   `INSTANCE_BUSY`, `QUOTA_EXCEEDED`, or `IDEMPOTENCY_CONFLICT`.
   */
  public async createSnapshot(input: CreateSnapshotInput): Promise<AcceptedMutation> {
    return this.acceptSnapshot('create_snapshot', input.projectId, input.actor, async () => {
      this.assertIdempotencyKey(input.idempotencyKey);
      validateSnapshotName(input.name);
      const activeTrace = this.telemetry.currentTraceContext({
        traceparent: input.traceparent,
        ...(input.tracestate ? { tracestate: input.tracestate } : {}),
      });
      const command: CreateSnapshotCommand = {
        actor: input.actor,
        projectId: input.projectId,
        instanceId: input.instanceId,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        traceparent: activeTrace.traceparent,
        ...(activeTrace.tracestate ? { tracestate: activeTrace.tracestate } : {}),
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
      };
      return this.store.acceptSnapshotCreate(
        command,
        canonicalSha256({
          actor: input.actor.subject,
          projectId: input.projectId,
          operation: 'create_snapshot',
          instanceId: input.instanceId,
          name: input.name,
          description: input.description ?? null,
        }),
      );
    });
  }

  /**
   * Accepts a rollback to an existing snapshot.
   *
   * WHY this is not gated behind an extra confirmation: a rollback discards everything written
   * since the snapshot, which is exactly what the caller asked for. The guard that matters is
   * ownership — the snapshot must belong to the instance named — and that lives in the store where
   * it can be checked under the same lock that accepts the operation.
   *
   * @throws DomainError `PROJECT_ACCESS_DENIED`, `SNAPSHOT_NOT_FOUND`,
   *   `SNAPSHOT_OWNERSHIP_MISMATCH`, `INSTANCE_BUSY`, or `IDEMPOTENCY_CONFLICT`.
   */
  public async rollbackSnapshot(input: SnapshotActionInput): Promise<AcceptedMutation> {
    return this.snapshotAction('rollback_snapshot', input);
  }

  /**
   * Accepts the deletion of an existing snapshot.
   *
   * @throws DomainError `PROJECT_ACCESS_DENIED`, `SNAPSHOT_NOT_FOUND`,
   *   `SNAPSHOT_OWNERSHIP_MISMATCH`, `INSTANCE_BUSY`, or `IDEMPOTENCY_CONFLICT`.
   */
  public async deleteSnapshot(input: SnapshotActionInput): Promise<AcceptedMutation> {
    return this.snapshotAction('delete_snapshot', input);
  }

  /** Lists an instance's snapshots. */
  public listSnapshots(
    actor: Actor,
    projectId: string,
    instanceId: string,
    limit = DEFAULT_PAGE_LIMIT,
    cursor?: string,
  ): Promise<Page<SnapshotView>> {
    this.authorize(actor, projectId);
    return this.store.listSnapshots(projectId, instanceId, this.page(limit, cursor));
  }

  /** Shared acceptance shape for rollback and delete, which differ only in the action. */
  private async snapshotAction(
    action: 'rollback_snapshot' | 'delete_snapshot',
    input: SnapshotActionInput,
  ): Promise<AcceptedMutation> {
    return this.acceptSnapshot(action, input.projectId, input.actor, async () => {
      this.assertIdempotencyKey(input.idempotencyKey);
      const activeTrace = this.telemetry.currentTraceContext({
        traceparent: input.traceparent,
        ...(input.tracestate ? { tracestate: input.tracestate } : {}),
      });
      const command: SnapshotActionCommand = {
        actor: input.actor,
        projectId: input.projectId,
        instanceId: input.instanceId,
        snapshotId: input.snapshotId,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        traceparent: activeTrace.traceparent,
        ...(activeTrace.tracestate ? { tracestate: activeTrace.tracestate } : {}),
      };
      return this.store.acceptSnapshotAction(
        action,
        command,
        canonicalSha256({
          actor: input.actor.subject,
          projectId: input.projectId,
          operation: action,
          instanceId: input.instanceId,
          snapshotId: input.snapshotId,
        }),
      );
    });
  }

  /** Wraps a snapshot acceptance in the shared span, authorization, and outcome metric. */
  private async acceptSnapshot(
    action: string,
    projectId: string,
    actor: Actor,
    accept: () => Promise<AcceptedMutation>,
  ): Promise<AcceptedMutation> {
    return this.telemetry.trace(
      'controlplane.command.accept',
      { 'command.type': action, 'cloud.project.id': projectId },
      async () => {
        try {
          this.authorize(actor, projectId);
          const accepted = await accept();
          this.telemetry.commandAccepted(action, accepted.replayed ? 'replayed' : 'accepted');
          return accepted;
        } catch (error: unknown) {
          this.telemetry.commandAccepted(action, 'rejected');
          throw error;
        }
      },
    );
  }

  /**
   * Accepts a soft deletion as durable intent.
   *
   * "Delete" here detaches tenant access and retains the provider resource for review; only an
   * administrative purge destroys it. See SAFE-028 and ADR 0007.
   *
   * @throws DomainError `PROJECT_ACCESS_DENIED`, `VALIDATION_FAILED`, `INSTANCE_NOT_FOUND`,
   *   `INSTANCE_BUSY`, or `IDEMPOTENCY_CONFLICT`.
   */
  public async retainInstance(input: RetainInstanceInput): Promise<AcceptedMutation> {
    return this.acceptSnapshot('retain_instance', input.projectId, input.actor, async () => {
      this.assertIdempotencyKey(input.idempotencyKey);
      const activeTrace = this.telemetry.currentTraceContext({
        traceparent: input.traceparent,
        ...(input.tracestate ? { tracestate: input.tracestate } : {}),
      });
      const command: RetainInstanceCommand = {
        actor: input.actor,
        projectId: input.projectId,
        instanceId: input.instanceId,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        traceparent: activeTrace.traceparent,
        ...(activeTrace.tracestate ? { tracestate: activeTrace.tracestate } : {}),
      };
      return this.store.acceptRetention(
        command,
        canonicalSha256({
          actor: input.actor.subject,
          projectId: input.projectId,
          operation: 'retain_instance',
          instanceId: input.instanceId,
        }),
      );
    });
  }

  /**
   * Accepts an administrative purge as durable intent.
   *
   * Authorized by the administrator role, not project membership: purge crosses projects by
   * design. The guards that make it safe — the confirmation, the retained state, the expired
   * deadline, and live provider ownership — live in the store and the workflow, where they can be
   * checked against state rather than against a request.
   *
   * @throws DomainError `ADMIN_REQUIRED`, `VALIDATION_FAILED`, `INSTANCE_NOT_FOUND`,
   *   `INSTANCE_BUSY`, or `IDEMPOTENCY_CONFLICT`.
   */
  public async purgeInstance(input: PurgeInstanceInput): Promise<AcceptedMutation> {
    return this.telemetry.trace(
      'controlplane.command.accept',
      { 'command.type': 'purge_instance' },
      async () => {
        try {
          this.authorizeAdministrator(input.actor);
          this.assertIdempotencyKey(input.idempotencyKey);
          if (input.reason.trim().length < 10) {
            // The reason is the only durable record of *why* a machine was destroyed, so an empty
            // or throwaway justification is refused rather than stored.
            throw new DomainError(
              'VALIDATION_FAILED',
              'A purge reason of at least 10 characters is required.',
            );
          }

          const activeTrace = this.telemetry.currentTraceContext({
            traceparent: input.traceparent,
            ...(input.tracestate ? { tracestate: input.tracestate } : {}),
          });
          const command: PurgeInstanceCommand = {
            actor: input.actor,
            instanceId: input.instanceId,
            idempotencyKey: input.idempotencyKey,
            correlationId: input.correlationId,
            traceparent: activeTrace.traceparent,
            ...(activeTrace.tracestate ? { tracestate: activeTrace.tracestate } : {}),
            reason: input.reason,
            confirmInstanceId: input.confirmInstanceId,
          };
          const accepted = await this.store.acceptPurge(
            command,
            canonicalSha256({
              actor: input.actor.subject,
              operation: 'purge_instance',
              instanceId: input.instanceId,
            }),
          );
          this.telemetry.commandAccepted(
            'purge_instance',
            accepted.replayed ? 'replayed' : 'accepted',
          );
          return accepted;
        } catch (error: unknown) {
          this.telemetry.commandAccepted('purge_instance', 'rejected');
          throw error;
        }
      },
    );
  }

  /**
   * Marks an instance for reconciliation on the next sweep.
   *
   * Returns immediately: the sweep owns the provider budget, so this records a request rather than
   * performing an observation.
   *
   * @throws DomainError `ADMIN_REQUIRED` or `INSTANCE_NOT_FOUND`.
   */
  public async requestReconciliation(actor: Actor, instanceId: string): Promise<void> {
    this.authorizeAdministrator(actor);
    const marked = await this.store.requestReconciliation(instanceId);
    if (!marked) {
      throw new DomainError('INSTANCE_NOT_FOUND', 'The requested instance does not exist.');
    }
  }

  /** Reads a project. @throws DomainError `PROJECT_ACCESS_DENIED` or `PROJECT_NOT_FOUND`. */
  public async getProject(actor: Actor, projectId: string): Promise<ProjectView> {
    this.authorize(actor, projectId);
    return this.required(await this.store.getProject(projectId), 'PROJECT_NOT_FOUND');
  }

  /** Reads quota limits and current usage. @throws DomainError `PROJECT_NOT_FOUND`. */
  public async getQuota(actor: Actor, projectId: string): Promise<QuotaView> {
    this.authorize(actor, projectId);
    return this.required(await this.store.getQuota(projectId), 'PROJECT_NOT_FOUND');
  }

  /** Lists bootable images available to the project. */
  public listImages(
    actor: Actor,
    projectId: string,
    limit = DEFAULT_PAGE_LIMIT,
    cursor?: string,
  ): Promise<Page<ImageView>> {
    this.authorize(actor, projectId);
    return this.store.listImages(projectId, this.page(limit, cursor));
  }

  /** Lists sizing templates available to the project. */
  public listFlavors(
    actor: Actor,
    projectId: string,
    limit = DEFAULT_PAGE_LIMIT,
    cursor?: string,
  ): Promise<Page<FlavorView>> {
    this.authorize(actor, projectId);
    return this.store.listFlavors(projectId, this.page(limit, cursor));
  }

  /** Lists networks an instance may attach to. */
  public listNetworks(
    actor: Actor,
    projectId: string,
    limit = DEFAULT_PAGE_LIMIT,
    cursor?: string,
  ): Promise<Page<NetworkView>> {
    this.authorize(actor, projectId);
    return this.store.listNetworks(projectId, this.page(limit, cursor));
  }

  /** Reads one instance. @throws DomainError `INSTANCE_NOT_FOUND`. */
  public async getInstance(
    actor: Actor,
    projectId: string,
    instanceId: string,
  ): Promise<InstanceView> {
    this.authorize(actor, projectId);
    return this.required(await this.store.getInstance(projectId, instanceId), 'INSTANCE_NOT_FOUND');
  }

  /** Lists the project's instances, most recently updated first. */
  public listInstances(
    actor: Actor,
    projectId: string,
    limit = DEFAULT_PAGE_LIMIT,
    cursor?: string,
  ): Promise<Page<InstanceView>> {
    this.authorize(actor, projectId);
    return this.store.listInstances(projectId, this.page(limit, cursor));
  }

  /** Reads one operation — the record a client polls after a mutation. */
  public async getOperation(
    actor: Actor,
    projectId: string,
    operationId: string,
  ): Promise<OperationView> {
    this.authorize(actor, projectId);
    return this.required(
      await this.store.getOperation(projectId, operationId),
      'OPERATION_NOT_FOUND',
    );
  }

  /** Lists the project's operations, most recently updated first. */
  public listOperations(
    actor: Actor,
    projectId: string,
    limit = DEFAULT_PAGE_LIMIT,
    cursor?: string,
  ): Promise<Page<OperationView>> {
    this.authorize(actor, projectId);
    return this.store.listOperations(projectId, this.page(limit, cursor));
  }

  /** Lists governed dead-letter evidence for a platform administrator. */
  public listDeadLetters(
    actor: Actor,
    limit = DEFAULT_PAGE_LIMIT,
    cursor?: string,
  ): Promise<Page<DeadLetterView>> {
    this.authorizeAdministrator(actor);
    return this.store.listDeadLetters(this.page(limit, cursor));
  }

  /** Lists attributed audit facts for a platform administrator, most recent first. */
  public listAuditEvents(
    actor: Actor,
    filter: AuditEventFilter = {},
    limit = DEFAULT_PAGE_LIMIT,
    cursor?: string,
  ): Promise<Page<AuditEventView>> {
    this.authorizeAdministrator(actor);
    return this.store.listAuditEvents(filter, this.page(limit, cursor));
  }

  /**
   * Reads one operation with recovery metadata, without requiring project membership.
   *
   * WHY: an administrator who authorizes a replay receives a `statusUrl` pointing at the
   * tenant operation route, which demands `tenant_developer` plus membership in the affected
   * project. Administrators are routinely members of neither, so without this route the
   * administrator cannot follow up on their own action.
   *
   * @throws DomainError `OPERATION_NOT_FOUND` when no such operation exists.
   */
  public async getAdministrativeOperation(
    actor: Actor,
    operationId: string,
  ): Promise<AdministrativeOperationView> {
    this.authorizeAdministrator(actor);
    return this.required(
      await this.store.getAdministrativeOperation(operationId),
      'OPERATION_NOT_FOUND',
    );
  }

  /** Accepts attributed replay intent; the original command is restored asynchronously. */
  public async requestDeadLetterReplay(input: ReplayDeadLetterInput): Promise<AcceptedMutation> {
    try {
      this.authorizeAdministrator(input.actor);
      if (
        input.idempotencyKey.length < IDEMPOTENCY_KEY_MINIMUM_LENGTH ||
        input.idempotencyKey.length > IDEMPOTENCY_KEY_MAXIMUM_LENGTH
      ) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'Idempotency key must contain 8 to 128 characters.',
        );
      }
      const reason = input.reason.trim();
      if (reason.length < 10 || reason.length > 512) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'Replay reason must contain 10 to 512 characters.',
        );
      }

      const failedTrace = await this.store.getDeadLetterTraceContext(input.originalEventId);
      return await this.telemetry.trace(
        'controlplane.replay.request',
        { 'command.type': 'replay_dead_letter' },
        async () => {
          const activeTrace = this.telemetry.currentTraceContext({
            traceparent: input.traceparent,
            ...(input.tracestate ? { tracestate: input.tracestate } : {}),
          });
          const command: ReplayDeadLetterCommand = {
            ...input,
            reason,
            traceparent: activeTrace.traceparent,
            ...(activeTrace.tracestate ? { tracestate: activeTrace.tracestate } : {}),
          };
          const accepted = await this.store.requestDeadLetterReplay(
            command,
            canonicalSha256({ originalEventId: input.originalEventId, reason }),
          );
          this.telemetry.commandAccepted(
            'replay_dead_letter',
            accepted.replayed ? 'replayed' : 'accepted',
          );
          return accepted;
        },
        undefined,
        failedTrace ? [failedTrace] : [],
      );
    } catch (error: unknown) {
      this.telemetry.commandAccepted('replay_dead_letter', 'rejected');
      throw error;
    }
  }

  /**
   * Rejects any caller without the role and explicit project membership.
   *
   * WHY project membership is checked here rather than left to a route guard: the guard sees
   * only the transport's view of a request, and gRPC carries the project inside the message
   * body rather than the path. Enforcing at the service means both transports get the same
   * rule from the same line of code.
   *
   * Phase 3 recognises one role. Richer role modelling arrives with the admin surface.
   *
   * @throws DomainError `PROJECT_ACCESS_DENIED`.
   */
  private authorize(actor: Actor, projectId: string): void {
    if (!actor.roles.includes('tenant_developer') || !actor.projects.includes(projectId)) {
      throw new DomainError('PROJECT_ACCESS_DENIED', 'Project access is denied.');
    }
  }

  /** Administrative recovery is never inferred from project membership. */
  private authorizeAdministrator(actor: Actor): void {
    if (!actor.roles.includes('platform_administrator')) {
      throw new DomainError('ADMIN_REQUIRED', 'Platform administrator access is required.');
    }
  }

  /**
   * Clamps a requested page size into the permitted range.
   *
   * Silently substitutes the default for anything invalid rather than rejecting the request.
   * A nonsensical `?limit=` is not worth failing a read over, and the transports already
   * reject non-numeric values before this point.
   */
  /**
   * Bounds a caller-supplied idempotency key.
   *
   * Checked here rather than in the DTO because gRPC callers do not pass through
   * class-validator, and both transports must enforce the same rule.
   *
   * @throws DomainError `VALIDATION_FAILED` when the key is too short or too long.
   */
  private assertIdempotencyKey(key: string): void {
    if (
      key.length < IDEMPOTENCY_KEY_MINIMUM_LENGTH ||
      key.length > IDEMPOTENCY_KEY_MAXIMUM_LENGTH
    ) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'Idempotency key must contain 8 to 128 characters.',
      );
    }
  }

  private limit(value: number): number {
    return Number.isInteger(value) && value >= 1 && value <= MAXIMUM_PAGE_LIMIT
      ? value
      : DEFAULT_PAGE_LIMIT;
  }

  /**
   * Builds a store page request from transport-supplied paging values.
   *
   * The cursor is passed through unvalidated on purpose: only the store knows the encoding it
   * issued, so only the store can tell a corrupt token from a valid one.
   */
  private page(limit: number, cursor?: string): PageRequest {
    return { limit: this.limit(limit), ...(cursor ? { cursor } : {}) };
  }

  /**
   * Converts a store's `null` into the right domain error.
   *
   * The store reports absence as `null` and stays out of the business of naming it; choosing
   * between `INSTANCE_NOT_FOUND` and `PROJECT_NOT_FOUND` is an application decision, which is
   * why the mapping lives here.
   */
  private required<T>(
    value: T | null,
    code: 'INSTANCE_NOT_FOUND' | 'OPERATION_NOT_FOUND' | 'PROJECT_NOT_FOUND',
  ): T {
    if (value === null) throw new DomainError(code, 'The requested resource was not found.');
    return value;
  }
}
