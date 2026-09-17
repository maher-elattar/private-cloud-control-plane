/**
 * The purge path's copy of the instance module, without `prevent_destroy`.
 *
 * **This is the only Terraform in the repository that can destroy a VM.**
 *
 * WHY a second directory rather than a variable: `prevent_destroy` is a `lifecycle`
 * meta-argument, and those take literals only — "destroy is permitted in the purge path" is not
 * expressible as a parameter. The alternative would be one module with no protection at all,
 * relying entirely on the plan gate; two modules means the ordinary path is protected by the
 * provider itself and the destructive one is a deliberate, named choice at the call site.
 *
 * The cost is duplication, and it is paid down mechanically: this file must be identical to
 * `../instance/main.tf` except for this header and the `lifecycle` block.
 * `pnpm run terraform:check-modules` fails if anything else diverges.
 *
 * Reaching this module is not sufficient to destroy anything. The workflow must still pass
 * `verifying_purge`, which proves live provider ownership before the call (SAFE-006), and the plan
 * gate must be invoked with the purge capability rather than refusing the delete as it otherwise
 * would.
 *
 * @see ../instance/main.tf
 * @see terraform-provisioning-plan.md
 */

resource "proxmox_virtual_environment_vm" "instance" {
  node_name   = var.node_name
  vm_id       = var.vm_id
  name        = var.hostname
  description = var.ownership_marker
  tags        = var.tags

  # The resource pool the instance belongs to.
  #
  # WHY this is an authorization control and not organisation. Proxmox checks `VM.Allocate` on
  # `/pool/<id>` when a create names a pool, and on `/vms/<vmid>` when it does not. Without a pool
  # this deployment needed one ACL entry per reserved VMID — and **Proxmox deletes a VMID's ACL
  # entry when the VM is destroyed**, so every instance lifecycle permanently consumed one of
  # them. Measured: eight entries disappeared across a single afternoon of verification runs, and
  # the next create on a consumed VMID failed with `HTTP 403 - Permission check failed` after the
  # control plane had already committed the instance, the lease and the quota.
  #
  # A pool grant cannot erode, because the pool outlives the VMs in it.
  pool_id = var.pool_id

  # Full clone, so the instance does not depend on the template's disk staying put.
  clone {
    vm_id        = var.template_vm_id
    datastore_id = var.datastore_id
    full         = true
  }

  cpu {
    cores   = var.cpu_cores
    sockets = 1
    type    = "host"
    # Maps to Proxmox's `vcpus`, which the template sets. Left undefined it diffs forever, and a
    # VM without CPU hotplug should report its full core count anyway.
    hotplugged = var.cpu_cores
  }

  memory {
    dedicated = var.memory_mib
  }

  disk {
    datastore_id = var.datastore_id
    interface    = var.disk_interface
    size         = var.disk_gib
    discard      = "on"
    iothread     = true
    ssd          = true

    # Matches the template's format, which is not a free choice.
    #
    # Measured: setting a format here does **not** convert on clone. bpg ignores `file_format` for
    # a cloned disk — the clone copies the source format — so a declared value that disagrees with
    # the template's real format makes every subsequent plan a *replacement*, which the gate
    # refuses. That took out convergence and resize as well as the snapshot it was meant to enable.
    #
    # So this value must state what the clone will actually be, and the way to change it is to
    # change the template. Proxmox snapshots a disk only where the storage supports it, and
    # directory storage supports snapshots **only for qcow2** — which is why the deployment now
    # clones from a qcow2 template built by `tools/proxmox/build-qcow2-template.mjs`, and why this
    # is a variable rather than a literal: a deployment whose template is still raw must declare
    # raw, or its first plan is a replacement.
    file_format = var.disk_format
  }

  network_device {
    bridge   = var.bridge
    model    = "virtio"
    mtu      = var.network_mtu
    firewall = true
  }

  agent {
    enabled = true
  }

  # Inline cloud-init only. The snippet-file attributes — `user_data_file_id` and its siblings —
  # are ForceNew in this provider, so editing cloud-init through them would ask Terraform to
  # destroy a running instance, which SAFE-028 forbids. They are never set, and that is also why
  # this deployment needs no SSH access to the node.
  initialization {
    # bpg defaults this to `local-lvm`, independently of `clone.datastore_id`. Where that storage
    # does not exist the clone succeeds and the cloud-init disk fails, leaving the resource
    # tainted — and a tainted resource is *replaced* on the next plan.
    datastore_id = var.datastore_id

    ip_config {
      ipv4 {
        address = "${var.ipv4_address}/${var.ipv4_prefix_length}"
        gateway = var.ipv4_gateway
      }
    }

    dns {
      domain  = var.dns_domain
      servers = var.dns_servers
    }

    user_account {
      username = var.cloud_init_username
      password = var.cloud_init_password
      keys     = var.ssh_public_keys
    }
  }

  # Declared to match the template. bpg's defaults differ from all three, and a default that
  # disagrees with the source VM is a permanent diff.
  machine       = "q35"
  scsi_hardware = "virtio-scsi-single"

  operating_system {
    type = "l26"
  }

  started = var.started
  on_boot = var.on_boot

  lifecycle {
    # No prevent_destroy. That absence is the entire difference between this module and its
    # sibling, and it is why this one is reached only from the purge path.

    ignore_changes = [
      # The provider assigns the MAC and the control plane does not own it. Without this, a NIC
      # rebuild would churn the address on every plan.
      network_device[0].mac_address,

      # WHY the clone block is ignored after creation: Proxmox does not record what a VM was
      # cloned from, so `terraform import` reconstructs an empty clone block. Every clone
      # sub-attribute is ForceNew, so without this the importer sees the block being *added* and
      # plans a destroy-and-create. Orphan recovery — adopting a VM that exists while state does
      # not — is impossible without it. Measured; see the walkthrough's finding 6.
      clone,

      # WHY pool membership is ignored after creation: the pool is what *authorizes* the create —
      # Proxmox checks `VM.Allocate` on `/pool/<id>` when a request names one — and membership is
      # established by that create. bpg does not read the membership back into state, so every
      # later plan sees `pool_id` as a change and re-adds a VM that is already in the pool, which
      # Proxmox refuses with `HTTP 500 - VM <id> is already a pool member`.
      #
      # Measured: the create succeeded, then the configure apply that follows it failed on the
      # re-add, so the instance never reached `active` and every subsequent operation failed the
      # same way. Ignoring it afterwards leaves the create doing the one thing it needs to.
      pool_id,
    ]
  }
}
