# Runbook: Terraform Run Recovery

What to do when a Terraform-backed operation does not finish cleanly. Every procedure here is
non-destructive unless it says otherwise, and the destructive one requires a VMID typed by hand.

**The standing rule:** nothing in this system automatically destroys a provider resource. If a
procedure below looks like it should, it does not — read it again.

## Reading the situation first

```bash
# What the control plane believes about this instance.
psql "$DATABASE_URL" -c "
  SELECT workspace_name, drift_state, state_serial, last_applied_at, last_refreshed_at
  FROM terraform.workspaces WHERE instance_id = '<instance-id>'"

# Every run for it, newest first.
psql "$DATABASE_URL" -c "
  SELECT command, status, gate_decision, gate_rule, exit_code, plan_actions, started_at
  FROM terraform.runs WHERE instance_id = '<instance-id>' ORDER BY started_at DESC"
```

`gate_rule` is the field that usually answers the question. It distinguishes a refusal an operator
can clear from one that needs a decision.

## A run is stuck at `running`

A run row stays `running` when the process that owned it died before recording an outcome.

The run is not lost. `getTask` will keep reporting it as running, which is honest — the apply may
still be in flight. Establish which:

```bash
# Is anything holding the state lock for this workspace?
psql "$DATABASE_URL" -c "
  SELECT pid, state, query_start FROM pg_stat_activity
  WHERE query LIKE '%terraform_remote_state%' AND state <> 'idle'"
```

- **A lock is held** — an apply is genuinely running. Wait. Commands carry a 180-second lock
  timeout, so a following operation will wait rather than fail.
- **No lock is held** — the process is gone. The `pg` backend releases its advisory lock when the
  session dies, deliberately: it has no `force-unlock` because there is nothing to force. Re-run
  the workflow; it will re-plan against real state and converge.

Never mark the row terminal by hand. A run's status is the only record of what happened, and
guessing at it removes the evidence the next investigation needs.

## The gate refused a plan

Read `gate_rule`:

| `gate_rule` | Meaning | Action |
| --- | --- | --- |
| `replace_because_tainted` | A previous apply failed partway | `untaint`, then re-run. Non-destructive |
| `replace_because_cannot_update` on `clone.*` | The module is missing `ignore_changes = [clone]` | A module bug. Fix the module |
| `replace_because_cannot_update` on `vm_id` | Configuration and reality disagree on an immutable attribute | Operator decision. See below |
| `delete_not_permitted` | A plain destroy outside the purge path | Something called the wrong path. Do not "allow" it |
| `unparseable_plan` | The plan could not be read | Usually a failed `plan`. Read the run's diagnostics |
| `errored_plan` | Terraform marked the plan errored | Read the diagnostics |
| `unrecognised_action` | A Terraform verb this gate has never seen | Do not bypass. The gate is doing its job |

### Clearing a tainted resource

```bash
# In the workspace's working directory, after init.
terraform untaint proxmox_virtual_environment_vm.instance
```

This changes state only. It does not touch the VM. The following apply converges in place, which
is what the walkthrough measured.

### A `vm_id` conflict

This means the control plane believes the instance has one VMID and the workspace was built with
another. Do not resolve it by editing either: work out which is correct, and if the VM is genuinely
ours but at a different id, adopt it (below) rather than replacing it.

## A VM exists but state does not

An orphan: the apply created the VM and died before writing state.

```bash
# 1. Prove it is ours. The marker must be the FIRST line of the description.
qm config <vmid> | grep '^description'

# 2. Adopt it.
terraform import proxmox_virtual_environment_vm.instance <node>/<vmid>

# 3. Converge. Expect exactly one update: Proxmox never returns the cloud-init password, so the
#    first post-import plan always shows it changing.
terraform plan
terraform apply
```

If the marker does **not** match, stop. SAFE-005 forbids adopting on a VMID alone. Record the
VMID in the checkpoint ledger, exclude it so no later run reuses it, and leave the VM alone.

Import only works because the module carries `ignore_changes = [clone]`. Proxmox does not record
what a VM was cloned from, so an import reconstructs an empty clone block, and every clone
sub-attribute is ForceNew — without the ignore rule the post-import plan is a replacement.

## State disagrees with reality

```bash
terraform apply -refresh-only
```

This writes to state and never to Proxmox, which is why it is safe to run at any time. It is
**required** after any failed apply and after every direct-API mutation, and for one measured
reason: a refused disk shrink was observed writing the rejected size into state while the server
kept the real one. The inventory reads persisted state, so it would have reported a disk size the
server never had.

`terraform state rm` (forget) and `terraform import` (adopt) are both permitted and both touch only
state. `terraform apply -replace=` is **forbidden** — it is a destroy with a friendlier name.

## A direct-API mutation left the workspace drifted

Expected after a rollback, which reverts disk and configuration wholesale with Terraform learning
nothing about it. The adapter schedules a refresh and marks the workspace `drifted` until that
refresh proves otherwise.

If `drift_state` is still `drifted` long afterwards, the refresh failed. Run it by hand. If it
reports real drift, that is a finding and not a fault: SAFE-029 requires reporting drift, never
repairing it automatically.

## Destroying a VM by hand

The last resort, and the only destructive procedure here.

Preferred: use the control plane's own purge capability. It carries the `verifying_purge` stage,
which proves live ownership before acting, and it records an audit entry.

Break-glass, when the control plane cannot reach it:

```bash
# 1. Record the pre-destroy evidence in the checkpoint ledger FIRST.
qm config <vmid> | grep -E '^(name|description)'

# 2. Only if the marker proves ownership.
qm stop <vmid> && qm destroy <vmid> --purge
```

Never from a tool, never from a script, never in a `finally`. The VMID is typed by hand every
time. On a shared server this is the difference between destroying a lab fixture and destroying
somebody's work.

## Rotating credentials

The token and the administrator password are independent.

```bash
# Re-mint the token. Idempotent; reuses the role, pool, user and ACLs.
pnpm run proxmox:token

# Verify the boundaries still hold.
pnpm run proxmox:token:verify
```

Rotating the administrator password does **not** invalidate the token. The password exists only so
the token can be re-minted; nothing in the running system authenticates with it.

The state connection string is a separate setting from `DATABASE_URL` and must carry an explicit
`sslmode`. The runner refuses to start without one, because Terraform's `pg` backend defaults TLS
on where the application's driver defaults it off — the same string works for one and fails for the
other, and silently appending `sslmode=disable` would be a transport-security decision made in the
wrong place.

## Checking the configuration agrees with itself

```bash
pnpm run proxmox:check-config
```

Twenty-one comparisons between the seeded catalog and the `PROXMOX_*` environment. Three of them
are checked at runtime anyway, but only at the point of use, minutes into a workflow, and only as
an opaque `protocol_error`. It also checks the one trap with no runtime guard until far too late:
that an enabled flavour's `minimum_disk_gib` equals the clone template's measured disk, which
`assertResources` compares for exact equality.
