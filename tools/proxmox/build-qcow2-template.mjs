/**
 * Builds a qcow2 clone template, so snapshots work on this server.
 *
 * WHY this exists. Proxmox refuses to snapshot a `raw` disk, and every instance this control plane
 * creates is a full clone of template 110, whose disk is `local:110/base-110-disk-0.raw`. The
 * Terraform provider offers a `file_format` attribute that looks like the fix and is not: bpg
 * ignores it on a clone, so the clone silently inherits the template's format. Declaring `qcow2`
 * produced a disk that stayed `raw`, and the permanent mismatch made every later plan a
 * replacement — which the plan gate correctly refused, blocking all work on that instance.
 *
 * The template is therefore the only place the format can be fixed.
 *
 * WHY a new template rather than converting 110. Converting would mean mutating a template that
 * belongs to somebody else's server and that 223 other machines sit alongside. This builds a
 * separate template at a free VMID, leaves 110 untouched, and is reversible by deleting one VM.
 * If the result is wrong, nothing that worked before has changed.
 *
 * The procedure, all through the API:
 *
 *   1. Full-clone the source template to the new VMID. The clone inherits `raw`.
 *   2. `move_disk` the clone's disk to the same storage with `format=qcow2`, which converts it.
 *   3. Convert the VM to a template. Proxmox renames the disk to `base-<vmid>-disk-0.qcow2`.
 *   4. Grant the scoped token an ACL on the new VMID, because per-VMID ACLs are how this
 *      deployment is bounded and a template it cannot read is a template it cannot clone.
 *
 * Steps 1 to 3 need administrator authority: allocating a VMID outside the token's allowlist and
 * granting an ACL are both deliberately outside what the scoped token may do.
 *
 * **It is idempotent.** A template already present at the target VMID is verified and left alone.
 *
 * Usage:
 *   node tools/proxmox/build-qcow2-template.mjs             # build, or verify an existing one
 *   node tools/proxmox/build-qcow2-template.mjs --check     # report only, change nothing
 *
 * @see docs/architecture/terraform-call-map.md
 * @see terraform-provisioning-checkpoints.md
 */
import {
  administer as administerCall,
  administratorSession as openAdministratorSession,
  awaitTask,
  loadCredentials,
  report,
} from './session.mjs';

/** The node this deployment is allowlisted to. */
const NODE = 'proxtest';

/** The storage the template lives on. `dir` type, which is what makes qcow2 available at all. */
const STORAGE = 'local';

/** The existing raw template, read from and never written to. */
const SOURCE_VMID = 110;

/**
 * The new template's VMID.
 *
 * Chosen outside the 100-323 band this server actually uses, so it cannot collide with a machine
 * someone creates by hand, and outside 910000-910099 so it is not swept by the reserved-interval
 * checks that assert the instance range is empty before a run.
 */
const TARGET_VMID = 9100;

/** The identity the control plane authenticates as, which needs to read the new template. */
const USER_ID = 'control-plane@pve';
const ROLE_ID = 'ControlPlaneLifecycle';

const checkOnly = process.argv.slice(2).includes('--check');
const credentials = await loadCredentials();

/** One administrative call, curried with this tool's endpoint. */
const administer = (session, method, path, body) =>
  administerCall(session, credentials.endpoint, method, path, body);

/**
 * Reads a VM's configuration, or `undefined` when it does not exist.
 *
 * @param {{cookie: string, csrf: string}} session Administrator session.
 * @param {number} vmid The VM to read.
 * @returns {Promise<Record<string, unknown> | undefined>} Its configuration, if present.
 */
async function configuration(session, vmid) {
  const result = await administer(session, 'GET', `/nodes/${NODE}/qemu/${vmid}/config`);
  return result.ok ? result.data : undefined;
}

/**
 * The disk format recorded in a VM's `scsi0` specification.
 *
 * Proxmox names the file after its format, so the extension is the authority — there is no
 * separate format field to read.
 *
 * @param {Record<string, unknown> | undefined} config A VM configuration.
 * @returns {string | undefined} `qcow2`, `raw`, or undefined when there is no disk.
 */
function diskFormat(config) {
  const specification = typeof config?.scsi0 === 'string' ? config.scsi0 : '';
  return /\.(qcow2|raw)\b/.exec(specification)?.[1];
}

const session = await openAdministratorSession(credentials);
process.stdout.write(`building a qcow2 template on ${credentials.endpoint}\n`);

const source = await configuration(session, SOURCE_VMID);
if (!source) throw new Error(`Source template ${SOURCE_VMID} does not exist.`);
if (source.template !== 1) {
  throw new Error(`VMID ${SOURCE_VMID} is not a template; refusing to clone from it.`);
}
process.stdout.write(
  `  source   ${SOURCE_VMID} ${source.name} format=${diskFormat(source)} disk=${source.scsi0}\n`,
);

const existing = await configuration(session, TARGET_VMID);
if (existing) {
  const format = diskFormat(existing);
  const isTemplate = existing.template === 1;
  process.stdout.write(
    `  present  ${TARGET_VMID} ${existing.name} format=${format} template=${isTemplate}\n`,
  );
  if (!isTemplate || format !== 'qcow2') {
    throw new Error(
      `VMID ${TARGET_VMID} exists but is not a qcow2 template (format=${format}, ` +
        `template=${isTemplate}). Inspect it by hand rather than letting this tool overwrite it.`,
    );
  }
  process.stdout.write('  nothing to do; the template is already correct\n');
} else if (checkOnly) {
  // Report and stop. Falling through would grant an ACL for a VM that does not exist and then
  // "verify" it, which is how a report-only mode ends up changing something.
  process.stdout.write(`  absent   ${TARGET_VMID} would be built (--check, nothing changed)\n`);
  process.exitCode = 1;
  process.exit();
} else {
  // --- 1. Full clone. `full=1` matters: a linked clone would share the source's raw base ---
  const cloned = await administer(session, 'POST', `/nodes/${NODE}/qemu/${SOURCE_VMID}/clone`, {
    newid: String(TARGET_VMID),
    name: 'UbuntuNoble24.04-qcow2',
    target: NODE,
    storage: STORAGE,
    full: '1',
    description: 'Control-plane clone template. qcow2 so that instance snapshots are possible.',
  });
  if (!report(`clone ${SOURCE_VMID} -> ${TARGET_VMID}`, cloned)) {
    throw new Error('The clone was refused.');
  }
  const cloneOutcome = await awaitTask(session, credentials.endpoint, NODE, String(cloned.data));
  if (cloneOutcome !== 'OK') throw new Error(`Clone task ended ${cloneOutcome}.`);
  process.stdout.write('  settled  clone\n');

  // --- 2. Convert the disk in place. Same storage, different format ---
  const moved = await administer(session, 'POST', `/nodes/${NODE}/qemu/${TARGET_VMID}/move_disk`, {
    disk: 'scsi0',
    storage: STORAGE,
    format: 'qcow2',
    delete: '1',
  });
  if (!report('convert scsi0 to qcow2', moved)) throw new Error('The conversion was refused.');
  const moveOutcome = await awaitTask(session, credentials.endpoint, NODE, String(moved.data));
  if (moveOutcome !== 'OK') throw new Error(`Conversion task ended ${moveOutcome}.`);
  process.stdout.write('  settled  conversion\n');

  // --- 3. Seal it as a template ---
  const templated = await administer(
    session,
    'POST',
    `/nodes/${NODE}/qemu/${TARGET_VMID}/template`,
  );
  if (!report(`seal ${TARGET_VMID} as a template`, templated)) {
    throw new Error('Sealing the template was refused.');
  }
}

// --- 4. The ACL. Idempotent, and required whether the template was just built or already there ---
report(
  `acl /vms/${TARGET_VMID} -> ${ROLE_ID}`,
  await administer(session, 'PUT', '/access/acl', {
    path: `/vms/${TARGET_VMID}`,
    roles: ROLE_ID,
    users: USER_ID,
    propagate: '1',
  }),
);

// --- Verification. The format is read back rather than assumed, and read with the scoped token,
// because a template the control plane cannot see is not a usable template ---
const built = await configuration(session, TARGET_VMID);
const format = diskFormat(built);
process.stdout.write('\nverifying\n');
process.stdout.write(`  format   ${format}${format === 'qcow2' ? '' : '  EXPECTED qcow2'}\n`);
process.stdout.write(`  template ${built?.template === 1 ? 'yes' : 'NO'}\n`);
process.stdout.write(`  disk     ${built?.scsi0}\n`);

const tokenVisible = await fetch(
  `${credentials.endpoint}/api2/json/nodes/${NODE}/qemu/${TARGET_VMID}/config`,
  { headers: { Authorization: `PVEAPIToken=${credentials.tokenId}=${credentials.tokenSecret}` } },
);
process.stdout.write(
  `  token    ${tokenVisible.status}${tokenVisible.ok ? '' : '  the scoped token cannot read it'}\n`,
);

const ok = format === 'qcow2' && built?.template === 1 && tokenVisible.ok;
process.stdout.write(`\n${ok ? `template ${TARGET_VMID} ready` : 'template is NOT usable'}\n`);
if (!ok) process.exitCode = 1;
