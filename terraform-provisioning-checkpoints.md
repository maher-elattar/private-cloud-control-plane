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

- Overall status: In progress
- Current checkpoint: T-2 — Manual Terraform walkthrough against the live server
- Last completed checkpoint: T-1 — Server survey
- Phase 6 dependency: cleared. Phase 6 closed with all fifteen checkpoints complete.
- Target server: `https://testsrv.mosalam.com:8006`, node `proxtest`, PVE 9.2.11, standalone.
- Committed so far: `726bc22` (gitignore and credential boundary), `167871f` (plan scoped to one
  server, VPC work deferred).
- **Credential note.** The supplied credentials are `root@pam` plus a password. They were read
  into a session transcript in the course of this work, so that password should be rotated once a
  scoped API token exists. A token is required regardless — see the T-1 findings.

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

### Checkpoint T-2 — Manual Terraform walkthrough — **In progress**

- Status: In progress
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
- Verification required: the server left with no VM inside 910000–910099; every design claim
  either confirmed or corrected in the design document; plan fixtures captured.

### Checkpoint T-3 — Readiness probe defect

- Status: Pending
- Rationale: blocks every live checkpoint from T-9 onward. Under any adapter whose
  `getCapabilities` throws synchronously the provider container never becomes healthy, and
  `provisioning-orchestrator` declares `depends_on: service_healthy`, so the orchestrator never
  starts and no request can reach the provider.
- Required work: make the readiness probe resilient to a synchronously-throwing adapter, and give
  `getCapabilities` a readiness path that does not fail the profile assertion. Also correct the
  stale `resizeCompute` / `growDisk` / `snapshots` / `retentionMarker` / `purge` capability flags,
  which report `false` for five capabilities Phase 5 implemented.
- Verification required: a unit test asserting the probe answers 503, not 500, under a
  synchronously-throwing provider double; `PROVIDER_ADAPTER=proxmox` reaching healthy in Compose.

### Checkpoint T-4 — Scoped API token

- Status: Pending
- Rationale: the direct adapter authenticates only with `PVEAPIToken`, so the supplied root
  password cannot drive the six operations that must stay on the direct API. `root@pam` also
  grants far more than this work needs on a server hosting 211 other machines.
- Required work: a token carrying only the VM lifecycle and datastore privileges the work uses,
  scoped to one pool; the credentials file restructured; the root password retired from tooling.
- Verification required: the token reads `/version`; a path outside its scope returns 403 — a
  boundary proven rather than promised.

### Checkpoint T-5 — Ownership-marker defect

- Status: Pending
- Rationale: `markInstanceRetained` writes the description as
  `private-cloud-control:{…}\nretained-until=…`, but `parseOwnership` runs `JSON.parse` over the
  whole remainder after the prefix, which is invalid JSON once that second line exists. It returns
  `null`, `markersMatch` fails, and `requireOwnedConfig` throws. **After a soft delete,
  administrative purge can never prove live ownership (SAFE-006) and observation reports an
  ownership mismatch that reconciliation will read as drift.** Create, power and resize are
  unaffected.
- Required work: parse only the marker line and tolerate following lines. **Not** by folding
  `retained-until` into the JSON, which would change the marker format and make every
  already-retained VM unparseable. Fixed in shared code, since the Terraform adapter inherits the
  same scheme.
- Verification required: a round-trip test through the retention description shape that fails
  against current code and passes after; plus trailing whitespace and operator-appended text.

### Checkpoint T-6 — Catalog rows, configuration, and the config cross-check

- Status: Pending
- Required work:
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

- Status: Pending
- Required work: migration `0008_terraform_inventory.sql` for `terraform.workspaces` and
  `terraform.runs` per design §5.3, plus the `terraform_remote_state` schema and the grants of
  §5.2 — the runner role writes, the application role reads `states` only. Because the `pg`
  backend creates its own table, the migration creates the schema and default privileges so the
  later table inherits them.
- Safety note: migrations are forward-only and `tools/db/migrate.mjs` refuses a changed checksum.
  An aborted attempt is recovered with a new migration, never by editing `0008`.
- Verification required: integration specs for stale-fencing-token rejection, one workspace per
  instance, `drift_summary` holding attribute names and never values, the two-sessions-one-
  workspace advisory-lock race, and the application role being unable to write state.

### Checkpoint T-8 — Module and plan gate

- Status: Pending
- Required work: `deploy/terraform/modules/instance/` promoted from the T-2 exploration with the
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

- Status: Pending
- Required work: Terraform execution as a tracked run — the `terraform.runs` row written **before**
  the process starts (SAFE-014) and `getTask` reading it (SAFE-015); fencing token honoured;
  diagnostics redacted; `TF_LOG` explicitly removed from the child environment because it prints
  resource attributes.
- Verification required: golden tfvars tests; a test proving neither rendered tfvars nor
  diagnostics carries password or key material; an integration test that kills a runner mid-apply
  and proves the advisory lock releases and the run is resumable.

### Checkpoint T-10 — Adapter, read path

- Status: Pending
- Required work: `TerraformProxmoxProvider` selected by `PROVIDER_ADAPTER=terraform` as a third
  value, with the default still `fake` and failing closed. `getCapabilities`, `validateProfile`,
  `getTask`, `observeInstance` via `plan -refresh-only -json`. The VMID clamp, context and
  ownership assertions, marker encode/decode and disk parsing are **extracted and shared**, not
  duplicated — one implementation of the safety code.
- Verification required: factory tests proving the `fake` default is preserved, `terraform` is
  accepted, an unknown value is rejected, and each missing setting refuses to start.

### Checkpoint T-11 — Create, end to end, one request

- Status: Pending
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

- Status: Pending
- One capability per checkpoint, one per commit, each driven through the full stack with the
  verifier extended, matching Phase 5's one-capability-per-change rule.
  - **T-12 Power** — `started` through Terraform; hard stop and reboot stay on the direct API,
    each followed by the mandatory refresh of design §6.4. Compare latency against T-2's
    measurements and be willing to route power to the direct API if Terraform is materially
    slower.
  - **T-13 Resize** — CPU, memory, disk growth. Shrink refused at both layers.
  - **T-14 Snapshots** — entirely direct API, each mutation followed by a refresh so state never
    silently diverges; a rollback leaves `drift_state` marked until a refresh clears it.
  - **T-15 Retention and purge** — soft delete via Terraform; purge as the one authorized destroy
    with `verifying_purge` proving live ownership first. T-5's fix is what makes this reachable.

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
