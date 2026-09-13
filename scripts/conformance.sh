#!/usr/bin/env bash
# Runs the shared conformance fixtures for one or more SDK languages. Each language gets its
# own mock ingest server process, so queues and journals are never shared.
#
#   scripts/conformance.sh                      # every language that has a runner
#   scripts/conformance.sh --language php       # one language (used by CI fan-out)
#
# Set MOCK_INGEST_SERVER_BIN to reuse a prebuilt mock binary; otherwise it is built with Go.
set -euo pipefail

LANGUAGES=(go node python php java dotnet ruby)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$ROOT/conformance/fixtures/cases"

usage() {
  echo "usage: scripts/conformance.sh [--language <$(IFS='|'; echo "${LANGUAGES[*]}")>]" >&2
  exit 2
}

selected=()
case "$#" in
  0)
    for language in "${LANGUAGES[@]}"; do
      if [[ -x "$ROOT/$language/scripts/conformance" ]]; then
        selected+=("$language")
      else
        echo "conformance: $language has no runner yet; not run" >&2
      fi
    done
    ;;
  2)
    [[ "$1" == "--language" ]] || usage
    printf '%s\n' "${LANGUAGES[@]}" | grep -qx -- "$2" || usage
    [[ -x "$ROOT/$2/scripts/conformance" ]] || { echo "conformance: $2/scripts/conformance is missing or not executable" >&2; exit 1; }
    selected=("$2")
    ;;
  *) usage ;;
esac
[[ ${#selected[@]} -gt 0 ]] || { echo "conformance: no language runners found" >&2; exit 1; }
[[ -d "$FIXTURES" ]] || { echo "conformance: fixture directory $FIXTURES is missing" >&2; exit 1; }

WORK="$(mktemp -d)"
MOCK_PID=""
stop_mock() {
  [[ -n "$MOCK_PID" ]] || return 0
  if kill -0 "$MOCK_PID" 2>/dev/null; then
    kill -TERM "$MOCK_PID" 2>/dev/null || true
    for _ in $(seq 1 60); do kill -0 "$MOCK_PID" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$MOCK_PID" 2>/dev/null; then
      echo "conformance: mock server ignored SIGTERM; killing it" >&2
      kill -KILL "$MOCK_PID" 2>/dev/null || true
    fi
  fi
  local status=0
  wait "$MOCK_PID" 2>/dev/null || status=$?
  MOCK_PID=""
  return "$status"
}
cleanup() {
  stop_mock || true
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

MOCK_BIN="${MOCK_INGEST_SERVER_BIN:-}"
if [[ -z "$MOCK_BIN" ]]; then
  MOCK_BIN="$WORK/mock-ingest-server"
  (cd "$ROOT/conformance/mock-ingest-server" && go build -o "$MOCK_BIN" ./cmd/mock-ingest-server)
fi
[[ -x "$MOCK_BIN" ]] || { echo "conformance: mock binary $MOCK_BIN is not executable" >&2; exit 1; }

summary=()
failed=0
for language in "${selected[@]}"; do
  echo "::group::conformance $language" 2>/dev/null || true
  ready="$WORK/$language.ready"
  "$MOCK_BIN" --listen 127.0.0.1:0 >"$ready" 2>"$WORK/$language.mock.stderr" &
  MOCK_PID=$!

  for _ in $(seq 1 100); do
    [[ -s "$ready" ]] && break
    kill -0 "$MOCK_PID" 2>/dev/null || break
    sleep 0.1
  done
  base_url="$(python3 - "$ready" <<'PY'
import json, sys, urllib.parse
lines = open(sys.argv[1]).read().splitlines()
record = json.loads(lines[0]) if len(lines) == 1 else None
if not isinstance(record, dict) or set(record) != {"base_url", "control_url"} or record["base_url"] != record["control_url"]:
    sys.exit("malformed readiness record")
url = urllib.parse.urlsplit(record["base_url"])
if url.scheme != "http" or url.hostname != "127.0.0.1" or url.path or url.query or url.fragment:
    sys.exit("readiness origin is not a loopback HTTP origin")
print(record["base_url"])
PY
  )" || { echo "conformance: $language mock server did not report readiness" >&2; cat "$WORK/$language.mock.stderr" >&2; exit 1; }

  reset_ok=""
  for _ in $(seq 1 100); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base_url/__control/reset" || true)"
    [[ "$code" == "204" ]] && { reset_ok=1; break; }
    sleep 0.1
  done
  [[ -n "$reset_ok" ]] || { echo "conformance: $language mock control API never became ready" >&2; exit 1; }

  log="$WORK/$language.runner.log"
  set +e
  # Pass exactly the four contract variables; drop any other CEKAT_CONFORMANCE_* from the caller.
  env $(env | sed -n 's/^\(CEKAT_CONFORMANCE_[^=]*\)=.*/-u \1/p') \
    CEKAT_CONFORMANCE_BASE_URL="$base_url" \
    CEKAT_CONFORMANCE_CONTROL_URL="$base_url" \
    CEKAT_CONFORMANCE_ACCESS_TOKEN="conformance-token" \
    CEKAT_CONFORMANCE_FIXTURES="$FIXTURES" \
    "$ROOT/$language/scripts/conformance" 2>&1 | tee "$log"
  runner_status=${PIPESTATUS[0]}
  set -e

  mock_status=0
  stop_mock || mock_status=$?
  passed="$(grep -c '"status":"passed"' "$log" || true)"
  not_applicable="$(grep -c '"status":"not_applicable"' "$log" || true)"
  echo "::endgroup::" 2>/dev/null || true
  if [[ "$runner_status" -ne 0 || "$mock_status" -ne 0 ]]; then
    failed=1
    summary+=("$language: FAILED (runner exit $runner_status, mock exit $mock_status; $passed passed, $not_applicable not_applicable)")
    [[ "$mock_status" -eq 0 ]] || cat "$WORK/$language.mock.stderr" >&2
  else
    summary+=("$language: ok ($passed passed, $not_applicable not_applicable)")
  fi
done

printf '\nConformance summary\n'
printf '  %s\n' "${summary[@]}"
exit "$failed"
