#!/bin/sh
set -eu
set -f
umask 077

TARGET_ROOT=''
REQUIRED_UID='0'
SECURE_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
INSTALL_OWNER='root'
INSTALL_GROUP='root'
BACKUP_ROOT="$TARGET_ROOT/var/backups/kinvest-metadata-firewall"
MANIFEST_RELATIVE='deploy/server/metadata-firewall-assets.sha256'
ASSET_IDS='library wrapper service timer drop-in modules-load sysctl'
EXPECTED_ASSET_PATHS='deploy/server/kinvest-metadata-firewall-lib.sh deploy/server/kinvest-metadata-firewall.sh deploy/server/kinvest-metadata-firewall.service deploy/server/kinvest-metadata-firewall.timer deploy/server/docker-kinvest-metadata-firewall.conf deploy/server/kinvest-br-netfilter.modules-load.conf deploy/server/kinvest-br-netfilter.sysctl.conf'

PATH=$SECURE_PATH
export PATH

FAILURE_CODE='UNEXPECTED_FAILURE'
backup_dir='none'
state_record=''
transaction_started='0'
transaction_committed='0'
stage_library=''
stage_wrapper=''
stage_service=''
stage_timer=''
stage_drop_in=''
stage_modules_load=''
stage_sysctl=''

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
  case "$1" in
    library|wrapper) return 0 ;;
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

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

file_uid() {
  if stat -c '%u' "$1" >/dev/null 2>&1; then
    stat -c '%u' "$1"
  else
    stat -f '%u' "$1"
  fi
}

file_gid() {
  if stat -c '%g' "$1" >/dev/null 2>&1; then
    stat -c '%g' "$1"
  else
    stat -f '%g' "$1"
  fi
}

identity_id() {
  value=$1
  kind=$2
  case "$value" in
    ''|*[!0-9]*)
      if [ "$kind" = 'user' ]; then
        id -u "$value"
      else
        id -g "$value"
      fi
      ;;
    *) printf '%s\n' "$value" ;;
  esac
}

assert_safe_directory() {
  directory=$1
  if [ -L "$directory" ] || { [ -e "$directory" ] && [ ! -d "$directory" ]; }; then
    fail 'TARGET_PATH_UNSAFE'
  fi
}

ensure_directory() {
  directory=$1
  mode=$2
  assert_safe_directory "$directory"
  if [ ! -d "$directory" ]; then
    mkdir "$directory" || fail 'TARGET_DIRECTORY_CREATE_FAILED'
    chown "$INSTALL_OWNER:$INSTALL_GROUP" "$directory" || fail 'TARGET_DIRECTORY_OWNER_FAILED'
    chmod "$mode" "$directory" || fail 'TARGET_DIRECTORY_MODE_FAILED'
  fi
}

validate_manifest_shape() (
  count=0
  seen=''
  while IFS= read -r line || [ -n "$line" ]; do
    old_ifs=$IFS
    IFS=' '
    set -- $line
    IFS=$old_ifs
    [ "$#" -eq 2 ] || exit 1
    digest=$1
    relative=$2
    [ "${#digest}" -eq 64 ] || exit 1
    case "$digest" in *[!0-9a-f]*) exit 1 ;; esac
    case " $EXPECTED_ASSET_PATHS " in *" $relative "*) ;; *) exit 1 ;; esac
    case "$seen" in *"|$relative|"*) exit 1 ;; esac
    seen="$seen|$relative|"
    count=$((count + 1))
  done < "$MANIFEST_RELATIVE"
  [ "$count" -eq 7 ] || exit 1
  for expected in $EXPECTED_ASSET_PATHS; do
    case "$seen" in *"|$expected|"*) ;; *) exit 1 ;; esac
  done
)

rollback_assets() {
  rollback_failed='0'
  tab=$(printf '\t')
  while IFS="$tab" read -r asset_id original_state target backup_name; do
    [ "$asset_id" = 'asset-state-v1' ] && continue
    case "$original_state" in
      present)
        restore_temp=$(mktemp "${target%/*}/.kinvest-metadata-restore-${asset_id}.XXXXXX") || {
          rollback_failed='1'
          continue
        }
        if ! cp -p "$backup_dir/$backup_name" "$restore_temp"; then
          rollback_failed='1'
        elif ! mv -fT -- "$restore_temp" "$target"; then
          rollback_failed='1'
        fi
        rm -f -- "$restore_temp"
        if [ ! -f "$target" ] || [ -L "$target" ] ||
          [ "$(file_hash "$target" 2>/dev/null || printf '%s' invalid)" != "$(file_hash "$backup_dir/$backup_name" 2>/dev/null || printf '%s' missing)" ] ||
          [ "$(file_mode "$target" 2>/dev/null || printf '%s' invalid)" != "$(file_mode "$backup_dir/$backup_name" 2>/dev/null || printf '%s' missing)" ]; then
          rollback_failed='1'
        fi
        ;;
      absent)
        if [ -e "$target" ] || [ -L "$target" ]; then
          if [ -f "$target" ] || [ -L "$target" ]; then
            rm -f -- "$target" || rollback_failed='1'
          else
            rollback_failed='1'
          fi
        fi
        ;;
      *) rollback_failed='1' ;;
    esac
  done < "$state_record"
  [ "$rollback_failed" = '0' ]
}

cleanup() {
  status=$?
  trap - 0 HUP INT TERM
  set +e
  rollback_status='not-required'
  if [ "$status" -ne 0 ] && [ "$transaction_started" = '1' ] && [ "$transaction_committed" != '1' ]; then
    rollback_status='ok'
    rollback_assets || rollback_status='failed'
    systemctl daemon-reload >/dev/null 2>&1 || rollback_status="${rollback_status}+daemon-reload-failed"
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
if [ ! -d "$SOURCE_ROOT" ] || [ -L "$SOURCE_ROOT" ]; then
  fail 'SOURCE_ROOT_INVALID'
fi
canonical_source=$(CDPATH= cd -P "$SOURCE_ROOT" 2>/dev/null && pwd -P) || fail 'SOURCE_ROOT_INVALID'
if [ "$canonical_source" != "$SOURCE_ROOT" ]; then
  fail 'SOURCE_ROOT_INVALID'
fi
cd "$SOURCE_ROOT" || fail 'SOURCE_ROOT_INVALID'

if [ ! -d deploy ] || [ -L deploy ] || [ ! -d deploy/server ] || [ -L deploy/server ]; then
  fail 'SOURCE_PATH_UNSAFE'
fi
if [ ! -f "$MANIFEST_RELATIVE" ] || [ -L "$MANIFEST_RELATIVE" ]; then
  fail 'SOURCE_MANIFEST_INVALID'
fi
for asset_id in $ASSET_IDS; do
  source_relative=$(asset_source "$asset_id")
  if [ ! -f "$source_relative" ] || [ -L "$source_relative" ]; then
    fail 'SOURCE_ASSET_UNSAFE'
  fi
done
if ! validate_manifest_shape || ! sha256sum -c "$MANIFEST_RELATIVE" >/dev/null 2>&1; then
  fail 'SOURCE_MANIFEST_INVALID'
fi
/bin/sh -n "$(asset_source library)" || fail 'SOURCE_SYNTAX_INVALID'
/bin/sh -n "$(asset_source wrapper)" || fail 'SOURCE_SYNTAX_INVALID'

for directory in \
  "$TARGET_ROOT" \
  "$TARGET_ROOT/usr" \
  "$TARGET_ROOT/usr/local" \
  "$TARGET_ROOT/usr/local/libexec" \
  "$TARGET_ROOT/usr/local/sbin" \
  "$TARGET_ROOT/etc" \
  "$TARGET_ROOT/etc/systemd" \
  "$TARGET_ROOT/etc/systemd/system" \
  "$TARGET_ROOT/etc/systemd/system/docker.service.d" \
  "$TARGET_ROOT/etc/modules-load.d" \
  "$TARGET_ROOT/etc/sysctl.d" \
  "$TARGET_ROOT/var" \
  "$TARGET_ROOT/var/backups" \
  "$BACKUP_ROOT"; do
  [ -n "$directory" ] && assert_safe_directory "$directory"
done
for asset_id in $ASSET_IDS; do
  target=$(asset_target "$asset_id")
  if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
    fail 'TARGET_PATH_UNSAFE'
  fi
done

ensure_directory "$TARGET_ROOT/var" '0755'
ensure_directory "$TARGET_ROOT/var/backups" '0755'
ensure_directory "$BACKUP_ROOT" '0700'
chown "$INSTALL_OWNER:$INSTALL_GROUP" "$BACKUP_ROOT" || fail 'BACKUP_ROOT_OWNER_FAILED'
chmod '0700' "$BACKUP_ROOT" || fail 'BACKUP_ROOT_MODE_FAILED'
timestamp=$(date -u '+%Y%m%dT%H%M%SZ') || fail 'BACKUP_TIMESTAMP_FAILED'
backup_dir=$(mktemp -d "$BACKUP_ROOT/install-$timestamp-XXXXXX") || fail 'BACKUP_CREATE_FAILED'
chown "$INSTALL_OWNER:$INSTALL_GROUP" "$backup_dir" || fail 'BACKUP_OWNER_FAILED'
chmod '0700' "$backup_dir" || fail 'BACKUP_MODE_FAILED'
state_record="$backup_dir/asset-state.tsv"
printf 'asset-state-v1\tstate\ttarget\tbackup\n' > "$state_record"
chmod '0600' "$state_record" || fail 'BACKUP_RECORD_FAILED'
chown "$INSTALL_OWNER:$INSTALL_GROUP" "$state_record" || fail 'BACKUP_RECORD_FAILED'

for asset_id in $ASSET_IDS; do
  target=$(asset_target "$asset_id")
  if [ -e "$target" ]; then
    backup_name="$asset_id.asset"
    cp -p "$target" "$backup_dir/$backup_name" || fail 'BACKUP_COPY_FAILED'
    if [ "$(file_hash "$target")" != "$(file_hash "$backup_dir/$backup_name")" ]; then
      fail 'BACKUP_VERIFY_FAILED'
    fi
    printf '%s\tpresent\t%s\t%s\n' "$asset_id" "$target" "$backup_name" >> "$state_record"
  else
    printf '%s\tabsent\t%s\t-\n' "$asset_id" "$target" >> "$state_record"
  fi
done
transaction_started='1'

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

expected_uid=$(identity_id "$INSTALL_OWNER" user) || fail 'OWNER_RESOLUTION_FAILED'
expected_gid=$(identity_id "$INSTALL_GROUP" group) || fail 'GROUP_RESOLUTION_FAILED'
for asset_id in $ASSET_IDS; do
  source_relative=$(asset_source "$asset_id")
  target=$(asset_target "$asset_id")
  mode=$(asset_mode "$asset_id")
  target_directory=${target%/*}
  temporary=$(mktemp "$target_directory/.kinvest-metadata-${asset_id}.XXXXXX") || fail 'STAGE_CREATE_FAILED'
  set_stage_path "$asset_id" "$temporary"
  cp "$source_relative" "$temporary" || fail 'STAGE_COPY_FAILED'
  chown "$INSTALL_OWNER:$INSTALL_GROUP" "$temporary" || fail 'STAGE_OWNER_FAILED'
  chmod "$mode" "$temporary" || fail 'STAGE_MODE_FAILED'
  if [ ! -f "$temporary" ] || [ -L "$temporary" ] ||
    [ "$(file_hash "$temporary")" != "$(file_hash "$source_relative")" ] ||
    [ "$(file_mode "$temporary")" != "${mode#0}" ] ||
    [ "$(file_uid "$temporary")" != "$expected_uid" ] ||
    [ "$(file_gid "$temporary")" != "$expected_gid" ]; then
    fail 'STAGE_VERIFY_FAILED'
  fi
  if asset_is_shell "$asset_id"; then
    /bin/sh -n "$temporary" || fail 'STAGE_SYNTAX_INVALID'
  fi
done

for asset_id in $ASSET_IDS; do
  temporary=$(stage_path "$asset_id")
  target=$(asset_target "$asset_id")
  if ! mv -fT -- "$temporary" "$target"; then
    fail 'ATOMIC_REPLACE_FAILED'
  fi
  set_stage_path "$asset_id" ''
done

for asset_id in $ASSET_IDS; do
  source_relative=$(asset_source "$asset_id")
  target=$(asset_target "$asset_id")
  mode=$(asset_mode "$asset_id")
  if [ ! -f "$target" ] || [ -L "$target" ] ||
    [ "$(file_hash "$target")" != "$(file_hash "$source_relative")" ] ||
    [ "$(file_mode "$target")" != "${mode#0}" ] ||
    [ "$(file_uid "$target")" != "$expected_uid" ] ||
    [ "$(file_gid "$target")" != "$expected_gid" ]; then
    fail 'INSTALLED_ASSET_VERIFY_FAILED'
  fi
done
/bin/sh -n "$(asset_target library)" || fail 'INSTALLED_SYNTAX_INVALID'
/bin/sh -n "$(asset_target wrapper)" || fail 'INSTALLED_SYNTAX_INVALID'

if ! modprobe br_netfilter; then
  fail 'MODULE_LOAD_FAILED'
fi
if ! sysctl --load "$(asset_target sysctl)"; then
  fail 'SYSCTL_LOAD_FAILED'
fi
if ! "$(asset_target wrapper)" verify-bridge-netfilter; then
  fail 'RUNTIME_VERIFY_FAILED'
fi
if ! systemctl daemon-reload; then
  fail 'DAEMON_RELOAD_FAILED'
fi

transaction_committed='1'
printf 'KINVEST_METADATA_FIREWALL_INSTALL_OK backup=%s\n' "$backup_dir"
