/**
 * Provider pin for the by-hand exploration.
 *
 * The version is exact, not a constraint. This is the only code in the repository that can
 * affect real hardware, and "whatever resolved today" is not a property worth having there.
 * `.terraform.lock.hcl` beside this file carries the hashes.
 */
terraform {
  required_version = ">= 1.9.0"

  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "0.113.1"
    }
  }

  # Local backend, deliberately. The by-hand phase must not write into the control-plane
  # database before the terraform_remote_state schema and its grants exist. See ../README.md.
}

# Every credential arrives through PROXMOX_VE_* in the environment; see ../env.sh.
# Nothing is configured here, so nothing secret can be committed here.
provider "proxmox" {}
