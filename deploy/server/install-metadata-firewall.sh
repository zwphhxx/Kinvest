#!/bin/sh
set -eu
set -f
umask 077

TARGET_ROOT=''
SECURITY_ROOT='/'
TRUSTED_UID='0'
TRUSTED_GID='0'
REQUIRED_UID='0'
SECURE_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
INSTALL_OWNER='root'
INSTALL_GROUP='root'
LOCK_ROOT='/run/lock'
RUNTIME_SYSCTL_PATH='/proc/sys/net/bridge/bridge-nf-call-iptables'
RUNTIME_MODULE_PATH='/sys/module/br_netfilter'
RUNTIME_FD_ROOT='/proc/self/fd'
RUNTIME_FD_IDENTITY_MODE='device-inode'
BACKUP_ROOT="$TARGET_ROOT/var/backups/kinvest-metadata-firewall"
LOCK_FILE="$LOCK_ROOT/kinvest-metadata-firewall-install.lock"
MANIFEST_RELATIVE='deploy/server/metadata-firewall-assets.sha256'
ASSET_IDS='library wrapper service timer drop-in modules-load sysctl'
INSTALL_IDS='drop-in library wrapper service timer modules-load sysctl'
ROLLBACK_IDS='sysctl modules-load timer service wrapper library drop-in'
EXPECTED_ASSET_PATHS='deploy/server/kinvest-metadata-firewall-lib.sh deploy/server/kinvest-metadata-firewall.sh deploy/server/kinvest-metadata-firewall.service deploy/server/kinvest-metadata-firewall.timer deploy/server/docker-kinvest-metadata-firewall.conf deploy/server/kinvest-br-netfilter.modules-load.conf deploy/server/kinvest-br-netfilter.sysctl.conf'

PATH=$SECURE_PATH
export PATH

FAILURE_CODE='UNEXPECTED_FAILURE'
RECOVERY_CODE='RECOVERY_FAILED'
backup_dir='none'
preparing_dir=''
state_record=''
parents_record=''
transaction_started='0'
transaction_committed='0'
stage_library=''
stage_wrapper=''
stage_service=''
stage_timer=''
stage_drop_in=''
stage_modules_load=''
stage_sysctl=''
expected_hash_library=''
expected_hash_wrapper=''
expected_hash_service=''
expected_hash_timer=''
expected_hash_drop_in=''
expected_hash_modules_load=''
expected_hash_sysctl=''

fail() {
  FAILURE_CODE=$1
  exit 1
}

asset_source() {
  case "$1" in
    library) printf '%s\n' 'deploy/server/kinvest-metadata-firewall-lib.sh' ;;
    wrapper) printf '%s\n' 'deploy/server/kinvest-metadata-firewall.sh' ;;
    service) printf '%s\n' 'deploy/server/kinvest-metadata-firewall.service' ;;
    timer) printf '%s\n' 'deploy/server/kinvest-metadata-firewall.timer' ;;
    drop-in) printf '%s\n' 'deploy/server/docker-kinvest-metadata-firewall.conf' ;;
    modules-load) printf '%s\n' 'deploy/server/kinvest-br-netfilter.modules-load.conf' ;;
    sysctl) printf '%s\n' 'deploy/server/kinvest-br-netfilter.sysctl.conf' ;;
    *) return 1 ;;
  esac
}

asset_target() {
  case "$1" in
    library) printf '%s\n' "$TARGET_ROOT/usr/local/libexec/kinvest-metadata-firewall-lib.sh" ;;
    wrapper) printf '%s\n' "$TARGET_ROOT/usr/local/sbin/kinvest-metadata-firewall" ;;
    service) printf '%s\n' "$TARGET_ROOT/etc/systemd/system/kinvest-metadata-firewall.service" ;;
    timer) printf '%s\n' "$TARGET_ROOT/etc/systemd/system/kinvest-metadata-firewall.timer" ;;
    drop-in) printf '%s\n' "$TARGET_ROOT/etc/systemd/system/docker.service.d/kinvest-metadata-firewall.conf" ;;
    modules-load) printf '%s\n' "$TARGET_ROOT/etc/modules-load.d/kinvest-br-netfilter.conf" ;;
    sysctl) printf '%s\n' "$TARGET_ROOT/etc/sysctl.d/90-kinvest-br-netfilter.conf" ;;
    *) return 1 ;;
  esac
}

asset_mode() {
  case "$1" in
    library|wrapper) printf '%s\n' '0755' ;;
    service|timer|drop-in|modules-load|sysctl) printf '%s\n' '0644' ;;
    *) return 1 ;;
  esac
}

asset_is_shell() {
  case "$1" in library|wrapper) return 0 ;; *) return 1 ;; esac
}

set_expected_hash() {
  case "$1" in
    library) expected_hash_library=$2 ;;
    wrapper) expected_hash_wrapper=$2 ;;
    service) expected_hash_service=$2 ;;
    timer) expected_hash_timer=$2 ;;
    drop-in) expected_hash_drop_in=$2 ;;
    modules-load) expected_hash_modules_load=$2 ;;
    sysctl) expected_hash_sysctl=$2 ;;
    *) return 1 ;;
  esac
}

expected_hash() {
  case "$1" in
    library) printf '%s\n' "$expected_hash_library" ;;
    wrapper) printf '%s\n' "$expected_hash_wrapper" ;;
    service) printf '%s\n' "$expected_hash_service" ;;
    timer) printf '%s\n' "$expected_hash_timer" ;;
    drop-in) printf '%s\n' "$expected_hash_drop_in" ;;
    modules-load) printf '%s\n' "$expected_hash_modules_load" ;;
    sysctl) printf '%s\n' "$expected_hash_sysctl" ;;
    *) return 1 ;;
  esac
}

id_for_source_path() {
  case "$1" in
    deploy/server/kinvest-metadata-firewall-lib.sh) printf '%s\n' library ;;
    deploy/server/kinvest-metadata-firewall.sh) printf '%s\n' wrapper ;;
    deploy/server/kinvest-metadata-firewall.service) printf '%s\n' service ;;
    deploy/server/kinvest-metadata-firewall.timer) printf '%s\n' timer ;;
    deploy/server/docker-kinvest-metadata-firewall.conf) printf '%s\n' drop-in ;;
    deploy/server/kinvest-br-netfilter.modules-load.conf) printf '%s\n' modules-load ;;
    deploy/server/kinvest-br-netfilter.sysctl.conf) printf '%s\n' sysctl ;;
    *) return 1 ;;
  esac
}

set_stage_path() {
  case "$1" in
    library) stage_library=$2 ;;
    wrapper) stage_wrapper=$2 ;;
    service) stage_service=$2 ;;
    timer) stage_timer=$2 ;;
    drop-in) stage_drop_in=$2 ;;
    modules-load) stage_modules_load=$2 ;;
    sysctl) stage_sysctl=$2 ;;
    *) return 1 ;;
  esac
}

stage_path() {
  case "$1" in
    library) printf '%s\n' "$stage_library" ;;
    wrapper) printf '%s\n' "$stage_wrapper" ;;
    service) printf '%s\n' "$stage_service" ;;
    timer) printf '%s\n' "$stage_timer" ;;
    drop-in) printf '%s\n' "$stage_drop_in" ;;
    modules-load) printf '%s\n' "$stage_modules_load" ;;
    sysctl) printf '%s\n' "$stage_sysctl" ;;
    *) return 1 ;;
  esac
}

file_hash() {
  sha256sum "$1" | awk '{print $1}'
}

stat_value() {
  linux_format=$1
  bsd_format=$2
  path_value=$3
  if stat -c "$linux_format" "$path_value" >/dev/null 2>&1; then
    stat -c "$linux_format" "$path_value"
  else
    stat -f "$bsd_format" "$path_value"
  fi
}

file_mode() { stat_value '%a' '%Lp' "$1"; }
file_uid() { stat_value '%u' '%u' "$1"; }
file_gid() { stat_value '%g' '%g' "$1"; }
file_links() { stat_value '%h' '%l' "$1"; }
file_identity() { stat_value '%d:%i' '%d:%i' "$1"; }
file_inode() { stat_value '%i' '%i' "$1"; }

mode_is_not_writable_by_group_or_other() {
  mode_value=$1
  other_digit=${mode_value#"${mode_value%?}"}
  without_other=${mode_value%?}
  group_digit=${without_other#"${without_other%?}"}
  case "$group_digit$other_digit" in
    *2*|*3*|*6*|*7*) return 1 ;;
    *) return 0 ;;
  esac
}

secure_directory() {
  path_value=$1
  [ -d "$path_value" ] && [ ! -L "$path_value" ] || return 1
  [ "$(file_uid "$path_value")" = "$TRUSTED_UID" ] || return 1
  [ "$(file_gid "$path_value")" = "$TRUSTED_GID" ] || return 1
  mode_is_not_writable_by_group_or_other "$(file_mode "$path_value")"
}

secure_regular_file() {
  path_value=$1
  [ -f "$path_value" ] && [ ! -L "$path_value" ] || return 1
  [ "$(file_uid "$path_value")" = "$TRUSTED_UID" ] || return 1
  [ "$(file_gid "$path_value")" = "$TRUSTED_GID" ] || return 1
  [ "$(file_links "$path_value")" = '1' ] || return 1
  mode_is_not_writable_by_group_or_other "$(file_mode "$path_value")"
}

validate_secure_chain() {
  requested_path=$1
  allow_missing=${2:-0}
  secure_directory "$SECURITY_ROOT" || return 1
  case "$requested_path" in
    "$SECURITY_ROOT") return 0 ;;
    "$SECURITY_ROOT"/*) relative_path=${requested_path#"$SECURITY_ROOT"/} ;;
    /*)
      [ "$SECURITY_ROOT" = '/' ] || return 1
      relative_path=${requested_path#/}
      ;;
    *) return 1 ;;
  esac
  current_path=$SECURITY_ROOT
  old_ifs=$IFS
  IFS='/'
  set -- $relative_path
  IFS=$old_ifs
  for component in "$@"; do
    case "$component" in ''|.|..) return 1 ;; esac
    current_path="${current_path%/}/$component"
    if [ ! -e "$current_path" ] && [ ! -L "$current_path" ]; then
      [ "$allow_missing" = '1' ] && return 0
      return 1
    fi
    secure_directory "$current_path" || return 1
  done
}

ensure_directory() {
  directory=$1
  mode=$2
  if [ -e "$directory" ] || [ -L "$directory" ]; then
    secure_directory "$directory" || fail 'TARGET_PATH_UNSAFE'
    return 0
  fi
  parent=${directory%/*}
  secure_directory "$parent" || fail 'TARGET_PATH_UNSAFE'
  mkdir "$directory" || fail 'TARGET_DIRECTORY_CREATE_FAILED'
  chown "$INSTALL_OWNER:$INSTALL_GROUP" "$directory" || fail 'TARGET_DIRECTORY_OWNER_FAILED'
  chmod "$mode" "$directory" || fail 'TARGET_DIRECTORY_MODE_FAILED'
  secure_directory "$directory" || fail 'TARGET_PATH_UNSAFE'
  sync -f "$parent" || fail 'TARGET_DIRECTORY_SYNC_FAILED'
}

durable_file() {
  path_value=$1
  sync -f "$path_value" || fail 'TRANSACTION_SYNC_FAILED'
}

durable_directory() {
  path_value=$1
  sync -f "$path_value" || fail 'TRANSACTION_SYNC_FAILED'
}

write_phase() {
  transaction=$1
  phase_value=$2
  phase_temp=$(mktemp "$transaction/.phase.XXXXXX") || return 1
  printf '%s\n' "$phase_value" > "$phase_temp" || return 1
  chown "$INSTALL_OWNER:$INSTALL_GROUP" "$phase_temp" || return 1
  chmod '0600' "$phase_temp" || return 1
  sync -f "$phase_temp" || return 1
  mv -fT -- "$phase_temp" "$transaction/phase" || return 1
  sync -f "$transaction" || return 1
}

validate_and_capture_manifest() {
  count=0
  seen=''
  while IFS= read -r line || [ -n "$line" ]; do
    old_ifs=$IFS
    IFS=' '
    set -- $line
    IFS=$old_ifs
    [ "$#" -eq 2 ] || return 1
    digest=$1
    relative=$2
    [ "${#digest}" -eq 64 ] || return 1
    case "$digest" in *[!0-9a-f]*) return 1 ;; esac
    case " $EXPECTED_ASSET_PATHS " in *" $relative "*) ;; *) return 1 ;; esac
    case "$seen" in *"|$relative|"*) return 1 ;; esac
    asset_id=$(id_for_source_path "$relative") || return 1
    set_expected_hash "$asset_id" "$digest" || return 1
    seen="$seen|$relative|"
    count=$((count + 1))
  done < "$MANIFEST_RELATIVE"
  [ "$count" -eq 7 ] || return 1
  for asset_id in $ASSET_IDS; do
    [ -n "$(expected_hash "$asset_id")" ] || return 1
  done
}

write_captured_manifest() {
  destination=$1
  : > "$destination"
  for asset_id in $ASSET_IDS; do
    printf '%s  %s\n' "$(expected_hash "$asset_id")" "$(asset_source "$asset_id")" >> "$destination"
  done
  chown "$INSTALL_OWNER:$INSTALL_GROUP" "$destination"
  chmod '0600' "$destination"
  durable_file "$destination"
}

parent_record_line() {
  transaction=$1
  asset_id=$2
  awk -F '\t' -v wanted="$asset_id" '$1 == wanted { print; found=1 } END { if (!found) exit 1 }' "$transaction/parents.tsv"
}

verify_bound_parent() {
  transaction=$1
  asset_id=$2
  record=$(parent_record_line "$transaction" "$asset_id") || {
    RECOVERY_CODE='TRANSACTION_INVENTORY_INVALID'
    return 1
  }
  tab=$(printf '\t')
  old_ifs=$IFS
  IFS="$tab"
  set -- $record
  IFS=$old_ifs
  [ "$#" -eq 3 ] || {
    RECOVERY_CODE='TRANSACTION_INVENTORY_INVALID'
    return 1
  }
  expected_parent=$2
  expected_identity=$3
  target_parent=$(asset_target "$asset_id")
  target_parent=${target_parent%/*}
  if [ "$expected_parent" != "$target_parent" ] || ! secure_directory "$target_parent" ||
    [ "$(file_identity "$target_parent" 2>/dev/null || printf '%s' invalid)" != "$expected_identity" ]; then
    RECOVERY_CODE='TARGET_PARENT_IDENTITY_CHANGED'
    return 1
  fi
}

state_record_line() {
  transaction=$1
  asset_id=$2
  awk -F '\t' -v wanted="$asset_id" '$1 == wanted { print; found=1 } END { if (!found) exit 1 }' "$transaction/asset-state.tsv"
}

validate_transaction() {
  transaction=$1
  secure_directory "$transaction" || return 1
  for trusted_file in phase asset-state.tsv parents.tsv captured-manifest.sha256 runtime-before runtime-identity; do
    secure_regular_file "$transaction/$trusted_file" || return 1
  done
  [ "$(wc -l < "$transaction/asset-state.tsv" | tr -d ' ')" = '8' ] || return 1
  [ "$(wc -l < "$transaction/parents.tsv" | tr -d ' ')" = '8' ] || return 1
  for asset_id in $ASSET_IDS; do
    line=$(state_record_line "$transaction" "$asset_id") || return 1
    tab=$(printf '\t')
    old_ifs=$IFS
    IFS="$tab"
    set -- $line
    IFS=$old_ifs
    [ "$#" -eq 8 ] || return 1
    [ "$1" = "$asset_id" ] || return 1
    [ "$3" = "$(asset_target "$asset_id")" ] || return 1
    case "$2" in
      present)
        [ "$4" = "$asset_id.asset" ] || return 1
        secure_regular_file "$transaction/backups/$4" || return 1
        [ "$(file_hash "$transaction/backups/$4")" = "$5" ] || return 1
        ;;
      absent) [ "$4" = '-' ] || return 1 ;;
      *) return 1 ;;
    esac
    verify_bound_parent "$transaction" "$asset_id" || return 1
  done
}

restore_files_from_transaction() {
  transaction=$1
  for asset_id in $ROLLBACK_IDS; do
    verify_bound_parent "$transaction" "$asset_id" || return 1
    line=$(state_record_line "$transaction" "$asset_id") || {
      RECOVERY_CODE='TRANSACTION_INVENTORY_INVALID'
      return 1
    }
    tab=$(printf '\t')
    old_ifs=$IFS
    IFS="$tab"
    set -- $line
    IFS=$old_ifs
    original_state=$2
    target=$3
    backup_name=$4
    original_hash=$5
    original_mode=$6
    original_uid=$7
    original_gid=$8
    case "$original_state" in
      present)
        restore_temp=$(mktemp "${target%/*}/.kinvest-metadata-restore-${asset_id}.XXXXXX") || return 1
        if ! cp "$transaction/backups/$backup_name" "$restore_temp" ||
          ! chown "$original_uid:$original_gid" "$restore_temp" ||
          ! chmod "$original_mode" "$restore_temp" ||
          [ "$(file_hash "$restore_temp")" != "$original_hash" ]; then
          rm -f -- "$restore_temp"
          return 1
        fi
        sync -f "$restore_temp" || return 1
        verify_bound_parent "$transaction" "$asset_id" || return 1
        mv -fT -- "$restore_temp" "$target" || return 1
        sync -f "$target" || return 1
        sync -f "${target%/*}" || return 1
        ;;
      absent)
        verify_bound_parent "$transaction" "$asset_id" || return 1
        if [ -e "$target" ] || [ -L "$target" ]; then
          if [ -f "$target" ] || [ -L "$target" ]; then
            rm -f -- "$target" || return 1
            sync -f "${target%/*}" || return 1
          else
            RECOVERY_CODE='TARGET_PATH_UNSAFE'
            return 1
          fi
        fi
        ;;
      *) RECOVERY_CODE='TRANSACTION_INVENTORY_INVALID'; return 1 ;;
    esac
  done
}

runtime_value() {
  if [ ! -e "$RUNTIME_SYSCTL_PATH" ] || [ -L "$RUNTIME_SYSCTL_PATH" ]; then
    printf '%s\n' missing
    return 0
  fi
  value=$(cat "$RUNTIME_SYSCTL_PATH" 2>/dev/null || printf '%s' unreadable)
  case "$value" in 1|0) printf '%s\n' "$value" ;; *) printf '%s\n' other ;; esac
}

write_runtime_one() {
  [ -e "$RUNTIME_SYSCTL_PATH" ] && [ ! -L "$RUNTIME_SYSCTL_PATH" ] || return 1
  printf '1\n' > "$RUNTIME_SYSCTL_PATH" || return 1
  [ "$(runtime_value)" = '1' ]
}

verify_bridge_prerequisites() {
  [ -d "$RUNTIME_MODULE_PATH" ] && [ ! -L "$RUNTIME_MODULE_PATH" ] || return 1
  [ -f "$RUNTIME_SYSCTL_PATH" ] && [ ! -L "$RUNTIME_SYSCTL_PATH" ] || return 1
  path_identity_before=$(file_identity "$RUNTIME_SYSCTL_PATH" 2>/dev/null) || return 1
  exec 8< "$RUNTIME_SYSCTL_PATH" || return 1
  verification_failed='0'
  if [ "$RUNTIME_FD_IDENTITY_MODE" = 'device-inode' ]; then
    fd_identity=$(file_identity "$RUNTIME_FD_ROOT/8" 2>/dev/null) || verification_failed='1'
    [ "$verification_failed" = '0' ] && [ "$fd_identity" = "$path_identity_before" ] || verification_failed='1'
  else
    [ "$RUNTIME_FD_IDENTITY_MODE" = 'inode-only' ] || verification_failed='1'
    fd_inode=$(file_inode "$RUNTIME_FD_ROOT/8" 2>/dev/null) || verification_failed='1'
    path_inode=$(file_inode "$RUNTIME_SYSCTL_PATH" 2>/dev/null) || verification_failed='1'
    [ "$verification_failed" = '0' ] && [ "$fd_inode" = "$path_inode" ] || verification_failed='1'
  fi
  first_line=''
  if ! IFS= read -r first_line <&8; then
    verification_failed='1'
  fi
  extra_line=''
  if IFS= read -r extra_line <&8 || [ -n "$extra_line" ]; then
    verification_failed='1'
  fi
  exec 8<&-
  [ "$first_line" = '1' ] || verification_failed='1'
  path_identity_after=$(file_identity "$RUNTIME_SYSCTL_PATH" 2>/dev/null) || verification_failed='1'
  [ "$path_identity_after" = "$path_identity_before" ] || verification_failed='1'
  [ "$verification_failed" = '0' ]
}

rollback_runtime() {
  transaction=$1
  [ -f "$transaction/runtime-sysctl-attempted" ] || return 0
  prior_runtime=$(cat "$transaction/runtime-before" 2>/dev/null || printf '%s' other)
  partial_code=''
  restored_sysctl=$(asset_target sysctl)
  if [ ! -e "$restored_sysctl" ] && [ ! -L "$restored_sysctl" ]; then
    partial_code='PRIOR_CONFIG_ABSENT'
  elif [ -f "$restored_sysctl" ] && [ ! -L "$restored_sysctl" ] &&
    [ "$(cat "$restored_sysctl" 2>/dev/null || printf '%s' invalid)" = 'net.bridge.bridge-nf-call-iptables = 1' ]; then
    if ! sysctl --load "$restored_sysctl" >/dev/null 2>&1; then
      partial_code='PRIOR_CONFIG_RELOAD_FAILED'
    fi
  else
    partial_code='PRIOR_CONFIG_UNSAFE'
  fi
  if [ "$prior_runtime" != '1' ]; then
    partial_code='PRIOR_RUNTIME_UNSAFE'
  fi
  if [ "$(runtime_value)" != '1' ]; then
    write_runtime_one || {
      printf '%s\n' 'KINVEST_METADATA_FIREWALL_RUNTIME_ROLLBACK_PARTIAL code=SAFE_VALUE_RESTORE_FAILED preserved=unknown' >&2
      return 1
    }
  fi
  if [ ! -d "$RUNTIME_MODULE_PATH" ] || [ -L "$RUNTIME_MODULE_PATH" ]; then
    modprobe br_netfilter >/dev/null 2>&1 || :
  fi
  if ! verify_bridge_prerequisites; then
    printf '%s\n' 'KINVEST_METADATA_FIREWALL_RUNTIME_ROLLBACK_PARTIAL code=RUNTIME_VERIFY_FAILED preserved=1' >&2
    return 1
  fi
  if [ -n "$partial_code" ]; then
    printf 'KINVEST_METADATA_FIREWALL_RUNTIME_ROLLBACK_PARTIAL code=%s preserved=1\n' "$partial_code" >&2
  fi
}

recover_transaction() {
  transaction=$1
  validate_transaction "$transaction" || {
    [ "$RECOVERY_CODE" = 'RECOVERY_FAILED' ] && RECOVERY_CODE='TRANSACTION_INVENTORY_INVALID'
    return 1
  }
  files_status='ok'
  runtime_status='not-required'
  daemon_reload_status='ok'
  phase_status=$(cat "$transaction/phase" 2>/dev/null || printf '%s' invalid)
  restore_files_from_transaction "$transaction" || files_status='failed'
  if [ -f "$transaction/runtime-sysctl-attempted" ]; then
    runtime_status='ok'
    rollback_runtime "$transaction" || runtime_status='failed'
  fi
  systemctl daemon-reload >/dev/null 2>&1 || daemon_reload_status='failed'
  if [ "$files_status" = 'ok' ] && [ "$runtime_status" != 'failed' ] && [ "$daemon_reload_status" = 'ok' ]; then
    if write_phase "$transaction" recovered; then
      phase_status='recovered'
    else
      phase_status='write-failed'
    fi
  fi
  printf 'KINVEST_METADATA_FIREWALL_RECOVERY_STATUS files=%s runtime=%s daemon_reload=%s phase=%s\n' \
    "$files_status" "$runtime_status" "$daemon_reload_status" "$phase_status" >&2
  if [ "$files_status" != 'ok' ] || [ "$runtime_status" = 'failed' ] ||
    [ "$daemon_reload_status" != 'ok' ] || [ "$phase_status" != 'recovered' ]; then
    RECOVERY_CODE='RECOVERY_INCOMPLETE'
    return 1
  fi
}

recover_incomplete_transaction() {
  incomplete=''
  incomplete_count=0
  set +f
  set -- "$BACKUP_ROOT"/install-*
  set -f
  for candidate in "$@"; do
    [ -d "$candidate" ] || continue
    secure_directory "$candidate" || {
      RECOVERY_CODE='TRANSACTION_INVENTORY_INVALID'
      return 1
    }
    if ! secure_regular_file "$candidate/phase"; then
      RECOVERY_CODE='TRANSACTION_INVENTORY_INVALID'
      return 1
    fi
    phase_value=$(cat "$candidate/phase" 2>/dev/null || printf '%s' invalid)
    case "$phase_value" in
      committed|recovered) ;;
      prepared|installing)
        incomplete=$candidate
        incomplete_count=$((incomplete_count + 1))
        ;;
      *) RECOVERY_CODE='TRANSACTION_INVENTORY_INVALID'; return 1 ;;
    esac
  done
  [ "$incomplete_count" -le 1 ] || {
    RECOVERY_CODE='MULTIPLE_INCOMPLETE_TRANSACTIONS'
    return 1
  }
  [ "$incomplete_count" -eq 0 ] || recover_transaction "$incomplete"
}

cleanup() {
  status=$?
  trap - 0 HUP INT TERM
  set +e
  rollback_status='not-required'
  if [ "$status" -ne 0 ] && [ "$transaction_started" = '1' ] && [ "$transaction_committed" != '1' ]; then
    rollback_status='ok'
    if ! recover_transaction "$backup_dir"; then
      rollback_status="failed:$RECOVERY_CODE"
    fi
  fi
  for temporary in "$stage_library" "$stage_wrapper" "$stage_service" "$stage_timer" "$stage_drop_in" "$stage_modules_load" "$stage_sysctl"; do
    [ -n "$temporary" ] && rm -f -- "$temporary"
  done
  if [ "$status" -ne 0 ]; then
    printf 'KINVEST_METADATA_FIREWALL_INSTALL_FAILED code=%s backup=%s rollback=%s\n' \
      "$FAILURE_CODE" "$backup_dir" "$rollback_status" >&2
  fi
  exit "$status"
}
trap cleanup 0
trap 'FAILURE_CODE=INTERRUPTED; exit 129' HUP
trap 'FAILURE_CODE=INTERRUPTED; exit 130' INT
trap 'FAILURE_CODE=INTERRUPTED; exit 143' TERM

if [ "$#" -ne 1 ]; then
  fail 'USAGE'
fi
SOURCE_ROOT=$1
if [ "$(id -u)" != "$REQUIRED_UID" ]; then
  fail 'ROOT_REQUIRED'
fi
case "$SOURCE_ROOT" in /*) ;; *) fail 'SOURCE_ROOT_INVALID' ;; esac
if printf '%s' "$SOURCE_ROOT" | LC_ALL=C grep -q '[[:cntrl:]]'; then
  fail 'SOURCE_ROOT_INVALID'
fi

secure_directory "$SECURITY_ROOT" || fail 'SECURITY_ROOT_UNSAFE'
validate_secure_chain "$TARGET_ROOT/var" 1 || fail 'TARGET_PATH_UNSAFE'
ensure_directory "$TARGET_ROOT/var" '0755'
validate_secure_chain "$TARGET_ROOT/var/backups" 1 || fail 'TARGET_PATH_UNSAFE'
ensure_directory "$TARGET_ROOT/var/backups" '0755'
validate_secure_chain "$BACKUP_ROOT" 1 || fail 'TARGET_PATH_UNSAFE'
ensure_directory "$BACKUP_ROOT" '0700'
chown "$INSTALL_OWNER:$INSTALL_GROUP" "$BACKUP_ROOT" || fail 'BACKUP_ROOT_OWNER_FAILED'
chmod '0700' "$BACKUP_ROOT" || fail 'BACKUP_ROOT_MODE_FAILED'
secure_directory "$BACKUP_ROOT" || fail 'BACKUP_ROOT_UNSAFE'

validate_secure_chain "$LOCK_ROOT" 1 || fail 'LOCK_PATH_UNSAFE'
ensure_directory "$LOCK_ROOT" '0755'
exec 9>"$LOCK_FILE"
flock -n 9 || fail 'INSTALL_LOCKED'
recover_incomplete_transaction || fail "$RECOVERY_CODE"

if [ ! -d "$SOURCE_ROOT" ] || [ -L "$SOURCE_ROOT" ]; then
  fail 'SOURCE_ROOT_INVALID'
fi
canonical_source=$(CDPATH= cd -P "$SOURCE_ROOT" 2>/dev/null && pwd -P) || fail 'SOURCE_ROOT_INVALID'
if [ "$canonical_source" != "$SOURCE_ROOT" ]; then
  fail 'SOURCE_ROOT_INVALID'
fi
validate_secure_chain "$SOURCE_ROOT" 0 || fail 'SOURCE_PATH_UNSAFE'
cd "$SOURCE_ROOT" || fail 'SOURCE_ROOT_INVALID'
if ! secure_directory deploy || ! secure_directory deploy/server; then
  fail 'SOURCE_PATH_UNSAFE'
fi
if ! secure_regular_file "$MANIFEST_RELATIVE"; then
  fail 'SOURCE_MANIFEST_INVALID'
fi
for asset_id in $ASSET_IDS; do
  source_relative=$(asset_source "$asset_id")
  secure_regular_file "$source_relative" || fail 'SOURCE_ASSET_UNSAFE'
done
validate_and_capture_manifest || fail 'SOURCE_MANIFEST_INVALID'
sha256sum -c "$MANIFEST_RELATIVE" >/dev/null 2>&1 || fail 'SOURCE_MANIFEST_INVALID'

for asset_id in $ASSET_IDS; do
  target=$(asset_target "$asset_id")
  parent=${target%/*}
  validate_secure_chain "$parent" 1 || fail 'TARGET_PATH_UNSAFE'
  if [ -e "$target" ] || [ -L "$target" ]; then
    secure_regular_file "$target" || fail 'TARGET_PATH_UNSAFE'
  fi
done

timestamp=$(date -u '+%Y%m%dT%H%M%SZ') || fail 'BACKUP_TIMESTAMP_FAILED'
preparing_dir=$(mktemp -d "$BACKUP_ROOT/.preparing-$timestamp-XXXXXX") || fail 'BACKUP_CREATE_FAILED'
backup_dir=$preparing_dir
chown "$INSTALL_OWNER:$INSTALL_GROUP" "$preparing_dir" || fail 'BACKUP_OWNER_FAILED'
chmod '0700' "$preparing_dir" || fail 'BACKUP_MODE_FAILED'
mkdir "$preparing_dir/snapshot" "$preparing_dir/backups" || fail 'BACKUP_CREATE_FAILED'
chown "$INSTALL_OWNER:$INSTALL_GROUP" "$preparing_dir/snapshot" "$preparing_dir/backups" || fail 'BACKUP_OWNER_FAILED'
chmod '0700' "$preparing_dir/snapshot" "$preparing_dir/backups" || fail 'BACKUP_MODE_FAILED'
write_captured_manifest "$preparing_dir/captured-manifest.sha256" || fail 'TRANSACTION_SYNC_FAILED'

for asset_id in $ASSET_IDS; do
  source_relative=$(asset_source "$asset_id")
  snapshot="$preparing_dir/snapshot/$asset_id.asset"
  cp "$source_relative" "$snapshot" || fail 'SOURCE_SNAPSHOT_COPY_FAILED'
  chown "$INSTALL_OWNER:$INSTALL_GROUP" "$snapshot" || fail 'SOURCE_SNAPSHOT_COPY_FAILED'
  chmod '0600' "$snapshot" || fail 'SOURCE_SNAPSHOT_COPY_FAILED'
  if [ "$(file_hash "$snapshot")" != "$(expected_hash "$asset_id")" ]; then
    fail 'SOURCE_SNAPSHOT_HASH_MISMATCH'
  fi
  durable_file "$snapshot"
done
/bin/sh -n "$preparing_dir/snapshot/library.asset" || fail 'SOURCE_SYNTAX_INVALID'
/bin/sh -n "$preparing_dir/snapshot/wrapper.asset" || fail 'SOURCE_SYNTAX_INVALID'

state_record="$preparing_dir/asset-state.tsv"
printf 'asset-state-v1\tstate\ttarget\tbackup\thash\tmode\tuid\tgid\n' > "$state_record"
for asset_id in $ASSET_IDS; do
  target=$(asset_target "$asset_id")
  if [ -e "$target" ]; then
    backup_name="$asset_id.asset"
    cp -p "$target" "$preparing_dir/backups/$backup_name" || fail 'BACKUP_COPY_FAILED'
    chown "$INSTALL_OWNER:$INSTALL_GROUP" "$preparing_dir/backups/$backup_name" || fail 'BACKUP_COPY_FAILED'
    backup_hash=$(file_hash "$target")
    [ "$(file_hash "$preparing_dir/backups/$backup_name")" = "$backup_hash" ] || fail 'BACKUP_VERIFY_FAILED'
    printf '%s\tpresent\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$asset_id" "$target" "$backup_name" "$backup_hash" "$(file_mode "$target")" "$(file_uid "$target")" "$(file_gid "$target")" >> "$state_record"
    durable_file "$preparing_dir/backups/$backup_name"
  else
    printf '%s\tabsent\t%s\t-\t-\t-\t-\t-\n' "$asset_id" "$target" >> "$state_record"
  fi
done
chown "$INSTALL_OWNER:$INSTALL_GROUP" "$state_record" || fail 'BACKUP_RECORD_FAILED'
chmod '0600' "$state_record" || fail 'BACKUP_RECORD_FAILED'
durable_file "$state_record"

ensure_directory "$TARGET_ROOT/usr" '0755'
ensure_directory "$TARGET_ROOT/usr/local" '0755'
ensure_directory "$TARGET_ROOT/usr/local/libexec" '0755'
ensure_directory "$TARGET_ROOT/usr/local/sbin" '0755'
ensure_directory "$TARGET_ROOT/etc" '0755'
ensure_directory "$TARGET_ROOT/etc/systemd" '0755'
ensure_directory "$TARGET_ROOT/etc/systemd/system" '0755'
ensure_directory "$TARGET_ROOT/etc/systemd/system/docker.service.d" '0755'
ensure_directory "$TARGET_ROOT/etc/modules-load.d" '0755'
ensure_directory "$TARGET_ROOT/etc/sysctl.d" '0755'

parents_record="$preparing_dir/parents.tsv"
printf 'parent-state-v1\tpath\tidentity\n' > "$parents_record"
for asset_id in $ASSET_IDS; do
  parent=$(asset_target "$asset_id")
  parent=${parent%/*}
  secure_directory "$parent" || fail 'TARGET_PATH_UNSAFE'
  printf '%s\t%s\t%s\n' "$asset_id" "$parent" "$(file_identity "$parent")" >> "$parents_record"
done
chown "$INSTALL_OWNER:$INSTALL_GROUP" "$parents_record" || fail 'BACKUP_RECORD_FAILED'
chmod '0600' "$parents_record" || fail 'BACKUP_RECORD_FAILED'
durable_file "$parents_record"

runtime_before=$(runtime_value)
printf '%s\n' "$runtime_before" > "$preparing_dir/runtime-before"
if [ -e "$RUNTIME_SYSCTL_PATH" ] && [ ! -L "$RUNTIME_SYSCTL_PATH" ]; then
  printf '%s\n' "$(file_identity "$RUNTIME_SYSCTL_PATH")" > "$preparing_dir/runtime-identity"
else
  printf '%s\n' missing > "$preparing_dir/runtime-identity"
fi
for runtime_record in runtime-before runtime-identity; do
  chown "$INSTALL_OWNER:$INSTALL_GROUP" "$preparing_dir/$runtime_record" || fail 'BACKUP_RECORD_FAILED'
  chmod '0600' "$preparing_dir/$runtime_record" || fail 'BACKUP_RECORD_FAILED'
  durable_file "$preparing_dir/$runtime_record"
done

write_phase "$preparing_dir" prepared || fail 'TRANSACTION_SYNC_FAILED'
durable_directory "$preparing_dir/snapshot"
durable_directory "$preparing_dir/backups"
durable_directory "$preparing_dir"
transaction_suffix=${preparing_dir##*/.preparing-}
final_transaction="$BACKUP_ROOT/install-$transaction_suffix"
mv -fT -- "$preparing_dir" "$final_transaction" || fail 'TRANSACTION_PREPARE_FAILED'
durable_directory "$BACKUP_ROOT"
preparing_dir=''
backup_dir=$final_transaction
state_record="$backup_dir/asset-state.tsv"
parents_record="$backup_dir/parents.tsv"
transaction_started='1'
write_phase "$backup_dir" installing || fail 'TRANSACTION_SYNC_FAILED'

for asset_id in $ASSET_IDS; do
  verify_bound_parent "$backup_dir" "$asset_id" || fail "$RECOVERY_CODE"
  target=$(asset_target "$asset_id")
  mode=$(asset_mode "$asset_id")
  temporary=$(mktemp "${target%/*}/.kinvest-metadata-${asset_id}.XXXXXX") || fail 'STAGE_CREATE_FAILED'
  set_stage_path "$asset_id" "$temporary"
  cp "$backup_dir/snapshot/$asset_id.asset" "$temporary" || fail 'STAGE_COPY_FAILED'
  chown "$INSTALL_OWNER:$INSTALL_GROUP" "$temporary" || fail 'STAGE_OWNER_FAILED'
  chmod "$mode" "$temporary" || fail 'STAGE_MODE_FAILED'
  if [ "$(file_hash "$temporary")" != "$(expected_hash "$asset_id")" ] ||
    [ "$(file_mode "$temporary")" != "${mode#0}" ]; then
    fail 'STAGE_VERIFY_FAILED'
  fi
  if asset_is_shell "$asset_id"; then
    /bin/sh -n "$temporary" || fail 'STAGE_SYNTAX_INVALID'
  fi
  durable_file "$temporary"
  verify_bound_parent "$backup_dir" "$asset_id" || fail "$RECOVERY_CODE"
done

for asset_id in $INSTALL_IDS; do
  verify_bound_parent "$backup_dir" "$asset_id" || fail "$RECOVERY_CODE"
  temporary=$(stage_path "$asset_id")
  target=$(asset_target "$asset_id")
  mv -fT -- "$temporary" "$target" || fail 'ATOMIC_REPLACE_FAILED'
  set_stage_path "$asset_id" ''
  sync -f "$target" || fail 'TRANSACTION_SYNC_FAILED'
  sync -f "${target%/*}" || fail 'TRANSACTION_SYNC_FAILED'
  case "$asset_id" in
    drop-in) # TEST_FAULT_POINT_AFTER_REPLACE_drop-in
      ;;
    library) # TEST_FAULT_POINT_AFTER_REPLACE_library
      ;;
    wrapper) # TEST_FAULT_POINT_AFTER_REPLACE_wrapper
      ;;
    service) # TEST_FAULT_POINT_AFTER_REPLACE_service
      ;;
    timer) # TEST_FAULT_POINT_AFTER_REPLACE_timer
      ;;
    modules-load) # TEST_FAULT_POINT_AFTER_REPLACE_modules-load
      ;;
    sysctl) # TEST_FAULT_POINT_AFTER_REPLACE_sysctl
      ;;
  esac
done

for asset_id in $ASSET_IDS; do
  verify_bound_parent "$backup_dir" "$asset_id" || fail "$RECOVERY_CODE"
  target=$(asset_target "$asset_id")
  mode=$(asset_mode "$asset_id")
  if [ ! -f "$target" ] || [ -L "$target" ] ||
    [ "$(file_hash "$target")" != "$(expected_hash "$asset_id")" ] ||
    [ "$(file_mode "$target")" != "${mode#0}" ]; then
    fail 'INSTALLED_ASSET_VERIFY_FAILED'
  fi
done
/bin/sh -n "$(asset_target library)" || fail 'INSTALLED_SYNTAX_INVALID'
/bin/sh -n "$(asset_target wrapper)" || fail 'INSTALLED_SYNTAX_INVALID'

if ! modprobe br_netfilter; then
  fail 'MODULE_LOAD_FAILED'
fi
: > "$backup_dir/runtime-sysctl-attempted"
chown "$INSTALL_OWNER:$INSTALL_GROUP" "$backup_dir/runtime-sysctl-attempted" || fail 'BACKUP_RECORD_FAILED'
chmod '0600' "$backup_dir/runtime-sysctl-attempted" || fail 'BACKUP_RECORD_FAILED'
durable_file "$backup_dir/runtime-sysctl-attempted"
durable_directory "$backup_dir"
if ! sysctl --load "$(asset_target sysctl)"; then
  fail 'SYSCTL_LOAD_FAILED'
fi
if ! "$(asset_target wrapper)" verify-bridge-netfilter; then
  fail 'RUNTIME_VERIFY_FAILED'
fi
if ! systemctl daemon-reload; then
  fail 'DAEMON_RELOAD_FAILED'
fi
write_phase "$backup_dir" committed || fail 'TRANSACTION_SYNC_FAILED'
transaction_committed='1'
printf 'KINVEST_METADATA_FIREWALL_INSTALL_OK backup=%s\n' "$backup_dir"
