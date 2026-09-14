# Terraform Provisioning Completion Checkpoints

This file is the resumable execution record for switching the Proxmox adapter from direct API
calls to the `bpg/proxmox` Terraform provider. Update it when a checkpoint starts, when its
verification completes, and after its commit. Do not mark a checkpoint complete without recording
concrete evidence.

The authoritative design is [`terraform-provisioning-plan.md`](terraform-provisioning-plan.md).
This file is the execution sequence for that design, not a second design. Where the two disagree,
the design document is amended and the divergence recorded here as a decision rather than
resolved silently.

Scope is deliberately narrow: the nine lifecycle capabilities that already exist, executed through
Terraform instead of hand-written HTTP, against **one standalone server**. Software-defined
networking is deferred to [`vpc-topology-plan.md`](vpc-topology-plan.md) and must not be designed
into this work.

## Current State

- The Terraform-backed adapter implements **all seventeen** provider-port methods and is verified
  against the live server at **22 of 22 checks** (`pnpm run verify:terraform-adapter`).
- Nine methods route through Terraform, six through a narrowed direct client, two are local. See
  [Terraform Call Map](docs/architecture/terraform-call-map.md).
- `PROVIDER_ADAPTER` accepts `fake`, `proxmox` and `terraform`. **The default is still `fake`**
  and the direct adapter is unchanged apart from the shared marker fix of T-5.
- Checkpoints T-0 through T-10 and T-12 through T-15 are complete. **T-11's upper layers**
  (REST accept → outbox → Kafka → orchestrator → projection, against this adapter) and T-16
  and T-17 remain.
- The server is left with **0 VMs inside the reserved interval 910000-910099** after every run.
  This is checked as both a precondition and a teardown assertion.

## Survey findings that shape everything below

Recorded 2026-09-14 from [`docs/verification/testsrv-survey.md`](docs/verification/testsrv-survey.md).
Evidence: [`docs/verification/evidence/testsrv-survey.json`](docs/verification/evidence/testsrv-survey.json).

1. **Template 110 matches the seeded `lab-small` flavour exactly** — 2 vCPU, 4096 MiB, 32 GiB
   disk on storage `local`, `template=1`, cloud-init drive present, `agent=1`. This is load
   bearing: `assertResources` refuses a create unless the requested disk equals the template's
   disk exactly, so a mismatch would have required a new flavour. None is needed.

2. **`vmbr1` exists at `192.168.4.1/22` with no bridge ports**, and the template's `net0` carries
   **`mtu=1400`**. The existing adapter preserves that MTU by accident, rewriting only the
   `bridge=` component of the inherited NIC. A Terraform `network_device` block builds the NIC
   from scratch and must set the MTU explicitly.

3. **This is a shared server with live workloads** — 211 VMs (101–317), 134 of them on `vmbr1`,
   and **110 addresses already in use inside `192.168.4.0/22`**, occupying `192.168.7.102` to
   `192.168.7.252`. The allocator returns the lowest free address so the first instances land at
   `192.168.4.2` upward, clear of that region, but the 110 measured addresses must be seeded as
   `control.networks.exclusions`. The pre-mutation address recheck reads every VM config on the
   node: measured 211 configs in 1.9 s at concurrency 12, so ~22 s serially, once per create.

4. **The reserved VMID interval 910000–910099 is free and accepted** by this server, with no
   `next-id` restriction in `datacenter.cfg`. Confirmed by `GET /cluster/nextid?vmid=910000`
   returning `910000`.

5. **Two blockers in this repository**, both found while surveying and neither caused by the
   server: the readiness probe returns 500 rather than 503 under any adapter whose
   `getCapabilities` throws synchronously (T-3), and the supplied root password cannot
   authenticate the direct adapter at all, which needs an API token (T-4).

## Completion Plan

### Checkpoint T-0 — Credential boundary and pending commits

- Status: Complete
- Rationale: the credentials file was untracked but **not** ignored, and `.gitignore` carried no
  Terraform patterns at all. Terraform state holds the cloud-init password in cleartext, so the
  ignore rules had to exist before any Terraform command ran inside the repository.
- Evidence recorded 2026-09-14:
  - `.gitignore` gained the credentials file, `*.tfstate`, `*.tfstate.*`, `*.tfvars`,
    `*.tfvars.json` with a `!*.tfvars.example` negation, `.terraform/`,
    `.terraform.tfstate.lock.info`, `crash.log`, `crash.*.log`, and `.*.kate-swp`.
  - **`.terraform.lock.hcl` is deliberately not ignored.** The dependency lock is meant to be
    committed and pinning a provider by hash is a supply-chain control. `.terraform/` carries a
    trailing slash so it matches only the plugin cache directory and never that lock file.
    Verified with `git check-ignore -v` on one representative path per pattern.
  - Committed alone as `726bc22`, ahead of everything else, so the credentials file could not be
    staged by accident. The plan rewrite and VPC deferral followed as `167871f`.
  - `git log --all -- terraformProxServerTestCredntails.txt` is empty: the file has never been in
    a commit. `git status --porcelain` does not list it.
- Commit: `726bc22`, then `167871f`

### Checkpoint T-1 — Server survey

- Status: Complete
- Rationale: template disk size, storage id, bridge existence and VMID availability can only be
  read off the target. Guessing any of them produces a failure at first apply instead of a finding
  here, and the disk size in particular gates whether the existing flavour can be used at all.
- Required work: a read-only survey tool, a narrative survey document, and a machine-readable
  evidence record.
- Evidence recorded 2026-09-14:
  - New tool `tools/verification/survey-proxmox.mjs`, wired as `pnpm run survey:proxmox`.
    Dependency-free ESM. Every call is a `GET` except the login, which is the one `POST` the
    Proxmox API requires to mint a ticket; there is no code path that creates, configures, powers
    or deletes anything.
  - The tool redacts `cipassword`, `sshkeys`, `ticket` and `CSRFPreventionToken`, and records
    third-party VMs as **addresses and VMIDs only**. Their names identify real people and are
    never written. Verified: the evidence file contains zero occurrences of the password and no
    key material.
  - All nine survey questions answered with measured values — see the findings above.
  - Two repository blockers discovered and confirmed by execution, not by reading alone.
- Verification:

  | Gate                              | Result                                                                      |
  | --------------------------------- | --------------------------------------------------------------------------- |
  | `pnpm run survey:proxmox`         | Survey completed; 9 of 9 questions answered                                 |
  | Secret scan of the evidence file  | 0 occurrences of the password; `cipassword` and `sshkeys` both `<redacted>` |
  | Third-party name scan             | Only the template's own name recorded                                       |
  | `GET /cluster/nextid?vmid=910000` | `200 {"data":"910000"}` — reserved range accepted                           |

  Evidence: `docs/verification/evidence/testsrv-survey.json`, captured `2026-09-14`.

- Planned commit: `feat: survey the Proxmox test server before Terraform work`

### Checkpoint T-2 — Manual Terraform walkthrough

- Status: Complete
- Rationale: the operator asked for the flow to be driven by hand against the server first, to
  understand it, before any of it is wired into the control plane. This is also where the design
  document's claims stop being research and become measurements.
- Required work:
  - `terraform-state/` as the exploration folder. `manual/` holds the HCL with a **local**
    backend: the by-hand phase must not write into the control-plane database before the
    `terraform_remote_state` schema and its grants exist (T-6). `fixtures/` holds redacted
    `terraform show -json` captures, which become the plan gate's test fixtures in T-7 — real
    plans from real hardware rather than invented ones.
  - Credentials reach Terraform as `PROXMOX_VE_*` environment variables sourced from the
    gitignored file, never as HCL and never on a command line.
  - Pin `bpg/proxmox` to an exact version and commit `.terraform.lock.hcl`.
  - Clone template 110 into a VMID inside 910000–910099 with `mtu = 1400` on the NIC, inline
    cloud-init (`ip_config`, `dns`, `user_account`), and the ownership marker in `description`.
  - Then measure, rather than assume, each thing the design depends on:
    - a second apply with no change is a clean no-op (`plan -detailed-exitcode` → 0), which is
      what the convergence assertion in design §5.4 rests on
    - the ownership marker round-trips through bpg byte-for-byte, so `parseOwnership` would
      succeed on what Proxmox actually stores
    - which attribute changes are `update` and which are `replace`, capturing the plan JSON for
      each
    - a disk shrink is refused by bpg on this version
    - `prevent_destroy` actually blocks a destroy here
    - `terraform import` adopts a marker-carrying VM and the following plan is a no-op, which is
      what the orphan resolution in design §6.5 rests on
    - latency for init, plan, apply-create, apply-noop, power off, power on, refresh-only
    - the guest genuinely comes up: `192.168.4.x/22`, gateway `192.168.4.1`, DNS `1.1.1.1`, and
      the configured user can log in
- Safety note: this VM is not a control-plane instance and is not in any control-plane table, so
  a hand-typed `terraform destroy` is the correct way to clean it up. That permission does not
  extend to anything else on this server, and nothing automated may destroy anything.
- Evidence recorded 2026-09-14, written up in
  `docs/architecture/terraform-manual-walkthrough.md`:
  - VM 910000 cloned from template 110 and booted **Ubuntu 24.04.5 LTS**, with `eth0` holding
    `192.168.4.2/22`, `default via 192.168.4.1`, the `ubuntu` user at uid 1000 in `sudo`, and
    `search lab.invalid` applied. Verified from inside the guest through the QEMU agent, not only
    from the Proxmox configuration.
  - **The ownership marker round-trips byte-for-byte.** This was the largest open risk in the
    design: had bpg normalised the description, the whole ownership model would have needed
    rethinking. It does not.
  - `plan -detailed-exitcode` reaches 0, so design §5.4's convergence assertion is viable — but
    only once every attribute the template sets is declared explicitly.
  - Change classification measured across thirteen attributes. Everything the control plane needs
    to change during an instance's life is an in-place `update`; three destructive shapes exist
    and all are avoidable.
  - Latency measured: plan no-op 2 s, refresh-only 1 s, disk grow 5 s, power off 7 s, create 11 s,
    power on 19 s, converge 21 s, destroy 10 s. That answers design §12's first open question with
    numbers rather than intuition — a power operation costs 7 to 19 seconds against a sub-second
    direct API call.
  - Seven plan fixtures captured under `terraform-state/fixtures/`, redacted to structure only:
    create, update, no-op, delete, and three distinct replacements each carrying a different
    `action_reason`. These are the plan gate's inputs at T-8 — real plans this provider emitted,
    rather than invented JSON that would only prove the fixtures match the parser.
- Findings that change the design:
  - **A failed create taints the resource, and a tainted resource is destroyed on the next plan**
    (`replace_because_tainted`). The gate refuses that plan, correctly — which means a transient
    create failure wedges the instance until something clears the taint. `terraform untaint`
    clears it without touching the VM and the next apply converges in place. The runner needs that
    recovery path. Design §6.5 covers the VM-exists-but-state-does-not case and does not cover
    this one.
  - **`terraform import` cannot adopt a cloned VM.** Proxmox does not record what a VM was cloned
    from, so an import reconstructs an empty `clone` block, and every `clone` sub-attribute is
    ForceNew — so the post-import plan is a replacement. `ignore_changes = [clone]` fixes it, and
    is therefore not an optimisation but the thing that makes orphan adoption possible at all.
  - **A refused disk shrink writes the rejected size into state** while the server keeps the real
    one. `plan` refreshes in memory so it reports correctly, but the persisted state stays wrong
    until `apply -refresh-only` repairs it — and the state inventory reads persisted state
    directly. Design §6.4's refresh rule must extend from direct-API mutations to any failed
    apply. The wider point is that the control plane's admission-time shrink refusal is the
    load-bearing one: relying on the provider's refusal does not merely cost time, it corrupts
    state.
  - **`initialization.datastore_id` defaults to `local-lvm`**, which does not exist on this host,
    and is independent of `clone.datastore_id`. This caused the first failure.
  - Template-inherited values can be overwritten but not cleared: bpg omits the key rather than
    issuing Proxmox's `delete=`, so anything the template sets and the configuration leaves empty
    diffs forever.
  - Proxmox validates SSH public keys server-side, returning HTTP 500 for an invalid one. The
    domain validator checks length and control characters but not validity.
- Safety finding, recorded separately because it is not a defect in this work:
  **the template's baked-in SSH key reaches every guest and cloud-init cannot remove it.** At the
  Proxmox layer an explicit key list replaces cleanly, but `/home/ubuntu/.ssh/authorized_keys`
  inside the running guest held two keys — the supplied one and `maher@AsusOLED-Linux`, which the
  golden image already carries. Every VM cloned from template 110 therefore grants a third party
  SSH access, including every VM the existing direct adapter creates today. The existing adapter
  makes it worse: it sets `sshkeys` only when the request carries at least one key, and
  `sshPublicKeys` is optional in the contract, so an instance created without keys never has its
  key list touched at all. The fix is to rebuild the template with no `authorized_keys` content;
  until then this is a known exposure of the lab environment and belongs in the runbook.
- Verification:

  | Gate                                                   | Result                                                        |
  | ------------------------------------------------------ | ------------------------------------------------------------- |
  | `terraform validate`, `terraform fmt -check`           | clean                                                         |
  | `plan -detailed-exitcode` on the settled configuration | 0 — clean no-op, twice                                        |
  | Guest verification through the QEMU agent              | Ubuntu 24.04.5, correct address, gateway, user, search domain |
  | `prevent_destroy`                                      | blocks a destroy: `Error: Instance cannot be destroyed`       |
  | Disk shrink                                            | refused at apply: `Cannot shrink ... it is not supported!`    |
  | Teardown                                               | 211 VMs on the server, none inside the reserved interval      |
  | Secret scan of every committable file                  | 0 occurrences of the password                                 |
  | `pnpm run docs:validate`                               | 61 Markdown files, 46 Mermaid artifacts                       |

  Evidence: `docs/architecture/terraform-manual-walkthrough.md` and `terraform-state/fixtures/`.

#### Addendum from T-4

Re-creating from scratch under the scoped token surfaced one further inherited value that the
evolved workspace had hidden — `cpu.hotplugged`, which the template sets through `vcpus`. The
methodological lesson is the durable part: **convergence must be verified from a fresh create, not
from a workspace that was incrementally fixed into shape.** A repaired workspace proves the
configuration and the server agree; it does not prove the configuration is complete enough to
build a correct VM from nothing.

#### Deviation recorded

`prevent_destroy` was removed from the manual configuration to tear the lab VM down. That was
deliberate, and it is the reason the production module needs two sibling directories rather than
one parameterised module: a `lifecycle` block cannot take a variable, so "destroy is permitted
only in the purge path" is not expressible as a single module. Recorded as a design correction to
be resolved at T-8.

One ignore-rule gap was found and closed by the work itself: an experiment left a
`terraform.tfvars.backup` holding the cloud-init password, and `*.tfvars` does not match it
because it does not end in `.tfvars`. Both ignore files now cover the suffixed forms, verified
with `git check-ignore`. Nothing was committed in the interim.

### Checkpoint T-3 — Readiness probe defect

- Status: Complete
- Rationale: blocked every live checkpoint. Under any adapter whose `getCapabilities` throws
  synchronously the provider container never becomes healthy, and `provisioning-orchestrator`
  declares `depends_on: service_healthy`, so the orchestrator never starts and no request can
  reach the provider at all.
- Evidence recorded 2026-09-14:
  - **The defect had two halves and both are fixed.** The probe chained `.catch()` onto
    `getCapabilities(...)`, and `ProxmoxProvider.getCapabilities` was not `async`, so its profile
    assertion threw _before any promise existed_ and escaped the handler. The endpoint raised
    instead of answering 503.
  - The controller now wraps the call in `try`/`catch` rather than chaining `.catch()`, and
    `getCapabilities` is `async` so the rejection path would be taken anyway. The `try` stays
    regardless: a health endpoint must not be able to return 500 because a dependency
    misbehaved, and the next adapter should not have to be polite for that to hold.
  - **Fixing only the throw would have left the endpoint permanently 503.** The probe passes no
    profile, and the assertion is a legitimate contract check, so a caught throw is still a
    failed probe. The configured profile id is now provided through a `PROVIDER_PROFILE_ID` DI
    token from the same factory that builds the adapter, so the probe can name it without the
    health endpoint reading the environment. Under the fake adapter the key is _absent_ rather
    than `undefined`, so a strict adapter cannot read it as a caller asking about a profile
    literally named `undefined`.
  - Corrected the capability flags. `resizeCompute`, `growDisk`, `snapshots`, `retentionMarker`
    and `purge` all reported `false` while being implemented — Phase 5 built them and did not
    update the report — so `getCapabilities` was advertising a narrower adapter than the one that
    exists, and any caller gating on those flags would have refused work this adapter can do.
    `maximumSnapshots` was `0` for the same reason.
  - The compute bounds are now named constants shared between `assertResources` and the
    capability report, so the enforced limits and the advertised limits cannot drift apart.
- Verification:

  | Gate                                                              | Result                                                                |
  | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
  | New `app.controller.spec.ts` against the **defective** controller | 2 of 12 fail — the synchronous-throw case and the profile-naming case |
  | Same spec against the fix                                         | 12 of 12 pass                                                         |
  | `pnpm run format:check`                                           | clean                                                                 |
  | `pnpm run lint`                                                   | 14 projects                                                           |
  | `pnpm run typecheck`                                              | 14 projects                                                           |
  | `pnpm run test`                                                   | 11 projects, 0 failures                                               |
  | `pnpm run test:integration`                                       | 5 files, 88 tests                                                     |
  | `pnpm run contracts:validate`                                     | 39 REST, 54 gRPC, 20 events                                           |
  | `pnpm run build`                                                  | 14 projects                                                           |

  The first row is the one that matters: the spec was run against the original code to prove it
  can fail. A regression test that passes either way documents nothing.

- Deferred deliberately: the Compose check that `PROVIDER_ADAPTER=proxmox` reaches healthy needs
  the extended simulator, because the current stub implements none of the five endpoints
  `validateProfile` reads. That is its own work and is tracked where the simulator is.

### Checkpoint T-4 — Scoped API token

- Status: Complete
- Taken ahead of T-3 because the operator authorised the token creation directly and it is a
  live-server action; T-3 is offline and unaffected by the order.
- Rationale: the direct adapter authenticates only with `PVEAPIToken`, so the supplied root
  password cannot drive the six operations that must stay on the direct API. `root@pam` also
  grants far more than this work needs on a server hosting 211 other machines.
- Evidence recorded 2026-09-14:
  - New tool `tools/proxmox/create-api-token.mjs`, wired as `pnpm run proxmox:token` and
    `proxmox:token:verify`. Idempotent; it re-mints the token because Proxmox returns a secret
    only once, and the secret is written straight into the gitignored credentials file — never
    printed, logged or returned.
  - Created: role `ControlPlaneLifecycle` with 17 named privileges, role `ControlPlaneNodeAudit`
    (`Sys.Audit`), role `ControlPlaneBridgeUse` (`SDN.Use`), pool `control-plane-lab`, user
    `control-plane@pve` with no password, and token `control-plane@pve!provisioner`.
  - **The reserved VMID interval is enumerated as 100 individual ACL entries.** Proxmox ACL paths
    have no range syntax, and `/vms` would have granted authority over all 211 machines on the
    node. Being structurally unable to name a VM outside the interval is a stronger guarantee than
    intending not to.
  - The privilege list deliberately excludes `VM.Console`, `VM.Backup`, `VM.Migrate`,
    `VM.Replicate` and every guest-agent privilege except `VM.GuestAgent.Audit`. The built-in
    `PVEVMAdmin` carries all of them, and `VM.GuestAgent.Unrestricted` in particular would let the
    token run arbitrary commands inside any guest it can reach.
  - `terraform apply` performs a complete create under the token — clone, cloud-init, boot — in
    35 s, and the following plan is a clean no-op. That is the proof the ACL set is sufficient, not
    merely plausible.
  - Two pre-existing identities were found and left alone: an unused `terraform-prov@pve` with no
    tokens, and an existing `root@pam!terraform` token holding `PVEVMAdmin` on `/` and `/vms`.
    The second is far broader than anything created here and is not this work's to change, but it
    is worth the operator knowing it exists.
- Finding: **a bridge is invisible without `SDN.Use` on it.** With `Sys.Audit` on the node the
  token saw 3 of 9 interfaces and `vmbr1` was not among them, which would have made
  `validateProfile` report the bridge absent rather than merely unchecked. The minimal grant is
  `SDN.Use` on `/sdn/zones/localnetwork/vmbr1` — one bridge, not SDN administration, and the token
  still holds nothing on `/sdn` itself.
- Design correction: §11 asked for a token with VM lifecycle and datastore privileges. It also
  needs that single bridge grant.
- Verification:

  | Gate                                           | Result                                                                      |
  | ---------------------------------------------- | --------------------------------------------------------------------------- |
  | `pnpm run proxmox:token:verify`                | token verified; 6 capability reads allowed, 10 privilege assertions correct |
  | Effective privileges on our reserved VMID      | 17                                                                          |
  | Effective privileges on another tenant's VM    | **0**                                                                       |
  | Effective privileges one past the interval     | **0**                                                                       |
  | Effective privileges on `/`, `/access`, `/sdn` | **0** each                                                                  |
  | Reads of another tenant's config and status    | **403**                                                                     |
  | Read of VMID 910100                            | **403**                                                                     |
  | Reads of node syslog and cluster backup jobs   | **403**                                                                     |
  | Full `terraform apply` under the token         | create in 35 s, then a clean no-op                                          |
  | Teardown                                       | 211 VMs, none inside the reserved interval                                  |

  Boundaries were asserted through `/access/permissions` rather than by attempting forbidden
  calls. The boundary that matters is that the token cannot stop or delete one of 211 machines
  belonging to other people, and proving that by _trying_ would mean discovering a wrong ACL by
  destroying someone's VM.

### Checkpoint T-5 — Ownership-marker defect

- Status: Complete
- Rationale: `markInstanceRetained` wrote the description as
  `private-cloud-control:{…}\nretained-until=…`, but `parseOwnership` ran `JSON.parse` over the
  whole remainder after the prefix, which is invalid JSON once that second line exists. It
  returned `null`, `markersMatch` failed, and `requireOwnedConfig` threw. **After a soft delete,
  administrative purge could never prove live ownership (SAFE-006), and observation reported an
  ownership mismatch that reconciliation would read as drift.** Create, power and resize were
  unaffected, which is why nothing had noticed.
- Evidence recorded 2026-09-14:
  - `parseOwnership` now parses only the first line and tolerates trailer lines beneath it. The
    marker is still required to be the _first_ line: an operator who prepends text has genuinely
    made the description unrecognisable, and refusing to act is the intended behaviour — ownership
    is proven or the workflow stops, never inferred.
  - **Deliberately not fixed by folding `retained-until` into the marker JSON.** That would change
    the marker's wire format, and every VM already carrying the one-line form would stop parsing —
    the same failure this trailer caused, only inflicted on purpose.
  - Appending to a description now goes through `describedWithTrailer`, with the trailer key as a
    named constant. The original bug was a bare template string at the single call site that
    needed a trailer; one shared function that keeps the marker on the first line is what stops
    the next trailer repeating it.
  - Five cases added to `proxmox-provider.spec.ts`, exercising the public surface rather than the
    parser, because the behaviour that matters is that a retained VM can still be observed and
    purged: purge proves ownership on a retained description, observation reports a match on both
    the retained and the one-line form, and both a prepended-text description and a malformed
    marker are refused.
- Verification:

  | Gate                                                 | Result                                                          |
  | ---------------------------------------------------- | --------------------------------------------------------------- |
  | New cases against the **defective** parser           | 2 of 38 fail — purge and observation on a retained description  |
  | The three control cases against the defective parser | pass either way, correctly: those behaviours were already right |
  | Same suite against the fix                           | 38 of 38 pass                                                   |
  | `pnpm run format:check`                              | clean                                                           |
  | `pnpm run lint`                                      | 14 projects                                                     |
  | `pnpm run typecheck`                                 | 14 projects                                                     |
  | `pnpm run test`                                      | 11 projects, 0 failures                                         |
  | `pnpm run test:integration`                          | 5 files, 88 tests                                               |
  | `pnpm run build`                                     | 14 projects                                                     |

  As with T-3, the first two rows are the point: the suite was run against the original code to
  prove which cases catch the defect and which do not.

### Checkpoint T-6 — Catalog rows, configuration, and the config cross-check

- Status: Complete
- Evidence recorded 2026-09-14:
  - `db/seeds/0002_proxmox_testsrv.sql`, additive and with new identifiers throughout, so the
    fake catalog is untouched and cannot accidentally select one of these rows. New project,
    quota, network, provider profile and image; **no new flavours**, because template 110 is
    2 vCPU / 4096 MiB / 32 GiB and `lab-small` already describes that exactly. That is
    load-bearing rather than lucky: `assertResources` refuses a create unless the requested disk
    equals the template's disk exactly, so a flavour off by one gibibyte would fail every create.
  - **The seed is generated, not hand-written.** `tools/proxmox/generate-lab-seed.mjs` derives it
    from the survey evidence, because its interesting content is the list of 110 addresses already
    live on the bridge — a measurement, and exactly the kind of thing hand-transcription gets
    quietly wrong. `pnpm run proxmox:generate-seed:check` asserts the committed file is current.
  - The live project's quota is deliberately tight: **three instances**. SAFE-030 requires a small
    explicit cap for live-provider work, and the reserved interval holds 100 identifiers, so the
    quota exhausts long before the interval does.
  - `tools/db/seed.mjs` now applies the whole `db/seeds` directory in order. It named one file,
    which meant adding a second seed silently did nothing until the loader was also edited.
  - `tools/proxmox/check-config.mjs` (`pnpm run proxmox:check-config`) asserts the seeded catalog
    and the `PROXMOX_*` environment describe the same server — 21 comparisons. Three of these are
    checked at runtime today by `assertNetwork` and `submitCreateInstance`, but only at the point
    of use, minutes into a workflow, and only as `protocol_error` with a message that does not say
    which value disagreed. It also checks the trap that has no runtime guard until far too late:
    that an enabled flavour's `minimum_disk_gib` equals the template's measured disk.
- **A defect the new seed exposed, and fixed.** `resetIntegrationState` restored quotas with an
  unqualified `UPDATE control.quotas SET ...` — correct while exactly one project existed, and
  silently wrong the moment a second appeared: it replaced the live-hardware project's
  three-instance cap with the fake project's twenty. **A reset that widens a safety limit is worse
  than one that leaves rows behind.** Quotas are now restored per project, and a new case asserts
  the restore map covers every seeded project, so the two cannot drift as seeds are added.
- Verification:

  | Gate                                                   | Result                                                 |
  | ------------------------------------------------------ | ------------------------------------------------------ |
  | `pnpm run test:integration`                            | 5 files, **93 tests** — was 88; five added             |
  | The quota case against the unqualified reset           | fails, which is what exposed the defect                |
  | `pnpm run proxmox:check-config`, correct configuration | 21 of 21 agree                                         |
  | Same with a wrong gateway and a wrong image            | 2 of 21 disagree, exit 1                               |
  | Same with no `PROXMOX_*` set                           | names the missing settings, exit 1                     |
  | `pnpm run proxmox:generate-seed:check`                 | current: 110 exclusions from the 2026-09-14 survey     |
  | `pnpm run test`                                        | 11 projects, 0 failures — the fake path is undisturbed |
  | `pnpm run format:check`, `lint`, `typecheck`, `build`  | clean; 14 projects each                                |
  | `pnpm run docs:validate`                               | 61 Markdown files, 46 Mermaid artifacts                |

  The "fake path is undisturbed" row is the one the additive design exists to satisfy: the
  integration suites and the Postman collection depend on seed 0001's values, and they still pass
  with seed 0002 applied.

- Superseded required work:
  - `db/seeds/0002_proxmox_testsrv.sql`, **additive, new ids only**. `0001_phase3_fake.sql` is not
    touched: the integration suites and the Postman collection depend on its values, and its
    `ON CONFLICT DO NOTHING` means an edit would not take effect on an existing database anyway.
    New network (`192.168.4.0/22`, gateway `192.168.4.1`, DNS `1.1.1.1`, exclusions from the
    survey), new provider profile, new image bound to it. Acceptance resolves the profile through
    the image and requires `profile.network_id === network.id`, so the three rows must be
    self-consistent.
  - `tools/db/seed.mjs` currently hardcodes one seed file and must apply the directory in order.
  - **A configuration cross-check.** The seeded rows and the `PROXMOX_*` environment are compared
    at runtime by `assertNetwork` and `assertDirectProfile`, and today a mismatch surfaces only as
    an opaque `protocol_error` at create time. A tool that asserts every configured value equals
    the seeded one turns that into a configuration fault reported before anything runs.
- Verification required: `pnpm run test`, `pnpm run test:integration` and `pnpm run postman:check`
  green **with the new seed present** — that is the proof the fake path is undisturbed.

### Checkpoint T-7 — Inventory schema

- Status: Complete
- Evidence recorded 2026-09-14:
  - Migration `0008_terraform_inventory.sql` creates `terraform.runs`, `terraform.workspaces`,
    and the `terraform_remote_state` schema the Terraform `pg` backend manages itself.
  - **The state schema is created here but never written by this system.** Creating it rather than
    letting the backend create it is what allows the grants to exist before the first apply:
    `terraform_runner` gets `USAGE, CREATE`, and `ALTER DEFAULT PRIVILEGES` gives
    `control_plane_application` `SELECT` on whatever the runner creates later. Terraform state
    holds the cloud-init password and any SSH key material — it is a secret store that happens to
    be JSON — and a grant is a boundary where an intention is not.
  - Role creation is wrapped in a `DO` block testing `pg_roles`, because `CREATE ROLE` has no
    `IF NOT EXISTS` and a migration that fails on re-application cannot be recovered after a
    partial failure. Verified by applying twice.
  - **No `DELETE` is granted anywhere in the schema.** A run record is evidence, and a workspace
    row outliving its instance is a finding rather than garbage: it means state exists for
    something the control plane believes is gone.
  - `terraform.workspaces.instance_id` is the primary key and `workspace_name` is unique, so one
    instance has one workspace and one workspace name belongs to one instance. The second half
    matters as much as the first: the `pg` backend's advisory lock is keyed on the state row, so
    two instances sharing a name would share a lock and serialise against each other.
  - `drift_state` defaults to `unknown`, never `in_sync`. A workspace nothing has observed is
    unknown, not healthy.
  - Kysely table types added, with defaulted columns marked `Generated` and nullable ones
    `Nullable`, so the insert shapes the tests use are the shapes the schema actually accepts.
- **A fragility the tests exposed, and fixed in the schema's contract.**
  `runs_finished_after_started` compared a `finished_at` the application computed against a
  `started_at` the column default supplied — two different clocks. Under any skew between the
  application and the database, a legitimately finished run would be rejected. The constraint is
  worth keeping, because the row it refuses is genuinely impossible; the requirement it implies is
  now stated in the migration and honoured by the tests: **both timestamps come from the database
  clock.**
- Scope recorded honestly: **stale-fencing-token rejection is not covered here.** No constraint
  can express "refuse a write whose token is older than the current lease" — it is a store
  behaviour, and it belongs where that store is written. The column exists and is `NOT NULL`;
  asserting enforcement at this layer would be claiming a guarantee the schema does not make.
- Verification:

  | Gate                                                  | Result                                                                            |
  | ----------------------------------------------------- | --------------------------------------------------------------------------------- |
  | `pnpm run test:integration`                           | 6 files, **108 tests** — was 93; fifteen added                                    |
  | `pnpm run db:migrate` applied twice                   | second run is a no-op; role creation is idempotent                                |
  | Default privileges on `terraform_remote_state`        | `control_plane_application=r/` only — no `w`, `a` or `d`                          |
  | `DELETE` grants in schema `terraform`                 | none, for either role                                                             |
  | Advisory-lock contention on one workspace             | second session refused while the first transaction is open, and free once it ends |
  | `pnpm run format:check`, `lint`, `typecheck`, `build` | clean; 14 projects each                                                           |
  | `pnpm run docs:validate`                              | 61 Markdown files, 46 Mermaid artifacts                                           |

- Safety note, unchanged: migrations are forward-only and `tools/db/migrate.mjs` refuses a changed
  checksum. An aborted attempt is recovered with a new migration, never by editing `0008`. The
  clock correction above was made before the migration was committed, so no such recovery was
  needed.

### Checkpoint T-8 — Module and plan gate

- Status: Complete
- Evidence recorded 2026-09-14:
  - `deploy/terraform/modules/instance/` carries the spellings T-2 proved, including the three
    that exist only to stop a diff that never converges — `machine`, `scsi_hardware`,
    `operating_system.type` — plus `cpu.hotplugged`, `initialization.datastore_id`,
    `dns.domain`, and `network_device.mtu`. Both modules `terraform validate` clean, and both
    lock files are committed.
  - **The `prevent_destroy` design correction is resolved.** A `lifecycle` block takes literals
    only, so the sibling `instance-purge/` module exists, differing from `instance/` _only_ in its
    header and its lifecycle block. `pnpm run terraform:check-modules` asserts that: the other
    three files must be byte-identical, and `main.tf` is compared with the header and the
    lifecycle block excised by brace depth rather than by regex, because a comment containing a
    brace defeats a pattern match.
  - The resources must stay identical for a reason beyond tidiness: a purge destroys _the
    instance the ordinary module built_, so if the two drifted the purge plan would compare the
    live VM against a different desired state and could propose changes before destroying it —
    which is the one moment nothing should be proposing changes.
  - `evaluatePlan` refuses unless every `resource_changes[].change.actions` entry is `no-op`,
    `create`, `read` or `update`. It fails closed on an unparseable plan, on a plan Terraform
    marked errored, and on any action it does not recognise — a future Terraform verb must not
    pass merely because it is not spelled `delete`.
  - The purge capability is `allowDestroyOf: <address>`, not a boolean. Naming one address means a
    purge plan that would _also_ destroy something else is still refused, which on a shared server
    is the accident worth preventing.
  - `isRecoverableByUntaint` separates the refusal an operator can clear without touching a VM
    (`replace_because_tainted`) from one that needs a decision. A mixed refusal is not recoverable.
- **The module check caught its own false positive**, which is worth recording. It matched the
  _word_ `prevent_destroy` and so failed on the purge module's comment explaining that
  attribute's absence. It now matches the assignment. A check an explanatory comment can break is
  worse than no check: it fails for a reason unrelated to safety, and the obvious fix is to
  delete the explanation.
- Verification:

  | Gate                                                  | Result                                                         |
  | ----------------------------------------------------- | -------------------------------------------------------------- |
  | `npx nx test provider-adapters`                       | 7 files, **62 tests** — was 38; twenty-four gate cases added   |
  | Gate fixtures asserted                                | all 7 captured plans; a meta-case fails if one is unreferenced |
  | `terraform validate`, both modules                    | valid                                                          |
  | `pnpm run terraform:check-modules`                    | modules agree                                                  |
  | Same with one line of the purge module altered        | 2 problems, exit 1                                             |
  | `pnpm run format:check`, `lint`, `typecheck`, `build` | clean; 14 projects each                                        |

  The fixture-coverage case is deliberate: a captured plan nobody asserts against is a plan shape
  nobody checked, and captured plans are expensive because they need real hardware.

- Superseded required work: `deploy/terraform/modules/instance/` promoted from the T-2 exploration with the
  spellings T-2 proved, `mtu` set explicitly, no ForceNew attributes set, and `ignore_changes` for
  anything T-2 showed as a perpetual diff. Then the plan gate: refuse unless every
  `resource_changes[].change.actions` is `no-op`, `create`, `read` or `update`.
- **Design correction to resolve here.** `prevent_destroy` is a `lifecycle` meta-argument and
  cannot take a variable, so the design document's "toggled off only in the purge path" is not
  expressible as written. Resolve with two sibling module directories differing only in the
  `lifecycle` block, plus a check that fails if anything else differs between them.
- Verification required: unit tests over the **T-2 fixtures** covering create, update, delete,
  both replace orderings, a multi-resource plan where only one resource is destructive, an
  unparseable plan (must fail closed), and an unknown action string.

### Checkpoint T-9 — Runner

- Status: Complete
- Evidence recorded 2026-09-14:
  - Four pieces, split so that the dangerous ones are pure: `tfvars.ts` renders variables,
    `diagnostics.ts` parses and redacts output, `runner.ts` drives the subprocess, and
    `PostgresTerraformInventoryStore` records runs.
  - **Two renderings of the variables exist deliberately.** `renderTfvars` produces what goes on
    disk, password included; `describeTfvars` produces what may be logged, spanned or stored. One
    function with a `redact` flag would mean one wrong argument leaks a password into a log line;
    two functions mean the logging paths can only reach the redacted one.
  - The variable file is written `0600` and the working directory is discarded after every run,
    successful or not. Leaving a password on disk for the next operator to find is the avoidable
    half of that exposure.
  - **`apply` is always given the saved plan file.** That is what makes the gate binding rather
    than advisory: `terraform apply` with no plan computes a fresh one, so a gate that inspected a
    previous plan would be inspecting a document that is not what executes. A test asserts the
    argument is present, and another asserts `apply` throws rather than running when handed a
    refused verdict — a caller reaching that point has bypassed the gate, which is a programming
    error and deserves to fail loudly.
  - `TF_LOG`, `TF_LOG_PATH` and `TF_LOG_PROVIDER` are **deleted** from every child environment
    rather than merely not set. `TF_LOG` prints resource attribute values, so inheriting it from
    an operator's shell would defeat every redaction in the package. A test sets it and asserts
    the child never sees it.
  - Diagnostics are redacted before the write, not on read: a value that reaches a log, a span or
    a column has already escaped. Redaction also covers a truncated prefix, because Terraform
    elides long values in messages and an exact-match-only redactor would leave the head of a
    password in place.
  - A run that produced no machine-readable output still reports something: a bounded, redacted
    head of the raw text. "No diagnostics" for a run that plainly failed is the wrong answer.
  - **Fencing is enforced in the store**, which is where the guarantee the schema could not
    express actually lives. A worker whose lease has been taken cannot record a run or complete
    one; the check and the insert share a transaction, so a refusal leaves no partial row for
    `getTask` to find. The absence of a lease is deliberately _not_ an error — a workflow that
    completed has handed the instance back, and a refresh recorded afterwards is legitimate.
  - A second completion is refused, so the first outcome stands. A retry that overwrote it would
    lose the failure a later investigation depends on.
- Tested against a **scripted fake Terraform binary** rather than a mocked module. The properties
  that matter are about the process — which arguments were passed, what the child's environment
  held, whether the saved plan was used — and mocking `spawn` would let all three be wrong while
  the tests passed. The fake records every invocation to a file, so the assertions read what the
  runner actually executed.
- Verification:

  | Gate                                                  | Result                                                       |
  | ----------------------------------------------------- | ------------------------------------------------------------ |
  | `npx nx test provider-adapters`                       | 9 files, **100 tests** — was 81; nineteen runner cases added |
  | `pnpm run test:integration`                           | 7 files, **122 tests** — was 108; fourteen store cases added |
  | `pnpm run format:check`, `lint`, `typecheck`, `build` | clean; 14 projects each                                      |

- Deferred with a reason: the Kubernetes Job executor. The runner records an
  `executor_reference` and `getTask` polls the run row rather than a process, so the Job variant
  is a change of executor behind an interface that already exists. Building it before the adapter
  works end to end would be building a deployment concern against an untested contract.

- Superseded required work: Terraform execution as a tracked run — the `terraform.runs` row written **before**
  the process starts (SAFE-014) and `getTask` reading it (SAFE-015); fencing token honoured;
  diagnostics redacted; `TF_LOG` explicitly removed from the child environment because it prints
  resource attributes.
- Verification required: golden tfvars tests; a test proving neither rendered tfvars nor
  diagnostics carries password or key material; an integration test that kills a runner mid-apply
  and proves the advisory lock releases and the run is resumable.

### Checkpoint T-10 — Adapter, read path

- Status: Complete
- Evidence recorded 2026-09-14:
  - `TerraformProxmoxProvider` implements `getCapabilities`, `validateProfile`, `getTask` and
    `observeInstance`. It opens no HTTP connection to Proxmox at all — every observation goes
    through Terraform, which holds the credentials.
  - `getCapabilities` is `async` and cheap, learned from T-3, and reports **`snapshots: false`**.
    bpg publishes no snapshot resource and no snapshot data source, so claiming the capability
    would be advertising work this adapter cannot do; snapshots are served by the narrowed direct
    client instead.
  - `observeInstance` uses `apply -refresh-only`, which writes to state and never to Proxmox.
    That is what makes observation safe to run against a live instance, including during
    reconciliation where SAFE-029 forbids repairing anything.
  - **The classifications are what the tests are about**, because each decides what a workflow
    does next. A refused plan reports a _permanent_ failure rather than `running`: the gate will
    refuse again for the same reason, so reporting it as still running would leave the workflow
    polling forever. A reference the adapter cannot find reports `UNKNOWN` rather than `FAILED`,
    because guessing "failed" for a reference that may simply not be committed yet would abandon
    a live instance. An unreachable state backend raises a retryable transport error rather than
    reporting absence — reporting "the instance does not exist" because the backend was down is
    how a reconciler comes to believe a live VM is gone.
  - The run record is read through a `TerraformRunReader` interface this package declares, not by
    importing `postgres-adapter`. Both are adapters, and one importing the other would make the
    provider unusable without a database; the composition root supplies the implementation.
  - The working directory is discarded in a `finally`, including when the read throws, because it
    holds a variable file with the cloud-init password in it.
- **The shared-code decision changed, and the reason is worth recording.** The plan was to extract
  the ownership and allowlist code into a neutral module. Two attempts at that mechanical
  extraction mis-bounded function bodies in a 1,400-line file that is the only code here able to
  affect real hardware, and both were reverted to a green suite. The symbols are now **exported
  in place** from the direct adapter instead. Sharing one implementation is the safety property
  worth having; which file it lives in is tidiness. Exporting in place buys the first with none of
  the risk, and a later move can be done by hand with the suite as its proof. A comment above them
  says so, and says not to make them private again.
- Scope recorded honestly: **`provider.factory.ts` does not yet accept `PROVIDER_ADAPTER=terraform`.**
  `createProvider` returns the intersection of all six narrowed ports, and this adapter implements
  four methods of seventeen. Wiring it now would mean either widening the factory's return type —
  which would let a partially-implemented adapter be selected in production — or stubbing the
  missing methods, which is a lie the type system would then stop catching. The factory value
  lands with the create path.
- Verification:

  | Gate                                                        | Result                                                                |
  | ----------------------------------------------------------- | --------------------------------------------------------------------- |
  | `npx nx test provider-adapters`                             | 10 files, **120 tests** — was 100; twenty adapter cases added         |
  | The direct adapter's suite after the export-in-place change | 100 of 100, unchanged — the evidence the sharing altered no behaviour |
  | `pnpm run test:integration`                                 | 122 tests                                                             |
  | `pnpm run format:check`, `lint`, `typecheck`, `build`       | clean; 14 projects each                                               |

- Superseded required work: `TerraformProxmoxProvider` selected by `PROVIDER_ADAPTER=terraform` as a third
  value, with the default still `fake` and failing closed. `getCapabilities`, `validateProfile`,
  `getTask`, `observeInstance` via `plan -refresh-only -json`. The VMID clamp, context and
  ownership assertions, marker encode/decode and disk parsing are **extracted and shared**, not
  duplicated — one implementation of the safety code.
- Verification required: factory tests proving the `fake` default is preserved, `terraform` is
  accepted, an unknown value is rejected, and each missing setting refuses to start.

### Checkpoint T-11 — Create, end to end, one request — **In progress**

- Status: In progress
- Progress recorded 2026-09-14 — the adapter's create path:
  - `submitCreateInstance` renders the variables, gates the plan, records the run, and **returns
    before the apply finishes**. The port's contract is submit-then-poll, and that is not a
    formality: a clone plus cloud-init takes tens of seconds, and holding a gRPC call open for it
    would tie the workflow's liveness to a network connection. A test asserts the apply is still
    running when the caller is answered.
  - **The ordering is the safety property.** The run row is durable before the process starts
    (SAFE-014), so a worker that dies mid-apply leaves a reference a new worker can poll
    (SAFE-015) rather than a gap that invites a second apply against the same instance. A test
    asserts the recorded run id is the reference handed back.
  - The VMID is derived deterministically from the instance id rather than allocated, so a replay
    computes the same id and recognises its own earlier work instead of building a second VM.
    Never `/cluster/nextid`, which could hand back an id outside the reservation.
  - A refused plan is **recorded** and not merely returned. A run row that never appeared would
    look like nothing was attempted, and the refusal is exactly what an operator needs to see.
  - Every path in the background task ends in `completeRun`, including the `catch`. A background
    task that threw without recording anything would leave the workflow polling forever. The
    failure is recorded as `unknown` rather than `failed`, because the apply may have acted
    before it failed and SAFE-018 forbids guessing.
  - A workspace is marked `in_sync` only after a _successful_ apply. A failed one can leave state
    holding a value the provider rejected, so nothing may treat it as in sync until a refresh has
    run.
- Verification so far:

  | Gate                                                  | Result                                                         |
  | ----------------------------------------------------- | -------------------------------------------------------------- |
  | `npx nx test provider-adapters`                       | 10 files, **130 tests** — was 120; ten create-path cases added |
  | `pnpm run format:check`, `lint`, `typecheck`, `build` | clean; 14 projects each                                        |

- Progress recorded 2026-09-14 — convergence, power, and the factory:
  - `applyInstanceConfiguration` became the **convergence assertion** the design called for.
    Terraform does clone and configure in one apply, so nothing is left to write by the time that
    stage runs — and the stage vocabulary is persisted state shared across capabilities, so
    collapsing it was not an option. A stage that previously performed a blind second write now
    proves the instance matches its declared configuration, and a non-empty plan fails it
    honestly.
  - **A declarative provider needs the whole desired state for every mutation, and the port does
    not carry it.** A power request hands the adapter an instance id and its ownership markers,
    which is all an imperative provider needs; omit an attribute from a Terraform apply and it
    plans to _clear_ it. Terraform's own state is where the rest comes from, which is the deeper
    reason `observeInstance` reads it too. `tfvarsFromState` reconstructs the variables, and
    every allowlisted value — node, storage, bridge, MTU, the cloud-init password — is taken from
    configuration rather than from state, so a state document someone edited cannot widen the
    boundary or move the instance to another node.
  - `startInstance` reports success without applying when the instance is already in the
    requested state, so a duplicate delivery does not produce a second run row for work nobody
    did.
  - `provider.factory.ts` now accepts `PROVIDER_ADAPTER=terraform`. The default is still `fake`
    and the unknown-value message names all three. Five new settings are mandatory with no
    defaults, and a case omitting each in turn proves each refuses to start: a default binary
    path, module path or state connection string would let a partially-configured process act on
    the wrong machine or write to the wrong state.
  - `apps/proxmox-provider` now depends on `postgres-adapter`, which the layer rule permits
    (`visibility:production`) and `pnpm lint` confirms. Project references synced.
- Verification so far:

  | Gate                                                  | Result                                                   |
  | ----------------------------------------------------- | -------------------------------------------------------- |
  | `npx nx test provider-adapters`                       | 130 tests                                                |
  | `npx nx test proxmox-provider`                        | 2 files, **17 tests** — was 12; five factory cases added |
  | `pnpm run test:integration`                           | 122 tests                                                |
  | `pnpm run format:check`, `lint`, `typecheck`, `build` | clean; 14 projects each                                  |

- Progress recorded 2026-09-14 — **the provider half of the create path is verified live**:
  - `tools/verification/verify-terraform-adapter.mjs` (`pnpm run verify:terraform-adapter`) drives
    the adapter against the real server and reports **14 of 14 checks passing**, twice in a row
    from a clean interval. Evidence: `docs/verification/evidence/terraform-adapter.json`.
  - What it proves, in order: the reserved interval is clear before anything starts;
    `validateProfile` initialises the module and the `pg` backend and plans exactly one create;
    `submitCreateInstance` returns `ACCEPTED` with a run reference; the run row exists before the
    apply settles; the task polls to `SUCCEEDED`; the gate allowed a create and nothing else; the
    VM on the server carries the right cores, memory, bridge, **MTU 1400**, `ipconfig0`,
    nameserver and 32 GiB disk; the ownership marker round-tripped and parses back to this
    instance; `observeInstance` reports it exists with ownership proven;
    `applyInstanceConfiguration` finds the workspace converged **from a fresh create**; the
    workspace inventory records `in_sync` with an apply timestamp; no secret reached
    `terraform.runs.diagnostics`; and the teardown leaves the interval empty.
  - The convergence check passing from a _fresh_ create is the one that matters most. T-4's
    addendum recorded that an incrementally-repaired workspace proves only that config and server
    agree, not that the config can build a correct VM from nothing. This run starts from nothing.

#### Three defects the live run found

1. **The `pg` backend requires TLS where the application's driver does not.** `terraform init`
   failed with `pq: SSL is not enabled on the server` against a connection string that works
   perfectly for the application: lib/pq defaults TLS on, node-postgres defaults it off. The
   runner now **refuses to construct** without an explicit `sslmode`, because the silent fix
   would have been for the runner to append `sslmode=disable` itself — a decision about transport
   security for a database holding credentials, made in the wrong place. `TERRAFORM_STATE_CONN_STR`
   is a separate setting from `DATABASE_URL` for exactly this reason.
2. **A transient clone failure was classified as permanent.** A run started seconds after the
   previous run's destroy failed with `Error: VM clone / All attempts fail` — the template was
   still locked by the preceding operation — and an identical re-run succeeded. `getTask` reported
   that as `FAILURE_CATEGORY_PERMANENT`, which would have failed an instance that would have
   worked a moment later. It now inspects the diagnostics for a narrow set of retryable
   conditions and reports `TRANSIENT`, with a case asserting a genuine misconfiguration still
   reports permanent. The patterns are deliberately narrow: a broad one would retry a real fault
   forever, which is worse than failing it once.
   Worth stating as a limitation rather than hiding: Terraform flattens the provider's structured
   error into a diagnostic string, so a text match is the only signal available by then. That is a
   real cost of routing through Terraform.
3. **The verifier's own reporter could disagree with itself.** A check returning a field named
   `status` overwrote its verdict, so a passing check rendered as failed while still counting as
   passed. The verdict is now written after the detail. A reporter that can contradict its own
   summary is worse than a terse one.

- Two earlier partial runs left VMs 910017 and 910097 on the server. Both were destroyed
  deliberately, by VMID, after their ownership markers were read and checked — marker prefix,
  `managedBy` and `environment` all had to match or the VM would have been reported and left
  alone. Recorded here because tier 3 of the abort story says a manual destroy is written down.
- Verification:

  | Gate                                                  | Result                                                  |
  | ----------------------------------------------------- | ------------------------------------------------------- |
  | `pnpm run verify:terraform-adapter`                   | **14 of 14** checks, twice consecutively                |
  | Server state afterwards                               | 211 VMs, **0** inside the reserved interval             |
  | Secret scan of the evidence file                      | 0 occurrences of the token secret or the password       |
  | `npx nx test provider-adapters`                       | **132 tests** — was 130; two classification cases added |
  | `pnpm run format:check`, `lint`, `typecheck`, `build` | clean; 14 projects each                                 |
  | `pnpm run terraform:check-modules`                    | modules agree                                           |

- Progress recorded 2026-09-14 — **the layers above the provider, against real hardware**:
  - `deploy/local/compose.terraform.yaml` points the Phase 4 stack's provider at the real server,
    and `tools/docker/service.Dockerfile` gained a `terraform-runtime` target carrying the engine
    and a provider mirror vendored at build time from the module's own committed lock file. The
    image initialises and validates the module with `--network none`, which is the proof that the
    vendoring is complete and the runtime needs no registry.
  - `tools/verification/verify-terraform-runtime.mjs` (`pnpm run verify:terraform-runtime`) drives
    **one create request through every layer** and then removes it through the control plane's own
    retention and purge path: REST accept, the replay, the single transactional commit, the outbox
    row, the Kafka record, the orchestrator's leased and fenced claim, the persisted task
    reference, the gated Terraform runs, the VM on the server, the ownership marker, the read
    projection, the restricted-operational view, the inventory, and a redaction scan across
    container logs, run diagnostics, the outbox and the audit trail.
  - Nothing in it reaches into a layer to make the next one work. Where a precondition had to be
    arranged, it is a named check with its own reasoning — see the two deviations below.

#### Nine defects the full-stack run found

The provider half had passed 22 of 22 in-process. Every one of these was invisible to that run,
and that is the finding worth keeping: **an adapter exercised only in-process drifts from the one
the wire delivers to.**

1. **The fencing token was a constant.** The adapter passed `context.attempt` as its fencing
   token, and the workflow pins `attempt` to `1` on purpose so that `requestId` stays
   byte-identical across replays. So the inventory's fencing check compared a constant against a
   real lease token — it was not a check at all, and it failed outright the moment a workflow
   reached its second claim. `ProviderCallContext` gained a `fencing_token` field, the workflow
   populates it from the claim, and the fake provider excludes it from the idempotency comparison
   because a token that must change when the lease moves is not part of a request's intent.
2. **Four power methods read the wrong object.** `StartInstanceRequest` and its three siblings
   nest their payload under a `request` field. The Terraform adapter declared the _inner_ type and
   read `context` straight off it — and TypeScript allowed it, because method parameters are
   bivariant. It compiled, it passed unit tests written against the same wrong shape, and it
   passed an in-process verifier that happened to call with the unwrapped object. Over gRPC
   `context` was `undefined` and a create that had already built and configured a VM failed at the
   power stage with "Provider profile is not allowlisted" — a shape mismatch wearing a security
   error's clothes. The direct adapter had it right all along.
3. **The runner relied on an ambient environment.** bpg authenticates with `PROXMOX_VE_*`, which
   are different names from this system's `PROXMOX_*` settings, and the runner simply inherited
   its parent's environment. That worked in every earlier run because the manual walkthrough's
   `env.sh` had exported them into the shell. In a container the plan failed with
   `Missing Proxmox VE API Endpoint`. The runner now takes the credentials explicitly, **refuses
   to construct without them**, and strips every inherited `PROXMOX_VE_*` first so a stale shell
   value cannot decide which server an apply talks to.
4. **The image had no system trust store.** Two TLS clients live in that container and they trust
   from different places: Node bundles its own CA list, so the direct client verified the endpoint
   perfectly, while the provider plugin is a separate Go binary reading `/etc/ssl/certs` — which
   the base image does not have. A clone failed with `x509: certificate signed by unknown
authority` against a publicly trusted certificate, in an image where the other client had just
   verified it. The fix for a trust-store gap is a trust store, not `PROXMOX_VE_INSECURE`.
5. **A malformed SSH key became a retryable provider failure.** Proxmox validates keys server-side
   and answers a bad one with an HTTP **500**, which any sane classifier reads as "the server had
   a problem, retry" — so a tenant pasting a truncated key burned the workflow's retry budget and
   ended in review, for input that could never have worked. `validateCreateInstance` now checks
   structure at admission: an SSH public key's body names its own algorithm, length-prefixed, so
   `ssh-ed25519` plus a run of `A`s is detectable with no provider call at all.
6. **The provider deadline turned "slow" into "unknown".** The base stack allows a provider call
   ten seconds, which is right for an adapter that answers from one HTTP request. Two calls here
   run Terraform synchronously and take about ten seconds on an idle server, or up to three
   minutes more waiting on the state lock. A mutation whose transport deadline expires has an
   _unknown_ outcome and goes to `manual_review` by design — so a deadline set too low does not
   merely fail a call, it converts "slow but fine" into "a human must look at this". The run that
   exposed it left a **running, correctly configured VM** the control plane had lost track of.
   The deadline is now 300 seconds, ordered deliberately above the runner's own 240-second
   invocation timeout so a stuck invocation yields a recorded run with diagnostics rather than an
   ambiguous timeout.
7. **A failed provider operation recorded no reason anywhere.** The provider logged
   `outcome: "failed"` and nothing else; the reason crossed gRPC and the orchestrator replaced it
   with a generic workflow message before persisting. The first hardware failure was therefore
   undiagnosable from the logs, the workflow row, or the operation. The operation log now carries
   the transport code and the adapter's own message — exactly what `rpcError` already sends across
   the boundary — while an unrecognised error contributes its constructor name only.
8. **Two inventory columns were never written.** `state_serial` and `state_lineage` existed in the
   schema and in the store, and no caller ever supplied them. They are how a replaced state
   document is detected: the lineage identifies the _file_, so a lineage that changes under a
   workspace means the state was restored, re-created, or pointed elsewhere — precisely when
   Terraform's belief about the world is confidently wrong. A dedicated `stateMetadata` invocation
   now reads both after every apply and refresh, and it is the one invocation whose output is
   never retained: `terraform state pull` emits the whole document, including the rendered
   cloud-init password.
9. **Redaction mangled the ownership marker.** Adding the API token to the redaction set redacted
   the eight characters `control-` everywhere they appeared, because the redactor also replaces
   each secret's leading prefix so a truncated value is still caught. Handing it a _container_
   turns that rule against you. The set now holds secret material only — the password extracted
   from the connection string, the secret half of the token — so what stays readable is exactly
   what an operator needs to fix a failed authentication: the host, the database, the user and the
   token id, all identities, none of them credentials.

#### Deviation recorded — the purge guard and the clock

The purge guard requires the retention deadline to have passed, and the shortest window the schema
permits is one hour (`retention_hours >= 1`). No configuration makes a purge reachable inside a
single run, so the verifier moves the deadline the application stamped into the past — which is
precisely what waiting would do.

It does **not** set `purge_eligible`, which would switch the guard off. Every check still runs for
real: the confirmation must match the instance id, the instance must be retained, the deadline is
still compared, and the workflow still proves live provider ownership from the VM's own description
immediately before destroying anything. A mismatched confirmation is asserted to be refused at
acceptance, before any provider call.

#### Deviation recorded — clearing the lab's own leftovers

A failed create holds an instance row, an IPv4 lease and a slice of the project's quota — correctly,
because the quota counts committed intent rather than built hardware. The lab quota is deliberately
three instances and three addresses (SAFE-030), so three finished runs exhaust it and the next run
is refused at acceptance before it can test anything. Quarantined leases are the subtler half: they
are held back on purpose after a failed release, because a VM might still be using the address.

The verifier therefore clears terminal-state rows and releases their addresses as a precondition —
and **the guard is the empty reserved interval, not the row**. It refuses to touch anything unless
the live server shows no VM in 910000-910099, because every instance in this project can only ever
have had a VM inside it: if the interval is empty, no address is in use and no row is the last
record of a live machine. An earlier version also skipped instances that had a Terraform workspace
row, reasoning that Terraform still tracked them; that was wrong, because a workspace row records
that Terraform _once_ tracked an instance and every failed run leaves one.

#### Recorded manual destroys

Runs that failed after building a VM left 910033, 910054 and 910083 on the server. Each was removed
deliberately, by VMID, after reading its description and checking the marker prefix, `managedBy`
and `environment`. 910054 was still running and Proxmox refused the destroy until it was stopped —
the API doing the right thing. Written down because tier 3 of the abort story says a manual destroy
is recorded.

One procedural note kept rather than tidied away: on one of those cleanups the ownership read timed
out and the destroy had been chained to run unconditionally, so it executed without the proof
having succeeded. No foreign VM could have been affected — the VMID was constant and read earlier
in the session, and the scoped token can address nothing outside the reserved interval — but the
procedure was wrong. The runbook's rule is the right one and it already says so: a manual destroy
is never scripted, and the ownership check gates it rather than merely preceding it.

#### Environment failure, recorded for honesty

Thirteen image rebuilds filled the host disk. The Compose Postgres died mid-run with
`ECONNREFUSED`, the API became unreachable, Kafka's log directory was corrupted while being
written, and the verifier crashed writing its evidence with `ENOSPC` — so a single environment
problem presented as a dozen unrelated defects in the system under test. Worth stating because
"record every outcome, do not fail fast" is only useful if the reader can tell an environment
failure from a finding.

- Rationale: the first full-stack run, and the checkpoint the operator described as observing and
  fixing at every level from the request to the server state.
- Required work: `submitCreateInstance` renders tfvars, gates the plan, applies, records the run;
  `applyInstanceConfiguration` becomes the convergence assertion rather than a second write;
  import-on-resume per design §6.5, never adopting on VMID alone (SAFE-005).

  Then one create request, asserted at every layer, by a new record-all-outcomes verifier
  (`check(name, body)`, the Phase 6 style — a fail-fast run hides the later layers and the later
  layers usually explain the first):

  | Layer         | Asserted                                                                                           |
  | ------------- | -------------------------------------------------------------------------------------------------- |
  | Configuration | every `PROXMOX_*` equals the seeded profile and network row                                        |
  | REST accept   | 202 with `operationId`/`targetId`/`statusUrl`; the same key again replays                          |
  | Database      | instance, operation, IPv4 lease and audit row in one commit (SAFE-011)                             |
  | Outbox        | one row on `provisioning.commands.v1`                                                              |
  | Kafka         | one record, correct headers, partition key is the instance id                                      |
  | Orchestrator  | workflow claimed with a lease and fencing token, one command receipt                               |
  | Provider      | task reference persisted **before** polling began (SAFE-014)                                       |
  | Terraform run | run rows with `gate_decision` allowed and plan actions `{create:1,delete:0}`                       |
  | Proxmox       | read-only: config, NIC bridge and MTU, `ipconfig0`, DNS, marker parses and matches                 |
  | Guest         | cloud-init applied and the address actually works                                                  |
  | Projection    | readback reports `succeeded`, observed power, the provider resource id                             |
  | Redaction     | no password, key or token in any log, event, run diagnostic, response, or the evidence file itself |

- Verification required: the verifier green, with each failing layer fixed and re-run before
  moving on. Expect real defects: the equivalent Phase 6 exercise found eight.

### Checkpoints T-12 to T-15 — The remaining capabilities

- Status: Complete
- Completed 2026-09-14. All four capabilities are implemented and verified against the live
  server in one run: **22 of 22 checks passing**, with the whole seventeen-method port
  implemented. Evidence: `docs/verification/evidence/terraform-adapter.json`.
- **T-12 Power — through Terraform, except the two operations it cannot express.**
  `startInstance` and `shutdownInstance` set `started` and converge, measured at roughly 35
  seconds each. A hard stop and a reboot go to the direct client, because `started = false` is a
  _graceful_ shutdown: conflating the two would mean a caller asking for one and silently getting
  the other. A redundant start reports success without applying, so a duplicate delivery does not
  produce a run row for work nobody did.
- **T-13 Resize — grow only, refused at admission.** CPU, memory and disk growth converge in
  place. A shrink is refused **before** anything is written, which the live run found to matter
  more than expected: an earlier refusal at apply time left the rejected size in Terraform state
  while the server kept the real one, so the inventory would have reported a disk the server never
  had. The mandatory-refresh rule was extended from "after a direct mutation" to "after any failed
  apply" as a result.
- **T-14 Snapshots — entirely the direct client, and honestly reported as unavailable here.** bpg
  publishes no snapshot resource and no data source, so all four operations are direct API calls,
  each followed by `apply -refresh-only`. A rollback additionally marks the workspace `drifted`
  until a refresh proves otherwise, because it reverts disk and configuration wholesale with
  Terraform learning nothing about it. On **this** server snapshots are impossible: template 110's
  disk is `raw` on directory storage, which snapshots qcow2 only. The verifier therefore asserts
  the capability flag _matches the storage_ rather than asserting snapshots work — a check that
  passes today and will keep passing after the template is rebuilt, when it will begin asserting
  the opposite branch.
- **T-15 Retention and purge — the one authorized destroy.** Retention sets `on_boot = false`,
  `started = false` and appends a retention trailer to the description, leaving the VM and its
  disk intact. Purge uses a sibling module identical to the production one except for its
  `lifecycle` block, because `prevent_destroy` cannot be parameterised — a check fails the build
  if the two modules diverge anywhere else. It refuses without an authorization id, proves
  ownership from the **live VM's description** rather than from state, and passes `allowDestroyOf`
  naming that single resource address so the gate permits exactly one delete and nothing else.

#### Three defects these capabilities found

1. **All operations on one instance shared a working directory.** The directory was
   `workingRoot/instance-<uuid>`, so a background apply's cleanup deleted a directory another
   operation was actively using. Directories are now unique per run and `discard` takes the path
   it was given and refuses anything outside the working root. The class of bug matters more than
   the instance: a cleanup that can remove another operation's workspace is a cleanup that can
   destroy in-flight work.
2. **No command carried `-lock-timeout`.** Terraform's default is to fail _immediately_ on lock
   contention, and two things legitimately overlap on one instance — a submit whose apply
   continues in the background, and the refresh a direct mutation schedules. Every init, plan,
   apply and refresh now waits 180 seconds.
3. **`validateProfile` leaked a workspace row per call.** Validation ran a real `init` and `plan`,
   which created a row in `terraform_remote_state.states` for a throwaway workspace — and
   validation is called on every profile check. It now runs `init -backend=false` followed by
   `terraform validate`, which needs no state at all. `terraform plan` refuses without an
   initialised backend, which is why this was not obvious.

- One further live finding, recorded because it cost an afternoon: **bpg ignores `file_format` on
  a clone.** Declaring `qcow2` to enable snapshots produced a disk that stayed `raw`, and the
  permanent mismatch between declared and actual made _every_ subsequent plan a replacement —
  which the gate correctly refused, blocking all further work on that instance. Reverted to `raw`
  and recorded as an environmental limitation with a template rebuild as the fix.
- Verification:

  | Gate                                | Result                                                                                                             |
  | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
  | `pnpm run verify:terraform-adapter` | **22 of 22** checks                                                                                                |
  | Server state afterwards             | 212 VMs, **0** inside the reserved interval                                                                        |
  | Secret scan of the evidence file    | 0 occurrences of the token secret, the cloud-init password, or the key                                             |
  | `npx nx test provider-adapters`     | 12 files, **165 tests** — was 132                                                                                  |
  | `pnpm run test:integration`         | 122 tests                                                                                                          |
  | Full quality gate                   | `contracts:validate`, `docs:validate`, `format:check`, `lint`, `typecheck`, `test`, `build` all clean; 14 projects |
  | `pnpm run terraform:check-modules`  | modules differ only in header and `lifecycle`                                                                      |

#### Deviation recorded — the precondition retry

A run scored 21 of 22 with its only failure being `fetch failed` on the `reserved-range-is-clear`
**precondition**. That check is an assertion _about_ the server, not an operation on it, and a
dropped packet is not a finding — but it invalidated an otherwise complete result. The read-only
probe now retries transport failures three times with a backoff. HTTP status codes are **not**
retried: a 403 or a 500 is an answer, and retrying an answer would hide it.

### Checkpoint T-16 — Drift and reconciliation

- Status: Pending
- Required work: `observeInstance` via `-refresh-only` feeding the reconciler.
- Verification required: introduce real drift on the server by hand and prove the control plane
  reports it and does not repair it (SAFE-029). Also provoke a replace plan deliberately and prove
  the gate refuses it, the workflow lands in `manual_review`, and the VM is untouched.

### Checkpoint T-17 — Closure

- Status: Pending
- Required work: full quality gate; a call-map document modelled on
  `docs/architecture/proxmox-create-call-map.md`; a run-recovery runbook covering a stuck lock, a
  refused plan, an orphan VM, state disagreeing with reality, and credential rotation; Mermaid
  sources each with a rendered SVG registered in `docs/diagrams/README.md`; README and metric
  catalog; the design document reconciled against what was actually built.

## Rollback and abort

No automatic destructive path exists and none may be added. Against real hardware the tiers are,
in order of preference:

1. **Leave it.** A half-created VM inside the reserved range carrying correct ownership markers is
   a resumable state, not a broken one — re-running the workflow imports it. Record the VMID and
   workspace in this file.
2. **Quarantine.** A VM at an expected VMID whose markers do **not** match is never adopted
   (SAFE-005). Record it in a deviation block and exclude the VMID so no later run reuses it. The
   in-band equivalent is the workflow's own `manual_review` terminal state.
3. **Deliberate operator destroy.** By a human, with the VMID typed by hand, only after this file
   records the pre-destroy ownership evidence. Never from a tool, never in a `finally`.

A refused plan is the _designed_ abort: the run records the refusal, the workflow goes to
`manual_review`, nothing was applied. A killed runner needs no action — the `pg` backend's
advisory lock self-releases when the session dies, which is why it deliberately has no
`force-unlock`. Divergence between state and reality is repaired only with `apply -refresh-only`,
which writes to state and not to Proxmox.

Explicitly forbidden as rollback: `terraform destroy` from any tool, `terraform apply -replace=`,
`-auto-approve` on a plan the gate did not clear, and `terraform force-unlock`.

## Resume Instructions

1. Read this file and `git status --short` before changing anything.
2. Continue only the checkpoint marked `In progress`.
3. Update this file with implementation and verification evidence before committing that
   checkpoint.
4. Record the commit hash, mark the checkpoint complete, and move `Current checkpoint` to the next
   pending item.
5. Never let a credential or a Terraform state file reach git history, and never add an automated
   path that destroys a provider resource. This server hosts 211 machines belonging to other
   people; ownership must be proven before any destructive call, and proven again by a human
   before any manual one.
