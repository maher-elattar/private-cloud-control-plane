/**
 * Generates `db/seeds/0002_proxmox_testsrv.sql` from the recorded server survey.
 *
 * PATTERN — derived configuration. The interesting part of that seed is the exclusion list: the
 * addresses already live on the target bridge, which the IPv4 allocator must never hand out.
 * That is a measurement, not a decision, and hand-transcribing 110 addresses is exactly the kind
 * of task that silently goes wrong. This reads them from the survey evidence instead.
 *
 * Re-running it after a fresh `pnpm run survey:proxmox` refreshes the list. The generated file is
 * committed, so `--check` can assert it is current the way the contract and Postman generators do.
 *
 * Usage:
 *   node tools/proxmox/generate-lab-seed.mjs
 *   node tools/proxmox/generate-lab-seed.mjs --check
 *
 * @see docs/verification/testsrv-survey.md
 * @see db/seeds/0002_proxmox_testsrv.sql
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** The survey this seed is derived from. */
const EVIDENCE_PATH = resolve('docs/verification/evidence/testsrv-survey.json');

/** The generated seed. */
const SEED_PATH = resolve('db/seeds/0002_proxmox_testsrv.sql');

/** Catalog identifiers. All new, so the fake path in seed 0001 stays untouched. */
const PROJECT_ID = '00000000-0000-4000-8000-0000000000a1';
const PROJECT_NAME = 'testsrv-lab';
const NETWORK_ID = 'testsrv-vmbr1';
const PROFILE_ID = 'proxmox-testsrv';
const IMAGE_ID = 'ubuntu-noble-2404';

/** The bridge, and the network address derived from its host address. */
const BRIDGE = 'vmbr1';
const NETWORK_CIDR = '192.168.4.0/22';
const GATEWAY = '192.168.4.1';
const DNS_SERVERS = ['1.1.1.1'];

/** The clone template. */
const TEMPLATE_VMID = 110;

/**
 * The reserved VMID interval the adapter clamps itself to — read from the survey, not assumed.
 *
 * WHY it is measured rather than written here: on this server the token's VM privileges are
 * explicit per-VMID ACL entries rather than a pool grant, and twenty-two of the hundred reserved
 * identifiers carry none. Seeding the whole reservation made the allocator pick 910058, which has
 * no entry, and the clone came back `HTTP 403 - Permission check failed` *after* the instance, the
 * lease and the quota had been committed. A resource range a credential cannot allocate is a
 * configuration that lies, and it fails at the latest possible moment.
 *
 * The survey records the longest unbroken allocatable run; the seed claims exactly that. Widening
 * it means adding the missing ACLs on the server and re-running the survey.
 */
function reservedInterval(evidence) {
  const run = evidence.reservedRange?.longestAllocatableRun;
  if (!run?.minimum || !run?.maximum) {
    throw new Error(
      'The survey records no allocatable VMID run. Re-run `pnpm run survey:proxmox` with a ' +
        'credential that can read /access/permissions.',
    );
  }
  return { minimum: run.minimum, maximum: run.maximum };
}

/**
 * A deliberately tight quota, because this project reaches real hardware.
 *
 * SAFE-030 requires live-provider work to carry a small explicit operation cap. The reserved
 * interval holds 100 identifiers; three instances means a runaway loop exhausts the quota long
 * before it exhausts the interval.
 */
const QUOTA = {
  instances: 3,
  cpuCount: 8,
  memoryMib: 16_384,
  diskGib: 192,
  ipv4Addresses: 3,
  snapshots: 8,
};

/** Column at which generated prose and lists wrap, matching Prettier's width for this repo. */
const WRAP_COLUMN = 96;

/** Renders a JSON address array wrapped to the prose width, so the SQL stays readable. */
function wrappedAddresses(addresses) {
  const lines = [];
  let current = '    ';
  addresses.forEach((address, index) => {
    const piece = `"${address}"${index < addresses.length - 1 ? ',' : ''}`;
    if (current.length + piece.length + 1 > WRAP_COLUMN) {
      lines.push(current.trimEnd());
      current = '    ';
    }
    current += `${piece} `;
  });
  lines.push(current.trimEnd());
  return `[\n${lines.join('\n')}\n  ]`;
}

const evidence = JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'));

/** The VMID interval this seed may honestly claim, measured by the survey. */
const { minimum: VMID_MINIMUM, maximum: VMID_MAXIMUM } = reservedInterval(evidence);
const addresses = (evidence.addressesInUseOnBridge?.addresses ?? []).map((entry) => entry.address);
const capturedAt = String(evidence.capturedAt ?? '').slice(0, 10);
const node = evidence.node;
const storage = evidence.template?.storage;
const templateDiskGib = evidence.template?.diskGiB;
const templateCores = evidence.template?.cpuCores;
const templateMemoryMib = evidence.template?.memoryMib;

if (!node || !storage || !templateDiskGib) {
  throw new Error(`${EVIDENCE_PATH} is missing node, storage or template disk size.`);
}
if (evidence.addressesInUseOnBridge?.bridge !== BRIDGE) {
  throw new Error(
    `The survey measured bridge ${evidence.addressesInUseOnBridge?.bridge}, not ${BRIDGE}.`,
  );
}

const sql = `-- Catalog rows for the live Proxmox test server.
--
-- **Generated by \`tools/proxmox/generate-lab-seed.mjs\`. Do not hand-edit.**
-- Refresh with \`pnpm run survey:proxmox\` then \`pnpm run proxmox:generate-seed\`.
--
-- Additive, and deliberately so. \`0001_phase3_fake.sql\` is not edited: the integration suites,
-- the Postman collection and the committed Phase 4 and Phase 6 evidence all depend on its values,
-- and its \`ON CONFLICT DO NOTHING\` means an edit would not take effect on an existing database
-- anyway. Every row here carries a new identifier, so the fake path is untouched and cannot
-- accidentally select one of these.
--
-- \`loadAcceptanceContext\` resolves the provider profile *through the image* and refuses unless
-- \`profile.network_id = network.id\`, so the image, profile and network below have to be mutually
-- consistent. They are also cross-checked against the \`PROXMOX_*\` environment at runtime by
-- \`assertNetwork\` and \`assertDirectProfile\`; \`pnpm run proxmox:check-config\` asserts that
-- agreement up front rather than leaving it to surface as an opaque protocol error at create time.
--
-- Derived from the survey of ${capturedAt}: \`docs/verification/evidence/testsrv-survey.json\`.
--
-- WHY \`ON CONFLICT DO UPDATE\` here where seed 0001 uses DO NOTHING: these rows describe a real
-- server that changes. The exclusion list in particular is a measurement with a date on it, and a
-- re-seed that silently kept a stale one would hand out an address that is already live.

BEGIN;

-- A project of its own, with a deliberately tight quota.
--
-- SAFE-030 requires live-provider work to have a small explicit operation cap. The reserved VMID
-- interval holds ${VMID_MAXIMUM - VMID_MINIMUM + 1} identifiers; this quota permits ${QUOTA.instances} instances, so a runaway loop
-- exhausts the quota long before it exhausts the interval.
INSERT INTO control.projects (id, name, enabled, created_at, updated_at)
VALUES ('${PROJECT_ID}', '${PROJECT_NAME}', true, now(), now())
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now();

INSERT INTO control.quotas (
  project_id, instances, cpu_count, memory_mib, disk_gib, ipv4_addresses, snapshots, updated_at
)
VALUES (
  '${PROJECT_ID}', ${QUOTA.instances}, ${QUOTA.cpuCount}, ${QUOTA.memoryMib}, ${QUOTA.diskGib},
  ${QUOTA.ipv4Addresses}, ${QUOTA.snapshots}, now()
)
ON CONFLICT (project_id) DO UPDATE SET
  instances = EXCLUDED.instances,
  cpu_count = EXCLUDED.cpu_count,
  memory_mib = EXCLUDED.memory_mib,
  disk_gib = EXCLUDED.disk_gib,
  ipv4_addresses = EXCLUDED.ipv4_addresses,
  snapshots = EXCLUDED.snapshots,
  updated_at = now();

-- The bridge as it actually is: ${GATEWAY}/22, so the network address is ${NETWORK_CIDR}.
--
-- The exclusions are the ${addresses.length} addresses measured as already live on this bridge. The
-- allocator returns the lowest free address, so instances land at 192.168.4.2 upward and are
-- nowhere near the occupied region — but it knows only its own leases plus whatever it is told
-- here, so without this list it would eventually walk into them. It cannot see an address a guest
-- configured internally rather than through cloud-init; \`assertIpv4Available\` rechecks live VM
-- configuration immediately before the network mutation (SAFE-025), which covers the declared
-- cases and cannot cover the undeclared ones.
INSERT INTO control.networks (
  id, name, ipv4_cidr, gateway, dns_servers, exclusions, enabled, created_at, updated_at
)
VALUES (
  '${NETWORK_ID}',
  'Test server ${BRIDGE}',
  '${NETWORK_CIDR}',
  '${GATEWAY}',
  '${JSON.stringify(DNS_SERVERS)}',
  '${wrappedAddresses(addresses)}',
  true,
  now(),
  now()
)
ON CONFLICT (id) DO UPDATE SET
  ipv4_cidr = EXCLUDED.ipv4_cidr,
  gateway = EXCLUDED.gateway,
  dns_servers = EXCLUDED.dns_servers,
  exclusions = EXCLUDED.exclusions,
  enabled = EXCLUDED.enabled,
  updated_at = now();

-- \`credential_reference\` is a NAME, never a value. SAFE-036 governs what enters history; the
-- token itself lives only in the gitignored credentials file.
INSERT INTO control.provider_profiles (
  id, provider_type, state, endpoint, cluster_alias, compute_target, image_source_reference,
  storage_target, network_attachment, resource_id_minimum, resource_id_maximum, network_id,
  credential_reference, created_at, updated_at
)
VALUES (
  '${PROFILE_ID}',
  'proxmox',
  'active',
  '${evidence.endpoint}',
  'testsrv',
  '${node}',
  '${TEMPLATE_VMID}',
  '${storage}',
  '${BRIDGE}',
  ${VMID_MINIMUM},
  ${VMID_MAXIMUM},
  '${NETWORK_ID}',
  'PROXMOX_API_TOKEN_ID/PROXMOX_API_TOKEN_SECRET',
  now(),
  now()
)
ON CONFLICT (id) DO UPDATE SET
  provider_type = EXCLUDED.provider_type,
  state = EXCLUDED.state,
  endpoint = EXCLUDED.endpoint,
  cluster_alias = EXCLUDED.cluster_alias,
  compute_target = EXCLUDED.compute_target,
  image_source_reference = EXCLUDED.image_source_reference,
  storage_target = EXCLUDED.storage_target,
  network_attachment = EXCLUDED.network_attachment,
  resource_id_minimum = EXCLUDED.resource_id_minimum,
  resource_id_maximum = EXCLUDED.resource_id_maximum,
  network_id = EXCLUDED.network_id,
  credential_reference = EXCLUDED.credential_reference,
  updated_at = now();

INSERT INTO control.images (
  id, name, provider_profile_id, enabled, architecture, created_at, updated_at
)
VALUES (
  '${IMAGE_ID}', 'Ubuntu Noble 24.04', '${PROFILE_ID}', true, 'x86_64', now(), now()
)
ON CONFLICT (id) DO UPDATE SET
  provider_profile_id = EXCLUDED.provider_profile_id,
  enabled = EXCLUDED.enabled,
  updated_at = now();

-- No new flavours.
--
-- Template ${TEMPLATE_VMID} is ${templateCores} vCPU, ${templateMemoryMib} MiB and ${templateDiskGib} GiB, which \`lab-small\` already
-- describes exactly. That matters rather than being a coincidence: \`assertResources\` refuses a
-- create unless the requested disk equals the template's disk exactly, so a flavour that
-- disagreed by a single gibibyte would fail every create. \`lab-medium\` (4 / 8192 / 64) is the
-- resize target, and growing ${templateDiskGib} GiB to 64 GiB is a valid grow.

COMMIT;
`;

if (process.argv.includes('--check')) {
  const existing = await readFile(SEED_PATH, 'utf8').catch(() => '');
  if (existing !== sql) {
    process.stderr.write(`${SEED_PATH} is stale. Run: pnpm run proxmox:generate-seed\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `db/seeds/0002_proxmox_testsrv.sql is current: ${addresses.length} exclusions from the ${capturedAt} survey.\n`,
    );
  }
} else {
  await writeFile(SEED_PATH, sql);
  process.stdout.write(
    `wrote db/seeds/0002_proxmox_testsrv.sql: ${addresses.length} exclusions from the ${capturedAt} survey.\n`,
  );
}
