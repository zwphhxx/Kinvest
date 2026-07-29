#!/usr/bin/env bash
set -Eeuo pipefail

ROOT='/root/docker/kinvest'
ALLOWED_REPOSITORY='ghcr.io/zwphhxx/kinvest'
COMPOSE="$ROOT/docker-compose.yml"
STATE="$ROOT/state"
CURRENT_STATE="$STATE/current.state"
PREVIOUS_STATE="$STATE/previous.state"
DOCKER_TIMEOUT='900s'
COMPOSE_TIMEOUT='120s'
INSPECT_TIMEOUT='15s'
DOCKER_KILL_AFTER='10s'
INSPECT_KILL_AFTER='5s'
HEALTH_ATTEMPTS='60'
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

if [[ ! "$digest_ref" =~ ^ghcr\.io/zwphhxx/kinvest@sha256:[0-9a-f]{64}$ ]]; then
  printf '%s\n' 'deployment requires the immutable Kinvest digest reference' >&2
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
  [[ "$1" =~ ^ghcr\.io/zwphhxx/kinvest@sha256:[0-9a-f]{64}$ ]]
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
  atomic_write_state "$PREVIOUS_STATE" "$previous_digest_ref" "$previous_commit"
else
  assert_not_symlink "$CURRENT_STATE"
  rm -f -- "$PREVIOUS_STATE"
fi

wait_for_health() {
  local attempt
  local health_status

  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1)); do
    if ! health_status="$(run_inspect inspect --format '{{.State.Health.Status}}' kinvest)"; then
      return 1
    fi

    if [[ "$health_status" == 'healthy' ]]; then
      return 0
    fi

    if [[ "$health_status" == 'unhealthy' ]]; then
      return 1
    fi

    sleep "$HEALTH_INTERVAL"
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
  local actual_image_id

  if ! verify_running_image "$previous_digest_ref" || ! current_is_healthy; then
    previous_snapshot_verified='false'
    previous_snapshot_image_id=''
    return 1
  fi

  if ! actual_image_id="$(run_inspect inspect --format '{{.Image}}' kinvest)"; then
    previous_snapshot_verified='false'
    previous_snapshot_image_id=''
    return 1
  fi

  previous_snapshot_image_id="$actual_image_id"
  previous_snapshot_verified='true'
}

verify_previous_from_snapshot() {
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
    [[ "$actual_image_id" == "$previous_snapshot_image_id" ]] &&
    current_is_healthy
}

previous_is_serving() {
  if [[ -z "$previous_digest_ref" ]]; then
    return 1
  fi

  if verify_running_image "$previous_digest_ref" && current_is_healthy; then
    return 0
  fi

  verify_previous_from_snapshot
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

  if ! run_docker pull "$previous_digest_ref" >/dev/null; then
    rollback_failure 'Previous digest pull failed.' "$original_status"
  fi

  if ! run_compose "$previous_digest_ref" >/dev/null; then
    rollback_failure 'Previous release compose failed.' "$original_status"
  fi

  if ! verify_running_image "$previous_digest_ref"; then
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
    printf '%s\n' 'Previous service was not healthy enough for a deployment snapshot.' >&2
  fi
fi

trap 'rollback "$?"' ERR

run_docker pull "$digest_ref" >/dev/null
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
