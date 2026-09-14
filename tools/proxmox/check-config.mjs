/**
 * Asserts that the seeded catalog and the `PROXMOX_*` environment describe the same server.
 *
 * PATTERN — fail at configuration time, not at mutation time. Server-specific values live in two
 * places: rows in `control.provider_profiles` / `control.networks` / `control.images`, and
 * environment variables read by `provider.factory.ts`. Three of them are cross-checked at runtime
 * — `assertNetwork` compares the event's network id, gateway and prefix length against the
 * configured ones, and `submitCreateInstance` compares the image id — but only at the point of
 * use, minutes into a workflow, and only as `protocol_error` with a message that does not say
 * which value disagreed.
 *
 * This turns that into a named mismatch reported before anything runs.
 *
 * It also checks the one trap that has no runtime guard until it is far too late:
 * `assertResources` refuses a create unless the requested disk equals the clone template's disk
 * **exactly**, and the requested disk comes from the flavour's `minimum_disk_gib`. A flavour that
 * disagrees with the template by a single gibibyte fails every create, with an error that blames
 * the allowlist rather than the catalog.
 *
 * Read-only against both the database and the survey evidence. It opens no connection to Proxmox.
 *
 * Usage:
 *   DATABASE_URL=... node tools/proxmox/check-config.mjs
 *
 * @see db/seeds/0002_proxmox_testsrv.sql
 * @see docs/verification/testsrv-survey.md
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { connectWhenReady } from '../db/postgres-ready.mjs';

/** The survey, for the template facts the database does not hold. */
const EVIDENCE_PATH = resolve('docs/verification/evidence/testsrv-survey.json');

/** `dnsTuple` in the store rejects a network with fewer than 1 or more than 4 resolvers. */
const MINIMUM_DNS_SERVERS = 1;
const MAXIMUM_DNS_SERVERS = 4;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required.');

/** Reads a required setting, collecting rather than throwing so every problem is reported. */
const missing = [];
function setting(name) {
  const value = process.env[name]?.trim();
  if (!value) missing.push(name);
  return value;
}

const configured = {
  providerProfileId: setting('PROXMOX_PROVIDER_PROFILE_ID'),
  endpoint: setting('PROXMOX_ENDPOINT'),
  node: setting('PROXMOX_NODE'),
  storage: setting('PROXMOX_STORAGE'),
  bridge: setting('PROXMOX_BRIDGE'),
  templateVmid: setting('PROXMOX_TEMPLATE_VMID'),
  imageId: setting('PROXMOX_IMAGE_ID'),
  networkId: setting('PROXMOX_NETWORK_ID'),
  ipv4Cidr: setting('PROXMOX_IPV4_CIDR'),
  ipv4Gateway: setting('PROXMOX_IPV4_GATEWAY'),
  vmidMinimum: setting('PROXMOX_VMID_MINIMUM'),
  vmidMaximum: setting('PROXMOX_VMID_MAXIMUM'),
  projectId: setting('PROXMOX_PROJECT_ID'),
};

if (missing.length > 0) {
  process.stderr.write(
    `Not configured for Proxmox. Missing: ${missing.join(', ')}\n` +
      'Set every PROXMOX_* value, or run with PROVIDER_ADAPTER=fake and skip this check.\n',
  );
  process.exitCode = 1;
  process.exit();
}

const findings = [];

/** Records one comparison. `expected` is what the environment says; `actual` what the row holds. */
function compare(label, expected, actual) {
  const agrees = String(expected) === String(actual);
  findings.push({ label, expected, actual, ok: agrees });
}

/** Records a standalone assertion that is not a two-sided comparison. */
function assertThat(label, ok, detail) {
  findings.push({ label, expected: detail, actual: ok ? detail : 'not satisfied', ok });
}

const pool = new pg.Pool({ connectionString, max: 1 });
const client = await connectWhenReady(pool);
try {
  const profile = (
    await client.query('SELECT * FROM control.provider_profiles WHERE id = $1', [
      configured.providerProfileId,
    ])
  ).rows[0];

  if (!profile) {
    process.stderr.write(
      `control.provider_profiles has no row '${configured.providerProfileId}'.\n` +
        'Run: pnpm run db:seed\n',
    );
    process.exitCode = 1;
    process.exit();
  }

  compare('profile.endpoint', configured.endpoint, profile.endpoint);
  compare('profile.compute_target (node)', configured.node, profile.compute_target);
  compare('profile.storage_target', configured.storage, profile.storage_target);
  compare('profile.network_attachment (bridge)', configured.bridge, profile.network_attachment);
  compare(
    'profile.image_source_reference (template)',
    configured.templateVmid,
    profile.image_source_reference,
  );
  compare('profile.network_id', configured.networkId, profile.network_id);
  compare('profile.resource_id_minimum', configured.vmidMinimum, profile.resource_id_minimum);
  compare('profile.resource_id_maximum', configured.vmidMaximum, profile.resource_id_maximum);
  assertThat('profile.provider_type is proxmox', profile.provider_type === 'proxmox', 'proxmox');
  assertThat("profile.state is 'active'", profile.state === 'active', 'active');
  // A credential *value* in this column would be a SAFE-036 violation committed to the database.
  assertThat(
    'profile.credential_reference is a name, not a secret',
    !/=|BEGIN |[0-9a-f]{16}/.test(String(profile.credential_reference)),
    'a reference',
  );

  const network = (
    await client.query('SELECT * FROM control.networks WHERE id = $1', [configured.networkId])
  ).rows[0];

  if (network) {
    // Postgres renders `cidr` canonically, so this comparison also catches host bits in the env.
    compare('network.ipv4_cidr', configured.ipv4Cidr, network.ipv4_cidr);
    compare('network.gateway', configured.ipv4Gateway, network.gateway);
    assertThat('network.enabled', network.enabled === true, 'true');
    const dns = Array.isArray(network.dns_servers) ? network.dns_servers : [];
    assertThat(
      `network.dns_servers holds ${MINIMUM_DNS_SERVERS} to ${MAXIMUM_DNS_SERVERS} entries`,
      dns.length >= MINIMUM_DNS_SERVERS && dns.length <= MAXIMUM_DNS_SERVERS,
      `${dns.length} configured`,
    );
    const exclusions = Array.isArray(network.exclusions) ? network.exclusions : [];
    assertThat(
      'network.exclusions is populated',
      exclusions.length > 0,
      `${exclusions.length} addresses`,
    );
  } else {
    assertThat(`control.networks has row '${configured.networkId}'`, false, 'the row');
  }

  const image = (
    await client.query('SELECT * FROM control.images WHERE id = $1', [configured.imageId])
  ).rows[0];

  if (image) {
    // submitCreateInstance throws unless request.imageId equals the configured image id, and the
    // request's image id is whatever the caller sent — so this row must exist and point at this
    // profile, or acceptance resolves a different profile than the adapter enforces.
    compare('image.provider_profile_id', configured.providerProfileId, image.provider_profile_id);
    assertThat('image.enabled', image.enabled === true, 'true');
  } else {
    assertThat(`control.images has row '${configured.imageId}'`, false, 'the row');
  }

  const project = (
    await client.query('SELECT * FROM control.projects WHERE id = $1', [configured.projectId])
  ).rows[0];
  assertThat(
    `control.projects has row '${configured.projectId}'`,
    Boolean(project) && project.enabled === true,
    'an enabled project',
  );

  // --- The flavour-versus-template trap ---
  const evidence = await readFile(EVIDENCE_PATH, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => undefined);
  const templateDiskGib = evidence?.template?.diskGiB;

  if (templateDiskGib === undefined) {
    assertThat(
      'the survey records the template disk size',
      false,
      'run pnpm run survey:proxmox first',
    );
  } else {
    const flavours = (
      await client.query(
        'SELECT id, cpu_count, memory_mib, minimum_disk_gib FROM control.flavors WHERE enabled = true ORDER BY minimum_disk_gib',
      )
    ).rows;
    const matching = flavours.filter(
      (flavour) => Number(flavour.minimum_disk_gib) === Number(templateDiskGib),
    );
    assertThat(
      `a flavour matches template disk ${templateDiskGib} GiB exactly`,
      matching.length > 0,
      matching.length > 0
        ? matching.map((flavour) => flavour.id).join(', ')
        : `none of ${flavours.map((f) => `${f.id}=${f.minimum_disk_gib}`).join(' ')}`,
    );
    // The survey also records the template's compute, which the matching flavour should reflect —
    // a mismatch here is not fatal (only disk is compared exactly) but it is always a mistake.
    for (const flavour of matching) {
      assertThat(
        `flavour '${flavour.id}' matches template compute`,
        Number(flavour.cpu_count) === Number(evidence.template.cpuCores) &&
          Number(flavour.memory_mib) === Number(evidence.template.memoryMib),
        `${evidence.template.cpuCores} vCPU / ${evidence.template.memoryMib} MiB`,
      );
    }
  }
} finally {
  client.release();
  await pool.end();
}

// --- Report ---

const failures = findings.filter((finding) => !finding.ok);
const width = Math.max(...findings.map((finding) => finding.label.length));

process.stdout.write(`configuration cross-check for profile '${configured.providerProfileId}'\n\n`);
for (const finding of findings) {
  const mark = finding.ok ? 'agrees ' : 'DIFFERS';
  const detail = finding.ok
    ? String(finding.actual)
    : `environment '${finding.expected}' vs catalog '${finding.actual}'`;
  process.stdout.write(`  ${mark}  ${finding.label.padEnd(width)}  ${detail}\n`);
}

process.stdout.write(
  `\n${failures.length === 0 ? `${findings.length} checks agree` : `${failures.length} of ${findings.length} checks disagree`}\n`,
);
if (failures.length > 0) process.exitCode = 1;
