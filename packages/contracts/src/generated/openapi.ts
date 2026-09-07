export interface paths {
  readonly '/health/live': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path?: never;
      readonly cookie?: never;
    };
    /** Report process liveness */
    readonly get: operations['getLiveness'];
    readonly put?: never;
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/health/ready': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path?: never;
      readonly cookie?: never;
    };
    /** Report dependency readiness */
    readonly get: operations['getReadiness'];
    readonly put?: never;
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/audit-events': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path?: never;
      readonly cookie?: never;
    };
    /** List attributed audit events */
    readonly get: operations['listAuditEvents'];
    readonly put?: never;
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/catalog/flavors/{flavorId}': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        readonly flavorId: components['parameters']['FlavorId'];
      };
      readonly cookie?: never;
    };
    readonly get?: never;
    /** Create or replace a flavor */
    readonly put: operations['upsertFlavor'];
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/catalog/images/{imageId}': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        readonly imageId: components['parameters']['ImageId'];
      };
      readonly cookie?: never;
    };
    readonly get?: never;
    /** Create or replace an image mapping */
    readonly put: operations['upsertImage'];
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/catalog/networks/{networkId}': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        readonly networkId: components['parameters']['NetworkId'];
      };
      readonly cookie?: never;
    };
    readonly get?: never;
    /** Create or replace a network */
    readonly put: operations['upsertNetwork'];
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/dead-letters': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path?: never;
      readonly cookie?: never;
    };
    /** List dead-letter evidence */
    readonly get: operations['listDeadLetters'];
    readonly put?: never;
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/dead-letters/{eventId}/replays': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        readonly eventId: components['parameters']['EventId'];
      };
      readonly cookie?: never;
    };
    readonly get?: never;
    readonly put?: never;
    /** Accept an attributed dead-letter replay */
    readonly post: operations['replayDeadLetter'];
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/instances/{instanceId}/purges': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral instance UUID. */
        readonly instanceId: components['parameters']['InstanceId'];
      };
      readonly cookie?: never;
    };
    readonly get?: never;
    readonly put?: never;
    /** Accept an explicit guarded purge command */
    readonly post: operations['purgeInstance'];
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/instances/{instanceId}/reconciliations': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral instance UUID. */
        readonly instanceId: components['parameters']['InstanceId'];
      };
      readonly cookie?: never;
    };
    readonly get?: never;
    readonly put?: never;
    /** Request a non-destructive provider observation */
    readonly post: operations['requestReconciliation'];
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/manual-reviews': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path?: never;
      readonly cookie?: never;
    };
    /** List open or resolved manual-review items */
    readonly get: operations['listManualReviews'];
    readonly put?: never;
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/manual-reviews/{reviewId}': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        readonly reviewId: components['parameters']['ReviewId'];
      };
      readonly cookie?: never;
    };
    /** Read one manual-review item */
    readonly get: operations['getManualReview'];
    readonly put?: never;
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/manual-reviews/{reviewId}/resolutions': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        readonly reviewId: components['parameters']['ReviewId'];
      };
      readonly cookie?: never;
    };
    readonly get?: never;
    readonly put?: never;
    /** Append an attributed manual-review disposition */
    readonly post: operations['resolveManualReview'];
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/operations/{operationId}': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Durable operation UUID. */
        readonly operationId: components['parameters']['OperationId'];
      };
      readonly cookie?: never;
    };
    /** Read one operation with recovery metadata */
    readonly get: operations['getAdministrativeOperation'];
    readonly put?: never;
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/provider-profiles': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path?: never;
      readonly cookie?: never;
    };
    /** List provider profiles */
    readonly get: operations['listProviderProfiles'];
    readonly put?: never;
    /** Create a disabled provider profile */
    readonly post: operations['createProviderProfile'];
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/provider-profiles/{profileId}': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        readonly profileId: components['parameters']['ProfileId'];
      };
      readonly cookie?: never;
    };
    /** Read one provider profile */
    readonly get: operations['getProviderProfile'];
    readonly put?: never;
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    /** Update and disable a provider profile pending validation */
    readonly patch: operations['updateProviderProfile'];
    readonly trace?: never;
  };
  readonly '/v1/admin/provider-profiles/{profileId}/actions/activate': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        readonly profileId: components['parameters']['ProfileId'];
      };
      readonly cookie?: never;
    };
    readonly get?: never;
    readonly put?: never;
    /** Activate a validated provider profile */
    readonly post: operations['activateProviderProfile'];
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/provider-profiles/{profileId}/actions/disable': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        readonly profileId: components['parameters']['ProfileId'];
      };
      readonly cookie?: never;
    };
    readonly get?: never;
    readonly put?: never;
    /** Disable a provider profile */
    readonly post: operations['disableProviderProfile'];
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/provider-profiles/{profileId}/actions/validate': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        readonly profileId: components['parameters']['ProfileId'];
      };
      readonly cookie?: never;
    };
    readonly get?: never;
    readonly put?: never;
    /** Accept a provider-profile validation command */
    readonly post: operations['validateProviderProfile'];
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/admin/retention-policy': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path?: never;
      readonly cookie?: never;
    };
    /** Read the active retention policy */
    readonly get: operations['getRetentionPolicy'];
    /** Replace the retention policy */
    readonly put: operations['updateRetentionPolicy'];
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/projects/{projectId}': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    /** Read an authorized project */
    readonly get: operations['getProject'];
    readonly put?: never;
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/projects/{projectId}/catalog/flavors': {
    readonly parameters: {
      readonly query?: {
        /** @description Opaque continuation cursor; callers must not parse it. */
        readonly cursor?: components['parameters']['Cursor'];
        readonly limit?: components['parameters']['Limit'];
      };
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    /** List enabled provider-neutral flavors */
    readonly get: operations['listFlavors'];
    readonly put?: never;
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/projects/{projectId}/catalog/images': {
    readonly parameters: {
      readonly query?: {
        /** @description Opaque continuation cursor; callers must not parse it. */
        readonly cursor?: components['parameters']['Cursor'];
        readonly limit?: components['parameters']['Limit'];
      };
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    /** List enabled provider-neutral images */
    readonly get: operations['listImages'];
    readonly put?: never;
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/projects/{projectId}/catalog/networks': {
    readonly parameters: {
      readonly query?: {
        /** @description Opaque continuation cursor; callers must not parse it. */
        readonly cursor?: components['parameters']['Cursor'];
        readonly limit?: components['parameters']['Limit'];
      };
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    /** List enabled provider-neutral networks */
    readonly get: operations['listNetworks'];
    readonly put?: never;
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/projects/{projectId}/instances': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    /** List project instances */
    readonly get: operations['listInstances'];
    readonly put?: never;
    /** Accept an instance-create command */
    readonly post: operations['createInstance'];
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/projects/{projectId}/instances/{instanceId}': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral instance UUID. */
        readonly instanceId: components['parameters']['InstanceId'];
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    /** Read one project instance */
    readonly get: operations['getInstance'];
    readonly put?: never;
    readonly post?: never;
    /**
     * Accept a soft-delete retention command
     * @description Normal deletion retains the provider resource; only an administrative purge destroys it.
     */
    readonly delete: operations['retainInstance'];
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/projects/{projectId}/instances/{instanceId}/actions': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral instance UUID. */
        readonly instanceId: components['parameters']['InstanceId'];
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    readonly get?: never;
    readonly put?: never;
    /** Accept a power or resize command */
    readonly post: operations['mutateInstance'];
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/projects/{projectId}/instances/{instanceId}/snapshots': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral instance UUID. */
        readonly instanceId: components['parameters']['InstanceId'];
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    /** List instance-owned snapshots */
    readonly get: operations['listSnapshots'];
    readonly put?: never;
    /** Accept a snapshot-create command */
    readonly post: operations['createSnapshot'];
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/projects/{projectId}/instances/{instanceId}/snapshots/{snapshotId}': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral instance UUID. */
        readonly instanceId: components['parameters']['InstanceId'];
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
        /** @description Provider-neutral snapshot UUID. */
        readonly snapshotId: components['parameters']['SnapshotId'];
      };
      readonly cookie?: never;
    };
    readonly get?: never;
    readonly put?: never;
    readonly post?: never;
    /** Accept a snapshot-delete command */
    readonly delete: operations['deleteSnapshot'];
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/projects/{projectId}/instances/{instanceId}/snapshots/{snapshotId}/actions': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral instance UUID. */
        readonly instanceId: components['parameters']['InstanceId'];
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
        /** @description Provider-neutral snapshot UUID. */
        readonly snapshotId: components['parameters']['SnapshotId'];
      };
      readonly cookie?: never;
    };
    readonly get?: never;
    readonly put?: never;
    /** Accept a snapshot rollback command */
    readonly post: operations['rollbackSnapshot'];
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/projects/{projectId}/operations': {
    readonly parameters: {
      readonly query?: {
        /** @description Opaque continuation cursor; callers must not parse it. */
        readonly cursor?: components['parameters']['Cursor'];
        readonly limit?: components['parameters']['Limit'];
      };
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    /** List project operations */
    readonly get: operations['listOperations'];
    readonly put?: never;
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/projects/{projectId}/operations/{operationId}': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Durable operation UUID. */
        readonly operationId: components['parameters']['OperationId'];
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    /** Read one project operation */
    readonly get: operations['getOperation'];
    readonly put?: never;
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
  readonly '/v1/projects/{projectId}/quota': {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    /** Read project quota limits and usage */
    readonly get: operations['getProjectQuota'];
    readonly put?: never;
    readonly post?: never;
    readonly delete?: never;
    readonly options?: never;
    readonly head?: never;
    readonly patch?: never;
    readonly trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    readonly AdministrativeOperation: components['schemas']['Operation'] & {
      /** Format: uuid */
      readonly causationId?: string | null;
      readonly checkpoint?: string | null;
      /** Format: uuid */
      readonly correlationId?: string;
      /** Format: uuid */
      readonly deadLetterEventId?: string | null;
      readonly providerTaskReference?: string | null;
      readonly retryCount?: number;
      readonly traceId?: string | null;
    };
    readonly AuditEvent: {
      readonly action: string;
      readonly actorId: string;
      /** @enum {string} */
      readonly actorRole:
        | 'tenant_developer'
        | 'platform_operator'
        | 'platform_administrator'
        | 'service';
      /** Format: uuid */
      readonly id: string;
      /** Format: date-time */
      readonly occurredAt: string;
      /** Format: uuid */
      readonly operationId?: string | null;
      /** @enum {string} */
      readonly outcome: 'accepted' | 'succeeded' | 'rejected' | 'failed';
      /** Format: uuid */
      readonly projectId: string | null;
      readonly reason?: string | null;
      readonly targetId: string;
      readonly targetType: string;
    };
    readonly AuditEventPage: {
      readonly items: readonly components['schemas']['AuditEvent'][];
      readonly page: components['schemas']['PageMetadata'];
    };
    readonly CreateInstanceRequest: {
      readonly flavorId: string;
      readonly hostname: string;
      readonly imageId: string;
      readonly networkId: string;
      readonly sshPublicKeys?: readonly string[];
    };
    readonly CreateSnapshotRequest: {
      readonly description?: string;
      readonly name: string;
    };
    readonly DeadLetter: {
      /** Format: uuid */
      readonly aggregateId: string;
      readonly attempts: number;
      readonly category: components['schemas']['ErrorCategory'];
      /** Format: date-time */
      readonly deadLetteredAt: string;
      /** Format: uuid */
      readonly eventId: string;
      /** Format: date-time */
      readonly lastReplayAt?: string | null;
      /** Format: uuid */
      readonly operationId: string;
      /** Format: uuid */
      readonly projectId: string;
      readonly replayAllowed: boolean;
      readonly safeMessage?: string | null;
      readonly schemaName: string;
      readonly schemaVersion: number;
    };
    readonly DeadLetterPage: {
      readonly items: readonly components['schemas']['DeadLetter'][];
      readonly page: components['schemas']['PageMetadata'];
    };
    readonly DesiredInstanceState: {
      readonly flavorId: string;
      readonly hostname: string;
      readonly imageId: string;
      readonly networkId: string;
      readonly powerState: components['schemas']['DesiredPowerState'];
      readonly retentionRequested: boolean;
    };
    /** @enum {string} */
    readonly DesiredPowerState: 'running' | 'stopped' | 'unchanged';
    /** @enum {string} */
    readonly DriftClassification:
      | 'none'
      | 'missing_resource'
      | 'identity_mismatch'
      | 'stale_task'
      | 'late_success'
      | 'power_drift'
      | 'network_drift'
      | 'ambiguous';
    /** @enum {string} */
    readonly ErrorCategory:
      | 'validation'
      | 'authentication'
      | 'authorization'
      | 'not_found'
      | 'conflict'
      | 'quota'
      | 'transient'
      | 'permanent'
      | 'unknown_outcome'
      | 'compensation_failure'
      | 'manual_review'
      | 'internal';
    readonly Flavor: components['schemas']['FlavorInput'] & {
      /** Format: date-time */
      readonly createdAt: string;
      readonly id: string;
      /** Format: date-time */
      readonly updatedAt: string;
    };
    readonly FlavorInput: {
      readonly cpuCount: number;
      readonly enabled: boolean;
      readonly memoryMiB: number;
      readonly minimumDiskGiB: number;
      readonly name: string;
    };
    readonly FlavorPage: {
      readonly items: readonly components['schemas']['Flavor'][];
      readonly page: components['schemas']['PageMetadata'];
    };
    readonly HealthResponse: {
      /** Format: date-time */
      readonly checkedAt: string;
      readonly dependencies?: {
        readonly [key: string]: 'ready' | 'degraded' | 'unavailable' | 'not_applicable';
      };
      readonly service: string;
      /** @enum {string} */
      readonly status: 'ok' | 'unavailable';
    };
    readonly Image: components['schemas']['ImageInput'] & {
      /** Format: date-time */
      readonly createdAt: string;
      readonly id: string;
      /** Format: date-time */
      readonly updatedAt: string;
    };
    readonly ImageInput: {
      /**
       * @default x86_64
       * @enum {string}
       */
      readonly architecture: 'x86_64' | 'arm64';
      readonly enabled: boolean;
      readonly name: string;
      readonly providerProfileId: string;
    };
    readonly ImagePage: {
      readonly items: readonly components['schemas']['Image'][];
      readonly page: components['schemas']['PageMetadata'];
    };
    readonly Instance: {
      /** Format: uuid */
      readonly activeOperationId?: string | null;
      /** Format: date-time */
      readonly createdAt: string;
      readonly desired: components['schemas']['DesiredInstanceState'];
      readonly drift: components['schemas']['DriftClassification'];
      /** Format: uuid */
      readonly id: string;
      readonly ipv4Lease?: components['schemas']['IPv4Lease'] | null;
      /** Format: date-time */
      readonly lastReconciledAt?: string | null;
      readonly lifecycleState: components['schemas']['InstanceLifecycleState'];
      readonly observed?: components['schemas']['ObservedInstanceState'] | null;
      /** Format: uuid */
      readonly projectId: string;
      /** @default false */
      readonly purgeEligible: boolean;
      /** Format: date-time */
      readonly retentionDeadline?: string | null;
      /** Format: date-time */
      readonly updatedAt: string;
    };
    readonly InstanceAction:
      | components['schemas']['PowerAction']
      | components['schemas']['ResizeAction'];
    /** @enum {string} */
    readonly InstanceLifecycleState:
      | 'pending'
      | 'provisioning'
      | 'active'
      | 'updating'
      | 'failed'
      | 'unknown_outcome'
      | 'retained'
      | 'purge_pending'
      | 'purged'
      | 'manual_review';
    readonly InstancePage: {
      readonly items: readonly components['schemas']['Instance'][];
      readonly page: components['schemas']['PageMetadata'];
    };
    readonly InvalidParameter: {
      readonly name: string;
      readonly reason: string;
    };
    readonly IPv4Lease: {
      /** Format: ipv4 */
      readonly address: string;
      /** Format: ipv4 */
      readonly gateway: string;
      readonly prefixLength: number;
      /** @enum {string} */
      readonly state: 'active' | 'quarantined' | 'released';
    };
    readonly ManualReview: {
      /** @enum {string} */
      readonly category:
        | 'unknown_outcome'
        | 'identity_mismatch'
        | 'ambiguous_drift'
        | 'purge_guard'
        | 'compensation_failure';
      /** Format: date-time */
      readonly createdAt: string;
      readonly evidenceReference?: string | null;
      /** Format: uuid */
      readonly id: string;
      /** Format: uuid */
      readonly instanceId: string;
      /** Format: uuid */
      readonly operationId: string;
      readonly resolution?: string | null;
      /** Format: date-time */
      readonly resolvedAt?: string | null;
      readonly state: components['schemas']['ManualReviewState'];
      readonly summary: string;
    };
    readonly ManualReviewPage: {
      readonly items: readonly components['schemas']['ManualReview'][];
      readonly page: components['schemas']['PageMetadata'];
    };
    readonly ManualReviewResolution: {
      /** @enum {string} */
      readonly disposition:
        | 'acknowledged'
        | 'retry_authorized'
        | 'no_action'
        | 'external_remediation_completed';
      readonly reason: string;
    };
    /** @enum {string} */
    readonly ManualReviewState: 'open' | 'resolved';
    readonly MutationAccepted: {
      /** Format: date-time */
      readonly acceptedAt: string;
      /** Format: uuid */
      readonly operationId: string;
      /** @description True when the idempotency key returned the original operation. */
      readonly replayed: boolean;
      /** Format: uri-reference */
      readonly statusUrl: string;
      /** Format: uuid */
      readonly targetId: string;
    };
    readonly Network: components['schemas']['NetworkInput'] & {
      /** Format: date-time */
      readonly createdAt: string;
      readonly id: string;
      /** Format: date-time */
      readonly updatedAt: string;
    };
    readonly NetworkInput: {
      readonly dnsServers: readonly string[];
      readonly enabled: boolean;
      readonly exclusions: readonly string[];
      /** Format: ipv4 */
      readonly gateway: string;
      /** Format: ipv4-cidr */
      readonly ipv4Cidr: string;
      readonly name: string;
    };
    readonly NetworkPage: {
      readonly items: readonly components['schemas']['Network'][];
      readonly page: components['schemas']['PageMetadata'];
    };
    readonly ObservedInstanceState: {
      readonly cpuCount?: number | null;
      readonly diskGiB?: number | null;
      readonly exists: boolean;
      readonly markerMatch: boolean;
      readonly memoryMiB?: number | null;
      /** Format: date-time */
      readonly observedAt: string;
      readonly powerState: components['schemas']['ObservedPowerState'];
    };
    /** @enum {string} */
    readonly ObservedPowerState: 'running' | 'stopped' | 'suspended' | 'unknown';
    readonly Operation: {
      /** Format: date-time */
      readonly acceptedAt: string;
      readonly action: string;
      /** Format: date-time */
      readonly completedAt?: string | null;
      readonly errorCategory?: components['schemas']['ErrorCategory'] | null;
      readonly errorCode?: string | null;
      readonly errorMessage?: string | null;
      /** Format: uuid */
      readonly id: string;
      readonly manualReviewRequired: boolean;
      readonly progressPercent: number;
      /** Format: uuid */
      readonly projectId: string;
      readonly stage: string;
      /** Format: date-time */
      readonly startedAt?: string | null;
      readonly state: components['schemas']['OperationState'];
      readonly targetId: string;
      /** @enum {string} */
      readonly targetType:
        | 'instance'
        | 'snapshot'
        | 'provider_profile'
        | 'retention_policy'
        | 'dead_letter'
        | 'manual_review';
      /** Format: date-time */
      readonly updatedAt: string;
    };
    readonly OperationPage: {
      readonly items: readonly components['schemas']['Operation'][];
      readonly page: components['schemas']['PageMetadata'];
    };
    /** @enum {string} */
    readonly OperationState:
      | 'accepted'
      | 'queued'
      | 'running'
      | 'retry_wait'
      | 'compensating'
      | 'unknown_outcome'
      | 'manual_review'
      | 'succeeded'
      | 'failed'
      | 'cancelled';
    readonly PageMetadata: {
      readonly limit: number;
      readonly nextCursor?: string | null;
    };
    readonly PowerAction: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      readonly action: 'PowerAction';
    };
    readonly ProblemDetails: {
      /** @enum {string} */
      readonly code:
        | 'AUTHENTICATION_REQUIRED'
        | 'ADMIN_REQUIRED'
        | 'PROJECT_ACCESS_DENIED'
        | 'PROJECT_NOT_FOUND'
        | 'INSTANCE_NOT_FOUND'
        | 'SNAPSHOT_NOT_FOUND'
        | 'OPERATION_NOT_FOUND'
        | 'PROFILE_NOT_FOUND'
        | 'DEAD_LETTER_NOT_FOUND'
        | 'MANUAL_REVIEW_NOT_FOUND'
        | 'VALIDATION_FAILED'
        | 'QUOTA_EXCEEDED'
        | 'IDEMPOTENCY_CONFLICT'
        | 'INSTANCE_BUSY'
        | 'SNAPSHOT_OWNERSHIP_MISMATCH'
        | 'DISK_SHRINK_FORBIDDEN'
        | 'PROFILE_DISABLED'
        | 'PROFILE_VALIDATION_REQUIRED'
        | 'LAB_GATE_FAILED'
        | 'REPLAY_NOT_ALLOWED'
        | 'RETENTION_NOT_EXPIRED'
        | 'OWNERSHIP_NOT_PROVEN'
        | 'MANUAL_REVIEW_ALREADY_RESOLVED'
        | 'PAYLOAD_TOO_LARGE'
        | 'RATE_LIMITED'
        | 'DEPENDENCY_UNAVAILABLE'
        | 'INTERNAL_ERROR';
      readonly detail?: string;
      /** Format: uri-reference */
      readonly instance?: string;
      readonly invalidParams?: readonly components['schemas']['InvalidParameter'][];
      /** Format: uuid */
      readonly operationId?: string;
      readonly status: number;
      readonly title: string;
      readonly traceId: string;
      /** Format: uri-reference */
      readonly type: string;
    };
    readonly Project: {
      /** Format: date-time */
      readonly createdAt: string;
      readonly enabled: boolean;
      /** Format: uuid */
      readonly id: string;
      readonly name: string;
      /** Format: date-time */
      readonly updatedAt: string;
    };
    readonly ProviderProfile: components['schemas']['ProviderProfileInput'] & {
      /** Format: date-time */
      readonly createdAt: string;
      /** Format: date-time */
      readonly lastValidatedAt?: string | null;
      /** Format: uuid */
      readonly lastValidationOperationId?: string | null;
      readonly state: components['schemas']['ProviderProfileState'];
      /** Format: date-time */
      readonly updatedAt: string;
      readonly version: number;
    };
    readonly ProviderProfileInput: {
      readonly clusterAlias: string;
      readonly computeTarget: string;
      readonly credentialReference: string;
      /** Format: uri */
      readonly endpoint: string;
      readonly id: string;
      readonly imageSourceReference: string;
      readonly networkAttachment: string;
      readonly networkId: string;
      readonly providerType: string;
      readonly resourceIdMaximum: number;
      readonly resourceIdMinimum: number;
      readonly storageTarget: string;
    };
    readonly ProviderProfilePage: {
      readonly items: readonly components['schemas']['ProviderProfile'][];
      readonly page: components['schemas']['PageMetadata'];
    };
    readonly ProviderProfilePatch: {
      readonly clusterAlias?: string;
      readonly computeTarget?: string;
      readonly credentialReference?: string;
      /** Format: uri */
      readonly endpoint?: string;
      readonly imageSourceReference?: string;
      readonly networkAttachment?: string;
      readonly networkId?: string;
      readonly resourceIdMaximum?: number;
      readonly resourceIdMinimum?: number;
      readonly storageTarget?: string;
    };
    /** @enum {string} */
    readonly ProviderProfileState:
      | 'disabled'
      | 'validation_pending'
      | 'validated'
      | 'active'
      | 'validation_failed';
    readonly PurgeRequest: {
      /** Format: uuid */
      readonly confirmInstanceId: string;
      readonly reason: string;
    };
    readonly QuotaSet: {
      readonly limits: components['schemas']['QuotaValues'];
      /** Format: date-time */
      readonly measuredAt: string;
      /** Format: uuid */
      readonly projectId: string;
      readonly usage: components['schemas']['QuotaValues'];
    };
    readonly QuotaValues: {
      readonly cpuCount: number;
      readonly diskGiB: number;
      readonly instances: number;
      readonly ipv4Addresses: number;
      readonly memoryMiB: number;
      readonly snapshots: number;
    };
    readonly ReconciliationRequest: {
      readonly reason: string;
    };
    readonly ReplayRequest: {
      readonly reason: string;
    };
    readonly ResizeAction: {
      /**
       * @description discriminator enum property added by openapi-typescript
       * @enum {string}
       */
      readonly action: 'ResizeAction';
      readonly diskGiB?: number;
      readonly flavorId: string;
    };
    readonly RetentionPolicy: components['schemas']['RetentionPolicyInput'] & {
      /** Format: date-time */
      readonly updatedAt: string;
      readonly updatedBy: string;
      readonly version: number;
    };
    readonly RetentionPolicyInput: {
      /** @enum {string} */
      readonly leaseReleaseMode: 'quarantine_until_purge' | 'release_on_retain';
      readonly retentionHours: number;
    };
    readonly Snapshot: {
      /** Format: date-time */
      readonly createdAt: string;
      readonly description?: string | null;
      /** Format: uuid */
      readonly id: string;
      /** Format: uuid */
      readonly instanceId: string;
      readonly name: string;
      /** @enum {string} */
      readonly state: 'creating' | 'available' | 'rolling_back' | 'deleting' | 'failed';
      /** Format: date-time */
      readonly updatedAt?: string | null;
    };
    readonly SnapshotPage: {
      readonly items: readonly components['schemas']['Snapshot'][];
      readonly page: components['schemas']['PageMetadata'];
    };
    readonly SnapshotRollbackRequest: {
      /** @constant */
      readonly action: 'rollback';
    };
  };
  responses: {
    /** @description Malformed or invalid request */
    readonly BadRequest: {
      headers: {
        readonly [name: string]: unknown;
      };
      content: {
        readonly 'application/problem+json': components['schemas']['ProblemDetails'];
      };
    };
    /** @description Idempotency, concurrency, ownership, or state conflict */
    readonly Conflict: {
      headers: {
        readonly [name: string]: unknown;
      };
      content: {
        readonly 'application/problem+json': components['schemas']['ProblemDetails'];
      };
    };
    /** @description The actor lacks project or administrator permission */
    readonly Forbidden: {
      headers: {
        readonly [name: string]: unknown;
      };
      content: {
        readonly 'application/problem+json': components['schemas']['ProblemDetails'];
      };
    };
    /** @description Durable intent and operation record committed */
    readonly MutationAccepted: {
      headers: {
        /** @description Operation-status resource. */
        readonly Location: string;
        readonly [name: string]: unknown;
      };
      content: {
        readonly 'application/json': components['schemas']['MutationAccepted'];
      };
    };
    /** @description The authorized resource does not exist */
    readonly NotFound: {
      headers: {
        readonly [name: string]: unknown;
      };
      content: {
        readonly 'application/problem+json': components['schemas']['ProblemDetails'];
      };
    };
    /** @description Request body exceeds 65,536 bytes */
    readonly PayloadTooLarge: {
      headers: {
        readonly [name: string]: unknown;
      };
      content: {
        readonly 'application/problem+json': components['schemas']['ProblemDetails'];
      };
    };
    /** @description A dependency required for this operation is unavailable */
    readonly ServiceUnavailable: {
      headers: {
        readonly [name: string]: unknown;
      };
      content: {
        readonly 'application/problem+json': components['schemas']['ProblemDetails'];
      };
    };
    /** @description Authentication is absent or invalid */
    readonly Unauthorized: {
      headers: {
        readonly [name: string]: unknown;
      };
      content: {
        readonly 'application/problem+json': components['schemas']['ProblemDetails'];
      };
    };
    /** @description Syntactically valid input violates a domain or safety invariant */
    readonly Unprocessable: {
      headers: {
        readonly [name: string]: unknown;
      };
      content: {
        readonly 'application/problem+json': components['schemas']['ProblemDetails'];
      };
    };
  };
  parameters: {
    /** @description Optional caller correlation UUID; the service creates one when absent. */
    readonly CorrelationId: string;
    /** @description Opaque continuation cursor; callers must not parse it. */
    readonly Cursor: string;
    readonly EventId: string;
    readonly FlavorId: string;
    /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
    readonly IdempotencyKey: string;
    readonly ImageId: string;
    /** @description Provider-neutral instance UUID. */
    readonly InstanceId: string;
    readonly Limit: number;
    readonly NetworkId: string;
    /** @description Durable operation UUID. */
    readonly OperationId: string;
    readonly ProfileId: string;
    /** @description Provider-neutral project UUID. */
    readonly ProjectId: string;
    readonly ReviewId: string;
    /** @description Provider-neutral snapshot UUID. */
    readonly SnapshotId: string;
    /** @description W3C Trace Context header. Invalid supplied values are rejected. */
    readonly Traceparent: string;
    /** @description Optional W3C vendor trace state, accepted only with a valid traceparent. */
    readonly Tracestate: string;
  };
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  readonly getLiveness: {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path?: never;
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Process is alive */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['HealthResponse'];
        };
      };
    };
  };
  readonly getReadiness: {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path?: never;
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Required dependencies are ready */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['HealthResponse'];
        };
      };
      readonly 503: components['responses']['ServiceUnavailable'];
    };
  };
  readonly listAuditEvents: {
    readonly parameters: {
      readonly query?: {
        /** @description Opaque continuation cursor; callers must not parse it. */
        readonly cursor?: components['parameters']['Cursor'];
        readonly limit?: components['parameters']['Limit'];
        readonly operationId?: string;
        readonly projectId?: string;
      };
      readonly header?: never;
      readonly path?: never;
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Audit-event page */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['AuditEventPage'];
        };
      };
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
    };
  };
  readonly upsertFlavor: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
      };
      readonly path: {
        readonly flavorId: components['parameters']['FlavorId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody: {
      readonly content: {
        readonly 'application/json': components['schemas']['FlavorInput'];
      };
    };
    readonly responses: {
      /** @description Upserted flavor */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['Flavor'];
        };
      };
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 409: components['responses']['Conflict'];
    };
  };
  readonly upsertImage: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
      };
      readonly path: {
        readonly imageId: components['parameters']['ImageId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody: {
      readonly content: {
        readonly 'application/json': components['schemas']['ImageInput'];
      };
    };
    readonly responses: {
      /** @description Upserted image */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['Image'];
        };
      };
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 409: components['responses']['Conflict'];
    };
  };
  readonly upsertNetwork: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
      };
      readonly path: {
        readonly networkId: components['parameters']['NetworkId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody: {
      readonly content: {
        readonly 'application/json': components['schemas']['NetworkInput'];
      };
    };
    readonly responses: {
      /** @description Upserted network */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['Network'];
        };
      };
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 409: components['responses']['Conflict'];
    };
  };
  readonly listDeadLetters: {
    readonly parameters: {
      readonly query?: {
        /** @description Opaque continuation cursor; callers must not parse it. */
        readonly cursor?: components['parameters']['Cursor'];
        readonly limit?: components['parameters']['Limit'];
      };
      readonly header?: never;
      readonly path?: never;
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Dead-letter page */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['DeadLetterPage'];
        };
      };
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
    };
  };
  readonly replayDeadLetter: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
        /** @description W3C Trace Context header. Invalid supplied values are rejected. */
        readonly traceparent?: components['parameters']['Traceparent'];
        /** @description Optional W3C vendor trace state, accepted only with a valid traceparent. */
        readonly tracestate?: components['parameters']['Tracestate'];
        /** @description Optional caller correlation UUID; the service creates one when absent. */
        readonly 'X-Correlation-ID'?: components['parameters']['CorrelationId'];
      };
      readonly path: {
        readonly eventId: components['parameters']['EventId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody: {
      readonly content: {
        readonly 'application/json': components['schemas']['ReplayRequest'];
      };
    };
    readonly responses: {
      readonly 202: components['responses']['MutationAccepted'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
      readonly 409: components['responses']['Conflict'];
    };
  };
  readonly purgeInstance: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
      };
      readonly path: {
        /** @description Provider-neutral instance UUID. */
        readonly instanceId: components['parameters']['InstanceId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody: {
      readonly content: {
        readonly 'application/json': components['schemas']['PurgeRequest'];
      };
    };
    readonly responses: {
      readonly 202: components['responses']['MutationAccepted'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
      readonly 409: components['responses']['Conflict'];
      readonly 422: components['responses']['Unprocessable'];
    };
  };
  readonly requestReconciliation: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
      };
      readonly path: {
        /** @description Provider-neutral instance UUID. */
        readonly instanceId: components['parameters']['InstanceId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody: {
      readonly content: {
        readonly 'application/json': components['schemas']['ReconciliationRequest'];
      };
    };
    readonly responses: {
      readonly 202: components['responses']['MutationAccepted'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
      readonly 409: components['responses']['Conflict'];
    };
  };
  readonly listManualReviews: {
    readonly parameters: {
      readonly query?: {
        /** @description Opaque continuation cursor; callers must not parse it. */
        readonly cursor?: components['parameters']['Cursor'];
        readonly limit?: components['parameters']['Limit'];
        readonly state?: components['schemas']['ManualReviewState'];
      };
      readonly header?: never;
      readonly path?: never;
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Manual-review page */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['ManualReviewPage'];
        };
      };
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
    };
  };
  readonly getManualReview: {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        readonly reviewId: components['parameters']['ReviewId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Manual-review detail */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['ManualReview'];
        };
      };
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
    };
  };
  readonly resolveManualReview: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
      };
      readonly path: {
        readonly reviewId: components['parameters']['ReviewId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody: {
      readonly content: {
        readonly 'application/json': components['schemas']['ManualReviewResolution'];
      };
    };
    readonly responses: {
      /** @description Resolved manual-review item */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['ManualReview'];
        };
      };
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
      readonly 409: components['responses']['Conflict'];
    };
  };
  readonly getAdministrativeOperation: {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Durable operation UUID. */
        readonly operationId: components['parameters']['OperationId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Administrative operation detail */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['AdministrativeOperation'];
        };
      };
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
    };
  };
  readonly listProviderProfiles: {
    readonly parameters: {
      readonly query?: {
        /** @description Opaque continuation cursor; callers must not parse it. */
        readonly cursor?: components['parameters']['Cursor'];
        readonly limit?: components['parameters']['Limit'];
      };
      readonly header?: never;
      readonly path?: never;
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Provider-profile page */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['ProviderProfilePage'];
        };
      };
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
    };
  };
  readonly createProviderProfile: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
      };
      readonly path?: never;
      readonly cookie?: never;
    };
    readonly requestBody: {
      readonly content: {
        readonly 'application/json': components['schemas']['ProviderProfileInput'];
      };
    };
    readonly responses: {
      /** @description Disabled provider profile */
      readonly 201: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['ProviderProfile'];
        };
      };
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 409: components['responses']['Conflict'];
    };
  };
  readonly getProviderProfile: {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        readonly profileId: components['parameters']['ProfileId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Provider profile */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['ProviderProfile'];
        };
      };
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
    };
  };
  readonly updateProviderProfile: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
      };
      readonly path: {
        readonly profileId: components['parameters']['ProfileId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody: {
      readonly content: {
        readonly 'application/merge-patch+json': components['schemas']['ProviderProfilePatch'];
      };
    };
    readonly responses: {
      /** @description Updated disabled provider profile */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['ProviderProfile'];
        };
      };
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
      readonly 409: components['responses']['Conflict'];
    };
  };
  readonly activateProviderProfile: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
      };
      readonly path: {
        readonly profileId: components['parameters']['ProfileId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      readonly 202: components['responses']['MutationAccepted'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
      readonly 409: components['responses']['Conflict'];
      readonly 422: components['responses']['Unprocessable'];
    };
  };
  readonly disableProviderProfile: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
      };
      readonly path: {
        readonly profileId: components['parameters']['ProfileId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      readonly 202: components['responses']['MutationAccepted'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
      readonly 409: components['responses']['Conflict'];
    };
  };
  readonly validateProviderProfile: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
      };
      readonly path: {
        readonly profileId: components['parameters']['ProfileId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      readonly 202: components['responses']['MutationAccepted'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
      readonly 409: components['responses']['Conflict'];
    };
  };
  readonly getRetentionPolicy: {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path?: never;
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Retention policy */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['RetentionPolicy'];
        };
      };
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
    };
  };
  readonly updateRetentionPolicy: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
      };
      readonly path?: never;
      readonly cookie?: never;
    };
    readonly requestBody: {
      readonly content: {
        readonly 'application/json': components['schemas']['RetentionPolicyInput'];
      };
    };
    readonly responses: {
      /** @description Updated retention policy */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['RetentionPolicy'];
        };
      };
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 409: components['responses']['Conflict'];
    };
  };
  readonly getProject: {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Project detail */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['Project'];
        };
      };
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
    };
  };
  readonly listFlavors: {
    readonly parameters: {
      readonly query?: {
        /** @description Opaque continuation cursor; callers must not parse it. */
        readonly cursor?: components['parameters']['Cursor'];
        readonly limit?: components['parameters']['Limit'];
      };
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Flavor page */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['FlavorPage'];
        };
      };
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
    };
  };
  readonly listImages: {
    readonly parameters: {
      readonly query?: {
        /** @description Opaque continuation cursor; callers must not parse it. */
        readonly cursor?: components['parameters']['Cursor'];
        readonly limit?: components['parameters']['Limit'];
      };
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Image page */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['ImagePage'];
        };
      };
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
    };
  };
  readonly listNetworks: {
    readonly parameters: {
      readonly query?: {
        /** @description Opaque continuation cursor; callers must not parse it. */
        readonly cursor?: components['parameters']['Cursor'];
        readonly limit?: components['parameters']['Limit'];
      };
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Network page */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['NetworkPage'];
        };
      };
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
    };
  };
  readonly listInstances: {
    readonly parameters: {
      readonly query?: {
        /** @description Opaque continuation cursor; callers must not parse it. */
        readonly cursor?: components['parameters']['Cursor'];
        readonly lifecycleState?: components['schemas']['InstanceLifecycleState'];
        readonly limit?: components['parameters']['Limit'];
      };
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Instance page */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['InstancePage'];
        };
      };
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
    };
  };
  readonly createInstance: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
        /** @description W3C Trace Context header. Invalid supplied values are rejected. */
        readonly traceparent?: components['parameters']['Traceparent'];
        /** @description Optional W3C vendor trace state, accepted only with a valid traceparent. */
        readonly tracestate?: components['parameters']['Tracestate'];
        /** @description Optional caller correlation UUID; the service creates one when absent. */
        readonly 'X-Correlation-ID'?: components['parameters']['CorrelationId'];
      };
      readonly path: {
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody: {
      readonly content: {
        readonly 'application/json': components['schemas']['CreateInstanceRequest'];
      };
    };
    readonly responses: {
      readonly 202: components['responses']['MutationAccepted'];
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 409: components['responses']['Conflict'];
      readonly 413: components['responses']['PayloadTooLarge'];
      readonly 422: components['responses']['Unprocessable'];
    };
  };
  readonly getInstance: {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral instance UUID. */
        readonly instanceId: components['parameters']['InstanceId'];
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Instance detail */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['Instance'];
        };
      };
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
    };
  };
  readonly retainInstance: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
        /** @description W3C Trace Context header. Invalid supplied values are rejected. */
        readonly traceparent?: components['parameters']['Traceparent'];
        /** @description Optional W3C vendor trace state, accepted only with a valid traceparent. */
        readonly tracestate?: components['parameters']['Tracestate'];
        /** @description Optional caller correlation UUID; the service creates one when absent. */
        readonly 'X-Correlation-ID'?: components['parameters']['CorrelationId'];
      };
      readonly path: {
        /** @description Provider-neutral instance UUID. */
        readonly instanceId: components['parameters']['InstanceId'];
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      readonly 202: components['responses']['MutationAccepted'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
      readonly 409: components['responses']['Conflict'];
    };
  };
  readonly mutateInstance: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
        /** @description W3C Trace Context header. Invalid supplied values are rejected. */
        readonly traceparent?: components['parameters']['Traceparent'];
        /** @description Optional W3C vendor trace state, accepted only with a valid traceparent. */
        readonly tracestate?: components['parameters']['Tracestate'];
        /** @description Optional caller correlation UUID; the service creates one when absent. */
        readonly 'X-Correlation-ID'?: components['parameters']['CorrelationId'];
      };
      readonly path: {
        /** @description Provider-neutral instance UUID. */
        readonly instanceId: components['parameters']['InstanceId'];
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody: {
      readonly content: {
        readonly 'application/json': components['schemas']['InstanceAction'];
      };
    };
    readonly responses: {
      readonly 202: components['responses']['MutationAccepted'];
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
      readonly 409: components['responses']['Conflict'];
      readonly 413: components['responses']['PayloadTooLarge'];
      readonly 422: components['responses']['Unprocessable'];
    };
  };
  readonly listSnapshots: {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral instance UUID. */
        readonly instanceId: components['parameters']['InstanceId'];
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Snapshot page */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['SnapshotPage'];
        };
      };
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
    };
  };
  readonly createSnapshot: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
        /** @description W3C Trace Context header. Invalid supplied values are rejected. */
        readonly traceparent?: components['parameters']['Traceparent'];
        /** @description Optional W3C vendor trace state, accepted only with a valid traceparent. */
        readonly tracestate?: components['parameters']['Tracestate'];
        /** @description Optional caller correlation UUID; the service creates one when absent. */
        readonly 'X-Correlation-ID'?: components['parameters']['CorrelationId'];
      };
      readonly path: {
        /** @description Provider-neutral instance UUID. */
        readonly instanceId: components['parameters']['InstanceId'];
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody: {
      readonly content: {
        readonly 'application/json': components['schemas']['CreateSnapshotRequest'];
      };
    };
    readonly responses: {
      readonly 202: components['responses']['MutationAccepted'];
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
      readonly 409: components['responses']['Conflict'];
      readonly 422: components['responses']['Unprocessable'];
    };
  };
  readonly deleteSnapshot: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
        /** @description W3C Trace Context header. Invalid supplied values are rejected. */
        readonly traceparent?: components['parameters']['Traceparent'];
        /** @description Optional W3C vendor trace state, accepted only with a valid traceparent. */
        readonly tracestate?: components['parameters']['Tracestate'];
        /** @description Optional caller correlation UUID; the service creates one when absent. */
        readonly 'X-Correlation-ID'?: components['parameters']['CorrelationId'];
      };
      readonly path: {
        /** @description Provider-neutral instance UUID. */
        readonly instanceId: components['parameters']['InstanceId'];
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
        /** @description Provider-neutral snapshot UUID. */
        readonly snapshotId: components['parameters']['SnapshotId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      readonly 202: components['responses']['MutationAccepted'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
      readonly 409: components['responses']['Conflict'];
    };
  };
  readonly rollbackSnapshot: {
    readonly parameters: {
      readonly query?: never;
      readonly header: {
        /** @description Scoped mutation identity, bound to the actor, project, action, target, and canonical body hash. */
        readonly 'Idempotency-Key': components['parameters']['IdempotencyKey'];
        /** @description W3C Trace Context header. Invalid supplied values are rejected. */
        readonly traceparent?: components['parameters']['Traceparent'];
        /** @description Optional W3C vendor trace state, accepted only with a valid traceparent. */
        readonly tracestate?: components['parameters']['Tracestate'];
        /** @description Optional caller correlation UUID; the service creates one when absent. */
        readonly 'X-Correlation-ID'?: components['parameters']['CorrelationId'];
      };
      readonly path: {
        /** @description Provider-neutral instance UUID. */
        readonly instanceId: components['parameters']['InstanceId'];
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
        /** @description Provider-neutral snapshot UUID. */
        readonly snapshotId: components['parameters']['SnapshotId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody: {
      readonly content: {
        readonly 'application/json': components['schemas']['SnapshotRollbackRequest'];
      };
    };
    readonly responses: {
      readonly 202: components['responses']['MutationAccepted'];
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
      readonly 409: components['responses']['Conflict'];
    };
  };
  readonly listOperations: {
    readonly parameters: {
      readonly query?: {
        /** @description Opaque continuation cursor; callers must not parse it. */
        readonly cursor?: components['parameters']['Cursor'];
        readonly instanceId?: string;
        readonly limit?: components['parameters']['Limit'];
        readonly state?: components['schemas']['OperationState'];
      };
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Operation page */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['OperationPage'];
        };
      };
      readonly 400: components['responses']['BadRequest'];
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
    };
  };
  readonly getOperation: {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Durable operation UUID. */
        readonly operationId: components['parameters']['OperationId'];
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Operation detail */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['Operation'];
        };
      };
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
    };
  };
  readonly getProjectQuota: {
    readonly parameters: {
      readonly query?: never;
      readonly header?: never;
      readonly path: {
        /** @description Provider-neutral project UUID. */
        readonly projectId: components['parameters']['ProjectId'];
      };
      readonly cookie?: never;
    };
    readonly requestBody?: never;
    readonly responses: {
      /** @description Project quota */
      readonly 200: {
        headers: {
          readonly [name: string]: unknown;
        };
        content: {
          readonly 'application/json': components['schemas']['QuotaSet'];
        };
      };
      readonly 401: components['responses']['Unauthorized'];
      readonly 403: components['responses']['Forbidden'];
      readonly 404: components['responses']['NotFound'];
    };
  };
}
