/**
 * Variable rendering and diagnostic redaction.
 *
 * The assertions that matter here are the negative ones. Everything else in this file is shape
 * checking; the cases that earn their place are the ones proving a cloud-init password cannot
 * reach a log line, a span attribute, or a run record.
 *
 * @see packages/provider-adapters/src/terraform/tfvars.ts
 * @see packages/provider-adapters/src/terraform/diagnostics.ts
 */
import { describe, expect, it } from 'vitest';
import { describeTfvars, renderTfvars, workspaceNameFor, type InstanceTfvars } from './tfvars.js';
import { hasError, parseDiagnostics, redactSecrets } from './diagnostics.js';

const PASSWORD = 'x8|XOO;_1{9M-example';
const SSH_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialHere operator@example';

const tfvars: InstanceTfvars = {
  node_name: 'proxtest',
  template_vm_id: 110,
  vm_id: 910_000,
  hostname: 'tf-example-01',
  ownership_marker:
    'private-cloud-control:{"managedBy":"private-cloud-control-plane","environment":"lab"}',
  tags: ['private-cloud-control-plane', 'lab'],
  datastore_id: 'local',
  disk_interface: 'scsi0',
  disk_format: 'qcow2',
  disk_gib: 32,
  cpu_cores: 2,
  memory_mib: 4096,
  bridge: 'vmbr1',
  network_mtu: 1400,
  ipv4_address: '192.168.4.2',
  ipv4_prefix_length: 22,
  ipv4_gateway: '192.168.4.1',
  dns_servers: ['1.1.1.1'],
  dns_domain: 'lab.invalid',
  cloud_init_username: 'ubuntu',
  cloud_init_password: PASSWORD,
  ssh_public_keys: [SSH_KEY],
  started: true,
  on_boot: false,
};

describe('renderTfvars', () => {
  it('renders valid JSON Terraform can read', () => {
    const parsed = JSON.parse(renderTfvars(tfvars)) as Record<string, unknown>;
    expect(parsed.vm_id).toBe(910_000);
    expect(parsed.network_mtu).toBe(1400);
    expect(parsed.dns_servers).toEqual(['1.1.1.1']);
  });

  it('preserves the ownership marker byte-for-byte', () => {
    // The marker contains quotes and colons, and it must arrive at Proxmox character-identical
    // or parseOwnership cannot prove ownership afterwards. JSON encoding rather than HCL string
    // quoting is the reason this is safe.
    const parsed = JSON.parse(renderTfvars(tfvars)) as Record<string, unknown>;
    expect(parsed.ownership_marker).toBe(tfvars.ownership_marker);
  });

  it('is byte-stable across renderings of the same instance', () => {
    // A tfvars file whose key order wandered would make every plan look like a change to
    // anything comparing files, and would defeat the convergence assertion.
    const shuffled = Object.fromEntries(
      Object.entries(tfvars).reverse(),
    ) as unknown as InstanceTfvars;
    expect(renderTfvars(shuffled)).toBe(renderTfvars(tfvars));
  });

  it('does contain the password, because Terraform needs it', () => {
    // Stated as a test so the next reader knows the omission in `describeTfvars` is deliberate
    // rather than an oversight, and that this file is written to disk and deleted, never logged.
    expect(renderTfvars(tfvars)).toContain(PASSWORD);
  });
});

describe('describeTfvars', () => {
  it('carries no credential material at all', () => {
    const described = JSON.stringify(describeTfvars(tfvars));
    expect(described).not.toContain(PASSWORD);
    expect(described).not.toContain('ssh-ed25519');
    expect(described).not.toContain('AAAAC3Nza');
  });

  it('keeps the key count, so an operator can still tell none from some', () => {
    expect(describeTfvars(tfvars).ssh_public_keys).toBe('<1 redacted>');
    expect(describeTfvars({ ...tfvars, ssh_public_keys: [] }).ssh_public_keys).toBe('<0 redacted>');
  });

  it('leaves everything operationally useful intact', () => {
    const described = describeTfvars(tfvars);
    expect(described.vm_id).toBe(910_000);
    expect(described.ipv4_address).toBe('192.168.4.2');
    expect(described.hostname).toBe('tf-example-01');
    expect(described.cloud_init_username).toBe('ubuntu');
  });
});

describe('workspaceNameFor', () => {
  it('derives the name from the instance id alone', () => {
    expect(workspaceNameFor('00000000-0000-4000-8000-0000000000aa')).toBe(
      'instance-00000000-0000-4000-8000-0000000000aa',
    );
  });
});

describe('redactSecrets', () => {
  it('removes an exact match', () => {
    expect(redactSecrets(`password is ${PASSWORD} here`, [PASSWORD])).toBe(
      'password is <redacted> here',
    );
  });

  it('removes a truncated prefix, which is how Terraform elides long values', () => {
    const truncated = PASSWORD.slice(0, 8);
    expect(redactSecrets(`value ${truncated}...`, [PASSWORD])).not.toContain(truncated);
  });

  it('redacts a longer secret whole rather than in pieces', () => {
    // `short` is a prefix of `longer`. Redacting the shorter one first would leave a fragment of
    // the longer one behind, so the implementation sorts by length.
    const short = 'secretval';
    const longer = 'secretvalue-with-more';
    expect(redactSecrets(`x ${longer} y`, [short, longer])).toBe('x <redacted> y');
  });

  it('ignores secrets too short to redact safely', () => {
    // Replacing a one-character secret would destroy the message this exists to preserve.
    expect(redactSecrets('a normal message', ['a'])).toBe('a normal message');
  });

  it('leaves text with no secrets untouched', () => {
    expect(redactSecrets('Cannot shrink disk, it is not supported!', [PASSWORD])).toBe(
      'Cannot shrink disk, it is not supported!',
    );
  });
});

describe('parseDiagnostics', () => {
  const stream = [
    '{"@level":"info","@message":"Terraform 1.15.9"}',
    JSON.stringify({
      '@level': 'error',
      type: 'diagnostic',
      diagnostic: {
        severity: 'error',
        summary: 'Cannot shrink local:910000/vm-910000-disk-0.raw in VM 910000',
        detail: 'it is not supported!',
        address: 'proxmox_virtual_environment_vm.instance',
      },
    }),
    'not json at all',
    JSON.stringify({
      '@level': 'warn',
      diagnostic: { severity: 'warning', summary: 'deprecated argument' },
    }),
  ].join('\n');

  it('extracts diagnostics and skips non-JSON lines', () => {
    const diagnostics = parseDiagnostics(stream);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]?.severity).toBe('error');
    expect(diagnostics[0]?.address).toBe('proxmox_virtual_environment_vm.instance');
    expect(diagnostics[1]?.severity).toBe('warning');
  });

  it('reports whether anything was an error', () => {
    expect(hasError(parseDiagnostics(stream))).toBe(true);
    expect(
      hasError(
        parseDiagnostics(
          JSON.stringify({ diagnostic: { severity: 'warning', summary: 'just a warning' } }),
        ),
      ),
    ).toBe(false);
  });

  it('redacts secrets out of every message and detail', () => {
    const leaky = JSON.stringify({
      diagnostic: {
        severity: 'error',
        summary: `provider rejected password ${PASSWORD}`,
        detail: `while setting ${PASSWORD} on the cloud-init drive`,
      },
    });
    const [diagnostic] = parseDiagnostics(leaky, [PASSWORD]);
    expect(diagnostic?.summary).not.toContain(PASSWORD);
    expect(diagnostic?.detail).not.toContain(PASSWORD);
    expect(diagnostic?.summary).toContain('<redacted>');
  });

  it('keeps a bounded redacted head when the output is not a JSON stream', () => {
    // A provider that crashed before Terraform could frame its output still has to report
    // something. "No diagnostics" for a run that plainly failed is the wrong answer.
    const raw = `panic: runtime error\npassword was ${PASSWORD}\n${'x'.repeat(5_000)}`;
    const [diagnostic] = parseDiagnostics(raw, [PASSWORD]);
    expect(diagnostic?.summary).toMatch(/no machine-readable diagnostics/);
    expect(diagnostic?.detail).not.toContain(PASSWORD);
    expect(diagnostic?.detail?.length).toBeLessThanOrEqual(2_000);
  });

  it('returns nothing for empty output', () => {
    expect(parseDiagnostics('')).toEqual([]);
    expect(parseDiagnostics('   \n  ')).toEqual([]);
  });

  it('returns nothing when a JSON stream carried no diagnostics', () => {
    // A successful run: JSON was seen, so the raw-text fallback must not fire.
    expect(parseDiagnostics('{"@level":"info","@message":"Apply complete!"}')).toEqual([]);
  });
});
