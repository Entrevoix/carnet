#!/usr/bin/env bash
# check-stale-plans.sh — verify the .claude/PRPs/plans/ lifecycle machine-checkably.
#
# Issue #92: a prior audit found plans in plans/ that described already-shipped work,
# costing a full human audit cycle to catch. This script makes that check automatic:
#
#   1. Every *.plan.md directly under .claude/PRPs/plans/ must carry a `Status:` header
#      (a line `Status: <value>` in its first 10 lines) whose value is exactly one of:
#      draft, in-progress, shipped.
#   2. Any plan marked `Status: shipped` must live in .claude/PRPs/plans/completed/, not
#      .claude/PRPs/plans/ itself — that's the actual point of the check.
#
# Scope note: this checks *.plan.md only, not every *.md in plans/. Several files in
# plans/ (session handoffs, backlog audits) are not lifecycle-tracked plans — they are
# point-in-time records, not documents that move through draft -> in-progress -> shipped.
# Giving them a Status header would be fiction. If that convention changes, widen the
# glob below to *.md and add a `Status:` header to those files too.
#
# Exit 0 on a clean tree, non-zero (with each violation printed) otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"

# `--self-test` runs the checker against synthetic fixtures instead of the repo.
# It exists because the real tree currently holds ZERO *.plan.md files (every
# plan turned out to be shipped and was moved to completed/), so a clean run
# passes over an empty glob — which proves nothing. Without this, the only
# evidence the checker actually catches anything would be a fixture someone
# created by hand once and deleted. Run it in CI alongside the real check.
if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  fail=0

  expect() { # expect <expected-exit> <case-name>
    set +e
    out="$("$0" "$tmp/plans" 2>&1)"; got=$?
    set -e
    if [ "$got" -ne "$1" ]; then
      echo "SELF-TEST FAIL: $2 — expected exit $1, got $got"
      printf '%s\n' "$out" | sed 's/^/    /'
      fail=1
    else
      echo "SELF-TEST ok: $2 (exit $got)"
    fi
    rm -f "$tmp"/plans/*.plan.md
  }

  mkdir -p "$tmp/plans/completed"

  printf 'Status: draft\n\n# X\n'       > "$tmp/plans/a.plan.md"; expect 0 "draft plan passes"
  printf 'Status: in-progress\n\n# X\n' > "$tmp/plans/a.plan.md"; expect 0 "in-progress plan passes"
  printf 'Status: shipped\n\n# X\n'     > "$tmp/plans/a.plan.md"; expect 1 "shipped plan in plans/ is flagged"
  printf '# X\n\nno header\n'           > "$tmp/plans/a.plan.md"; expect 1 "missing Status header is flagged"
  printf 'Status: wibble\n\n# X\n'      > "$tmp/plans/a.plan.md"; expect 1 "invalid Status value is flagged"
  printf 'Status: shipped\n'            > "$tmp/plans/completed/a.plan.md"
  printf 'Status: draft\n\n# X\n'       > "$tmp/plans/a.plan.md"; expect 0 "shipped plan in completed/ is fine"
  rm -f "$tmp/plans/completed/a.plan.md"
  # A Status buried past the header window must not count.
  { printf 'line\n%.0s' $(seq 1 12); printf 'Status: draft\n'; } > "$tmp/plans/a.plan.md"
  expect 1 "Status below line 10 does not count"
  # Non-plan .md files are out of scope and must not be checked.
  printf '# handoff, no status\n' > "$tmp/plans/session-handoff.md"
  printf 'Status: draft\n\n# X\n' > "$tmp/plans/a.plan.md"; expect 0 "non-*.plan.md files are ignored"

  echo "---"
  [ "$fail" -eq 0 ] && echo "check-stale-plans --self-test: all cases passed" || echo "check-stale-plans --self-test: FAILURES"
  exit "$fail"
fi

# Optional first arg overrides the plans dir (used by --self-test).
PLANS_DIR="${1:-$REPO_ROOT/.claude/PRPs/plans}"
VALID_STATUS_RE='^(draft|in-progress|shipped)$'

if [ ! -d "$PLANS_DIR" ]; then
  echo "check-stale-plans: plans directory not found: $PLANS_DIR" >&2
  exit 1
fi

violations=0
checked=0

shopt -s nullglob
plan_files=("$PLANS_DIR"/*.plan.md)
shopt -u nullglob

for file in "${plan_files[@]}"; do
  [ -f "$file" ] || continue
  checked=$((checked + 1))

  status_line="$(head -n 10 -- "$file" | grep -m1 -E '^Status:[[:space:]]*' || true)"

  if [ -z "$status_line" ]; then
    echo "VIOLATION: $file — missing a 'Status:' header in the first 10 lines"
    violations=$((violations + 1))
    continue
  fi

  status_value="$(printf '%s\n' "$status_line" | sed -E 's/^Status:[[:space:]]*//; s/[[:space:]]+$//')"

  if ! printf '%s\n' "$status_value" | grep -qE "$VALID_STATUS_RE"; then
    echo "VIOLATION: $file — Status value '$status_value' is not one of: draft, in-progress, shipped"
    violations=$((violations + 1))
    continue
  fi

  if [ "$status_value" = "shipped" ]; then
    echo "VIOLATION: $file — marked Status: shipped but still in plans/ (move it to plans/completed/)"
    violations=$((violations + 1))
  fi
done

echo "---"
if [ "$violations" -eq 0 ]; then
  echo "check-stale-plans: OK — 0 violations across $checked plan file(s) in $PLANS_DIR"
  exit 0
else
  echo "check-stale-plans: FAILED — $violations violation(s) across $checked plan file(s)"
  exit 1
fi
