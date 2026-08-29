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
import { canonicalSha256, DomainError, validateCreateInstance } from '@private-cloud/domain';
import type {
  AcceptedMutation,
  Actor,
  ControlPlaneStore,
  CreateInstanceCommand,
  DeadLetterView,
  FlavorView,
  ImageView,
  InstanceView,
  NetworkView,
  OperationView,
  Page,
  ProjectView,
  QuotaView,
  ReplayDeadLetterCommand,
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

          // Checked here rather than in the DTO because gRPC callers do not pass through
          // class-validator, and both transports must enforce the same rule.
          if (
            input.idempotencyKey.length < IDEMPOTENCY_KEY_MINIMUM_LENGTH ||
            input.idempotencyKey.length > IDEMPOTENCY_KEY_MAXIMUM_LENGTH
          ) {
            throw new DomainError(
              'VALIDATION_FAILED',
              'Idempotency key must contain 8 to 128 characters.',
            );
          }
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
  ): Promise<Page<ImageView>> {
    this.authorize(actor, projectId);
    return this.store.listImages(projectId, this.limit(limit));
  }

  /** Lists sizing templates available to the project. */
  public listFlavors(
    actor: Actor,
    projectId: string,
    limit = DEFAULT_PAGE_LIMIT,
  ): Promise<Page<FlavorView>> {
    this.authorize(actor, projectId);
    return this.store.listFlavors(projectId, this.limit(limit));
  }

  /** Lists networks an instance may attach to. */
  public listNetworks(
    actor: Actor,
    projectId: string,
    limit = DEFAULT_PAGE_LIMIT,
  ): Promise<Page<NetworkView>> {
    this.authorize(actor, projectId);
    return this.store.listNetworks(projectId, this.limit(limit));
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
  ): Promise<Page<InstanceView>> {
    this.authorize(actor, projectId);
    return this.store.listInstances(projectId, this.limit(limit));
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
  ): Promise<Page<OperationView>> {
    this.authorize(actor, projectId);
    return this.store.listOperations(projectId, this.limit(limit));
  }

  /** Lists governed dead-letter evidence for a platform administrator. */
  public listDeadLetters(actor: Actor, limit = DEFAULT_PAGE_LIMIT): Promise<Page<DeadLetterView>> {
    this.authorizeAdministrator(actor);
    return this.store.listDeadLetters(this.limit(limit));
  }

  /** Accepts attributed replay intent; the original command is restored asynchronously. */
  public requestDeadLetterReplay(input: ReplayDeadLetterInput): Promise<AcceptedMutation> {
    return this.telemetry.trace(
      'controlplane.command.accept',
      { 'command.type': 'replay_dead_letter' },
      async () => {
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
        } catch (error: unknown) {
          this.telemetry.commandAccepted('replay_dead_letter', 'rejected');
          throw error;
        }
      },
    );
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
  private limit(value: number): number {
    return Number.isInteger(value) && value >= 1 && value <= MAXIMUM_PAGE_LIMIT
      ? value
      : DEFAULT_PAGE_LIMIT;
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
