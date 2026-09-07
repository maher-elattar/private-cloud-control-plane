/**
 * Thin, dependency-free wrapper around `kubectl`.
 *
 * Every Phase 6 tool talks to the cluster through this module so that three properties hold in
 * one place rather than at forty call sites: the context is pinned, stdout and stderr are both
 * captured, and a non-zero exit is an `Error` carrying the command that produced it.
 */
import { spawn } from 'node:child_process';

/** Context every Phase 6 tool is pinned to. Overridable for a differently named local cluster. */
export const KUBE_CONTEXT = process.env.PHASE6_KUBE_CONTEXT ?? 'minikube';

/**
 * Runs a command and resolves with its captured output.
 *
 * @param {string} command Executable to run.
 * @param {readonly string[]} args Arguments passed verbatim; never shell-interpolated.
 * @param {{ input?: string, allowFailure?: boolean, timeoutMs?: number }} [options] Behaviour.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>} Captured result.
 */
export function run(command, args, options = {}) {
  const { input, allowFailure = false, timeoutMs = 600_000 } = options;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !allowFailure) {
        rejectPromise(
          new Error(
            `${command} ${args.join(' ')} exited ${code}.\n${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      resolvePromise({ code: code ?? 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Runs `kubectl` against the pinned context.
 *
 * @param {readonly string[]} args Arguments after the context flag.
 * @param {{ input?: string, allowFailure?: boolean, timeoutMs?: number }} [options] Behaviour.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>} Captured result.
 */
export function kubectl(args, options = {}) {
  return run('kubectl', ['--context', KUBE_CONTEXT, ...args], options);
}

/**
 * Reads one object as JSON, or `undefined` when it does not exist.
 *
 * @param {readonly string[]} args `get` arguments identifying exactly one object.
 * @returns {Promise<unknown | undefined>} Parsed object, or `undefined` when absent.
 */
export async function kubectlGetJson(args) {
  const result = await kubectl(['get', ...args, '-o', 'json'], { allowFailure: true });
  if (result.code !== 0) {
    if (/not found|the server doesn't have a resource type/i.test(result.stderr)) return undefined;
    throw new Error(`kubectl get ${args.join(' ')} failed.\n${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * Polls until a predicate holds or the deadline passes.
 *
 * Used instead of `kubectl wait` wherever the condition is a computed property of several
 * objects, which `kubectl wait` cannot express.
 *
 * @template T
 * @param {string} description Human-readable subject, used in the timeout message.
 * @param {() => Promise<T | undefined>} probe Resolves to a truthy value once the wait is over.
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options] Deadline and poll spacing.
 * @returns {Promise<T>} The first truthy probe result.
 */
export async function waitFor(description, probe, options = {}) {
  const { timeoutMs = 300_000, intervalMs = 3_000 } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}.${suffix}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}
