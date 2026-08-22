#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-}"
LOCAL_SBIN='/usr/local/sbin'
LOCAL_LIBEXEC='/usr/local/libexec'
SERVER_ROOT='/root/docker/kinvest'
RUN_ROOT='/run'
SUDOERS_DIR='/etc/sudoers.d'
INSTALL_OWNER='root'
INSTALL_GROUP='root'
GATE_STATE_DIR='/var/lib/kinvest-deploy-gate'
GATE_INSTALL_MARKER="$GATE_STATE_DIR/install-incomplete"
GATE_IDENTITY="$GATE_STATE_DIR/identity"
GATE_ROOT_OWNER='0:0'
GATE_USER="${KINVEST_DEPLOY_GATE_USER:-}"
GATE_GROUP="${KINVEST_DEPLOY_GATE_GROUP:-}"
GATE_GROUP_GID=''
GATE_IDENTITY_CONTENT=''

DEPLOY_TARGET="$LOCAL_SBIN/deploy-kinvest-v3"
V2_DEPLOY_TARGET="$LOCAL_SBIN/deploy-kinvest"
V2_VALIDATOR_TARGET="$LOCAL_LIBEXEC/kinvest-secret-version-config"
V2_ATTESTATION_TARGET="$LOCAL_LIBEXEC/kinvest-offline-image-attestation"
WRAPPER_TARGET="$LOCAL_SBIN/kinvest-ssh-command"
HELPER_TARGET="$LOCAL_LIBEXEC/kinvest-deploy-v3-contract"
COMPOSE_TARGET="$SERVER_ROOT/docker-compose-v3.yml"
SUDOERS_TARGET="$SUDOERS_DIR/kinvest-deploy-v3"
DEPLOY_LOCK="$SERVER_ROOT/state/deploy.lock"
INSTALL_BACKUP_ROOT="$SERVER_ROOT/install-backups/deploy-v3"

SOURCE_ASSETS=('deploy-kinvest-v2.sh' 'secret-version-config.py' 'offline-image-attestation.py' 'deploy-kinvest-v3.sh' 'kinvest-ssh-command-v3' 'deploy-v3-contract.py' 'docker-compose-v3.yml' 'kinvest-deploy-v4.sudoers.in')
TARGETS=("$V2_DEPLOY_TARGET" "$V2_VALIDATOR_TARGET" "$V2_ATTESTATION_TARGET" "$DEPLOY_TARGET" "$WRAPPER_TARGET" "$HELPER_TARGET" "$COMPOSE_TARGET" "$SUDOERS_TARGET")
TARGET_NAMES=('v2-deployer' 'validator' 'attestation' 'deployer' 'wrapper' 'helper' 'compose' 'sudoers')
ASSET_MODES=('0755' '0755' '0755' '0755' '0755' '0755' '0644' '0440')
EXPECTED_ASSET_HASHES=(
  '60a6078a62f45446c19277ce5d7ae3fbf7b93359668ceeeb19251dcd4b5cf3b8'
  'edf93826e6fb66b8e0c55b84f24a432e8cb32fb81392f3cf132d82c386ac93e5'
  '424e9fa9b013727ef75c489cfa25cf5144efbabb34d2bbb630115efe86de7bc1'
  '0f5a6b5a09a6251c48b329263d9a5a27221bd6a1fa6b9a42a69750614b788bd8'
  'adf011acd3cb7b242bfa0f3e3c863999980e41c011320b04cbea723e137f677c'
  '68040b9177cc8d2bb929a351e289eee7e9c6e446fda447ceec12d9ad382afe23'
  '7698dd619fb6a441763f85e4e35c819af55e431c6d0ac9c4b527930d07a644aa'
  '7b5e370620d99b501bd60a78637dc51984a09b550923181e424c98e4f9b36040'
)
INSTALL_HASHES=("${EXPECTED_ASSET_HASHES[@]}")

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

if [[ "$#" -ne 1 || "$SOURCE_DIR" != /* || "$SOURCE_DIR" == *$'\n'* || ! -d "$SOURCE_DIR" ]]; then
  fail 'usage: install-deploy-v3.sh /absolute/canonical/source/dir' 2
fi

if [[ "$(id -u)" -ne 0 ]]; then
  if [[ "${KINVEST_INSTALL_V3_TEST_ROOT:-}" != '1' \
    || "$LOCAL_SBIN" == '/usr/local/sbin' \
    || "$LOCAL_LIBEXEC" == '/usr/local/libexec' \
    || "$SERVER_ROOT" == '/root/docker/kinvest' \
    || "$RUN_ROOT" == '/run' ]]; then
    fail 'deploy-v3 installation must run as root'
  fi
fi

canonical_source="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$SOURCE_DIR")"
if [[ "$canonical_source" != "$SOURCE_DIR" || -L "$SOURCE_DIR" ]]; then
  fail 'deploy-v3 source directory must be canonical' 2
fi

for source_asset in "${SOURCE_ASSETS[@]}"; do
  source_path="$SOURCE_DIR/$source_asset"
  if [[ ! -f "$source_path" || -L "$source_path" ]]; then
    fail "invalid deploy-v3 source file: $source_asset"
  fi
done
bash -n "$SOURCE_DIR/deploy-kinvest-v3.sh"
bash -n "$SOURCE_DIR/kinvest-ssh-command-v3"
[[ -s "$SOURCE_DIR/docker-compose-v3.yml" ]] || fail 'invalid deploy-v3 source file: docker-compose-v3.yml'

for target_directory in "$LOCAL_SBIN" "$LOCAL_LIBEXEC" "$SERVER_ROOT" "$SERVER_ROOT/state" "$SUDOERS_DIR" "$INSTALL_BACKUP_ROOT"; do
  if [[ -L "$target_directory" || ( -e "$target_directory" && ! -d "$target_directory" ) ]]; then
    fail "refusing invalid deploy-v3 target directory: $target_directory"
  fi
done
install -d -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m 0755 -- \
  "$LOCAL_SBIN" "$LOCAL_LIBEXEC" "$SERVER_ROOT" "$SERVER_ROOT/state" "$SUDOERS_DIR"
install -d -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m 0700 -- "$INSTALL_BACKUP_ROOT"

file_hash() {
  sha256sum "$1" | awk '{print $1}'
}

file_attributes() {
  python3 -c 'import os, stat, sys; value=os.stat(sys.argv[1], follow_symlinks=False); print(f"{value.st_uid}:{value.st_gid}:{stat.S_IMODE(value.st_mode):o}")' "$1"
}

fsync_directory() {
  python3 -c 'import os,sys; descriptor=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY); os.fsync(descriptor); os.close(descriptor)' "$1"
}

fsync_file() {
  python3 -c 'import os,sys; descriptor=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW); os.fsync(descriptor); os.close(descriptor)' "$1"
}

gate_inode_identity() {
  python3 -c 'import os,stat,sys; v=os.lstat(sys.argv[1]); print(f"{v.st_dev}:{v.st_ino}:{v.st_uid}:{v.st_nlink}:{int(stat.S_ISREG(v.st_mode))}")' "$1"
}

resolve_gate_identity() {
  local user_record group_record name password uid primary_gid gecos home shell extra gid members deploy_groups
  [[ -n "$GATE_USER" && -n "$GATE_GROUP" ]] || fail 'DEPLOY_V3_GATE_IDENTITY_REQUIRED'
  [[ "$GATE_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "$GATE_GROUP" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || return 1
  user_record="$(getent passwd "$GATE_USER")" || return 1
  group_record="$(getent group "$GATE_GROUP")" || return 1
  [[ "$user_record" != *$'\n'* && "$user_record" != *$'\r'* && "$group_record" != *$'\n'* && "$group_record" != *$'\r'* ]] || return 1
  IFS=: read -r name password uid primary_gid gecos home shell extra <<<"$user_record"
  [[ "$name" == "$GATE_USER" && "$uid" =~ ^[1-9][0-9]{0,9}$ && "$primary_gid" =~ ^[0-9]{1,10}$ && -z "$extra" ]] || return 1
  IFS=: read -r name password gid members extra <<<"$group_record"
  [[ "$name" == "$GATE_GROUP" && -z "$extra" && "$gid" =~ ^[1-9][0-9]{0,9}$ ]] || return 1
  deploy_groups=" $(id -G "$GATE_USER") " || return 1
  [[ "$deploy_groups" == *" $gid "* ]] || return 1
  GATE_GROUP_GID="$gid"
  GATE_IDENTITY_CONTENT="user=$GATE_USER"$'\n'"group=$GATE_GROUP"$'\n'"gid=$GATE_GROUP_GID"
}

validate_gate_temp() {
  local candidate="$1" basename identity
  [[ "$(dirname "$candidate")" == "$GATE_STATE_DIR" ]] || return 1
  basename="$(basename "$candidate")"
  [[ "$basename" =~ ^\.(install-incomplete|identity)\.[A-Za-z0-9]{6}$ ]] || return 1
  [[ -f "$candidate" && ! -L "$candidate" ]] || return 1
  identity="$(gate_inode_identity "$candidate")" || return 1
  [[ "$identity" =~ ^[0-9]+:[0-9]+:${GATE_ROOT_OWNER%%:*}:1:1$ ]]
}

validate_tracked_gate_temp() {
  validate_gate_temp "$1" && [[ "$(gate_inode_identity "$1")" == "$2" ]]
}

cleanup_gate_temporaries() {
  local removed='false'
  if [[ -n "${gate_identity_temporary:-}" ]]; then
    validate_tracked_gate_temp "$gate_identity_temporary" "$gate_identity_temporary_identity" || return 1
    rm -f "$gate_identity_temporary" || return 1
    gate_identity_temporary=''
    gate_identity_temporary_identity=''
    removed='true'
  fi
  if [[ -n "${gate_marker_temporary:-}" ]]; then
    validate_tracked_gate_temp "$gate_marker_temporary" "$gate_marker_temporary_identity" || return 1
    rm -f "$gate_marker_temporary" || return 1
    gate_marker_temporary=''
    gate_marker_temporary_identity=''
    removed='true'
  fi
  [[ "$removed" == false ]] || fsync_directory "$GATE_STATE_DIR"
}

reconcile_gate_temporaries() {
  local candidate removed='false'
  shopt -s nullglob
  for candidate in "$GATE_STATE_DIR"/.install-incomplete.* "$GATE_STATE_DIR"/.identity.*; do
    validate_gate_temp "$candidate" || { shopt -u nullglob; return 1; }
    rm -f "$candidate" || { shopt -u nullglob; return 1; }
    removed='true'
  done
  shopt -u nullglob
  [[ "$removed" == false ]] || fsync_directory "$GATE_STATE_DIR"
}

prepare_gate_directory() {
  if [[ -e "$GATE_STATE_DIR" || -L "$GATE_STATE_DIR" ]]; then
    [[ -d "$GATE_STATE_DIR" && ! -L "$GATE_STATE_DIR" ]] || return 1
    [[ "$(file_attributes "$GATE_STATE_DIR")" =~ ^${GATE_ROOT_OWNER%%:*}:[0-9]+:750$ ]] || return 1
    [[ "$(gate_inode_identity "$GATE_STATE_DIR")" =~ ^[0-9]+:[0-9]+:${GATE_ROOT_OWNER%%:*}:[2-9][0-9]*:0$ ]] || return 1
  else
    install -d -o root -g "$GATE_GROUP" -m 0750 "$GATE_STATE_DIR" || return 1
    fsync_directory "$(dirname "$GATE_STATE_DIR")" || return 1
  fi
}

validate_or_publish_gate_identity() {
  if [[ -e "$GATE_IDENTITY" || -L "$GATE_IDENTITY" ]]; then
    [[ -f "$GATE_IDENTITY" && ! -L "$GATE_IDENTITY" ]] || return 1
    [[ "$(file_attributes "$GATE_IDENTITY")" == "${GATE_ROOT_OWNER%%:*}:$GATE_GROUP_GID:640" ]] || return 1
    [[ "$(cat "$GATE_IDENTITY")" == "$GATE_IDENTITY_CONTENT" ]] || fail 'DEPLOY_V3_GATE_IDENTITY_MISMATCH'
  else
    gate_identity_temporary="$(mktemp "$GATE_STATE_DIR/.identity.XXXXXX")" || return 1
    gate_identity_temporary_identity="$(gate_inode_identity "$gate_identity_temporary")" || return 1
    printf '%s\n' "$GATE_IDENTITY_CONTENT" >"$gate_identity_temporary" || return 1
    chown root:"$GATE_GROUP" "$gate_identity_temporary" || return 1
    chmod 0640 "$gate_identity_temporary" || return 1
    fsync_file "$gate_identity_temporary" || return 1
    mv -fT "$gate_identity_temporary" "$GATE_IDENTITY" || return 1
    gate_identity_temporary=''
    gate_identity_temporary_identity=''
    fsync_directory "$GATE_STATE_DIR" || return 1
  fi
}

validate_gate_marker() {
  [[ -f "$GATE_INSTALL_MARKER" && ! -L "$GATE_INSTALL_MARKER" ]] || return 1
  [[ "$(file_attributes "$GATE_INSTALL_MARKER")" == "${GATE_ROOT_OWNER%%:*}:$GATE_GROUP_GID:640" ]] || return 1
  [[ "$(cat "$GATE_INSTALL_MARKER")" == ACTIVE ]]
}

publish_gate_marker() {
  gate_marker_temporary="$(mktemp "$GATE_STATE_DIR/.install-incomplete.XXXXXX")" || return 1
  gate_marker_temporary_identity="$(gate_inode_identity "$gate_marker_temporary")" || return 1
  printf '%s\n' ACTIVE >"$gate_marker_temporary" || return 1
  chown root:"$GATE_GROUP" "$gate_marker_temporary" || return 1
  chmod 0640 "$gate_marker_temporary" || return 1
  fsync_file "$gate_marker_temporary" || return 1
  mv -fT "$gate_marker_temporary" "$GATE_INSTALL_MARKER" || return 1
  gate_marker_temporary=''
  gate_marker_temporary_identity=''
  fsync_directory "$GATE_STATE_DIR" || return 1
  public_marker_published='true'
}

clear_gate_marker() {
  if [[ -e "$GATE_INSTALL_MARKER" || -L "$GATE_INSTALL_MARKER" ]]; then
    validate_gate_marker || return 1
    rm -f "$GATE_INSTALL_MARKER" || return 1
    fsync_directory "$GATE_STATE_DIR" || return 1
  fi
  public_marker_published='false'
}

expected_owner="$(python3 -c 'import pwd, sys; value=sys.argv[1]; print(int(value) if value.isdigit() else pwd.getpwnam(value).pw_uid)' "$INSTALL_OWNER")"
expected_group="$(python3 -c 'import grp, sys; value=sys.argv[1]; print(int(value) if value.isdigit() else grp.getgrnam(value).gr_gid)' "$INSTALL_GROUP")"

gate_identity_temporary=''
gate_identity_temporary_identity=''
gate_marker_temporary=''
gate_marker_temporary_identity=''
public_marker_published='false'
deploy_temporary=''
v2_deploy_temporary=''
v2_validator_temporary=''
v2_attestation_temporary=''
wrapper_temporary=''
helper_temporary=''
compose_temporary=''
sudoers_temporary=''
compile_cache=''
staging_dir=''
backup_dir=''
transaction_started='false'
transaction_committed='false'
BACKUP_PRESENT=()
BACKUP_HASHES=()
BACKUP_ATTRIBUTES=()

snapshot_targets() {
  local index target backup_path target_hash target_attributes
  backup_dir="$(mktemp -d "$INSTALL_BACKUP_ROOT/kinvest-deploy-v3-backup.XXXXXX")"
  chmod 0700 "$backup_dir"
  chown "$INSTALL_OWNER:$INSTALL_GROUP" "$backup_dir"
  for index in "${!TARGETS[@]}"; do
    target="${TARGETS[$index]}"
    backup_path="$backup_dir/${TARGET_NAMES[$index]}.asset"
    if [[ -e "$target" || -L "$target" ]]; then
      if [[ ! -f "$target" || -L "$target" ]]; then
        printf '%s\n' "refusing non-regular deploy-v3 target during snapshot: $target" >&2
        return 1
      fi
      BACKUP_PRESENT[$index]='true'
      target_hash="$(file_hash "$target")"
      target_attributes="$(file_attributes "$target")"
      cp -p -- "$target" "$backup_path"
      if [[ "$(file_hash "$backup_path")" != "$target_hash" \
        || "$(file_attributes "$backup_path")" != "$target_attributes" ]]; then
        printf '%s\n' "deploy-v3 backup verification failed: $target" >&2
        return 1
      fi
      BACKUP_HASHES[$index]="$target_hash"
      BACKUP_ATTRIBUTES[$index]="$target_attributes"
    else
      BACKUP_PRESENT[$index]='false'
      : > "$backup_dir/${TARGET_NAMES[$index]}.absent"
      chmod 0600 "$backup_dir/${TARGET_NAMES[$index]}.absent"
      chown "$INSTALL_OWNER:$INSTALL_GROUP" "$backup_dir/${TARGET_NAMES[$index]}.absent"
      BACKUP_HASHES[$index]=''
      BACKUP_ATTRIBUTES[$index]=''
    fi
  done
  {
    printf '%s\n' 'kinvest-deploy-v3-install-backup-v1'
    for index in "${!TARGETS[@]}"; do
      printf '%s|%s|%s|%s\n' "${TARGET_NAMES[$index]}" "${BACKUP_PRESENT[$index]}" "${BACKUP_HASHES[$index]}" "${BACKUP_ATTRIBUTES[$index]}"
    done
  } >"$backup_dir/manifest.txt"
  chmod 0600 "$backup_dir/manifest.txt"
  chown "$INSTALL_OWNER:$INSTALL_GROUP" "$backup_dir/manifest.txt"
}

rollback_targets() {
  local index target backup_path restore_temporary owner group mode rollback_failed
  rollback_failed='false'
  for index in "${!TARGETS[@]}"; do
    target="${TARGETS[$index]}"
    if [[ "${BACKUP_PRESENT[$index]:-}" == 'true' ]]; then
      backup_path="$backup_dir/${TARGET_NAMES[$index]}.asset"
      restore_temporary="$(mktemp "$(dirname -- "$target")/.kinvest-v3-restore-${TARGET_NAMES[$index]}.XXXXXX")" || {
        rollback_failed='true'
        continue
      }
      if ! cp -p -- "$backup_path" "$restore_temporary"; then
        rollback_failed='true'
      fi
      IFS=: read -r owner group mode <<< "${BACKUP_ATTRIBUTES[$index]}"
      chown "$owner:$group" "$restore_temporary" || rollback_failed='true'
      chmod "$mode" "$restore_temporary" || rollback_failed='true'
      if [[ "$(file_hash "$restore_temporary")" != "${BACKUP_HASHES[$index]}" \
        || "$(file_attributes "$restore_temporary")" != "${BACKUP_ATTRIBUTES[$index]}" ]]; then
        rollback_failed='true'
      elif ! mv -fT -- "$restore_temporary" "$target"; then
        rollback_failed='true'
      fi
      rm -f -- "$restore_temporary"
    elif [[ -e "$target" || -L "$target" ]]; then
      if [[ -f "$target" || -L "$target" ]]; then
        rm -f -- "$target" || rollback_failed='true'
      else
        rollback_failed='true'
      fi
    fi
  done

  for index in "${!TARGETS[@]}"; do
    target="${TARGETS[$index]}"
    if [[ "${BACKUP_PRESENT[$index]:-}" == 'true' ]]; then
      if [[ ! -f "$target" || -L "$target" \
        || "$(file_hash "$target")" != "${BACKUP_HASHES[$index]}" \
        || "$(file_attributes "$target")" != "${BACKUP_ATTRIBUTES[$index]}" ]]; then
        rollback_failed='true'
      fi
    elif [[ -e "$target" || -L "$target" ]]; then
      rollback_failed='true'
    fi
  done
  [[ "$rollback_failed" == 'false' ]]
}

cleanup() {
  local cleanup_status="$?"
  local restore_status
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  restore_status=0
  if [[ "$transaction_started" == 'true' && "$transaction_committed" != 'true' ]]; then
    rollback_targets || restore_status=1
  fi
  if [[ "$public_marker_published" == 'true' && "$restore_status" -eq 0 ]]; then
    clear_gate_marker || restore_status=1
  fi
  cleanup_gate_temporaries || restore_status=1
  rm -f -- "$v2_deploy_temporary" "$v2_validator_temporary" "$v2_attestation_temporary" "$deploy_temporary" "$wrapper_temporary" "$helper_temporary" "$compose_temporary" "$sudoers_temporary"
  if [[ -n "$compile_cache" ]]; then
    rm -rf -- "$compile_cache"
  fi
  if [[ -n "$staging_dir" ]]; then
    rm -rf -- "$staging_dir"
  fi
  if [[ "$restore_status" -ne 0 ]]; then
    printf '%s\n' 'deploy-v3 transactional rollback failed' >&2
    printf 'deploy-v3 recovery backup preserved at %s\n' "$backup_dir" >&2
    cleanup_status=1
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT
on_signal() {
  exit "$1"
}
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

resolve_gate_identity || fail 'DEPLOY_V3_GATE_IDENTITY_INVALID'
prepare_gate_directory || fail 'DEPLOY_V3_GATE_STATE_INVALID'
exec 8<"$GATE_STATE_DIR"
flock -n 8 || fail 'another Kinvest installer is already running'
exec 9>"$DEPLOY_LOCK"
flock -n 9 || fail 'another Kinvest deployment is already running'
[[ "$(file_attributes "$GATE_STATE_DIR")" == "${GATE_ROOT_OWNER%%:*}:$GATE_GROUP_GID:750" ]] || fail 'DEPLOY_V3_GATE_IDENTITY_MISMATCH'
reconcile_gate_temporaries || fail 'DEPLOY_V3_GATE_TEMP_INVALID'
if [[ -e "$GATE_INSTALL_MARKER" || -L "$GATE_INSTALL_MARKER" ]]; then
  validate_gate_marker || fail 'DEPLOY_V3_GATE_STATE_INVALID'
  fail 'DEPLOY_INSTALL_INCOMPLETE' 76
fi
validate_or_publish_gate_identity || fail 'DEPLOY_V3_GATE_IDENTITY_INVALID'

for target in "${TARGETS[@]}"; do
  if [[ ( -e "$target" || -L "$target" ) && ( ! -f "$target" || -L "$target" ) ]]; then
    fail "refusing non-regular deploy-v3 target: $target"
  fi
done

for index in "${!SOURCE_ASSETS[@]}"; do
  if [[ "$(file_hash "$SOURCE_DIR/${SOURCE_ASSETS[$index]}")" != "${EXPECTED_ASSET_HASHES[$index]}" ]]; then
    fail "untrusted deploy-v3 source hash: ${SOURCE_ASSETS[$index]}"
  fi
done

staging_dir="$(mktemp -d "$RUN_ROOT/kinvest-deploy-v3-stage.XXXXXX")"
chmod 0700 "$staging_dir"
chown "$INSTALL_OWNER:$INSTALL_GROUP" "$staging_dir"
for index in "${!SOURCE_ASSETS[@]}"; do
  install -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m "${ASSET_MODES[$index]}" -- \
    "$SOURCE_DIR/${SOURCE_ASSETS[$index]}" "$staging_dir/${SOURCE_ASSETS[$index]}"
  if [[ "$(file_hash "$staging_dir/${SOURCE_ASSETS[$index]}")" != "${EXPECTED_ASSET_HASHES[$index]}" ]]; then
    fail "staged deploy-v3 source changed: ${SOURCE_ASSETS[$index]}"
  fi
done

compile_cache="$(mktemp -d "$RUN_ROOT/kinvest-deploy-v3-pycache.XXXXXX")"
PYTHONPYCACHEPREFIX="$compile_cache" python3 -m py_compile "$staging_dir/secret-version-config.py" "$staging_dir/offline-image-attestation.py"
validator_output="$(printf '{}\n' | python3 "$staging_dir/secret-version-config.py" mapping)"
[[ "$validator_output" == '{}' ]] || fail 'staged deploy-v2 validator self-check failed'
attestation_output="$(python3 "$staging_dir/offline-image-attestation.py" self-check)"
[[ "$attestation_output" == KINVEST_OFFLINE_ATTESTATION_SELF_CHECK_OK ]] || fail 'staged deploy-v2 attestation self-check failed'
PYTHONPYCACHEPREFIX="$compile_cache" python3 -m py_compile "$staging_dir/deploy-v3-contract.py"
v2_deploy_temporary="$(mktemp "$LOCAL_SBIN/.deploy-kinvest-v2.XXXXXX")"
v2_validator_temporary="$(mktemp "$LOCAL_LIBEXEC/.kinvest-secret-version-config.XXXXXX")"
v2_attestation_temporary="$(mktemp "$LOCAL_LIBEXEC/.kinvest-offline-image-attestation.XXXXXX")"
deploy_temporary="$(mktemp "$LOCAL_SBIN/.deploy-kinvest-v3.XXXXXX")"
wrapper_temporary="$(mktemp "$LOCAL_SBIN/.kinvest-ssh-command.XXXXXX")"
helper_temporary="$(mktemp "$LOCAL_LIBEXEC/.kinvest-deploy-v3-contract.XXXXXX")"
compose_temporary="$(mktemp "$SERVER_ROOT/.docker-compose-v3.XXXXXX")"
sudoers_temporary="$(mktemp "$SUDOERS_DIR/.kinvest-deploy-v3.XXXXXX")"

install -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m 0755 -- "$staging_dir/deploy-kinvest-v2.sh" "$v2_deploy_temporary"
install -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m 0755 -- "$staging_dir/secret-version-config.py" "$v2_validator_temporary"
install -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m 0755 -- "$staging_dir/offline-image-attestation.py" "$v2_attestation_temporary"
install -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m 0755 -- "$staging_dir/deploy-kinvest-v3.sh" "$deploy_temporary"
install -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m 0755 -- "$staging_dir/kinvest-ssh-command-v3" "$wrapper_temporary"
install -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m 0755 -- "$staging_dir/deploy-v3-contract.py" "$helper_temporary"
install -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m 0644 -- "$staging_dir/docker-compose-v3.yml" "$compose_temporary"
sed "s/@KINVEST_DEPLOY_GATE_USER@/$GATE_USER/g" "$staging_dir/kinvest-deploy-v4.sudoers.in" >"$sudoers_temporary"
chown "$INSTALL_OWNER:$INSTALL_GROUP" "$sudoers_temporary"
chmod 0440 "$sudoers_temporary"
expected_sudoers="$GATE_USER ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest \"\""$'\n'"$GATE_USER ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest-v3 \"\""$'\n'"$GATE_USER ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest-v4 \"\""
[[ "$(cat "$sudoers_temporary")" == "$expected_sudoers" ]] || fail 'DEPLOY_V3_SUDOERS_RENDER_INVALID'
INSTALL_HASHES[7]="$(file_hash "$sudoers_temporary")"
bash -n "$v2_deploy_temporary"
bash -n "$deploy_temporary"
bash -n "$wrapper_temporary"
PYTHONPYCACHEPREFIX="$compile_cache" python3 -m py_compile "$helper_temporary"
[[ -s "$compose_temporary" ]] || fail 'staged deploy-v3 compose verification failed'
visudo -cf "$sudoers_temporary" >/dev/null

PYTHONPYCACHEPREFIX="$compile_cache" python3 -m py_compile "$v2_validator_temporary" "$v2_attestation_temporary"
staged_path=("$v2_deploy_temporary" "$v2_validator_temporary" "$v2_attestation_temporary" "$deploy_temporary" "$wrapper_temporary" "$helper_temporary" "$compose_temporary" "$sudoers_temporary")
for index in "${!TARGETS[@]}"; do
  if [[ ! -f "${staged_path[$index]}" || -L "${staged_path[$index]}" \
    || "$(file_hash "${staged_path[$index]}")" != "${INSTALL_HASHES[$index]}" \
    || "$(file_attributes "${staged_path[$index]}")" != "$expected_owner:$expected_group:${ASSET_MODES[$index]#0}" ]]; then
    fail "staged deploy-v3 asset verification failed: ${SOURCE_ASSETS[$index]}"
  fi
done

snapshot_targets
publish_gate_marker || fail 'DEPLOY_V3_GATE_MARKER_FAILED'
transaction_started='true'

# Install the root transaction program before its wrapper. No asset installation
# invokes the deployer, Compose, Docker, or systemd.
mv -fT -- "$v2_deploy_temporary" "$V2_DEPLOY_TARGET"
v2_deploy_temporary=''
mv -fT -- "$v2_validator_temporary" "$V2_VALIDATOR_TARGET"
v2_validator_temporary=''
mv -fT -- "$v2_attestation_temporary" "$V2_ATTESTATION_TARGET"
v2_attestation_temporary=''
mv -fT -- "$deploy_temporary" "$DEPLOY_TARGET"
deploy_temporary=''
mv -fT -- "$helper_temporary" "$HELPER_TARGET"
helper_temporary=''
mv -fT -- "$compose_temporary" "$COMPOSE_TARGET"
compose_temporary=''
mv -fT -- "$sudoers_temporary" "$SUDOERS_TARGET"
sudoers_temporary=''
mv -fT -- "$wrapper_temporary" "$WRAPPER_TARGET"
wrapper_temporary=''

for index in "${!TARGETS[@]}"; do
  target="${TARGETS[$index]}"
  if [[ ! -f "$target" || -L "$target" \
    || "$(file_hash "$target")" != "${INSTALL_HASHES[$index]}" \
    || "$(file_attributes "$target")" != "$expected_owner:$expected_group:${ASSET_MODES[$index]#0}" ]]; then
    fail "installed deploy-v3 asset verification failed: $target"
  fi
done
bash -n "$V2_DEPLOY_TARGET"
bash -n "$DEPLOY_TARGET"
bash -n "$WRAPPER_TARGET"
PYTHONPYCACHEPREFIX="$compile_cache" python3 -m py_compile "$HELPER_TARGET"
PYTHONPYCACHEPREFIX="$compile_cache" python3 -m py_compile "$V2_VALIDATOR_TARGET" "$V2_ATTESTATION_TARGET"
visudo -cf "$SUDOERS_TARGET" >/dev/null
sudo -n -U "$GATE_USER" -l "$LOCAL_SBIN/deploy-kinvest" >/dev/null
sudo -n -U "$GATE_USER" -l "$LOCAL_SBIN/deploy-kinvest-v3" >/dev/null
sudo -n -U "$GATE_USER" -l "$LOCAL_SBIN/deploy-kinvest-v4" >/dev/null
clear_gate_marker || fail 'DEPLOY_V3_GATE_MARKER_CLEAR_FAILED'
transaction_committed='true'

sha256sum "$DEPLOY_TARGET" "$WRAPPER_TARGET" "$HELPER_TARGET" "$COMPOSE_TARGET" "$SUDOERS_TARGET"
printf 'deploy-v3 installation backup preserved at %s\n' "$backup_dir"
printf '%s\n' 'deploy-v3 assets installed transactionally; no container was restarted.'
