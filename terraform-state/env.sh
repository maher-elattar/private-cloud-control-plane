#!/usr/bin/env bash
# Exports the Proxmox credentials that the bpg provider reads, from the gitignored credentials
# file at the repository root.
#
# WHY environment rather than HCL or a command line: a variable in HCL is a value in a tracked
# file, and a value on a command line lands in shell history and in the process table. SAFE-036
# governs what enters history; this keeps the secret out of both.
#
# The token is preferred over the administrator password. The password exists only so that
# tools/proxmox/create-api-token.mjs can re-mint the token, and rotating it does not invalidate
# the token.
#
# Usage:  source ./env.sh
set -eu
CREDENTIALS="${PROXMOX_CREDENTIALS:-$(git rev-parse --show-toplevel)/terraformProxServerTestCredntails.txt}"
[ -s "$CREDENTIALS" ] || { echo "credentials file is missing or empty: $CREDENTIALS" >&2; return 1 2>/dev/null || exit 1; }

_value() { sed -n "s/^$1=//p" "$CREDENTIALS" | head -1 | tr -d '\r'; }

PROXMOX_VE_ENDPOINT=$(_value PROXMOX_ENDPOINT)
_token_id=$(_value PROXMOX_API_TOKEN_ID)
_token_secret=$(_value PROXMOX_API_TOKEN_SECRET)

if [ -n "$_token_id" ] && [ -n "$_token_secret" ]; then
  # bpg's expected shape: user@realm!tokenid=secret
  PROXMOX_VE_API_TOKEN="${_token_id}=${_token_secret}"
  export PROXMOX_VE_API_TOKEN
  _how="token ${_token_id}"
  unset PROXMOX_VE_USERNAME PROXMOX_VE_PASSWORD 2>/dev/null || true
else
  # Fallback for a credentials file that predates the token, in the original three-line layout.
  PROXMOX_VE_ENDPOINT=$(sed -n '1p' "$CREDENTIALS" | tr -d '\r')
  _user=$(sed -n '2p' "$CREDENTIALS" | tr -d '\r')
  PROXMOX_VE_PASSWORD=$(sed -n '3p' "$CREDENTIALS" | tr -d '\r')
  case "$_user" in *@*) PROXMOX_VE_USERNAME="$_user";; *) PROXMOX_VE_USERNAME="$_user@pam";; esac
  export PROXMOX_VE_USERNAME PROXMOX_VE_PASSWORD
  _how="password $PROXMOX_VE_USERNAME"
fi

# The server presents a real Let's Encrypt certificate covering this name, so verification stays
# on. This must never become true.
PROXMOX_VE_INSECURE=false
export PROXMOX_VE_ENDPOINT PROXMOX_VE_INSECURE
unset _token_id _token_secret _user 2>/dev/null || true
echo "exported PROXMOX_VE_* using $_how at $PROXMOX_VE_ENDPOINT"
unset _how
