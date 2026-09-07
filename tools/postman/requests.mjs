/**
 * The Postman collection's request list, as data.
 *
 * This module is the single source of truth for both generated artifacts: the importable
 * `.postman_collection.json` and the runner that executes it headlessly. Keeping the two from
 * drifting matters more here than it looks — a collection that passes in the runner but 404s when a
 * person imports it is worse than no collection, because it is trusted.
 *
 * WHY the requests are ordered rather than alphabetised: this is a lifecycle API. A snapshot cannot
 * be taken of an instance that has not been created, a retained instance cannot be powered on, and
 * a purge is refused for anything that is not already retained. The order below *is* the lifecycle,
 * and running it top to bottom is what makes the collection a test rather than a catalogue.
 *
 * Each entry declares the response it expects. Where that expectation is a refusal — a 403 for a
 * foreign project, a 409 for a purge inside the retention window — the refusal is the assertion:
 * these are the safety rules the control plane exists to enforce, and a run that stopped refusing
 * would be a regression that a "happy path only" collection would never notice.
 *
 * @see docs/operations/phase-6-api-examples.md
 * @see docs/operations/phase-6-operations-manual.md
 */

/** Project seeded by `db/seeds/0001_phase3_fake.sql`; every tenant request is scoped to it. */
export const SEEDED_PROJECT = '00000000-0000-4000-8000-000000000001';
/** A project the seeded tokens are deliberately *not* members of, used to prove the 403. */
export const FOREIGN_PROJECT = '00000000-0000-4000-8000-0000000000ff';
/** An instance UUID that does not exist, used to prove the 404 rather than assume it. */
export const ABSENT_INSTANCE = '00000000-0000-4000-8000-00000000dead';

/**
 * Folders in run order, each with the requests it holds.
 *
 * `expect.status` is asserted by both the generated Postman tests and the runner. `capture` runs
 * after a successful assertion and stores values later requests depend on. `operationId` ties the
 * request back to the OpenAPI document so coverage can be checked mechanically.
 */
export const FOLDERS = [
  {
    name: '00 Identity',
    description:
      'Mints the bearer tokens every later request carries. The issuer is the in-cluster OIDC ' +
      'fixture, reached over a `kubectl port-forward`; it has no route through the Gateway and ' +
      'is not meant to have one. Run this folder first: every other folder reads the variables ' +
      'it sets.',
    requests: [
      {
        name: 'Mint tenant token',
        method: 'GET',
        url: '{{oidcUrl}}/token?roles=tenant_developer&projects={{projectId}}',
        auth: 'none',
        throughGateway: false,
        expect: { status: 200 },
        capture: [
          "pm.collectionVariables.set('tenantToken', pm.response.json().access_token);",
          "pm.test('token is a three-part JWS', () => pm.expect(pm.response.json().access_token.split('.')).to.have.lengthOf(3));",
        ],
        description:
          'A `tenant_developer` in the seeded project. Valid for 15 minutes — re-run this ' +
          'request rather than debugging a sudden 401.',
      },
      {
        name: 'Mint administrator token',
        method: 'GET',
        url: '{{oidcUrl}}/token?roles=platform_administrator&projects={{projectId}}',
        auth: 'none',
        throughGateway: false,
        expect: { status: 200 },
        capture: ["pm.collectionVariables.set('adminToken', pm.response.json().access_token);"],
        description:
          'A `platform_administrator`. Administrative recovery is never inferred from project ' +
          'membership, so this role is checked on its own and the two tokens are not ' +
          'interchangeable in either direction.',
      },
      {
        name: 'Mint foreign-project token',
        method: 'GET',
        url: '{{oidcUrl}}/token?roles=tenant_developer&projects={{foreignProjectId}}',
        auth: 'none',
        throughGateway: false,
        expect: { status: 200 },
        capture: ["pm.collectionVariables.set('foreignToken', pm.response.json().access_token);"],
        description:
          'A correctly signed token for a project the caller does not belong to. Used later to ' +
          'prove that a valid signature is not by itself authorisation.',
      },
    ],
  },
  {
    name: '01 Health and routing',
    description:
      'The unauthenticated probes, and the one header that decides which environment answers. ' +
      '`X-Canary: green` reaches the preview Service; everything else reaches the active one.',
    requests: [
      {
        name: 'Liveness (active / blue)',
        method: 'GET',
        url: '{{gatewayUrl}}/health/live',
        auth: 'none',
        operationId: 'getLiveness',
        expect: { status: 200 },
        capture: [
          "pm.test('reports ok', () => pm.expect(pm.response.json().status).to.eql('ok'));",
        ],
        description:
          'Deliberately unauthenticated: a liveness probe that needs a token cannot run from a ' +
          'kubelet.',
      },
      {
        name: 'Readiness (active / blue)',
        method: 'GET',
        url: '{{gatewayUrl}}/health/ready',
        auth: 'none',
        operationId: 'getReadiness',
        expect: { status: 200 },
        description:
          'Readiness is the gate the blue-green promotion waits on. A green ReplicaSet whose ' +
          'pods never report ready is aborted by the progress deadline rather than promoted.',
      },
      {
        name: 'Liveness through the green header',
        method: 'GET',
        url: '{{gatewayUrl}}/health/live',
        auth: 'none',
        headers: { 'X-Canary': 'green' },
        expect: { status: 200 },
        description:
          'Same path, same Gateway, different backend. Gateway API resolves the tie by header ' +
          'match count, so the rule carrying `X-Canary: green` wins over the one that matches ' +
          'everything. When no rollout is in progress the preview Service points at the same ' +
          'ReplicaSet as the active one, so this answers identically — that is correct, not a ' +
          'routing failure.',
      },
    ],
  },
  {
    name: '02 Project, quota, and catalog',
    description: 'The read surface a caller needs before it can compose a valid create request.',
    requests: [
      {
        name: 'Get project',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}',
        auth: 'tenant',
        operationId: 'getProject',
        expect: { status: 200 },
      },
      {
        name: 'Get project quota',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/quota',
        auth: 'tenant',
        operationId: 'getProjectQuota',
        expect: { status: 200 },
        capture: [
          "pm.test('limits and usage are both reported', () => { const q = pm.response.json(); pm.expect(q).to.have.property('limits'); pm.expect(q).to.have.property('usage'); });",
        ],
        description:
          '`usage` is measured, not cached: it is computed inside the same read that returns it, ' +
          'so a create accepted a moment ago is already counted.',
      },
      {
        name: 'List images',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/catalog/images',
        auth: 'tenant',
        operationId: 'listImages',
        expect: { status: 200 },
      },
      {
        name: 'List flavors',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/catalog/flavors',
        auth: 'tenant',
        operationId: 'listFlavors',
        expect: { status: 200 },
      },
      {
        name: 'List networks',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/catalog/networks',
        auth: 'tenant',
        operationId: 'listNetworks',
        expect: { status: 200 },
      },
    ],
  },
  {
    name: '03 Create an instance',
    description:
      'The asynchronous accept path, and the two behaviours that make it safe to retry. A create ' +
      'returns 202 with an operation to follow; it does not return an instance, because no ' +
      'instance exists yet.',
    requests: [
      {
        name: 'Create instance',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances',
        auth: 'tenant',
        operationId: 'createInstance',
        idempotent: true,
        newIdempotencyKey: 'createKey',
        correlated: true,
        body: {
          imageId: '{{imageId}}',
          flavorId: '{{flavorId}}',
          networkId: '{{networkId}}',
          hostname: '{{hostname}}',
          sshPublicKeys: ['{{sshPublicKey}}'],
        },
        expect: { status: 202 },
        capture: [
          'const accepted = pm.response.json();',
          "pm.collectionVariables.set('instanceId', accepted.targetId);",
          "pm.collectionVariables.set('operationId', accepted.operationId);",
          "pm.collectionVariables.set('statusUrl', accepted.statusUrl);",
          "pm.test('is not reported as a replay', () => pm.expect(accepted.replayed).to.eql(false));",
        ],
        description:
          'The `Idempotency-Key` header is required. The response carries `operationId`, ' +
          '`targetId` (the new instance), and a `statusUrl` to poll. The instance is not usable ' +
          'until that operation reaches `succeeded`.',
      },
      {
        name: 'Create instance again with the same key (replay)',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances',
        auth: 'tenant',
        operationId: 'createInstance',
        idempotencyKeyFrom: 'createKey',
        body: {
          imageId: '{{imageId}}',
          flavorId: '{{flavorId}}',
          networkId: '{{networkId}}',
          hostname: '{{hostname}}',
          sshPublicKeys: ['{{sshPublicKey}}'],
        },
        expect: { status: 202 },
        capture: [
          'const replay = pm.response.json();',
          "pm.test('is reported as a replay', () => pm.expect(replay.replayed).to.eql(true));",
          "pm.test('returns the original operation, not a new one', () => pm.expect(replay.operationId).to.eql(pm.collectionVariables.get('operationId')));",
        ],
        description:
          'The same key with the same payload returns the *stored* response. This is the ' +
          'behaviour that makes a client retry safe: a second VM is never built, and the caller ' +
          'is handed back the operation it already started.',
      },
      {
        name: 'Create instance with the same key but a different payload',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances',
        auth: 'tenant',
        operationId: 'createInstance',
        idempotencyKeyFrom: 'createKey',
        body: {
          imageId: '{{imageId}}',
          flavorId: '{{flavorIdLarger}}',
          networkId: '{{networkId}}',
          hostname: '{{hostname}}',
        },
        expect: { status: 409 },
        capture: [
          "pm.test('names the idempotency conflict', () => pm.expect(pm.response.json().code).to.eql('IDEMPOTENCY_CONFLICT'));",
        ],
        description:
          'A reused key with different content is a client bug, not a retry, and is refused. ' +
          'The payload is compared by canonical hash, so key order and whitespace do not matter ' +
          'and a genuinely identical body still replays.',
      },
      {
        name: 'Poll the create operation until it settles',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/operations/{{operationId}}',
        auth: 'tenant',
        operationId: 'getOperation',
        expect: { status: 200 },
        pollUntil: {
          jsonPath: 'state',
          anyOf: ['succeeded', 'failed'],
          attempts: 60,
          delayMs: 2000,
        },
        capture: [
          "pm.test('the create succeeded', () => pm.expect(pm.response.json().state).to.eql('succeeded'));",
        ],
        description:
          'Re-sends itself until the operation leaves `pending`/`running`. In the Postman GUI ' +
          'this uses `postman.setNextRequest`, so it works in a collection run; sending it once ' +
          'by hand simply shows the current state.',
      },
      {
        name: 'Get instance',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances/{{instanceId}}',
        auth: 'tenant',
        operationId: 'getInstance',
        expect: { status: 200 },
        capture: [
          "pm.test('is active', () => pm.expect(pm.response.json().lifecycleState).to.eql('active'));",
        ],
      },
      {
        name: 'List instances',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances?limit=10',
        auth: 'tenant',
        operationId: 'listInstances',
        expect: { status: 200 },
        capture: [
          "pm.test('page metadata is present', () => pm.expect(pm.response.json()).to.have.property('page'));",
        ],
      },
      {
        name: 'List operations',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/operations?limit=10',
        auth: 'tenant',
        operationId: 'listOperations',
        expect: { status: 200 },
        capture: [
          "pm.test('the create operation is listed', () => pm.expect(pm.response.json().items.map((o) => o.id)).to.include(pm.collectionVariables.get('operationId')));",
        ],
        description:
          'The operation journal for the project. Every accepted command appears here whether it ' +
          'succeeded, failed, or is still running, which makes it the place to look when a ' +
          'caller lost the `operationId` a 202 returned.',
      },
    ],
  },
  {
    name: '04 Power and resize',
    description:
      'Every mutation is the same shape as a create: a 202 with an operation to follow. The ' +
      'instance is locked for the duration, which is what the 409 in the last request proves.',
    requests: [
      {
        name: 'Shutdown',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances/{{instanceId}}/actions',
        auth: 'tenant',
        operationId: 'mutateInstance',
        idempotent: true,
        body: { action: 'shutdown' },
        expect: { status: 202 },
        capture: ["pm.collectionVariables.set('operationId', pm.response.json().operationId);"],
        description:
          'A graceful guest shutdown. `stop` is the ungraceful one and is a separate action.',
      },
      {
        name: 'Poll the shutdown operation',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/operations/{{operationId}}',
        auth: 'tenant',
        expect: { status: 200 },
        pollUntil: {
          jsonPath: 'state',
          anyOf: ['succeeded', 'failed'],
          attempts: 60,
          delayMs: 2000,
        },
        capture: [
          "pm.test('the shutdown succeeded', () => pm.expect(pm.response.json().state).to.eql('succeeded'));",
        ],
      },
      {
        name: 'Start',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances/{{instanceId}}/actions',
        auth: 'tenant',
        operationId: 'mutateInstance',
        idempotent: true,
        body: { action: 'start' },
        expect: { status: 202 },
        capture: ["pm.collectionVariables.set('operationId', pm.response.json().operationId);"],
      },
      {
        name: 'Poll the start operation',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/operations/{{operationId}}',
        auth: 'tenant',
        expect: { status: 200 },
        pollUntil: {
          jsonPath: 'state',
          anyOf: ['succeeded', 'failed'],
          attempts: 60,
          delayMs: 2000,
        },
        capture: [
          "pm.test('the start succeeded', () => pm.expect(pm.response.json().state).to.eql('succeeded'));",
        ],
      },
      {
        name: 'Resize to a larger flavor',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances/{{instanceId}}/actions',
        auth: 'tenant',
        operationId: 'mutateInstance',
        idempotent: true,
        body: { action: 'resize', flavorId: '{{flavorIdLarger}}' },
        expect: { status: 202 },
        capture: ["pm.collectionVariables.set('operationId', pm.response.json().operationId);"],
        description:
          'CPU and memory come from the flavor. A disk change is the optional `diskGiB` on the ' +
          'same action, and it may only grow — a shrink is refused with `DISK_SHRINK_FORBIDDEN` ' +
          'because no safe shrink exists that the control plane can perform blind.',
      },
      {
        name: 'Poll the resize operation',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/operations/{{operationId}}',
        auth: 'tenant',
        expect: { status: 200 },
        pollUntil: {
          jsonPath: 'state',
          anyOf: ['succeeded', 'failed'],
          attempts: 60,
          delayMs: 2000,
        },
        capture: [
          "pm.test('the resize succeeded', () => pm.expect(pm.response.json().state).to.eql('succeeded'));",
        ],
      },
      {
        name: 'Refuse a disk shrink',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances/{{instanceId}}/actions',
        auth: 'tenant',
        operationId: 'mutateInstance',
        idempotent: true,
        body: { action: 'resize', flavorId: '{{flavorIdLarger}}', diskGiB: 8 },
        expect: { status: [409, 422] },
        capture: [
          "pm.test('names the shrink refusal', () => pm.expect(pm.response.json().code).to.eql('DISK_SHRINK_FORBIDDEN'));",
        ],
        description:
          'The instance already has a larger disk than 8 GiB, so this is a shrink. It is refused ' +
          'at acceptance — nothing reaches the provider.',
      },
    ],
  },
  {
    name: '05 Snapshots',
    description: 'Create, list, roll back, and delete. Each mutating call is asynchronous.',
    requests: [
      {
        name: 'Create snapshot',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances/{{instanceId}}/snapshots',
        auth: 'tenant',
        operationId: 'createSnapshot',
        idempotent: true,
        body: { name: '{{snapshotName}}', description: 'Taken by the Postman collection run.' },
        expect: { status: 202 },
        capture: [
          "pm.collectionVariables.set('operationId', pm.response.json().operationId);",
          "pm.collectionVariables.set('snapshotId', pm.response.json().targetId);",
        ],
      },
      {
        name: 'Poll the snapshot operation',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/operations/{{operationId}}',
        auth: 'tenant',
        expect: { status: 200 },
        pollUntil: {
          jsonPath: 'state',
          anyOf: ['succeeded', 'failed'],
          attempts: 60,
          delayMs: 2000,
        },
        capture: [
          "pm.test('the snapshot succeeded', () => pm.expect(pm.response.json().state).to.eql('succeeded'));",
        ],
      },
      {
        name: 'List snapshots',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances/{{instanceId}}/snapshots',
        auth: 'tenant',
        operationId: 'listSnapshots',
        expect: { status: 200 },
        capture: [
          "pm.test('the new snapshot is listed', () => pm.expect(pm.response.json().items.map((s) => s.id)).to.include(pm.collectionVariables.get('snapshotId')));",
        ],
      },
      {
        name: 'Roll back to the snapshot',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances/{{instanceId}}/snapshots/{{snapshotId}}/actions',
        auth: 'tenant',
        operationId: 'rollbackSnapshot',
        idempotent: true,
        body: { action: 'rollback' },
        expect: { status: 202 },
        capture: ["pm.collectionVariables.set('operationId', pm.response.json().operationId);"],
      },
      {
        name: 'Poll the rollback operation',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/operations/{{operationId}}',
        auth: 'tenant',
        expect: { status: 200 },
        pollUntil: {
          jsonPath: 'state',
          anyOf: ['succeeded', 'failed'],
          attempts: 60,
          delayMs: 2000,
        },
        capture: [
          "pm.test('the rollback succeeded', () => pm.expect(pm.response.json().state).to.eql('succeeded'));",
        ],
      },
      {
        name: 'Delete the snapshot',
        method: 'DELETE',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances/{{instanceId}}/snapshots/{{snapshotId}}',
        auth: 'tenant',
        operationId: 'deleteSnapshot',
        idempotent: true,
        expect: { status: 202 },
        capture: ["pm.collectionVariables.set('operationId', pm.response.json().operationId);"],
        description:
          'Deletes the snapshot, never the instance. This is the one delete in the tenant surface ' +
          'that actually destroys something, and its blast radius is one snapshot.',
      },
      {
        name: 'Poll the snapshot deletion',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/operations/{{operationId}}',
        auth: 'tenant',
        expect: { status: 200 },
        pollUntil: {
          jsonPath: 'state',
          anyOf: ['succeeded', 'failed'],
          attempts: 60,
          delayMs: 2000,
        },
        capture: [
          "pm.test('the deletion succeeded', () => pm.expect(pm.response.json().state).to.eql('succeeded'));",
        ],
      },
    ],
  },
  {
    name: '06 Retention and purge',
    description:
      '`DELETE` on an instance does not delete it. It detaches access and retains the resource, ' +
      'and only an administrator can destroy what is left — after the retention window has ' +
      'expired. The refusal in the last request is the safety rule working, not a failure.',
    requests: [
      {
        name: 'Retain (soft delete) the instance',
        method: 'DELETE',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances/{{instanceId}}',
        auth: 'tenant',
        operationId: 'retainInstance',
        idempotent: true,
        expect: { status: 202 },
        capture: ["pm.collectionVariables.set('operationId', pm.response.json().operationId);"],
        description:
          'The VM keeps existing. Access is detached, the address is quarantined rather than ' +
          'reissued, and a retention deadline is stamped from the policy.',
      },
      {
        name: 'Poll the retention operation',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/operations/{{operationId}}',
        auth: 'tenant',
        expect: { status: 200 },
        pollUntil: {
          jsonPath: 'state',
          anyOf: ['succeeded', 'failed'],
          attempts: 60,
          delayMs: 2000,
        },
        capture: [
          "pm.test('the retention succeeded', () => pm.expect(pm.response.json().state).to.eql('succeeded'));",
        ],
      },
      {
        name: 'Confirm the instance is retained, not gone',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances/{{instanceId}}',
        auth: 'tenant',
        operationId: 'getInstance',
        expect: { status: 200 },
        capture: [
          'const retained = pm.response.json();',
          "pm.test('is retained', () => pm.expect(retained.lifecycleState).to.eql('retained'));",
          "pm.test('reports when it stops being recoverable', () => pm.expect(retained.retentionDeadline).to.not.eql(null));",
          "pm.test('is not yet purge-eligible', () => pm.expect(retained.purgeEligible).to.eql(false));",
        ],
      },
      {
        name: 'Purge is refused inside the retention window',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/admin/instances/{{instanceId}}/purges',
        auth: 'admin',
        operationId: 'purgeInstance',
        idempotent: true,
        body: {
          reason: 'Postman collection run: proving the retention window is enforced.',
          confirmInstanceId: '{{instanceId}}',
        },
        expect: { status: 409 },
        capture: [
          "pm.test('is refused as busy, not accepted', () => pm.expect(pm.response.json().code).to.eql('INSTANCE_BUSY'));",
        ],
        description:
          'The default policy retains for 168 hours, so a purge moments after a retain is ' +
          'refused. Making this succeed on purpose is a lab-only step documented in the ' +
          'operations manual; there is no API that shortens the window today.',
      },
      {
        name: 'Purge refuses a mismatched confirmation',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/admin/instances/{{instanceId}}/purges',
        auth: 'admin',
        operationId: 'purgeInstance',
        idempotent: true,
        body: {
          reason: 'Postman collection run: proving the confirmation guard is enforced.',
          confirmInstanceId: '{{absentInstanceId}}',
        },
        expect: { status: [409, 422] },
        description:
          'The caller must name the instance twice, in the path and in the body, and the two ' +
          'must agree. A purge is the one irreversible operation in the API, so the request has ' +
          'to be unambiguous about what it is destroying.',
      },
    ],
  },
  {
    name: '07 Administration',
    description:
      'The administrative surface that is served today. Each requires `platform_administrator`; ' +
      'project membership grants none of it.',
    requests: [
      {
        name: 'Get an operation as an administrator',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/admin/operations/{{operationId}}',
        auth: 'admin',
        operationId: 'getAdministrativeOperation',
        expect: { status: 200 },
        description:
          'The same operation the tenant route returns, without requiring the administrator to ' +
          'be a member of the project that owns it.',
      },
      {
        name: 'List audit events',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/admin/audit-events?limit=10',
        auth: 'admin',
        operationId: 'listAuditEvents',
        expect: { status: 200 },
        capture: [
          'const audit = pm.response.json();',
          "pm.test('page metadata is present', () => pm.expect(audit).to.have.property('page'));",
          "pm.test('records the action that actually happened', () => pm.expect(audit.items.some((entry) => entry.action === 'retain_instance' && entry.outcome === 'succeeded')).to.eql(true));",
        ],
        description:
          'Every accepted command writes an audit entry in the same transaction that accepts it, ' +
          'so this list cannot disagree with what actually happened. The second assertion guards a ' +
          'real defect: every terminal entry was once labelled `create_instance` regardless of the ' +
          'capability that produced it, so the log claimed a VM had been built once per power ' +
          'change, resize, snapshot, and retention.',
      },
      {
        name: 'List dead letters',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/admin/dead-letters?limit=10',
        auth: 'admin',
        operationId: 'listDeadLetters',
        expect: { status: 200 },
        capture: [
          'const items = pm.response.json().items;',
          "if (items.length > 0) { pm.collectionVariables.set('deadLetterEventId', items[0].eventId); }",
          "pm.test('page metadata is present', () => pm.expect(pm.response.json()).to.have.property('page'));",
        ],
        description:
          'Empty on a healthy run. Raw poison-record bytes are never stored or returned here — ' +
          'the entry carries identifiers and a classification, not the payload that broke.',
      },
      {
        name: 'Request reconciliation',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/admin/instances/{{instanceId}}/reconciliations',
        auth: 'admin',
        operationId: 'requestReconciliation',
        idempotent: true,
        body: { reason: 'Postman collection run: observe and report drift, change nothing.' },
        expect: { status: 202 },
        description:
          'Reconciliation observes and reports. It never repairs by deleting or stopping ' +
          'anything; a disagreement it cannot explain becomes a manual review, not an action.',
      },
      {
        name: 'Replay a dead letter',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/admin/dead-letters/{{deadLetterEventId}}/replays',
        auth: 'admin',
        operationId: 'replayDeadLetter',
        idempotent: true,
        body: { reason: 'Postman collection run: authorised replay of a quarantined record.' },
        expect: { status: [202, 404] },
        skipWhenUnset: 'deadLetterEventId',
        description:
          'Skipped when the previous request found no dead letters, which is the normal case. ' +
          'A replay is authorised in one transaction and admitted back only after a three-way ' +
          'check on generation, payload hash, and the outbox row that authorised it.',
      },
    ],
  },
  {
    name: '08 Authorization and validation',
    description:
      'The refusals. Each of these is a rule the control plane is supposed to enforce, so each ' +
      'asserts the refusal rather than tolerating a range.',
    requests: [
      {
        name: 'No token is rejected',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances',
        auth: 'none',
        expect: { status: 401 },
        capture: [
          "pm.test('names the missing authentication', () => pm.expect(pm.response.json().code).to.eql('AUTHENTICATION_REQUIRED'));",
        ],
      },
      {
        name: 'A token for another project is rejected',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances',
        auth: 'foreign',
        expect: { status: 403 },
        capture: [
          "pm.test('names the project denial', () => pm.expect(pm.response.json().code).to.eql('PROJECT_ACCESS_DENIED'));",
        ],
        description:
          'The signature is valid and the role is right. Membership is what is missing, and it ' +
          'is checked in the application layer so REST and gRPC get the rule from one place.',
      },
      {
        name: 'A tenant token cannot reach the admin surface',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/admin/audit-events',
        auth: 'tenant',
        expect: { status: 403 },
        capture: [
          "pm.test('requires an administrator', () => pm.expect(pm.response.json().code).to.eql('ADMIN_REQUIRED'));",
        ],
      },
      {
        name: 'An unknown instance is a 404',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances/{{absentInstanceId}}',
        auth: 'tenant',
        expect: { status: 404 },
      },
      {
        name: 'A malformed create body is rejected',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances',
        auth: 'tenant',
        idempotent: true,
        body: { imageId: 'ubuntu-24-04-cloud', hostname: 'missing-required-fields' },
        expect: { status: [400, 422] },
        description:
          'Missing `flavorId` and `networkId`. Rejected by the transport before any transaction ' +
          'opens, so nothing is written and no operation is created.',
      },
      {
        name: 'A create without an Idempotency-Key is rejected',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/projects/{{projectId}}/instances',
        auth: 'tenant',
        body: {
          imageId: '{{imageId}}',
          flavorId: '{{flavorId}}',
          networkId: '{{networkId}}',
          hostname: 'no-idempotency-key',
        },
        expect: { status: [400, 422] },
        description:
          'The header is required on every mutating call. Without it a client retry after a ' +
          'timeout could not be distinguished from a second request, which is how duplicate VMs ' +
          'get built.',
      },
    ],
  },
  {
    name: '09 Declared but not yet served',
    description:
      'These operations are in the OpenAPI document and in the generated clients, and the ' +
      'control-api has no route for them yet. They answer 404 today. They are kept in the ' +
      'collection deliberately: when a later phase implements one, this folder is where the ' +
      'change shows up, and until then the collection states the gap instead of hiding it. ' +
      'See the coverage table in the API examples document.',
    expectUnimplemented: true,
    requests: [
      {
        name: 'Upsert image',
        method: 'PUT',
        url: '{{gatewayUrl}}/v1/admin/catalog/images/{{imageId}}',
        auth: 'admin',
        operationId: 'upsertImage',
        idempotent: true,
        body: {
          name: 'Ubuntu 24.04 Cloud',
          providerProfileId: 'fake-lab',
          enabled: true,
          architecture: 'x86_64',
        },
      },
      {
        name: 'Upsert flavor',
        method: 'PUT',
        url: '{{gatewayUrl}}/v1/admin/catalog/flavors/{{flavorId}}',
        auth: 'admin',
        operationId: 'upsertFlavor',
        idempotent: true,
        body: {
          name: 'Lab Small',
          cpuCount: 2,
          memoryMiB: 4096,
          minimumDiskGiB: 32,
          enabled: true,
        },
      },
      {
        name: 'Upsert network',
        method: 'PUT',
        url: '{{gatewayUrl}}/v1/admin/catalog/networks/{{networkId}}',
        auth: 'admin',
        operationId: 'upsertNetwork',
        idempotent: true,
        body: {
          name: 'Lab primary',
          ipv4Cidr: '192.0.2.0/27',
          gateway: '192.0.2.1',
          dnsServers: ['192.0.2.53'],
          exclusions: ['192.0.2.2'],
          enabled: true,
        },
      },
      {
        name: 'List provider profiles',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/admin/provider-profiles',
        auth: 'admin',
        operationId: 'listProviderProfiles',
      },
      {
        name: 'Create provider profile',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/admin/provider-profiles',
        auth: 'admin',
        operationId: 'createProviderProfile',
        idempotent: true,
        body: {
          id: 'fake-lab-2',
          providerType: 'fake',
          endpoint: 'fake://lab-2',
          clusterAlias: 'fake-lab-2',
          computeTarget: 'fake-node',
          imageSourceReference: 'ubuntu-24-04-cloud',
          storageTarget: 'fake-storage',
          networkAttachment: 'lab-primary',
          resourceIdMinimum: 920000,
          resourceIdMaximum: 920099,
          networkId: 'lab-primary',
          credentialReference: 'test-only',
        },
      },
      {
        name: 'Get provider profile',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/admin/provider-profiles/fake-lab',
        auth: 'admin',
        operationId: 'getProviderProfile',
      },
      {
        name: 'Update provider profile',
        method: 'PATCH',
        url: '{{gatewayUrl}}/v1/admin/provider-profiles/fake-lab',
        auth: 'admin',
        operationId: 'updateProviderProfile',
        idempotent: true,
        body: { computeTarget: 'fake-node-2' },
      },
      {
        name: 'Validate provider profile',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/admin/provider-profiles/fake-lab/actions/validate',
        auth: 'admin',
        operationId: 'validateProviderProfile',
        idempotent: true,
        body: {},
      },
      {
        name: 'Activate provider profile',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/admin/provider-profiles/fake-lab/actions/activate',
        auth: 'admin',
        operationId: 'activateProviderProfile',
        idempotent: true,
        body: {},
      },
      {
        name: 'Disable provider profile',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/admin/provider-profiles/fake-lab/actions/disable',
        auth: 'admin',
        operationId: 'disableProviderProfile',
        idempotent: true,
        body: { reason: 'Postman collection run: exercising the declared disable action.' },
      },
      {
        name: 'List manual reviews',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/admin/manual-reviews',
        auth: 'admin',
        operationId: 'listManualReviews',
      },
      {
        name: 'Get manual review',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/admin/manual-reviews/{{absentInstanceId}}',
        auth: 'admin',
        operationId: 'getManualReview',
      },
      {
        name: 'Resolve manual review',
        method: 'POST',
        url: '{{gatewayUrl}}/v1/admin/manual-reviews/{{absentInstanceId}}/resolutions',
        auth: 'admin',
        operationId: 'resolveManualReview',
        idempotent: true,
        body: {
          resolution: 'acknowledged',
          notes: 'Postman collection run: exercising the declared resolution action.',
        },
      },
      {
        name: 'Get retention policy',
        method: 'GET',
        url: '{{gatewayUrl}}/v1/admin/retention-policy',
        auth: 'admin',
        operationId: 'getRetentionPolicy',
      },
      {
        name: 'Update retention policy',
        method: 'PUT',
        url: '{{gatewayUrl}}/v1/admin/retention-policy',
        auth: 'admin',
        operationId: 'updateRetentionPolicy',
        idempotent: true,
        body: { retentionHours: 168, leaseReleaseMode: 'quarantine_until_purge' },
      },
    ],
  },
];

/** Flattened request list in run order. */
export function allRequests() {
  return FOLDERS.flatMap((folder) =>
    folder.requests.map((request) => ({
      ...request,
      folder: folder.name,
      expect: request.expect ?? (folder.expectUnimplemented ? { status: 404 } : undefined),
    })),
  );
}
