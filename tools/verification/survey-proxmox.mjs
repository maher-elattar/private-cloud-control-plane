/**
 * Read-only survey of a Proxmox server, ahead of pointing the control plane at it.
 *
 * PATTERN — pre-flight survey. Several decisions in `terraform-provisioning-plan.md` are blocked
 * on facts that can only be read off the target: the clone template's disk size (which
 * `assertResources` requires to equal the flavour's `minimum_disk_gib` exactly), which storage
 * backs it, whether the configured bridge exists, and whether the reserved VMID interval is free.
 * Guessing any of them produces a failure at first apply instead of a finding here.
 *
 * **This script never mutates anything.** Every request is a GET except the login, and the login
 * is the one POST the Proxmox API requires to mint a ticket. There is no code path here that
 * creates, configures, powers, or deletes a VM.
 *
 * WHY it records third-party addresses but not third-party names: the in-use address list is
 * needed to seed `control.networks.exclusions` so the allocator cannot hand out an address that
 * is already live. The VM *names* on a shared server identify real people and belong in nobody's
 * git history, so they are counted and never written.
 *
 * Usage:
 *   node tools/verification/survey-proxmox.mjs
 *   node tools/verification/survey-proxmox.mjs --credentials=/path/to/file
 *
 * The credentials file is three lines — endpoint, username, password — and is gitignored.
 * Evidence: docs/verification/evidence/testsrv-survey.json
 *
 * @see terraform-provisioning-plan.md
 * @see docs/architecture/safety-invariants.md
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Default location of the gitignored three-line credentials file. */
const DEFAULT_CREDENTIALS = 'terraformProxServerTestCredntails.txt';

/** Where the machine-readable survey is written. */
const EVIDENCE_PATH = resolve('docs/verification/evidence/testsrv-survey.json');

/** The clone template this work targets. */
const TEMPLATE_VMID = 110;

/** The bridge the control plane is configured to attach instances to. */
const EXPECTED_BRIDGE = 'vmbr1';

/**
 * The VMID interval `ProxmoxProvider` clamps itself to.
 *
 * WHY it is surveyed rather than assumed: Proxmox permits 100 upwards, but `datacenter.cfg` may
 * carry a `next-id` range that excludes this interval, and any VM already sitting inside it would
 * collide with an allocation.
 */
const RESERVED_VMID_MINIMUM = 910_000;
const RESERVED_VMID_MAXIMUM = 910_099;

/** Config keys whose values are credential material and must never be written to evidence. */
const REDACTED_KEYS = new Set(['cipassword', 'sshkeys', 'ticket', 'CSRFPreventionToken']);

/** Reads the three-line credentials file without letting its contents reach stdout. */
async function credentials(path) {
  const lines = (await readFile(path, 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) {
    throw new Error(`${path} must hold three lines: endpoint, username, password.`);
  }
  const [endpoint, user, password] = lines;
  return {
    endpoint: endpoint.replace(/\/$/, ''),
    // Proxmox requires a realm. `root` alone is rejected; `root@pam` is what the UI sends.
    username: user.includes('@') ? user : `${user}@pam`,
    password,
  };
}

/** Exchanges username and password for a session ticket. The only non-GET in this script. */
async function login({ endpoint, username, password }) {
  const response = await fetch(`${endpoint}/api2/json/access/ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
  });
  if (!response.ok) throw new Error(`Login failed: ${response.status} ${response.statusText}`);
  const { data } = await response.json();
  if (!data?.ticket) throw new Error('Login succeeded but returned no ticket.');
  return data;
}

/** Strips credential-bearing keys from anything destined for the evidence file. */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) =>
      REDACTED_KEYS.has(key) ? [key, '<redacted>'] : [key, redact(member)],
    ),
  );
}

/** Extracts a disk size in GiB from a Proxmox disk specification string. */
function diskGiB(specification) {
  const match = /(?:^|,)size=(\d+(?:\.\d+)?)([KMGT])(?:,|$)/i.exec(specification ?? '');
  if (!match) return undefined;
  const factors = { k: 1 / 1024 / 1024, m: 1 / 1024, g: 1, t: 1024 };
  return Math.ceil(Number(match[1]) * factors[match[2].toLowerCase()]);
}

/** True when `address` falls inside `cidr`. IPv4 only; this survey has no IPv6 surface. */
function withinCidr(address, cidr) {
  const [network, prefix] = cidr.split('/');
  const toInteger = (value) =>
    value.split('.').reduce((accumulator, octet) => accumulator * 256 + Number(octet), 0);
  const mask = prefix === '0' ? 0 : (0xffffffff << (32 - Number(prefix))) >>> 0;
  return (toInteger(address) & mask) === (toInteger(network) & mask);
}

const flags = process.argv.slice(2);
const credentialsPath = resolve(
  flags.find((flag) => flag.startsWith('--credentials='))?.slice('--credentials='.length) ??
    DEFAULT_CREDENTIALS,
);

const secrets = await credentials(credentialsPath);
const session = await login(secrets);
const headers = { cookie: `PVEAuthCookie=${session.ticket}` };

/** Issues one read-only API call, recording an error rather than throwing. */
async function get(path) {
  const response = await fetch(`${secrets.endpoint}/api2/json${path}`, { headers });
  if (!response.ok) return { __error: `${response.status} ${response.statusText}` };
  return (await response.json()).data;
}

process.stdout.write(`surveying ${secrets.endpoint} as ${session.username}\n`);

const version = await get('/version');
const nodes = await get('/nodes');
const node = nodes?.[0]?.node;
if (!node) throw new Error('The server reported no nodes.');

const [clusterOptions, storage, network, virtualMachines, templateConfig, templateStatus] =
  await Promise.all([
    get('/cluster/options'),
    get(`/nodes/${node}/storage`),
    get(`/nodes/${node}/network`),
    get(`/nodes/${node}/qemu`),
    get(`/nodes/${node}/qemu/${TEMPLATE_VMID}/config`),
    get(`/nodes/${node}/qemu/${TEMPLATE_VMID}/status/current`),
  ]);

// --- Read every VM's configuration, to learn which addresses are already live ---
//
// WHY all of them: `assertIpv4Available` (SAFE-025) rechecks the address immediately before the
// network mutation by doing exactly this scan, so the cost measured here is the cost the adapter
// pays on every create. Recording it makes that a known number rather than a surprise.
const vmids = (virtualMachines ?? []).map((entry) => entry.vmid).sort((a, b) => a - b);
const configurationScanStarted = Date.now();
const configurations = new Map();
const SCAN_CONCURRENCY = 12;
let cursor = 0;
await Promise.all(
  Array.from({ length: SCAN_CONCURRENCY }, async () => {
    while (cursor < vmids.length) {
      const vmid = vmids[cursor];
      cursor += 1;
      configurations.set(vmid, await get(`/nodes/${node}/qemu/${vmid}/config`));
    }
  }),
);
const scanMs = Date.now() - configurationScanStarted;

const bridge = (network ?? []).find((entry) => entry.iface === EXPECTED_BRIDGE);
const bridgeCidr = bridge?.cidr ?? null;

const leasedAddresses = [];
let attachedToBridge = 0;
for (const [vmid, configuration] of configurations) {
  if (!configuration || configuration.__error) continue;
  for (const [key, value] of Object.entries(configuration)) {
    if (/^net\d+$/.test(key) && String(value).includes(`bridge=${EXPECTED_BRIDGE}`)) {
      attachedToBridge += 1;
    }
    if (/^ipconfig\d+$/.test(key)) {
      const match = /ip=(\d+\.\d+\.\d+\.\d+)\/(\d+)/.exec(String(value));
      if (match && bridgeCidr && withinCidr(match[1], bridgeCidr)) {
        leasedAddresses.push({ address: match[1], vmid, prefixLength: Number(match[2]) });
      }
    }
  }
}
leasedAddresses.sort((left, right) => withinCidrOrder(left.address, right.address));

/** Numeric ordering for dotted-quad addresses, so the evidence list reads in address order. */
function withinCidrOrder(left, right) {
  const toInteger = (value) =>
    value.split('.').reduce((accumulator, octet) => accumulator * 256 + Number(octet), 0);
  return toInteger(left) - toInteger(right);
}

const primaryDisk = templateConfig?.scsi0 ?? templateConfig?.virtio0 ?? templateConfig?.sata0;
const occupiedReserved = vmids.filter(
  (vmid) => vmid >= RESERVED_VMID_MINIMUM && vmid <= RESERVED_VMID_MAXIMUM,
);

const evidence = {
  capturedAt: new Date().toISOString(),
  endpoint: secrets.endpoint,
  authenticatedAs: session.username,
  capabilityGroups: Object.keys(session.cap ?? {}).sort(),
  version,
  node,
  nodeCount: (nodes ?? []).length,
  clusterOptions: redact(clusterOptions),
  storage: (storage ?? []).map((entry) => ({
    storage: entry.storage,
    type: entry.type,
    active: entry.active,
    content: entry.content,
  })),
  network: (network ?? []).map((entry) => ({
    iface: entry.iface,
    type: entry.type,
    active: entry.active,
    cidr: entry.cidr ?? null,
    address: entry.address ?? null,
    bridgePorts: entry.bridge_ports ?? null,
  })),
  template: {
    vmid: TEMPLATE_VMID,
    isTemplate: templateConfig?.template === 1,
    name: templateConfig?.name,
    diskSpecification: primaryDisk,
    diskGiB: diskGiB(primaryDisk),
    storage: primaryDisk?.split(':')[0],
    cpuCores: templateConfig?.cores,
    sockets: templateConfig?.sockets,
    memoryMib: templateConfig?.memory,
    guestAgent: templateConfig?.agent,
    cloudInitDrive: templateConfig?.ide0 ?? null,
    networkDevice: templateConfig?.net0,
    nameserver: templateConfig?.nameserver,
    cloudInitUser: templateConfig?.ciuser,
    powerState: templateStatus?.status,
    configuration: redact(templateConfig),
  },
  inventory: {
    virtualMachineCount: vmids.length,
    lowestVmid: vmids[0] ?? null,
    highestVmid: vmids.at(-1) ?? null,
    attachedToExpectedBridge: attachedToBridge,
    configurationScanMs: scanMs,
    configurationScanConcurrency: SCAN_CONCURRENCY,
    // The adapter's pre-mutation recheck is serial, so this is the per-create cost it would pay.
    estimatedSerialScanSeconds: Math.round((scanMs / 1000) * SCAN_CONCURRENCY),
  },
  reservedRange: {
    minimum: RESERVED_VMID_MINIMUM,
    maximum: RESERVED_VMID_MAXIMUM,
    occupied: occupiedReserved,
    free: occupiedReserved.length === 0,
    nextIdRestriction: clusterOptions?.['next-id'] ?? null,
  },
  addressesInUseOnBridge: {
    bridge: EXPECTED_BRIDGE,
    cidr: bridgeCidr,
    count: leasedAddresses.length,
    // Addresses and VMIDs only. Third-party VM names are deliberately not recorded.
    addresses: leasedAddresses,
  },
};

await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, undefined, 2)}\n`);

process.stdout.write(`\n${'-'.repeat(84)}\n`);
process.stdout.write(`node                  ${node}  (PVE ${version?.version})\n`);
process.stdout.write(`nodes                 ${evidence.nodeCount}\n`);
process.stdout.write(
  `template ${TEMPLATE_VMID}          ${evidence.template.name}  template=${evidence.template.isTemplate}  disk=${evidence.template.diskGiB}GiB  storage=${evidence.template.storage}\n`,
);
process.stdout.write(
  `template compute      ${evidence.template.cpuCores} cores, ${evidence.template.memoryMib} MiB, agent=${evidence.template.guestAgent}\n`,
);
process.stdout.write(`bridge ${EXPECTED_BRIDGE}         ${bridgeCidr ?? 'ABSENT'}\n`);
process.stdout.write(
  `virtual machines      ${evidence.inventory.virtualMachineCount} (${evidence.inventory.lowestVmid}-${evidence.inventory.highestVmid}), ${attachedToBridge} on ${EXPECTED_BRIDGE}\n`,
);
process.stdout.write(
  `reserved range        ${RESERVED_VMID_MINIMUM}-${RESERVED_VMID_MAXIMUM}  free=${evidence.reservedRange.free}  next-id=${evidence.reservedRange.nextIdRestriction ?? 'unrestricted'}\n`,
);
process.stdout.write(
  `addresses in use      ${leasedAddresses.length} inside ${bridgeCidr}  (must become exclusions)\n`,
);
process.stdout.write(
  `config scan           ${(scanMs / 1000).toFixed(1)}s at concurrency ${SCAN_CONCURRENCY}; ~${evidence.inventory.estimatedSerialScanSeconds}s serial\n`,
);
process.stdout.write(`${'-'.repeat(84)}\n`);
process.stdout.write(`Evidence: ${EVIDENCE_PATH}\n`);
