#!/usr/bin/env bash
set -Eeuo pipefail

ROOT='/root/docker/kinvest'
ALLOWED_REPOSITORY='ccr.ccs.tencentyun.com/website-dev/kinvest'
ALLOWED_DEPLOYMENT_DIGEST_PATTERN='^ccr\.ccs\.tencentyun\.com/website-dev/kinvest@sha256:[0-9a-f]{64}$'
ALLOWED_STATE_DIGEST_PATTERN='^(ccr\.ccs\.tencentyun\.com/website-dev/kinvest|ghcr\.io/zwphhxx/kinvest)@sha256:[0-9a-f]{64}$'
COMPOSE="$ROOT/docker-compose.yml"
STATE="$ROOT/state"
CURRENT_STATE="$STATE/current.state"
PREVIOUS_STATE="$STATE/previous.state"
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

digest_ref=''
commit_sha=''
extra_input=''

if ! IFS= read -r digest_ref || ! IFS= read -r commit_sha; then
  printf '%s\n' 'deployment requires exactly two input lines' >&2
  exit 2
fi

if IFS= read -r extra_input; then
  printf '%s\n' 'deployment requires exactly two input lines' >&2
  exit 2
fi

if [[ ! "$digest_ref" =~ $ALLOWED_DEPLOYMENT_DIGEST_PATTERN ]]; then
  printf '%s\n' 'deployment requires the immutable Kinvest TCR digest reference' >&2
  exit 2
fi

if [[ ! "$commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s\n' 'deployment requires a 40-character lowercase audit commit SHA' >&2
  exit 2
fi

if [[ "${digest_ref%@*}" != "$ALLOWED_REPOSITORY" ]]; then
  printf '%s\n' 'deployment repository is not allowed' >&2
  exit 2
fi

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

for path_component in '/root' '/root/docker' "$ROOT" "$ROOT/data" "$STATE"; do
  assert_not_symlink "$path_component"
done

if [[ ! -d "$ROOT" || ! -f "$COMPOSE" || ! -x "$ROOT/prepare-data-dir.sh" ]]; then
  printf '%s\n' 'Kinvest server files are not bootstrapped' >&2
  exit 1
fi

assert_not_symlink "$COMPOSE"
assert_not_symlink "$ROOT/prepare-data-dir.sh"
install -d -m 0700 -- "$STATE"
assert_not_symlink "$STATE"

exec 9>"$STATE/deploy.lock"
if ! flock -n 9; then
  printf '%s\n' 'another Kinvest deployment is already running' >&2
  exit 1
fi

run_docker() {
  timeout --signal=TERM --kill-after="$DOCKER_KILL_AFTER" "$DOCKER_TIMEOUT" docker "$@"
}

run_pull() {
  timeout --signal=TERM --kill-after="$DOCKER_KILL_AFTER" "$PULL_TIMEOUT" docker pull "$1"
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
  local stderr_file

  stderr_file="$(mktemp "$STATE/.pull-stderr.XXXXXX")"

  while ((attempt <= PULL_ATTEMPTS)); do
    status=0
    run_pull "$ref" >/dev/null 2>"$stderr_file" || status=$?

    if ((status == 0)); then
      rm -f -- "$stderr_file"
      printf 'Kinvest image pull attempt %s of %s succeeded.\n' "$attempt" "$PULL_ATTEMPTS" >&2
      return 0
    fi

    printf 'Kinvest image pull attempt %s of %s failed with exit code %s.\n' \
      "$attempt" "$PULL_ATTEMPTS" "$status" >&2

    if ((attempt >= PULL_ATTEMPTS)); then
      rm -f -- "$stderr_file"
      printf 'Kinvest image pull failed after %s attempts.\n' "$PULL_ATTEMPTS" >&2
      return 1
    fi

    if ! pull_failure_is_transient "$status" "$stderr_file"; then
      rm -f -- "$stderr_file"
      printf 'Kinvest image pull failed with a non-retryable error (exit code %s).\n' "$status" >&2
      return 1
    fi

    sleep "$wait_seconds"
    wait_seconds=$((wait_seconds * 2))
    attempt=$((attempt + 1))
  done
}

run_inspect() {
  timeout --signal=TERM --kill-after="$INSPECT_KILL_AFTER" "$INSPECT_TIMEOUT" docker "$@"
}

run_compose() {
  local image_ref="$1"

  timeout --signal=TERM --kill-after="$DOCKER_KILL_AFTER" "$COMPOSE_TIMEOUT" \
    env KINVEST_IMAGE="$image_ref" \
    docker compose \
      --project-name kinvest \
      -f "$COMPOSE" \
      up -d --no-deps kinvest
}

is_valid_digest_ref() {
  [[ "$1" =~ $ALLOWED_STATE_DIGEST_PATTERN ]]
}

is_valid_commit() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

atomic_write_state() {
  local destination="$1"
  local image_ref="$2"
  local audit_commit="$3"
  local temporary

  temporary="$(mktemp "$STATE/.state.XXXXXX")"
  printf 'digest_ref=%s\ncommit=%s\n' "$image_ref" "$audit_commit" > "$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$destination"
}

previous_digest_ref=''
previous_commit=''
previous_snapshot_image_id=''
previous_snapshot_verified='false'

read_previous_state() {
  local first_line=''
  local second_line=''
  local unexpected_line=''

  assert_not_symlink "$CURRENT_STATE"

  if ! IFS= read -r first_line || ! IFS= read -r second_line; then
    return 1
  fi < "$CURRENT_STATE"

  if IFS= read -r unexpected_line < <(tail -n +3 "$CURRENT_STATE"); then
    return 1
  fi

  previous_digest_ref="${first_line#digest_ref=}"
  previous_commit="${second_line#commit=}"

  [[ "$first_line" == "digest_ref=$previous_digest_ref" ]] &&
    [[ "$second_line" == "commit=$previous_commit" ]] &&
    is_valid_digest_ref "$previous_digest_ref" &&
    is_valid_commit "$previous_commit"
}

run_docker network inspect web >/dev/null
"$ROOT/prepare-data-dir.sh" >/dev/null

if [[ -e "$CURRENT_STATE" ]]; then
  if ! read_previous_state; then
    printf '%s\n' 'refusing invalid current Kinvest deployment state' >&2
    exit 1
  fi
else
  assert_not_symlink "$CURRENT_STATE"
fi

wait_for_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  local health_status
  local remaining

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
    if ((remaining <= 0)); then
      break
    fi
    if ((remaining < HEALTH_INTERVAL)); then
      sleep "$remaining"
    else
      sleep "$HEALTH_INTERVAL"
    fi
  done

  return 1
}

current_is_healthy() {
  local health_status

  if ! health_status="$(run_inspect inspect --format '{{.State.Health.Status}}' kinvest)"; then
    return 1
  fi

  [[ "$health_status" == 'healthy' ]]
}

verify_running_image() {
  local expected_ref="$1"
  local expected_image_id
  local actual_image_ref
  local actual_image_id

  if ! expected_image_id="$(run_inspect image inspect --format '{{.Id}}' "$expected_ref")"; then
    return 1
  fi
  if ! actual_image_ref="$(run_inspect inspect --format '{{.Config.Image}}' kinvest)"; then
    return 1
  fi
  if ! actual_image_id="$(run_inspect inspect --format '{{.Image}}' kinvest)"; then
    return 1
  fi

  [[ "$actual_image_ref" == "$expected_ref" && "$actual_image_id" == "$expected_image_id" ]]
}

capture_previous_snapshot() {
  local local_image_id
  local running_image_ref
  local running_image_id
  local health_status

  previous_snapshot_verified='false'
  previous_snapshot_image_id=''

  if ! local_image_id="$(run_inspect image inspect --format '{{.Id}}' "$previous_digest_ref")" ||
    ! running_image_ref="$(run_inspect inspect --format '{{.Config.Image}}' kinvest)" ||
    ! running_image_id="$(run_inspect inspect --format '{{.Image}}' kinvest)" ||
    ! health_status="$(run_inspect inspect --format '{{.State.Health.Status}}' kinvest)"; then
    return 1
  fi

  if [[ "$running_image_ref" != "$previous_digest_ref" ||
    "$running_image_id" != "$local_image_id" ||
    "$health_status" != 'healthy' ]]; then
    return 1
  fi

  previous_snapshot_image_id="$local_image_id"
  previous_snapshot_verified='true'
}

previous_snapshot_is_locally_available() {
  local local_image_id

  if [[ "$previous_snapshot_verified" != 'true' || -z "$previous_snapshot_image_id" ]]; then
    return 1
  fi
  if ! local_image_id="$(run_inspect image inspect --format '{{.Id}}' "$previous_digest_ref")"; then
    return 1
  fi

  [[ "$local_image_id" == "$previous_snapshot_image_id" ]]
}

verify_previous_image_from_snapshot() {
  local actual_image_ref
  local actual_image_id

  if [[ "$previous_snapshot_verified" != 'true' || -z "$previous_snapshot_image_id" ]]; then
    return 1
  fi
  if ! actual_image_ref="$(run_inspect inspect --format '{{.Config.Image}}' kinvest)"; then
    return 1
  fi
  if ! actual_image_id="$(run_inspect inspect --format '{{.Image}}' kinvest)"; then
    return 1
  fi

  [[ "$actual_image_ref" == "$previous_digest_ref" ]] &&
    [[ "$actual_image_id" == "$previous_snapshot_image_id" ]]
}

previous_is_serving() {
  if [[ -z "$previous_digest_ref" ]]; then
    return 1
  fi

  previous_snapshot_is_locally_available &&
    verify_previous_image_from_snapshot &&
    current_is_healthy
}

remove_kinvest_container() {
  run_docker rm -f kinvest >/dev/null
}

preserve_previous_and_exit() {
  local original_status="$1"

  printf '%s\n' '部署失败但previous继续服务。' >&2
  exit "$original_status"
}

rollback_failure() {
  local reason="$1"
  local original_status="$2"

  if previous_is_serving; then
    preserve_previous_and_exit "$original_status"
  fi

  printf '%s\n' "$reason" >&2
  if ! remove_kinvest_container; then
    printf '%s\n' 'Kinvest container removal also failed.' >&2
  fi
  printf '%s\n' 'Kinvest is not verified healthy; manual intervention is required.' >&2
  exit "$original_status"
}

rollback() {
  local original_status="${1:-1}"

  trap - ERR
  printf '%s\n' 'Kinvest deployment failed; starting verified rollback.' >&2

  if [[ -z "$previous_digest_ref" ]]; then
    if ! remove_kinvest_container; then
      printf '%s\n' 'Kinvest candidate container removal failed.' >&2
    fi
    printf '%s\n' 'No previous digest exists; manual intervention is required.' >&2
    exit "$original_status"
  fi

  if previous_is_serving; then
    preserve_previous_and_exit "$original_status"
  fi

  if ! previous_snapshot_is_locally_available; then
    rollback_failure 'Previous snapshot image is not locally available.' "$original_status"
  fi

  if ! run_compose "$previous_digest_ref" >/dev/null; then
    rollback_failure 'Previous release compose failed.' "$original_status"
  fi

  if ! verify_previous_image_from_snapshot; then
    rollback_failure 'Previous release image identity verification failed.' "$original_status"
  fi

  if ! wait_for_health; then
    rollback_failure 'Previous release health verification failed.' "$original_status"
  fi

  printf '%s\n' 'Previous healthy Kinvest digest was restored.' >&2
  exit "$original_status"
}

if [[ -n "$previous_digest_ref" ]]; then
  if ! capture_previous_snapshot; then
    printf '%s\n' 'Refusing deployment because previous service snapshot could not be verified; previous continues serving.' >&2
    exit 1
  fi
  atomic_write_state "$PREVIOUS_STATE" "$previous_digest_ref" "$previous_commit"
else
  rm -f -- "$PREVIOUS_STATE"
fi

trap 'rollback "$?"' ERR

pull_with_retries "$digest_ref"
run_compose "$digest_ref" >/dev/null

if ! wait_for_health; then
  printf '%s\n' 'Kinvest candidate did not become healthy.' >&2
  false
fi

if ! verify_running_image "$digest_ref"; then
  printf '%s\n' 'Kinvest running image does not match the requested immutable digest.' >&2
  false
fi

atomic_write_state "$CURRENT_STATE" "$digest_ref" "$commit_sha"
trap - ERR

printf '%s\n' "Kinvest deployed immutable digest for audit commit $commit_sha."
