# Proxmox Create Call Map

## Purpose

This call map defines the only Proxmox write path implemented in Phase 3. The provider adapter translates the provider-neutral gRPC contract into these calls. It does not import another system's service, worker, placement, inventory, or persistence architecture.

## Phase 3 Sequence

| Stage | Method and path | Request fields | Result handling | Safety rule |
| --- | --- | --- | --- | --- |
| Validate endpoint | `GET /api2/json/version` | None | Require a valid `{data}` envelope | HTTPS with a trusted certificate only |
| Validate node | `GET /api2/json/nodes/{node}/status` | None | Require the one configured node | Node comes from the server-side profile |
| Validate template | `GET /api2/json/nodes/{node}/qemu/{templateVmid}/config` | None | Confirm template and disk baseline | Template VMID is allowlisted |
| Validate storage | `GET /api2/json/nodes/{node}/storage/{storage}/status` | None | Confirm the configured target is available | Storage is allowlisted |
| Validate bridge | `GET /api2/json/nodes/{node}/network` | None | Match one bridge by interface name | No bridge or SDN mutation |
| Find owned or free VMID | `GET /api2/json/nodes/{node}/qemu` and occupied VM config reads | None | Match exact ownership metadata or choose a free reserved ID | Never use `/cluster/nextid`; never leave `910000-910099` |
| Clone | `POST /api2/json/nodes/{node}/qemu/{templateVmid}/clone` | `newid`, `name`, `full=1`, `storage`, `description` | Persist returned UPID before polling | Description contains immutable ownership markers |
| Poll task | `GET /api2/json/nodes/{node}/tasks/{encodedUpid}/status` | None | `running` remains pending; `stopped` succeeds only with `exitstatus=OK` | UPID node must equal the allowlisted node |
| Recheck network | VM list and occupied VM config reads | None | Reject a live collision before configuration | Read-only and limited to the allowlisted node |
| Read inherited NIC | `GET /api2/json/nodes/{node}/qemu/{vmid}/config` | None | Read and parse `net0` | Preserve model, MAC, and unrelated options |
| Configure | `POST /api2/json/nodes/{node}/qemu/{vmid}/config` | `name`, `cores`, `sockets=1`, `vcpus`, `memory`, `net0`, `ipconfig0`, `nameserver`, optional `sshkeys` | Persist a non-empty returned UPID before polling; an empty result is synchronous success | No password fields; omit blank SSH keys |
| Start | `POST /api2/json/nodes/{node}/qemu/{vmid}/status/start` | None | Persist returned UPID before polling | Only the owned VM selected by the workflow |
| Observe | VM `config` and `status/current` reads | None | Success requires an existing VM and exact marker match | Observation, not transport success, completes the operation |

Proxmox mutations use `application/x-www-form-urlencoded`; reads use encoded query parameters. Every response is parsed through the JSON `{data}` envelope. Raw errors, task logs, credentials, and endpoint details are never tenant-visible.

## Task And Retry Rules

- The provider adapter performs one task-status read per `GetTask` call. It never blocks in a sleep loop.
- The orchestrator stores a pre-call checkpoint before each mutation and stores a returned task reference before polling.
- A transport timeout after submission is an unknown outcome. The workflow observes ownership and does not submit another create automatically.
- A stopped task with a non-`OK` exit status is a classified provider failure.
- Configuration or start may complete synchronously when Proxmox returns no task reference.

## Deliberately Rejected Behavior

- Password and ticket authentication
- Disabled certificate or hostname verification
- Cluster-wide next-ID allocation
- Weighted or automatic node placement
- Provider task polling inside a blocking adapter call
- Host-side `pvesh`, `qm`, `pct`, or inventory-agent execution
- Automatic stop, delete, purge, or disk destruction after create failure
- Customer, billing, hosting-service, or commercial product concepts

Phase 3 keeps the requested disk equal to the allowlisted template baseline. Disk growth is implemented later through the existing provider resize contract.
