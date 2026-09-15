#!/usr/bin/env bash
# Runs the shared conformance fixtures for one or more SDK languages; see scripts/conformance.py.
#
#   scripts/conformance.sh                      # every language that has a runner
#   scripts/conformance.sh --language php       # one language (used by CI fan-out)
#
# Set MOCK_INGEST_SERVER_BIN to reuse a prebuilt mock binary; otherwise it is built with Go.
set -euo pipefail
command -v python3 >/dev/null || { echo "conformance: python3 is required" >&2; exit 1; }
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/conformance.py" "$@"
