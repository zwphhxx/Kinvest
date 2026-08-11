#!/bin/sh

KMF_METADATA_FIXED_IP=169.254.0.23
KMF_CHAIN=KINVEST-METADATA
KMF_GUARD_COMMENT=kinvest-metadata-docker-start-guard

kinvest_metadata_validate_ipv4() {
  kmf_value=$1
  kmf_old_ifs=$IFS
  IFS=.
  set -- $kmf_value
  IFS=$kmf_old_ifs
  [ "$#" -eq 4 ] || return 1
  for kmf_octet in "$@"; do
    case "$kmf_octet" in
      ''|*[!0-9]*) return 1 ;;
    esac
    [ "$kmf_octet" -ge 0 ] 2>/dev/null &&
      [ "$kmf_octet" -le 255 ] || return 1
  done
}

kinvest_metadata_validate_interface() {
  kmf_interface=$1
  [ -n "$kmf_interface" ] || return 1
  kmf_interface_length=$(printf '%s' "$kmf_interface" | wc -c | tr -d ' ')
  [ "$kmf_interface_length" -le 15 ] || return 1
  case "$kmf_interface" in
    *[!A-Za-z0-9_.:-]*) return 1 ;;
  esac
}

kinvest_metadata_load_config() {
  kmf_config_path=$1
  KMF_CONTAINER_IP=
  KMF_BRIDGE_INTERFACE=
  KMF_METADATA_IP=
  [ -f "$kmf_config_path" ] || {
    printf '%s\n' 'Metadata firewall config is unavailable' >&2
    return 1
  }
  while IFS='=' read -r kmf_key kmf_value; do
    case "$kmf_key" in
      ''|'#'*) continue ;;
      KINVEST_CONTAINER_IP) KMF_CONTAINER_IP=$kmf_value ;;
      KINVEST_BRIDGE_INTERFACE) KMF_BRIDGE_INTERFACE=$kmf_value ;;
      KINVEST_METADATA_IP) KMF_METADATA_IP=$kmf_value ;;
      *)
        printf '%s\n' 'Metadata firewall config contains an unknown key' >&2
        return 1
        ;;
    esac
  done < "$kmf_config_path"
  kinvest_metadata_validate_ipv4 "$KMF_CONTAINER_IP" || return 1
  kinvest_metadata_validate_interface "$KMF_BRIDGE_INTERFACE" || return 1
  kinvest_metadata_validate_ipv4 "$KMF_METADATA_IP" || return 1
  [ "$KMF_METADATA_IP" = "$KMF_METADATA_FIXED_IP" ] || {
    printf '%s\n' 'Metadata address changed; refusing to broaden access' >&2
    return 1
  }
  [ "$KMF_CONTAINER_IP" != "$KMF_METADATA_IP" ] || return 1
}

kinvest_metadata_iptables() {
  "$KMF_IPTABLES" -w 5 "$@"
}

kinvest_metadata_remove_all() {
  kmf_remove_chain=$1
  shift
  while kinvest_metadata_iptables -C "$kmf_remove_chain" "$@" >/dev/null 2>&1; do
    kinvest_metadata_iptables -D "$kmf_remove_chain" "$@"
  done
}

kinvest_metadata_guard() {
  KMF_IPTABLES=$1
  kinvest_metadata_remove_all FORWARD -d "$KMF_METADATA_FIXED_IP/32" -p tcp --dport 80 -m comment --comment "$KMF_GUARD_COMMENT" -j REJECT --reject-with tcp-reset
  kinvest_metadata_iptables -I FORWARD 1 -d "$KMF_METADATA_FIXED_IP/32" -p tcp --dport 80 -m comment --comment "$KMF_GUARD_COMMENT" -j REJECT --reject-with tcp-reset
}

kinvest_metadata_status_rules() {
  KMF_IPTABLES=$1
  kmf_config_path=$2
  kinvest_metadata_load_config "$kmf_config_path"
  kinvest_metadata_iptables -C DOCKER-USER -j "$KMF_CHAIN"
  kinvest_metadata_iptables -C "$KMF_CHAIN" -i "$KMF_BRIDGE_INTERFACE" -s "$KMF_CONTAINER_IP/32" -d "$KMF_METADATA_IP/32" -p tcp --dport 80 -m comment --comment kinvest-metadata-app-allow -j ACCEPT
  kinvest_metadata_iptables -C "$KMF_CHAIN" -d "$KMF_METADATA_IP/32" -p tcp --dport 80 -m comment --comment kinvest-metadata-default-deny -j REJECT --reject-with tcp-reset
  kinvest_metadata_iptables -C "$KMF_CHAIN" -j RETURN

  kmf_docker_rules=$(kinvest_metadata_iptables -S DOCKER-USER)
  kmf_first_jump=$(printf '%s\n' "$kmf_docker_rules" | awk '$1 == "-A" { print; exit }')
  kmf_jump_count=$(printf '%s\n' "$kmf_docker_rules" | awk '$0 == "-A DOCKER-USER -j KINVEST-METADATA" { count++ } END { print count + 0 }')
  [ "$kmf_first_jump" = '-A DOCKER-USER -j KINVEST-METADATA' ]
  [ "$kmf_jump_count" -eq 1 ]

  kmf_targets=$(kinvest_metadata_iptables -S "$KMF_CHAIN" | awk '$1 == "-A" { for (i = 1; i <= NF; i++) if ($i == "-j") print $(i + 1) }')
  [ "$kmf_targets" = "$(printf 'ACCEPT\nREJECT\nRETURN')" ]
}

kinvest_metadata_apply() {
  KMF_IPTABLES=$1
  kmf_config_path=$2
  kinvest_metadata_guard "$KMF_IPTABLES"
  kinvest_metadata_load_config "$kmf_config_path"
  kinvest_metadata_iptables -S DOCKER-USER >/dev/null
  if ! kinvest_metadata_iptables -S "$KMF_CHAIN" >/dev/null 2>&1; then
    kinvest_metadata_iptables -N "$KMF_CHAIN"
  fi
  kinvest_metadata_iptables -F "$KMF_CHAIN"
  kinvest_metadata_iptables -A "$KMF_CHAIN" -i "$KMF_BRIDGE_INTERFACE" -s "$KMF_CONTAINER_IP/32" -d "$KMF_METADATA_IP/32" -p tcp --dport 80 -m comment --comment kinvest-metadata-app-allow -j ACCEPT
  kinvest_metadata_iptables -A "$KMF_CHAIN" -d "$KMF_METADATA_IP/32" -p tcp --dport 80 -m comment --comment kinvest-metadata-default-deny -j REJECT --reject-with tcp-reset
  kinvest_metadata_iptables -A "$KMF_CHAIN" -j RETURN
  kinvest_metadata_remove_all DOCKER-USER -j "$KMF_CHAIN"
  kinvest_metadata_iptables -I DOCKER-USER 1 -j "$KMF_CHAIN"
  kinvest_metadata_status_rules "$KMF_IPTABLES" "$kmf_config_path"
  kinvest_metadata_remove_all FORWARD -d "$KMF_METADATA_FIXED_IP/32" -p tcp --dport 80 -m comment --comment "$KMF_GUARD_COMMENT" -j REJECT --reject-with tcp-reset
}

kinvest_metadata_status() {
  KMF_IPTABLES=$1
  kmf_config_path=$2
  kinvest_metadata_status_rules "$KMF_IPTABLES" "$kmf_config_path"
  if kinvest_metadata_iptables -C FORWARD -d "$KMF_METADATA_FIXED_IP/32" -p tcp --dport 80 -m comment --comment "$KMF_GUARD_COMMENT" -j REJECT --reject-with tcp-reset >/dev/null 2>&1; then
    printf '%s\n' 'Metadata startup guard is still active' >&2
    return 1
  fi
}

kinvest_metadata_rollback() {
  KMF_IPTABLES=$1
  kinvest_metadata_guard "$KMF_IPTABLES"
  if kinvest_metadata_iptables -S DOCKER-USER >/dev/null 2>&1; then
    kinvest_metadata_remove_all DOCKER-USER -j "$KMF_CHAIN"
  fi
  if kinvest_metadata_iptables -S "$KMF_CHAIN" >/dev/null 2>&1; then
    kinvest_metadata_iptables -F "$KMF_CHAIN"
    kinvest_metadata_iptables -X "$KMF_CHAIN"
  fi
}
