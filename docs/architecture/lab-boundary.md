# Lab Boundary

## Purpose

The lab boundary makes live Proxmox testing possible without treating a general cluster credential as permission to mutate arbitrary resources. All provider writes remain disabled until every deployment-supplied allowlist value has been verified.

## Fixed Logical Boundary

| Field | Value |
| --- | --- |
| Environment | `lab` |
| Project ID | `lab-sandbox` |
| Kubernetes namespace | `private-cloud-control-plane` |
| Provider profile | `proxmox-lab` |
| Provider cluster alias | `lab-proxmox` |
| Image slug | `ubuntu-24-04-cloud` |
| VMID range | `910000-910099` |
| Maximum managed instances | `20` |
| Maximum real create operations per failure or load run | `20` |
| Maximum CPU per instance | `8` vCPU |
| Maximum memory per instance | `16 GiB` |
| Maximum disk per instance | `128 GiB` |
| IPv4 leases per instance | `1` |
| Snapshots per instance | `3` |
| Default retention before purge eligibility | `24 hours` |

The VMID range is reserved by policy but must be checked for live collisions before the provider profile can be enabled.

## Deployment-Supplied Allowlist

The authored reference material contains real and example infrastructure identifiers that cannot be assumed safe for a new control plane. These values therefore have no defaults:

| Required value | Acceptance rule |
| --- | --- |
| Proxmox API endpoint | Must identify the approved lab cluster and use a trusted certificate |
| Node | Exactly one node is allowed for the MVP; it must be explicitly named |
| Template VMID | Exactly one Ubuntu 24.04 cloud-init template mapped to `ubuntu-24-04-cloud` |
| Storage | Dedicated lab-capable target verified for full clones and disk growth |
| Bridge | Existing guest bridge approved for the lab; host and SDN mutation remain prohibited |
| IPv4 CIDR and gateway | Dedicated lab subnet, gateway excluded from allocation, no overlap with another managed pool |
| Provider credential reference | Secret-manager reference for a least-privilege automation identity |

An unset value, failed probe, ambiguous match, or value outside this table keeps `proxmox-lab` disabled.

## Ownership Marker

Every created VM must include all of these values in provider tags or description metadata:

```text
managed-by=private-cloud-control-plane
environment=lab
project-id=lab-sandbox
instance-id=<control-plane UUID>
operation-id=<create operation UUID>
```

The instance ID is immutable. A human-readable VM name is not ownership proof.

## Allowed Live Operations

- Read provider version, node, template, storage, network, VM, and task state
- Full-clone the one allowlisted template into the reserved VMID range
- Configure CPU, memory, one disk, one guest NIC, cloud-init, and one IPv4 lease
- Start, shutdown, stop, and reboot owned lab VMs
- Grow disk within the project limit
- Create, list, roll back, and delete snapshots owned by the instance
- Mark an owned VM retained during soft delete
- Purge only after the retention window and explicit administrative confirmation

## Prohibited Live Operations

- Mutating a VM outside the reserved VMID range or without matching ownership markers
- Automatic purge or destructive reconciliation
- Node, cluster, storage, SDN, bridge, firewall, VLAN, template, or image mutation
- Live migration
- Disk shrink
- LXC operations
- Passthrough device configuration
- High-concurrency real VM creation
- Reusing source-system credentials, customer records, IP allocations, or VM ownership as test data

## Activation Gate

The provider profile can move from disabled to enabled only when a retained verification record proves:

1. The endpoint and cluster identity are correct.
2. The node, template, storage, bridge, CIDR, and gateway match the deployment allowlist.
3. Every VMID in the range is free or already carries matching control-plane ownership.
4. The provider identity has required VM permissions and no host-lifecycle permissions.
5. A dry-run create request resolves only allowlisted provider values.
6. A fake-provider end-to-end create, duplicate, timeout, and compensation suite passes.
7. The live test cap and cleanup owner are recorded.
