/**
 * What the by-hand run needs to read back, and what the adapter will later need to observe.
 *
 * No output exposes cloud-init credentials. `terraform output` is frequently piped into logs and
 * transcripts, and the password is already in state; it does not need a second home.
 */

output "vm_id" {
  description = "The allocated VMID."
  value       = proxmox_virtual_environment_vm.instance.vm_id
}

output "name" {
  description = "The VM name Proxmox recorded."
  value       = proxmox_virtual_environment_vm.instance.name
}

output "description_roundtrip" {
  description = "The description Proxmox stored. Compared against the marker sent, byte-for-byte."
  value       = proxmox_virtual_environment_vm.instance.description
}

output "ipv4_addresses" {
  description = "Addresses the guest agent reports, which is how observeInstance will read them."
  value       = proxmox_virtual_environment_vm.instance.ipv4_addresses
}

output "mac_addresses" {
  description = "NIC addresses, for confirming the ignore_changes rule is pinned to the right one."
  value       = proxmox_virtual_environment_vm.instance.mac_addresses
}
