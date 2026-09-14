/**
 * Executes Terraform for one instance, as a gated, recorded run.
 *
 * PATTERN — adapter over a subprocess. Every invocation goes through {@link TerraformRunner}, and
 * the ordering inside it is the safety property: a plan is produced, the plan gate reads what
 * Terraform *actually* proposed, and only then may an apply happen. There is no path that applies
 * without a gated plan, because `apply` is always given a saved plan file rather than being
 * allowed to compute its own.
 *
 * WHY that matters more than it looks: `terraform apply` with no plan file computes a fresh plan
 * and applies it, so a gate that inspected a *previous* plan would be inspecting a document that
 * is no longer what will be executed. Applying the saved file is what makes the gate's verdict
 * binding rather than advisory.
 *
 * @see packages/provider-adapters/src/terraform/plan-gate.ts
 * @see docs/architecture/terraform-manual-walkthrough.md
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluatePlan, type GateResult, type TerraformPlan } from './plan-gate.js';
import { parseDiagnostics, type TerraformDiagnostic } from './diagnostics.js';
import { renderTfvars, type InstanceTfvars } from './tfvars.js';

/** Where Terraform lives and what it is allowed to reach. */
export interface TerraformRunnerConfiguration {
  /** Path to the `terraform` or `tofu` binary. */
  readonly binary: string;
  /** The module directory to copy configuration from. */
  readonly modulePath: string;
  /** The purge module, which is the only one without `prevent_destroy`. */
  readonly purgeModulePath: string;
  /** Root for per-workspace working directories. */
  readonly workingRoot: string;
  /** Vendored provider plugins, so `init` needs no registry access. */
  readonly pluginDirectory?: string;
  /**
   * `pg` backend connection string. Never logged.
   *
   * Must carry an explicit `sslmode`, and is **not** the application's `DATABASE_URL`: see the
   * class comment for why the two are not interchangeable.
   */
  readonly backendConnectionString: string;
  /** How long any single invocation may run. */
  readonly timeoutMs?: number;
}

/** One invocation's outcome. */
export interface InvocationResult {
  readonly command: string;
  readonly exitCode: number;
  readonly diagnostics: readonly TerraformDiagnostic[];
  readonly durationMs: number;
}

/** What a gated apply produced. */
export interface ApplyOutcome {
  readonly gate: GateResult;
  /** Absent when the gate refused: nothing was applied. */
  readonly apply?: InvocationResult;
  readonly plan: InvocationResult;
}

/** Default ceiling for one invocation. Creates were measured at 11 s; this is generous. */
const DEFAULT_TIMEOUT_MS = 600_000;

/** The plan file name inside a working directory. */
const PLAN_FILE = 'plan.tfplan';

/** The variable file name inside a working directory. */
const TFVARS_FILE = 'terraform.tfvars.json';

/** Permissions for the variable file, which holds the cloud-init password. */
const TFVARS_MODE = 0o600;

/**
 * Environment variables removed from every child process.
 *
 * `TF_LOG` in particular prints resource attribute values, which for this module includes the
 * cloud-init password. Inheriting it from an operator's shell would defeat every redaction in
 * this package, so it is deleted rather than merely not set.
 */
const STRIPPED_ENVIRONMENT = ['TF_LOG', 'TF_LOG_PATH', 'TF_LOG_PROVIDER'];

/**
 * Drives Terraform for one workspace at a time.
 *
 * WHY the constructor insists on an explicit `sslmode`: Terraform's `pg` backend uses lib/pq,
 * which **defaults TLS on**, while the application's driver defaults it off. The same connection
 * string therefore works for one and fails for the other with `pq: SSL is not enabled on the
 * server` — an error that names neither the setting nor the difference. Worse, the silent fix
 * would be for this class to append `sslmode=disable` itself, which is a decision about
 * transport security for a database holding credentials, made in the wrong place. Requiring the
 * operator to say which they mean is the only honest option.
 */
export class TerraformRunner {
  public constructor(private readonly configuration: TerraformRunnerConfiguration) {
    if (!/[?&]sslmode=/.test(configuration.backendConnectionString)) {
      throw new Error(
        'The Terraform state connection string must set sslmode explicitly. ' +
          "Terraform's pg backend defaults TLS on where the application's driver defaults it " +
          'off, so the two strings are not interchangeable.',
      );
    }
  }

  /**
   * Prepares a working directory for a workspace and writes its variables.
   *
   * @param workspaceName The workspace, which is also the directory name.
   * @param tfvars The instance's variables.
   * @param purge Whether to use the purge module, which permits a destroy.
   * @returns The working directory path.
   */
  public async prepare(
    workspaceName: string,
    tfvars: InstanceTfvars,
    purge = false,
  ): Promise<string> {
    const directory = join(this.configuration.workingRoot, workspaceName);
    await mkdir(directory, { recursive: true });

    // Copy the module rather than referencing it, so a run cannot be affected by an edit to the
    // shared directory while it is in flight.
    const source = purge ? this.configuration.purgeModulePath : this.configuration.modulePath;
    await this.copyModule(source, directory);

    const variablePath = join(directory, TFVARS_FILE);
    await writeFile(variablePath, renderTfvars(tfvars));
    // The file holds the cloud-init password. Written before the mode is tightened would leave a
    // window; `writeFile` then `chmod` is the closest Node offers without an open/fchmod dance,
    // and the directory itself is not world-readable.
    await chmod(variablePath, TFVARS_MODE);

    return directory;
  }

  /**
   * Removes a working directory.
   *
   * Called after every run, successful or not: the variable file inside it holds a password, and
   * leaving it on disk for the next operator to find is the avoidable half of that exposure.
   *
   * @param workspaceName The workspace whose directory should go.
   */
  public async discard(workspaceName: string): Promise<void> {
    await rm(join(this.configuration.workingRoot, workspaceName), {
      recursive: true,
      force: true,
    });
  }

  /**
   * Initialises a working directory against the `pg` backend.
   *
   * @param directory A directory from {@link prepare}.
   * @param workspaceName The workspace to select.
   * @returns The invocation's outcome.
   */
  public async init(directory: string, workspaceName: string): Promise<InvocationResult> {
    const arguments_ = [
      'init',
      '-input=false',
      '-no-color',
      `-backend-config=conn_str=${this.configuration.backendConnectionString}`,
    ];
    if (this.configuration.pluginDirectory) {
      // With a plugin directory, `init` never reaches a registry. That is a supply-chain control
      // and what makes the runner's network policy writable.
      arguments_.push(`-plugin-dir=${this.configuration.pluginDirectory}`);
    }
    const result = await this.run('init', arguments_, directory);
    if (result.exitCode === 0) {
      // `new` is tolerated failing: the workspace exists after the first run for this instance.
      await this.run('workspace', ['workspace', 'new', workspaceName], directory).catch(
        () => undefined,
      );
      await this.run('workspace', ['workspace', 'select', workspaceName], directory);
    }
    return result;
  }

  /**
   * Produces a plan and puts it through the gate.
   *
   * @param directory A prepared, initialised directory.
   * @param options `allowDestroyOf` names the one address a purge may destroy; `destroy` produces
   *   a destroy plan rather than a convergence plan.
   * @returns The gate's verdict and the plan invocation's outcome.
   */
  public async plan(
    directory: string,
    options: { readonly allowDestroyOf?: string; readonly destroy?: boolean } = {},
  ): Promise<{ readonly gate: GateResult; readonly invocation: InvocationResult }> {
    const arguments_ = [
      'plan',
      '-input=false',
      '-no-color',
      `-out=${PLAN_FILE}`,
      `-var-file=${TFVARS_FILE}`,
    ];
    if (options.destroy) arguments_.push('-destroy');

    const invocation = await this.run('plan', arguments_, directory);
    if (invocation.exitCode !== 0) {
      return {
        gate: evaluatePlan(undefined),
        invocation,
      };
    }

    const shown = await this.run('show', ['show', '-json', PLAN_FILE], directory);
    let parsed: TerraformPlan | undefined;
    try {
      parsed = JSON.parse(shown.stdout) as TerraformPlan;
    } catch {
      parsed = undefined;
    }

    return {
      gate: evaluatePlan(parsed, {
        ...(options.allowDestroyOf ? { allowDestroyOf: options.allowDestroyOf } : {}),
      }),
      invocation,
    };
  }

  /**
   * Applies the saved plan, and only if the gate allowed it.
   *
   * @param directory A prepared directory holding a gated plan.
   * @param gate The gate's verdict for that plan.
   * @returns The apply's outcome.
   * @throws Error when called with a refused verdict. That is a programming error rather than an
   *   operational one: the caller has bypassed the gate, and failing loudly is the only response.
   */
  public async apply(directory: string, gate: GateResult): Promise<InvocationResult> {
    if (gate.decision !== 'allowed') {
      throw new Error(`Refusing to apply a plan the gate rejected: ${gate.rule ?? 'unknown'}`);
    }
    // The saved plan file, never a fresh one. `apply` with no plan computes its own, which would
    // make the gate's verdict advisory rather than binding.
    return this.run('apply', ['apply', '-input=false', '-no-color', PLAN_FILE], directory);
  }

  /**
   * Refreshes state from reality without touching the provider.
   *
   * Required after every direct-API mutation, and after any failed apply — a refused disk shrink
   * was measured writing the rejected size into state while the server kept the real one.
   *
   * @param directory A prepared, initialised directory.
   * @returns The refresh's outcome.
   */
  public async refresh(directory: string): Promise<InvocationResult> {
    return this.run(
      'refresh',
      [
        'apply',
        '-refresh-only',
        '-auto-approve',
        '-input=false',
        '-no-color',
        `-var-file=${TFVARS_FILE}`,
      ],
      directory,
    );
  }

  /**
   * Reads the workspace's state document.
   *
   * `show -json` with no plan file prints *state* rather than a plan, which is how observation
   * learns what exists. Read-only: it makes no provider call of its own, so the caller is
   * responsible for having refreshed first if it wants state to reflect reality.
   *
   * @param directory A prepared, initialised directory.
   * @returns The invocation's outcome, with `stdout` carrying the state JSON.
   */
  public async showState(
    directory: string,
  ): Promise<InvocationResult & { readonly stdout: string }> {
    return this.run('show-state', ['show', '-json', '-no-color'], directory);
  }

  /**
   * Clears a taint without touching the provider resource.
   *
   * A create that fails partway leaves the resource tainted, and a tainted resource is *replaced*
   * on the next plan. The gate refuses that plan, correctly — which means a transient failure
   * wedges the instance until something clears the marking. This is that something.
   *
   * @param directory A prepared, initialised directory.
   * @param address The resource address to untaint.
   * @returns The invocation's outcome.
   */
  public async untaint(directory: string, address: string): Promise<InvocationResult> {
    return this.run('untaint', ['untaint', '-no-color', address], directory);
  }

  /** Copies the module's `.tf` files and its lock file into a working directory. */
  private async copyModule(source: string, destination: string): Promise<void> {
    const { readdir, copyFile } = await import('node:fs/promises');
    for (const entry of await readdir(source)) {
      // `.tf` and the lock file only. Never `.terraform/`, which is a plugin cache belonging to
      // the source directory, and never a stray tfvars an operator left behind.
      if (!entry.endsWith('.tf') && entry !== '.terraform.lock.hcl') continue;
      await copyFile(join(source, entry), join(destination, entry));
    }
  }

  /**
   * Runs one Terraform invocation.
   *
   * @param label Name for the result, which is what a run record shows.
   * @param arguments_ Full argument list, including the subcommand.
   * @param directory Working directory.
   * @param overrides Test seam: an alternate binary.
   * @returns Exit code, redacted diagnostics, duration, and raw stdout for the caller to parse.
   */
  private async run(
    label: string,
    arguments_: readonly string[],
    directory: string,
    overrides: { readonly binary?: string } = {},
  ): Promise<InvocationResult & { readonly stdout: string }> {
    const startedAt = Date.now();
    const environment = { ...process.env };
    for (const name of STRIPPED_ENVIRONMENT) delete environment[name];
    // `TF_IN_AUTOMATION` removes the "run terraform init" advice from error output, which is
    // noise in a run record. `TF_INPUT` is belt and braces beside `-input=false`.
    environment.TF_IN_AUTOMATION = '1';
    environment.TF_INPUT = '0';

    const child = spawn(overrides.binary ?? this.configuration.binary, [...arguments_], {
      cwd: directory,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timeoutMs = this.configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const exitCode = await new Promise<number>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, timeoutMs);
      child.on('error', () => {
        clearTimeout(timer);
        resolve(-1);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });

    return {
      command: label,
      exitCode,
      diagnostics: parseDiagnostics(`${stdout}\n${stderr}`, this.secrets()),
      durationMs: Date.now() - startedAt,
      stdout,
    };
  }

  /** Values that must never appear in retained output. */
  private secrets(): readonly string[] {
    return [this.configuration.backendConnectionString];
  }
}
