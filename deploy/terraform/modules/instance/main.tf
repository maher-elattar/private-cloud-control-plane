/**
 * One control-plane instance, as a cloned Proxmox VM.
 *
 * PATTERN — ports and adapters, at the infrastructure layer. This module is the only Terraform the
 * control plane applies for an instance, and every argument in it was proved by hand against real
 * hardware before it was written here. Where a value looks redundant, it is preventing a diff that
 * never converges; the reason is recorded beside it or in the variable's description.
 *
 * **This module cannot destroy.** `prevent_destroy` refuses any plan that would, which is the
 * second of three layers: the module sets no ForceNew attribute, this block refuses a destroy, and
 * the plan gate refuses any plan whose actions contain a delete. The purge path uses the sibling
 * `instance-purge` module, which differs from this one *only* in its lifecycle block —
 * `pnpm run terraform:check-modules` fails if anything else diverges.
 *
 * @see docs/architecture/terraform-manual-walkthrough.md
 * @see terraform-provisioning-plan.md
 */

resource "proxmox_virtual_environment_vm" "instance" {
  node_name   = var.node_name
  vm_id       = var.vm_id
  name        = var.hostname
  description = var.ownership_marker
  tags        = var.tags

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
    prevent_destroy = true

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
    ]
  }
}
