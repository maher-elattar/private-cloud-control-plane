/**
 * One cloned VM, by hand, against the real Proxmox test server.
 *
 * PATTERN — laboratory, not product. This mirrors what `deploy/terraform/modules/instance/` will
 * declare, so that every argument spelling, in-place update and forced replacement is measured
 * here before a workflow depends on it. The product module is promoted from what this proves.
 *
 * Deliberately minimal to begin with: no `disk` block, so the clone inherits the template's disk
 * untouched. bpg documents that declaring disk attributes on a clone can let schema defaults
 * override inherited values, so the first apply establishes the inherit behaviour and the disk
 * block is introduced as a separate, observed step.
 *
 * @see ../README.md
 * @see ../../terraform-provisioning-plan.md
 */

resource "proxmox_virtual_environment_vm" "instance" {
  node_name   = var.node_name
  vm_id       = var.vm_id
  name        = var.hostname
  description = var.ownership_marker

  # Full clone, so the instance does not depend on the template's disk staying put.
  clone {
    vm_id        = var.template_vm_id
    datastore_id = var.datastore_id
    full         = true
  }

  # `host` matches the template. A different CPU type would be a config change on first apply.
  cpu {
    cores   = var.cpu_cores
    sockets = 1
    type    = "host"
    # WHY hotplugged is declared: it maps to Proxmox's `vcpus`, which the template sets to 2. Left
    # unset, bpg computes 0, plans a change to clear it, and the clear does not stick — a
    # permanent diff of exactly the kind finding 3 describes. Matching the core count is also what
    # a VM without CPU hotplug should report.
    hotplugged = var.cpu_cores
  }

  memory {
    dedicated = var.memory_mib
  }

  # Declared to match the template exactly, so that adding the block is a no-op rather than a
  # change. bpg warns that declaring disk attributes on a clone lets schema defaults override
  # inherited values, so every attribute the template sets is repeated here rather than defaulted.
  disk {
    datastore_id = var.datastore_id
    interface    = "scsi0"
    size         = var.disk_gib
    discard      = "on"
    iothread     = true
    ssd          = true
    file_format  = "raw"
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

  # Inline cloud-init only. The snippet-file attributes (user_data_file_id and its siblings) are
  # ForceNew in this provider, so editing cloud-init through them would ask Terraform to destroy
  # a running VM — which SAFE-028 forbids. They are never set.
  initialization {
    # WHY this is set explicitly: bpg defaults the cloud-init drive's datastore to `local-lvm`,
    # which does not exist on this host. Omitting it clones the VM successfully and then fails
    # attaching the cloud-init disk, which leaves the resource tainted — and a tainted resource
    # is REPLACED on the next apply, i.e. destroyed. Measured, not assumed: see
    # ../fixtures/plan-replace-tainted.json.
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

  started = var.started
  on_boot = false

  machine       = "q35"
  scsi_hardware = "virtio-scsi-single"

  operating_system {
    type = "l26"
  }

  lifecycle {
    ignore_changes = [
      # The provider assigns the MAC, and the control plane does not own it. Without this, a NIC
      # rebuild would churn the address on every plan.
      network_device[0].mac_address,
      # WHY the clone block is ignored after creation: Proxmox does not record what a VM was
      # cloned from, so `terraform import` reconstructs an empty clone block. Every clone
      # sub-attribute is ForceNew, so without this the importer sees the block being *added* and
      # plans a destroy-and-create. That is measured, not theorised — see
      # ../fixtures/plan-replace-after-import.json. Orphan adoption (design SS6.5) is impossible
      # without it.
      clone,
    ]
  }
}
