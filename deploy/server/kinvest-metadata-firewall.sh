#!/bin/sh
set -eu

PATH=/usr/sbin:/usr/bin:/sbin:/bin
KMF_LIBRARY=/usr/local/libexec/kinvest-metadata-firewall-lib.sh
KMF_CONFIG=${KMF_CONFIG:-/etc/kinvest/metadata-network.conf}
KMF_LOCK=/run/lock/kinvest-metadata-firewall.lock
KMF_IPTABLES=/usr/sbin/iptables
KMF_IPTABLES_RESTORE=/usr/sbin/iptables-restore
KMF_DOCKER=/usr/bin/docker

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
    printf '%s\n' 'Metadata network config must be root:root mode 0600' >&2
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

kmf_usage='Usage: kinvest-metadata-firewall validate-config|guard|apply|status|reconcile|rollback|rollback-pre-bind --assert-role-unbound'
case "$#:$1" in
  1:validate-config|1:guard|1:apply|1:status|1:reconcile|1:rollback) ;;
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
if [ "$kmf_action" = validate-config ] || [ "$kmf_action" = apply ] || [ "$kmf_action" = status ] || [ "$kmf_action" = reconcile ]; then
  kinvest_assert_secure_file "$KMF_CONFIG" 600
fi
[ -x /usr/bin/flock ] || exit 1
if [ "$kmf_action" != validate-config ]; then
  [ -x "$KMF_IPTABLES" ] || exit 1
fi
if [ "$kmf_action" = apply ] || [ "$kmf_action" = reconcile ]; then
  [ -x "$KMF_IPTABLES_RESTORE" ] || exit 1
fi
if [ "$kmf_action" = apply ] || [ "$kmf_action" = status ] || [ "$kmf_action" = reconcile ]; then
  [ -x "$KMF_DOCKER" ] || exit 1
fi

exec 9>"$KMF_LOCK"
/usr/bin/flock -x 9
. "$KMF_LIBRARY"

case "$kmf_action" in
  validate-config) kinvest_metadata_validate_config "$KMF_CONFIG" ;;
  guard) kinvest_metadata_guard "$KMF_IPTABLES" ;;
  apply) kinvest_metadata_apply "$KMF_IPTABLES" "$KMF_IPTABLES_RESTORE" "$KMF_DOCKER" "$KMF_CONFIG" ;;
  status) kinvest_metadata_status "$KMF_IPTABLES" "$KMF_DOCKER" "$KMF_CONFIG" ;;
  reconcile) kinvest_metadata_reconcile "$KMF_IPTABLES" "$KMF_IPTABLES_RESTORE" "$KMF_DOCKER" "$KMF_CONFIG" ;;
  rollback) kinvest_metadata_rollback "$KMF_IPTABLES" ;;
  rollback-pre-bind) kinvest_metadata_rollback_pre_bind "$KMF_IPTABLES" "$2" ;;
esac
