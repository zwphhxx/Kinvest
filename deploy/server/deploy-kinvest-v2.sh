#!/usr/bin/env bash
set -euo pipefail

ROOT='/root/docker/kinvest'
RUN_ROOT='/run'
COMPOSE="$ROOT/docker-compose.yml"
METADATA_NETWORK_CONFIG='/etc/kinvest/metadata-network.conf'
METADATA_FIREWALL='/usr/local/sbin/kinvest-metadata-firewall'
SECRET_VERSION_VALIDATOR='/usr/local/libexec/kinvest-secret-version-config'
OFFLINE_IMAGE_ATTESTATION='/usr/local/libexec/kinvest-offline-image-attestation'
DATA_DIR="$ROOT/data"
DATABASE="$DATA_DIR/kinvest.sqlite"
STATE="$ROOT/state"
METADATA_ACTIVATION_STATE="$STATE/metadata-network.state"
BACKUP_DIR="$ROOT/backups"
CURRENT_STATE="$STATE/current.state"
PREVIOUS_STATE="$STATE/previous.state"
ATTEMPT_STATE="$STATE/attempt.state"
TCR_POLICY_FILE="$ROOT/policy/tcr-basic.enabled"
PUBLIC_HEALTH_URL='https://dearmina.cn/api/health'
GHCR_REPOSITORY='ghcr.io/zwphhxx/kinvest'
TCR_REPOSITORY='ccr.ccs.tencentyun.com/website-dev/kinvest'
ALLOWED_STATE_DIGEST_PATTERN='^(ghcr\.io/zwphhxx/kinvest|ccr\.ccs\.tencentyun\.com/website-dev/kinvest)@sha256:[0-9a-f]{64}$'
PULL_ATTEMPTS='3'
PULL_TIMEOUT='300s'
PULL_RETRY_BASE_WAIT_SECONDS='2'
DOCKER_TIMEOUT='120s'
COMPOSE_TIMEOUT='120s'
INSPECT_TIMEOUT='15s'
DOCKER_KILL_AFTER='10s'
INSPECT_KILL_AFTER='5s'
HEALTH_TIMEOUT_SECONDS='120'
HEALTH_INTERVAL='2'

if [[ "$#" -ne 0 ]]; then
  printf '%s\n' 'deployment accepts no command-line arguments' >&2
  exit 2
fi

protocol_magic=''
digest_ref=''
commit_sha=''
registry_mode=''
registry_host=''
registry_username=''
registry_password=''
release_record_schema_version=''
verification_run_id=''
artifact_source=''
secret_version_ids=''
deployment_intent='forward'
payload_end=''
extra_input=''

read_payload_line() {
  local variable_name="$1"
  local value=''

  if ! IFS= read -r value; then
    printf '%s\n' 'deployment requires a complete deploy-v2 payload' >&2
    exit 2
  fi
  printf -v "$variable_name" '%s' "$value"
}

for payload_variable in \
  protocol_magic \
  digest_ref \
  commit_sha \
  registry_mode \
  registry_host \
  registry_username \
  registry_password \
  release_record_schema_version \
  verification_run_id \
  artifact_source \
  secret_version_ids \
  payload_end; do
  read_payload_line "$payload_variable"
done

if IFS= read -r extra_input; then
  printf '%s\n' 'deployment payload contains unexpected trailing input' >&2
  exit 2
fi

if [[ "$protocol_magic" != 'KINVEST_DEPLOY_V2' || "$payload_end" != 'EOF' ]]; then
  printf '%s\n' 'deployment payload has an invalid protocol envelope' >&2
  exit 2
fi

if [[ ! "$digest_ref" =~ $ALLOWED_STATE_DIGEST_PATTERN ]]; then
  printf '%s\n' 'deployment requires an allowed immutable Kinvest digest reference' >&2
  exit 2
fi

if [[ ! "$commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s\n' 'deployment requires a 40-character lowercase audit commit SHA' >&2
  exit 2
fi

if [[ ! "$release_record_schema_version" =~ ^[12]$ || ! "$verification_run_id" =~ ^[0-9]+$ ]]; then
  printf '%s\n' 'deployment requires valid release record provenance' >&2
  exit 2
fi

if [[ "$secret_version_ids" == '{"rollback":"previous"}' ]]; then
  deployment_intent='rollback'
fi

case "$registry_mode" in
  ghcr-public)
    if [[ "${digest_ref%@*}" != "$GHCR_REPOSITORY" ||
      "$registry_host" != 'ghcr.io' ||
      -n "$registry_username" ||
      -n "$registry_password" ||
      "$artifact_source" != 'ghcr-public' ||
      "$release_record_schema_version" != '2' ]]; then
      printf '%s\n' 'public GHCR deployment metadata is inconsistent' >&2
      exit 2
    fi
    ;;
  tcr-basic)
    if [[ "${digest_ref%@*}" != "$TCR_REPOSITORY" ||
      "$registry_host" != 'ccr.ccs.tencentyun.com' ||
      ! "$registry_username" =~ ^[A-Za-z0-9._@-]{1,128}$ ||
      -z "$registry_password" ||
      "$registry_password" == *$'\r'* ||
      "$artifact_source" != 'tcr-private' ]]; then
      printf '%s\n' 'private TCR deployment metadata is inconsistent' >&2
      exit 2
    fi
    ;;
  *)
    printf '%s\n' 'deployment registry mode is not allowed' >&2
    exit 2
    ;;
esac

if [[ "$(id -u)" -ne 0 ]]; then
  printf '%s\n' 'deployment must run as root' >&2
  exit 1
fi

assert_not_symlink() {
  local candidate="$1"

  if [[ -L "$candidate" ]]; then
    printf '%s\n' "refusing symlinked Kinvest path: $candidate" >&2
    exit 1
  fi
}

metadata_network_name=''
assert_metadata_network_config() {
  local metadata_config_path="${1:-$METADATA_NETWORK_CONFIG}"
  local metadata_stat=''
  local metadata_key=''
  local metadata_value=''
  local metadata_network_count=0

  if [[ ! -f "$metadata_config_path" || -L "$metadata_config_path" ]]; then
    printf '%s\n' 'metadata network config is missing or symlinked' >&2
    exit 1
  fi
  metadata_stat="$(stat -Lc '%u:%g:%a' "$metadata_config_path")" || exit 1
  if [[ "$metadata_stat" != '0:0:600' ]]; then
    printf '%s\n' 'metadata network config must be root-owned mode 0600' >&2
    exit 1
  fi
  while IFS='=' read -r metadata_key metadata_value; do
    if [[ "$metadata_key" == 'KINVEST_METADATA_NETWORK' ]]; then
      metadata_network_name="$metadata_value"
      metadata_network_count=$((metadata_network_count + 1))
    fi
  done < "$metadata_config_path"
  if [[ "$metadata_network_count" -ne 1 || ! "$metadata_network_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
    printf '%s\n' 'metadata network config has an invalid network name' >&2
    exit 1
  fi
}

metadata_network_phase=''
metadata_config_sha256=''
read_metadata_network_phase() {
  local metadata_state_stat=''
  local metadata_state_line=''
  local metadata_state_line_count=0
  local metadata_state_version=''
  local metadata_state_mode=''
  local metadata_state_hash=''

  assert_not_symlink "$METADATA_ACTIVATION_STATE"
  if [[ ! -f "$METADATA_ACTIVATION_STATE" ]]; then
    printf '%s\n' 'metadata network activation state is missing; explicit pending approval is required for first migration' >&2
    exit 1
  fi
  metadata_state_stat="$(stat -Lc '%u:%g:%a' "$METADATA_ACTIVATION_STATE")" || exit 1
  if [[ "$metadata_state_stat" != '0:0:600' ]]; then
    printf '%s\n' 'metadata network activation state must be root-owned mode 0600' >&2
    exit 1
  fi
  while IFS= read -r metadata_state_line || [[ -n "$metadata_state_line" ]]; do
    metadata_state_line_count=$((metadata_state_line_count + 1))
    case "$metadata_state_line_count" in
      1) metadata_state_version="$metadata_state_line" ;;
      2) metadata_state_mode="$metadata_state_line" ;;
      3) metadata_state_hash="$metadata_state_line" ;;
    esac
  done < "$METADATA_ACTIVATION_STATE"
  if [[ "$metadata_state_line_count" -ne 3 ||
    "$metadata_state_version" != 'version=1' ||
    ! "$metadata_state_mode" =~ ^mode=(pending|active)$ ||
    ! "$metadata_state_hash" =~ ^config_sha256=([0-9a-f]{64})$ ]]; then
    printf '%s\n' 'metadata network activation state is invalid' >&2
    exit 1
  fi
  metadata_network_phase="${metadata_state_mode#mode=}"
  metadata_config_sha256="${metadata_state_hash#config_sha256=}"
}

atomic_write_metadata_activation_state() {
  local phase="$1"
  local temporary=''

  [[ "$phase" == 'pending' || "$phase" == 'active' ]] || return 1
  temporary="$(mktemp "$STATE/.metadata-network-state.XXXXXX")"
  printf 'version=1\nmode=%s\nconfig_sha256=%s\n' "$phase" "$metadata_config_sha256" > "$temporary"
  chmod 0600 "$temporary"
  chown root:root "$temporary"
  mv -f -- "$temporary" "$METADATA_ACTIVATION_STATE"
}

ROOT_PARENT="${ROOT%/kinvest}"
ROOT_TOP="${ROOT_PARENT%/docker}"
for path_component in "$ROOT_TOP" "$ROOT_PARENT" "$ROOT" "$DATA_DIR" "$STATE" "$BACKUP_DIR" "$RUN_ROOT"; do
  assert_not_symlink "$path_component"
done

if [[ ! -d "$ROOT" || ! -f "$COMPOSE" || ! -x "$ROOT/prepare-data-dir.sh" ||
  ! -x "$METADATA_FIREWALL" || ! -x "$SECRET_VERSION_VALIDATOR" ]]; then
  printf '%s\n' 'Kinvest server files are not bootstrapped' >&2
  exit 1
fi

assert_not_symlink "$COMPOSE"
assert_not_symlink "$ROOT/prepare-data-dir.sh"
assert_not_symlink "$METADATA_FIREWALL"
assert_not_symlink "$SECRET_VERSION_VALIDATOR"
assert_metadata_network_config
install -d -m 0700 -- "$STATE" "$BACKUP_DIR"
assert_not_symlink "$STATE"
assert_not_symlink "$BACKUP_DIR"

exec 9>"$STATE/deploy.lock"
if ! flock -n 9; then
  printf '%s\n' 'another Kinvest deployment is already running' >&2
  exit 1
fi
docker_config=''
metadata_config_snapshot=''
pull_stderr=''
login_stderr=''
preflight_stdout=''
preflight_stderr=''
preflight_expected=''

cleanup_runtime() {
  registry_password=''
  registry_username=''
  if [[ -n "$pull_stderr" ]]; then
    rm -f -- "$pull_stderr"
  fi
  if [[ -n "$login_stderr" ]]; then
    rm -f -- "$login_stderr"
  fi
  if [[ -n "$docker_config" && "$docker_config" == "$RUN_ROOT"/kinvest-docker-config.* ]]; then
    rm -rf -- "$docker_config"
  fi
  if [[ -n "$metadata_config_snapshot" && "$metadata_config_snapshot" == "$RUN_ROOT"/kinvest-metadata-network.* ]]; then
    rm -f -- "$metadata_config_snapshot"
  fi
  for preflight_file in "$preflight_stdout" "$preflight_stderr" "$preflight_expected"; do
    if [[ -n "$preflight_file" && "$preflight_file" == "$RUN_ROOT"/kinvest-ssm-preflight.* ]]; then
      rm -f -- "$preflight_file"
    fi
  done
}
trap cleanup_runtime EXIT INT TERM HUP

on_signal() {
  exit "$1"
}
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

metadata_config_snapshot="$(mktemp "$RUN_ROOT/kinvest-metadata-network.XXXXXX")"
cp -- "$METADATA_NETWORK_CONFIG" "$metadata_config_snapshot"
chmod 0600 "$metadata_config_snapshot"
chown root:root "$metadata_config_snapshot"
assert_metadata_network_config "$metadata_config_snapshot"
read_metadata_network_phase

docker_config="$(mktemp -d "$RUN_ROOT/kinvest-docker-config.XXXXXX")"
chmod 0700 "$docker_config"
export DOCKER_CONFIG="$docker_config"

assert_tcr_policy_enabled() {
  local owner=''
  local mode=''
  local first_line=''
  local extra_line=''

  if [[ ! -f "$TCR_POLICY_FILE" || -L "$TCR_POLICY_FILE" ]]; then
    printf '%s\n' 'TCR production mode is not enabled by server policy' >&2
    exit 1
  fi
  owner="$(stat -c '%U:%G' "$TCR_POLICY_FILE")"
  mode="$(stat -c '%a' "$TCR_POLICY_FILE")"
  IFS= read -r first_line < "$TCR_POLICY_FILE" || true
  extra_line="$(sed -n '2p' "$TCR_POLICY_FILE")"
  if [[ "$owner" != 'root:root' || "$mode" != '600' || "$first_line" != 'enabled' || -n "$extra_line" ]]; then
    printf '%s\n' 'TCR production policy is invalid' >&2
    exit 1
  fi
}

if [[ "$registry_mode" == 'tcr-basic' ]]; then
  assert_tcr_policy_enabled
fi

run_docker() {
  timeout --signal=TERM --kill-after="$DOCKER_KILL_AFTER" "$DOCKER_TIMEOUT" docker "$@"
}

run_pull() {
  timeout --signal=TERM --kill-after="$DOCKER_KILL_AFTER" "$PULL_TIMEOUT" docker pull "$1"
}

run_inspect() {
  timeout --signal=TERM --kill-after="$INSPECT_KILL_AFTER" "$INSPECT_TIMEOUT" docker "$@"
}

run_metadata_firewall() {
  timeout --signal=TERM --kill-after="$DOCKER_KILL_AFTER" "$DOCKER_TIMEOUT" \
    env KMF_CONFIG="$metadata_config_snapshot" "$METADATA_FIREWALL" "$@"
}

secret_provider_mode() {
  if [[ "$1" == '{}' ]]; then printf '%s\n' 'disabled'; else printf '%s\n' 'cvm-ssm'; fi
}

validate_secret_mapping() {
  local candidate="$1"
  local canonical=''

  canonical="$(printf '%s\n' "$candidate" | "$SECRET_VERSION_VALIDATOR" mapping 2>/dev/null)" || return 1
  [[ "$canonical" == "$candidate" ]] || return 1
  printf '%s\n' "$canonical"
}

run_compose() {
  local image_ref="$1"
  local version_mapping="$2"
  local provider_mode=''

  provider_mode="$(secret_provider_mode "$version_mapping")"

  timeout --signal=TERM --kill-after="$DOCKER_KILL_AFTER" "$COMPOSE_TIMEOUT" \
    env KINVEST_IMAGE="$image_ref" DOCKER_CONFIG="$DOCKER_CONFIG" \
      KINVEST_SECRET_PROVIDER_MODE="$provider_mode" \
      KINVEST_SECRET_VERSION_IDS="$version_mapping" \
    docker compose \
      --env-file "$metadata_config_snapshot" \
      --project-name kinvest \
      -f "$COMPOSE" \
      up -d --no-deps --pull never kinvest
}

run_compose_config() {
  local image_ref="$1"
  local version_mapping="$2"
  local provider_mode=''

  provider_mode="$(secret_provider_mode "$version_mapping")"

  timeout --signal=TERM --kill-after="$DOCKER_KILL_AFTER" "$COMPOSE_TIMEOUT" \
    env KINVEST_IMAGE="$image_ref" DOCKER_CONFIG="$DOCKER_CONFIG" \
      KINVEST_SECRET_PROVIDER_MODE="$provider_mode" \
      KINVEST_SECRET_VERSION_IDS="$version_mapping" \
    docker compose \
      --env-file "$metadata_config_snapshot" \
      --project-name kinvest \
      -f "$COMPOSE" \
      config
}

pull_failure_is_transient() {
  local status="$1"
  local stderr_file="$2"

  if ((status == 124 || status == 137 || status == 143)); then
    return 0
  fi

  grep -Eqi \
    'timeout|timed out|connection reset|connection refused|EOF|temporary|try again|unreachable|no route to host|TLS handshake|Bad Gateway|Service Unavailable|Gateway Timeout|502|503|504' \
    "$stderr_file"
}

pull_with_retries() {
  local ref="$1"
  local attempt=1
  local wait_seconds="$PULL_RETRY_BASE_WAIT_SECONDS"
  local status=0

  pull_stderr="$(mktemp "$RUN_ROOT/kinvest-pull-stderr.XXXXXX")"

  while ((attempt <= PULL_ATTEMPTS)); do
    status=0
    run_pull "$ref" >/dev/null 2>"$pull_stderr" || status=$?

    if ((status == 0)); then
      rm -f -- "$pull_stderr"
      pull_stderr=''
      printf 'Kinvest image pull attempt %s of %s succeeded.\n' "$attempt" "$PULL_ATTEMPTS" >&2
      return 0
    fi

    printf 'Kinvest image pull attempt %s of %s failed with exit code %s.\n' \
      "$attempt" "$PULL_ATTEMPTS" "$status" >&2

    if ((attempt >= PULL_ATTEMPTS)); then
      printf 'Kinvest image pull failed after %s attempts.\n' "$PULL_ATTEMPTS" >&2
      return 1
    fi

    if ! pull_failure_is_transient "$status" "$pull_stderr"; then
      printf 'Kinvest image pull failed with a non-retryable error (exit code %s).\n' "$status" >&2
      return 1
    fi

    sleep "$wait_seconds"
    wait_seconds=$((wait_seconds * 2))
    attempt=$((attempt + 1))
  done
}

if [[ "$registry_mode" == 'tcr-basic' ]]; then
  login_stderr="$(mktemp "$RUN_ROOT/kinvest-login-stderr.XXXXXX")"
  login_status=0
  printf '%s' "$registry_password" |
    timeout --signal=TERM --kill-after="$DOCKER_KILL_AFTER" "$DOCKER_TIMEOUT" \
      docker login "$registry_host" --username "$registry_username" --password-stdin \
      >/dev/null 2>"$login_stderr" || login_status=$?
  registry_password=''
  registry_username=''
  rm -f -- "$login_stderr"
  login_stderr=''
  if ((login_status != 0)); then
    printf 'Registry login failed with exit code %s.\n' "$login_status" >&2
    exit 1
  fi
fi

verify_repo_digest() {
  local expected_ref="$1"
  local repo_digests=''

  if ! repo_digests="$(run_inspect image inspect --format '{{json .RepoDigests}}' "$expected_ref")"; then
    return 1
  fi
  grep -Fq -- "\"$expected_ref\"" <<< "$repo_digests"
}

inspect_image_id() {
  local image_ref="$1"
  local image_id=''

  image_id="$(run_inspect image inspect --format '{{.Id}}' "$image_ref")" || return 1
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$image_id"
}

resolve_offline_image_id() {
  local value=''
  local available_image_id=''

  [[ -x "$OFFLINE_IMAGE_ATTESTATION" && ! -L "$OFFLINE_IMAGE_ATTESTATION" ]] || return 1
  value="$(
    "$OFFLINE_IMAGE_ATTESTATION" resolve \
      "$digest_ref" \
      "$commit_sha" \
      "$verification_run_id" 2>/dev/null
  )" || return 1
  [[ "$value" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  available_image_id="$(inspect_image_id "$value")" || return 1
  [[ "$available_image_id" == "$value" ]] || return 1
  printf '%s\n' "$value"
}

resolve_candidate_runtime_image_id() {
  local resolved_image_id=''

  candidate_runtime_image_id=''
  if verify_repo_digest "$digest_ref"; then
    resolved_image_id="$(inspect_image_id "$digest_ref")" || return 1
    printf '%s\n' 'Kinvest image RepoDigest is already verified locally; registry pull skipped.' >&2
    candidate_runtime_image_id="$resolved_image_id"
    return 0
  fi

  if resolved_image_id="$(resolve_offline_image_id)"; then
    printf '%s\n' 'Kinvest offline image attestation resolved a verified local Image ID; registry pull skipped.' >&2
    candidate_runtime_image_id="$resolved_image_id"
    return 0
  fi

  pull_with_retries "$digest_ref"
  if ! verify_repo_digest "$digest_ref"; then
    printf '%s\n' 'pulled image RepoDigests do not contain the requested digest' >&2
    return 1
  fi
  candidate_runtime_image_id="$(inspect_image_id "$digest_ref")" || return 1
}

read_image_schema_range() {
  local image_ref="$1"
  local allow_legacy="$2"
  local minimum=''
  local maximum=''

  minimum="$(run_inspect image inspect --format '{{index .Config.Labels "io.kinvest.schema.min"}}' "$image_ref")" || return 1
  maximum="$(run_inspect image inspect --format '{{index .Config.Labels "io.kinvest.schema.max"}}' "$image_ref")" || return 1

  if [[ "$allow_legacy" == 'true' && ( "$minimum" == '<no value>' || -z "$minimum" ) &&
    ( "$maximum" == '<no value>' || -z "$maximum" ) ]]; then
    printf '%s %s\n' '0' '0'
    return 0
  fi

  if [[ ! "$minimum" =~ ^[0-9]+$ || ! "$maximum" =~ ^[0-9]+$ || "$minimum" -gt "$maximum" ]]; then
    return 1
  fi
  printf '%s %s\n' "$minimum" "$maximum"
}

run_secret_preflight() {
  local image_ref="$1"
  local version_mapping="$2"
  local label=''
  local reference_count=''
  local status=0

  [[ "$version_mapping" != '{}' ]] || return 0
  label="$(run_inspect image inspect --format '{{index .Config.Labels "io.kinvest.secret-bootstrap"}}' "$image_ref")" || {
    printf '%s\n' 'candidate secret bootstrap label check failed' >&2
    return 1
  }
  if [[ "$label" != '1' ]]; then
    printf '%s\n' 'candidate secret bootstrap label is missing' >&2
    return 1
  fi
  reference_count="$(printf '%s\n' "$version_mapping" | "$SECRET_VERSION_VALIDATOR" count 2>/dev/null)" || {
    printf '%s\n' 'candidate secret preflight configuration is invalid' >&2
    return 1
  }
  preflight_stdout="$(mktemp "$RUN_ROOT/kinvest-ssm-preflight.stdout.XXXXXX")"
  preflight_stderr="$(mktemp "$RUN_ROOT/kinvest-ssm-preflight.stderr.XXXXXX")"
  preflight_expected="$(mktemp "$RUN_ROOT/kinvest-ssm-preflight.expected.XXXXXX")"
  chmod 0600 "$preflight_stdout" "$preflight_stderr" "$preflight_expected"
  printf 'KINVEST_SSM_PREFLIGHT_OK references=%s\n' "$reference_count" > "$preflight_expected"

  run_docker run \
    --rm \
    --user 10001:10001 \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --network container:kinvest \
    --env KINVEST_SECRET_PROVIDER_MODE=cvm-ssm \
    --env "KINVEST_SECRET_VERSION_IDS=$version_mapping" \
    --entrypoint node \
    "$image_ref" \
    server/secret-preflight.js >"$preflight_stdout" 2>"$preflight_stderr" || status=$?

  if ((status != 0)) || [[ -s "$preflight_stderr" ]] || ! cmp -s -- "$preflight_expected" "$preflight_stdout"; then
    printf '%s\n' 'candidate secret preflight failed' >&2
    return 1
  fi
  rm -f -- "$preflight_stdout" "$preflight_stderr" "$preflight_expected"
  preflight_stdout=''
  preflight_stderr=''
  preflight_expected=''
}

read_database_schema() {
  if [[ ! -e "$DATABASE" ]]; then
    printf '%s\n' '0'
    return 0
  fi
  assert_not_symlink "$DATABASE"
  python3 - "$DATABASE" <<'PY'
import sqlite3
import sys

connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    value = connection.execute("PRAGMA user_version").fetchone()[0]
    if not isinstance(value, int) or value < 0:
        raise RuntimeError("invalid SQLite user_version")
    print(value)
finally:
    connection.close()
PY
}

database_backup_path='none'
database_backup_checksum='none'

create_database_backup() {
  local timestamp=''
  local temporary=''

  if [[ ! -e "$DATABASE" ]]; then
    return 0
  fi

  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  database_backup_path="$BACKUP_DIR/${timestamp}-${commit_sha}.sqlite"
  temporary="$(mktemp "$BACKUP_DIR/.backup.XXXXXX")"
  python3 - "$DATABASE" "$temporary" <<'PY'
import sqlite3
import sys

source = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
destination = sqlite3.connect(sys.argv[2])
try:
    source.backup(destination)
    result = destination.execute("PRAGMA quick_check").fetchone()[0]
    if result != "ok":
        raise RuntimeError("backup quick_check failed")
finally:
    destination.close()
    source.close()
PY
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$database_backup_path"
  database_backup_checksum="$(sha256sum "$database_backup_path" | awk '{print $1}')"
  if [[ ! "$database_backup_checksum" =~ ^[0-9a-f]{64}$ ]]; then
    printf '%s\n' 'database backup checksum is invalid' >&2
    exit 1
  fi
}

schema_in_range() {
  local schema="$1"
  local minimum="$2"
  local maximum="$3"
  [[ "$schema" =~ ^[0-9]+$ && "$minimum" =~ ^[0-9]+$ && "$maximum" =~ ^[0-9]+$ ]] &&
    ((schema >= minimum && schema <= maximum))
}

wait_for_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  local health_status=''
  local remaining=0

  while ((SECONDS < deadline)); do
    if ! health_status="$(run_inspect inspect --format '{{.State.Health.Status}}' kinvest)"; then
      return 1
    fi
    if [[ "$health_status" == 'healthy' ]]; then
      return 0
    fi
    if [[ "$health_status" == 'unhealthy' ]]; then
      return 1
    fi
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || break
    if ((remaining < HEALTH_INTERVAL)); then sleep "$remaining"; else sleep "$HEALTH_INTERVAL"; fi
  done
  return 1
}

verify_running_image() {
  local expected_image_id="$1"
  local available_image_id=''
  local actual_image_ref=''
  local actual_image_id=''

  [[ "$expected_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  available_image_id="$(inspect_image_id "$expected_image_id")" || return 1
  actual_image_ref="$(run_inspect inspect --format '{{.Config.Image}}' kinvest)" || return 1
  actual_image_id="$(run_inspect inspect --format '{{.Image}}' kinvest)" || return 1

  [[ "$available_image_id" == "$expected_image_id" &&
    "$actual_image_ref" == "$expected_image_id" &&
    "$actual_image_id" == "$expected_image_id" ]]
}

atomic_write_state() {
  local destination="$1"
  local state_digest="$2"
  local state_runtime_image_id="$3"
  local state_commit="$4"
  local state_schema="$5"
  local state_min="$6"
  local state_max="$7"
  local state_secret_versions="$8"
  local state_release_schema="$9"
  local state_run_id="${10}"
  local state_artifact_source="${11}"
  local state_backup_path="${12}"
  local state_backup_checksum="${13}"
  local state_deployed_at="${14}"
  local temporary=''

  temporary="$(mktemp "$STATE/.state.XXXXXX")"
  cat > "$temporary" <<EOF_STATE
protocolVersion=3
imageDigest=$state_digest
runtimeImageId=$state_runtime_image_id
commit=$state_commit
schemaVersion=$state_schema
imageSchemaMin=$state_min
imageSchemaMax=$state_max
secretVersionIds=$state_secret_versions
releaseRecordSchemaVersion=$state_release_schema
verificationRunId=$state_run_id
artifactSource=$state_artifact_source
databaseBackupPath=$state_backup_path
databaseBackupChecksum=$state_backup_checksum
deployedAt=$state_deployed_at
EOF_STATE
  chmod 0600 "$temporary"
  chown root:root "$temporary"
  mv -f -- "$temporary" "$destination"
}

atomic_write_attempt_state() {
  local schema_before="$1"
  local started_at="$2"
  local temporary=''

  temporary="$(mktemp "$STATE/.attempt.XXXXXX")"
  cat > "$temporary" <<EOF_ATTEMPT
protocolVersion=3
status=pending
imageDigest=$digest_ref
runtimeImageId=$candidate_runtime_image_id
commit=$commit_sha
schemaBefore=$schema_before
imageSchemaMin=$candidate_schema_min
imageSchemaMax=$candidate_schema_max
secretVersionIds=$secret_version_ids
releaseRecordSchemaVersion=$release_record_schema_version
verificationRunId=$verification_run_id
artifactSource=$artifact_source
databaseBackupPath=$database_backup_path
databaseBackupChecksum=$database_backup_checksum
startedAt=$started_at
EOF_ATTEMPT
  chmod 0600 "$temporary"
  chown root:root "$temporary"
  mv -f -- "$temporary" "$ATTEMPT_STATE"
}

previous_digest_ref=''
previous_state_protocol='legacy'
previous_commit=''
previous_schema='0'
previous_schema_min='0'
previous_schema_max='0'
previous_secret_versions='{}'
previous_release_schema='0'
previous_run_id='0'
previous_artifact_source='legacy'
previous_backup_path='none'
previous_backup_checksum='none'
previous_deployed_at='legacy'
previous_image_id=''
has_previous_release='false'

read_current_state() {
  local source="${1:-$CURRENT_STATE}"
  local first_line=''
  local second_line=''
  local third_line=''
  local state_line=''
  local state_line_count=0

  previous_digest_ref=''
  previous_state_protocol='legacy'
  previous_commit=''
  previous_schema='0'
  previous_schema_min='0'
  previous_schema_max='0'
  previous_secret_versions='{}'
  previous_release_schema='0'
  previous_run_id='0'
  previous_artifact_source='legacy'
  previous_backup_path='none'
  previous_backup_checksum='none'
  previous_deployed_at='legacy'
  previous_image_id=''

  assert_not_symlink "$source"
  IFS= read -r first_line < "$source" || return 1

  if [[ "$first_line" == protocolVersion=3 ]]; then
    previous_state_protocol='3'
    while IFS= read -r state_line || [[ -n "$state_line" ]]; do
      state_line_count=$((state_line_count + 1))
      case "$state_line_count" in
        1) [[ "$state_line" == 'protocolVersion=3' ]] || return 1 ;;
        2) [[ "$state_line" == imageDigest=* ]] || return 1; previous_digest_ref="${state_line#imageDigest=}" ;;
        3) [[ "$state_line" == runtimeImageId=* ]] || return 1; previous_image_id="${state_line#runtimeImageId=}" ;;
        4) [[ "$state_line" == commit=* ]] || return 1; previous_commit="${state_line#commit=}" ;;
        5) [[ "$state_line" == schemaVersion=* ]] || return 1; previous_schema="${state_line#schemaVersion=}" ;;
        6) [[ "$state_line" == imageSchemaMin=* ]] || return 1; previous_schema_min="${state_line#imageSchemaMin=}" ;;
        7) [[ "$state_line" == imageSchemaMax=* ]] || return 1; previous_schema_max="${state_line#imageSchemaMax=}" ;;
        8) [[ "$state_line" == secretVersionIds=* ]] || return 1; previous_secret_versions="${state_line#secretVersionIds=}" ;;
        9) [[ "$state_line" == releaseRecordSchemaVersion=* ]] || return 1; previous_release_schema="${state_line#releaseRecordSchemaVersion=}" ;;
        10) [[ "$state_line" == verificationRunId=* ]] || return 1; previous_run_id="${state_line#verificationRunId=}" ;;
        11) [[ "$state_line" == artifactSource=* ]] || return 1; previous_artifact_source="${state_line#artifactSource=}" ;;
        12) [[ "$state_line" == databaseBackupPath=* ]] || return 1; previous_backup_path="${state_line#databaseBackupPath=}" ;;
        13) [[ "$state_line" == databaseBackupChecksum=* ]] || return 1; previous_backup_checksum="${state_line#databaseBackupChecksum=}" ;;
        14) [[ "$state_line" == deployedAt=* ]] || return 1; previous_deployed_at="${state_line#deployedAt=}" ;;
        *) return 1 ;;
      esac
    done < "$source"
    [[ "$state_line_count" -eq 14 ]] || return 1
  elif [[ "$first_line" == protocolVersion=2 ]]; then
    previous_state_protocol='2'
    while IFS= read -r state_line || [[ -n "$state_line" ]]; do
      state_line_count=$((state_line_count + 1))
      case "$state_line_count" in
        1) [[ "$state_line" == 'protocolVersion=2' ]] || return 1 ;;
        2) [[ "$state_line" == imageDigest=* ]] || return 1; previous_digest_ref="${state_line#imageDigest=}" ;;
        3) [[ "$state_line" == commit=* ]] || return 1; previous_commit="${state_line#commit=}" ;;
        4) [[ "$state_line" == schemaVersion=* ]] || return 1; previous_schema="${state_line#schemaVersion=}" ;;
        5) [[ "$state_line" == imageSchemaMin=* ]] || return 1; previous_schema_min="${state_line#imageSchemaMin=}" ;;
        6) [[ "$state_line" == imageSchemaMax=* ]] || return 1; previous_schema_max="${state_line#imageSchemaMax=}" ;;
        7) [[ "$state_line" == secretVersionIds=* ]] || return 1; previous_secret_versions="${state_line#secretVersionIds=}" ;;
        8) [[ "$state_line" == releaseRecordSchemaVersion=* ]] || return 1; previous_release_schema="${state_line#releaseRecordSchemaVersion=}" ;;
        9) [[ "$state_line" == verificationRunId=* ]] || return 1; previous_run_id="${state_line#verificationRunId=}" ;;
        10) [[ "$state_line" == artifactSource=* ]] || return 1; previous_artifact_source="${state_line#artifactSource=}" ;;
        11) [[ "$state_line" == databaseBackupPath=* ]] || return 1; previous_backup_path="${state_line#databaseBackupPath=}" ;;
        12) [[ "$state_line" == databaseBackupChecksum=* ]] || return 1; previous_backup_checksum="${state_line#databaseBackupChecksum=}" ;;
        13) [[ "$state_line" == deployedAt=* ]] || return 1; previous_deployed_at="${state_line#deployedAt=}" ;;
        *) return 1 ;;
      esac
    done < "$source"
    [[ "$state_line_count" -eq 13 ]] || return 1
  else
    IFS= read -r first_line < "$source" || return 1
    IFS= read -r second_line < <(sed -n '2p' "$source") || return 1
    third_line="$(sed -n '3p' "$source")"
    [[ -z "$third_line" && "$first_line" == digest_ref=* && "$second_line" == commit=* ]] || return 1
    previous_digest_ref="${first_line#digest_ref=}"
    previous_commit="${second_line#commit=}"
  fi

  [[ "$previous_digest_ref" =~ $ALLOWED_STATE_DIGEST_PATTERN ]] || return 1
  if [[ "$previous_state_protocol" == '3' && ! "$previous_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    return 1
  fi
  [[ "$previous_commit" =~ ^[0-9a-f]{40}$ ]] || return 1
  schema_in_range "$previous_schema" "$previous_schema_min" "$previous_schema_max" || return 1
  previous_secret_versions="$(validate_secret_mapping "$previous_secret_versions")" || return 1
}

capture_previous_snapshot() {
  local running_ref=''
  local running_image_id=''
  local available_image_id=''
  local health=''

  running_ref="$(run_inspect inspect --format '{{.Config.Image}}' kinvest)" || return 1
  running_image_id="$(run_inspect inspect --format '{{.Image}}' kinvest)" || return 1
  health="$(run_inspect inspect --format '{{.State.Health.Status}}' kinvest)" || return 1
  [[ "$running_image_id" =~ ^sha256:[0-9a-f]{64}$ && "$health" == 'healthy' ]] || return 1
  available_image_id="$(inspect_image_id "$running_image_id")" || return 1
  [[ "$available_image_id" == "$running_image_id" ]] || return 1

  if [[ "$previous_state_protocol" == '3' ]]; then
    [[ "$running_ref" == "$previous_image_id" && "$running_image_id" == "$previous_image_id" ]]
  else
    [[ "$running_ref" == "$previous_digest_ref" ]] || return 1
    previous_image_id="$running_image_id"
  fi
}

rollback() {
  local original_status="${1:-1}"
  local current_schema=''
  local available_previous_image_id=''

  trap - ERR
  if ! run_metadata_firewall guard; then
    printf '%s\n' 'metadata deny guard could not be confirmed; refusing rollback operations' >&2
    exit "$original_status"
  fi
  printf '%s\n' 'Kinvest deployment failed; evaluating verified rollback.' >&2

  if [[ -z "$previous_digest_ref" ]]; then
    run_docker rm -f kinvest >/dev/null || true
    printf '%s\n' 'No previous release exists; manual intervention is required.' >&2
    exit "$original_status"
  fi

  current_schema="$(read_database_schema)" || enter_restore_required "$original_status"
  if ! schema_in_range "$current_schema" "$previous_schema_min" "$previous_schema_max"; then
    enter_restore_required "$original_status"
  fi

  available_previous_image_id="$(inspect_image_id "$previous_image_id")" || {
    printf '%s\n' 'Previous image is not locally available; manual intervention is required.' >&2
    exit "$original_status"
  }
  if [[ "$available_previous_image_id" != "$previous_image_id" ]]; then
    printf '%s\n' 'Previous image identity changed; manual intervention is required.' >&2
    exit "$original_status"
  fi

  if ! run_secret_preflight "$previous_image_id" "$previous_secret_versions"; then
    printf '%s\n' 'previous release secret preflight failed; manual intervention is required' >&2
    exit "$original_status"
  fi
  run_compose "$previous_image_id" "$previous_secret_versions" >/dev/null || exit "$original_status"
  wait_for_health || exit "$original_status"
  verify_running_image "$previous_image_id" || exit "$original_status"
  metadata_firewall_outcome='verified'
  if ! run_metadata_firewall reconcile; then
    if run_metadata_firewall guard; then
      metadata_firewall_outcome='deny'
    else
      metadata_firewall_outcome='failed'
    fi
  fi
  if [[ "$metadata_network_phase" == 'pending' ]]; then
    atomic_write_metadata_activation_state pending || printf '%s\n' 'could not restore pending metadata activation state' >&2
  fi
  rm -f -- "$ATTEMPT_STATE"
  case "$metadata_firewall_outcome" in
    verified) printf '%s\n' 'Previous compatible Kinvest digest was restored; metadata firewall status verified.' >&2 ;;
    deny) printf '%s\n' 'Previous compatible Kinvest digest was restored with the metadata deny guard; allow-path isolation is not active.' >&2 ;;
    failed) printf '%s\n' 'Previous compatible Kinvest digest was restored, but metadata deny could not be confirmed; immediate manual isolation is required.' >&2 ;;
  esac
  exit "$original_status"
}

enter_restore_required() {
  local original_status="$1"
  local running_ref=''

  if ! run_metadata_firewall guard; then
    printf '%s\n' 'metadata deny guard could not be confirmed; immediate manual isolation is required' >&2
    exit "$original_status"
  fi

  if ! running_ref="$(run_inspect inspect --format '{{.Config.Image}}' kinvest)" ||
    [[ "$running_ref" == "$candidate_runtime_image_id" ]]; then
    if ! run_docker stop kinvest >/dev/null; then
      printf '%s\n' 'candidate stop failed; immediate manual isolation is required' >&2
    fi
  fi
  printf '%s\n' 'ROLLBACK_REQUIRES_DB_RESTORE' >&2
  exit "$original_status"
}

verify_public_health() {
  local response_file=''

  response_file="$(mktemp "$RUN_ROOT/kinvest-public-health.XXXXXX")"
  if ! curl -fsS --max-time 15 "$PUBLIC_HEALTH_URL" > "$response_file"; then
    rm -f -- "$response_file"
    return 1
  fi
  if ! python3 - "$response_file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    payload = json.load(stream)
if payload.get("status") != "ok" or payload.get("service") != "kinvest":
    raise SystemExit(1)
PY
  then
    rm -f -- "$response_file"
    return 1
  fi
  rm -f -- "$response_file"
}

run_metadata_firewall validate-config
validated_metadata_config_sha256="$(sha256sum "$metadata_config_snapshot" | awk '{print $1}')" || exit 1
if [[ "$validated_metadata_config_sha256" != "$metadata_config_sha256" ]]; then
  printf '%s\n' 'validated metadata config snapshot does not match the approved hash' >&2
  exit 1
fi
rollback_target_runtime_image_id=''
if [[ "$deployment_intent" == 'rollback' ]]; then
  if [[ ! -f "$PREVIOUS_STATE" ]] || ! read_current_state "$PREVIOUS_STATE" ||
    [[ "$previous_digest_ref" != "$digest_ref" || "$previous_commit" != "$commit_sha" ]]; then
    printf '%s\n' 'manual rollback target does not match verified previous state' >&2
    exit 1
  fi
  secret_version_ids="$previous_secret_versions"
  rollback_target_runtime_image_id="$previous_image_id"
else
  secret_version_ids="$(validate_secret_mapping "$secret_version_ids")" || {
    printf '%s\n' 'deployment secret version metadata is invalid' >&2
    exit 2
  }
fi

if [[ "$metadata_network_phase" == 'active' ]]; then
  if ! run_docker network inspect "$metadata_network_name" >/dev/null; then
    run_metadata_firewall guard
    printf '%s\n' 'active metadata network is absent; conflict detection and explicit user approval are required before recreation' >&2
    exit 1
  fi
  if ! run_metadata_firewall status; then
    run_metadata_firewall guard
    printf '%s\n' 'active metadata network or firewall status is invalid; refusing routine deployment' >&2
    exit 1
  fi
fi
run_docker network inspect web >/dev/null
"$ROOT/prepare-data-dir.sh" >/dev/null

if [[ -e "$CURRENT_STATE" ]]; then
  if ! read_current_state || ! capture_previous_snapshot; then
    printf '%s\n' 'refusing deployment because the current release cannot be verified' >&2
    exit 1
  fi
  has_previous_release='true'
else
  assert_not_symlink "$CURRENT_STATE"
fi

resolve_candidate_runtime_image_id || {
  printf '%s\n' 'candidate image could not be resolved to an immutable local Image ID' >&2
  exit 1
}
if [[ "$deployment_intent" == 'rollback' && -n "$rollback_target_runtime_image_id" &&
  "$candidate_runtime_image_id" != "$rollback_target_runtime_image_id" ]]; then
  printf '%s\n' 'manual rollback runtime Image ID does not match verified previous state' >&2
  exit 1
fi

# Remove registry material immediately after the authenticated pull. The empty
# temporary DOCKER_CONFIG remains active so later Docker calls cannot fall back
# to /root/.docker/config.json.
rm -f -- "$DOCKER_CONFIG/config.json"

run_compose_config "$candidate_runtime_image_id" "$secret_version_ids" >/dev/null

read -r candidate_schema_min candidate_schema_max < <(read_image_schema_range "$candidate_runtime_image_id" 'false') || {
  printf '%s\n' 'candidate image has invalid schema compatibility labels' >&2
  exit 1
}
schema_before="$(read_database_schema)"
if ! schema_in_range "$schema_before" "$candidate_schema_min" "$candidate_schema_max"; then
  printf '%s\n' 'candidate image does not support the current database schema' >&2
  exit 1
fi

run_secret_preflight "$candidate_runtime_image_id" "$secret_version_ids"

create_database_backup
if [[ "$has_previous_release" == 'true' ]]; then
  atomic_write_state \
    "$PREVIOUS_STATE" \
    "$previous_digest_ref" \
    "$previous_image_id" \
    "$previous_commit" \
    "$previous_schema" \
    "$previous_schema_min" \
    "$previous_schema_max" \
    "$previous_secret_versions" \
    "$previous_release_schema" \
    "$previous_run_id" \
    "$previous_artifact_source" \
    "$previous_backup_path" \
    "$previous_backup_checksum" \
    "$previous_deployed_at"
else
  rm -f -- "$PREVIOUS_STATE"
fi
attempt_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
atomic_write_attempt_state "$schema_before" "$attempt_started_at"

trap 'rollback "$?"' ERR
run_metadata_firewall guard
run_compose "$candidate_runtime_image_id" "$secret_version_ids" >/dev/null
metadata_firewall_status=0
run_metadata_firewall reconcile || metadata_firewall_status=$?
if ((metadata_firewall_status != 0)); then
  rollback "$metadata_firewall_status"
fi
wait_for_health
verify_running_image "$candidate_runtime_image_id"

schema_after="$(read_database_schema)"
if ! schema_in_range "$schema_after" "$candidate_schema_min" "$candidate_schema_max"; then
  printf '%s\n' 'candidate produced a schema outside its declared compatibility range' >&2
  false
fi
verify_public_health

if [[ "$metadata_network_phase" == 'pending' ]]; then
atomic_write_metadata_activation_state active
fi

deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
atomic_write_state \
  "$CURRENT_STATE" \
  "$digest_ref" \
  "$candidate_runtime_image_id" \
  "$commit_sha" \
  "$schema_after" \
  "$candidate_schema_min" \
  "$candidate_schema_max" \
  "$secret_version_ids" \
  "$release_record_schema_version" \
  "$verification_run_id" \
  "$artifact_source" \
  "$database_backup_path" \
  "$database_backup_checksum" \
  "$deployed_at"
rm -f -- "$ATTEMPT_STATE"
trap - ERR

printf 'Kinvest deployed protocol v3 for audit commit %s.\n' "$commit_sha"
