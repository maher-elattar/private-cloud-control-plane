# Terraform Call Map

What the Terraform-backed adapter does for each provider-port method, in the order it does it.
The analogue of [Proxmox Create Call Map](proxmox-create-call-map.md) for the adapter that drives
Terraform instead of `/api2/json` directly.

## Purpose

This map defines the only sequences the Terraform adapter performs. It translates the
provider-neutral gRPC contract into Terraform invocations and, for the six operations Terraform
cannot express, into a narrowed set of Proxmox API calls. Nothing outside this map is attempted,
and no path here writes a VM's configuration except through Terraform.

Every claim below was measured against a live server. Where a measurement contradicted the design,
[Terraform Manual Walkthrough](terraform-manual-walkthrough.md) records the correction.

## Routing

Nine of the seventeen port methods go through Terraform; six go to the direct client; two are
local.

| Method | Route | Sequence |
| --- | --- | --- |
| `getCapabilities` | local | Static. No I/O, so the readiness probe can call it every few seconds |
| `validateProfile` | Terraform | `prepare` → `init` → `plan`, in a throwaway workspace |
| `submitCreateInstance` | Terraform | See below |
| `applyInstanceConfiguration` | Terraform | Convergence assertion, not a write |
| `getTask` | either | Run record, or a Proxmox task for a `upid:`-prefixed reference |
| `observeInstance` | Terraform | `init` → `apply -refresh-only` → `show -json` |
| `startInstance` / `shutdownInstance` | Terraform | `started = true`/`false` |
| `resizeInstance` | Terraform | `cpu.cores`, `memory.dedicated`, `disk.size` |
| `markInstanceRetained` | Terraform | `on_boot = false`, `started = false`, retention trailer |
| `purgeInstance` | Terraform | The purge module, with `allowDestroyOf` |
| `stopInstance` | direct | `POST .../status/stop` with `overrule-shutdown=1` |
| `rebootInstance` | direct | `POST .../status/reboot` |
| `listSnapshots` | direct | `GET .../snapshot`, minus the synthetic `current` |
| `createSnapshot` | direct | `POST .../snapshot` with `vmstate=0` |
| `rollbackSnapshot` | direct | `POST .../snapshot/{name}/rollback` with `start=1` |
| `deleteSnapshot` | direct | `DELETE .../snapshot/{name}` |

## The create sequence

| Stage | Invocation | Inputs | Result handling | Safety rule |
| --- | --- | --- | --- | --- |
| Allowlist | none | `imageId`, ownership markers, context | Refuse anything outside the profile | Image, profile and project all checked before any I/O |
| VMID | none | `instanceId` | SHA-256 of the instance id, modulo the reserved interval | Deterministic, so a replay recognises its own work. Never `/cluster/nextid` |
| Prepare | copy module, write tfvars | rendered variables | Directory is unique per run | A cleanup can only remove the directory its own operation made |
| Init | `init -lock-timeout -backend-config=conn_str` | state connection string | Non-zero is retryable, not permanent | The connection string is never logged or written to a file |
| Plan | `plan -out -var-file` | tfvars | `show -json` → the gate | The gate reads what Terraform *planned*, not what was intended |
| Record | `terraform.runs` insert | run id, fencing token | Written **before** the process starts | SAFE-014, so a restart resumes rather than resubmits |
| Apply | `apply <plan file>` | the saved plan | Not awaited; the caller polls | The saved file, never a fresh plan — that is what makes the gate binding |
| Complete | `terraform.runs` update | exit code, plan actions, diagnostics | Every path records, including the `catch` | A background task that recorded nothing would leave the workflow polling forever |
| Inventory | `terraform.workspaces` upsert | state serial and lineage | `in_sync` only after a *successful* apply | A failed apply can leave state holding a rejected value |

## Task and retry rules

- One run row is one task. `getTask` polls that row, not a process, which is what makes a worker
  restart survivable.
- A **refused plan** is terminal, not pending. The gate will refuse again for the same reason, so
  reporting it as running would leave the workflow polling forever.
- A reference `getTask` cannot find reports `UNKNOWN`, never `FAILED`. Guessing "failed" for a
  reference that may simply not be committed yet would abandon a live instance.
- A background task that throws records `unknown`, not `failed`: the apply may have acted before
  it failed, and SAFE-018 forbids guessing.
- A **transient** failure is distinguished from a permanent one by matching a narrow set of
  patterns in the diagnostics — a held config lock, bpg's "all attempts fail", a refused
  connection. Terraform flattens the provider's structured error into a string, so a text match is
  the only signal available by then. That is a real cost of routing through Terraform.
- Every command carries `-lock-timeout`. Terraform's default is to fail immediately on lock
  contention, and two things legitimately overlap on one instance: a submit whose apply continues
  in the background, and the refresh a direct mutation schedules.

## Rules for the direct half

- Every direct mutation is followed by `apply -refresh-only`, because Terraform did not make the
  change and has no way to know about it. A rollback additionally marks the workspace `drifted`
  until a refresh proves otherwise.
- Ownership is proven from the **live VM's description**, not from state, before any snapshot
  operation or purge. State is this system's belief; a destructive call has to be justified by what
  is actually there.
- The client can name no VMID outside the reserved interval, and the check runs before the URL is
  built — there is no code path that puts a foreign VMID in a request.
- A snapshot name is validated rather than escaped, because it is interpolated into a URL path and
  a validated name is easier to audit than an escaped one.
- A task counts as successful only when it is `stopped` **and** reports `exitstatus=OK`. `stopped`
  alone means finished, not succeeded.

## Deliberately not done

- **No `terraform destroy` outside the purge path.** The ordinary module carries
  `prevent_destroy`, the purge path uses a sibling module that differs only in that block, and a
  check fails if anything else diverges between them.
- **No snippet-based cloud-init.** Those attributes are ForceNew in this provider, so editing
  cloud-init through them would ask Terraform to destroy a running instance. Inline only, which
  also means this deployment needs no SSH access to the node.
- **No `/cluster/nextid`**, no node selection, no migration, no HA, no SDN resource.
- **No configuration write from the direct client.** It performs six operations and reads one
  config; it cannot move an instance away from the state Terraform believes in.
- **No automatic destroy on any failure branch.** A refused plan, a tainted resource and an
  unknown outcome all end in a recorded refusal and `manual_review`.

## Known environmental limitations

These are properties of the target, not of this code, and they are recorded because the
alternative is rediscovering them.

| Limitation | Consequence | Fix |
| --- | --- | --- |
| Template 110's disk is **raw** on directory storage | Snapshots are impossible: directory storage snapshots qcow2 only, and bpg does not convert format on a clone — measured | Rebuild the template with a qcow2 disk |
| The template carries an SSH key in its image | Every clone grants that key's holder access, and cloud-init cannot remove it | Rebuild the template with no `authorized_keys` content |
| The template sets `searchdomain` and `vcpus` | Both must be declared explicitly or they diff forever | Declared in the module |
| A bridge is invisible without `SDN.Use` on it | `validateProfile` would report an existing bridge absent | One `SDN.Use` grant on the single bridge |
