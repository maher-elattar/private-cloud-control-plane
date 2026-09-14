# terraform-state

The laboratory for the Terraform-backed provisioning work, and the archive of plan captures it
produces. **This is not the product.** The module the control plane actually drives lives at
`deploy/terraform/modules/instance/`; this folder exists so the provider's real behaviour can be
learned by hand first, against the real server, before any of it is wired into a workflow.

| Path | Tracked | Purpose |
| --- | --- | --- |
| `manual/` | yes, except real variable values | HCL driven by hand against the test server |
| `manual/terraform.tfvars` | **no** | Real addresses and the cloud-init password |
| `fixtures/` | yes | Redacted `terraform show -json` captures |
| `runs/` | no | Raw command transcripts |

## Why a local backend here

`manual/` deliberately uses Terraform's local backend rather than the `pg` backend the design
specifies. The by-hand phase must not write into the control-plane database before that schema
and its grants exist, and a state file under a gitignored directory is the simplest thing that
cannot leak. The product module uses `pg`.

## Why the captures are kept

`fixtures/` is the input to the plan gate's tests. The gate refuses any plan containing a
`delete` action, and testing it against *invented* plan JSON would only prove the fixtures match
the parser. These captures are real plans from real hardware, so a test over them proves the gate
refuses what this provider actually emits.

## Credentials

Supplied as `PROXMOX_VE_*` environment variables, never in HCL and never on a command line:

```bash
source ./env.sh          # reads the gitignored credentials file and exports
terraform -chdir=manual init
```

## The reserved interval

Every VM created from this folder must sit inside VMIDs 910000-910099. The server hosts 211
machines belonging to other people; that interval is the boundary that makes it impossible to
touch one of them. Nothing here may destroy anything outside it, and nothing automated may
destroy anything at all.
