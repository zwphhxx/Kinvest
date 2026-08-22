#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-}"
LOCAL_SBIN='/usr/local/sbin'
LOCAL_LIBEXEC='/usr/local/libexec'
SERVER_ROOT='/root/docker/kinvest'
SUDOERS_DIR='/etc/sudoers.d'
RUN_ROOT='/run'
BACKUP_ROOT="$SERVER_ROOT/install-backups/deploy-v4"
INSTALL_JOURNAL="$SERVER_ROOT/state/install-v4.journal"
SOURCE_ASSETS=('deploy-kinvest-v4' 'deploy-kinvest-v3.sh' 'kinvest-ssh-command-v3' 'deploy-v3-contract.py' 'docker-compose-v3.yml' 'kinvest-deploy-v4.sudoers' 'access-control-network.conf.example')
TARGETS=("$LOCAL_SBIN/deploy-kinvest-v4" "$LOCAL_SBIN/deploy-kinvest-v3" "$LOCAL_SBIN/kinvest-ssh-command" "$LOCAL_LIBEXEC/kinvest-deploy-v4-contract" "$SERVER_ROOT/docker-compose-v4.yml" "$SUDOERS_DIR/kinvest-deploy-v4" "$SERVER_ROOT/access-control-network.conf.example")
MODES=('0755' '0755' '0755' '0755' '0644' '0440' '0600')
EXPECTED_ASSET_HASHES=(
  'fb25bd314ab46e3af56fe46e83564000d7388d6f7670b63d370b4047d2d4e86d'
  'bfeb96bd0ee29b819e178288568e2a7ab443ca6885ec6487e6e5a5f52cc06599'
  '67639f9e54b2b0682292f6744f8d97ffa9f2a2870148f7aa5d881b8c3f1f9834'
  'b7652e47a17ac1f94177ca15a1780ffd82f137bbf7c5d6aea136095a1413dc68'
  '7698dd619fb6a441763f85e4e35c819af55e431c6d0ac9c4b527930d07a644aa'
  '3001cab7876d3d03b3188aa60f25450d0010ba272e2419b10a5da2fba9ad51cf'
  'cef9b242ad3de3c2134e2a4e7e1ae1693ce55cd63bb9ac9d65710ec796309594'
)

fail() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }
file_hash() { sha256sum "$1" | awk '{print $1}'; }
file_attributes() {
  python3 -c 'import os,stat,sys; v=os.stat(sys.argv[1],follow_symlinks=False); print(f"{v.st_uid}:{v.st_gid}:{stat.S_IMODE(v.st_mode):o}")' "$1"
}
fsync_directory() {
  python3 -c 'import os,sys; descriptor=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY); os.fsync(descriptor); os.close(descriptor)' "$1"
}

[[ "$#" -eq 1 && "$SOURCE_DIR" == /* && -d "$SOURCE_DIR" && ! -L "$SOURCE_DIR" ]] || fail 'usage: install-deploy-v4.sh /absolute/canonical/source/dir' 2
[[ "$(id -u)" -eq 0 ]] || fail 'deploy-v4 installation must run as root'
[[ "$(realpath -e "$SOURCE_DIR")" == "$SOURCE_DIR" ]] || fail 'deploy-v4 source directory must be canonical'

for index in "${!SOURCE_ASSETS[@]}"; do
  source="$SOURCE_DIR/${SOURCE_ASSETS[$index]}"
  [[ -f "$source" && ! -L "$source" ]] || fail "invalid deploy-v4 source file: ${SOURCE_ASSETS[$index]}"
  [[ "$(file_hash "$source")" == "${EXPECTED_ASSET_HASHES[$index]}" ]] || fail "untrusted deploy-v4 source hash: ${SOURCE_ASSETS[$index]}"
done
bash -n "$SOURCE_DIR/deploy-kinvest-v4"
bash -n "$SOURCE_DIR/deploy-kinvest-v3.sh"
bash -n "$SOURCE_DIR/kinvest-ssh-command-v3"
PYTHONDONTWRITEBYTECODE=1 python3 -m py_compile "$SOURCE_DIR/deploy-v3-contract.py"
visudo -cf "$SOURCE_DIR/kinvest-deploy-v4.sudoers" >/dev/null

for directory in "$LOCAL_SBIN" "$LOCAL_LIBEXEC" "$SERVER_ROOT" "$SERVER_ROOT/state" "$SUDOERS_DIR" "$BACKUP_ROOT"; do
  [[ ! -L "$directory" && ( ! -e "$directory" || -d "$directory" ) ]] || fail "unsafe deploy-v4 target directory: $directory"
done
install -d -o root -g root -m 0755 "$LOCAL_SBIN" "$LOCAL_LIBEXEC" "$SERVER_ROOT" "$SERVER_ROOT/state" "$SUDOERS_DIR"
install -d -o root -g root -m 0700 "$BACKUP_ROOT"

exec 9>"$SERVER_ROOT/state/deploy.lock"
flock -n 9 || fail 'another Kinvest deployment is already running'

BACKUP_PRESENT=('')
BACKUP_HASHES=('')
BACKUP_ATTRIBUTES=('')
backup=''
stage=''
temporary=''
transaction_started='false'
transaction_committed='false'

load_backup() {
  local candidate="$1" line present hash attributes extra line_count index manifest_index
  [[ "$candidate" == "$BACKUP_ROOT"/kinvest-deploy-v4-backup.* && -d "$candidate" && ! -L "$candidate" ]] || return 1
  [[ "$(realpath -e "$candidate")" == "$candidate" ]] || return 1
  [[ -f "$candidate/manifest.txt" && ! -L "$candidate/manifest.txt" ]] || return 1
  line_count="$(wc -l <"$candidate/manifest.txt" | tr -d '[:space:]')"
  [[ "$line_count" == 8 && "$(sed -n '1p' "$candidate/manifest.txt")" == kinvest-deploy-v4-install-backup-v1 ]] || return 1
  for index in "${!TARGETS[@]}"; do
    line="$(sed -n "$((index + 2))p" "$candidate/manifest.txt")"
    IFS='|' read -r manifest_index present hash attributes extra <<<"$line"
    [[ "$manifest_index" == "$index" && -z "$extra" && ( "$present" == true || "$present" == false ) ]] || return 1
    if [[ "$present" == true ]]; then
      [[ "$hash" =~ ^[0-9a-f]{64}$ && "$attributes" =~ ^[0-9]+:[0-9]+:[0-7]{3,4}$ ]] || return 1
      [[ -f "$candidate/$index.asset" && ! -L "$candidate/$index.asset" ]] || return 1
      [[ "$(file_hash "$candidate/$index.asset")" == "$hash" && "$(file_attributes "$candidate/$index.asset")" == "$attributes" ]] || return 1
    else
      [[ -z "$hash" && -z "$attributes" && -f "$candidate/$index.absent" && ! -L "$candidate/$index.absent" ]] || return 1
    fi
    BACKUP_PRESENT[$index]="$present"
    BACKUP_HASHES[$index]="$hash"
    BACKUP_ATTRIBUTES[$index]="$attributes"
  done
  backup="$candidate"
}

rollback_targets() {
  local index target restored owner group mode rollback_failed='false'
  for index in "${!TARGETS[@]}"; do
    target="${TARGETS[$index]}"
    if [[ "${BACKUP_PRESENT[$index]}" == true ]]; then
      restored="$(mktemp "$(dirname "$target")/.kinvest-v4-restore.XXXXXX")" || { rollback_failed='true'; continue; }
      cp -p "$backup/$index.asset" "$restored" || rollback_failed='true'
      IFS=: read -r owner group mode <<<"${BACKUP_ATTRIBUTES[$index]}"
      chown "$owner:$group" "$restored" || rollback_failed='true'
      chmod "$mode" "$restored" || rollback_failed='true'
      if [[ "$(file_hash "$restored")" != "${BACKUP_HASHES[$index]}" || "$(file_attributes "$restored")" != "${BACKUP_ATTRIBUTES[$index]}" ]]; then
        rollback_failed='true'
      elif ! mv -fT "$restored" "$target"; then
        rollback_failed='true'
      fi
      rm -f "$restored"
    elif [[ -e "$target" || -L "$target" ]]; then
      [[ -f "$target" || -L "$target" ]] && rm -f "$target" || rollback_failed='true'
    fi
  done
  for index in "${!TARGETS[@]}"; do
    target="${TARGETS[$index]}"
    if [[ "${BACKUP_PRESENT[$index]}" == true ]]; then
      [[ -f "$target" && ! -L "$target" && "$(file_hash "$target")" == "${BACKUP_HASHES[$index]}" && "$(file_attributes "$target")" == "${BACKUP_ATTRIBUTES[$index]}" ]] || rollback_failed='true'
    else
      [[ ! -e "$target" && ! -L "$target" ]] || rollback_failed='true'
    fi
  done
  [[ "$rollback_failed" == false ]]
}

clear_install_journal() {
  rm -f "$INSTALL_JOURNAL"
  fsync_directory "$SERVER_ROOT/state"
}

if [[ -e "$INSTALL_JOURNAL" || -L "$INSTALL_JOURNAL" ]]; then
  [[ -f "$INSTALL_JOURNAL" && ! -L "$INSTALL_JOURNAL" ]] || fail 'DEPLOY_V4_INSTALL_JOURNAL_INVALID'
  state_owner="$(file_attributes "$SERVER_ROOT/state" | cut -d: -f1-2)"
  [[ "$(file_attributes "$INSTALL_JOURNAL")" == "$state_owner:600" ]] || fail 'DEPLOY_V4_INSTALL_JOURNAL_INVALID'
  [[ "$(wc -l <"$INSTALL_JOURNAL" | tr -d '[:space:]')" == 1 ]] || fail 'DEPLOY_V4_INSTALL_JOURNAL_INVALID'
  journal_line="$(cat "$INSTALL_JOURNAL")"
  [[ "$journal_line" == backup=* ]] || fail 'DEPLOY_V4_INSTALL_JOURNAL_INVALID'
  load_backup "${journal_line#backup=}" || fail 'DEPLOY_V4_INSTALL_JOURNAL_INVALID'
  rollback_targets || fail 'DEPLOY_V4_INSTALL_RECONCILE_FAILED'
  interrupted_backup="$backup"
  clear_install_journal
  rm -rf "$interrupted_backup"
  fsync_directory "$BACKUP_ROOT"
  BACKUP_PRESENT=('')
  BACKUP_HASHES=('')
  BACKUP_ATTRIBUTES=('')
  backup=''
fi

for target in "${TARGETS[@]}"; do
  [[ ! -L "$target" && ( ! -e "$target" || -f "$target" ) ]] || fail "unsafe deploy-v4 target: $target"
done

stage="$(mktemp -d "$RUN_ROOT/kinvest-deploy-v4-stage.XXXXXX")"
backup="$(mktemp -d "$BACKUP_ROOT/kinvest-deploy-v4-backup.XXXXXX")"
chmod 0700 "$stage" "$backup"
for index in "${!TARGETS[@]}"; do
  target="${TARGETS[$index]}"
  if [[ -f "$target" ]]; then
    BACKUP_PRESENT[$index]='true'
    BACKUP_HASHES[$index]="$(file_hash "$target")"
    BACKUP_ATTRIBUTES[$index]="$(file_attributes "$target")"
    cp -p "$target" "$backup/$index.asset"
    [[ "$(file_hash "$backup/$index.asset")" == "${BACKUP_HASHES[$index]}" ]] || fail "deploy-v4 backup hash mismatch: $target"
    [[ "$(file_attributes "$backup/$index.asset")" == "${BACKUP_ATTRIBUTES[$index]}" ]] || fail "deploy-v4 backup attribute mismatch: $target"
  else
    BACKUP_PRESENT[$index]='false'
    : >"$backup/$index.absent"
    chmod 0600 "$backup/$index.absent"
  fi
  install -o root -g root -m "${MODES[$index]}" "$SOURCE_DIR/${SOURCE_ASSETS[$index]}" "$stage/$index"
  [[ "$(file_hash "$stage/$index")" == "${EXPECTED_ASSET_HASHES[$index]}" ]] || fail "staged deploy-v4 hash mismatch: ${SOURCE_ASSETS[$index]}"
done
{
  printf '%s\n' kinvest-deploy-v4-install-backup-v1
  for index in "${!TARGETS[@]}"; do
    printf '%s|%s|%s|%s\n' "$index" "${BACKUP_PRESENT[$index]}" "${BACKUP_HASHES[$index]:-}" "${BACKUP_ATTRIBUTES[$index]:-}"
  done
} >"$backup/manifest.txt"
chmod 0600 "$backup/manifest.txt"

cleanup() {
  local result=$? rollback_ok='true'
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  if [[ "$transaction_started" == true && "$transaction_committed" != true ]]; then
    rollback_targets || rollback_ok='false'
    if [[ "$rollback_ok" == true ]]; then clear_install_journal || rollback_ok='false'; fi
  fi
  rm -f "$temporary"
  rm -rf "$stage"
  if [[ "$rollback_ok" != true ]]; then
    printf 'deploy-v4 rollback failed; recovery backup preserved at %s\n' "$backup" >&2
    result=1
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

journal_temporary="$(mktemp "$SERVER_ROOT/state/.install-v4-journal.XXXXXX")"
printf 'backup=%s\n' "$backup" >"$journal_temporary"
chmod 0600 "$journal_temporary"
mv -f "$journal_temporary" "$INSTALL_JOURNAL"
fsync_directory "$SERVER_ROOT/state"
transaction_started='true'
if [[ -f "${TARGETS[2]}" ]]; then chmod 000 "${TARGETS[2]}"; fi

for index in "${!TARGETS[@]}"; do
  temporary="$(mktemp "$(dirname "${TARGETS[$index]}")/.kinvest-v4-install.XXXXXX")"
  install -o root -g root -m "${MODES[$index]}" "$stage/$index" "$temporary"
  mv -fT "$temporary" "${TARGETS[$index]}"
  temporary=''
done

for index in "${!TARGETS[@]}"; do
  target="${TARGETS[$index]}"
  [[ -f "$target" && ! -L "$target" ]] || fail "installed deploy-v4 target is unsafe: $target"
  [[ "$(file_hash "$target")" == "${EXPECTED_ASSET_HASHES[$index]}" ]] || fail "installed deploy-v4 hash mismatch: $target"
  [[ "$(file_attributes "$target")" == "$(file_attributes "$stage/$index")" ]] || fail "installed deploy-v4 attributes mismatch: $target"
done
bash -n "$LOCAL_SBIN/deploy-kinvest-v4"
bash -n "$LOCAL_SBIN/deploy-kinvest-v3"
bash -n "$LOCAL_SBIN/kinvest-ssh-command"
PYTHONDONTWRITEBYTECODE=1 python3 -m py_compile "$LOCAL_LIBEXEC/kinvest-deploy-v4-contract"
visudo -cf "$SUDOERS_DIR/kinvest-deploy-v4" >/dev/null
sudo -n -U kinvest-deploy -l "$LOCAL_SBIN/deploy-kinvest-v4" >/dev/null
clear_install_journal
transaction_committed='true'

sha256sum "${TARGETS[@]}"
printf 'deploy-v4 installation backup preserved at %s\n' "$backup"
printf '%s\n' 'deploy-v4 assets installed; no configuration was enabled and no container was restarted.'
