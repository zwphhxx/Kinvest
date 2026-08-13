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
DEPLOY_USER='lighthouse'

DEPLOY_TARGET="$LOCAL_SBIN/deploy-kinvest-v3"
WRAPPER_TARGET="$LOCAL_SBIN/kinvest-ssh-command"
HELPER_TARGET="$LOCAL_LIBEXEC/kinvest-deploy-v3-contract"
COMPOSE_TARGET="$SERVER_ROOT/docker-compose-v3.yml"
SUDOERS_TARGET="$SUDOERS_DIR/kinvest-deploy-v3"
DEPLOY_LOCK="$SERVER_ROOT/state/deploy.lock"
INSTALL_BACKUP_ROOT="$SERVER_ROOT/install-backups/deploy-v3"

SOURCE_ASSETS=('deploy-kinvest-v3.sh' 'kinvest-ssh-command-v3' 'deploy-v3-contract.py' 'docker-compose-v3.yml' 'kinvest-deploy-v3.sudoers')
TARGETS=("$DEPLOY_TARGET" "$WRAPPER_TARGET" "$HELPER_TARGET" "$COMPOSE_TARGET" "$SUDOERS_TARGET")
TARGET_NAMES=('deployer' 'wrapper' 'helper' 'compose' 'sudoers')
ASSET_MODES=('0755' '0755' '0755' '0644' '0440')
EXPECTED_ASSET_HASHES=(
  '8bb3a2e0e31649440a8a920d2fc4afdecf2a11abf31817074d737d8356a45306'
  'c9bcc3ef8a3e462425423a6f6f5e4b9aa8a84b9cd242d06f04ab592be667f606'
  '52605d387571f05a5df52e5f6484ec1962c5aa4b758ab0fe0a45521ae51df008'
  'a422a8ce78ab16bf589a66508d4a7dfdd3ba05238a80784992ed62e959767eff'
  '4293e524d7aa95bde30cb4b2152df8e6c93571200d757ec9697f58448c5612b8'
)

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

for target in "${TARGETS[@]}"; do
  if [[ ( -e "$target" || -L "$target" ) && ( ! -f "$target" || -L "$target" ) ]]; then
    fail "refusing non-regular deploy-v3 target: $target"
  fi
done

file_hash() {
  sha256sum "$1" | awk '{print $1}'
}

file_attributes() {
  python3 -c 'import os, stat, sys; value=os.stat(sys.argv[1], follow_symlinks=False); print(f"{value.st_uid}:{value.st_gid}:{stat.S_IMODE(value.st_mode):o}")' "$1"
}

expected_owner="$(python3 -c 'import pwd, sys; value=sys.argv[1]; print(int(value) if value.isdigit() else pwd.getpwnam(value).pw_uid)' "$INSTALL_OWNER")"
expected_group="$(python3 -c 'import grp, sys; value=sys.argv[1]; print(int(value) if value.isdigit() else grp.getgrnam(value).gr_gid)' "$INSTALL_GROUP")"

deploy_temporary=''
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
  rm -f -- "$deploy_temporary" "$wrapper_temporary" "$helper_temporary" "$compose_temporary" "$sudoers_temporary"
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
PYTHONPYCACHEPREFIX="$compile_cache" python3 -m py_compile "$staging_dir/deploy-v3-contract.py"
deploy_temporary="$(mktemp "$LOCAL_SBIN/.deploy-kinvest-v3.XXXXXX")"
wrapper_temporary="$(mktemp "$LOCAL_SBIN/.kinvest-ssh-command.XXXXXX")"
helper_temporary="$(mktemp "$LOCAL_LIBEXEC/.kinvest-deploy-v3-contract.XXXXXX")"
compose_temporary="$(mktemp "$SERVER_ROOT/.docker-compose-v3.XXXXXX")"
sudoers_temporary="$(mktemp "$SUDOERS_DIR/.kinvest-deploy-v3.XXXXXX")"

install -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m 0755 -- "$staging_dir/deploy-kinvest-v3.sh" "$deploy_temporary"
install -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m 0755 -- "$staging_dir/kinvest-ssh-command-v3" "$wrapper_temporary"
install -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m 0755 -- "$staging_dir/deploy-v3-contract.py" "$helper_temporary"
install -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m 0644 -- "$staging_dir/docker-compose-v3.yml" "$compose_temporary"
install -o "$INSTALL_OWNER" -g "$INSTALL_GROUP" -m 0440 -- "$staging_dir/kinvest-deploy-v3.sudoers" "$sudoers_temporary"
bash -n "$deploy_temporary"
bash -n "$wrapper_temporary"
PYTHONPYCACHEPREFIX="$compile_cache" python3 -m py_compile "$helper_temporary"
[[ -s "$compose_temporary" ]] || fail 'staged deploy-v3 compose verification failed'
visudo -cf "$sudoers_temporary" >/dev/null

staged_path=("$deploy_temporary" "$wrapper_temporary" "$helper_temporary" "$compose_temporary" "$sudoers_temporary")
for index in "${!TARGETS[@]}"; do
  if [[ ! -f "${staged_path[$index]}" || -L "${staged_path[$index]}" \
    || "$(file_hash "${staged_path[$index]}")" != "${EXPECTED_ASSET_HASHES[$index]}" \
    || "$(file_attributes "${staged_path[$index]}")" != "$expected_owner:$expected_group:${ASSET_MODES[$index]#0}" ]]; then
    fail "staged deploy-v3 asset verification failed: ${SOURCE_ASSETS[$index]}"
  fi
done

exec 9>"$DEPLOY_LOCK"
if ! flock -n 9; then
  fail 'another Kinvest deployment is already running'
fi
snapshot_targets
transaction_started='true'

# Install the root transaction program before its wrapper. No asset installation
# invokes the deployer, Compose, Docker, or systemd.
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
    || "$(file_hash "$target")" != "${EXPECTED_ASSET_HASHES[$index]}" \
    || "$(file_attributes "$target")" != "$expected_owner:$expected_group:${ASSET_MODES[$index]#0}" ]]; then
    fail "installed deploy-v3 asset verification failed: $target"
  fi
done
bash -n "$DEPLOY_TARGET"
bash -n "$WRAPPER_TARGET"
PYTHONPYCACHEPREFIX="$compile_cache" python3 -m py_compile "$HELPER_TARGET"
visudo -cf "$SUDOERS_TARGET" >/dev/null
sudo -n -U "$DEPLOY_USER" -l "$DEPLOY_TARGET" >/dev/null
sudo -n -U "$DEPLOY_USER" -l "$LOCAL_SBIN/deploy-kinvest-v2" >/dev/null
transaction_committed='true'

sha256sum "$DEPLOY_TARGET" "$WRAPPER_TARGET" "$HELPER_TARGET" "$COMPOSE_TARGET" "$SUDOERS_TARGET"
printf 'deploy-v3 installation backup preserved at %s\n' "$backup_dir"
printf '%s\n' 'deploy-v3 assets installed transactionally; no container was restarted.'
