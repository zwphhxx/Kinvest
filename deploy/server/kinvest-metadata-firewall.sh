#!/bin/sh
set -eu

PATH=/usr/sbin:/usr/bin:/sbin:/bin
KMF_LIBRARY=/usr/local/libexec/kinvest-metadata-firewall-lib.sh
KMF_CONFIG=/etc/kinvest/metadata-firewall.conf
KMF_LOCK=/run/lock/kinvest-metadata-firewall.lock
KMF_IPTABLES=/usr/sbin/iptables

kinvest_assert_secure_file() {
  kmf_secure_path=$1
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
  kmf_group_digit=$(printf '%s\n' "$kmf_mode" | rev | cut -c2)
  kmf_other_digit=$(printf '%s\n' "$kmf_mode" | rev | cut -c1)
  case "$kmf_group_digit$kmf_other_digit" in
    *2*|*3*|*6*|*7*)
      printf '%s\n' 'Metadata firewall dependency is writable outside root' >&2
      exit 1
      ;;
  esac
}

[ "$#" -eq 1 ] || {
  printf '%s\n' 'Usage: kinvest-metadata-firewall guard|apply|status|rollback' >&2
  exit 2
}
kmf_action=$1
case "$kmf_action" in
  guard|apply|status|rollback) ;;
  *) exit 2 ;;
esac

kinvest_assert_secure_file "$KMF_LIBRARY"
if [ "$kmf_action" = apply ] || [ "$kmf_action" = status ]; then
  kinvest_assert_secure_file "$KMF_CONFIG"
fi
[ -x "$KMF_IPTABLES" ] && [ -x /usr/bin/flock ] || exit 1

exec 9>"$KMF_LOCK"
/usr/bin/flock -x 9
. "$KMF_LIBRARY"

case "$kmf_action" in
  guard) kinvest_metadata_guard "$KMF_IPTABLES" ;;
  apply) kinvest_metadata_apply "$KMF_IPTABLES" "$KMF_CONFIG" ;;
  status) kinvest_metadata_status "$KMF_IPTABLES" "$KMF_CONFIG" ;;
  rollback) kinvest_metadata_rollback "$KMF_IPTABLES" ;;
esac
