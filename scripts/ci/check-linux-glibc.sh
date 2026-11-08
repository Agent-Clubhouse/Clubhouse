#!/usr/bin/env bash
# Fail when node-pty's Linux binaries need a glibc newer than the first
# argument (#3080), so a runner or image change can't raise the oldest Linux
# the app runs on without someone deciding to. The second argument is where
# to look (default: out). Windows and macOS prebuilds have no glibc versions
# and are skipped.
set -euo pipefail

max="${1:?usage: check-linux-glibc.sh MAX_GLIBC [dir]}"
root="${2:-out}"
found=0
while IFS= read -r f; do
  # A file with no glibc versions (a Windows prebuild) matches nothing, which isn't a failure.
  need=$( { (objdump -T "$f" 2>/dev/null || true) | grep -o 'GLIBC_[0-9.]*' || true; } | sed 's/GLIBC_//' | sort -uV | tail -n 1)
  [ -z "$need" ] && continue
  found=1
  echo "$f needs glibc $need"
  if [ "$(printf '%s\n%s\n' "$need" "$max" | sort -V | tail -n 1)" != "$max" ]; then
    echo "::error::$f needs glibc $need, newer than $max."
    exit 1
  fi
done < <(find "$root" -path '*node-pty*' -type f \( -name '*.node' -o -name spawn-helper \))
if [ "$found" -eq 0 ]; then
  echo "::error::No Linux node-pty binary found under $root"
  exit 1
fi
echo "Every node-pty binary needs glibc $max or older"
