#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-}"
LOCAL_SBIN='/usr/local/sbin'
LOCAL_LIBEXEC='/usr/local/libexec'
SERVER_ROOT='/root/docker/kinvest'
SUDOERS_DIR='/etc/sudoers.d'
RUN_ROOT='/run'
BACKUP_ROOT="$SERVER_ROOT/install-backups/deploy-v5"
INSTALL_JOURNAL="$SERVER_ROOT/state/install-v5.journal"
V3_INSTALL_JOURNAL="$SERVER_ROOT/state/install-v3.journal"
GATE_STATE_DIR='/var/lib/kinvest-deploy-gate'
GATE_INSTALL_MARKER="$GATE_STATE_DIR/install-incomplete"
GATE_IDENTITY="$GATE_STATE_DIR/identity"
GATE_ROOT_OWNER='0:0'
GATE_USER="${KINVEST_DEPLOY_GATE_USER:-}"
GATE_GROUP="${KINVEST_DEPLOY_GATE_GROUP:-}"
GATE_GROUP_GID=''
GATE_IDENTITY_CONTENT=''
GATE_SOURCE="$SOURCE_DIR/kinvest-ssh-command-v3"
GATE_TARGET="$LOCAL_SBIN/kinvest-ssh-command"
GATE_EXPECTED_HASH='ea3c6bf2d5f0b7822ca1dc5f331c6c0987c170d9ef90ca08793422af6f4d3815'
MANIFEST_EXPECTED_HASH='442e9e286fb400ed432569fb707a0101aebbbbfc92a07fcf8089b6ed3f06320c'
SOURCE_ASSETS=('deploy-kinvest-v5' 'deploy-v5-runtime.py' 'deploy-v5-contract.py' 'docker-compose-v5.yml' 'kinvest-deploy-v5.sudoers.in' 'deploy-v5-assets.sha256' 'deploy-kinvest-v3.sh' 'deploy-v3-contract.py' 'docker-compose-v3.yml' 'offline-image-attestation.py')
TARGETS=("$LOCAL_SBIN/deploy-kinvest-v5" "$LOCAL_LIBEXEC/kinvest-deploy-v5-runtime" "$LOCAL_LIBEXEC/kinvest-deploy-v5-contract" "$SERVER_ROOT/docker-compose-v5.yml" "$SUDOERS_DIR/kinvest-deploy-v5" "$SERVER_ROOT/deploy-v5-assets.sha256" "$LOCAL_SBIN/deploy-kinvest-v3" "$LOCAL_LIBEXEC/kinvest-deploy-v3-contract" "$SERVER_ROOT/docker-compose-v3.yml" "$LOCAL_LIBEXEC/kinvest-offline-image-attestation")
TARGET_KEYS=('deploy-kinvest-v5' 'kinvest-deploy-v5-runtime' 'kinvest-deploy-v5-contract' 'docker-compose-v5.yml' 'kinvest-deploy-v5.sudoers' 'deploy-v5-assets.sha256' 'deploy-kinvest-v3' 'kinvest-deploy-v3-contract' 'docker-compose-v3.yml' 'kinvest-offline-image-attestation')
MODES=('0755' '0755' '0755' '0644' '0440' '0600' '0755' '0755' '0644' '0755')
EXPECTED_ASSET_HASHES=(
  '01cb61e16ae8c0e041cd1d6be02ec82eeabdb4c103a331cba45f5e42ed712c00'
  '2664c8f7a52f7decbc3a2758013e1e0c51ed1d2833ca0490d664a8bc6ad2e05d'
  'ccec93bcce7a8e7bf5871f7269446a93b88caf6a971360d7e8269c43161468bd'
  '1e9a52d1025350fc21539d21fbfbdc9b51f818f1896ec26bc3ba572188eca2df'
  'e7185be9b5236736b1e7c0f6f499320d0aac3083dea0b4a4b11a0597f15fdc3b'
  '442e9e286fb400ed432569fb707a0101aebbbbfc92a07fcf8089b6ed3f06320c'
  '3bb3abdfee9b33cd9bd703730c3eb4fc7c1a25d3b6dc3e1ae00e2a775dd36bb1'
  '68040b9177cc8d2bb929a351e289eee7e9c6e446fda447ceec12d9ad382afe23'
  '7698dd619fb6a441763f85e4e35c819af55e431c6d0ac9c4b527930d07a644aa'
  '424e9fa9b013727ef75c489cfa25cf5144efbabb34d2bbb630115efe86de7bc1'
)

fail() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }
file_hash() { sha256sum "$1" | awk '{print $1}'; }
file_attributes() {
  python3 -c 'import os,stat,sys; v=os.stat(sys.argv[1],follow_symlinks=False); print(f"{v.st_uid}:{v.st_gid}:{stat.S_IMODE(v.st_mode):o}")' "$1"
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

validate_reentry_gate_temp() {
  local candidate="$1" basename identity
  [[ "$(dirname "$candidate")" == "$GATE_STATE_DIR" ]] || return 1
  basename="$(basename "$candidate")"
  [[ "$basename" =~ ^\.(install-incomplete|identity)\.[A-Za-z0-9]{6}$ ]] || return 1
  [[ -f "$candidate" && ! -L "$candidate" ]] || return 1
  identity="$(gate_inode_identity "$candidate")" || return 1
  [[ "$identity" =~ ^[0-9]+:[0-9]+:${GATE_ROOT_OWNER%%:*}:1:1$ ]]
}

validate_tracked_gate_temp() {
  local candidate="$1" expected_identity="$2"
  validate_reentry_gate_temp "$candidate" || return 1
  [[ "$(gate_inode_identity "$candidate")" == "$expected_identity" ]]
}

cleanup_tracked_gate_temporaries() {
  local removed='false'
  if [[ -n "${gate_marker_temporary:-}" ]]; then
    validate_tracked_gate_temp "$gate_marker_temporary" "$gate_marker_temporary_identity" || return 1
    rm -f "$gate_marker_temporary" || return 1
    gate_marker_temporary=''
    gate_marker_temporary_identity=''
    removed='true'
  fi
  if [[ -n "${gate_identity_temporary:-}" ]]; then
    validate_tracked_gate_temp "$gate_identity_temporary" "$gate_identity_temporary_identity" || return 1
    rm -f "$gate_identity_temporary" || return 1
    gate_identity_temporary=''
    gate_identity_temporary_identity=''
    removed='true'
  fi
  [[ "$removed" == false ]] || fsync_directory "$GATE_STATE_DIR"
}

reconcile_gate_temporaries() {
  local candidate removed='false'
  shopt -s nullglob
  for candidate in "$GATE_STATE_DIR"/.install-incomplete.* "$GATE_STATE_DIR"/.identity.*; do
    validate_reentry_gate_temp "$candidate" || { shopt -u nullglob; return 1; }
    rm -f "$candidate" || { shopt -u nullglob; return 1; }
    removed='true'
  done
  shopt -u nullglob
  [[ "$removed" == false ]] || fsync_directory "$GATE_STATE_DIR"
}

resolve_gate_identity() {
  local user_record group_record name password uid primary_gid gecos home shell extra gid members deploy_groups
  [[ -n "$GATE_USER" && -n "$GATE_GROUP" ]] || fail 'DEPLOY_V5_GATE_IDENTITY_REQUIRED'
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

validate_gate_marker() {
  [[ -f "$GATE_INSTALL_MARKER" && ! -L "$GATE_INSTALL_MARKER" ]] || return 1
  [[ "$(file_attributes "$GATE_INSTALL_MARKER")" == "${GATE_ROOT_OWNER%%:*}:$GATE_GROUP_GID:640" ]] || return 1
  [[ "$(wc -c <"$GATE_INSTALL_MARKER" | tr -d '[:space:]')" == 7 ]] || return 1
  [[ "$(cat "$GATE_INSTALL_MARKER")" == ACTIVE ]]
}

prepare_gate_state() {
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
    [[ "$(cat "$GATE_IDENTITY")" == "$GATE_IDENTITY_CONTENT" ]] || fail 'DEPLOY_V5_GATE_IDENTITY_MISMATCH'
  else
    gate_identity_temporary="$(mktemp "$GATE_STATE_DIR/.identity.XXXXXX")" || return 1
    gate_identity_temporary_identity="$(gate_inode_identity "$gate_identity_temporary")" || return 1
    # gate-identity-temp-created
    printf '%s\n' "$GATE_IDENTITY_CONTENT" >"$gate_identity_temporary" || return 1
    # gate-identity-temp-written
    chown root:"$GATE_GROUP" "$gate_identity_temporary" || return 1
    # gate-identity-temp-owned
    chmod 0640 "$gate_identity_temporary" || return 1
    # gate-identity-temp-mode
    fsync_file "$gate_identity_temporary" || return 1
    # gate-identity-temp-durable
    mv -fT "$gate_identity_temporary" "$GATE_IDENTITY" || return 1
    # gate-identity-temp-renamed
    gate_identity_temporary=''
    gate_identity_temporary_identity=''
    fsync_directory "$GATE_STATE_DIR" || return 1
  fi
  if [[ -e "$GATE_INSTALL_MARKER" || -L "$GATE_INSTALL_MARKER" ]]; then
    validate_gate_marker || return 1
  fi
}

publish_public_marker() {
  gate_marker_temporary="$(mktemp "$GATE_STATE_DIR/.install-incomplete.XXXXXX")"
  gate_marker_temporary_identity="$(gate_inode_identity "$gate_marker_temporary")"
  # gate-marker-temp-created
  printf '%s\n' ACTIVE >"$gate_marker_temporary"
  chown root:"$GATE_GROUP" "$gate_marker_temporary"
  chmod 0640 "$gate_marker_temporary"
  fsync_file "$gate_marker_temporary"
  mv -fT "$gate_marker_temporary" "$GATE_INSTALL_MARKER"
  gate_marker_temporary=''
  fsync_directory "$GATE_STATE_DIR"
  validate_gate_marker
}

clear_public_marker() {
  if [[ -e "$GATE_INSTALL_MARKER" || -L "$GATE_INSTALL_MARKER" ]]; then
    validate_gate_marker || return 1
    rm -f "$GATE_INSTALL_MARKER" || return 1
    fsync_directory "$GATE_STATE_DIR" || return 1
  fi
}

[[ "$#" -eq 1 && "$SOURCE_DIR" == /* && -d "$SOURCE_DIR" && ! -L "$SOURCE_DIR" ]] || fail 'usage: install-deploy-v5.sh /absolute/canonical/source/dir' 2
[[ "$(id -u)" -eq 0 ]] || fail 'deploy-v5 installation must run as root'
[[ "$(realpath -e "$SOURCE_DIR")" == "$SOURCE_DIR" ]] || fail 'deploy-v5 source directory must be canonical'
resolve_gate_identity || fail 'DEPLOY_V5_GATE_IDENTITY_INVALID'

for index in "${!SOURCE_ASSETS[@]}"; do
  source="$SOURCE_DIR/${SOURCE_ASSETS[$index]}"
  [[ -f "$source" && ! -L "$source" ]] || fail "invalid deploy-v5 source file: ${SOURCE_ASSETS[$index]}"
  [[ "$(file_hash "$source")" == "${EXPECTED_ASSET_HASHES[$index]}" ]] || fail "untrusted deploy-v5 source hash: ${SOURCE_ASSETS[$index]}"
done
[[ "$(file_hash "$SOURCE_DIR/deploy-v5-assets.sha256")" == "$MANIFEST_EXPECTED_HASH" ]] || fail 'untrusted deploy-v5 asset manifest'
(cd "$SOURCE_DIR" && sha256sum -c deploy-v5-assets.sha256 >/dev/null) || fail 'deploy-v5 asset manifest mismatch'
bash -n "$SOURCE_DIR/deploy-kinvest-v5"
bash -n "$SOURCE_DIR/deploy-kinvest-v3.sh"
bash -n "$SOURCE_DIR/kinvest-ssh-command-v3"
PYTHONDONTWRITEBYTECODE=1 python3 -m py_compile "$SOURCE_DIR/deploy-v5-runtime.py" "$SOURCE_DIR/deploy-v5-contract.py" "$SOURCE_DIR/deploy-v3-contract.py" "$SOURCE_DIR/offline-image-attestation.py"
[[ -f "$GATE_SOURCE" && ! -L "$GATE_SOURCE" ]] || fail 'invalid deploy-v5 forced-command gate'
[[ "$(file_hash "$GATE_SOURCE")" == "$GATE_EXPECTED_HASH" ]] || fail 'untrusted deploy-v5 forced-command gate hash'

for directory in "$LOCAL_SBIN" "$LOCAL_LIBEXEC" "$SERVER_ROOT" "$SERVER_ROOT/state" "$SUDOERS_DIR" "$BACKUP_ROOT"; do
  [[ ! -L "$directory" && ( ! -e "$directory" || -d "$directory" ) ]] || fail "unsafe deploy-v5 target directory: $directory"
done
install -d -o root -g root -m 0755 "$LOCAL_SBIN" "$LOCAL_LIBEXEC" "$SERVER_ROOT" "$SERVER_ROOT/state" "$SUDOERS_DIR"
install -d -o root -g root -m 0700 "$BACKUP_ROOT"

gate_marker_temporary=''
gate_marker_temporary_identity=''
gate_identity_temporary=''
gate_identity_temporary_identity=''
early_cleanup() {
  local result=$?
  trap - EXIT
  cleanup_tracked_gate_temporaries || result=1
  exit "$result"
}
trap early_cleanup EXIT
prepare_gate_state || fail 'DEPLOY_V5_GATE_STATE_INVALID'
exec 8<"$GATE_STATE_DIR"
flock -n 8 || fail 'another Kinvest installer is already running'
exec 9>"$SERVER_ROOT/state/deploy.lock"
flock -n 9 || fail 'another Kinvest deployment is already running'
[[ "$(file_attributes "$GATE_STATE_DIR")" == "${GATE_ROOT_OWNER%%:*}:$GATE_GROUP_GID:750" ]] || fail 'DEPLOY_V5_GATE_IDENTITY_MISMATCH'
reconcile_gate_temporaries || fail 'DEPLOY_V5_GATE_TEMP_INVALID'
validate_or_publish_gate_identity || fail 'DEPLOY_V5_GATE_IDENTITY_INVALID'
if [[ -e "$V3_INSTALL_JOURNAL" || -L "$V3_INSTALL_JOURNAL" ]]; then
  fail 'DEPLOY_INSTALL_INCOMPLETE' 76
fi

BACKUP_PRESENT=('')
BACKUP_HASHES=('')
BACKUP_ATTRIBUTES=('')
BACKUP_FILES=('')
backup=''
stage=''
temporary=''
transaction_started='false'
transaction_committed='false'
public_marker_published='false'

load_backup() {
  local candidate="$1" line present hash attributes extra line_count index manifest_key header record_count matched file_key
  [[ "$candidate" == "$BACKUP_ROOT"/kinvest-deploy-v5-backup.* && -d "$candidate" && ! -L "$candidate" ]] || return 1
  [[ "$(realpath -e "$candidate")" == "$candidate" ]] || return 1
  [[ -f "$candidate/manifest.txt" && ! -L "$candidate/manifest.txt" ]] || return 1
  line_count="$(wc -l <"$candidate/manifest.txt" | tr -d '[:space:]')"
  header="$(sed -n '1p' "$candidate/manifest.txt")"
  BACKUP_PRESENT=('')
  BACKUP_HASHES=('')
  BACKUP_ATTRIBUTES=('')
  BACKUP_FILES=('')
  for index in "${!TARGETS[@]}"; do BACKUP_PRESENT[$index]='untouched'; done
  record_count="$((line_count - 1))"
  [[ "$record_count" -ge 0 ]] || return 1
  for (( manifest_line = 2; manifest_line <= line_count; manifest_line++ )); do
    line="$(sed -n "${manifest_line}p" "$candidate/manifest.txt")"
    IFS='|' read -r manifest_key present hash attributes extra <<<"$line"
    [[ -z "$extra" && ( "$present" == true || "$present" == false ) ]] || return 1
    if [[ "$header" == kinvest-deploy-v5-install-backup-v1 ]]; then
      [[ ( "$record_count" -eq 9 || "$record_count" -eq 10 ) && "$manifest_key" =~ ^[0-9]+$ ]] || return 1
      index="$manifest_key"
      [[ "$index" -lt "${#TARGETS[@]}" && "$index" -eq "$((manifest_line - 2))" ]] || return 1
      file_key="$index"
    elif [[ "$header" == kinvest-deploy-v5-install-backup-v2 ]]; then
      [[ "$record_count" -ge 10 && "$record_count" -le "${#TARGETS[@]}" && "$manifest_key" =~ ^[a-zA-Z0-9._-]+$ ]] || return 1
      matched='false'
      for index in "${!TARGET_KEYS[@]}"; do
        if [[ "${TARGET_KEYS[$index]}" == "$manifest_key" ]]; then matched='true'; break; fi
      done
      [[ "$matched" == true && "${BACKUP_PRESENT[$index]}" == untouched ]] || return 1
      file_key="$manifest_key"
    else
      return 1
    fi
    if [[ "$present" == true ]]; then
      [[ "$hash" =~ ^[0-9a-f]{64}$ && "$attributes" =~ ^[0-9]+:[0-9]+:[0-7]{3,4}$ ]] || return 1
      [[ -f "$candidate/$file_key.asset" && ! -L "$candidate/$file_key.asset" ]] || return 1
      [[ "$(file_hash "$candidate/$file_key.asset")" == "$hash" && "$(file_attributes "$candidate/$file_key.asset")" == "$attributes" ]] || return 1
    else
      [[ -z "$hash" && -z "$attributes" && -f "$candidate/$file_key.absent" && ! -L "$candidate/$file_key.absent" ]] || return 1
    fi
    BACKUP_PRESENT[$index]="$present"
    BACKUP_HASHES[$index]="$hash"
    BACKUP_ATTRIBUTES[$index]="$attributes"
    BACKUP_FILES[$index]="$file_key"
  done
  backup="$candidate"
}

rollback_targets() {
  local index target restored owner group mode rollback_failed='false'
  for index in "${!TARGETS[@]}"; do
    target="${TARGETS[$index]}"
    if [[ "${BACKUP_PRESENT[$index]}" == true ]]; then
      restored="$(mktemp "$(dirname "$target")/.kinvest-v5-restore.XXXXXX")" || { rollback_failed='true'; continue; }
      cp -p "$backup/${BACKUP_FILES[$index]}.asset" "$restored" || rollback_failed='true'
      IFS=: read -r owner group mode <<<"${BACKUP_ATTRIBUTES[$index]}"
      chown "$owner:$group" "$restored" || rollback_failed='true'
      chmod "$mode" "$restored" || rollback_failed='true'
      if [[ "$(file_hash "$restored")" != "${BACKUP_HASHES[$index]}" || "$(file_attributes "$restored")" != "${BACKUP_ATTRIBUTES[$index]}" ]]; then
        rollback_failed='true'
      elif ! fsync_file "$restored"; then
        rollback_failed='true'
      elif ! mv -fT "$restored" "$target"; then
        rollback_failed='true'
      elif ! fsync_directory "$(dirname "$target")"; then
        rollback_failed='true'
      fi
      rm -f "$restored"
    elif [[ "${BACKUP_PRESENT[$index]}" == false && ( -e "$target" || -L "$target" ) ]]; then
      if [[ -f "$target" || -L "$target" ]]; then
        rm -f "$target" && fsync_directory "$(dirname "$target")" || rollback_failed='true'
      else
        rollback_failed='true'
      fi
    fi
  done
  fsync_target_directories || rollback_failed='true'
  for index in "${!TARGETS[@]}"; do
    target="${TARGETS[$index]}"
    if [[ "${BACKUP_PRESENT[$index]}" == true ]]; then
      [[ -f "$target" && ! -L "$target" && "$(file_hash "$target")" == "${BACKUP_HASHES[$index]}" && "$(file_attributes "$target")" == "${BACKUP_ATTRIBUTES[$index]}" ]] || rollback_failed='true'
    elif [[ "${BACKUP_PRESENT[$index]}" == false ]]; then
      [[ ! -e "$target" && ! -L "$target" ]] || rollback_failed='true'
    fi
  done
  [[ "$rollback_failed" == false ]]
}

fsync_target_directories() {
  local directory
  for directory in "$LOCAL_SBIN" "$LOCAL_LIBEXEC" "$SERVER_ROOT" "$SUDOERS_DIR"; do
    fsync_directory "$directory"
  done
}

install_forced_command_gate() {
  local gate_temporary
  gate_temporary="$(mktemp "$LOCAL_SBIN/.kinvest-command-gate.XXXXXX")"
  install -o root -g root -m 0755 "$GATE_SOURCE" "$gate_temporary"
  [[ "$(file_hash "$gate_temporary")" == "$GATE_EXPECTED_HASH" ]] || return 1
  fsync_file "$gate_temporary"
  mv -fT "$gate_temporary" "$GATE_TARGET"
  fsync_directory "$LOCAL_SBIN"
  [[ -f "$GATE_TARGET" && ! -L "$GATE_TARGET" && "$(file_hash "$GATE_TARGET")" == "$GATE_EXPECTED_HASH" ]] || return 1
}

clear_install_journal() {
  rm -f "$INSTALL_JOURNAL"
  fsync_directory "$SERVER_ROOT/state"
  clear_public_marker
  public_marker_published='false'
}

if [[ -e "$INSTALL_JOURNAL" || -L "$INSTALL_JOURNAL" ]]; then
  [[ -f "$INSTALL_JOURNAL" && ! -L "$INSTALL_JOURNAL" ]] || fail 'DEPLOY_V5_INSTALL_JOURNAL_INVALID'
  state_owner="$(file_attributes "$SERVER_ROOT/state" | cut -d: -f1-2)"
  [[ "$(file_attributes "$INSTALL_JOURNAL")" == "$state_owner:600" ]] || fail 'DEPLOY_V5_INSTALL_JOURNAL_INVALID'
  [[ "$(wc -l <"$INSTALL_JOURNAL" | tr -d '[:space:]')" == 1 ]] || fail 'DEPLOY_V5_INSTALL_JOURNAL_INVALID'
  journal_line="$(cat "$INSTALL_JOURNAL")"
  [[ "$journal_line" == backup=* ]] || fail 'DEPLOY_V5_INSTALL_JOURNAL_INVALID'
  load_backup "${journal_line#backup=}" || fail 'DEPLOY_V5_INSTALL_JOURNAL_INVALID'
  rollback_targets || fail 'DEPLOY_V5_INSTALL_RECONCILE_FAILED'
  interrupted_backup="$backup"
  clear_install_journal
  rm -rf "$interrupted_backup"
  fsync_directory "$BACKUP_ROOT"
  BACKUP_PRESENT=('')
  BACKUP_HASHES=('')
  BACKUP_ATTRIBUTES=('')
  BACKUP_FILES=('')
  backup=''
elif [[ -e "$GATE_INSTALL_MARKER" || -L "$GATE_INSTALL_MARKER" ]]; then
  validate_gate_marker || fail 'DEPLOY_V5_GATE_STATE_INVALID'
  clear_public_marker || fail 'DEPLOY_V5_INSTALL_RECONCILE_FAILED'
fi

install_forced_command_gate # stable-gate-commit

for target in "${TARGETS[@]}"; do
  [[ ! -L "$target" && ( ! -e "$target" || -f "$target" ) ]] || fail "unsafe deploy-v5 target: $target"
done

stage="$(mktemp -d "$RUN_ROOT/kinvest-deploy-v5-stage.XXXXXX")"
backup="$(mktemp -d "$BACKUP_ROOT/kinvest-deploy-v5-backup.XXXXXX")"
chmod 0700 "$stage" "$backup"
for index in "${!TARGETS[@]}"; do
  target="${TARGETS[$index]}"
  BACKUP_FILES[$index]="${TARGET_KEYS[$index]}"
  if [[ -f "$target" ]]; then
    BACKUP_PRESENT[$index]='true'
    BACKUP_HASHES[$index]="$(file_hash "$target")"
    BACKUP_ATTRIBUTES[$index]="$(file_attributes "$target")"
    cp -p "$target" "$backup/${BACKUP_FILES[$index]}.asset"
    [[ "$(file_hash "$backup/${BACKUP_FILES[$index]}.asset")" == "${BACKUP_HASHES[$index]}" ]] || fail "deploy-v5 backup hash mismatch: $target"
    [[ "$(file_attributes "$backup/${BACKUP_FILES[$index]}.asset")" == "${BACKUP_ATTRIBUTES[$index]}" ]] || fail "deploy-v5 backup attribute mismatch: $target"
  else
    BACKUP_PRESENT[$index]='false'
    : >"$backup/${BACKUP_FILES[$index]}.absent"
    chmod 0600 "$backup/${BACKUP_FILES[$index]}.absent"
  fi
  if [[ "$index" == 4 ]]; then
    sed "s/@KINVEST_DEPLOY_GATE_USER@/$GATE_USER/g" "$SOURCE_DIR/${SOURCE_ASSETS[$index]}" >"$stage/$index"
    chown root:root "$stage/$index"
    chmod "${MODES[$index]}" "$stage/$index"
    visudo -cf "$stage/$index" >/dev/null
  else
    install -o root -g root -m "${MODES[$index]}" "$SOURCE_DIR/${SOURCE_ASSETS[$index]}" "$stage/$index"
    [[ "$(file_hash "$stage/$index")" == "${EXPECTED_ASSET_HASHES[$index]}" ]] || fail "staged deploy-v5 hash mismatch: ${SOURCE_ASSETS[$index]}"
  fi
done
{
  printf '%s\n' kinvest-deploy-v5-install-backup-v2
  for index in "${!TARGETS[@]}"; do
    printf '%s|%s|%s|%s\n' "${TARGET_KEYS[$index]}" "${BACKUP_PRESENT[$index]}" "${BACKUP_HASHES[$index]:-}" "${BACKUP_ATTRIBUTES[$index]:-}"
  done
} >"$backup/manifest.txt"
chmod 0600 "$backup/manifest.txt"
for backup_item in "$backup"/*.asset "$backup"/*.absent "$backup/manifest.txt"; do
  [[ -e "$backup_item" ]] && fsync_file "$backup_item"
done
fsync_directory "$backup"
fsync_directory "$BACKUP_ROOT"

cleanup() {
  local result=$? rollback_ok='true'
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  if [[ "$transaction_started" == true && "$transaction_committed" != true ]]; then
    rollback_targets || rollback_ok='false'
    if [[ "$rollback_ok" == true ]]; then clear_install_journal || rollback_ok='false'; fi
  elif [[ "$public_marker_published" == true && ! -e "$INSTALL_JOURNAL" && ! -L "$INSTALL_JOURNAL" ]]; then
    clear_public_marker || rollback_ok='false'
  fi
  rm -f "$temporary"
  rm -rf "$stage"
  cleanup_tracked_gate_temporaries || rollback_ok='false'
  if [[ "$rollback_ok" != true ]]; then
    printf 'deploy-v5 rollback failed; recovery backup preserved at %s\n' "$backup" >&2
    result=1
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

publish_install_journal() {
  local journal_temporary
  publish_public_marker
  public_marker_published='true'
  journal_temporary="$(mktemp "$SERVER_ROOT/state/.install-v5-journal.XXXXXX")"
  printf 'backup=%s\n' "$backup" >"$journal_temporary"
  chmod 0600 "$journal_temporary"
  fsync_file "$journal_temporary"
  mv -f "$journal_temporary" "$INSTALL_JOURNAL"
  fsync_directory "$SERVER_ROOT/state"
}
publish_install_journal # install-journal-commit
transaction_started='true'

for index in "${!TARGETS[@]}"; do
  temporary="$(mktemp "$(dirname "${TARGETS[$index]}")/.kinvest-v5-install.XXXXXX")"
  install -o root -g root -m "${MODES[$index]}" "$stage/$index" "$temporary"
  fsync_file "$temporary"
  mv -fT "$temporary" "${TARGETS[$index]}"
  fsync_directory "$(dirname "${TARGETS[$index]}")"
  temporary=''
done
fsync_target_directories

for index in "${!TARGETS[@]}"; do
  target="${TARGETS[$index]}"
  [[ -f "$target" && ! -L "$target" ]] || fail "installed deploy-v5 target is unsafe: $target"
  [[ "$(file_hash "$target")" == "$(file_hash "$stage/$index")" ]] || fail "installed deploy-v5 hash mismatch: $target"
  [[ "$(file_attributes "$target")" == "$(file_attributes "$stage/$index")" ]] || fail "installed deploy-v5 attributes mismatch: $target"
done
bash -n "$LOCAL_SBIN/deploy-kinvest-v5"
bash -n "$LOCAL_SBIN/deploy-kinvest-v3"
bash -n "$GATE_TARGET"
PYTHONDONTWRITEBYTECODE=1 python3 -m py_compile "$LOCAL_LIBEXEC/kinvest-deploy-v5-runtime" "$LOCAL_LIBEXEC/kinvest-deploy-v5-contract" "$LOCAL_LIBEXEC/kinvest-deploy-v3-contract" "$LOCAL_LIBEXEC/kinvest-offline-image-attestation"
visudo -cf "$SUDOERS_DIR/kinvest-deploy-v5" >/dev/null
sudo -n -U "$GATE_USER" -l "$LOCAL_SBIN/deploy-kinvest" >/dev/null
sudo -n -U "$GATE_USER" -l "$LOCAL_SBIN/deploy-kinvest-v3" >/dev/null
sudo -n -U "$GATE_USER" -l "$LOCAL_SBIN/deploy-kinvest-v4" >/dev/null
sudo -n -U "$GATE_USER" -l "$LOCAL_SBIN/deploy-kinvest-v5" >/dev/null
clear_install_journal
transaction_committed='true'

sha256sum "$GATE_TARGET" "${TARGETS[@]}"
printf 'deploy-v5 installation backup preserved at %s\n' "$backup"
printf '%s\n' 'deploy-v5 assets installed; no configuration was enabled and no container was restarted.'
