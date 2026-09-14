/**
 * Creates a narrowly scoped Proxmox API token for the control plane, and proves its boundaries.
 *
 * PATTERN — least privilege, verified rather than asserted. The direct adapter authenticates only
 * with `PVEAPIToken`, so a password cannot drive it at all; and the credentials supplied for this
 * work are `root@pam`, which on a server hosting 211 machines belonging to other people is far
 * more authority than this system needs. This tool replaces that with a dedicated user whose
 * permissions are an explicit list, then demonstrates that paths outside the list are refused.
 *
 * **It is idempotent.** Re-running it reuses the role, pool, user and ACL entries it already
 * created. The one thing it cannot reuse is the token secret, which Proxmox returns exactly once —
 * so a token that already exists is deleted and re-minted, and the new secret is written to the
 * credentials file.
 *
 * The secret is never printed, never logged, and never returned. It goes straight into the
 * gitignored credentials file. SAFE-036 governs what enters history and SAFE-031 what enters
 * logs; a tool that echoed the secret it just minted would defeat both.
 *
 * Usage:
 *   node tools/proxmox/create-api-token.mjs            # create or re-mint, then verify
 *   node tools/proxmox/create-api-token.mjs --verify   # verify an existing token only
 *
 * @see terraform-provisioning-checkpoints.md
 * @see docs/architecture/safety-invariants.md
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** The gitignored credentials file this tool reads root access from and writes the token into. */
const CREDENTIALS_PATH = resolve('terraformProxServerTestCredntails.txt');

/** Identities and scopes this tool owns. Everything else on the server is left alone. */
const ROLE_ID = 'ControlPlaneLifecycle';
const POOL_ID = 'control-plane-lab';
const USER_ID = 'control-plane@pve';
const TOKEN_NAME = 'provisioner';

/** The node, storage and template this deployment is allowlisted to. */
const NODE = 'proxtest';
const STORAGE = 'local';
const TEMPLATE_VMID = 110;

/** The reserved VMID interval the adapter clamps itself to. */
const VMID_MINIMUM = 910_000;
const VMID_MAXIMUM = 910_099;

/**
 * Exactly the privileges the nine lifecycle capabilities need, and nothing else.
 *
 * WHY each is here rather than taking the built-in `PVEVMAdmin`: that role also carries
 * `VM.Console`, `VM.Backup`, `VM.Migrate`, `VM.Replicate` and the unrestricted guest-agent
 * privileges. None of them is used by any capability in scope, and `VM.GuestAgent.Unrestricted`
 * in particular would let this token run arbitrary commands inside any guest it can reach.
 */
const ROLE_PRIVILEGES = [
  // Create, clone, read.
  'VM.Allocate',
  'VM.Clone',
  'VM.Audit',
  // Configuration, one privilege per surface the module writes.
  'VM.Config.CPU',
  'VM.Config.Memory',
  'VM.Config.Disk',
  'VM.Config.Network',
  'VM.Config.Options',
  'VM.Config.CDROM',
  'VM.Config.Cloudinit',
  'VM.Config.HWType',
  // Power.
  'VM.PowerMgmt',
  // Snapshots, which stay on the direct API because bpg has no snapshot resource.
  'VM.Snapshot',
  'VM.Snapshot.Rollback',
  // Reading guest addresses, which is how observeInstance learns the instance's real IP.
  // Deliberately the audit privilege only: the file and exec privileges are not granted.
  'VM.GuestAgent.Audit',
  // Disk allocation on the one allowlisted storage.
  'Datastore.AllocateSpace',
  'Datastore.Audit',
];

/** Read-only node access, needed by validateProfile's node-status check. */
const NODE_ROLE_ID = 'ControlPlaneNodeAudit';
const NODE_ROLE_PRIVILEGES = ['Sys.Audit'];

/**
 * Permission to attach a VM to one specific bridge.
 *
 * WHY an SDN privilege appears in work that deliberately excludes SDN: Proxmox filters the
 * `/nodes/{node}/network` listing by permission, and a bridge is only visible to a caller holding
 * `SDN.Use` on it — measured, with `Sys.Audit` on the node alone the token saw 3 of 9 interfaces
 * and `vmbr1` was not among them, which would make `validateProfile`'s bridge check report the
 * bridge as absent. This is not SDN administration: the grant is `SDN.Use` on a single bridge,
 * and the token still holds nothing on `/sdn` itself, so it can neither enumerate nor create
 * zones, vnets or subnets.
 */
const BRIDGE_ROLE_ID = 'ControlPlaneBridgeUse';
const BRIDGE_ROLE_PRIVILEGES = ['SDN.Use'];
const BRIDGE = 'vmbr1';
/** Proxmox files plain Linux bridges under this synthetic zone, even with no SDN configured. */
const BRIDGE_ACL_PATH = `/sdn/zones/localnetwork/${BRIDGE}`;

/**
 * Effective-permission assertions, checked after the token is minted.
 *
 * WHY this is done through `/access/permissions` rather than by attempting forbidden calls: the
 * boundary that matters on this server is that the token cannot stop or delete one of the 211
 * machines belonging to other people. Proving that by *trying* would mean that a wrong ACL is
 * discovered by destroying someone's VM. Asking Proxmox for the token's effective privileges on a
 * path is authoritative, read-only, and cannot damage anything.
 *
 * Each entry is a path, the privileges that must be present, and the privileges that must be
 * absent.
 */
const PERMISSION_ASSERTIONS = [
  {
    path: `/vms/${VMID_MINIMUM}`,
    label: 'our reserved VMID',
    required: ['VM.Allocate', 'VM.Config.Disk', 'VM.PowerMgmt', 'VM.Audit'],
    forbidden: ['VM.Console', 'VM.GuestAgent.Unrestricted', 'VM.Backup', 'VM.Migrate'],
  },
  {
    path: '/vms/101',
    label: "another tenant's VM",
    required: [],
    forbidden: ['VM.Allocate', 'VM.PowerMgmt', 'VM.Config.Disk', 'VM.Config.Options', 'VM.Audit'],
  },
  {
    path: `/vms/${VMID_MAXIMUM + 1}`,
    label: 'one past the reserved interval',
    required: [],
    forbidden: ['VM.Allocate', 'VM.PowerMgmt', 'VM.Config.Disk'],
  },
  {
    path: `/vms/${TEMPLATE_VMID}`,
    label: 'the clone template',
    required: ['VM.Clone', 'VM.Audit'],
    forbidden: [],
  },
  {
    path: `/storage/${STORAGE}`,
    label: 'the allowlisted storage',
    required: ['Datastore.AllocateSpace', 'Datastore.Audit'],
    forbidden: ['Datastore.Allocate'],
  },
  {
    path: `/nodes/${NODE}`,
    label: 'the node',
    required: ['Sys.Audit'],
    forbidden: ['Sys.Modify', 'Sys.PowerMgmt', 'Sys.Console'],
  },
  {
    path: '/access',
    label: 'user administration',
    required: [],
    forbidden: ['User.Modify', 'Permissions.Modify', 'Realm.Allocate'],
  },
  {
    path: '/sdn',
    label: 'SDN as a whole',
    required: [],
    forbidden: ['SDN.Allocate', 'SDN.Audit', 'SDN.Use'],
  },
  {
    path: BRIDGE_ACL_PATH,
    label: 'the one allowlisted bridge',
    required: ['SDN.Use'],
    forbidden: ['SDN.Allocate', 'SDN.Audit'],
  },
  {
    path: '/',
    label: 'the root path',
    required: [],
    forbidden: ['VM.Allocate', 'VM.PowerMgmt', 'Sys.Modify', 'Permissions.Modify'],
  },
];

const flags = process.argv.slice(2);
const verifyOnly = flags.includes('--verify');

// --- Credentials file, in either the legacy three-line form or KEY=value ---

/** Parses the credentials file, accepting the original three-line layout or KEY=value lines. */
function parseCredentials(text) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (lines.some((line) => /^[A-Z][A-Z0-9_]*=/.test(line))) {
    const values = Object.fromEntries(
      lines
        .filter((line) => line.includes('='))
        .map((line) => {
          const index = line.indexOf('=');
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    return {
      endpoint: values.PROXMOX_ENDPOINT?.replace(/\/$/, ''),
      rootUsername: values.PROXMOX_ROOT_USERNAME,
      rootPassword: values.PROXMOX_ROOT_PASSWORD,
      tokenId: values.PROXMOX_API_TOKEN_ID,
      tokenSecret: values.PROXMOX_API_TOKEN_SECRET,
    };
  }
  const [endpoint, user, password] = lines;
  return {
    endpoint: endpoint?.replace(/\/$/, ''),
    rootUsername: user?.includes('@') ? user : `${user}@pam`,
    rootPassword: password,
  };
}

const credentials = parseCredentials(await readFile(CREDENTIALS_PATH, 'utf8'));
if (!credentials.endpoint) throw new Error(`${CREDENTIALS_PATH}: no endpoint found.`);

/** Authenticates as the administrator, for the token-administration calls only. */
async function administratorSession() {
  if (!credentials.rootPassword) {
    throw new Error('Administrator credentials are required to create or re-mint a token.');
  }
  const response = await fetch(`${credentials.endpoint}/api2/json/access/ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: credentials.rootUsername,
      password: credentials.rootPassword,
    }),
  });
  if (!response.ok) throw new Error(`Administrator login failed: ${response.status}`);
  const { data } = await response.json();
  return {
    cookie: `PVEAuthCookie=${data.ticket}`,
    csrf: data.CSRFPreventionToken,
  };
}

/** One administrative call. Returns `{ ok, status, data }` rather than throwing, so callers
 * can treat "already exists" as success. */
async function administer(session, method, path, body) {
  const response = await fetch(`${credentials.endpoint}/api2/json${path}`, {
    method,
    headers: {
      cookie: session.cookie,
      CSRFPreventionToken: session.csrf,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body: new URLSearchParams(body) } : {}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { ok: response.ok, status: response.status, data: parsed?.data, raw: text };
}

/** Reports what an administrative step did, without ever echoing a secret. */
function report(step, result, alreadyExists = 'already present') {
  if (result.ok) {
    process.stdout.write(`  created  ${step}\n`);
    return true;
  }
  if (result.status === 500 && /already exists/i.test(result.raw)) {
    process.stdout.write(`  reused   ${step} (${alreadyExists})\n`);
    return true;
  }
  process.stdout.write(`  FAILED   ${step}: ${result.status} ${result.raw.slice(0, 160)}\n`);
  return false;
}

let tokenId = credentials.tokenId;

if (!verifyOnly) {
  const session = await administratorSession();
  process.stdout.write(`administering ${credentials.endpoint} as ${credentials.rootUsername}\n`);

  // --- Roles ---
  report(
    `role ${ROLE_ID}`,
    await administer(session, 'POST', '/access/roles', {
      roleid: ROLE_ID,
      privs: ROLE_PRIVILEGES.join(','),
    }),
  );
  // A re-run must also correct the privilege list if it has changed here.
  await administer(session, 'PUT', `/access/roles/${ROLE_ID}`, {
    privs: ROLE_PRIVILEGES.join(','),
  });
  report(
    `role ${NODE_ROLE_ID}`,
    await administer(session, 'POST', '/access/roles', {
      roleid: NODE_ROLE_ID,
      privs: NODE_ROLE_PRIVILEGES.join(','),
    }),
  );
  report(
    `role ${BRIDGE_ROLE_ID}`,
    await administer(session, 'POST', '/access/roles', {
      roleid: BRIDGE_ROLE_ID,
      privs: BRIDGE_ROLE_PRIVILEGES.join(','),
    }),
  );

  // --- Pool and user ---
  report(`pool ${POOL_ID}`, await administer(session, 'POST', '/pools', { poolid: POOL_ID }));
  report(
    `user ${USER_ID}`,
    await administer(session, 'POST', '/access/users', {
      userid: USER_ID,
      enable: '1',
      comment: 'Control plane provisioner. No password; token authentication only.',
    }),
  );

  // --- Access control entries ---
  //
  // WHY the reserved VMID interval is enumerated rather than covered by a single path: Proxmox
  // ACL paths have no range syntax, and `/vms` would grant authority over all 211 machines on
  // this node. One hundred explicit entries is verbose, but it is the exact boundary, and being
  // unable to name a VM outside the interval is a stronger guarantee than intending not to.
  const vmidPaths = [];
  for (let vmid = VMID_MINIMUM; vmid <= VMID_MAXIMUM; vmid += 1) vmidPaths.push(`/vms/${vmid}`);

  const acls = [
    { path: `/pool/${POOL_ID}`, roleid: ROLE_ID, label: `pool ${POOL_ID}` },
    { path: `/storage/${STORAGE}`, roleid: ROLE_ID, label: `storage ${STORAGE}` },
    { path: `/vms/${TEMPLATE_VMID}`, roleid: ROLE_ID, label: `template ${TEMPLATE_VMID}` },
    { path: `/nodes/${NODE}`, roleid: NODE_ROLE_ID, label: `node ${NODE} (audit only)` },
    { path: BRIDGE_ACL_PATH, roleid: BRIDGE_ROLE_ID, label: `bridge ${BRIDGE} (use only)` },
  ];

  for (const acl of acls) {
    report(
      `acl ${acl.label} -> ${acl.roleid}`,
      await administer(session, 'PUT', '/access/acl', {
        path: acl.path,
        roles: acl.roleid,
        users: USER_ID,
        propagate: '1',
      }),
    );
  }

  // The interval, in one call per chunk to keep the request bodies small.
  const CHUNK = 25;
  for (let index = 0; index < vmidPaths.length; index += CHUNK) {
    const chunk = vmidPaths.slice(index, index + CHUNK);
    for (const path of chunk) {
      await administer(session, 'PUT', '/access/acl', {
        path,
        roles: ROLE_ID,
        users: USER_ID,
        propagate: '1',
      });
    }
  }
  process.stdout.write(
    `  created  acl ${VMID_MINIMUM}-${VMID_MAXIMUM} -> ${ROLE_ID} (${vmidPaths.length} entries)\n`,
  );

  // --- Token. Deleted and re-minted, because the secret is returned only at creation ---
  await administer(session, 'DELETE', `/access/users/${USER_ID}/token/${TOKEN_NAME}`);
  const minted = await administer(session, 'POST', `/access/users/${USER_ID}/token/${TOKEN_NAME}`, {
    comment: 'Control plane provisioner token.',
    // privsep=0: the token inherits the user's permissions, and the user is already the narrow
    // identity created above. With privsep=1 the token would additionally need its own ACLs.
    privsep: '0',
  });
  if (!minted.ok || !minted.data?.value) {
    throw new Error(`Minting the token failed: ${minted.status} ${minted.raw.slice(0, 200)}`);
  }
  tokenId = minted.data['full-tokenid'];
  process.stdout.write(`  created  token ${tokenId}\n`);

  // --- Write the credentials file. The secret goes here and nowhere else ---
  const rewritten = [
    '# Proxmox credentials for the control plane. This file is gitignored and must stay that way.',
    '#',
    '# The token is what the adapters use. The administrator credentials below are retained only',
    '# for re-running tools/proxmox/create-api-token.mjs, and rotating them does not invalidate',
    '# the token.',
    '',
    `PROXMOX_ENDPOINT=${credentials.endpoint}`,
    `PROXMOX_API_TOKEN_ID=${tokenId}`,
    `PROXMOX_API_TOKEN_SECRET=${minted.data.value}`,
    '',
    '# Administrative, for token management only.',
    `PROXMOX_ROOT_USERNAME=${credentials.rootUsername}`,
    `PROXMOX_ROOT_PASSWORD=${credentials.rootPassword}`,
    '',
  ].join('\n');
  await writeFile(CREDENTIALS_PATH, rewritten);
  process.stdout.write(`  wrote    ${CREDENTIALS_PATH} (secret not echoed)\n`);
}

// --- Verification: the token works, and its boundaries hold ---

const verification = parseCredentials(await readFile(CREDENTIALS_PATH, 'utf8'));
if (!verification.tokenId || !verification.tokenSecret) {
  throw new Error('No token in the credentials file to verify.');
}
const tokenHeaders = {
  Authorization: `PVEAPIToken=${verification.tokenId}=${verification.tokenSecret}`,
};

/** One read with the token, reporting only the status. */
async function probe(path) {
  const response = await fetch(`${credentials.endpoint}/api2/json${path}`, {
    headers: tokenHeaders,
  });
  return response.status;
}

process.stdout.write('\nverifying the token can do its job\n');
const allowed = [
  ['/version', 'API version'],
  [`/nodes/${NODE}/status`, 'node status (validateProfile)'],
  [`/nodes/${NODE}/network`, 'bridge list (validateProfile)'],
  [`/nodes/${NODE}/storage/${STORAGE}/status`, 'storage status (validateProfile)'],
  [`/nodes/${NODE}/qemu/${TEMPLATE_VMID}/config`, 'template config'],
];

/**
 * The bridge must be *visible*, not merely permitted.
 *
 * `validateProfile` matches `/nodes/{node}/network` entries by `iface`, so a bridge Proxmox
 * filters out of that listing is indistinguishable from one that does not exist.
 */
async function bridgeVisible() {
  const response = await fetch(`${credentials.endpoint}/api2/json/nodes/${NODE}/network`, {
    headers: tokenHeaders,
  });
  if (!response.ok) return false;
  const { data } = await response.json();
  return Array.isArray(data) && data.some((entry) => entry.iface === BRIDGE);
}

let failures = 0;
for (const [path, label] of allowed) {
  const status = await probe(path);
  const ok = status === 200;
  if (!ok) failures += 1;
  process.stdout.write(`  ${ok ? 'allowed ' : 'BLOCKED '} ${status}  ${label}\n`);
}

const visible = await bridgeVisible();
if (!visible) failures += 1;
process.stdout.write(
  `  ${visible ? 'allowed ' : 'BLOCKED '} ${visible ? '200' : '---'}  ${BRIDGE} appears in the interface listing\n`,
);

process.stdout.write('\nverifying the boundaries, by effective privilege rather than by trying\n');
for (const assertion of PERMISSION_ASSERTIONS) {
  const response = await fetch(
    `${credentials.endpoint}/api2/json/access/permissions?path=${encodeURIComponent(assertion.path)}`,
    { headers: tokenHeaders },
  );
  if (!response.ok) {
    failures += 1;
    process.stdout.write(`  FAILED   ${assertion.path}: ${response.status}\n`);
    continue;
  }
  const { data } = await response.json();
  const granted = new Set(Object.keys(data?.[assertion.path] ?? {}));
  const missing = assertion.required.filter((privilege) => !granted.has(privilege));
  const leaked = assertion.forbidden.filter((privilege) => granted.has(privilege));
  const ok = missing.length === 0 && leaked.length === 0;
  if (!ok) failures += 1;
  const detail = ok
    ? `${granted.size} privilege(s)`
    : [
        missing.length ? `MISSING ${missing.join(',')}` : '',
        leaked.length ? `LEAKED ${leaked.join(',')}` : '',
      ]
        .filter(Boolean)
        .join('  ');
  process.stdout.write(
    `  ${ok ? 'correct ' : 'WRONG   '} ${assertion.path.padEnd(20)} ${assertion.label.padEnd(32)} ${detail}\n`,
  );
}

process.stdout.write(`\n${failures === 0 ? 'token verified' : `${failures} check(s) failed`}\n`);
if (failures > 0) process.exitCode = 1;
