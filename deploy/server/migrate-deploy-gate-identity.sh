#!/usr/bin/env bash
set -uo pipefail

umask 077

GATE_STATE_DIR='/var/lib/kinvest-deploy-gate'
SERVER_ROOT='/root/docker/kinvest'
DEPLOY_LOCK="$SERVER_ROOT/state/deploy.lock"
V3_INSTALL_JOURNAL="$SERVER_ROOT/state/install-v3.journal"
V4_INSTALL_JOURNAL="$SERVER_ROOT/state/install-v4.journal"
GATE_IDENTITY="$GATE_STATE_DIR/identity"
INSTALL_MARKER="$GATE_STATE_DIR/install-incomplete"
ROOT_UID='0'

current_user=''
current_group=''
target_user=''
target_group=''
current_gid=''
target_gid=''
marker_temporary=''
identity_temporary=''
migration_started='false'

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-76}"
}

valid_identity_name() {
  [[ "$1" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]
}

resolve_identity() {
  local user="$1" group="$2" passwd_record group_record resolved_user resolved_group gid groups candidate
  passwd_record="$(getent passwd "$user" 2>/dev/null)" || return 1
  group_record="$(getent group "$group" 2>/dev/null)" || return 1
  [[ "$passwd_record" != *$'\n'* && "$group_record" != *$'\n'* ]] || return 1
  IFS=: read -r resolved_user _ _ _ _ _ _ <<<"$passwd_record"
  IFS=: read -r resolved_group _ gid _ <<<"$group_record"
  [[ "$resolved_user" == "$user" && "$resolved_group" == "$group" && "$gid" =~ ^[0-9]+$ ]] || return 1
  groups="$(id -G "$user" 2>/dev/null)" || return 1
  for candidate in $groups; do
    [[ "$candidate" =~ ^[0-9]+$ ]] || return 1
    [[ "$candidate" != "$gid" ]] || {
      printf '%s\n' "$gid"
      return 0
    }
  done
  return 1
}

fsync_file() {
  python3 - "$1" >/dev/null 2>&1 <<'PY'
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
}

fsync_directory() {
  python3 - "$1" >/dev/null 2>&1 <<'PY'
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
}

validate_directory() {
  python3 - "$1" "$ROOT_UID" "$2" >/dev/null 2>&1 <<'PY'
import os, stat, sys
path, expected_uid, expected_gid = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
info = os.lstat(path)
assert stat.S_ISDIR(info.st_mode)
assert not stat.S_ISLNK(info.st_mode)
assert info.st_uid == expected_uid
assert info.st_gid == expected_gid
assert stat.S_IMODE(info.st_mode) == 0o750
assert info.st_nlink >= 2
PY
}

validate_regular_file() {
  local path="$1" gid="$2" mode="$3" expected_kind="$4" expected_user="${5:-}" expected_group="${6:-}"
  python3 - "$path" "$ROOT_UID" "$gid" "$mode" "$expected_kind" "$expected_user" "$expected_group" >/dev/null 2>&1 <<'PY'
import os, stat, sys
path = sys.argv[1]
expected_uid, expected_gid = int(sys.argv[2]), int(sys.argv[3])
expected_mode, kind = int(sys.argv[4], 8), sys.argv[5]
user, group = sys.argv[6], sys.argv[7]
info = os.lstat(path)
assert stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode)
assert info.st_uid == expected_uid and info.st_gid == expected_gid
assert stat.S_IMODE(info.st_mode) == expected_mode and info.st_nlink == 1
with open(path, "rb", buffering=0) as handle:
    value = handle.read(4097)
assert len(value) <= 4096
if kind == "identity":
    expected = f"user={user}\ngroup={group}\ngid={expected_gid}\n".encode("ascii")
elif kind == "marker":
    expected = b"ACTIVE\n"
else:
    raise AssertionError("unknown kind")
assert value == expected
PY
}

validate_entries() {
  local include_marker="$1"
  python3 - "$GATE_STATE_DIR" "$include_marker" >/dev/null 2>&1 <<'PY'
import os, sys
expected = ["identity"] if sys.argv[2] == "false" else ["identity", "install-incomplete"]
assert sorted(os.listdir(sys.argv[1])) == expected
PY
}

clean_state_kind() {
  local directory_current='false' directory_target='false'
  validate_directory "$GATE_STATE_DIR" "$current_gid" && directory_current='true'
  validate_directory "$GATE_STATE_DIR" "$target_gid" && directory_target='true'
  [[ "$directory_current" == true || "$directory_target" == true ]] || return 1
  validate_entries false || return 1

  if [[ "$directory_current" == true ]] &&
    validate_regular_file "$GATE_IDENTITY" "$current_gid" 0640 identity "$current_user" "$current_group"; then
    return 0
  fi
  if [[ "$directory_target" == true ]] &&
    validate_regular_file "$GATE_IDENTITY" "$target_gid" 0640 identity "$target_user" "$target_group"; then
    return 2
  fi

  python3 - "$GATE_IDENTITY" "$ROOT_UID" >/dev/null 2>&1 <<'PY' || return 1
import os, stat, sys
info = os.lstat(sys.argv[1])
assert stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode)
assert info.st_uid == int(sys.argv[2])
assert stat.S_IMODE(info.st_mode) == 0o640 and info.st_nlink == 1
PY
  return 3
}

validate_state_with_marker() {
  local user="$1" group="$2" gid="$3"
  validate_directory "$GATE_STATE_DIR" "$gid" &&
    validate_entries true &&
    validate_regular_file "$GATE_IDENTITY" "$gid" 0640 identity "$user" "$group" &&
    validate_regular_file "$INSTALL_MARKER" "$gid" 0640 marker
}

validate_tracked_temporary() {
  local candidate="$1" prefix="$2"
  [[ -n "$candidate" && "$(dirname "$candidate")" == "$GATE_STATE_DIR" ]] || return 1
  [[ "$(basename "$candidate")" =~ ^\.${prefix}\.[A-Za-z0-9]{6}$ ]] || return 1
  python3 - "$candidate" "$ROOT_UID" >/dev/null 2>&1 <<'PY'
import os, stat, sys
info = os.lstat(sys.argv[1])
assert stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode)
assert info.st_uid == int(sys.argv[2]) and info.st_nlink == 1
PY
}

remove_tracked_temporary() {
  local candidate="$1" prefix="$2"
  [[ -z "$candidate" || ! -e "$candidate" ]] && return 0
  validate_tracked_temporary "$candidate" "$prefix" || return 1
  rm -f -- "$candidate" >/dev/null 2>&1 || return 1
  fsync_directory "$GATE_STATE_DIR"
}

publish_marker() {
  marker_temporary="$(mktemp "$GATE_STATE_DIR/.install-incomplete.XXXXXX")" || return 1
  printf '%s\n' ACTIVE >"$marker_temporary" || return 1
  chown "$ROOT_UID:$current_gid" "$marker_temporary" >/dev/null 2>&1 || return 1
  chmod 0640 "$marker_temporary" >/dev/null 2>&1 || return 1
  fsync_file "$marker_temporary" || return 1
  validate_regular_file "$marker_temporary" "$current_gid" 0640 marker || return 1
  mv -fT "$marker_temporary" "$INSTALL_MARKER" >/dev/null 2>&1 || return 1
  marker_temporary=''
  fsync_directory "$GATE_STATE_DIR" || return 1
  validate_regular_file "$INSTALL_MARKER" "$current_gid" 0640 marker
}

stage_and_replace_identity() {
  local user="$1" group="$2" gid="$3"
  remove_tracked_temporary "$identity_temporary" identity || return 1
  identity_temporary="$(mktemp "$GATE_STATE_DIR/.identity.XXXXXX")" || return 1
  printf 'user=%s\ngroup=%s\ngid=%s\n' "$user" "$group" "$gid" >"$identity_temporary" || return 1
  chown "$ROOT_UID:$gid" "$identity_temporary" >/dev/null 2>&1 || return 1
  chmod 0640 "$identity_temporary" >/dev/null 2>&1 || return 1
  fsync_file "$identity_temporary" || return 1
  validate_regular_file "$identity_temporary" "$gid" 0640 identity "$user" "$group" || return 1
  mv -fT "$identity_temporary" "$GATE_IDENTITY" >/dev/null 2>&1 || return 1
  identity_temporary=''
  fsync_directory "$GATE_STATE_DIR"
}

test_failure_requested() {
  [[ "${KINVEST_DEPLOY_GATE_MIGRATION_TEST_ONLY:-}" == 1 &&
    "${KINVEST_DEPLOY_GATE_MIGRATION_FAIL_AT:-}" == "$1" ]]
}

perform_migration() {
  publish_marker || return 1
  migration_started='true'
  test_failure_requested after-marker && return 1

  chown "$ROOT_UID:$target_gid" "$GATE_STATE_DIR" >/dev/null 2>&1 || return 1
  chmod 0750 "$GATE_STATE_DIR" >/dev/null 2>&1 || return 1
  fsync_directory "$GATE_STATE_DIR" || return 1
  test_failure_requested after-directory-group && return 1

  stage_and_replace_identity "$target_user" "$target_group" "$target_gid" || return 1
  test_failure_requested after-identity-replace && return 1

  chown "$ROOT_UID:$target_gid" "$INSTALL_MARKER" >/dev/null 2>&1 || return 1
  chmod 0640 "$INSTALL_MARKER" >/dev/null 2>&1 || return 1
  fsync_file "$INSTALL_MARKER" || return 1
  fsync_directory "$GATE_STATE_DIR" || return 1
  validate_state_with_marker "$target_user" "$target_group" "$target_gid" || return 1

  rm -f -- "$INSTALL_MARKER" >/dev/null 2>&1 || return 1
  fsync_directory "$GATE_STATE_DIR" || return 1
  clean_state_kind
  [[ "$?" -eq 2 ]]
}

rollback_to_current() {
  if [[ "${KINVEST_DEPLOY_GATE_MIGRATION_TEST_ONLY:-}" == 1 &&
    "${KINVEST_DEPLOY_GATE_MIGRATION_ROLLBACK_FAIL:-}" == 1 ]]; then
    return 1
  fi

  if [[ -e "$INSTALL_MARKER" || -L "$INSTALL_MARKER" ]]; then
    validate_regular_file "$INSTALL_MARKER" "$current_gid" 0640 marker ||
      validate_regular_file "$INSTALL_MARKER" "$target_gid" 0640 marker || return 1
  elif [[ -n "$marker_temporary" ]]; then
    validate_tracked_temporary "$marker_temporary" install-incomplete || return 1
  else
    return 1
  fi

  if [[ ! -e "$INSTALL_MARKER" ]]; then
    remove_tracked_temporary "$marker_temporary" install-incomplete || return 1
    marker_temporary=''
    publish_marker || return 1
  fi

  chown "$ROOT_UID:$current_gid" "$INSTALL_MARKER" >/dev/null 2>&1 || return 1
  chmod 0640 "$INSTALL_MARKER" >/dev/null 2>&1 || return 1
  fsync_file "$INSTALL_MARKER" || return 1
  chown "$ROOT_UID:$current_gid" "$GATE_STATE_DIR" >/dev/null 2>&1 || return 1
  chmod 0750 "$GATE_STATE_DIR" >/dev/null 2>&1 || return 1
  fsync_directory "$GATE_STATE_DIR" || return 1
  stage_and_replace_identity "$current_user" "$current_group" "$current_gid" || return 1
  remove_tracked_temporary "$marker_temporary" install-incomplete || return 1
  marker_temporary=''
  remove_tracked_temporary "$identity_temporary" identity || return 1
  identity_temporary=''
  validate_state_with_marker "$current_user" "$current_group" "$current_gid" || return 1
  rm -f -- "$INSTALL_MARKER" >/dev/null 2>&1 || return 1
  fsync_directory "$GATE_STATE_DIR" || return 1
  clean_state_kind
  [[ "$?" -eq 0 ]]
}

handle_interruption() {
  trap - HUP INT TERM
  if [[ "$migration_started" == true ]] && rollback_to_current >/dev/null 2>&1; then
    die DEPLOY_GATE_IDENTITY_MIGRATION_FAILED_ROLLED_BACK
  fi
  die DEPLOY_GATE_IDENTITY_MIGRATION_FAILED_FAIL_CLOSED
}

[[ "$(id -u)" -eq 0 ]] || die DEPLOY_GATE_IDENTITY_MIGRATION_ROOT_REQUIRED
[[ "$#" -eq 4 ]] || die DEPLOY_GATE_IDENTITY_MIGRATION_USAGE 2
current_user="$1"
current_group="$2"
target_user="$3"
target_group="$4"

for identity_name in "$current_user" "$current_group" "$target_user" "$target_group"; do
  valid_identity_name "$identity_name" || die DEPLOY_GATE_IDENTITY_MIGRATION_IDENTITY_INVALID
done
[[ "$current_user:$current_group" != "$target_user:$target_group" ]] ||
  die DEPLOY_GATE_IDENTITY_MIGRATION_IDENTITY_INVALID

current_gid="$(resolve_identity "$current_user" "$current_group")" ||
  die DEPLOY_GATE_IDENTITY_MIGRATION_IDENTITY_INVALID
target_gid="$(resolve_identity "$target_user" "$target_group")" ||
  die DEPLOY_GATE_IDENTITY_MIGRATION_IDENTITY_INVALID

validate_directory "$GATE_STATE_DIR" "$current_gid" >/dev/null 2>&1 || {
  if validate_directory "$GATE_STATE_DIR" "$target_gid" >/dev/null 2>&1 &&
    validate_entries false >/dev/null 2>&1 &&
    validate_regular_file "$GATE_IDENTITY" "$target_gid" 0640 identity "$target_user" "$target_group" >/dev/null 2>&1; then
    die DEPLOY_GATE_IDENTITY_MIGRATION_SOURCE_MISMATCH
  fi
  die DEPLOY_GATE_IDENTITY_MIGRATION_UNSAFE_STATE
}

{ exec 8<"$GATE_STATE_DIR"; } 2>/dev/null || die DEPLOY_GATE_IDENTITY_MIGRATION_UNSAFE_STATE
flock -n 8 >/dev/null 2>&1 || die DEPLOY_GATE_IDENTITY_MIGRATION_BUSY

clean_state_kind >/dev/null 2>&1
case "$?" in
  0) ;;
  2|3) die DEPLOY_GATE_IDENTITY_MIGRATION_SOURCE_MISMATCH ;;
  *) die DEPLOY_GATE_IDENTITY_MIGRATION_UNSAFE_STATE ;;
esac

[[ -f "$DEPLOY_LOCK" && ! -L "$DEPLOY_LOCK" ]] || die DEPLOY_GATE_IDENTITY_MIGRATION_UNSAFE_STATE
{ exec 9<>"$DEPLOY_LOCK"; } 2>/dev/null || die DEPLOY_GATE_IDENTITY_MIGRATION_UNSAFE_STATE
flock -n 9 >/dev/null 2>&1 || die DEPLOY_GATE_IDENTITY_MIGRATION_BUSY

clean_state_kind >/dev/null 2>&1
case "$?" in
  0) ;;
  2|3) die DEPLOY_GATE_IDENTITY_MIGRATION_SOURCE_MISMATCH ;;
  *) die DEPLOY_GATE_IDENTITY_MIGRATION_UNSAFE_STATE ;;
esac

if [[ -e "$V3_INSTALL_JOURNAL" || -L "$V3_INSTALL_JOURNAL" ||
  -e "$V4_INSTALL_JOURNAL" || -L "$V4_INSTALL_JOURNAL" ]]; then
  die DEPLOY_GATE_IDENTITY_MIGRATION_INSTALL_INCOMPLETE
fi

trap handle_interruption HUP INT TERM
if perform_migration >/dev/null 2>&1; then
  trap - HUP INT TERM
  printf '%s\n' DEPLOY_GATE_IDENTITY_MIGRATION_OK
  exit 0
fi

trap - HUP INT TERM
if rollback_to_current >/dev/null 2>&1; then
  die DEPLOY_GATE_IDENTITY_MIGRATION_FAILED_ROLLED_BACK
fi
die DEPLOY_GATE_IDENTITY_MIGRATION_FAILED_FAIL_CLOSED
