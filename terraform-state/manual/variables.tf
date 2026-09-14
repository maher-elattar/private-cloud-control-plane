/**
 * Every server-specific value, with no defaults for anything that identifies the target.
 *
 * WHY no defaults on the target values: a default endpoint, node, storage or VMID would let a
 * partially-configured run act on the wrong machine. The same rule the provider factory applies
 * to its environment variables applies here.
 */

variable "node_name" {
  description = "The single Proxmox node. Surveyed value: proxtest."
  type        = string
}

variable "template_vm_id" {
  description = "VMID of the clone source. Surveyed value: 110, UbuntuNoble24.04."
  type        = number
}

variable "vm_id" {
  description = "VMID to create. Must sit inside the reserved 910000-910099 interval."
  type        = number

  validation {
    # The server hosts 211 machines belonging to other people. This interval is the boundary
    # that makes it impossible to touch one of them, so it is enforced here as well as in the
    # adapter rather than trusted to a careful operator.
    condition     = var.vm_id >= 910000 && var.vm_id <= 910099
    error_message = "vm_id must be inside the reserved interval 910000-910099."
  }
}

variable "hostname" {
  description = "VM name. Proxmox requires a valid DNS name."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$", var.hostname))
    error_message = "hostname must be a valid DNS label."
  }
}

variable "datastore_id" {
  description = "Storage for the cloned disk. Surveyed value: local, the only storage with images content."
  type        = string
}

variable "bridge" {
  description = "Network bridge. Surveyed value: vmbr1 at 192.168.4.1/22."
  type        = string
}

variable "network_mtu" {
  description = <<-EOT
    MTU for the NIC. The template carries mtu=1400 because vmbr1 has no physical ports and the
    host routes or encapsulates the traffic. A Terraform network_device block builds the NIC from
    scratch, so omitting this would hand the guest 1500 and break anything that cannot fragment.
  EOT
  type        = number
}

variable "cpu_cores" {
  description = "vCPU count."
  type        = number
}

variable "memory_mib" {
  description = "Memory in MiB."
  type        = number
}

variable "ipv4_address" {
  description = "Address to assign, without a prefix."
  type        = string
}

variable "ipv4_prefix_length" {
  description = "Prefix length. Must cover the gateway or the gateway is off-link."
  type        = number
}

variable "ipv4_gateway" {
  description = "Default gateway. Surveyed value: 192.168.4.1, the bridge address on the host."
  type        = string
}

variable "dns_servers" {
  description = "Resolvers for cloud-init."
  type        = list(string)
}

variable "cloud_init_username" {
  description = "Cloud-init user to create."
  type        = string
}

variable "cloud_init_password" {
  description = <<-EOT
    Cloud-init password. Lands in Terraform state in cleartext, which is why every state path in
    this repository is gitignored and the product backend restricts the state schema by role.
  EOT
  type        = string
  sensitive   = true
}

variable "ssh_public_keys" {
  description = "Authorized keys for the cloud-init user."
  type        = list(string)
  default     = []
}

variable "ownership_marker" {
  description = <<-EOT
    The control plane's ownership marker, written verbatim into the VM description.

    This exists in the by-hand configuration for one reason: to prove the marker survives a
    round trip through this provider byte-for-byte, so that parseOwnership succeeds on what
    Proxmox actually stores. If bpg normalises or re-encodes it, the whole ownership model needs
    rethinking, and that is far better discovered here than inside a purge.
  EOT
  type        = string
}

variable "dns_domain" {
  description = <<-EOT
    Cloud-init search domain. Declared explicitly because the template carries
    `searchdomain 1.1.1.1` and bpg cannot clear an inherited value — leaving it unset produces a
    permanent diff. See ../../docs/architecture/terraform-manual-walkthrough.md.
  EOT
  type        = string
}

variable "disk_gib" {
  description = "Primary disk size in GiB. Growth only: bpg refuses a shrink at apply time."
  type        = number
}

variable "started" {
  description = "Desired power state. Proven to be an in-place update, not a replacement."
  type        = bool
}
