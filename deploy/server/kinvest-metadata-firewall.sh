#!/bin/sh
set -eu

PATH=/usr/sbin:/usr/bin:/sbin:/bin
KMF_LIBRARY=/usr/local/libexec/kinvest-metadata-firewall-lib.sh
KMF_CONFIG=${KMF_CONFIG:-/etc/kinvest/metadata-network.conf}
KMF_BR_NETFILTER_MODULE_PATH=${KMF_BR_NETFILTER_MODULE_PATH:-/sys/module/br_netfilter}
KMF_BRIDGE_NF_CALL_IPTABLES_PATH=${KMF_BRIDGE_NF_CALL_IPTABLES_PATH:-/proc/sys/net/bridge/bridge-nf-call-iptables}
KMF_ACTIVATION_STATE=${KMF_ACTIVATION_STATE:-/root/docker/kinvest/state/metadata-network.state}
KMF_RUNTIME_DIR=${KMF_RUNTIME_DIR:-/run}
KMF_LOCK=/run/lock/kinvest-metadata-firewall.lock
KMF_IPTABLES=/usr/sbin/iptables
KMF_IPTABLES_RESTORE=/usr/sbin/iptables-restore
KMF_DOCKER=/usr/bin/docker
KMF_SHA256SUM=/usr/bin/sha256sum
KMF_SYNC=/usr/bin/sync

kmf_reconcile_config=
kmf_reconcile_prefix=
kmf_activation_state_tmp=
KMF_ACTIVATION_MODE=

kinvest_cleanup_reconcile_config() {
  if [ -n "$kmf_reconcile_config" ]; then
    rm -f -- "$kmf_reconcile_config"
    kmf_reconcile_config=
  fi
  if [ -n "$kmf_reconcile_prefix" ]; then
    rm -f -- "$kmf_reconcile_prefix".*
  fi
  if [ -n "$kmf_activation_state_tmp" ]; then
    rm -f -- "$kmf_activation_state_tmp"
    kmf_activation_state_tmp=
  fi
}

kinvest_assert_secure_file() {
  kmf_secure_path=$1
  kmf_required_mode=${2:-}
  [ -f "$kmf_secure_path" ] && [ ! -L "$kmf_secure_path" ] || {
    printf '%s\n' 'Metadata firewall dependency is missing or is a symlink' >&2
    exit 1
  }
  kmf_stat=$(stat -Lc '%u:%g:%a' "$kmf_secure_path") || exit 1
  kmf_owner=$(printf '%s\n' "$kmf_stat" | cut -d: -f1)
  kmf_group=$(printf '%s\n' "$kmf_stat" | cut -d: -f2)
  kmf_mode=$(printf '%s\n' "$kmf_stat" | cut -d: -f3)
  [ "$kmf_owner" = 0 ] && [ "$kmf_group" = 0 ] || {
    printf '%s\n' 'Metadata firewall dependency is not owned by root' >&2
    exit 1
  }
  if [ -n "$kmf_required_mode" ] && [ "$kmf_mode" != "$kmf_required_mode" ]; then
    printf '%s\n' "Metadata firewall dependency must be root:root mode 0$kmf_required_mode" >&2
    exit 1
  fi
  kmf_group_digit=$(printf '%s\n' "$kmf_mode" | rev | cut -c2)
  kmf_other_digit=$(printf '%s\n' "$kmf_mode" | rev | cut -c1)
  case "$kmf_group_digit$kmf_other_digit" in
    *2*|*3*|*6*|*7*)
      printf '%s\n' 'Metadata firewall dependency is writable outside root' >&2
      exit 1
      ;;
  esac
}

kinvest_assert_active_config_binding() {
  kmf_bound_config=$1
  kmf_state_line_number=0
  kmf_expected_config_sha256=
  KMF_ACTIVATION_MODE=

  [ -f "$KMF_ACTIVATION_STATE" ] && [ ! -L "$KMF_ACTIVATION_STATE" ] || {
    printf '%s\n' 'Metadata network activation state is missing or is a symlink' >&2
    return 1
  }
  exec 8< "$KMF_ACTIVATION_STATE" || return 1
  [ -f /dev/fd/8 ] && [ ! -L "$KMF_ACTIVATION_STATE" ] || {
    printf '%s\n' 'Metadata network activation state changed while opening' >&2
    return 1
  }
  kmf_state_path_identity=$(stat -Lc '%d:%i' "$KMF_ACTIVATION_STATE") || return 1
  kmf_state_fd_identity=$(stat -Lc '%d:%i' /dev/fd/8) || return 1
  [ "$kmf_state_path_identity" = "$kmf_state_fd_identity" ] || {
    printf '%s\n' 'Metadata network activation state changed while opening' >&2
    return 1
  }
  kmf_state_stat=$(stat -Lc '%u:%g:%a' /dev/fd/8) || return 1
  [ "$kmf_state_stat" = 0:0:600 ] || {
    printf '%s\n' 'Metadata network activation state must be root:root mode 0600' >&2
    return 1
  }
  while IFS= read -r kmf_state_line || [ -n "$kmf_state_line" ]; do
    kmf_state_line_number=$((kmf_state_line_number + 1))
    case "$kmf_state_line_number:$kmf_state_line" in
      1:version=1) ;;
      2:mode=active) KMF_ACTIVATION_MODE=active ;;
      2:mode=deny-all) KMF_ACTIVATION_MODE=deny-all ;;
      3:config_sha256=*) kmf_expected_config_sha256=${kmf_state_line#config_sha256=} ;;
      *)
        printf '%s\n' 'Metadata network activation state is invalid or is not active' >&2
        return 1
        ;;
    esac
  done <&8
  exec 8<&-

  [ "$kmf_state_line_number" -eq 3 ] &&
    [ "${#kmf_expected_config_sha256}" -eq 64 ] || {
      printf '%s\n' 'Metadata network activation state is invalid or is not active' >&2
      return 1
    }
  case "$kmf_expected_config_sha256" in
    *[!0-9a-f]*)
      printf '%s\n' 'Metadata network activation state contains an invalid config hash' >&2
      return 1
      ;;
  esac

  kmf_sha256_output=$("$KMF_SHA256SUM" "$kmf_bound_config") || return 1
  kmf_actual_config_sha256=${kmf_sha256_output%% *}
  [ "${#kmf_actual_config_sha256}" -eq 64 ] || {
    printf '%s\n' 'Metadata network config hash command returned invalid output' >&2
    return 1
  }
  case "$kmf_actual_config_sha256" in
    *[!0-9a-f]*)
      printf '%s\n' 'Metadata network config hash command returned invalid output' >&2
      return 1
      ;;
  esac
  [ "$kmf_actual_config_sha256" = "$kmf_expected_config_sha256" ] || {
    printf '%s\n' 'Metadata network activation state does not match the installed config' >&2
    return 1
  }
}

kinvest_assert_secure_state_directory() {
  kmf_state_directory=${KMF_ACTIVATION_STATE%/*}
  [ "$kmf_state_directory" != "$KMF_ACTIVATION_STATE" ] &&
    [ -d "$kmf_state_directory" ] && [ ! -L "$kmf_state_directory" ] || {
    printf '%s\n' 'Metadata network activation state directory is unavailable or is a symlink' >&2
    return 1
  }
  kmf_state_directory_stat=$(stat -Lc '%u:%g:%a' "$kmf_state_directory") || return 1
  kmf_state_directory_owner=$(printf '%s\n' "$kmf_state_directory_stat" | cut -d: -f1)
  kmf_state_directory_group=$(printf '%s\n' "$kmf_state_directory_stat" | cut -d: -f2)
  kmf_state_directory_mode=$(printf '%s\n' "$kmf_state_directory_stat" | cut -d: -f3)
  [ "$kmf_state_directory_owner" = 0 ] && [ "$kmf_state_directory_group" = 0 ] || {
    printf '%s\n' 'Metadata network activation state directory is not owned by root' >&2
    return 1
  }
  kmf_state_directory_group_digit=$(printf '%s\n' "$kmf_state_directory_mode" | rev | cut -c2)
  kmf_state_directory_other_digit=$(printf '%s\n' "$kmf_state_directory_mode" | rev | cut -c1)
  case "$kmf_state_directory_group_digit$kmf_state_directory_other_digit" in
    *2*|*3*|*6*|*7*)
      printf '%s\n' 'Metadata network activation state directory is writable outside root' >&2
      return 1
      ;;
  esac
}

kinvest_activate_deny_all() {
  kmf_bound_config=$1
  kinvest_assert_secure_state_directory || return 1
  kmf_sha256_output=$("$KMF_SHA256SUM" "$kmf_bound_config") || return 1
  kmf_config_sha256=${kmf_sha256_output%% *}
  [ "${#kmf_config_sha256}" -eq 64 ] || {
    printf '%s\n' 'Metadata network config hash command returned invalid output' >&2
    return 1
  }
  case "$kmf_config_sha256" in
    *[!0-9a-f]*)
      printf '%s\n' 'Metadata network config hash command returned invalid output' >&2
      return 1
      ;;
  esac

  kmf_activation_state_tmp=$(mktemp "$KMF_ACTIVATION_STATE.$$.XXXXXX") || return 1
  printf 'version=1\nmode=deny-all\nconfig_sha256=%s\n' "$kmf_config_sha256" > "$kmf_activation_state_tmp"
  chmod 0600 "$kmf_activation_state_tmp"
  "$KMF_SYNC" "$kmf_activation_state_tmp" || return 1
  mv -f -- "$kmf_activation_state_tmp" "$KMF_ACTIVATION_STATE"
  kmf_activation_state_tmp=
  "$KMF_SYNC" "$kmf_state_directory" || return 1
  kinvest_assert_active_config_binding "$kmf_bound_config" || return 1
  [ "$KMF_ACTIVATION_MODE" = deny-all ]
}

kmf_usage='Usage: kinvest-metadata-firewall validate-config|verify-bridge-netfilter|guard|apply|status|reconcile|reconcile-active|activate-deny-all --confirm-deny-all|rollback|rollback-pre-bind --assert-role-unbound'
case "$#:$1" in
  1:validate-config|1:verify-bridge-netfilter|1:guard|1:apply|1:status|1:reconcile|1:reconcile-active|1:rollback) ;;
  2:activate-deny-all)
    [ "$2" = '--confirm-deny-all' ] || {
      printf '%s\n' "$kmf_usage" >&2
      exit 2
    }
    ;;
  2:rollback-pre-bind)
    [ "$2" = '--assert-role-unbound' ] || {
      printf '%s\n' "$kmf_usage" >&2
      exit 2
    }
    ;;
  *)
    printf '%s\n' "$kmf_usage" >&2
    exit 2
    ;;
esac
kmf_action=$1

kinvest_assert_secure_file "$KMF_LIBRARY"
if [ "$kmf_action" = verify-bridge-netfilter ]; then
  . "$KMF_LIBRARY"
  kinvest_metadata_verify_bridge_netfilter
  exit 0
fi
if [ "$kmf_action" = validate-config ] || [ "$kmf_action" = apply ] || [ "$kmf_action" = status ] || [ "$kmf_action" = reconcile ] || [ "$kmf_action" = reconcile-active ] || [ "$kmf_action" = activate-deny-all ]; then
  kinvest_assert_secure_file "$KMF_CONFIG" 600
fi
[ -x /usr/bin/flock ] || exit 1
if [ "$kmf_action" != validate-config ] && [ "$kmf_action" != activate-deny-all ]; then
  [ -x "$KMF_IPTABLES" ] || exit 1
fi
if [ "$kmf_action" = apply ] || [ "$kmf_action" = reconcile ] || [ "$kmf_action" = reconcile-active ]; then
  [ -x "$KMF_IPTABLES_RESTORE" ] || exit 1
fi
if [ "$kmf_action" = apply ] || [ "$kmf_action" = status ] || [ "$kmf_action" = reconcile ] || [ "$kmf_action" = reconcile-active ]; then
  [ -x "$KMF_DOCKER" ] || exit 1
fi
if [ "$kmf_action" = reconcile-active ] || [ "$kmf_action" = activate-deny-all ]; then
  [ -x "$KMF_SHA256SUM" ] || exit 1
fi
if [ "$kmf_action" = activate-deny-all ]; then
  [ -x "$KMF_SYNC" ] || exit 1
fi

exec 9>"$KMF_LOCK"
/usr/bin/flock -x 9
if [ "$kmf_action" = reconcile-active ] || [ "$kmf_action" = activate-deny-all ]; then
  umask 077
  kmf_reconcile_prefix="$KMF_RUNTIME_DIR/kinvest-metadata-network.$$"
  trap kinvest_cleanup_reconcile_config EXIT
  trap 'exit 1' HUP INT TERM
  kmf_reconcile_config=$(mktemp "$kmf_reconcile_prefix.XXXXXX")
  cat "$KMF_CONFIG" > "$kmf_reconcile_config"
  if [ "$kmf_action" = reconcile-active ]; then
    kinvest_assert_active_config_binding "$kmf_reconcile_config"
  fi
fi
. "$KMF_LIBRARY"

case "$kmf_action" in
  validate-config) kinvest_metadata_validate_config "$KMF_CONFIG" ;;
  guard) kinvest_metadata_guard "$KMF_IPTABLES" ;;
  apply) kinvest_metadata_apply "$KMF_IPTABLES" "$KMF_IPTABLES_RESTORE" "$KMF_DOCKER" "$KMF_CONFIG" ;;
  status) kinvest_metadata_status "$KMF_IPTABLES" "$KMF_DOCKER" "$KMF_CONFIG" ;;
  reconcile) kinvest_metadata_reconcile "$KMF_IPTABLES" "$KMF_IPTABLES_RESTORE" "$KMF_DOCKER" "$KMF_CONFIG" ;;
  reconcile-active)
    case "$KMF_ACTIVATION_MODE" in
      active) kinvest_metadata_reconcile "$KMF_IPTABLES" "$KMF_IPTABLES_RESTORE" "$KMF_DOCKER" "$kmf_reconcile_config" ;;
      deny-all) kinvest_metadata_reconcile_deny_all "$KMF_IPTABLES" "$KMF_IPTABLES_RESTORE" "$kmf_reconcile_config" ;;
      *) exit 1 ;;
    esac
    ;;
  activate-deny-all) kinvest_activate_deny_all "$kmf_reconcile_config" ;;
  rollback) kinvest_metadata_rollback "$KMF_IPTABLES" ;;
  rollback-pre-bind) kinvest_metadata_rollback_pre_bind "$KMF_IPTABLES" "$2" ;;
esac
