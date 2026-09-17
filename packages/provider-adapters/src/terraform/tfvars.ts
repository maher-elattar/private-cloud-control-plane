/**
 * Renders the variable file for one instance's Terraform workspace.
 *
 * PATTERN — generated data, not generated code. The runner never writes HCL: generated HCL is
 * generated code with a shell attached, whereas generated *variables* are data with a schema.
 * `deploy/terraform/modules/instance` is fixed and reviewed; only this file changes per instance.
 *
 * Two renderings exist deliberately. {@link renderTfvars} produces what goes on disk, including
 * the cloud-init password. {@link describeTfvars} produces what may be logged, spanned, or written
 * to a run record — the same object with every credential replaced. Having one function that
 * takes a "redact" flag would mean one wrong argument leaks a password into a log line; having two
 * means the redacted one is the only thing the logging paths can reach.
 *
 * @see deploy/terraform/modules/instance/variables.tf
 * @see docs/architecture/safety-invariants.md
 */

/** Every variable `deploy/terraform/modules/instance` declares. */
export interface InstanceTfvars {
  readonly node_name: string;
  readonly template_vm_id: number;
  readonly vm_id: number;
  readonly hostname: string;
  readonly ownership_marker: string;
  readonly tags: readonly string[];
  readonly datastore_id: string;
  readonly disk_interface: string;
  /**
   * The clone's disk format, which must equal the template's real format.
   *
   * bpg ignores `file_format` on a cloned disk, so a declared value the template does not have
   * makes every later plan a replacement rather than converting anything.
   */
  readonly disk_format: 'qcow2' | 'raw';
  /** The resource pool created instances join, which is what authorizes the create. */
  readonly pool_id: string;
  readonly disk_gib: number;
  readonly cpu_cores: number;
  readonly memory_mib: number;
  readonly bridge: string;
  readonly network_mtu: number;
  readonly ipv4_address: string;
  readonly ipv4_prefix_length: number;
  readonly ipv4_gateway: string;
  readonly dns_servers: readonly string[];
  readonly dns_domain: string;
  readonly cloud_init_username: string;
  readonly cloud_init_password: string;
  readonly ssh_public_keys: readonly string[];
  readonly started: boolean;
  readonly on_boot: boolean;
}

/**
 * Variable names whose values are credential material.
 *
 * `ssh_public_keys` is included even though a public key is not secret: on a shared lab it
 * identifies a person, and an operator reading a log has no need for it.
 */
const CREDENTIAL_VARIABLES: readonly (keyof InstanceTfvars)[] = [
  'cloud_init_password',
  'ssh_public_keys',
];

/**
 * Renders the variable file exactly as Terraform will read it.
 *
 * JSON rather than HCL, because `.tfvars.json` has one unambiguous escaping rule and HCL string
 * quoting is a place to make a mistake with an ownership marker that contains quotes and colons.
 *
 * **The result contains the cloud-init password.** It is written to a file inside a gitignored
 * working directory, with restrictive permissions, and deleted after the run. It must never be
 * logged — use {@link describeTfvars} for that.
 *
 * @param tfvars The variables for one instance.
 * @returns Pretty-printed JSON, newline-terminated.
 */
export function renderTfvars(tfvars: InstanceTfvars): string {
  // Keys are sorted so that two renderings of the same instance are byte-identical. A tfvars file
  // whose key order wandered would make every plan look like a change to anything diffing files.
  const ordered = Object.fromEntries(
    Object.entries(tfvars).sort(([left], [right]) => left.localeCompare(right)),
  );
  return `${JSON.stringify(ordered, undefined, 2)}\n`;
}

/**
 * Describes the variables for a log line, a span attribute, or a run record.
 *
 * @param tfvars The variables for one instance.
 * @returns The same shape with credential values replaced by a marker and key counts kept, so an
 *   operator can still tell "two SSH keys were sent" from "none were".
 */
export function describeTfvars(tfvars: InstanceTfvars): Record<string, unknown> {
  const described: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tfvars)) {
    if (!CREDENTIAL_VARIABLES.includes(key as keyof InstanceTfvars)) {
      described[key] = value;
      continue;
    }
    described[key] = Array.isArray(value) ? `<${value.length} redacted>` : '<redacted>';
  }
  return described;
}

/**
 * The workspace name for an instance.
 *
 * One workspace per instance, and the name derives from the instance id alone. That is what makes
 * the `pg` backend's advisory lock — which is keyed on the state row — cover exactly one instance,
 * the same granularity as the per-instance lease the control plane already holds.
 *
 * @param instanceId The instance's UUID.
 * @returns The Terraform workspace name.
 */
export function workspaceNameFor(instanceId: string): string {
  return `instance-${instanceId}`;
}
