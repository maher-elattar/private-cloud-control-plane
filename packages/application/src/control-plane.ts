import { canonicalSha256, DomainError, validateCreateInstance } from '@private-cloud/domain';
import type {
  AcceptedMutation,
  Actor,
  ControlPlaneStore,
  CreateInstanceCommand,
  FlavorView,
  ImageView,
  InstanceView,
  NetworkView,
  OperationView,
  Page,
  ProjectView,
  QuotaView,
} from './ports.js';

export interface CreateInstanceInput {
  readonly actor: Actor;
  readonly projectId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly traceparent: string;
  readonly imageId: string;
  readonly flavorId: string;
  readonly networkId: string;
  readonly hostname: string;
  readonly sshPublicKeys?: readonly string[];
}

export class ControlPlaneApplication {
  public constructor(private readonly store: ControlPlaneStore) {}

  public async createInstance(input: CreateInstanceInput): Promise<AcceptedMutation> {
    this.authorize(input.actor, input.projectId);
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'Idempotency key must contain 8 to 128 characters.',
      );
    }
    validateCreateInstance(input);
    const command: CreateInstanceCommand = {
      ...input,
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
      sshPublicKeys: [...(input.sshPublicKeys ?? [])].sort(),
    });
    return this.store.acceptCreate(command, requestHash);
  }

  public async getProject(actor: Actor, projectId: string): Promise<ProjectView> {
    this.authorize(actor, projectId);
    return this.required(await this.store.getProject(projectId), 'PROJECT_NOT_FOUND');
  }

  public async getQuota(actor: Actor, projectId: string): Promise<QuotaView> {
    this.authorize(actor, projectId);
    return this.required(await this.store.getQuota(projectId), 'PROJECT_NOT_FOUND');
  }

  public listImages(actor: Actor, projectId: string, limit = 50): Promise<Page<ImageView>> {
    this.authorize(actor, projectId);
    return this.store.listImages(projectId, this.limit(limit));
  }

  public listFlavors(actor: Actor, projectId: string, limit = 50): Promise<Page<FlavorView>> {
    this.authorize(actor, projectId);
    return this.store.listFlavors(projectId, this.limit(limit));
  }

  public listNetworks(actor: Actor, projectId: string, limit = 50): Promise<Page<NetworkView>> {
    this.authorize(actor, projectId);
    return this.store.listNetworks(projectId, this.limit(limit));
  }

  public async getInstance(
    actor: Actor,
    projectId: string,
    instanceId: string,
  ): Promise<InstanceView> {
    this.authorize(actor, projectId);
    return this.required(await this.store.getInstance(projectId, instanceId), 'INSTANCE_NOT_FOUND');
  }

  public listInstances(actor: Actor, projectId: string, limit = 50): Promise<Page<InstanceView>> {
    this.authorize(actor, projectId);
    return this.store.listInstances(projectId, this.limit(limit));
  }

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

  public listOperations(actor: Actor, projectId: string, limit = 50): Promise<Page<OperationView>> {
    this.authorize(actor, projectId);
    return this.store.listOperations(projectId, this.limit(limit));
  }

  private authorize(actor: Actor, projectId: string): void {
    if (!actor.roles.includes('tenant_developer') || !actor.projects.includes(projectId)) {
      throw new DomainError('PROJECT_ACCESS_DENIED', 'Project access is denied.');
    }
  }

  private limit(value: number): number {
    return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 50;
  }

  private required<T>(
    value: T | null,
    code: 'INSTANCE_NOT_FOUND' | 'OPERATION_NOT_FOUND' | 'PROJECT_NOT_FOUND',
  ): T {
    if (value === null) throw new DomainError(code, 'The requested resource was not found.');
    return value;
  }
}
