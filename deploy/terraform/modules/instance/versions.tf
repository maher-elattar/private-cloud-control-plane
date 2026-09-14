/**
 * Provider pin, exact rather than a constraint.
 *
 * This is the only Terraform the control plane applies against real hardware, and "whatever
 * resolved today" is not a property worth having there. `.terraform.lock.hcl` carries the hashes,
 * and the runner initialises from a vendored plugin directory rather than the registry.
 */
terraform {
  required_version = ">= 1.9.0"

  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "0.113.1"
    }
  }
}
