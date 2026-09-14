#!/usr/bin/env bash
# Exports the Proxmox credentials that the bpg provider reads, from the gitignored
# three-line credentials file at the repository root.
#
# WHY environment rather than HCL or a command line: a variable in HCL is a value in a
# tracked file, and a value on a command line lands in shell history and in the process
# table. SAFE-036 governs what enters history; this keeps the password out of both.
#
# Usage:  source ./env.sh
set -eu
CREDENTIALS="${PROXMOX_CREDENTIALS:-$(git rev-parse --show-toplevel)/terraformProxServerTestCredntails.txt}"
[ -s "$CREDENTIALS" ] || { echo "credentials file is missing or empty: $CREDENTIALS" >&2; return 1 2>/dev/null || exit 1; }

PROXMOX_VE_ENDPOINT=$(sed -n '1p' "$CREDENTIALS" | tr -d '\r')
_user=$(sed -n '2p' "$CREDENTIALS" | tr -d '\r')
PROXMOX_VE_PASSWORD=$(sed -n '3p' "$CREDENTIALS" | tr -d '\r')
# Proxmox rejects a username without a realm; the web UI sends root@pam.
case "$_user" in *@*) PROXMOX_VE_USERNAME="$_user";; *) PROXMOX_VE_USERNAME="$_user@pam";; esac
# The server presents a real Let's Encrypt certificate covering this name, so verification
# stays on. This must never become true.
PROXMOX_VE_INSECURE=false

export PROXMOX_VE_ENDPOINT PROXMOX_VE_USERNAME PROXMOX_VE_PASSWORD PROXMOX_VE_INSECURE
unset _user
echo "exported PROXMOX_VE_* for $PROXMOX_VE_USERNAME at $PROXMOX_VE_ENDPOINT"
