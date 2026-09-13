# Proxmox Test Server Survey

Read off `testsrv.mosalam.com` on 2026-09-14, before any Terraform work, because several
decisions in [Terraform-Backed Provisioning](../../terraform-provisioning-plan.md) are blocked on
facts that can only be read from the target rather than assumed.

Produced by `pnpm run survey:proxmox` (`tools/verification/survey-proxmox.mjs`). Machine record:
[`evidence/testsrv-survey.json`](evidence/testsrv-survey.json).

**Nothing was mutated.** Every call was a `GET` except the login, which is the one `POST` the
Proxmox API requires to mint a session ticket. There is no code path in the survey tool that
creates, configures, powers, or deletes anything.

## The environment

| Property | Value |
| --- | --- |
| Endpoint | `https://testsrv.mosalam.com:8006` |
| PVE version | 9.2.11 (release 9.2) |
| Node name | **`proxtest`** — note it differs from the DNS name |
| Nodes | 1. Standalone, not a cluster |
| TLS | Let's Encrypt, SANs cover `testsrv.mosalam.com` and `proxtest.mosalam.com`; verification passes against the platform trust store with no CA injection and no `insecure` flag |
| Authenticated as | `root@pam`, capability groups `access, dc, mapping, nodes, sdn, storage, vms` |

## Clone template 110 — `UbuntuNoble24.04`

| Property | Value | Consequence |
| --- | --- | --- |
| `template` | `1` | A genuine template, so a full clone behaves as the design assumes |
| Primary disk | `local:110/base-110-disk-0.raw,discard=on,iothread=1,size=32G,ssd=1` | **Exactly 32 GiB** |
| Storage | `local` | The only storage on this host with `images` content |
| CPU | `cores 2`, `sockets 1`, `vcpus 2` | |
| Memory | `4096` MiB | |
| Guest agent | `agent 1` | `observeInstance` can read guest IPs |
| Cloud-init drive | `ide0 local:110/vm-110-cloudinit.raw,media=cdrom,size=4M` | Present, so inline cloud-init works |
| `net0` | `virtio=BC:24:11:89:33:77,bridge=vmbr1,firewall=1,**mtu=1400**` | Already on the target bridge |
| `ciuser` | `root` | Overridden per instance |
| `nameserver` | `1.1.1.1` | Matches the requested DNS |

**The template matches the seeded `lab-small` flavour exactly** — 2 vCPU, 4096 MiB, 32 GiB. That
matters more than it looks: `assertResources` refuses the create unless the requested disk equals
the template's disk *exactly* (`diskGiB(current) !== String(disk)` → `protocol_error`). Had the
template been 20 GiB or 40 GiB, every create would have failed and a new flavour would have been
required. No flavour change is needed.

**`mtu=1400` must be carried over.** `vmbr1` has no physical ports, so the traffic is routed or
encapsulated by the host and the reduced MTU is deliberate. The existing direct adapter preserves
it by accident — it rewrites only the `bridge=` component of the inherited `net0` and leaves the
rest alone. A Terraform `network_device` block builds the NIC from scratch, so the MTU has to be
set explicitly or guests will get 1500 and fail on anything that cannot fragment.

## Storage

| Storage | Type | Active | Content |
| --- | --- | --- | --- |
| `local` | `dir` | yes | `rootdir,images,backup,vztmpl,iso,snippets` |
| `SBMosalam` | `pbs` | yes | `backup` |
| `SBMazeed` | `pbs` | yes | `backup` |

Only `local` can hold VM images, so it is the single allowlisted storage target. It also carries
`snippets`, which means snippet-based cloud-init would be *possible* here — but it stays out of
scope, because changing a snippet id forces VM replacement in the bpg provider.

## Networking

| Interface | Type | CIDR | Ports |
| --- | --- | --- | --- |
| `enp41s0` | eth | `157.90.75.55/28` | — |
| **`vmbr1`** | **bridge** | **`192.168.4.1/22`** | none |
| `vi1` | bridge | `192.168.0.1/22` | none |
| `vmbr44` | bridge | `192.168.18.1/24` | none |
| `vmbr200` | bridge | `192.168.32.1/20` | none |
| `vmbr4021`, `vmbr4022` | bridge | — | `enp41s0.4021`, `enp41s0.4022` |

`vmbr1` exists, is active, and carries `192.168.4.1/22` — matching the requested gateway exactly.
It has no bridge ports, so it is host-internal and the host itself is the gateway.

Note the survey reports the bridge's **address** with its prefix (`192.168.4.1/22`). The catalog
needs the **network** address: `control.networks.ipv4_cidr` is a Postgres `cidr` column and
`allocateIpv4` both reject host bits, so the value to seed is `192.168.4.0/22`.

## Reserved VMID range

| Check | Result |
| --- | --- |
| VMs inside 910000–910099 | none — the range is free |
| `datacenter.cfg` `next-id` restriction | none; the range is unrestricted |
| `GET /cluster/nextid?vmid=910000` | `200 {"data":"910000"}` — the server accepts the id |
| Server's own next free id | `318` |

The adapter hard-clamps allocated VMIDs to 910000–910099, so this had to be confirmed rather than
assumed: a `next-id` range in `datacenter.cfg` could have excluded it, and that would have been a
hard blocker discovered at first apply instead of here.

## This is a shared server with live workloads

The single most important finding, and the one that changes how the rest of the work must be done.

| Measure | Value |
| --- | --- |
| Virtual machines | **211**, VMIDs 101–317 |
| Attached to `vmbr1` | **134** |
| Addresses already in use inside `192.168.4.0/22` | **110** |
| Range those addresses occupy | `192.168.7.102` – `192.168.7.252` |

This is not an empty lab. The VM names include what read as real services and a large number of
individual people's machines. They are counted here and deliberately not listed — the survey tool
records addresses and VMIDs so the allocator can avoid them, and never writes third-party VM
names, which identify real people and do not belong in this repository's history.

Three consequences:

**1. The address pool is not ours alone.** `allocateIpv4` knows only its own
`control.ipv4_leases` table plus whatever `exclusions` it is given; it has no idea what else is
live on the bridge. It returns the *lowest* free address, so the first instances land at
`192.168.4.2` upward — comfortably clear of the occupied `192.168.7.x` region — but the 110
measured addresses must still be seeded into `control.networks.exclusions`, or the allocator will
eventually walk into them.

Residual risk worth stating plainly: the survey can only see addresses declared through
cloud-init `ipconfig0`. A guest that configures a static address internally is invisible to it.
`assertIpv4Available` (SAFE-025) rechecks the address against live VM configs immediately before
the network mutation, which catches the declared cases, but nothing here can detect an
undeclared one. The first live create is therefore verified by confirming the guest actually has
working connectivity, not just that Proxmox accepted the config.

**2. The pre-mutation address recheck is expensive here.** `assertIpv4Available` reads every VM's
configuration on the node. Measured: 211 configurations in 1.9 s at concurrency 12, so roughly
**22 s serially** — which is what the existing adapter does, once per create. It is correctness
before speed and the create path is already minutes long, but it is now a known number rather
than a surprise.

**3. Safety margins that were theoretical are now load-bearing.** The VMID clamp and the
ownership-marker discipline exist to make it impossible to touch a VM this system did not create.
On an empty lab that is belt-and-braces. Here, 211 other machines share the node and the bridge,
so every destructive path must prove ownership before acting, and no automated path may destroy
anything at all.

## Two blockers found while surveying

Neither is caused by the server; both are in this repository and both block live work.

### The readiness probe returns 500 instead of 503 under a real adapter

`apps/proxmox-provider/src/app/app.controller.ts` reads:

```ts
const response = await this.provider
  .getCapabilities({ requestId: READINESS_REQUEST_ID })
  .catch(() => undefined);
```

`ProxmoxProvider.getCapabilities` is **not** `async`, and its first statement is
`this.assertDirectProfile(request.providerProfileId)`. The probe passes no `providerProfileId`, so
that assertion throws *synchronously*, before any promise exists — and a synchronous throw is not
caught by a `.catch()` chained onto the call's result. Confirmed by execution: the error escapes
the `.catch()` entirely, so `/health/ready` raises rather than answering 503.

`FakeProvider.getCapabilities` is `async` and asserts nothing, which is why this has never been
seen: the default adapter is `fake`, and Kubernetes leaves `PROVIDER_ADAPTER` unset.

Impact under a real adapter: the container never becomes healthy, and
`provisioning-orchestrator` declares `depends_on: proxmox-provider: {condition: service_healthy}`,
so the orchestrator never starts and no request can reach the provider at all.

### The supplied credentials cannot drive the direct adapter

The credentials are a username and password for `root@pam`. `ProxmoxProvider` authenticates only
with `Authorization: PVEAPIToken=<id>=<secret>` and has no password path.

The Terraform provider accepts either, so the Terraform-routed operations would work — but the six
operations that must stay on the direct API (snapshots, reboot, hard stop) would not. **A scoped
API token is a prerequisite, not a refinement**, and it is also the right answer on a shared
server: `root@pam` grants far more than this work needs, including the `sdn`, `access` and
`storage` capability groups that nothing in scope touches.

## Answers to the questions this survey was run to settle

| Question | Answer |
| --- | --- |
| Template 110's disk size | 32 GiB — matches `lab-small`, no flavour change needed |
| Is 110 a template, cloud-init ready | Yes; `template=1`, cloud-init drive present, `agent=1` |
| Storage id | `local` |
| Does `vmbr1` exist | Yes, active, `192.168.4.1/22` |
| Is 910000–910099 free and accepted | Yes to both; no `next-id` restriction |
| Node name | `proxtest` |
| PVE version | 9.2.11 |
| What the credentials can do | Everything — they are `root@pam`. Too broad, and unusable by the direct adapter |
| Guest agent in the template | Yes, `agent 1` |
