/**
 * Every value the control plane renders into a tfvars file for one instance.
 *
 * No defaults on anything that identifies the target. A default endpoint, node, storage or VMID
 * would let a partially-rendered run act on the wrong machine — the same rule the provider factory
 * applies to its environment.
 *
 * Every attribute the clone template sets is declared here, and that is not thoroughness for its
 * own sake: bpg cannot *clear* an inherited value, only overwrite it, so anything the template
 * sets and the configuration leaves empty produces a diff that never converges. Measured; see
 * docs/architecture/terraform-manual-walkthrough.md finding 3.
 */

variable "node_name" {
  description = "The single allowlisted Proxmox node."
  type        = string
}

variable "template_vm_id" {
  description = "VMID of the clone source."
  type        = number
}

variable "vm_id" {
  description = "VMID to create, inside the reserved interval."
  type        = number

  validation {
    # Enforced here as well as in the adapter. The target may host machines belonging to other
    # people, and this interval is the boundary that makes it impossible to touch one.
    condition     = var.vm_id >= 910000 && var.vm_id <= 910099
    error_message = "vm_id must be inside the reserved interval 910000-910099."
  }
}

variable "hostname" {
  description = "VM name. Proxmox requires a valid DNS label."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$", var.hostname))
    error_message = "hostname must be a valid DNS label."
  }
}

variable "ownership_marker" {
  description = <<-EOT
    The control plane's ownership marker, written verbatim as the first line of the description.

    Proved to round-trip byte-for-byte through this provider, which is what allows `parseOwnership`
    to succeed on what Proxmox stores. Any trailer the control plane appends goes on later lines;
    the marker must stay first.
  EOT
  type        = string
}

variable "tags" {
  description = "Proxmox tags, mirroring the ownership markers for operator visibility."
  type        = list(string)
  default     = []
}

variable "datastore_id" {
  description = "Storage for the cloned disk and the cloud-init drive."
  type        = string
}

variable "disk_interface" {
  description = "Disk bus, matching the template."
  type        = string
}

variable "disk_gib" {
  description = <<-EOT
    Primary disk size in GiB. Growth only.

    On create this must equal the template's disk exactly, because `assertResources` compares them
    and refuses anything else. On resize bpg refuses a shrink at apply time, and the control plane
    refuses one at admission — the second of those is the load-bearing one, because a refused
    shrink still writes the rejected size into state.
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

variable "bridge" {
  description = "The allowlisted network bridge."
  type        = string
}

variable "network_mtu" {
  description = <<-EOT
    NIC MTU, which must match the template's.

    The direct adapter preserves this by accident, rewriting only the `bridge=` component of the
    inherited NIC. A `network_device` block builds the NIC from scratch, so leaving this unset
    hands the guest 1500 and breaks anything that cannot fragment.
  EOT
  type        = number
}

variable "ipv4_address" {
  description = "Leased address, without a prefix."
  type        = string
}

variable "ipv4_prefix_length" {
  description = "Prefix length. Must cover the gateway, or the gateway is off-link."
  type        = number
}

variable "ipv4_gateway" {
  description = "Default gateway."
  type        = string
}

variable "dns_servers" {
  description = "Resolvers for cloud-init."
  type        = list(string)
}

variable "dns_domain" {
  description = <<-EOT
    Cloud-init search domain.

    Declared rather than left to default because the template sets `searchdomain`, and an
    inherited value the configuration leaves empty diffs forever.
  EOT
  type        = string
}

variable "cloud_init_username" {
  description = "Cloud-init user to create."
  type        = string
}

variable "cloud_init_password" {
  description = <<-EOT
    Cloud-init password.

    Lands in Terraform state in cleartext, which is why the state schema restricts writes to the
    runner role and reads to `SELECT` for the application, why every state path is gitignored, and
    why `TF_LOG` is removed from the runner's environment.
  EOT
  type        = string
  sensitive   = true
}

variable "ssh_public_keys" {
  description = <<-EOT
    Authorized keys for the cloud-init user.

    A non-empty list replaces the Proxmox-side key list cleanly. An **empty** list does not clear
    it, and separately the golden template may carry a key baked into the image that cloud-init
    cannot remove at all — see the walkthrough's finding 4. That is an image-hygiene problem, not
    one this module can solve.
  EOT
  type        = list(string)
  default     = []
}

variable "started" {
  description = "Desired power state. An in-place update, not a replacement."
  type        = bool
  default     = true
}

variable "on_boot" {
  description = "Start with the host. Cleared when an instance is retained."
  type        = bool
  default     = false
}
