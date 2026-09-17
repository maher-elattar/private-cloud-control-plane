/**
 * Generates the console's demo user, printing the password exactly once.
 *
 * WHY generated rather than committed: SAFE-036 governs what may enter history, and a password in
 * a repository is a password on every machine that ever cloned it. This writes a **scrypt hash**
 * into the gitignored Compose environment and prints the plaintext to the terminal, where it is
 * the operator's to keep or discard.
 *
 * Re-running it mints a new password. That is the intended way to rotate one, and it is why the
 * output says so rather than silently replacing a credential someone had written down.
 *
 * Usage:
 *   node tools/console/demo-user.mjs            # generate, write the hash, print the password
 *   node tools/console/demo-user.mjs --check    # report whether a user is configured
 *
 * @see apps/control-api/tools/local-oidc.mjs
 * @see deploy/local/compose.console.yaml
 */
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

/** The Compose environment the console stack reads. Gitignored, written by compose-env.mjs. */
const ENVIRONMENT_PATH = resolve('deploy/local/.env.terraform');

/** The setting the identity stub parses. */
const SETTING = 'LOCAL_OIDC_USERS';

/** The demo customer's identity. */
const USERNAME = 'demo@testsrv.lab';
const ROLES = 'tenant_developer';

/**
 * The project the demo user may see.
 *
 * `testsrv-lab`, the project bound to the `proxmox-testsrv` provider profile — the one that
 * reaches real hardware. The other seeded project, `lab-sandbox`, is bound to the fake provider
 * and would answer every request from a stack running the Terraform adapter with a profile
 * mismatch.
 */
const PROJECT = '00000000-0000-4000-8000-0000000000a1';

/** Derived key length, matching what the identity stub compares against. */
const KEY_LENGTH = 32;

const checkOnly = process.argv.slice(2).includes('--check');
const existing = await readFile(ENVIRONMENT_PATH, 'utf8').catch(() => '');

if (checkOnly) {
  const configured = new RegExp(`^${SETTING}=.+$`, 'm').test(existing);
  process.stdout.write(
    configured
      ? `${SETTING} is configured in ${ENVIRONMENT_PATH}\n`
      : `${SETTING} is absent. Run: node tools/console/demo-user.mjs\n`,
  );
  process.exitCode = configured ? 0 : 1;
} else {
  if (!existing) {
    throw new Error(
      `${ENVIRONMENT_PATH} does not exist. Run \`pnpm run terraform:compose-env\` first.`,
    );
  }

  // 18 bytes of base64url: long enough that it is not worth attacking, short enough to type.
  const password = randomBytes(18).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  const hash = Buffer.from(await scrypt(password, salt, KEY_LENGTH)).toString('hex');
  const record = `${USERNAME}:${hash}:${salt}:${ROLES}:${PROJECT}`;

  const line = `${SETTING}=${record}`;
  const updated = new RegExp(`^${SETTING}=.*$`, 'm').test(existing)
    ? existing.replace(new RegExp(`^${SETTING}=.*$`, 'm'), line)
    : `${existing.replace(/\n*$/, '\n')}${line}\n`;
  await writeFile(ENVIRONMENT_PATH, updated, { mode: 0o600 });

  process.stdout.write('\nDemo console user written.\n\n');
  process.stdout.write('  Sign-in page   http://localhost:3102/login\n');
  process.stdout.write(`  Username       ${USERNAME}\n`);
  process.stdout.write(`  Password       ${password}\n`);
  process.stdout.write(`  Role           ${ROLES}\n`);
  process.stdout.write(`  Project        ${PROJECT} (testsrv-lab)\n\n`);
  process.stdout.write(
    'The password is shown once and is not recoverable — only its hash was stored.\n' +
      'Re-running this command mints a new one.\n',
  );
}
