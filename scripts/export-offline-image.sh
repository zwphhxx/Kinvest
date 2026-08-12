#!/usr/bin/env bash
set -euo pipefail

SOURCE_REFERENCE="${1:-}"
OUTPUT_PATH="${2:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
VERIFIER="$REPOSITORY_ROOT/deploy/server/offline-image-attestation.py"
TEMPORARY_PATH=''

usage() {
  printf '%s\n' 'usage: export-offline-image.sh <full-ghcr-digest-ref> <absolute-output.tar>' >&2
  exit 2
}

cleanup() {
  if [[ -n "$TEMPORARY_PATH" ]]; then
    rm -f -- "$TEMPORARY_PATH"
  fi
}

on_signal() {
  exit "$1"
}

trap cleanup EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

if [[ "$#" -ne 2 ]]; then
  usage
fi
if [[ "$(uname -s)" != 'Darwin' ]]; then
  printf '%s\n' 'offline image export must run on macOS' >&2
  exit 1
fi
if [[ ! "$SOURCE_REFERENCE" =~ ^ghcr\.io/zwphhxx/kinvest@sha256:[0-9a-f]{64}$ ]]; then
  usage
fi
if [[ "$OUTPUT_PATH" != /* || "$OUTPUT_PATH" != *.tar ]]; then
  usage
fi
if [[ -e "$OUTPUT_PATH" || -L "$OUTPUT_PATH" ]]; then
  printf '%s\n' 'offline image export output already exists' >&2
  exit 2
fi
if [[ ! -d "$(dirname -- "$OUTPUT_PATH")" ]]; then
  printf '%s\n' 'offline image export output directory does not exist' >&2
  exit 2
fi
if [[ ! -f "$VERIFIER" || -L "$VERIFIER" ]]; then
  printf '%s\n' 'offline image verifier is unavailable' >&2
  exit 1
fi

umask 077
TEMPORARY_PATH="$(mktemp "$OUTPUT_PATH.temporary.XXXXXX")"
chmod 0600 "$TEMPORARY_PATH"

docker pull --platform linux/amd64 "$SOURCE_REFERENCE" >/dev/null
repo_digests="$(
  docker image inspect \
    --format '{{range .RepoDigests}}{{println .}}{{end}}' \
    "$SOURCE_REFERENCE"
)"
repo_digest_verified='false'
while IFS= read -r repo_digest; do
  if [[ "$repo_digest" == "$SOURCE_REFERENCE" ]]; then
    repo_digest_verified='true'
  fi
done <<< "$repo_digests"
if [[ "$repo_digest_verified" != 'true' ]]; then
  printf '%s\n' 'offline image export could not verify the exact RepoDigest' >&2
  exit 1
fi

docker image save --output "$TEMPORARY_PATH" "$SOURCE_REFERENCE"
if [[ ! -f "$TEMPORARY_PATH" || -L "$TEMPORARY_PATH" ]]; then
  printf '%s\n' 'offline image export did not produce a regular archive' >&2
  exit 1
fi
chmod 0600 "$TEMPORARY_PATH"

archive_checksum="$(shasum -a 256 "$TEMPORARY_PATH" | awk '{print $1}')"
if [[ ! "$archive_checksum" =~ ^[0-9a-f]{64}$ ]]; then
  printf '%s\n' 'offline image export checksum is invalid' >&2
  exit 1
fi

verification_output="$(
  python3 "$VERIFIER" verify-archive \
    "$TEMPORARY_PATH" "$archive_checksum" "$SOURCE_REFERENCE"
)"
if [[ ! "$verification_output" =~ ^KINVEST_OFFLINE_ARCHIVE_OK\ runtimeImageId=sha256:[0-9a-f]{64}$ ]]; then
  printf '%s\n' 'offline image verifier returned an invalid result' >&2
  exit 1
fi
verified_runtime_image_id="${verification_output#KINVEST_OFFLINE_ARCHIVE_OK runtimeImageId=}"

verification_metadata="$(
  python3 - "$VERIFIER" "$TEMPORARY_PATH" "$archive_checksum" "$SOURCE_REFERENCE" <<'PY'
import importlib.util
import sys

helper_path, archive_path, archive_checksum, source_reference = sys.argv[1:]
spec = importlib.util.spec_from_file_location("kinvest_offline_image_attestation", helper_path)
if spec is None or spec.loader is None:
    raise SystemExit(1)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
verified = module.verify_archive(archive_path, archive_checksum, source_reference)
print(f"platform_manifest_digest={verified.platform_manifest_digest}")
print(f"runtime_image_id={verified.runtime_image_id}")
PY
)"
platform_manifest_line="${verification_metadata%%$'\n'*}"
runtime_image_line="${verification_metadata#*$'\n'}"
if [[ "$platform_manifest_line" == "$verification_metadata" || "$runtime_image_line" == *$'\n'* ]]; then
  printf '%s\n' 'offline image verifier metadata is invalid' >&2
  exit 1
fi
platform_manifest_digest="${platform_manifest_line#platform_manifest_digest=}"
runtime_image_id="${runtime_image_line#runtime_image_id=}"
if [[ "$platform_manifest_line" != "platform_manifest_digest=$platform_manifest_digest" \
  || "$runtime_image_line" != "runtime_image_id=$runtime_image_id" \
  || ! "$platform_manifest_digest" =~ ^sha256:[0-9a-f]{64}$ \
  || ! "$runtime_image_id" =~ ^sha256:[0-9a-f]{64}$ \
  || "$runtime_image_id" != "$verified_runtime_image_id" ]]; then
  printf '%s\n' 'offline image verifier metadata is invalid' >&2
  exit 1
fi

archive_size="$(wc -c < "$TEMPORARY_PATH" | tr -d '[:space:]')"
if [[ ! "$archive_size" =~ ^[1-9][0-9]*$ ]]; then
  printf '%s\n' 'offline image export size is invalid' >&2
  exit 1
fi
if [[ -e "$OUTPUT_PATH" || -L "$OUTPUT_PATH" ]]; then
  printf '%s\n' 'offline image export output appeared during export' >&2
  exit 1
fi
mv -n -- "$TEMPORARY_PATH" "$OUTPUT_PATH"
if [[ -e "$TEMPORARY_PATH" ]]; then
  printf '%s\n' 'offline image export refused to replace an existing output' >&2
  exit 1
fi
TEMPORARY_PATH=''

printf 'path=%s\n' "$OUTPUT_PATH"
printf 'checksum=sha256:%s\n' "$archive_checksum"
printf 'size=%s\n' "$archive_size"
printf 'source=%s\n' "$SOURCE_REFERENCE"
printf '%s\n' 'platform=linux/amd64'
printf 'platformManifest=%s\n' "$platform_manifest_digest"
printf 'runtimeImageId=%s\n' "$runtime_image_id"
