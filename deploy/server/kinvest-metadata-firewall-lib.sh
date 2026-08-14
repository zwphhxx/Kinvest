#!/bin/sh

KMF_METADATA_FIXED_IP=169.254.0.23
KMF_CHAIN=KINVEST-METADATA
KMF_GUARD_COMMENT=kinvest-metadata-docker-start-guard
KMF_NORMALIZATION_GUARD_COMMENT=kinvest-metadata-normalization-guard

kinvest_metadata_verify_bridge_netfilter() {
  [ -d "$KMF_BR_NETFILTER_MODULE_PATH" ] || {
    printf '%s\n' 'METADATA_BR_NETFILTER_MODULE_MISSING' >&2
    return 1
  }
  [ -f "$KMF_BRIDGE_NF_CALL_IPTABLES_PATH" ] && [ ! -L "$KMF_BRIDGE_NF_CALL_IPTABLES_PATH" ] || {
    printf '%s\n' 'METADATA_BR_NETFILTER_SYSCTL_MISSING' >&2
    return 1
  }

  kmf_bridge_nf_call_iptables=
  kmf_bridge_nf_call_iptables_extra=
  exec 7< "$KMF_BRIDGE_NF_CALL_IPTABLES_PATH" || {
    printf '%s\n' 'METADATA_BR_NETFILTER_SYSCTL_MISSING' >&2
    return 1
  }
  if ! IFS= read -r kmf_bridge_nf_call_iptables <&7; then
    exec 7<&-
    printf '%s\n' 'METADATA_BR_NETFILTER_SYSCTL_INVALID' >&2
    return 1
  fi
  if IFS= read -r kmf_bridge_nf_call_iptables_extra <&7 || [ -n "$kmf_bridge_nf_call_iptables_extra" ]; then
    exec 7<&-
    printf '%s\n' 'METADATA_BR_NETFILTER_SYSCTL_INVALID' >&2
    return 1
  fi
  exec 7<&-

  case "$kmf_bridge_nf_call_iptables" in
    1) return 0 ;;
    0)
      printf '%s\n' 'METADATA_BR_NETFILTER_SYSCTL_DISABLED' >&2
      return 1
      ;;
    *)
      printf '%s\n' 'METADATA_BR_NETFILTER_SYSCTL_INVALID' >&2
      return 1
      ;;
  esac
}

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

kinvest_metadata_validate_name() {
  kmf_name=$1
  [ -n "$kmf_name" ] || return 1
  case "$kmf_name" in
    *[!A-Za-z0-9_.-]*|[-_.]*) return 1 ;;
  esac
}

kinvest_metadata_validate_interface() {
  kmf_interface=$1
  kinvest_metadata_validate_name "$kmf_interface" || return 1
  kmf_interface_length=$(printf '%s' "$kmf_interface" | wc -c | tr -d ' ')
  [ "$kmf_interface_length" -le 15 ]
}

kinvest_metadata_validate_cidr() {
  kmf_cidr=$1
  case "$kmf_cidr" in
    */*) ;;
    *) return 1 ;;
  esac
  kmf_cidr_ip=${kmf_cidr%/*}
  kmf_cidr_prefix=${kmf_cidr#*/}
  kinvest_metadata_validate_ipv4 "$kmf_cidr_ip" || return 1
  case "$kmf_cidr_prefix" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$kmf_cidr_prefix" -ge 1 ] && [ "$kmf_cidr_prefix" -le 30 ]
}

kinvest_metadata_ipv4_in_cidr() {
  kmf_address=$1
  kmf_cidr=$2
  awk -v address="$kmf_address" -v cidr="$kmf_cidr" '
    function number(value, parts) {
      split(value, parts, ".")
      return (((parts[1] * 256) + parts[2]) * 256 + parts[3]) * 256 + parts[4]
    }
    BEGIN {
      split(cidr, fields, "/")
      block = 2 ^ (32 - fields[2])
      exit int(number(address) / block) == int(number(fields[1]) / block) ? 0 : 1
    }
  '
}

kinvest_metadata_load_config() {
  kmf_config_path=$1
  KMF_NETWORK=
  KMF_SUBNET=
  KMF_GATEWAY=
  KMF_CONTAINER_NAME=
  KMF_CONTAINER_IP=
  KMF_BRIDGE_INTERFACE=
  KMF_METADATA_IP=
  KMF_SUBNET_PREFIX=
  kmf_seen_keys=

  [ -f "$kmf_config_path" ] || {
    printf '%s\n' 'Metadata network config is unavailable' >&2
    return 1
  }

  while IFS='=' read -r kmf_key kmf_value; do
    case "$kmf_key" in
      ''|'#'*) continue ;;
      KINVEST_METADATA_NETWORK) KMF_NETWORK=$kmf_value ;;
      KINVEST_METADATA_SUBNET) KMF_SUBNET=$kmf_value ;;
      KINVEST_METADATA_GATEWAY) KMF_GATEWAY=$kmf_value ;;
      KINVEST_CONTAINER_NAME) KMF_CONTAINER_NAME=$kmf_value ;;
      KINVEST_CONTAINER_IP) KMF_CONTAINER_IP=$kmf_value ;;
      KINVEST_BRIDGE_INTERFACE) KMF_BRIDGE_INTERFACE=$kmf_value ;;
      KINVEST_METADATA_IP) KMF_METADATA_IP=$kmf_value ;;
      *)
        printf '%s\n' 'Metadata network config contains an unknown key' >&2
        return 1
        ;;
    esac
    case " $kmf_seen_keys " in
      *" $kmf_key "*)
        printf '%s\n' 'Metadata network config contains a duplicate key' >&2
        return 1
        ;;
    esac
    kmf_seen_keys="$kmf_seen_keys $kmf_key"
  done < "$kmf_config_path"

  kinvest_metadata_validate_name "$KMF_NETWORK" || return 1
  kinvest_metadata_validate_cidr "$KMF_SUBNET" || return 1
  KMF_SUBNET_PREFIX=${KMF_SUBNET#*/}
  kinvest_metadata_validate_ipv4 "$KMF_GATEWAY" || return 1
  [ "$KMF_CONTAINER_NAME" = kinvest ] || return 1
  kinvest_metadata_validate_ipv4 "$KMF_CONTAINER_IP" || return 1
  kinvest_metadata_validate_interface "$KMF_BRIDGE_INTERFACE" || return 1
  kinvest_metadata_validate_ipv4 "$KMF_METADATA_IP" || return 1
  [ "$KMF_METADATA_IP" = "$KMF_METADATA_FIXED_IP" ] || {
    printf '%s\n' 'Metadata address changed; refusing to broaden access' >&2
    return 1
  }
  [ "$KMF_CONTAINER_IP" != "$KMF_GATEWAY" ] || return 1
  [ "$KMF_CONTAINER_IP" != "$KMF_METADATA_IP" ] || return 1
  kinvest_metadata_ipv4_in_cidr "$KMF_GATEWAY" "$KMF_SUBNET" || return 1
  kinvest_metadata_ipv4_in_cidr "$KMF_CONTAINER_IP" "$KMF_SUBNET"
}

kinvest_metadata_iptables() {
  "$KMF_IPTABLES" -w 5 "$@"
}

kinvest_metadata_remove_all() {
  kmf_remove_chain=$1
  shift
  while :; do
    if kinvest_metadata_iptables -C "$kmf_remove_chain" "$@" >/dev/null 2>&1; then
      if ! kinvest_metadata_iptables -D "$kmf_remove_chain" "$@"; then
        printf '%s\n' "Metadata firewall could not delete a managed rule from $kmf_remove_chain" >&2
        return 1
      fi
    else
      kmf_remove_check_status=$?
      if [ "$kmf_remove_check_status" -ne 1 ]; then
        printf '%s\n' "Metadata firewall could not check a managed rule in $kmf_remove_chain" >&2
        return 1
      fi
      return 0
    fi
  done
}

kinvest_metadata_primary_guard_present() {
  kinvest_metadata_iptables -C FORWARD -d "$KMF_METADATA_FIXED_IP/32" -p tcp --dport 80 -m comment --comment "$KMF_GUARD_COMMENT" -j REJECT --reject-with tcp-reset >/dev/null 2>&1
}

kinvest_metadata_normalization_guard_present() {
  kinvest_metadata_iptables -C FORWARD -d "$KMF_METADATA_FIXED_IP/32" -p tcp --dport 80 -m comment --comment "$KMF_NORMALIZATION_GUARD_COMMENT" -j REJECT --reject-with tcp-reset >/dev/null 2>&1
}

kinvest_metadata_any_guard_present() {
  kinvest_metadata_primary_guard_present || kinvest_metadata_normalization_guard_present
}

kinvest_metadata_guard_failure() {
  kmf_guard_failure_reason=$1
  if kinvest_metadata_any_guard_present; then
    printf '%s\n' "Metadata guard operation failed ($kmf_guard_failure_reason); a deny guard remains confirmed" >&2
  else
    printf '%s\n' "Metadata guard operation failed ($kmf_guard_failure_reason); no deny guard can be confirmed" >&2
  fi
  return 1
}

kinvest_metadata_guard() {
  KMF_IPTABLES=$1
  kinvest_metadata_verify_bridge_netfilter || return 1
  kmf_guard_rules=$(kinvest_metadata_iptables -S FORWARD) || return 1
  kmf_guard_first_comment=$(printf '%s\n' "$kmf_guard_rules" | awk '$1 == "-A" { for (i = 1; i <= NF; i++) if ($i == "--comment") print $(i + 1); exit }')
  kmf_primary_count=$(printf '%s\n' "$kmf_guard_rules" | awk -v expected="$KMF_GUARD_COMMENT" '{ for (i = 1; i <= NF; i++) if ($i == "--comment" && $(i + 1) == expected) count++ } END { print count + 0 }')
  kmf_normalization_count=$(printf '%s\n' "$kmf_guard_rules" | awk -v expected="$KMF_NORMALIZATION_GUARD_COMMENT" '{ for (i = 1; i <= NF; i++) if ($i == "--comment" && $(i + 1) == expected) count++ } END { print count + 0 }')

  if kinvest_metadata_iptables -C FORWARD -d "$KMF_METADATA_FIXED_IP/32" -p tcp --dport 80 -m comment --comment "$KMF_GUARD_COMMENT" -j REJECT --reject-with tcp-reset >/dev/null 2>&1 &&
    [ "$kmf_guard_first_comment" = "$KMF_GUARD_COMMENT" ] &&
    [ "$kmf_primary_count" -eq 1 ] &&
    [ "$kmf_normalization_count" -eq 0 ]; then
    return 0
  fi

  if [ "$kmf_primary_count" -eq 0 ] && [ "$kmf_normalization_count" -eq 0 ]; then
    if ! kinvest_metadata_iptables -I FORWARD 1 -d "$KMF_METADATA_FIXED_IP/32" -p tcp --dport 80 -m comment --comment "$KMF_GUARD_COMMENT" -j REJECT --reject-with tcp-reset; then
      kinvest_metadata_guard_failure 'primary insertion'
      return 1
    fi
    if ! kinvest_metadata_primary_guard_present; then
      kinvest_metadata_guard_failure 'primary insertion verification'
      return 1
    fi
  else
    if ! kinvest_metadata_iptables -I FORWARD 1 -d "$KMF_METADATA_FIXED_IP/32" -p tcp --dport 80 -m comment --comment "$KMF_NORMALIZATION_GUARD_COMMENT" -j REJECT --reject-with tcp-reset; then
      kinvest_metadata_guard_failure 'normalization insertion'
      return 1
    fi
    if ! kinvest_metadata_normalization_guard_present; then
      kinvest_metadata_guard_failure 'normalization insertion verification'
      return 1
    fi
    if ! kinvest_metadata_remove_all FORWARD -d "$KMF_METADATA_FIXED_IP/32" -p tcp --dport 80 -m comment --comment "$KMF_GUARD_COMMENT" -j REJECT --reject-with tcp-reset; then
      kinvest_metadata_guard_failure 'old primary deletion'
      return 1
    fi
    if ! kinvest_metadata_iptables -I FORWARD 1 -d "$KMF_METADATA_FIXED_IP/32" -p tcp --dport 80 -m comment --comment "$KMF_GUARD_COMMENT" -j REJECT --reject-with tcp-reset; then
      kinvest_metadata_guard_failure 'new primary insertion'
      return 1
    fi
    if ! kinvest_metadata_primary_guard_present; then
      kinvest_metadata_guard_failure 'new primary insertion verification'
      return 1
    fi
    if ! kinvest_metadata_remove_all FORWARD -d "$KMF_METADATA_FIXED_IP/32" -p tcp --dport 80 -m comment --comment "$KMF_NORMALIZATION_GUARD_COMMENT" -j REJECT --reject-with tcp-reset; then
      kinvest_metadata_guard_failure 'normalization deletion'
      return 1
    fi
  fi

  kmf_guard_rules=$(kinvest_metadata_iptables -S FORWARD) || return 1
  kmf_guard_first_comment=$(printf '%s\n' "$kmf_guard_rules" | awk '$1 == "-A" { for (i = 1; i <= NF; i++) if ($i == "--comment") print $(i + 1); exit }')
  kmf_primary_count=$(printf '%s\n' "$kmf_guard_rules" | awk -v expected="$KMF_GUARD_COMMENT" '{ for (i = 1; i <= NF; i++) if ($i == "--comment" && $(i + 1) == expected) count++ } END { print count + 0 }')
  kmf_normalization_count=$(printf '%s\n' "$kmf_guard_rules" | awk -v expected="$KMF_NORMALIZATION_GUARD_COMMENT" '{ for (i = 1; i <= NF; i++) if ($i == "--comment" && $(i + 1) == expected) count++ } END { print count + 0 }')
  if kinvest_metadata_primary_guard_present &&
    [ "$kmf_guard_first_comment" = "$KMF_GUARD_COMMENT" ] &&
    [ "$kmf_primary_count" -eq 1 ] &&
    [ "$kmf_normalization_count" -eq 0 ]; then
    return 0
  fi
  kinvest_metadata_guard_failure 'final postcondition'
}

kinvest_metadata_validate_route() {
  kmf_route=$1
  kmf_route_destination=
  kmf_route_gateway=
  kmf_route_interface=
  kmf_route_source=
  kmf_route_gateway_count=0
  kmf_route_interface_count=0
  kmf_route_source_count=0
  set -- $kmf_route
  [ "$#" -ge 1 ] || return 1
  kmf_route_destination=$1
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      via)
        kmf_route_gateway_count=$((kmf_route_gateway_count + 1))
        shift; [ "$#" -gt 0 ] || return 1; kmf_route_gateway=$1
        ;;
      dev)
        kmf_route_interface_count=$((kmf_route_interface_count + 1))
        shift; [ "$#" -gt 0 ] || return 1; kmf_route_interface=$1
        ;;
      src)
        kmf_route_source_count=$((kmf_route_source_count + 1))
        shift; [ "$#" -gt 0 ] || return 1; kmf_route_source=$1
        ;;
    esac
    shift
  done
  [ "$kmf_route_gateway_count" -eq 1 ] &&
    [ "$kmf_route_interface_count" -eq 1 ] &&
    [ "$kmf_route_source_count" -eq 1 ] &&
    [ "$kmf_route_destination" = "$KMF_METADATA_IP" ] &&
    [ "$kmf_route_gateway" = "$KMF_GATEWAY" ] &&
    [ -n "$kmf_route_interface" ] &&
    [ "$kmf_route_source" = "$KMF_CONTAINER_IP" ]
}

kinvest_metadata_validate_network() {
  KMF_DOCKER=$1
  kmf_driver=$("$KMF_DOCKER" network inspect --format '{{.Driver}}' "$KMF_NETWORK") || return 1
  kmf_bridge=$("$KMF_DOCKER" network inspect --format '{{index .Options "com.docker.network.bridge.name"}}' "$KMF_NETWORK") || return 1
  kmf_member_count=$("$KMF_DOCKER" network inspect --format '{{len .Containers}}' "$KMF_NETWORK") || return 1
  kmf_ipam=$("$KMF_DOCKER" network inspect --format '{{range .IPAM.Config}}{{printf "%s|%s\n" .Subnet .Gateway}}{{end}}' "$KMF_NETWORK") || return 1
  kmf_members=$("$KMF_DOCKER" network inspect --format '{{range .Containers}}{{printf "%s|%s\n" .Name .IPv4Address}}{{end}}' "$KMF_NETWORK") || return 1

  [ "$kmf_driver" = bridge ] || return 1
  [ "$kmf_bridge" = "$KMF_BRIDGE_INTERFACE" ] || return 1
  [ "$kmf_member_count" = 1 ] || return 1
  [ "$kmf_ipam" = "$KMF_SUBNET|$KMF_GATEWAY" ] || return 1
  [ "$kmf_members" = "$KMF_CONTAINER_NAME|$KMF_CONTAINER_IP/$KMF_SUBNET_PREFIX" ] || return 1

  kmf_route=$("$KMF_DOCKER" exec "$KMF_CONTAINER_NAME" ip -4 route get "$KMF_METADATA_IP") || return 1
  kinvest_metadata_validate_route "$kmf_route" || {
    printf '%s\n' 'Metadata route does not use the dedicated network source' >&2
    return 1
  }
}

kinvest_metadata_verify_managed_chain() {
  kinvest_metadata_iptables -C "$KMF_CHAIN" -i "$KMF_BRIDGE_INTERFACE" -s "$KMF_CONTAINER_IP/32" -d "$KMF_METADATA_IP/32" -p tcp --dport 80 -m comment --comment kinvest-metadata-app-allow -j ACCEPT || return 1
  kinvest_metadata_iptables -C "$KMF_CHAIN" -d "$KMF_METADATA_IP/32" -p tcp --dport 80 -m comment --comment kinvest-metadata-default-deny -j REJECT --reject-with tcp-reset || return 1
  kinvest_metadata_iptables -C "$KMF_CHAIN" -j RETURN || return 1
  kmf_chain_rules=$(kinvest_metadata_iptables -S "$KMF_CHAIN") || return 1
  kmf_chain_signature=$(printf '%s\n' "$kmf_chain_rules" | awk '
    $1 == "-A" {
      comment=""
      target=""
      for (i = 1; i <= NF; i++) {
        if ($i == "--comment") comment=$(i + 1)
        if ($i == "-j") target=$(i + 1)
      }
      print comment "|" target
    }
  ')
  [ "$kmf_chain_signature" = "$(printf '%s\n' 'kinvest-metadata-app-allow|ACCEPT' 'kinvest-metadata-default-deny|REJECT' '|RETURN')" ]
}

kinvest_metadata_verify_deny_all_managed_chain() {
  kinvest_metadata_iptables -C "$KMF_CHAIN" -d "$KMF_METADATA_IP/32" -p tcp --dport 80 -m comment --comment kinvest-metadata-default-deny -j REJECT --reject-with tcp-reset || return 1
  kinvest_metadata_iptables -C "$KMF_CHAIN" -j RETURN || return 1
  kmf_chain_rules=$(kinvest_metadata_iptables -S "$KMF_CHAIN") || return 1
  kmf_chain_signature=$(printf '%s\n' "$kmf_chain_rules" | awk '
    $1 == "-A" {
      comment=""
      target=""
      for (i = 1; i <= NF; i++) {
        if ($i == "--comment") comment=$(i + 1)
        if ($i == "-j") target=$(i + 1)
      }
      print comment "|" target
    }
  ')
  [ "$kmf_chain_signature" = "$(printf '%s\n' 'kinvest-metadata-default-deny|REJECT' '|RETURN')" ]
}

kinvest_metadata_verify_rules() {
  kmf_mode=$1
  kmf_chain_mode=${2:-allow}
  case "$kmf_chain_mode" in
    allow) kinvest_metadata_verify_managed_chain || return 1 ;;
    deny-all) kinvest_metadata_verify_deny_all_managed_chain || return 1 ;;
    *) return 1 ;;
  esac

  kmf_forward_rules=$(kinvest_metadata_iptables -S FORWARD) || return 1
  kmf_docker_rules=$(kinvest_metadata_iptables -S DOCKER-USER) || return 1
  kmf_forward_jump_count=$(printf '%s\n' "$kmf_forward_rules" | awk '$0 == "-A FORWARD -j KINVEST-METADATA" { count++ } END { print count + 0 }')
  kmf_docker_jump_count=$(printf '%s\n' "$kmf_docker_rules" | awk '$0 == "-A DOCKER-USER -j KINVEST-METADATA" { count++ } END { print count + 0 }')
  kmf_guard_count=$(printf '%s\n' "$kmf_forward_rules" | awk '/--comment kinvest-metadata-docker-start-guard/ { count++ } END { print count + 0 }')
  kmf_normalization_guard_count=$(printf '%s\n' "$kmf_forward_rules" | awk '/--comment kinvest-metadata-normalization-guard/ { count++ } END { print count + 0 }')
  kmf_forward_first=$(printf '%s\n' "$kmf_forward_rules" | awk '$1 == "-A" { print; exit }')
  kmf_forward_second=$(printf '%s\n' "$kmf_forward_rules" | awk '$1 == "-A" { count++; if (count == 2) { print; exit } }')
  kmf_docker_first=$(printf '%s\n' "$kmf_docker_rules" | awk '$1 == "-A" { print; exit }')

  [ "$kmf_forward_jump_count" -eq 1 ] &&
    [ "$kmf_docker_jump_count" -eq 1 ] &&
    [ "$kmf_normalization_guard_count" -eq 0 ] &&
    [ "$kmf_docker_first" = '-A DOCKER-USER -j KINVEST-METADATA' ] || return 1

  case "$kmf_mode" in
    staging)
      [ "$kmf_guard_count" -eq 1 ] &&
        printf '%s\n' "$kmf_forward_first" | grep -F -- "--comment $KMF_GUARD_COMMENT" >/dev/null &&
        [ "$kmf_forward_second" = '-A FORWARD -j KINVEST-METADATA' ]
      ;;
    final)
      [ "$kmf_guard_count" -eq 0 ] &&
        [ "$kmf_forward_first" = '-A FORWARD -j KINVEST-METADATA' ]
      ;;
    *) return 1 ;;
  esac
}

kinvest_metadata_restore_jumps() {
  {
    printf '%s\n' '*filter'
    printf '%s\n' "-I FORWARD 2 -j $KMF_CHAIN"
    printf '%s\n' "-I DOCKER-USER 1 -j $KMF_CHAIN"
    printf '%s\n' 'COMMIT'
  } | "$KMF_IPTABLES_RESTORE" -w 5 --noflush
}

kinvest_metadata_apply() {
  KMF_IPTABLES=$1
  KMF_IPTABLES_RESTORE=$2
  KMF_DOCKER=$3
  kmf_config_path=$4

  kinvest_metadata_guard "$KMF_IPTABLES" || return 1
  kinvest_metadata_load_config "$kmf_config_path" || return 1
  kinvest_metadata_validate_network "$KMF_DOCKER" || return 1
  kinvest_metadata_iptables -S DOCKER-USER >/dev/null || return 1
  if ! kinvest_metadata_iptables -S "$KMF_CHAIN" >/dev/null 2>&1; then
    kinvest_metadata_iptables -N "$KMF_CHAIN" || return 1
  fi
  kinvest_metadata_iptables -F "$KMF_CHAIN" || return 1
  kinvest_metadata_iptables -A "$KMF_CHAIN" -i "$KMF_BRIDGE_INTERFACE" -s "$KMF_CONTAINER_IP/32" -d "$KMF_METADATA_IP/32" -p tcp --dport 80 -m comment --comment kinvest-metadata-app-allow -j ACCEPT || return 1
  kinvest_metadata_iptables -A "$KMF_CHAIN" -d "$KMF_METADATA_IP/32" -p tcp --dport 80 -m comment --comment kinvest-metadata-default-deny -j REJECT --reject-with tcp-reset || return 1
  kinvest_metadata_iptables -A "$KMF_CHAIN" -j RETURN || return 1
  kinvest_metadata_verify_managed_chain || return 1

  kinvest_metadata_remove_all FORWARD -j "$KMF_CHAIN" || return 1
  kinvest_metadata_remove_all DOCKER-USER -j "$KMF_CHAIN" || return 1
  kinvest_metadata_restore_jumps || return 1
  kinvest_metadata_verify_rules staging || return 1
  kinvest_metadata_remove_all FORWARD -d "$KMF_METADATA_FIXED_IP/32" -p tcp --dport 80 -m comment --comment "$KMF_GUARD_COMMENT" -j REJECT --reject-with tcp-reset || return 1
  if ! kinvest_metadata_verify_rules final; then
    kinvest_metadata_guard "$KMF_IPTABLES"
    return 1
  fi
}

kinvest_metadata_status() {
  KMF_IPTABLES=$1
  KMF_DOCKER=$2
  kmf_config_path=$3
  kinvest_metadata_load_config "$kmf_config_path" || return 1
  kinvest_metadata_validate_network "$KMF_DOCKER" || return 1
  kinvest_metadata_verify_rules final
}

kinvest_metadata_validate_config() {
  kinvest_metadata_load_config "$1"
}

kinvest_metadata_reconcile() {
  local iptables_command="$1"
  local iptables_restore_command="$2"
  local docker_command="$3"
  local config_path="$4"

  kinvest_metadata_guard "$iptables_command" || return 1
  if ! kinvest_metadata_apply "$iptables_command" "$iptables_restore_command" "$docker_command" "$config_path"; then
    kinvest_metadata_guard "$iptables_command" || return 1
    return 1
  fi
  if ! kinvest_metadata_status "$iptables_command" "$docker_command" "$config_path"; then
    kinvest_metadata_guard "$iptables_command" || return 1
    return 1
  fi
}

kinvest_metadata_apply_deny_all() {
  KMF_IPTABLES=$1
  KMF_IPTABLES_RESTORE=$2
  kmf_config_path=$3

  kinvest_metadata_guard "$KMF_IPTABLES" || return 1
  kinvest_metadata_load_config "$kmf_config_path" || return 1
  kinvest_metadata_iptables -S DOCKER-USER >/dev/null || return 1
  if ! kinvest_metadata_iptables -S "$KMF_CHAIN" >/dev/null 2>&1; then
    kinvest_metadata_iptables -N "$KMF_CHAIN" || return 1
  fi
  kinvest_metadata_iptables -F "$KMF_CHAIN" || return 1
  kinvest_metadata_iptables -A "$KMF_CHAIN" -d "$KMF_METADATA_IP/32" -p tcp --dport 80 -m comment --comment kinvest-metadata-default-deny -j REJECT --reject-with tcp-reset || return 1
  kinvest_metadata_iptables -A "$KMF_CHAIN" -j RETURN || return 1
  kinvest_metadata_verify_deny_all_managed_chain || return 1

  kinvest_metadata_remove_all FORWARD -j "$KMF_CHAIN" || return 1
  kinvest_metadata_remove_all DOCKER-USER -j "$KMF_CHAIN" || return 1
  kinvest_metadata_restore_jumps || return 1
  kinvest_metadata_verify_rules staging deny-all || return 1
  kinvest_metadata_remove_all FORWARD -d "$KMF_METADATA_FIXED_IP/32" -p tcp --dport 80 -m comment --comment "$KMF_GUARD_COMMENT" -j REJECT --reject-with tcp-reset || return 1
  if ! kinvest_metadata_verify_rules final deny-all; then
    kinvest_metadata_guard "$KMF_IPTABLES"
    return 1
  fi
}

kinvest_metadata_status_deny_all() {
  KMF_IPTABLES=$1
  kmf_config_path=$2
  kinvest_metadata_load_config "$kmf_config_path" || return 1
  kinvest_metadata_verify_rules final deny-all
}

kinvest_metadata_reconcile_deny_all() {
  local iptables_command="$1"
  local iptables_restore_command="$2"
  local config_path="$3"

  kinvest_metadata_guard "$iptables_command" || return 1
  if ! kinvest_metadata_apply_deny_all "$iptables_command" "$iptables_restore_command" "$config_path"; then
    kinvest_metadata_guard "$iptables_command" || return 1
    return 1
  fi
  if ! kinvest_metadata_status_deny_all "$iptables_command" "$config_path"; then
    kinvest_metadata_guard "$iptables_command" || return 1
    return 1
  fi
}

kinvest_metadata_cleanup_permanent() {
  if kinvest_metadata_iptables -S FORWARD >/dev/null 2>&1; then
    kinvest_metadata_remove_all FORWARD -j "$KMF_CHAIN"
  fi
  if kinvest_metadata_iptables -S DOCKER-USER >/dev/null 2>&1; then
    kinvest_metadata_remove_all DOCKER-USER -j "$KMF_CHAIN"
  fi
  if kinvest_metadata_iptables -S "$KMF_CHAIN" >/dev/null 2>&1; then
    kinvest_metadata_iptables -F "$KMF_CHAIN"
    kinvest_metadata_iptables -X "$KMF_CHAIN"
  fi
}

kinvest_metadata_rollback() {
  KMF_IPTABLES=$1
  kinvest_metadata_guard "$KMF_IPTABLES"
  kinvest_metadata_cleanup_permanent
}

kinvest_metadata_rollback_pre_bind() {
  KMF_IPTABLES=$1
  kmf_role_assertion=$2
  kinvest_metadata_guard "$KMF_IPTABLES"
  [ "$kmf_role_assertion" = '--assert-role-unbound' ] || {
    printf '%s\n' 'Pre-bind rollback requires the explicit unbound-role operator assertion' >&2
    return 1
  }
  kinvest_metadata_cleanup_permanent
  kinvest_metadata_remove_all FORWARD -d "$KMF_METADATA_FIXED_IP/32" -p tcp --dport 80 -m comment --comment "$KMF_GUARD_COMMENT" -j REJECT --reject-with tcp-reset
}
