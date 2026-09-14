# Terraform Manual Walkthrough

What the `bpg/proxmox` provider actually does on the real test server, measured by hand before any
of it was wired into a workflow. Run on 2026-09-14 against `proxtest` (PVE 9.2.11) with
`bpg/proxmox` 0.113.1 and Terraform 1.15.9, from `terraform-state/manual/`.

Every claim below is a measurement. Where it contradicts
[Terraform-Backed Provisioning](../../terraform-provisioning-plan.md), that document is the one
that was wrong, and the correction is noted.

The plan captures are committed under `terraform-state/fixtures/`, redacted to structure only.
They are the plan gate's test inputs: testing the gate against invented plan JSON would only
prove the fixtures match the parser, whereas these are real plans this provider emitted.

## What worked first time

The parts the design got right, confirmed rather than assumed:

- A full clone of template 110 into VMID 910000 with the disk on `local`, `vmbr1` with
  `mtu = 1400`, 2 cores, 4096 MiB.
- **The ownership marker round-trips byte-for-byte.** `description` came back from Proxmox
  character-identical to what was sent, unescaped and unencoded, so `parseOwnership` will succeed
  on what the server actually stores. This was the single biggest open risk in the design: if bpg
  had normalised the marker, the whole ownership model would have needed rethinking.
- Inline cloud-init reached the guest. The VM booted **Ubuntu 24.04.5 LTS**, hostname
  `tf-manual-01`, `eth0` holding `192.168.4.2/22`, `default via 192.168.4.1 dev eth0`, the
  `ubuntu` user present at uid 1000 in the `sudo` group, and `search lab.invalid` applied.
- `prevent_destroy` genuinely blocks a destroy on this provider: `Error: Instance cannot be
  destroyed`.
- `terraform plan -detailed-exitcode` returns 0 once the configuration is complete, which is what
  the convergence assertion in design §5.4 rests on. Reaching that took work — see finding 3.

## Change classification, measured

The design's §6.3 table was a prediction. This is the measurement.

| Change | Actions | `action_reason` |
| --- | --- | --- |
| `cpu.cores` | `update` | — |
| `memory.dedicated` | `update` | — |
| `disk.size` **increase** | `update` | — |
| `disk.size` **decrease** | `update` at plan, **apply fails** | see finding 5 |
| `initialization.ip_config` address | `update` | — |
| `initialization.dns.servers` | `update` | — |
| `initialization.dns.domain` | `update` | — |
| `initialization.user_account.username` | `update` | — |
| `initialization.user_account.keys` | `update` | — |
| `name` (hostname) | `update` | — |
| `description` (the marker) | `update` | — |
| `started` | `update` | — |
| **`vm_id`** | **`delete`+`create`** | `replace_because_cannot_update`, `replace_paths [["vm_id"]]` |
| **a tainted resource** | **`delete`+`create`** | `replace_because_tainted` |
| **after `import`, without `ignore_changes`** | **`delete`+`create`** | `replace_because_cannot_update`, `replace_paths` on `clone.*` |

Everything the control plane needs to change during an instance's life is an in-place update. The
three destructive shapes are all avoidable, and two of them were discovered only by provoking
them.

## Latency, measured

| Operation | Elapsed |
| --- | --- |
| `plan`, no-op | 2 s |
| `apply`, refresh-only | 1 s |
| `apply`, disk grow | 5 s |
| `apply`, power off | 7 s |
| `apply`, create (clone) | 11 s |
| `apply`, power on | 19 s |
| `apply`, converge update | 21 s |
| `destroy` | 10 s |

This answers design §12's first open question with numbers. A power operation costs 7–19 s through
Terraform against a sub-second direct API call. Creates are already minutes long so the overhead
disappears there, but for power it is real, and the decision of whether to route power through
Terraform should be made against these figures rather than on consistency grounds alone.

## Findings

### 1. `initialization.datastore_id` defaults to `local-lvm`, which does not exist here

The first apply failed with `storage 'local-lvm' does not exist` — after the clone had already
succeeded. bpg defaults the cloud-init drive's datastore independently of `clone.datastore_id`,
so setting the clone's storage is not enough. It must be set explicitly on the `initialization`
block too.

### 2. A failed apply taints the resource, and a tainted resource is destroyed on the next plan

This is the most consequential finding for the runner's design.

After finding 1, state recorded the resource with `status: tainted`, and the very next plan was
`delete`+`create` with `action_reason: replace_because_tainted`. Under the plan gate that plan is
refused — correctly, because it would destroy a VM. But it means **any transient failure during a
create wedges the instance permanently** unless something clears the taint.

`terraform untaint` clears it without touching the VM. After untainting and fixing the
configuration, the plan became a plain `update` and the apply converged in place: `0 added,
1 changed, 0 destroyed`.

**Addition to the design:** the runner needs an untaint-then-converge recovery path for a failed
create. Design §6.5 covers the case where a VM exists but state does not; this is the different
case where state exists but is tainted, and the resolution is not the same.

A failed *update*, by contrast, does **not** taint — state stayed healthy after the shrink refusal
in finding 5. Only a failed create taints.

### 3. Template-inherited values produce permanent diffs unless declared explicitly

After the VM was healthy, `plan -detailed-exitcode` kept returning 2 — `1 to change` — on every
run. Two attributes churned, both the same shape:

- `initialization.dns.domain`: the server held `1.1.1.1`, inherited from the template's
  `searchdomain`, while the configuration left it unset and therefore computed `""`.
- `initialization.user_account.keys`: the server held the template's SSH key while the
  configuration declared `[]`.

In both cases Terraform planned to clear the value and the clear did not stick, so the same diff
reappeared forever. bpg does not issue Proxmox's `delete=<key>` for an attribute that became
empty; it omits the key, and Proxmox keeps the previous value.

Declaring both explicitly with non-empty values produced the clean no-op. **Anything the golden
template sets must be declared explicitly in the configuration**, or the convergence assertion can
never pass.

### 4. The template's baked-in SSH key reaches every guest, and cloud-init cannot remove it

The security finding, and it needed a look inside the guest to see.

At the Proxmox layer this looks fine: setting a non-empty `keys` list replaces the config value
cleanly, and `qm config 910000` showed exactly one key — the one supplied. But
`/home/ubuntu/.ssh/authorized_keys` inside the running guest held **two**:

```
ssh-ed25519 AAAA…UIRr maher@AsusOLED-Linux     <- baked into the template image
ssh-ed25519 AAAA…Apz4 tf-manual-probe          <- supplied through cloud-init
```

The template image already carries that key in the user's `authorized_keys`, so cloud-init appends
rather than replaces. **Every VM cloned from template 110 grants SSH access to a third party, and
no cloud-init configuration removes it.**

This is a property of the golden image, not of Terraform or of either adapter, and it applies
equally to the VMs the existing direct adapter creates today. It is worth stating separately that
the existing adapter makes it worse: `applyInstanceConfiguration` sets `sshkeys` only when the
request carries at least one key, so an instance created with no SSH keys — which the REST
contract permits, `sshPublicKeys` being optional — never has its key list touched at all.

Two things follow, and neither is a code change in this work:

- The template must be rebuilt with no `authorized_keys` content and no `sshkeys` in its
  configuration, or every instance inherits an operator's access.
- Until it is, this is a known exposure of the lab environment and belongs in the runbook rather
  than in a silent assumption.

### 5. A refused disk shrink writes the rejected size into state

`disk.size` 32 → 16 planned as an ordinary `update`, so the plan gate allowed it. The apply then
failed exactly as intended:

```
Error: Cannot shrink local:910000/vm-910000-disk-0.raw in VM 910000, it is not supported!
```

SAFE-026's second layer works. But **state then recorded `size: 16` while the server still had
32G.** The mutation failed and the state was written anyway.

The consequences are narrow but real. `terraform plan` refreshes in memory, so a subsequent plan
reported against reality correctly; the *persisted* state stayed wrong until
`apply -refresh-only` repaired it. Anything that reads persisted state rather than planning — and
the design's state inventory reads `terraform_remote_state.states` directly for exactly that
reason — would have reported a disk size the server never had.

**Addition to the design:** §6.4 currently requires a `-refresh-only` after every direct-API
mutation. It must also require one after **any failed apply**, before the inventory's
`state_serial` or drift classification is believed.

The deeper point is that the control plane's admission-time shrink refusal is the load-bearing
one. Relying on the provider's refusal is not merely slower; it corrupts state.

### 6. `terraform import` cannot adopt a cloned VM

Design §6.5 resolves the orphan case — a VM that exists while state does not — by importing it
rather than rebuilding. Measured, that does not work as written.

Removing the resource from state and re-importing it produced `delete`+`create`, with
`replace_paths` naming `clone.vm_id`, `clone.full`, `clone.datastore_id` and `clone.retries`.
The reason is structural: **Proxmox does not record what a VM was cloned from**, so an import
reconstructs an empty `clone` block. The configuration declares one, every `clone` sub-attribute
is ForceNew, and Terraform reads that as the block being added.

`ignore_changes = [clone]` resolves it. With the clone block ignored after creation, the
post-import plan became a plain in-place `update`, and one converging apply left the workspace
clean.

**Addition to the design:** `ignore_changes = [clone]` is not an optimisation, it is what makes
orphan adoption possible at all, and it belongs in the production module with that reason
recorded beside it.

One residual diff after import is expected and harmless: Proxmox never returns the cloud-init
password, so the first post-import plan always shows `user_account.password` changing. One
converging apply re-sets it and the workspace is clean thereafter.

### 7. Proxmox validates SSH public keys server-side

A syntactically plausible but cryptographically invalid key was rejected with
`HTTP 500 – SSH public key validation error`. The domain layer's `validateCreateInstance` checks
key length and control characters but not validity, so a malformed key reaches the provider and
fails there. Worth knowing when classifying that failure: it is a permanent validation failure,
not a transport problem.

### 8. Declaring the `disk` block normalises the disk line once

bpg warns that declaring disk attributes on a clone lets schema defaults override inherited
values. Measured: adding a `disk` block matching the template produced one `update` that wrote
bpg's defaults onto the disk specification —

```
before: local:910000/vm-910000-disk-0.raw,discard=on,iothread=1,size=32G,ssd=1
after:  local:910000/vm-910000-disk-0.raw,aio=io_uring,backup=1,cache=none,discard=on,
        iothread=1,replicate=1,size=32G,ssd=1
```

— and the plan was clean afterwards. The size was untouched. This matters only for VMs that
already exist; a create that declares the block from the start never sees the normalisation step.

Three other attributes diverge from bpg's defaults on this template and must be declared to avoid
a diff: `machine = "q35"`, `scsi_hardware = "virtio-scsi-single"`, and
`operating_system { type = "l26" }`.

### 9. cloud-init reports `degraded done`

`cloud-init status --long` inside the guest exits **2** with `extended_status: degraded done`. The
cause is benign — bpg writes the deprecated string form of the `user` key, and cloud-init warns
about it twice — but any readiness check keying on cloud-init's exit code would read a healthy
guest as failed.

### 10. A bridge is invisible without `SDN.Use` on it, even with no SDN configured

Found while replacing `root@pam` with a scoped token. With `Sys.Audit` on the node — which is what
`validateProfile`'s node-status check needs — the token saw **3 of 9** interfaces from
`/nodes/{node}/network`, and `vmbr1` was not among them. Every bridge was filtered out; only the
physical NIC and its two VLAN children were visible.

Proxmox gates bridge visibility on `SDN.Use` for the bridge, filing plain Linux bridges under a
synthetic `localnetwork` zone even on a host with no SDN objects at all (`/cluster/sdn/zones`
returns `[]` here). The minimal grant that restores it is `SDN.Use` on
`/sdn/zones/localnetwork/vmbr1`.

Two things worth stating precisely, because "the deployment needs an SDN privilege" reads alarming
next to a plan that defers all SDN work:

- This is not SDN administration. The grant is `SDN.Use` on **one bridge**. The token holds
  nothing on `/sdn` itself, so it can neither enumerate nor create zones, vnets or subnets —
  verified by effective-privilege assertion, not by assumption.
- Without it `validateProfile` does not merely lose a check, it reports a *wrong* one: the bridge
  match is by `iface` against that listing, so a filtered bridge is indistinguishable from a
  missing one, and profile validation would fail with the bridge apparently absent.

### 11. `cpu.hotplugged` is another inherited value that cannot be cleared

The template sets `vcpus 2`, which bpg surfaces as `cpu.hotplugged`. Left undeclared, bpg computes
`0`, plans a change to clear it, and the clear does not stick — the same shape as finding 3.
Declaring `hotplugged` equal to the core count settles it, and is also what a VM without CPU
hotplug should report.

### 12. A fresh create shows diffs an evolved workspace does not

Finding 11 is only visible from a **fresh** create. The first clean no-op recorded here was
reached on a workspace that had been incrementally corrected across several applies, and those
applies had already normalised `vcpus` as a side effect. Re-creating from scratch under the scoped
token surfaced the diff immediately.

The methodological lesson matters more than the attribute: **convergence must be verified from a
fresh create, not from a workspace that was fixed into shape.** An incrementally-repaired
workspace proves that the configuration and the server agree; it does not prove that the
configuration is complete enough to create a correct VM from nothing. The product module's
convergence test therefore has to start from an empty workspace.

## Corrections to the design document

| § | Claim | Correction |
| --- | --- | --- |
| §6.3 | ForceNew attributes are `vm_id`, `node_name`, `clone.*`, `disk.datastore_id`, the cloud-init snippet ids | Confirmed, and the `clone.*` entry is more consequential than recorded: it makes import impossible without `ignore_changes` (finding 6) |
| §6.4 | A `-refresh-only` is mandatory after every direct-API mutation | Extend to **any failed apply** (finding 5) |
| §6.5 | An orphan is resolved by importing it | Only with `ignore_changes = [clone]`, and it needs one converging apply afterwards (finding 6) |
| §6.5 | Covers the VM-exists-but-state-does-not case | A third case exists: state exists but is tainted, and the resolution is `untaint` then converge, not import (finding 2) |
| §7 | The module sets no `initialization.user_account.password` | The operator has asked for a password, so it is set. The template's own baked-in key is the larger exposure (finding 4) |
| §12 q1 | Power through Terraform or the direct API, to be decided on latency | Measured: 7–19 s per power operation against a sub-second API call |
| §11 | Asks for an API token with the VM lifecycle privileges | Also needs `SDN.Use` on the one bridge, or `validateProfile` reports it absent (finding 10) |

## Fixtures produced

| Fixture | Actions | What it proves the gate must do |
| --- | --- | --- |
| `plan-create.json` | `create` | allow |
| `plan-update.json` | `update` | allow |
| `plan-noop.json` | `no-op` | allow |
| `plan-destroy.json` | `delete` | refuse |
| `plan-replace-vmid.json` | `delete`+`create` | refuse — configuration-driven replacement |
| `plan-replace-tainted.json` | `delete`+`create` | refuse — but recoverable by `untaint` |
| `plan-replace-after-import.json` | `delete`+`create` | refuse — the case `ignore_changes` prevents |

The three replacement fixtures carry distinct `action_reason` values, so the gate can report *why*
it refused rather than only that it did — and `replace_because_tainted` is the one an operator can
clear without destroying anything.

## Teardown

The lab VM was destroyed by hand after the measurements. The server is back to 211 VMs with
nothing inside 910000–910099, confirmed by a read-only inventory call.

Removing `prevent_destroy` to allow that teardown was deliberate and is the reason the production
module needs the two-directory arrangement described in the checkpoint ledger: a `lifecycle` block
cannot take a variable, so "destroy is allowed only in the purge path" is not expressible as a
single parameterised module.
