# Running the customer console

## Bring the stack up

The console is a Compose overlay, in the same style as the Terraform one: the base stack stays
buildable with no credentials, and every value the overlay needs is `${VAR:?}` so a misconfigured
stack fails loudly rather than starting a console nobody can sign in to.

```bash
pnpm run terraform:compose-env    # writes the gitignored env file from the credentials
pnpm run console:demo-user        # adds the demo user; prints the password once

docker compose --env-file deploy/local/.env.terraform \
  -f deploy/local/compose.phase4.yaml \
  -f deploy/local/compose.terraform.yaml \
  -f deploy/local/compose.console.yaml up -d --build
```

Then open **http://localhost:3102**.

`pnpm run console:demo-user` prints the password exactly once and stores only its scrypt hash, so
keep it or re-run the command to mint a new one. The identity stub reads its users at startup, so
after minting a new password recreate it:

```bash
docker compose --env-file deploy/local/.env.terraform \
  -f deploy/local/compose.phase4.yaml -f deploy/local/compose.terraform.yaml \
  -f deploy/local/compose.console.yaml up -d --force-recreate local-oidc
```

## The demo account

| Field | Value |
| --- | --- |
| Sign-in | http://localhost:3102/login |
| Username | `demo@testsrv.lab` |
| Password | printed once by `pnpm run console:demo-user` |
| Role | `tenant_developer` |
| Project | `00000000-0000-4000-8000-0000000000a1` (`testsrv-lab`) |

`testsrv-lab` is the project bound to the `proxmox-testsrv` provider profile, which reaches the
real server. Its quota is deliberately small — **three instances, three addresses, eight
snapshots** — so a runaway loop exhausts the quota long before it exhausts the reserved VMID
interval. The create wizard caps its server count at the remaining headroom for the same reason.

## Two things that will bite

**Choose the image explicitly.** The catalog endpoints are not scoped to the deployment's active
provider, so they list every enabled image and network — including the fake project's. The wizard
shows each image's provider profile and filters the network list to match it, but the default is
whichever image the API returns first. On this stack, pick **Ubuntu Noble 24.04**
(`proxmox-testsrv`); the other belongs to the fake adapter and the provider will refuse it as not
allowlisted.

**Actions take about a minute each.** Every mutation is a Terraform apply against a real server —
init, plan, apply, observe. The console shows the row immediately in a provisioning state and fills
in as it converges, which is what the control plane actually does, but a power change or a rescale
is 60 to 90 seconds rather than instant.

## When configuration drifts

`pnpm run proxmox:check-config` compares the provider's environment against the catalog in the
database and names any disagreement. It is worth running whenever something is inexplicably
refused: a stale container carrying the previous template VMID looks exactly like a broken
provider, and this reports it as
`profile.image_source_reference (template): environment '110' vs catalog '9100'`.

Recreate a service after regenerating the environment, because Compose does not restart a container
for an env-file change it cannot see:

```bash
docker compose --env-file deploy/local/.env.terraform \
  -f deploy/local/compose.phase4.yaml -f deploy/local/compose.terraform.yaml \
  -f deploy/local/compose.console.yaml up -d --force-recreate proxmox-provider
```

## Verification

```bash
pnpm run verify:console              # the browser suite, against real hardware
pnpm run verify:console --list       # names the checks, changes nothing
pnpm run verify:console --only=<name>
pnpm run verify:console --keep       # leaves the created server in place
```

It drives Chrome against the running stack, writes
`docs/verification/evidence/console-runtime.json`, and leaves screenshots beside it. It creates and
destroys a real VM in the reserved interval, and clears the project first — guarded on the interval
being empty, because every instance in this project can only ever have had a VM inside it.

Known flakiness, stated rather than hidden: the checks that exercise power, rescale and snapshots
are sequenced against a three-instance quota on real hardware, and a run interrupted partway leaves
state that the next run's preconditions have to clear. The operations journal is the more reliable
witness for those three — `projection.operations` records each as `succeeded` — and the suite's
sequencing is the part still being tightened.
