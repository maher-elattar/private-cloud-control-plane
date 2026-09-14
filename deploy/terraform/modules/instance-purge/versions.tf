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

  # State lives in the control plane's own PostgreSQL, one workspace per instance.
  #
  # Empty here and completed by `-backend-config=conn_str=...` at init: the connection string
  # carries a password, and SAFE-036 governs what enters history. It is supplied from the
  # environment by the runner and never written to a file.
  #
  # WHY the pg backend rather than a file or object store: it locks state with a Postgres
  # advisory lock keyed on the state row, so one workspace per instance gives that lock the same
  # granularity as the per-instance lease the control plane already holds. The two agree instead
  # of fighting. It also has no force-unlock, deliberately — a killed runner releases its lock by
  # dying, which is the behaviour we want.
  backend "pg" {}
}
