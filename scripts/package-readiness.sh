#!/usr/bin/env bash
# Builds local 0.3.0 package artifacts through each language's no-publish scripts/package and validates
# every manifest. It never publishes, signs, tags, pushes, or reads registry credentials.
#
#   scripts/package-readiness.sh --language <go|node|python|php|java|dotnet|ruby> --output <absolute-empty-directory>
#   scripts/package-readiness.sh --all --output <absolute-empty-directory>
#
# Artifacts land in <output>/<language>/. --all runs the seven languages serially in fixed order, keeps
# going after a failure so every problem is reported, and finally validates the complete aggregate.
set -Eeuo pipefail

readonly VERSION=0.3.0
readonly LANGUAGES=(go node python php java dotnet ruby)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly ROOT
readonly VALIDATOR="$ROOT/scripts/validate-package-manifest.py"

usage() {
  local IFS='|'
  echo "package-readiness: $1" >&2
  echo "usage: scripts/package-readiness.sh (--language <${LANGUAGES[*]}> | --all) --output <absolute-empty-directory>" >&2
  exit 2
}

selected=()
if [[ $# -eq 4 && $1 == --language && $3 == --output ]]; then
  for language in "${LANGUAGES[@]}"; do
    [[ $2 == "$language" ]] && selected=("$language")
  done
  [[ ${#selected[@]} -eq 1 ]] || usage "unknown language: $2"
  output=$4
elif [[ $# -eq 3 && $1 == --all && $2 == --output ]]; then
  selected=("${LANGUAGES[@]}")
  output=$3
else
  usage "expected --language <language> --output <directory> or --all --output <directory>"
fi

[[ $output == /* ]] || usage "output must be an absolute path"
case "$output/" in
  */./* | */../* | *//*) usage "output must not contain empty, '.', or '..' components" ;;
esac
parent="$(dirname "$output")"
[[ -d $parent ]] || usage "the parent of output must exist"
# Resolve the parent first so nothing is created when the output would fall inside the repository.
canonical="$(cd "$parent" && pwd -P)/$(basename "$output")"
case "$canonical/" in
  "$ROOT"/*) usage "output must be outside the repository" ;;
esac
if [[ -L $output ]]; then
  usage "output must not be a symbolic link"
elif [[ -e $output ]]; then
  [[ -d $output ]] || usage "output must be a directory"
  [[ -z $(ls -A "$output") ]] || usage "output directory must be empty so stale artifacts cannot be reused"
else
  mkdir "$output"
fi
output=$canonical
command -v python3 >/dev/null || { echo "package-readiness: python3 is required to validate manifests" >&2; exit 1; }

group() { [[ -n ${GITHUB_ACTIONS:-} ]] && echo "::group::$1" || echo "== $1"; }
endgroup() { [[ -n ${GITHUB_ACTIONS:-} ]] && echo "::endgroup::" || true; }

# Package scripts run in the background so an interrupt or cancellation reaches them promptly.
child_pid=''
child_language=''
on_signal() {
  if [[ -n $child_pid ]]; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  echo "package-readiness: interrupted${child_language:+ while packaging $child_language}" >&2
  exit 130
}
trap on_signal INT TERM

results=()
failed=0
for language in "${selected[@]}"; do
  script="$ROOT/$language/scripts/package"
  destination="$output/$language"
  group "$language package"
  status=0
  if [[ ! -x $script ]]; then
    echo "package-readiness: $language/scripts/package is missing or not executable" >&2
    status=1
  else
    mkdir "$destination"
    child_language=$language
    "$script" --version "$VERSION" --output "$destination" &
    child_pid=$!
    wait "$child_pid" || status=$?
    child_pid=''
    child_language=''
    if [[ $status -eq 0 ]]; then
      python3 "$VALIDATOR" "$destination/manifest.json" --language "$language" --version "$VERSION" || status=$?
    fi
  fi
  endgroup
  if [[ $status -eq 0 ]]; then
    results+=("$language: ok")
  else
    failed=1
    results+=("$language: FAILED (exit $status; partial output kept in $destination)")
  fi
done

if [[ $failed -eq 0 && ${#selected[@]} -eq ${#LANGUAGES[@]} ]]; then
  group "aggregate manifest validation"
  python3 "$VALIDATOR" --all "$output" || { failed=1; results+=("aggregate: FAILED"); }
  endgroup
fi

printf '\nPackage readiness (%s)\n' "$VERSION"
printf '  %s\n' "${results[@]}"
if [[ $failed -eq 0 ]]; then
  echo "Artifacts: $output"
fi
exit "$failed"
