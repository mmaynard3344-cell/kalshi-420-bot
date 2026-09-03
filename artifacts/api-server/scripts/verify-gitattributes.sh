#!/usr/bin/env bash
# verify-gitattributes.sh
# Exhaustively asserts that every file tracked by git under the two data trees
# has filter:unset (LFS disabled) UNLESS it is on the explicit LFS allowlist.
#
# Usage: run from the repository root.  Exits non-zero on any mismatch.
set -euo pipefail

# ── Intentional LFS allowlist ─────────────────────────────────────────────────
# Add a path here ONLY when deliberately routing a file through Git-LFS.
LFS_ALLOWED=(
  "artifacts/api-server/data/replays/3c74e738-ae65-4f44-ba40-c2ae1a9ad9ba.json"
  "data/replays/95b66b43-254f-40b6-9b9a-098a58cd3675.json"
)

is_lfs_allowed() {
  local path="$1"
  for allowed in "${LFS_ALLOWED[@]}"; do
    [[ "$path" == "$allowed" ]] && return 0
  done
  return 1
}

PASS=0
FAIL=0

check_file() {
  local path="$1"
  local got want
  got=$(git check-attr filter -- "$path" | awk -F': ' '{print $NF}')

  if is_lfs_allowed "$path"; then
    want="lfs"
  else
    want="unset"
  fi

  if [[ "$got" == "$want" ]]; then
    echo "  OK  [$got] $path"
    (( PASS++ )) || true
  else
    echo "FAIL  $path"
    echo "      expected filter:$want  got filter:$got"
    (( FAIL++ )) || true
  fi
}

echo "=== Checking all tracked files under artifacts/api-server/data/ and data/ ==="
echo ""

while IFS= read -r file; do
  check_file "$file"
done < <(git ls-files artifacts/api-server/data/ data/)

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
