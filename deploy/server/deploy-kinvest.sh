#!/usr/bin/env bash
set -euo pipefail

ROOT='/root/docker/kinvest'
COMPOSE="$ROOT/docker-compose.yml"
STATE="$ROOT/state"
CURRENT_REF="$STATE/current.ref"
PREVIOUS_REF="$STATE/previous.ref"
HEALTH_ATTEMPTS='60'
HEALTH_INTERVAL='2'

if [[ "$#" -ne 2 ]]; then
  printf '%s\n' 'deployment requires an image and commit SHA' >&2
  exit 2
fi

image="$1"
sha="$2"

if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s\n' 'deployment requires a 40-character lowercase commit SHA' >&2
  exit 2
fi

if [[ ! "$image" =~ ^ghcr\.io/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._/-]*$ ]]; then
  printf '%s\n' 'deployment requires a lowercase ghcr.io image without a tag or digest' >&2
  exit 2
fi

candidate_ref="${image}:${sha}"
previous_ref=''

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

docker network inspect web >/dev/null
"$ROOT/prepare-data-dir.sh" >/dev/null

is_valid_ref() {
  [[ "$1" =~ ^ghcr\.io/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._/-]*:[0-9a-f]{40}$ ]]
}

atomic_write_ref() {
  local destination="$1"
  local value="$2"
  local temporary

  temporary="$(mktemp "$STATE/.ref.XXXXXX")"
  printf '%s\n' "$value" > "$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" "$destination"
}

if [[ -e "$CURRENT_REF" ]]; then
  assert_not_symlink "$CURRENT_REF"
  IFS= read -r previous_ref < "$CURRENT_REF"
  if ! is_valid_ref "$previous_ref"; then
    printf '%s\n' 'refusing invalid current Kinvest image state' >&2
    exit 1
  fi
  atomic_write_ref "$PREVIOUS_REF" "$previous_ref"
else
  rm -f -- "$PREVIOUS_REF"
fi

minimal_diagnostics() {
  docker inspect \
    --format 'container={{.Name}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} image={{.Config.Image}}' \
    kinvest >&2 2>/dev/null || printf '%s\n' 'Kinvest container is absent' >&2
}

wait_for_health() {
  local attempt
  local status

  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1)); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' kinvest 2>/dev/null || true)"

    if [[ "$status" == 'healthy' ]]; then
      return 0
    fi

    if [[ "$status" == 'unhealthy' || "$status" == 'exited' || "$status" == 'dead' ]]; then
      break
    fi

    sleep "$HEALTH_INTERVAL"
  done

  return 1
}

rollback() {
  local original_status="${1:-1}"

  trap - ERR
  set +e
  printf '%s\n' 'Kinvest deployment failed; starting safe rollback.' >&2
  minimal_diagnostics

  if [[ -n "$previous_ref" ]]; then
    docker pull "$previous_ref" >/dev/null
    KINVEST_IMAGE="$previous_ref" docker compose \
      --project-name kinvest \
      -f "$COMPOSE" \
      up -d --no-deps kinvest >/dev/null

    if wait_for_health; then
      printf '%s\n' 'Previous healthy Kinvest image was restored.' >&2
    else
      printf '%s\n' 'Rollback image did not become healthy; manual intervention is required.' >&2
      minimal_diagnostics
    fi
  else
    docker rm -f kinvest >/dev/null 2>&1 || true
    printf '%s\n' 'No previous release existed; Kinvest remains stopped.' >&2
  fi

  exit "$original_status"
}

trap 'rollback $?' ERR

docker pull "$candidate_ref" >/dev/null
expected_image_id="$(docker image inspect --format '{{.Id}}' "$candidate_ref")"

KINVEST_IMAGE="$candidate_ref" docker compose \
  --project-name kinvest \
  -f "$COMPOSE" \
  up -d --no-deps kinvest >/dev/null

if ! wait_for_health; then
  printf '%s\n' 'Kinvest container did not become healthy within the deployment window.' >&2
  false
fi

actual_image_id="$(docker inspect --format '{{.Image}}' kinvest)"
actual_image_ref="$(docker inspect --format '{{.Config.Image}}' kinvest)"

if [[ "$actual_image_id" != "$expected_image_id" || "$actual_image_ref" != "$candidate_ref" ]]; then
  printf '%s\n' 'Kinvest running image does not match the requested immutable release.' >&2
  false
fi

atomic_write_ref "$CURRENT_REF" "$candidate_ref"
trap - ERR

printf '%s\n' "Kinvest deployed immutable release $sha."
