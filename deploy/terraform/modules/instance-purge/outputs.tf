/**
 * What the adapter reads back after an apply.
 *
 * No output exposes cloud-init credentials. `terraform output` is routinely piped into logs and
 * transcripts, and the password is already in state; it does not need a second home.
 */

output "vm_id" {
  description = "The allocated VMID, which becomes the instance's providerResourceId."
  value       = proxmox_virtual_environment_vm.instance.vm_id
}

output "name" {
  description = "The VM name Proxmox recorded."
  value       = proxmox_virtual_environment_vm.instance.name
}

output "description" {
  description = "The stored description, compared against the ownership marker sent."
  value       = proxmox_virtual_environment_vm.instance.description
}

output "ipv4_addresses" {
  description = "Addresses the guest agent reports. How observeInstance learns the real IP."
  value       = proxmox_virtual_environment_vm.instance.ipv4_addresses
}

output "mac_addresses" {
  description = "NIC addresses, for confirming the ignore_changes rule targets the right one."
  value       = proxmox_virtual_environment_vm.instance.mac_addresses
}
