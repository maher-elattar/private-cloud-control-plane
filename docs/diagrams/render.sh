#!/usr/bin/env bash

set -euo pipefail

diagram_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while IFS= read -r source; do
  output="${source%.d2}.svg"
  printf 'Rendering %s\n' "${source#"$diagram_dir"/}"
  d2 "$source" "$output"
done < <(find "$diagram_dir" -type f -name '*.d2' -print | sort)
