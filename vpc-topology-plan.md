# Tenant VPC Topology — Plan

Adding multi-tenant software-defined networking to the control plane: VPCs with overlapping
address space, AZ-scoped subnets, and optional public addressing, provisioned through Proxmox SDN.

**Status: DEFERRED — not scheduled, not being implemented.** Design only. Nothing here is
implemented and no server has been touched.

This work is parked. [Terraform-Backed Provisioning](terraform-provisioning-plan.md) is the active
plan, it is deliberately VPC-free, and it is verified against a **single standalone Proxmox
server** rather than a cluster. Everything below assumes a multi-node cluster with an EVPN fabric,
so none of it can start until that environment exists and the Terraform runner has been proven
against real hardware (that plan's checkpoint T-15).

Nothing in this document should be designed into the active work "for later". It is kept because
the research behind it is worth not losing, not because it is next.

| Diagram                                                                                         | Shows                                                        |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`vpc-physical-topology`](docs/diagrams/rendered/vpc-physical-topology.mermaid.svg)             | Nodes, public edge, fabric underlay, and the storage reality |
| [`vpc-tenant-isolation`](docs/diagrams/rendered/vpc-tenant-isolation.mermaid.svg)               | Two tenants on the same CIDR in separate VRFs                |
| [`vpc-control-plane-model`](docs/diagrams/rendered/vpc-control-plane-model.mermaid.svg)         | New aggregates and how they project onto Proxmox SDN objects |
| [`vpc-sdn-apply-serialization`](docs/diagrams/rendered/vpc-sdn-apply-serialization.mermaid.svg) | The global apply lock — the central safety mechanism         |
| [`vpc-instance-dual-nic`](docs/diagrams/rendered/vpc-instance-dual-nic.mermaid.svg)             | Private and public NICs, MTUs, and the routing split         |

---

## 1. What this adds to the product

Today the control plane provisions **instances** onto **one** allowlisted network that a platform
operator seeds into `control.networks`. Networking is a fixed backdrop: `listNetworks` is a
catalog read, `control.provider_profiles.network_id` points at exactly one row, and every instance
in the system lands on the same bridge with an address from the same pool.

This phase makes the network itself a tenant-owned, control-plane-managed resource:

| New capability          | Shape                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| **VPC**                 | A tenant's isolated routing domain. Its own address plan. Two tenants may both use `10.50.0.0/16` |
| **Subnet**              | A CIDR inside a VPC, bound to one availability zone                                               |
| **Availability zone**   | A named failure domain that maps to one Proxmox node                                              |
| **Instance placement**  | An instance is created _into_ a subnet, and therefore into an AZ                                  |
| **Public addressing**   | An optional second NIC on the shared public bridge, from a platform-managed pool                  |
| **Cross-AZ resilience** | Per-instance ZFS replication and HA node affinity, declared rather than hand-built                |

That is a genuine scope expansion, not a refactor. It adds four aggregates, roughly fourteen REST
operations, a new class of workflow whose blast radius is the whole cluster rather than one VM, and
three new allocators that each need the transactional rigour `allocateIpv4` already has.

---

## 2. The environment, as actually configured

Read from the three `/etc/network/interfaces` files. This section is deliberately literal, because
several later decisions depend on details that are easy to assume wrongly.

| Node       | Public address    | Public gateway | Primary NIC |
| ---------- | ----------------- | -------------- | ----------- |
| `prox88`   | `91.98.186.15/26` | `91.98.186.1`  | `enp5s0`    |
| `prox99`   | `144.76.80.51/27` | `144.76.80.33` | `enp6s0`    |
| `prox2new` | `46.4.198.134/26` | `46.4.198.129` | `enp6s0`    |

Shared vSwitch VLANs already present on all three:

| Bridge     | VLAN | Configuration                                                 | Purpose today                                           |
| ---------- | ---- | ------------------------------------------------------------- | ------------------------------------------------------- |
| `vmbr4000` | 4000 | no host address, MTU 1400                                     | Routed public subnets for guests                        |
| `vmbr4001` | 4001 | `10.0.0.251/252/253` `/32` + route to `10.0.0.0/24`, MTU 1400 | **An existing private L3 mesh between all three nodes** |
| `vmbr4021` | 4021 | no address, MTU 1400                                          | k8s control plane                                       |
| `vmbr4022` | 4022 | no address, MTU 1400                                          | k8s pod fabric                                          |

Everything else — `vmbr1`, `vmbr2`, `vmbr3`, `vmbr6`, `vmbr10`, `vmbr21`, `vmbr44`, `vmbr100`,
`vmbr200` — is per-node NAT with `iptables MASQUERADE`, is not shared between nodes, and is out of
scope. Several of them collide across nodes (`172.16.1.1/24` and `192.168.18.1/24` exist on all
three as _different_ networks), which is exactly why they cannot participate in a routed fabric.

### 2.1 Two findings that change the design

**`vmbr4001` is already a usable fabric underlay, and that removes the WireGuard problem.**

The conversation you had concluded that the fabric must be a PVE 9.2 WireGuard fabric over the
public IPs, and that this is the one piece `bpg/proxmox` cannot manage — which is correct: the
provider ships `sdn_fabric_openfabric` and `sdn_fabric_ospf` and **no WireGuard fabric resource**.

But you already have private L3 reachability between all three nodes on VLAN 4001. An OpenFabric
or OSPF fabric over `vmbr4001` needs no WireGuard, and **is** a Terraform resource. Choosing it
collapses the one platform-level gap in the whole design.

The trade-off is encryption. WireGuard encrypts node-to-node overlay traffic; a vSwitch does not.
Whether that matters depends on §2.2.

MTU is the other axis, and it is worth being exact about:

| Underlay                        | Path MTU                     | VXLAN overhead | WireGuard overhead | Guest MTU |
| ------------------------------- | ---------------------------- | -------------- | ------------------ | --------- |
| OpenFabric/OSPF over `vmbr4001` | 1400 (Hetzner vSwitch limit) | ~50            | —                  | **1350**  |
| WireGuard over public `vmbr0`   | 1500                         | ~50            | ~80                | **1370**  |
| WireGuard over `vmbr4001`       | 1400                         | ~50            | ~80                | 1270      |

So the encrypted path actually yields a slightly _larger_ guest MTU, because the public interface
is not MTU-capped at 1400. Neither number is negotiable at runtime — whichever is chosen becomes a
column on the subnet record and is written by cloud-init.

**The three nodes may not be in the same Hetzner location, and that is a prerequisite question,
not a detail.** `46.4.0.0/16` and `144.76.0.0/16` are long-standing Falkenstein ranges;
`91.98.0.0/16` is a newer allocation that Hetzner has used outside Falkenstein. If `prox88` is in
a different datacenter, then a single Corosync cluster across all three is precisely the topology
Proxmox tells you not to build — quorum depends on low-latency, reliable cluster communication.

This has to be answered before anything else, because **every AZ semantic in this plan assumes one
Proxmox cluster**. If the three nodes cannot safely be one cluster, the correct architecture is
three clusters under Proxmox Datacenter Manager, AZs become regions, and stretched VNets stop being
available — a materially different design.

### 2.2 What this plan does _not_ own

These are prerequisites the control plane cannot create and must refuse to work without:

1. **A Proxmox cluster** spanning the three nodes, with quorum, on a link that satisfies Corosync's
   latency requirements.
2. **The SDN fabric** — WireGuard or OpenFabric/OSPF — and the EVPN controller on top of it.
   Platform infrastructure, built once. The control plane reads its health and refuses to
   provision when it is degraded; it never reconfigures it.
3. **`wireguard-tools` and `frr-pythontools`** installed on every node, and PVE 9.2 if the
   WireGuard option is taken.
4. **Routed public subnets** delegated to the vSwitch, with their gateways, recorded as a platform
   pool.

---

## 3. AWS mapping, and the four places it breaks

Rendered view of the isolation model:
[`vpc-tenant-isolation`](docs/diagrams/rendered/vpc-tenant-isolation.mermaid.svg).

| AWS                    | Here                            | Honest?                                                 |
| ---------------------- | ------------------------------- | ------------------------------------------------------- |
| Region                 | Proxmox cluster                 | Yes                                                     |
| Availability Zone      | One node                        | **Partly — see (a)**                                    |
| VPC                    | EVPN zone with its own VRF      | Yes                                                     |
| Subnet                 | VNet + SDN subnet               | **Partly — see (b)**                                    |
| Route table            | The zone's VRF                  | Yes                                                     |
| VPC peering            | BGP between VRFs                | Yes, with the same overlapping-CIDR restriction AWS has |
| Security group         | Proxmox firewall security group | Yes                                                     |
| Internet gateway / NAT | Exit nodes with SNAT            | Yes for egress                                          |
| Elastic IP             | Second NIC on `vmbr4000`        | **No — see (c)**                                        |
| EBS                    | Local ZFS + async replication   | **No — see (d)**                                        |

**(a) An AZ here is one machine, not one datacenter.** Correlated failure is far more likely than
in AWS: one power feed, one rack, one uplink, potentially one datacenter. Call them failure domains
internally. Exposing them as AZs to customers is a product decision, and it should be made
knowing that a single Hetzner rack loss can take all three.

**(b) An AWS subnet lives in exactly one AZ; an EVPN VNet is deployed to a set of nodes and is
naturally stretched across all of them.** We get AWS semantics by _convention_: each subnet is
recorded with an AZ, and instances in it are placed there with a non-strict HA node-affinity rule.
The network itself remains reachable everywhere, which is what makes failover work at all —
an instance that fails over to another node keeps its address and its gateway. This is better
behaviour than AWS, but it means the AZ boundary is enforced by the control plane, not by the
fabric. Nothing stops an operator with node access from starting a VM on the wrong node.

**(c) A public address here is configured _inside_ the guest.** AWS instances only ever see their
private address; the Internet Gateway does the 1:1 translation. Here the guest genuinely holds
`x.y.z.w/28` on a second NIC. Consequences that must be documented rather than glossed over: the
guest can see and change its own public address; a misconfigured guest can ARP for an address it
does not own; and moving an address between instances is a guest-visible reconfiguration, not an
API-level remap.

**(d) Storage is not multi-AZ.** ZFS replication is asynchronous with a one-minute minimum
interval, so the RPO after a node loss is 0–60 seconds. This must never be described as
AWS-equivalent multi-AZ durability. It is warm standby.

---

## 4. The central safety problem: SDN apply is cluster-wide

This is the single most important section in the plan, and it is where the architecture from
[terraform-provisioning-plan.md](terraform-provisioning-plan.md) has to change.

`proxmox_sdn_applier` is documented as triggering "Proxmox's SDN **Apply** (equivalent to
`PUT /cluster/sdn`)". That endpoint applies **all pending SDN configuration, cluster-wide**. It
does not apply "the objects this Terraform run created". It publishes everything anyone has staged.

Three consequences, each of which invalidates a naive design:

1. **Two concurrent tenant applies each publish the other's half-written configuration.** Tenant A
   writes a zone and calls apply; tenant B has written a VNet but not yet its subnet; A's apply
   pushes B's incomplete VNet to every node. The per-workspace isolation that makes the
   instance-level Terraform design safe does not exist here.
2. **The blast radius is every tenant on the cluster.** An apply reloads network configuration and
   FRR on all nodes. A bad apply is a cluster-wide network outage, not one broken VM.
3. **Proxmox has no SDN rollback.** Recovery means re-applying a previous configuration, which
   requires that we kept one.

### 4.1 The design

**All SDN mutations are serialized through a single global writer, and the apply itself is a
direct API call rather than a Terraform resource.**

```text
tenant intent → control.sdn_changes (queued, one row per mutation)
              → pg_advisory_lock on one global SDN key
              → [ write objects · verify pending · snapshot · PUT /cluster/sdn · verify converged ]
              → release
```

The rendered diagram is
[`vpc-sdn-apply-serialization`](docs/diagrams/rendered/vpc-sdn-apply-serialization.mermaid.svg).

Each step earns its place:

- **Queue, don't block the caller.** VPC and subnet creates are accepted asynchronously exactly
  like instance creates — 202 plus an operation to poll. The queue is what lets a burst of tenant
  requests serialize without any of them failing.
- **One global advisory lock.** The instance-level design uses one lock per instance because
  instances are independent. SDN objects are not: they share one apply. A single
  `pg_advisory_xact_lock` on a fixed SDN key is the honest expression of that.
- **Verify pending before applying.** The EVPN zone resource exposes read-only `pending` and
  `state` attributes. Before applying, read what is staged cluster-wide. If anything is pending
  that this change did not write, **stop and go to `manual_review`**. Publishing configuration
  the control plane did not author is exactly the failure mode that must never be automatic.
- **Snapshot the known-good configuration first.** `/etc/pve/sdn/*.cfg` plus the rendered running
  config, stored as a versioned row. This is the only rollback that exists.
- **Apply with a direct `PUT /cluster/sdn`, not `sdn_applier`.** Two reasons. It is an imperative
  action, and the Terraform plan already establishes a narrowed direct client for imperative
  operations. And `sdn_applier` is marked **EXPERIMENTAL** in the provider — an experimental
  resource is not where the most dangerous operation in the system belongs.
- **Verify convergence per node** before declaring success, and re-apply the snapshot if a node
  did not converge. A partial apply that is silently accepted is worse than a failed one.

### 4.2 Consequence for the Terraform workspace model

The Terraform plan's rule — one workspace per instance — stays for instances. SDN needs a second
model:

| Layer                      | Workspace                | Lock                       | Applied by                |
| -------------------------- | ------------------------ | -------------------------- | ------------------------- |
| Fabric and EVPN controller | `platform-fabric`        | Global SDN lock            | Operator, out of band     |
| Tenant VPC and its subnets | `vpc-<vpc-id>`           | Global SDN lock            | Control plane, serialized |
| One instance               | `instance-<instance-id>` | Per-instance advisory lock | Control plane, concurrent |

VPC workspaces are per-VPC so that a tenant's network objects can be planned, drift-checked, and
destroyed independently — but the _apply_ that publishes them is global and serialized. Splitting
the write from the publish is what makes this workable.

---

## 5. Domain model

Rendered: [`vpc-control-plane-model`](docs/diagrams/rendered/vpc-control-plane-model.mermaid.svg).

### 5.1 New aggregates

**`Vpc`** — owned by a project. Carries the tenant's address plan (`ipv4_cidr`, informational —
Proxmox has no VPC-level CIDR), the allocated VRF VNI, the MTU, the exit-node set, and state
(`pending`, `active`, `degraded`, `deleting`). One VPC maps to one EVPN zone.

**`Subnet`** — owned by a VPC. `ipv4_cidr`, `gateway`, `availability_zone_id`, `vnet_vni`,
`snat_enabled`, `dns_servers`, `mtu`, `state`. Maps to one VNet plus one SDN subnet. `control.networks`
is superseded by this: the existing table becomes the platform-managed default VPC's subnets so the
Phase 3–5 path keeps working unchanged during migration.

**`AvailabilityZone`** — platform catalog, not tenant-owned. `id`, `node_name`, `state`, `capacity`.
This is what turns today's single `configuration.node` into a set, and it is a new safety surface:
SAFE-002 requires the node to match the provider profile, so the profile's `compute_target` becomes
a _set_ of allowed nodes and placement must be checked against it at the point of use.

**`PublicIpAddress`** — platform pool, leased to instances. `address`, `prefix_length`, `gateway`,
`pool_id`, `state` (`available`, `leased`, `quarantined`), `instance_id`. Leasing is transactional
exactly like `control.ipv4_leases`.

### 5.2 Three allocators, all of them safety-critical

Each needs the treatment `allocateIpv4` already has: a pure function in `packages/domain` for the
arithmetic and boundary rules, plus a store method that takes an advisory lock and relies on a
unique constraint to make the race unwinnable.

**VNI allocation.** VNIs must be unique across the entire fabric even though CIDRs overlap. A
collision silently merges two tenants' Layer 2 — the worst failure this system could have. Ranges
are reserved per purpose (VRF VNIs and VNet VNIs in disjoint bands), allocation is a single
transaction, and the unique constraint is on the fabric-wide VNI, not on `(vpc_id, vni)`.

**Tenant CIDR allocation.** Within a VPC, subnets must not overlap each other. Across VPCs, they
may. Postgres `cidr`/`inet` types and an exclusion constraint using `&&` give this directly:
`EXCLUDE USING gist (vpc_id WITH =, ipv4_cidr WITH &&)`. That is a database-enforced invariant
rather than application logic, which is the right level for it.

**Public address allocation.** From a finite platform pool, with a hard capacity rule the current
system has no equivalent of: **Hetzner permits 32 MAC addresses per physical switch port.** Every
guest NIC on `vmbr4000` consumes one. The control plane must count leased public NICs per node and
refuse allocation past a configured ceiling below 32. Discovering this limit in production looks
like random, partial connectivity loss for unrelated tenants.

### 5.3 What changes in the existing model

- `control.ipv4_leases` already has `UNIQUE (network_id, address)` filtered to active leases, so
  overlapping CIDRs across different subnets work with no change to the index — a genuinely lucky
  break. `network_id` is renamed to `subnet_id` and re-pointed.
- **SAFE-023 must be restated.** "An IPv4 address has at most one active lease" becomes "…at most
  one active lease _within its subnet_". The old wording becomes false the moment two tenants use
  `10.50.10.10`.
- `allocateIpv4`'s `Ipv4Pool` gains no new fields but its call sites become subnet-scoped.
- `ProviderProfile.network_attachment` and `network_id` become the _default_ VPC binding for
  instances created without an explicit subnet, preserving the Phase 3–5 contract.

---

## 6. Contracts

Contracts are generated, and `tools/contracts/validate.mjs` asserts hard counts — `39` REST
operations at line 115 and `54` gRPC methods at line 240. Both move, and the assertion updates are
part of the same change so the count can never drift silently.

Proposed REST additions (14, taking 39 → 53):

| Operation               | Method and path                                                         |
| ----------------------- | ----------------------------------------------------------------------- |
| `listVpcs`              | `GET /v1/projects/{projectId}/vpcs`                                     |
| `createVpc`             | `POST /v1/projects/{projectId}/vpcs`                                    |
| `getVpc`                | `GET /v1/projects/{projectId}/vpcs/{vpcId}`                             |
| `deleteVpc`             | `DELETE /v1/projects/{projectId}/vpcs/{vpcId}`                          |
| `listSubnets`           | `GET /v1/projects/{projectId}/vpcs/{vpcId}/subnets`                     |
| `createSubnet`          | `POST /v1/projects/{projectId}/vpcs/{vpcId}/subnets`                    |
| `getSubnet`             | `GET …/subnets/{subnetId}`                                              |
| `deleteSubnet`          | `DELETE …/subnets/{subnetId}`                                           |
| `listAvailabilityZones` | `GET /v1/availability-zones`                                            |
| `listPublicAddresses`   | `GET /v1/projects/{projectId}/public-addresses`                         |
| `attachPublicAddress`   | `POST /v1/projects/{projectId}/instances/{instanceId}/public-addresses` |
| `detachPublicAddress`   | `DELETE …/public-addresses/{addressId}`                                 |
| `listSdnChanges`        | `GET /v1/admin/sdn-changes`                                             |
| `getSdnChange`          | `GET /v1/admin/sdn-changes/{changeId}`                                  |

The last two are administrative and exist because a serialized global queue that operators cannot
inspect is an outage waiting to happen.

New events on the existing channels: `vpc.create.requested`, `vpc.created`, `vpc.delete.requested`,
`vpc.deleted`, `subnet.create.requested`, `subnet.created`, `subnet.delete.requested`,
`subnet.deleted`, `sdn.apply.completed`, `sdn.apply.failed`, `public_address.attached`,
`public_address.detached`. Taking events 20 → 32.

`Instance` gains `subnetId`, `availabilityZoneId`, and `publicAddresses[]`. `CreateInstanceRequest`
gains an optional `subnetId`; absent, it resolves to the provider profile's default subnet, which
is what keeps every existing test and the Postman collection passing.

---

## 7. Schema

Migration `0009_vpc_topology.sql`. Additive; nothing existing is dropped in the same migration.

```sql
CREATE TABLE control.availability_zones (
  id                text PRIMARY KEY,
  node_name         text NOT NULL UNIQUE,
  state             text NOT NULL CHECK (state IN ('active','draining','unavailable')),
  ...
);

CREATE TABLE control.vpcs (
  id                uuid PRIMARY KEY,
  project_id        uuid NOT NULL REFERENCES control.projects(id),
  name              text NOT NULL,
  ipv4_cidr         cidr NOT NULL,          -- the tenant's plan; may overlap another tenant's
  vrf_vni           integer NOT NULL UNIQUE, -- fabric-wide unique
  mtu               integer NOT NULL,
  state             text NOT NULL CHECK (state IN ('pending','active','degraded','deleting','failed')),
  ...
  UNIQUE (project_id, name)
);

CREATE TABLE control.subnets (
  id                     uuid PRIMARY KEY,
  vpc_id                 uuid NOT NULL REFERENCES control.vpcs(id),
  availability_zone_id   text NOT NULL REFERENCES control.availability_zones(id),
  ipv4_cidr              cidr NOT NULL,
  gateway                inet NOT NULL,
  vnet_vni               integer NOT NULL UNIQUE,   -- fabric-wide unique
  snat_enabled           boolean NOT NULL DEFAULT false,
  mtu                    integer NOT NULL,
  state                  text NOT NULL CHECK (state IN ('pending','active','degraded','deleting','failed')),
  ...
  EXCLUDE USING gist (vpc_id WITH =, ipv4_cidr inet_ops WITH &&)   -- no overlap inside a VPC
);

CREATE TABLE control.public_address_pools ( ... );
CREATE TABLE control.public_addresses (
  id             uuid PRIMARY KEY,
  pool_id        uuid NOT NULL REFERENCES control.public_address_pools(id),
  address        inet NOT NULL,
  state          text NOT NULL CHECK (state IN ('available','leased','quarantined')),
  instance_id    uuid REFERENCES control.instances(id),
  ...
);
CREATE UNIQUE INDEX public_addresses_leased ON control.public_addresses (address)
  WHERE state IN ('leased','quarantined');

CREATE TABLE control.sdn_changes (           -- the serialized queue
  id, operation_id, kind, payload jsonb, state, queued_at, started_at, finished_at,
  pending_check jsonb, snapshot_id, failure jsonb
);
CREATE TABLE control.sdn_snapshots (         -- the only rollback that exists
  id, captured_at, configuration jsonb, applied_change_id, known_good boolean
);

ALTER TABLE control.ipv4_leases RENAME COLUMN network_id TO subnet_id;
ALTER TABLE control.instances
  ADD COLUMN subnet_id uuid REFERENCES control.subnets(id),
  ADD COLUMN availability_zone_id text REFERENCES control.availability_zones(id);
```

The `EXCLUDE USING gist` constraint deserves a note in the migration: it is the reason subnet
overlap inside a VPC cannot happen even under concurrent creates, and it replaces what would
otherwise be a read-check-write race in application code.

---

## 8. Workflows

Four new actions join the `WorkflowAction` union, each with its own stage plan and — critically —
its own mutation-stage classification. Getting that classification wrong is how a retry turns into
a duplicated destructive operation, so each gets a test asserting exactly which stages are
mutations.

| Action          | Stages                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `create_vpc`    | `accepted` → `allocating_vni` → `writing_sdn` → `queued_for_apply` → `applying_sdn` → `verifying_sdn` → `completed`         |
| `delete_vpc`    | `accepted` → `verifying_vpc_empty` → `writing_sdn` → `queued_for_apply` → `applying_sdn` → `verifying_sdn` → `completed`    |
| `create_subnet` | `accepted` → `allocating_vni` → `writing_sdn` → `queued_for_apply` → `applying_sdn` → `verifying_sdn` → `completed`         |
| `delete_subnet` | `accepted` → `verifying_subnet_empty` → `writing_sdn` → `queued_for_apply` → `applying_sdn` → `verifying_sdn` → `completed` |

`queued_for_apply` is a genuinely new kind of stage: the workflow parks until the global SDN writer
picks its change up. It is not a poll of an external task — it is a poll of an internal queue —
and it re-enters itself the same way `polling_*` stages do.

The two `verifying_*_empty` stages are the refusal points. **Deleting a subnet with live instances,
or a VPC with live subnets, is refused** — a 409, not a cascade. There is no cascading network
delete in this design, for the same reason there is no destructive compensation path anywhere else.

Attach and detach of a public address are instance mutations rather than SDN changes: they change a
VM's NIC set, take no global lock, and route through the existing instance workflow machinery with
`submitting_public_address` / `polling_public_address` / `observing_public_address`.

---

## 9. Terraform layering

Rendered: [`vpc-physical-topology`](docs/diagrams/rendered/vpc-physical-topology.mermaid.svg).

```text
deploy/terraform/
  modules/
    instance/          # from terraform-provisioning-plan.md
    vpc/               # EVPN zone + VNets + subnets for one tenant VPC
    availability-zone/ # HA rules + replication jobs for one instance placement
  platform/
    fabric/            # OpenFabric or OSPF fabric + EVPN controller. Operator-applied.
```

The `vpc` module is a straightforward mapping onto verified provider resources:

```hcl
resource "proxmox_virtual_environment_sdn_zone_evpn" "vpc" {
  id                = var.zone_id           # 8-char limit
  controller        = var.controller_id
  vrf_vxlan         = var.vrf_vni
  nodes             = var.nodes
  mtu               = var.mtu
  exit_nodes        = var.exit_nodes
  primary_exit_node = var.primary_exit_node # preferred over ECMP when SNAT is in use
}

resource "proxmox_virtual_environment_sdn_vnet" "subnet" {
  for_each = var.subnets
  id       = each.value.vnet_id
  zone     = proxmox_virtual_environment_sdn_zone_evpn.vpc.id
  tag      = each.value.vni
}

resource "proxmox_virtual_environment_sdn_subnet" "subnet" {
  for_each = var.subnets
  vnet     = proxmox_virtual_environment_sdn_vnet.subnet[each.key].id
  cidr     = each.value.cidr
  gateway  = each.value.gateway
  snat     = each.value.snat
}
```

**No `sdn_applier` resource.** The apply is the direct call described in §4.1. Terraform writes the
objects; the control plane publishes them, under the lock, having checked what else is pending.

The instance module from the Terraform plan gains a second `network_device` and a second
`ip_config` entry when a public address is attached. **Ordering of `initialization.ip_config`
entries relative to `network_device` blocks needs verification against the provider before this is
relied on** — it is listed as a checkpoint task rather than asserted here.

Two provider facts already verified and worth carrying into the module:

- `proxmox_vm` (the short-name resource) is marked "highly experimental… **MUST NOT** be used in
  production". The module uses `proxmox_virtual_environment_vm` throughout.
- `proxmox_virtual_environment_harule` and `_haresource` cover non-strict node affinity, and
  `_replication` covers ZFS replication jobs with target, schedule, and rate. AZ placement and
  warm standby are therefore declarative, not scripts.

---

## 10. New safety invariants

Proposed additions to `docs/architecture/safety-invariants.md`:

| ID       | Invariant                                                                                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SAFE-037 | Every SDN mutation is serialized through one global writer; concurrent SDN applies never occur.                                                                |
| SAFE-038 | An SDN apply is refused when pending configuration exists that the current change did not author. The outcome is `manual_review`, never a best-effort publish. |
| SAFE-039 | A known-good SDN configuration snapshot is recorded before every apply, and is the only rollback path.                                                         |
| SAFE-040 | Overlay identifiers (VRF and VNet VNIs) are unique across the whole fabric, enforced by a database constraint, regardless of address-space overlap.            |
| SAFE-041 | Subnets within a VPC never overlap, enforced by a database exclusion constraint rather than application logic.                                                 |
| SAFE-042 | A subnet with live instances, or a VPC with live subnets, is never deleted. Network deletion never cascades.                                                   |
| SAFE-043 | Public address leases are capped per node below the physical switch-port MAC limit.                                                                            |
| SAFE-044 | Instance placement is checked against the provider profile's allowed availability zones at the point of use, not only at admission.                            |

And SAFE-023 is amended: _"An IPv4 address has at most one active lease **within its subnet**;
allocation and release are transactional."_

---

## 11. Checkpoints

One checkpoint per commit, ledger discipline as in Phases 4–6. Checkpoints V-1 to V-9 need no
cluster at all — they are contract, schema, allocator, and gating work that is fully testable in
containers.

| #    | Checkpoint                                                                                                         | Needs a cluster? |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ---------------- |
| V-1  | ADR: SDN scope, global apply lock, fabric choice, AZ semantics and their honest limits                             | No               |
| V-2  | Contracts: 14 REST operations, gRPC parity, 12 events, hard-count updates, regenerated types and docs              | No               |
| V-3  | Migration `0009`, including the exclusion constraint; integration tests that race concurrent subnet creates        | No               |
| V-4  | VNI allocator — pure domain function plus store method; integration test for concurrent allocation                 | No               |
| V-5  | Subnet CIDR validation and overlap rules; SAFE-023 restatement across code and docs                                | No               |
| V-6  | Public address pool and allocator, including the per-node MAC ceiling                                              | No               |
| V-7  | SDN change queue and the global writer: lock, pending check, snapshot, convergence verify. Direct-API apply client | No               |
| V-8  | The four workflows, stage plans, mutation classification tests, refusal paths                                      | No               |
| V-9  | `vpc` Terraform module + plan-gate fixtures for SDN plans                                                          | No               |
| V-10 | Application and API surface: authorization, idempotency, projections, read models                                  | No               |
| V-11 | Simulator: extend the local Proxmox simulator with SDN endpoints and a pending/apply state machine                 | No               |
| V-12 | Instance integration: `subnetId` on create, AZ placement, HA rules, replication jobs                               | Simulator        |
| V-13 | Public NIC on instances: second `network_device`, dual `ip_config`, routing and MTU in cloud-init                  | Simulator        |
| V-14 | **Cluster prerequisites verified**: one Proxmox cluster, fabric up, EVPN controller healthy                        | **Yes**          |
| V-15 | First live VPC: one zone, one subnet, one instance, on one node                                                    | **Yes**          |
| V-16 | Cross-AZ: same VPC across all three nodes, instance-to-instance across nodes, failover keeps address and gateway   | **Yes**          |
| V-17 | Overlapping CIDRs: two VPCs on `10.50.0.0/16`, proven isolated                                                     | **Yes**          |
| V-18 | Public addressing live, including the MAC-ceiling refusal                                                          | **Yes**          |
| V-19 | Failure drills: apply with foreign pending config, node fails to converge, snapshot restore                        | **Yes**          |
| V-20 | Migration: fold `control.networks` into a platform default VPC without disturbing existing instances               | **Yes**          |
| V-21 | Closure: docs, diagrams, runbook, metric catalog, README, Postman coverage for the new operations                  | Yes              |

---

## 12. Testing

The layers are the ones the project already uses, with one addition that carries most of the risk.

- **Unit.** VNI allocation boundaries. CIDR overlap arithmetic. Public-address capacity maths. The
  SDN plan gate against recorded plan JSON, including a plan that would delete a VNet with live
  leases.
- **Integration, containerized.** The races that matter, on real PostgreSQL: two concurrent subnet
  creates in the same VPC (the exclusion constraint must reject exactly one), two concurrent VNI
  allocations, two workflows contending for the global SDN lock, and a worker killed mid-apply.
- **Simulator (V-11).** The existing simulator is 137 lines covering the current adapter's handful
  of endpoints. SDN needs `/cluster/sdn` GET and PUT, zone/VNet/subnet CRUD, and a pending→applied
  state machine — because the _pending-configuration_ check in §4.1 is the single most important
  behaviour in this phase and it must be testable without a cluster.
- **Live.** The Required Verification Pattern per capability, plus the three drills in V-19. Live
  work stays inside a dedicated lab project and VMID range (SAFE-007) with the small operation cap
  SAFE-030 requires.

---

## 13. Risks

| Risk                                                          | Assessment                                                                                                                                                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A bad SDN apply takes down the whole cluster's networking** | The defining risk. Serialization, the pending check, snapshot-before-apply, and per-node convergence verification all exist for this one scenario. It is still the reason V-19 is a checkpoint of its own |
| **The three nodes cannot safely be one cluster**              | Would invalidate every AZ semantic here. It is the first prerequisite in V-14 for that reason, and §2.1 explains why it is genuinely uncertain                                                            |
| **VNI collision merges two tenants' Layer 2**                 | Database-unique constraint on the fabric-wide VNI, allocated in the same transaction as the object                                                                                                        |
| **Public address misuse by a guest**                          | Inherent to guest-configured addressing (§3c). Mitigated by Proxmox firewall rules and MAC filtering, not eliminated                                                                                      |
| **32-MAC vSwitch ceiling hit in production**                  | Enforced as a refusal, not discovered. Beyond ~30 public NICs per node, the design has to move to edge gateways                                                                                           |
| **`sdn_applier` being experimental**                          | Avoided entirely — the apply is a direct call                                                                                                                                                             |
| **Scope**                                                     | This is the largest single expansion since Phase 5: four aggregates, 14 operations, four workflows, three allocators. It should not be attempted before the Terraform phase is at least through T-13      |

---

## 14. Open questions

1. **Are all three nodes in one Hetzner location, and can they form one Corosync cluster?** Blocking
   for every AZ semantic. Nothing past V-13 can start without an answer.
2. **Fabric underlay: OpenFabric/OSPF over the existing `vmbr4001`, or a WireGuard fabric over the
   public IPs?** The former is fully Terraform-manageable and simpler; the latter encrypts
   node-to-node traffic and yields a marginally larger guest MTU (1370 vs 1350). If the nodes are
   in different datacenters, encryption stops being optional and WireGuard wins despite the gap.
3. **Are AZs exposed to customers as AZs?** They are single machines. The plan supports either
   choice but the product language should be decided before the API is published.
4. **Strict or non-strict HA node affinity?** Non-strict gives real failover and is recommended;
   strict gives literal AWS semantics and wastes the cluster's best property.
5. **Which public subnets are delegated to the pool, and what per-node ceiling below 32?**
6. **Does the default VPC migration (V-20) need to be transparent to existing instances,** or is a
   maintenance window acceptable? Transparent is achievable but constrains the migration shape.

---

## Appendix — vocabulary

None of this exists in the codebase. It lives here rather than in
[the glossary](docs/architecture/glossary.md) because that document describes the system as it
actually is, and this work is deferred. The terms are easy to confuse with one another, which is
the only reason they are written down this early.

**EVPN zone.** A tenant's isolated routing domain, and what the control plane will expose as a
**VPC**. Its isolation comes from having its own VRF, which is why two tenants can both use
`10.50.0.0/16` without ambiguity — the addresses live in separate routing tables.

**VRF (virtual routing and forwarding).** A separate routing table on the same physical hosts.
This is the mechanism behind overlapping tenant address space. It is also why VPC peering between
two tenants on the same CIDR is impossible without NAT — exactly the restriction AWS has.

**VNet and SDN subnet.** A VNet is a Layer 2 segment; an SDN subnet attaches a CIDR and a gateway
to it. Together they are what the control plane will expose as a **subnet**. Unlike an AWS subnet,
a VNet is deployed to a _set_ of nodes and is reachable on all of them; the availability-zone
boundary is a control-plane convention, not something the fabric enforces.

**VNI (VXLAN network identifier).** The overlay's numeric identifier. VNIs must be unique across
the whole fabric even when CIDRs overlap — a collision silently merges two tenants' Layer 2, which
is why allocation gets the same transactional treatment as IPv4 leasing.

**Anycast gateway.** The subnet's `.1` address, present on every participating node at once. It is
what lets an instance keep both its address and its gateway when it fails over to another node.

**Exit node.** A node that advertises a default route into the EVPN fabric and performs SNAT for
egress. Analogous to an AWS NAT gateway. With SNAT in use, a designated primary exit node is
preferred over ECMP across several.

**Cluster SDN apply.** `PUT /cluster/sdn`, which publishes **all** pending SDN configuration
cluster-wide rather than only the objects one caller staged. This single fact is why network
changes cannot use the per-tenant isolation that every other mutation in this system relies on,
and why they are serialized through one global writer instead.
