#!/usr/bin/env bash
# Classifies each attribute change as in-place update or forced replacement, by planning only.
# Plan is non-mutating, so this touches nothing on the server.
set -u
set -a; . ./env.sh >/dev/null 2>&1; set +a
BASE=manual/terraform.tfvars
cp "$BASE" "$BASE.backup"

classify() {
  local label="$1" sed_expr="$2"
  cp "$BASE.backup" "$BASE"
  sed -i "$sed_expr" "$BASE"
  terraform -chdir=manual plan -no-color -input=false -out="plan-exp.tfplan" > "runs/exp-$label.txt" 2>&1
  local code=$?
  if [ $code -ne 0 ] && ! grep -q 'Saved the plan' "runs/exp-$label.txt"; then
    printf '%-28s ERROR: %s\n' "$label" "$(grep -m1 'Error:' runs/exp-$label.txt | head -c 90)"
    return
  fi
  terraform -chdir=manual show -json "plan-exp.tfplan" > "runs/exp-$label.json" 2>&1
  python3 - "$label" "runs/exp-$label.json" <<'PY'
import json, sys
label, path = sys.argv[1], sys.argv[2]
d = json.load(open(path))
rc = d.get('resource_changes', [])
if not rc:
    print(f"{label:28} no-op")
else:
    e = rc[0]
    actions = '+'.join(e['change']['actions'])
    reason = e.get('action_reason') or ''
    paths = e['change'].get('replace_paths') or ''
    print(f"{label:28} {actions:14} {reason:26} {paths if paths else ''}")
PY
}

printf '%-28s %-14s %-26s %s\n' EXPERIMENT ACTIONS ACTION_REASON REPLACE_PATHS
printf '%s\n' "----------------------------------------------------------------------------------------"
classify cpu-increase       's/cpu_cores  = 2/cpu_cores  = 4/'
classify memory-increase    's/memory_mib = 4096/memory_mib = 8192/'
classify ip-address-change  's|ipv4_address       = "192.168.4.2"|ipv4_address       = "192.168.4.3"|'
classify dns-servers-change 's|dns_servers        = \["1.1.1.1"\]|dns_servers        = ["9.9.9.9"]|'
classify hostname-change    's/hostname       = "tf-manual-01"/hostname       = "tf-manual-02"/'
classify cloudinit-user     's/cloud_init_username = "ubuntu"/cloud_init_username = "operator"/'
classify vmid-change        's/vm_id          = 910000/vm_id          = 910001/'
classify marker-change      's|"instanceId":\\"00000000-0000-4000-8000-0000000000aa\\"|"instanceId":\\"00000000-0000-4000-8000-0000000000cc\\"|'

cp "$BASE.backup" "$BASE"
rm -f "$BASE.backup" manual/plan-exp.tfplan
echo "--- tfvars restored ---"
