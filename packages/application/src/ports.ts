import type { components } from '@private-cloud/contracts';
import type {
  InstanceCreateRequestedV1,
  InstanceMutationCompletedV1,
  InstanceMutationFailedV1,
  WorkflowProgressedV1,
} from '@private-cloud/contracts';

export type ProjectView = components['schemas']['Project'];
export type QuotaView = components['schemas']['QuotaSet'];
export type ImageView = components['schemas']['Image'];
export type FlavorView = components['schemas']['Flavor'];
export type NetworkView = components['schemas']['Network'];
export type InstanceView = components['schemas']['Instance'];
export type OperationView = components['schemas']['Operation'];
export type AcceptedMutation = components['schemas']['MutationAccepted'];

export interface Actor {
  readonly subject: string;
  readonly roles: readonly string[];
  readonly projects: readonly string[];
}

export interface CreateInstanceCommand {
  readonly actor: Actor;
  readonly projectId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly traceparent: string;
  readonly imageId: string;
  readonly flavorId: string;
  readonly networkId: string;
  readonly hostname: string;
  readonly sshPublicKeys: readonly string[];
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: { readonly limit: number; readonly nextCursor: string | null };
}

export interface ControlPlaneStore {
  acceptCreate(command: CreateInstanceCommand, requestHash: string): Promise<AcceptedMutation>;
  getProject(projectId: string): Promise<ProjectView | null>;
  getQuota(projectId: string): Promise<QuotaView | null>;
  listImages(projectId: string, limit: number): Promise<Page<ImageView>>;
  listFlavors(projectId: string, limit: number): Promise<Page<FlavorView>>;
  listNetworks(projectId: string, limit: number): Promise<Page<NetworkView>>;
  getInstance(projectId: string, instanceId: string): Promise<InstanceView | null>;
  listInstances(projectId: string, limit: number): Promise<Page<InstanceView>>;
  getOperation(projectId: string, operationId: string): Promise<OperationView | null>;
  listOperations(projectId: string, limit: number): Promise<Page<OperationView>>;
}

export interface ClaimedCreateWorkflow {
  readonly command: InstanceCreateRequestedV1;
  readonly stage: string;
  readonly attempt: number;
  readonly fencingToken: bigint;
  readonly providerResourceId?: string;
  readonly providerTaskReference?: string;
}

export type WorkflowEvent =
  | WorkflowProgressedV1
  | InstanceMutationCompletedV1
  | InstanceMutationFailedV1;

export interface WorkflowStore {
  claimNextCreate(workerId: string, leaseSeconds: number): Promise<ClaimedCreateWorkflow | null>;
  checkpoint(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly fencingToken: bigint;
    readonly stage: string;
    readonly providerResourceId?: string;
    readonly providerTaskReference?: string | null;
    readonly nextAttemptAt?: Date;
    readonly event: WorkflowEvent;
  }): Promise<void>;
  complete(input: {
    readonly operationId: string;
    readonly workerId: string;
    readonly fencingToken: bigint;
    readonly status: 'succeeded' | 'failed' | 'manual_review';
    readonly event: WorkflowEvent;
  }): Promise<void>;
}

export interface ProjectionStore {
  applyNextWorkflowEvent(): Promise<boolean>;
}
