#!/usr/bin/env bash
set -euo pipefail

SOURCE_REFERENCE="${1:-}"
OUTPUT_PATH="${2:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
VERIFIER="$REPOSITORY_ROOT/deploy/server/offline-image-attestation.py"
TEMPORARY_PATH=''
PUBLICATION_STATE=''
ANCHOR_DIRECTORY=''
ANCHOR_DIRECTORY_IDENTITY=''
ANCHOR_PATH=''
SUCCESS_METADATA_COMPLETED='false'

usage() {
  printf '%s\n' 'usage: export-offline-image.sh <full-ghcr-digest-ref> <absolute-output.tar>' >&2
  exit 2
}

cleanup() {
  cleanup_status="$?"
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  if [[ "$SUCCESS_METADATA_COMPLETED" != 'true' && -n "$PUBLICATION_STATE" && -f "$PUBLICATION_STATE" ]]; then
    python3 - cleanup-created-link "$PUBLICATION_STATE" "$OUTPUT_PATH" <<'PY' || true
import os
import stat
import sys

mode, state_path, output_path = sys.argv[1:]
if mode != "cleanup-created-link":
    raise SystemExit(1)
try:
    with open(state_path, "r", encoding="ascii") as state:
        fields = state.read().split()
    if len(fields) != 3 or fields[0] != "armed":
        raise SystemExit(0)
    expected_device, expected_inode = map(int, fields[1:])
    target = os.lstat(output_path)
    if (
        stat.S_ISREG(target.st_mode)
        and target.st_dev == expected_device
        and target.st_ino == expected_inode
    ):
        os.unlink(output_path)
except (FileNotFoundError, OSError, ValueError):
    pass
PY
  fi
  if [[ -n "$TEMPORARY_PATH" ]]; then
    rm -f -- "$TEMPORARY_PATH"
  fi
  if [[ -n "$ANCHOR_DIRECTORY" ]]; then
    anchor_cleanup_status=0
    python3 - cleanup-anchor "$ANCHOR_DIRECTORY" "$ANCHOR_PATH" \
      "$ANCHOR_DIRECTORY_IDENTITY" "${archive_identity:-}" <<'PY' || anchor_cleanup_status="$?"
import os
import stat
import sys

mode, directory_path, anchor_path, expected_directory_identity, expected_archive_identity = sys.argv[1:]
if mode != "cleanup-anchor":
    raise SystemExit(1)

def identity(value):
    return f"{value.st_dev}:{value.st_ino}:{value.st_size}:{stat.S_IMODE(value.st_mode)}:{value.st_uid}"

try:
    directory = os.lstat(directory_path)
    if (
        not stat.S_ISDIR(directory.st_mode)
        or stat.S_ISLNK(directory.st_mode)
        or stat.S_IMODE(directory.st_mode) != 0o700
        or directory.st_uid != os.getuid()
        or f"{directory.st_dev}:{directory.st_ino}" != expected_directory_identity
    ):
        raise OSError("anchor directory identity mismatch")
    try:
        anchor = os.lstat(anchor_path)
        if (
            not stat.S_ISREG(anchor.st_mode)
            or stat.S_ISLNK(anchor.st_mode)
            or identity(anchor) != expected_archive_identity
        ):
            raise OSError("anchor identity mismatch")
        os.unlink(anchor_path)
    except FileNotFoundError:
        pass
    try:
        os.lstat(anchor_path)
    except FileNotFoundError:
        pass
    else:
        raise OSError("anchor still exists")
    directory_after = os.lstat(directory_path)
    if (
        not stat.S_ISDIR(directory_after.st_mode)
        or stat.S_ISLNK(directory_after.st_mode)
        or stat.S_IMODE(directory_after.st_mode) != 0o700
        or directory_after.st_uid != os.getuid()
        or f"{directory_after.st_dev}:{directory_after.st_ino}" != expected_directory_identity
    ):
        raise OSError("anchor directory changed")
    os.rmdir(directory_path)
    try:
        os.lstat(directory_path)
    except FileNotFoundError:
        pass
    else:
        raise OSError("anchor directory still exists")
except FileNotFoundError:
    try:
        os.lstat(anchor_path)
    except FileNotFoundError:
        raise SystemExit(0)
    raise SystemExit(1)
except (OSError, ValueError):
    raise SystemExit(1)
PY
    if [[ "$anchor_cleanup_status" -ne 0 ]]; then
      printf 'offline image anchor cleanup incomplete at %s\n' "$ANCHOR_DIRECTORY" >&2
      if [[ "$cleanup_status" -eq 0 ]]; then
        cleanup_status=1
      fi
    fi
  fi
  if [[ -n "$PUBLICATION_STATE" ]]; then
    rm -f -- "$PUBLICATION_STATE"
  fi
  return "$cleanup_status"
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
if [[ "$OUTPUT_PATH" =~ [[:cntrl:]] ]]; then
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
PUBLICATION_STATE="$(mktemp "$OUTPUT_PATH.publication.XXXXXX")"
chmod 0600 "$TEMPORARY_PATH"
chmod 0600 "$PUBLICATION_STATE"

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

archive_identity="$(
  python3 - capture-identity "$TEMPORARY_PATH" "$archive_checksum" <<'PY'
import hashlib
import os
import stat
import sys

mode, archive_path, expected_checksum = sys.argv[1:]
if mode != "capture-identity":
    raise SystemExit(1)
archive = os.lstat(archive_path)
if (
    not stat.S_ISREG(archive.st_mode)
    or stat.S_ISLNK(archive.st_mode)
    or stat.S_IMODE(archive.st_mode) != 0o600
    or archive.st_uid != os.getuid()
):
    raise SystemExit(1)
digest = hashlib.sha256()
with open(archive_path, "rb", buffering=0) as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(chunk)
if digest.hexdigest() != expected_checksum:
    raise SystemExit(1)
print(f"{archive.st_dev}:{archive.st_ino}:{archive.st_size}:{stat.S_IMODE(archive.st_mode)}:{archive.st_uid}")
PY
)"
if [[ ! "$archive_identity" =~ ^[0-9]+:[0-9]+:[0-9]+:384:[0-9]+$ ]]; then
  printf '%s\n' 'offline image export identity is invalid' >&2
  exit 1
fi

ANCHOR_DIRECTORY="$(mktemp -d "$(dirname -- "$OUTPUT_PATH")/.kinvest-offline-anchor.XXXXXX")"
chmod 0700 "$ANCHOR_DIRECTORY"
ANCHOR_PATH="$ANCHOR_DIRECTORY/archive"
ANCHOR_DIRECTORY_IDENTITY="$(
python3 - create-anchor "$TEMPORARY_PATH" "$ANCHOR_DIRECTORY" "$ANCHOR_PATH" "$archive_checksum" "$archive_identity" <<'PY'
import hashlib
import os
import stat
import sys

mode, temporary_path, directory_path, anchor_path, expected_checksum, expected_identity = sys.argv[1:]
if mode != "create-anchor":
    raise SystemExit(1)

def checksum(path):
    digest = hashlib.sha256()
    with open(path, "rb", buffering=0) as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def identity(value):
    return f"{value.st_dev}:{value.st_ino}:{value.st_size}:{stat.S_IMODE(value.st_mode)}:{value.st_uid}"

directory = os.lstat(directory_path)
temporary = os.lstat(temporary_path)
if (
    not stat.S_ISDIR(directory.st_mode)
    or stat.S_ISLNK(directory.st_mode)
    or stat.S_IMODE(directory.st_mode) != 0o700
    or directory.st_uid != os.getuid()
    or directory.st_dev != temporary.st_dev
    or not stat.S_ISREG(temporary.st_mode)
    or stat.S_ISLNK(temporary.st_mode)
    or stat.S_IMODE(temporary.st_mode) != 0o600
    or temporary.st_uid != os.getuid()
    or identity(temporary) != expected_identity
    or checksum(temporary_path) != expected_checksum
):
    raise SystemExit(1)
try:
    os.lstat(anchor_path)
except FileNotFoundError:
    pass
else:
    raise SystemExit(1)
os.link(temporary_path, anchor_path, follow_symlinks=False)
anchor = os.lstat(anchor_path)
if (
    not stat.S_ISREG(anchor.st_mode)
    or stat.S_ISLNK(anchor.st_mode)
    or not os.path.samestat(temporary, anchor)
    or identity(anchor) != expected_identity
    or checksum(anchor_path) != expected_checksum
):
    try:
        os.unlink(anchor_path)
    except OSError:
        pass
    raise SystemExit(1)
print(f"{directory.st_dev}:{directory.st_ino}")
PY
)"
if [[ ! "$ANCHOR_DIRECTORY_IDENTITY" =~ ^[0-9]+:[0-9]+$ ]]; then
  printf '%s\n' 'offline image anchor identity is invalid' >&2
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
  python3 - metadata "$VERIFIER" "$TEMPORARY_PATH" "$archive_checksum" "$SOURCE_REFERENCE" <<'PY'
import importlib.util
import sys

mode, helper_path, archive_path, archive_checksum, source_reference = sys.argv[1:]
if mode != "metadata":
    raise SystemExit(1)
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

post_verification_identity="$(
  python3 - capture-identity "$TEMPORARY_PATH" "$archive_checksum" <<'PY'
import hashlib
import os
import stat
import sys

mode, archive_path, expected_checksum = sys.argv[1:]
if mode != "capture-identity":
    raise SystemExit(1)
archive = os.lstat(archive_path)
if (
    not stat.S_ISREG(archive.st_mode)
    or stat.S_ISLNK(archive.st_mode)
    or stat.S_IMODE(archive.st_mode) != 0o600
    or archive.st_uid != os.getuid()
):
    raise SystemExit(1)
digest = hashlib.sha256()
with open(archive_path, "rb", buffering=0) as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(chunk)
if digest.hexdigest() != expected_checksum:
    raise SystemExit(1)
print(f"{archive.st_dev}:{archive.st_ino}:{archive.st_size}:{stat.S_IMODE(archive.st_mode)}:{archive.st_uid}")
PY
)"
if [[ "$post_verification_identity" != "$archive_identity" ]]; then
  printf '%s\n' 'offline image archive changed after verification' >&2
  exit 1
fi
python3 - verify-anchor "$TEMPORARY_PATH" "$ANCHOR_PATH" "$archive_checksum" "$archive_identity" <<'PY'
import hashlib
import os
import stat
import sys

mode, temporary_path, anchor_path, expected_checksum, expected_identity = sys.argv[1:]
if mode != "verify-anchor":
    raise SystemExit(1)

def checksum(path):
    digest = hashlib.sha256()
    with open(path, "rb", buffering=0) as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def identity(value):
    return f"{value.st_dev}:{value.st_ino}:{value.st_size}:{stat.S_IMODE(value.st_mode)}:{value.st_uid}"

temporary = os.lstat(temporary_path)
anchor = os.lstat(anchor_path)
if (
    not stat.S_ISREG(temporary.st_mode)
    or stat.S_ISLNK(temporary.st_mode)
    or stat.S_IMODE(temporary.st_mode) != 0o600
    or temporary.st_uid != os.getuid()
    or not stat.S_ISREG(anchor.st_mode)
    or stat.S_ISLNK(anchor.st_mode)
    or not os.path.samestat(temporary, anchor)
    or identity(temporary) != expected_identity
    or identity(anchor) != expected_identity
    or checksum(temporary_path) != expected_checksum
    or checksum(anchor_path) != expected_checksum
):
    raise SystemExit(1)
PY

archive_size="$(wc -c < "$TEMPORARY_PATH" | tr -d '[:space:]')"
if [[ ! "$archive_size" =~ ^[1-9][0-9]*$ ]]; then
  printf '%s\n' 'offline image export size is invalid' >&2
  exit 1
fi
if [[ -e "$OUTPUT_PATH" || -L "$OUTPUT_PATH" ]]; then
  printf '%s\n' 'offline image export output appeared during export' >&2
  exit 1
fi
python3 - publish-no-replace "$TEMPORARY_PATH" "$OUTPUT_PATH" "$archive_checksum" "$archive_identity" "$PUBLICATION_STATE" "$ANCHOR_PATH" <<'PY'
import hashlib
import os
import stat
import sys

mode, temporary_path, output_path, expected_checksum, expected_identity, state_path, anchor_path = sys.argv[1:]
if mode != "publish-no-replace":
    raise SystemExit(1)

def checksum(path):
    digest = hashlib.sha256()
    with open(path, "rb", buffering=0) as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def identity(value):
    return f"{value.st_dev}:{value.st_ino}:{value.st_size}:{stat.S_IMODE(value.st_mode)}:{value.st_uid}"

def publication_failed(source_stat=None):
    if source_stat is not None:
        try:
            target_stat = os.lstat(output_path)
            if os.path.samestat(source_stat, target_stat):
                os.unlink(output_path)
        except OSError:
            pass
    print("offline image publication failed", file=sys.stderr)
    raise SystemExit(1)

try:
    source_stat = os.lstat(temporary_path)
    anchor_stat = os.lstat(anchor_path)
    if (
        identity(source_stat) != expected_identity
        or identity(anchor_stat) != expected_identity
        or not os.path.samestat(source_stat, anchor_stat)
        or checksum(temporary_path) != expected_checksum
        or checksum(anchor_path) != expected_checksum
    ):
        publication_failed()
    with open(state_path, "w", encoding="ascii") as state:
        state.write(f"armed {source_stat.st_dev} {source_stat.st_ino}\n")
        state.flush()
        os.fsync(state.fileno())
    os.link(temporary_path, output_path, follow_symlinks=False)
except OSError:
    publication_failed()

try:
    target_stat = os.lstat(output_path)
    if (
        not stat.S_ISREG(target_stat.st_mode)
        or stat.S_ISLNK(target_stat.st_mode)
        or stat.S_IMODE(target_stat.st_mode) != 0o600
        or target_stat.st_uid != os.getuid()
        or not os.path.samestat(source_stat, target_stat)
        or not os.path.samestat(anchor_stat, target_stat)
        or identity(target_stat) != expected_identity
        or checksum(output_path) != expected_checksum
        or checksum(anchor_path) != expected_checksum
    ):
        publication_failed(source_stat)
    os.unlink(temporary_path)
    final_stat = os.lstat(output_path)
    if (
        not stat.S_ISREG(final_stat.st_mode)
        or stat.S_ISLNK(final_stat.st_mode)
        or stat.S_IMODE(final_stat.st_mode) != 0o600
        or final_stat.st_uid != os.getuid()
        or not os.path.samestat(source_stat, final_stat)
        or not os.path.samestat(anchor_stat, final_stat)
        or identity(final_stat) != expected_identity
        or checksum(output_path) != expected_checksum
        or checksum(anchor_path) != expected_checksum
    ):
        publication_failed(source_stat)
except OSError:
    publication_failed(source_stat)
PY
TEMPORARY_PATH=''

python3 - verify-published-anchor "$OUTPUT_PATH" "$ANCHOR_PATH" "$archive_checksum" "$archive_identity" <<'PY'
import hashlib
import os
import stat
import sys

mode, output_path, anchor_path, expected_checksum, expected_identity = sys.argv[1:]
if mode != "verify-published-anchor":
    raise SystemExit(1)

def checksum(path):
    digest = hashlib.sha256()
    with open(path, "rb", buffering=0) as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def identity(value):
    return f"{value.st_dev}:{value.st_ino}:{value.st_size}:{stat.S_IMODE(value.st_mode)}:{value.st_uid}"

output = os.lstat(output_path)
anchor = os.lstat(anchor_path)
if (
    not stat.S_ISREG(output.st_mode)
    or stat.S_ISLNK(output.st_mode)
    or stat.S_IMODE(output.st_mode) != 0o600
    or output.st_uid != os.getuid()
    or not stat.S_ISREG(anchor.st_mode)
    or stat.S_ISLNK(anchor.st_mode)
    or not os.path.samestat(output, anchor)
    or identity(output) != expected_identity
    or identity(anchor) != expected_identity
    or checksum(output_path) != expected_checksum
    or checksum(anchor_path) != expected_checksum
):
    raise SystemExit(1)
PY

final_checksum="$(shasum -a 256 "$OUTPUT_PATH" | awk '{print $1}')"
if [[ "$final_checksum" != "$archive_checksum" ]]; then
  printf '%s\n' 'offline image export final checksum mismatch' >&2
  exit 1
fi

trap '' HUP INT TERM
python3 - cleanup-anchor-strict "$ANCHOR_DIRECTORY" "$ANCHOR_PATH" "$OUTPUT_PATH" \
  "$archive_checksum" "$archive_identity" "$ANCHOR_DIRECTORY_IDENTITY" <<'PY'
import hashlib
import os
import stat
import sys

(
    mode,
    directory_path,
    anchor_path,
    output_path,
    expected_checksum,
    expected_archive_identity,
    expected_directory_identity,
) = sys.argv[1:]
if mode != "cleanup-anchor-strict":
    raise SystemExit(1)

def checksum(path):
    digest = hashlib.sha256()
    with open(path, "rb", buffering=0) as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def identity(value):
    return f"{value.st_dev}:{value.st_ino}:{value.st_size}:{stat.S_IMODE(value.st_mode)}:{value.st_uid}"

def valid_directory(value):
    return (
        stat.S_ISDIR(value.st_mode)
        and not stat.S_ISLNK(value.st_mode)
        and stat.S_IMODE(value.st_mode) == 0o700
        and value.st_uid == os.getuid()
        and f"{value.st_dev}:{value.st_ino}" == expected_directory_identity
    )

def valid_archive(value):
    return (
        stat.S_ISREG(value.st_mode)
        and not stat.S_ISLNK(value.st_mode)
        and stat.S_IMODE(value.st_mode) == 0o600
        and value.st_uid == os.getuid()
        and identity(value) == expected_archive_identity
    )

try:
    directory = os.lstat(directory_path)
    anchor = os.lstat(anchor_path)
    output = os.lstat(output_path)
    if (
        not valid_directory(directory)
        or not valid_archive(anchor)
        or not valid_archive(output)
        or not os.path.samestat(anchor, output)
        or checksum(anchor_path) != expected_checksum
        or checksum(output_path) != expected_checksum
    ):
        raise OSError("anchor cleanup precondition failed")
    os.unlink(anchor_path)
    try:
        os.lstat(anchor_path)
    except FileNotFoundError:
        pass
    else:
        raise OSError("anchor still exists")
    output_after = os.lstat(output_path)
    directory_after = os.lstat(directory_path)
    if (
        not valid_archive(output_after)
        or not os.path.samestat(output, output_after)
        or checksum(output_path) != expected_checksum
        or not valid_directory(directory_after)
        or not os.path.samestat(directory, directory_after)
    ):
        raise OSError("anchor cleanup postcondition failed")
    os.rmdir(directory_path)
    try:
        os.lstat(directory_path)
    except FileNotFoundError:
        pass
    else:
        raise OSError("anchor directory still exists")
except (FileNotFoundError, OSError, ValueError):
    print("offline image anchor cleanup failed", file=sys.stderr)
    raise SystemExit(1)
PY
ANCHOR_DIRECTORY=''
ANCHOR_DIRECTORY_IDENTITY=''
ANCHOR_PATH=''

success_metadata="$(printf 'path=%s\nchecksum=sha256:%s\nsize=%s\nsource=%s\nplatform=linux/amd64\nplatformManifest=%s\nruntimeImageId=%s' \
  "$OUTPUT_PATH" "$archive_checksum" "$archive_size" "$SOURCE_REFERENCE" \
  "$platform_manifest_digest" "$runtime_image_id")"
printf '%s\n' "$success_metadata"
SUCCESS_METADATA_COMPLETED='true'
