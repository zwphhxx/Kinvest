#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-}"
LOCAL_DEPLOY_SCRIPT='/usr/local/sbin/deploy-kinvest'
LOCAL_SSH_COMMAND='/usr/local/sbin/kinvest-ssh-command'
LOCAL_SECRET_VALIDATOR='/usr/local/libexec/kinvest-secret-version-config'
LOCAL_OFFLINE_ATTESTATION='/usr/local/libexec/kinvest-offline-image-attestation'
TARGETS=("$LOCAL_DEPLOY_SCRIPT" "$LOCAL_SSH_COMMAND" "$LOCAL_SECRET_VALIDATOR" "$LOCAL_OFFLINE_ATTESTATION")
TARGET_NAMES=('deployer' 'wrapper' 'validator' 'offline-attestation')
SOURCE_ASSETS=('deploy-kinvest-v2.sh' 'kinvest-ssh-command-v2' 'secret-version-config.py' 'offline-image-attestation.py')

if [[ "$#" -ne 1 || "$SOURCE_DIR" != /* || ! -d "$SOURCE_DIR" ]]; then
  printf '%s\n' 'usage: install-deploy-v2.sh /absolute/canonical/source/dir' >&2
  exit 2
fi

if [[ "$(id -u)" -ne 0 ]]; then
  printf '%s\n' 'deploy-v2 installation must run as root' >&2
  exit 1
fi

if [[ "$(realpath -e -- "$SOURCE_DIR")" != "$SOURCE_DIR" ]]; then
  printf '%s\n' 'deploy-v2 source directory must be canonical' >&2
  exit 2
fi

for source_file in deploy-kinvest-v2.sh kinvest-ssh-command-v2; do
  if [[ ! -f "$SOURCE_DIR/$source_file" || -L "$SOURCE_DIR/$source_file" ]]; then
    printf '%s\n' "invalid deploy-v2 source file: $source_file" >&2
    exit 1
  fi
  bash -n "$SOURCE_DIR/$source_file"
done
if [[ ! -f "$SOURCE_DIR/secret-version-config.py" || -L "$SOURCE_DIR/secret-version-config.py" ]]; then
  printf '%s\n' 'invalid deploy-v2 source file: secret-version-config.py' >&2
  exit 1
fi
validator_output="$(printf '{}\n' | python3 "$SOURCE_DIR/secret-version-config.py" mapping)"
[[ "$validator_output" == '{}' ]]
if [[ ! -f "$SOURCE_DIR/offline-image-attestation.py" || -L "$SOURCE_DIR/offline-image-attestation.py" ]]; then
  printf '%s\n' 'invalid deploy-v2 source file: offline-image-attestation.py' >&2
  exit 1
fi
EXPECTED_ASSET_HASHES=()
for source_asset in "${SOURCE_ASSETS[@]}"; do
  EXPECTED_ASSET_HASHES+=("$(sha256sum "$SOURCE_DIR/$source_asset" | awk '{print $1}')")
done
expected_attestation_hash="${EXPECTED_ASSET_HASHES[3]}"
for target in "${TARGETS[@]}"; do
  if [[ ( -e "$target" || -L "$target" ) && ( ! -f "$target" || -L "$target" ) ]]; then
    printf '%s\n' "refusing non-regular deploy-v2 target: $target" >&2
    exit 1
  fi
done
if [[ -L /usr/local/libexec ]]; then
  printf '%s\n' 'refusing symlinked deploy-v2 target directory: /usr/local/libexec' >&2
  exit 1
fi
install -d -o root -g root -m 0755 -- /usr/local/libexec

deploy_temporary=''
wrapper_temporary=''
validator_temporary=''
attestation_temporary=''
compile_cache=''
backup_dir=''
transaction_started='false'
transaction_committed='false'
BACKUP_PRESENT=()
BACKUP_HASHES=()
BACKUP_ATTRIBUTES=()

snapshot_targets() {
  local index target backup_path target_hash target_attributes
  backup_dir="$(mktemp -d /run/kinvest-deploy-v2-backup.XXXXXX)"
  chmod 0700 "$backup_dir"
  chown root:root "$backup_dir"
  for index in "${!TARGETS[@]}"; do
    target="${TARGETS[$index]}"
    backup_path="$backup_dir/${TARGET_NAMES[$index]}.asset"
    if [[ -e "$target" || -L "$target" ]]; then
      if [[ ! -f "$target" || -L "$target" ]]; then
        printf '%s\n' "refusing non-regular deploy-v2 target during snapshot: $target" >&2
        return 1
      fi
      BACKUP_PRESENT[$index]='true'
      target_hash="$(sha256sum "$target" | awk '{print $1}')"
      target_attributes="$(stat -c '%u:%g:%a' "$target")"
      cp --preserve=mode,ownership,timestamps -- "$target" "$backup_path"
      if [[ "$(sha256sum "$backup_path" | awk '{print $1}')" != "$target_hash" \
        || "$(stat -c '%u:%g:%a' "$backup_path")" != "$target_attributes" ]]; then
        printf '%s\n' "deploy-v2 backup verification failed: $target" >&2
        return 1
      fi
      BACKUP_HASHES[$index]="$target_hash"
      BACKUP_ATTRIBUTES[$index]="$target_attributes"
    else
      BACKUP_PRESENT[$index]='false'
      : > "$backup_dir/${TARGET_NAMES[$index]}.absent"
      chmod 0600 "$backup_dir/${TARGET_NAMES[$index]}.absent"
      chown root:root "$backup_dir/${TARGET_NAMES[$index]}.absent"
      BACKUP_HASHES[$index]=''
      BACKUP_ATTRIBUTES[$index]=''
    fi
  done
}

restore_targets() {
  local index target backup_path restore_temporary owner group mode restore_failed
  restore_failed='false'
  for index in "${!TARGETS[@]}"; do
    target="${TARGETS[$index]}"
    if [[ "${BACKUP_PRESENT[$index]:-}" == 'true' ]]; then
      backup_path="$backup_dir/${TARGET_NAMES[$index]}.asset"
      restore_temporary="$(mktemp "$(dirname -- "$target")/.kinvest-restore-${TARGET_NAMES[$index]}.XXXXXX")" || {
        restore_failed='true'
        continue
      }
      cp --preserve=mode,ownership,timestamps -- "$backup_path" "$restore_temporary" || restore_failed='true'
      IFS=: read -r owner group mode <<< "${BACKUP_ATTRIBUTES[$index]}"
      chown "$owner:$group" "$restore_temporary" || restore_failed='true'
      chmod "$mode" "$restore_temporary" || restore_failed='true'
      if [[ "$(sha256sum "$restore_temporary" | awk '{print $1}')" != "${BACKUP_HASHES[$index]}" \
        || "$(stat -c '%u:%g:%a' "$restore_temporary")" != "${BACKUP_ATTRIBUTES[$index]}" ]]; then
        restore_failed='true'
      elif ! mv -fT -- "$restore_temporary" "$target"; then
        restore_failed='true'
      fi
      rm -f -- "$restore_temporary"
    else
      if [[ -e "$target" || -L "$target" ]]; then
        if [[ -f "$target" || -L "$target" ]]; then
          rm -f -- "$target" || restore_failed='true'
        else
          restore_failed='true'
        fi
      fi
    fi
  done
  for index in "${!TARGETS[@]}"; do
    target="${TARGETS[$index]}"
    if [[ "${BACKUP_PRESENT[$index]:-}" == 'true' ]]; then
      if [[ ! -f "$target" || -L "$target" \
        || "$(sha256sum "$target" | awk '{print $1}')" != "${BACKUP_HASHES[$index]}" \
        || "$(stat -c '%u:%g:%a' "$target")" != "${BACKUP_ATTRIBUTES[$index]}" ]]; then
        restore_failed='true'
      fi
    elif [[ -e "$target" || -L "$target" ]]; then
      restore_failed='true'
    fi
  done
  [[ "$restore_failed" == 'false' ]]
}

cleanup() {
  cleanup_status="$?"
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  restore_status=0
  if [[ "$transaction_started" == 'true' && "$transaction_committed" != 'true' ]]; then
    restore_targets || restore_status=1
  fi
  rm -f -- "$deploy_temporary" "$wrapper_temporary" "$validator_temporary" "$attestation_temporary"
  if [[ -n "$compile_cache" ]]; then
    rm -rf -- "$compile_cache"
  fi
  if [[ -n "$backup_dir" && "$restore_status" -eq 0 ]]; then
    rm -rf -- "$backup_dir"
  fi
  if [[ "$restore_status" -ne 0 ]]; then
    printf '%s\n' 'deploy-v2 transactional restoration failed' >&2
    printf 'deploy-v2 recovery backup preserved at %s\n' "$backup_dir" >&2
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

deploy_temporary="$(mktemp /usr/local/sbin/.deploy-kinvest-v2.XXXXXX)"
wrapper_temporary="$(mktemp /usr/local/sbin/.kinvest-ssh-command-v2.XXXXXX)"
validator_temporary="$(mktemp /usr/local/libexec/.kinvest-secret-version-config.XXXXXX)"
attestation_temporary="$(mktemp /usr/local/libexec/.kinvest-offline-image-attestation.XXXXXX)"
compile_cache="$(mktemp -d /run/kinvest-offline-pycache.XXXXXX)"

PYTHONPYCACHEPREFIX="$compile_cache" python3 -m py_compile "$SOURCE_DIR/offline-image-attestation.py"
attestation_output="$(python3 "$SOURCE_DIR/offline-image-attestation.py" self-check)"
[[ "$attestation_output" == 'KINVEST_OFFLINE_ATTESTATION_SELF_CHECK_OK' ]]

install -o root -g root -m 0755 -- "$SOURCE_DIR/deploy-kinvest-v2.sh" "$deploy_temporary"
install -o root -g root -m 0755 -- "$SOURCE_DIR/kinvest-ssh-command-v2" "$wrapper_temporary"
install -o root -g root -m 0755 -- "$SOURCE_DIR/secret-version-config.py" "$validator_temporary"
install -o root -g root -m 0755 -- "$SOURCE_DIR/offline-image-attestation.py" "$attestation_temporary"
bash -n "$deploy_temporary"
bash -n "$wrapper_temporary"
validator_output="$(printf '{}\n' | python3 "$validator_temporary" mapping)"
[[ "$validator_output" == '{}' ]]
PYTHONPYCACHEPREFIX="$compile_cache" python3 -m py_compile "$attestation_temporary"
attestation_output="$(python3 "$attestation_temporary" self-check)"
[[ "$attestation_output" == 'KINVEST_OFFLINE_ATTESTATION_SELF_CHECK_OK' ]]

# Install the root program first. Until the wrapper is replaced, an old two-line
# request fails closed against the v2 envelope. No deployment is started here.
snapshot_targets
transaction_started='true'
mv -fT -- "$deploy_temporary" "$LOCAL_DEPLOY_SCRIPT"
deploy_temporary=''
mv -fT -- "$validator_temporary" "$LOCAL_SECRET_VALIDATOR"
validator_temporary=''
mv -fT -- "$attestation_temporary" "$LOCAL_OFFLINE_ATTESTATION"
attestation_temporary=''

installed_attestation_attributes="$(stat -c '%u:%g:%a' "$LOCAL_OFFLINE_ATTESTATION")"
installed_attestation_hash="$(sha256sum "$LOCAL_OFFLINE_ATTESTATION" | awk '{print $1}')"
installed_attestation_output="$(python3 "$LOCAL_OFFLINE_ATTESTATION" self-check)"
if [[ ! -f "$LOCAL_OFFLINE_ATTESTATION" \
  || -L "$LOCAL_OFFLINE_ATTESTATION" \
  || "$installed_attestation_attributes" != '0:0:755' \
  || "$installed_attestation_hash" != "$expected_attestation_hash" \
  || "$installed_attestation_output" != 'KINVEST_OFFLINE_ATTESTATION_SELF_CHECK_OK' ]]; then
  printf '%s\n' 'installed offline attestation helper verification failed' >&2
  exit 1
fi

mv -fT -- "$wrapper_temporary" "$LOCAL_SSH_COMMAND"
wrapper_temporary=''

for index in "${!TARGETS[@]}"; do
  target="${TARGETS[$index]}"
  if [[ ! -f "$target" || -L "$target" \
    || "$(stat -c '%u:%g:%a' "$target")" != '0:0:755' \
    || "$(sha256sum "$target" | awk '{print $1}')" != "${EXPECTED_ASSET_HASHES[$index]}" ]]; then
    printf '%s\n' "installed deploy-v2 asset verification failed: $target" >&2
    exit 1
  fi
done
installed_attestation_output="$(python3 "$LOCAL_OFFLINE_ATTESTATION" self-check)"
[[ "$installed_attestation_output" == 'KINVEST_OFFLINE_ATTESTATION_SELF_CHECK_OK' ]]
transaction_committed='true'

sha256sum "$LOCAL_DEPLOY_SCRIPT" "$LOCAL_SSH_COMMAND" "$LOCAL_SECRET_VALIDATOR" "$LOCAL_OFFLINE_ATTESTATION"
printf '%s\n' 'deploy-v2 entrypoint installed; no container was restarted.'
