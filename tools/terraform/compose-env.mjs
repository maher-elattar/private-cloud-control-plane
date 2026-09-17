/**
 * Writes the gitignored environment file the Terraform compose overlay reads.
 *
 * WHY generate it: the overlay needs twenty-two settings that must agree exactly with the seeded
 * catalog rows and with the surveyed server, and three of them are secrets. Populated by hand,
 * the failure mode is a provider that starts happily and refuses every create minutes later with
 * an opaque `protocol_error` — or, worse, one pointed at the wrong node. Every value here is read
 * from the credentials file or from the recorded survey; none is typed twice.
 *
 * The output file holds the API token and the cloud-init password, so it is written 0600 into a
 * gitignored path and is never printed.
 *
 * Usage:
 *   node tools/terraform/compose-env.mjs
 *   node tools/terraform/compose-env.mjs --check    # verify without writing
 *
 * @see deploy/local/compose.terraform.yaml
 * @see tools/proxmox/check-config.mjs
 */
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** The gitignored credentials file at the repository root. */
const CREDENTIALS_PATH = resolve('terraformProxServerTestCredntails.txt');

/** The recorded survey, which is where every server fact comes from. */
const SURVEY_PATH = resolve('docs/verification/evidence/testsrv-survey.json');

/** Written next to the compose files, and gitignored. */
const OUTPUT_PATH = resolve('deploy/local/.env.terraform');

/** Owner read/write only. It holds two secrets. */
const FILE_MODE = 0o600;

/**
 * The catalog identifiers seeded by `db/seeds/0002_proxmox_testsrv.sql`.
 *
 * Hard-coded rather than read from the database, deliberately: this file is what configures the
 * provider, and reading the identifiers from the same database the provider will read would make
 * the agreement unfalsifiable. `pnpm run proxmox:check-config` compares the two.
 */
const CATALOG = {
  PROXMOX_PROVIDER_PROFILE_ID: 'proxmox-testsrv',
  PROXMOX_NETWORK_ID: 'testsrv-vmbr1',
  PROXMOX_IMAGE_ID: 'ubuntu-noble-2404',
  PROXMOX_PROJECT_ID: '00000000-0000-4000-8000-0000000000a1',
  // The address pool is an operator decision recorded in the seed, not a surveyed fact. The
  // bridge carries 192.168.4.1/22, so the network address is 192.168.4.0/22.
  PROXMOX_IPV4_CIDR: '192.168.4.0/22',
  PROXMOX_IPV4_GATEWAY: '192.168.4.1',
  // The module's own choice, and the only interface the disk block is written for.
  PROXMOX_DISK_INTERFACE: 'scsi0',
  // Template 110 bakes in a `searchdomain`, which bpg cannot clear: an unset domain leaves the
  // inherited value in place and every plan diffs forever. So a domain is always declared, and
  // `.invalid` is the reserved TLD that cannot resolve anywhere (RFC 2606) — a lab instance must
  // not inherit a search domain that resolves against somebody's real zone.
  PROXMOX_DNS_DOMAIN: 'lab.invalid',
};

/**
 * State backend connection string, as seen from inside the compose network.
 *
 * `sslmode=disable` is explicit because the runner refuses a string without one. It is correct
 * here and only here: this Postgres is a container on a private compose network reached by service
 * name, holding lab state. A deployed control plane supplies its own string with `sslmode=require`.
 */
/** The guest account cloud-init creates. */
const CLOUD_INIT_USERNAME = 'ubuntu';

const STATE_CONNECTION_STRING =
  'postgresql://private_cloud:private_cloud@postgres:5432/private_cloud?sslmode=disable';

/** Reads one `KEY=value` line from the credentials file. */
function credential(contents, key) {
  const line = contents.split('\n').find((candidate) => candidate.startsWith(`${key}=`));
  const value = line?.slice(key.length + 1).trim();
  if (!value) throw new Error(`${key} is missing from ${CREDENTIALS_PATH}`);
  return value;
}

/**
 * Reads one key out of a Proxmox comma-separated property list.
 *
 * The survey records the template's network device verbatim, because that is the form Proxmox
 * returns: `virtio=BC:24:11:…,bridge=vmbr1,firewall=1,mtu=1400`. The bridge and the MTU are read
 * from it rather than restated, so a template rebuilt onto a different bridge cannot leave this
 * file pointing at the old one.
 */
function property(specification, key) {
  const match = new RegExp(`(?:^|,)${key}=([^,]+)`).exec(specification ?? '');
  if (!match) throw new Error(`No ${key} in the surveyed network device: ${specification}`);
  return match[1];
}

const credentials = await readFile(CREDENTIALS_PATH, 'utf8').catch(() => {
  throw new Error(`Credentials file is missing or unreadable: ${CREDENTIALS_PATH}`);
});
const survey = JSON.parse(await readFile(SURVEY_PATH, 'utf8'));

const template = survey.template ?? {};
const reservation = survey.reservedRange ?? {};

/** The settings, assembled: secrets from the credentials file, server facts from the survey. */
const settings = {
  PROXMOX_ENDPOINT: credential(credentials, 'PROXMOX_ENDPOINT'),
  PROXMOX_API_TOKEN_ID: credential(credentials, 'PROXMOX_API_TOKEN_ID'),
  PROXMOX_API_TOKEN_SECRET: credential(credentials, 'PROXMOX_API_TOKEN_SECRET'),
  // One standalone node, so the alias and the node name are the same string. They are separate
  // settings because a cluster would make them differ.
  PROXMOX_CLUSTER_ALIAS: survey.node,
  PROXMOX_NODE: survey.node,
  ...CATALOG,
  PROXMOX_TEMPLATE_VMID: String(template.vmid ?? ''),
  // The surveyed disk format. It decides whether the adapter reports snapshot support, because
  // Proxmox refuses to snapshot a `raw` disk and a full clone inherits its template's format.
  PROXMOX_TEMPLATE_DISK_FORMAT: String(template.diskFormat ?? 'raw'),
  PROXMOX_STORAGE: template.storage ?? '',
  PROXMOX_BRIDGE: property(template.networkDevice, 'bridge'),
  PROXMOX_NETWORK_MTU: property(template.networkDevice, 'mtu'),
  PROXMOX_VMID_MINIMUM: String(reservation.minimum ?? ''),
  PROXMOX_VMID_MAXIMUM: String(reservation.maximum ?? ''),
  // The operator's choice of guest account, matching what the live verifier uses so the two
  // paths produce identical VMs. The password is the lab administrator's, which is a recorded lab
  // exposure rather than a design: the credentials file carries no separate guest secret, and
  // inventing one here would put a value in a tracked file.
  PROXMOX_CLOUD_INIT_USER: CLOUD_INIT_USERNAME,
  PROXMOX_CLOUD_INIT_PASSWORD: credential(credentials, 'PROXMOX_ROOT_PASSWORD'),
  TERRAFORM_STATE_CONN_STR: STATE_CONNECTION_STRING,
};

// No setting may be blank. Measured, not assumed: compose's `${VAR:?}` rejects an empty value as
// well as an absent one, and the factory's `requiredEnvironment` trims before testing. So a survey
// that changed shape fails here rather than producing a provider configured with blanks.
const blank = Object.entries(settings)
  .filter(([, value]) => value === '' || value == null)
  .map(([name]) => name);
if (blank.length > 0) {
  throw new Error(`No value derived for: ${blank.join(', ')}. Re-run pnpm run survey:proxmox.`);
}

// The disk size the template actually has must equal the seeded flavour's minimum, because
// `assertResources` compares them for exact equality. Checked here so the mismatch surfaces before
// a container starts rather than as a refused create.
if (template.diskGiB !== 32) {
  throw new Error(
    `Template ${template.vmid} has a ${template.diskGiB} GiB disk; the seeded flavour requires 32. ` +
      'Re-run pnpm run proxmox:generate-seed.',
  );
}

const rendered = `# Generated by tools/terraform/compose-env.mjs. Do not commit; do not hand-edit.
# Holds the Proxmox API token and the cloud-init password.
${Object.entries(settings)
  .map(([name, value]) => `${name}=${value}`)
  .join('\n')}
`;

if (process.argv.includes('--check')) {
  const existing = await readFile(OUTPUT_PATH, 'utf8').catch(() => null);
  if (existing !== rendered) {
    throw new Error(`${OUTPUT_PATH} is missing or stale. Run pnpm run terraform:compose-env.`);
  }
  console.log(`${OUTPUT_PATH} is current (${Object.keys(settings).length} settings).`);
} else {
  await writeFile(OUTPUT_PATH, rendered, { mode: FILE_MODE });
  await chmod(OUTPUT_PATH, FILE_MODE);
  // Names only. Printing a value would put the token in the terminal scrollback and in CI logs.
  console.log(`Wrote ${OUTPUT_PATH} (0600) with ${Object.keys(settings).length} settings:`);
  console.log(Object.keys(settings).sort().join(' '));
}
