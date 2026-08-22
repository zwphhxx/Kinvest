#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT='/root/docker/kinvest'
RUN_ROOT='/run'
DEPLOY_PROTOCOL="${KINVEST_DEPLOY_PROTOCOL:-3}"
BUNDLE_UID='0'
BUNDLE_GID='10001'
COMPOSE="$ROOT/docker-compose-v3.yml"
CONTRACT='/usr/local/libexec/kinvest-deploy-v3-contract'
if [[ "$DEPLOY_PROTOCOL" == 4 ]]; then
  COMPOSE="${KINVEST_DEPLOY_COMPOSE:?set v4 compose path}"
  CONTRACT="${KINVEST_DEPLOY_CONTRACT:?set v4 contract path}"
fi
OFFLINE_IMAGE_ATTESTATION='/usr/local/libexec/kinvest-offline-image-attestation'
DATA_DIR="$ROOT/data"
DATABASE="$DATA_DIR/kinvest.sqlite"
STATE="$ROOT/state"
BACKUP_DIR="$ROOT/backups"
CURRENT_STATE="$STATE/current.state"
PREVIOUS_STATE="$STATE/previous.state"
ATTEMPT_STATE="$STATE/attempt.state"
VERSION_LEDGER="$STATE/secret-version-ledger.json"
PUBLIC_HEALTH_URL='https://dearmina.cn/api/health'
BUNDLE_ROOT="$RUN_ROOT/kinvest-secrets"
METADATA_NETWORK_CONFIG='/etc/kinvest/metadata-network.conf'
ACCESS_NETWORK_CONFIG='/etc/kinvest/access-control-network.conf'
DOCKER_TIMEOUT='120s'
INSPECT_TIMEOUT='15s'
PULL_TIMEOUT='300s'
LEGACY_RECOVERY_IMAGE_DIGEST='ghcr.io/zwphhxx/kinvest@sha256:25bc6f76846f1ad429aeb8c4bf1185f8db43bb71b7e5d293197ca48f4d74ad26'
LEGACY_RECOVERY_RUNTIME_IMAGE_ID='sha256:46fce58a9fac1c765a5f5beeafe53a9f63fb3f4e93d4628640a2583da68000b0'
LEGACY_RECOVERY_COMMIT='a0d511f0818a2dd0cc00f619af24942802f3af0d'
LEGACY_RECOVERY_PREFLIGHT_ERROR='SSM_PREFLIGHT_REQUIRES_CVM_SSM'

fail() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }

[[ "$#" -eq 0 ]] || fail DEPLOY_V3_ARGUMENTS_FORBIDDEN 2
[[ "$(id -u)" -eq 0 ]] || fail DEPLOY_V3_ROOT_REQUIRED
[[ -x "$CONTRACT" && -f "$COMPOSE" && ! -L "$COMPOSE" ]] || fail DEPLOY_V3_ASSETS_MISSING
install -d -m 0700 -- "$STATE" "$BACKUP_DIR"

exec 9>"$STATE/deploy.lock"
flock -n 9 || fail DEPLOY_V3_LOCKED

if [[ "$DEPLOY_PROTOCOL" == 3 && -f "$CURRENT_STATE" && "$(head -n 1 "$CURRENT_STATE")" == 'protocolVersion=5' ]]; then
  fail DEPLOY_V3_PROTOCOL_RETIRED
fi

[[ -f "$METADATA_NETWORK_CONFIG" && ! -L "$METADATA_NETWORK_CONFIG" ]] || fail DEPLOY_V3_METADATA_CONFIG_INVALID
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?KINVEST_SECRET_BUNDLE_PATH[[:space:]]*=' "$METADATA_NETWORK_CONFIG"; then
  fail DEPLOY_V3_METADATA_CONFIG_FORBIDDEN
fi

run_fstype="$(findmnt -n -o FSTYPE --target "$RUN_ROOT" 2>/dev/null)" || fail DEPLOY_V3_RUN_MOUNT_INVALID
[[ "$run_fstype" == tmpfs ]] || fail DEPLOY_V3_RUN_NOT_TMPFS

prepared_file=''
current_json=''
previous_json=''
attempt_json=''
current_original_file=''
previous_original_file=''
plan_file=''
base_file=''
candidate_state_file=''
recovery_state_file=''
envelope_file=''
preflight_stdout=''
preflight_stderr=''
health_file=''
access_snapshot=''
network_json=''
candidate_bundle_id='none'
candidate_bundle_path=''
candidate_bundle_keep='false'
transaction_started='false'
current_committed='false'
deployment_succeeded='false'
previous_state_existed='false'
recovery_image_id=''
recovery_schema_min=''
recovery_schema_max=''
current_was_legacy='false'
previous_was_legacy='false'
recovery_error=''
current_schema_version=''
restore_backup_path='none'
restore_backup_checksum='none'
last_preflight_legacy_failure='false'
request_access_mode='disabled'
current_access_mode='disabled'
current_access_contract='0'
current_trusted_proxies='[]'
current_proxy_checksum=''
current_bundle_path=''
target_access_mode='disabled'
target_access_contract='0'
target_trusted_proxies='[]'
target_proxy_checksum=''

safe_runtime_file() {
  [[ -n "$1" && "$1" == "$RUN_ROOT"/kinvest-v3.* ]]
}

remove_candidate_bundle() {
  [[ "$candidate_bundle_keep" == false ]] || return 0
  if [[ "$candidate_bundle_id" =~ ^[0-9a-f]{32}$ ]]; then
    "$CONTRACT" remove-bundle "$candidate_bundle_id" >/dev/null 2>&1 || true
  fi
  rmdir -- "$BUNDLE_ROOT" 2>/dev/null || true
}

run_docker() { timeout --signal=TERM --kill-after=10s "$DOCKER_TIMEOUT" docker "$@"; }
run_inspect() { timeout --signal=TERM --kill-after=5s "$INSPECT_TIMEOUT" docker "$@"; }

inspect_image_id() {
  local value=''
  value="$(run_inspect image inspect "$1" --format '{{.Id}}' 2>/dev/null)" || return 1
  [[ "$value" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$value"
}

read_image_label() {
  run_inspect image inspect "$1" --format "{{index .Config.Labels \"$2\"}}" 2>/dev/null
}

read_schema_version() {
  python3 - "$DATABASE" <<'PY'
import sqlite3, sys
connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    value = connection.execute("PRAGMA user_version").fetchone()[0]
    if not isinstance(value, int) or value < 0:
        raise SystemExit(1)
    print(value)
finally:
    connection.close()
PY
}

verify_image_capability() {
  local image_id="$1" schema="$2" minimum maximum bootstrap
  minimum="$(read_image_label "$image_id" io.kinvest.schema.min)" || return 1
  maximum="$(read_image_label "$image_id" io.kinvest.schema.max)" || return 1
  bootstrap="$(read_image_label "$image_id" io.kinvest.secret-bootstrap)" || return 1
  [[ "$minimum" =~ ^[0-9]+$ && "$maximum" =~ ^[0-9]+$ && "$minimum" -le "$maximum" ]] || return 1
  [[ "$bootstrap" == 1 && "$schema" -ge "$minimum" && "$schema" -le "$maximum" ]] || return 1
  printf '%s\n%s\n' "$minimum" "$maximum"
}

wait_for_container() {
  local expected="$1" health='' running_image='' running_ref=''
  for _ in $(seq 1 60); do
    health="$(run_inspect inspect --format '{{.State.Health.Status}}' kinvest 2>/dev/null)" || return 1
    [[ "$health" == healthy ]] && break
    [[ "$health" == unhealthy ]] && return 1
    sleep 2
  done
  [[ "$health" == healthy ]] || return 1
  running_image="$(run_inspect inspect --format '{{.Image}}' kinvest 2>/dev/null)" || return 1
  running_ref="$(run_inspect inspect --format '{{.Config.Image}}' kinvest 2>/dev/null)" || return 1
  [[ "$running_image" == "$expected" && "$running_ref" == "$expected" ]]
}

verify_public_health() {
  health_file="$(mktemp "$RUN_ROOT/kinvest-v3.public-health.XXXXXX")"
  chmod 0600 "$health_file"
  curl -fsS --max-time 15 "$PUBLIC_HEALTH_URL" >"$health_file" || return 1
  python3 - "$health_file" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    value = json.load(stream)
if value.get("status") != "ok" or value.get("service") != "kinvest":
    raise SystemExit(1)
PY
}

verify_access_behavior() {
  local mode="$1" watch_body watch_status auth_body auth_status
  watch_body="$(mktemp "$RUN_ROOT/kinvest-v3.watchlist.XXXXXX")"
  auth_body="$(mktemp "$RUN_ROOT/kinvest-v3.auth-status.XXXXXX")"
  chmod 0600 "$watch_body" "$auth_body"
  watch_status="$(curl -sS --max-time 15 -o "$watch_body" -w '%{http_code}' https://dearmina.cn/api/watchlist)" || return 1
  if [[ "$mode" == disabled ]]; then
    [[ "$watch_status" == 200 ]] || return 1
  else
    [[ "$watch_status" == 401 ]] || return 1
    python3 - "$watch_body" <<'PY' || return 1
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    value = json.load(stream)
if value != {"error": "AUTH_REQUIRED"}:
    raise SystemExit(1)
PY
    auth_status="$(curl -sS --max-time 15 -o "$auth_body" -w '%{http_code}' https://dearmina.cn/api/auth/status)" || return 1
    [[ "$auth_status" == 200 ]] || return 1
    python3 - "$auth_body" <<'PY' || return 1
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    value = json.load(stream)
if value != {"authorized": False}:
    raise SystemExit(1)
PY
  fi
  rm -f -- "$watch_body" "$auth_body"
}

create_access_snapshot() {
  access_snapshot="$(mktemp "$RUN_ROOT/kinvest-v3.access-snapshot.XXXXXX")"
  python3 - "$DATABASE" "$access_snapshot" <<'PY'
import os, sqlite3, sys
source = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
destination = sqlite3.connect(sys.argv[2])
try:
    source.backup(destination)
    if destination.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise SystemExit(1)
finally:
    destination.close(); source.close()
for suffix in ("-wal", "-shm", "-journal"):
    if os.path.exists(sys.argv[2] + suffix):
        raise SystemExit(1)
PY
  chown 10001:10001 "$access_snapshot"
  chmod 0440 "$access_snapshot"
}

load_access_network() {
  network_json="$(mktemp "$RUN_ROOT/kinvest-v3.access-network.XXXXXX")"
  chmod 0600 "$network_json"
  "$CONTRACT" validate-network-config "$ACCESS_NETWORK_CONFIG" >"$network_json" || return 1
  local container network ip running actual_ip
  container="$(json_field "$network_json" container)"
  network="$(json_field "$network_json" network)"
  ip="$(json_field "$network_json" ip)"
  running="$(run_inspect inspect --format '{{.State.Running}}' "$container" 2>/dev/null)" || return 1
  actual_ip="$(run_inspect inspect --format "{{with index .NetworkSettings.Networks \"$network\"}}{{.IPAddress}}{{end}}" "$container" 2>/dev/null)" || return 1
  [[ "$running" == true && "$actual_ip" == "$ip" ]] || return 1
  target_trusted_proxies="$(json_field "$network_json" trustedProxyAddresses)"
  target_proxy_checksum="$(json_field "$network_json" checksum)"
}

run_secret_preflight() {
  local image_id="$1" provider="$2" versions="$3" bundle_path="$4" expected expected_error references bytes error_bytes status output error valid
  output="$(mktemp "$RUN_ROOT/kinvest-v3.preflight-out.XXXXXX")"
  error="$(mktemp "$RUN_ROOT/kinvest-v3.preflight-err.XXXXXX")"
  chmod 0600 "$output" "$error"
  last_preflight_legacy_failure='false'
  status=0
  (
    ulimit -f 1
    if [[ "$provider" == github-tmpfs-v1 ]]; then
      run_docker run --rm --user 10001:10001 --read-only --cap-drop ALL \
        --security-opt no-new-privileges:true --network none \
        --env "KINVEST_SECRET_PROVIDER_MODE=$provider" \
        --env "KINVEST_SECRET_VERSION_IDS=$versions" \
        --env KINVEST_SECRET_BUNDLE_PATH=/run/secrets/kinvest \
        --volume "$bundle_path:/run/secrets/kinvest:ro" \
        --entrypoint node "$image_id" server/secret-preflight.js
    else
      run_docker run --rm --user 10001:10001 --read-only --cap-drop ALL \
        --security-opt no-new-privileges:true --network none \
        --env "KINVEST_SECRET_PROVIDER_MODE=$provider" \
        --env "KINVEST_SECRET_VERSION_IDS=$versions" \
        --entrypoint node "$image_id" server/secret-preflight.js
    fi
  ) >"$output" 2>"$error" || status=$?
  references=2
  [[ "$provider" == disabled ]] && references=0
  expected="KINVEST_SECRET_PREFLIGHT_OK mode=$provider references=$references"
  bytes=$((${#expected} + 1))
  expected_error="$LEGACY_RECOVERY_PREFLIGHT_ERROR"
  error_bytes=$((${#expected_error} + 1))
  valid=false
  if ((status == 1)) && \
    [[ ! -s "$output" ]] && \
    [[ "$(wc -c <"$error" | tr -d '[:space:]')" -eq "$error_bytes" ]] && \
    [[ "$(cat "$error")" == "$expected_error" ]]; then
    last_preflight_legacy_failure='true'
  fi
  if ((status == 0)) && \
    [[ "$(wc -c <"$output" | tr -d '[:space:]')" -le 128 ]] && \
    [[ "$(wc -c <"$error" | tr -d '[:space:]')" -eq 0 ]] && \
    [[ "$(wc -c <"$output" | tr -d '[:space:]')" -eq "$bytes" ]] && \
    [[ "$(cat "$output")" == "$expected" ]]; then
    valid=true
  fi
  rm -f -- "$output" "$error"
  [[ "$valid" == true ]]
}

run_access_preflight() {
  local image_id="$1" provider="$2" versions="$3" bundle_path="$4" mode="$5" proxies="$6" output error status expected bytes valid
  output="$(mktemp "$RUN_ROOT/kinvest-v3.access-preflight-out.XXXXXX")"
  error="$(mktemp "$RUN_ROOT/kinvest-v3.access-preflight-err.XXXXXX")"
  chmod 0600 "$output" "$error"
  status=0
  (
    ulimit -f 1
    run_docker run --rm --user 10001:10001 --read-only --cap-drop ALL \
      --security-opt no-new-privileges:true --network none \
      --env "KINVEST_SECRET_PROVIDER_MODE=$provider" \
      --env "KINVEST_SECRET_VERSION_IDS=$versions" \
      --env KINVEST_SECRET_BUNDLE_PATH=/run/secrets/kinvest \
      --env "KINVEST_ACCESS_CONTROL_MODE=$mode" \
      --env "KINVEST_TRUSTED_PROXY_ADDRESSES=$proxies" \
      --env KINVEST_DB_PATH=/data/kinvest.sqlite \
      --volume "$bundle_path:/run/secrets/kinvest:ro" \
      --volume "$access_snapshot:/data/kinvest.sqlite:ro" \
      --entrypoint node "$image_id" server/access-preflight.js
  ) >"$output" 2>"$error" || status=$?
  expected='KINVEST_ACCESS_PREFLIGHT_OK mode=device-approval references=2 database=ready proxy=ready'
  bytes=$((${#expected} + 1))
  valid=false
  if ((status == 0)) && [[ ! -s "$error" ]] && \
    [[ "$(wc -c <"$output" | tr -d '[:space:]')" -eq "$bytes" ]] && \
    [[ "$(cat "$output")" == "$expected" ]]; then valid=true; fi
  rm -f -- "$output" "$error"
  [[ "$valid" == true ]]
}

run_legacy_disabled_recovery_preflight() {
  local image_id="$1" expected bytes status output error valid
  output="$(mktemp "$RUN_ROOT/kinvest-v3.legacy-preflight-out.XXXXXX")"
  error="$(mktemp "$RUN_ROOT/kinvest-v3.legacy-preflight-err.XXXXXX")"
  chmod 0600 "$output" "$error"
  status=0
  (
    ulimit -f 1
    run_docker run --rm --user 10001:10001 --read-only --cap-drop ALL \
      --security-opt no-new-privileges:true --network none \
      --env KINVEST_SECRET_PROVIDER_MODE=disabled \
      --env 'KINVEST_SECRET_VERSION_IDS={}' \
      --entrypoint node "$image_id" -e 'const { bootstrapSecrets } = require("./server/security/secret-bootstrap"); (async () => { let runtime; try { runtime = await bootstrapSecrets({ env: { KINVEST_SECRET_PROVIDER_MODE: "disabled", KINVEST_SECRET_VERSION_IDS: "{}" } }); const status = runtime && runtime.status; if (!status || status.mode !== "disabled" || status.referenceCount !== 0 || typeof runtime.clear !== "function") throw new Error("invalid status"); runtime.clear(); runtime = undefined; process.stdout.write("KINVEST_SECRET_PREFLIGHT_OK mode=disabled references=0\n"); } catch { if (runtime && typeof runtime.clear === "function") { try { runtime.clear(); } catch {} } process.exitCode = 1; } })();'
  ) >"$output" 2>"$error" || status=$?
  expected='KINVEST_SECRET_PREFLIGHT_OK mode=disabled references=0'
  bytes=$((${#expected} + 1))
  valid=false
  if ((status == 0)) && \
    [[ "$(wc -c <"$output" | tr -d '[:space:]')" -le 128 ]] && \
    [[ "$(wc -c <"$error" | tr -d '[:space:]')" -eq 0 ]] && \
    [[ "$(wc -c <"$output" | tr -d '[:space:]')" -eq "$bytes" ]] && \
    [[ "$(cat "$output")" == "$expected" ]]; then
    valid=true
  fi
  rm -f -- "$output" "$error"
  [[ "$valid" == true ]]
}

compose_up() {
  local image_id="$1" provider="$2" versions="$3" bundle_path="$4" access_mode="${5:-disabled}" proxies="${6:-[]}" 
  (
    export KINVEST_IMAGE="$image_id"
    export KINVEST_SECRET_PROVIDER_MODE="$provider"
    export KINVEST_SECRET_VERSION_IDS="$versions"
    export KINVEST_SECRET_BUNDLE_HOST_PATH="$bundle_path"
    export KINVEST_ACCESS_CONTROL_MODE="$access_mode"
    export KINVEST_TRUSTED_PROXY_ADDRESSES="$proxies"
    if [[ "$provider" == github-tmpfs-v1 ]]; then
      export KINVEST_SECRET_BUNDLE_PATH=/run/secrets/kinvest
    else
      unset KINVEST_SECRET_BUNDLE_PATH
    fi
    run_docker compose -f "$COMPOSE" --env-file "$METADATA_NETWORK_CONFIG" up -d
  )
}

compose_down() {
  local image_id="$1" provider="$2" versions="$3" bundle_path="$4" access_mode="${5:-disabled}" proxies="${6:-[]}"
  (
    export KINVEST_IMAGE="$image_id"
    export KINVEST_SECRET_PROVIDER_MODE="$provider"
    export KINVEST_SECRET_VERSION_IDS="$versions"
    export KINVEST_SECRET_BUNDLE_HOST_PATH="$bundle_path"
    export KINVEST_ACCESS_CONTROL_MODE="$access_mode"
    export KINVEST_TRUSTED_PROXY_ADDRESSES="$proxies"
    if [[ "$provider" == github-tmpfs-v1 ]]; then
      export KINVEST_SECRET_BUNDLE_PATH=/run/secrets/kinvest
    else
      unset KINVEST_SECRET_BUNDLE_PATH
    fi
    run_docker compose -f "$COMPOSE" --env-file "$METADATA_NETWORK_CONFIG" down
  )
}

make_approved_envelope() {
  local original="$1" output="$2" access_mode="${3:-disabled}" access_contract="${4:-0}" proxies="${5:-[]}" proxy_checksum="${6:-}"
  python3 - "$original" "$prepared_file" "$access_mode" "$access_contract" "$proxies" "$proxy_checksum" >"$output" <<'PY'
import json, sys
with open(sys.argv[1], encoding="ascii") as stream:
    original = json.load(stream)
with open(sys.argv[2], encoding="ascii") as stream:
    prepared = json.load(stream)
approved = {key: prepared[key] for key in (
    "secretProviderMode", "secretVersionIds", "secretMaterialFingerprints", "secretBundleId"
)}
if original.get("protocolVersion") == 5:
    approved.update({
        "accessControlMode": sys.argv[3],
        "imageAccessControlContract": int(sys.argv[4]),
        "trustedProxyAddresses": json.loads(sys.argv[5]),
        "trustedProxyConfigChecksum": sys.argv[6],
    })
print(json.dumps({"approved": approved, "original": original}, ensure_ascii=True, separators=(",", ":")))
PY
}

prune_unreferenced_bundles() {
  local keep_id="$1" entry name
  [[ -e "$BUNDLE_ROOT" ]] || return 0
  [[ -d "$BUNDLE_ROOT" && ! -L "$BUNDLE_ROOT" ]] || return 1
  while IFS= read -r -d '' entry; do
    name="${entry##*/}"
    if [[ "$name" == disabled ]]; then
      [[ -d "$entry" && ! -L "$entry" ]] || return 1
    elif [[ "$name" =~ ^[0-9a-f]{32}$ ]]; then
      [[ "$name" == "$keep_id" ]] || "$CONTRACT" remove-bundle "$name" >/dev/null || return 1
    else
      return 1
    fi
  done < <(find "$BUNDLE_ROOT" -mindepth 1 -maxdepth 1 -print0)
}

restore_previous_runtime() {
  local recovery_versions recovery_provider recovery_bundle schema_after
  [[ "$transaction_started" == true && -n "$recovery_image_id" ]] || return 1
  recovery_provider="$current_provider"
  recovery_versions="$current_versions"
  if [[ "$DEPLOY_PROTOCOL" == 4 ]]; then
    recovery_bundle="$current_bundle_path"
  else
    recovery_bundle="$candidate_bundle_path"
  fi
  compose_down "$runtime_image_id" "$target_provider" "$target_versions" "$candidate_bundle_path" "$target_access_mode" "$target_trusted_proxies" >/dev/null || return 1
  schema_after="$(read_schema_version)" || return 1
  if [[ "$current_was_legacy" == true && "$schema_after" != "$current_schema_version" ]]; then
    recovery_error='ROLLBACK_REQUIRES_DB_RESTORE'
    return 1
  fi
  if [[ "$schema_after" -lt "$recovery_schema_min" || "$schema_after" -gt "$recovery_schema_max" ]]; then
    recovery_error='ROLLBACK_REQUIRES_DB_RESTORE'
    return 1
  fi
  compose_up "$recovery_image_id" "$recovery_provider" "$recovery_versions" "$recovery_bundle" "$current_access_mode" "$current_trusted_proxies" >/dev/null || return 1
  wait_for_container "$recovery_image_id" || return 1
  verify_public_health || return 1
  if [[ "$DEPLOY_PROTOCOL" == 4 ]]; then verify_access_behavior "$current_access_mode" || return 1; fi

  if [[ "$current_was_legacy" == true ]]; then
    "$CONTRACT" atomic-legacy-state "$CURRENT_STATE" <"$current_original_file" || return 1
  else
    envelope_file="$(mktemp "$RUN_ROOT/kinvest-v3.recovery-envelope.XXXXXX")"
    safe_runtime_file "$envelope_file" || return 1
    chmod 0600 "$envelope_file"
    make_approved_envelope "$current_json" "$envelope_file" "$current_access_mode" "$current_access_contract" "$current_trusted_proxies" "$current_proxy_checksum" || return 1
    recovery_state_file="$(mktemp "$RUN_ROOT/kinvest-v3.recovery-state.XXXXXX")"
    chmod 0600 "$recovery_state_file"
    if [[ "$intent" == RESTORE ]]; then
      "$CONTRACT" make-restore-state "$schema_after" "$restore_backup_path" "$restore_backup_checksum" <"$envelope_file" >"$recovery_state_file" || return 1
    else
      "$CONTRACT" make-recovery-state "$schema_after" "$database_backup_path" "$database_backup_checksum" <"$envelope_file" >"$recovery_state_file" || return 1
    fi
    "$CONTRACT" atomic-state "$CURRENT_STATE" <"$recovery_state_file" || return 1
  fi
  if [[ "$previous_state_existed" == true ]]; then
    if [[ "$previous_was_legacy" == true ]]; then
      "$CONTRACT" atomic-legacy-state "$PREVIOUS_STATE" <"$previous_original_file" || return 1
    else
      "$CONTRACT" atomic-state "$PREVIOUS_STATE" <"$previous_json" || return 1
    fi
  else
    rm -f -- "$PREVIOUS_STATE" || return 1
  fi
  rm -f -- "$ATTEMPT_STATE" || return 1
  candidate_bundle_keep='true'
  prune_unreferenced_bundles "$candidate_bundle_id" || return 1
}

cleanup() {
  local status=$?
  trap - EXIT
  if ((status != 0)) && [[ "$transaction_started" == true && "$current_committed" == false ]]; then
    if ! restore_previous_runtime; then
      candidate_bundle_keep='true'
      if [[ "$recovery_error" == ROLLBACK_REQUIRES_DB_RESTORE ]]; then
        printf '%s\n' ROLLBACK_REQUIRES_DB_RESTORE >&2
        status=75
      else
        printf '%s\n' DEPLOY_V3_RECOVERY_FAILED >&2
        status=70
      fi
    fi
  fi
  remove_candidate_bundle
  local item=''
  for item in "$prepared_file" "$current_json" "$previous_json" "$attempt_json" "$current_original_file" \
    "$previous_original_file" "$plan_file" "$base_file" \
    "$candidate_state_file" "$recovery_state_file" "$envelope_file" "$preflight_stdout" \
    "$preflight_stderr" "$health_file"; do
    if safe_runtime_file "$item"; then rm -f -- "$item"; fi
  done
  rm -f -- "$access_snapshot" "$network_json"
  exit "$status"
}

on_signal() { exit "$1"; }
trap cleanup EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

for atomic_target in "$CURRENT_STATE" "$PREVIOUS_STATE" "$ATTEMPT_STATE" "$VERSION_LEDGER"; do
  "$CONTRACT" reconcile-atomic-state "$atomic_target"
done

prepared_file="$(mktemp "$RUN_ROOT/kinvest-v3.prepared.XXXXXX")"
chmod 0600 "$prepared_file"
if ! "$CONTRACT" prepare >"$prepared_file"; then
  fail DEPLOY_V3_PAYLOAD_REJECTED 2
fi

json_field() { "$CONTRACT" json-field "$2" <"$1"; }
intent="$(json_field "$prepared_file" intent)"
request_provider="$(json_field "$prepared_file" secretProviderMode)"
request_versions="$(json_field "$prepared_file" secretVersionIds)"
request_fingerprints="$(json_field "$prepared_file" secretMaterialFingerprints)"
request_bundle_id="$(json_field "$prepared_file" secretBundleId)"
if [[ "$DEPLOY_PROTOCOL" == 4 ]]; then
  request_access_mode="$(json_field "$prepared_file" accessControlMode)"
fi
candidate_bundle_id="$request_bundle_id"
candidate_bundle_path="$(json_field "$prepared_file" secretBundlePath)"
verification_run_id="$(json_field "$prepared_file" verificationRunId)"

if [[ "$request_provider" == disabled ]]; then
  install -d -o "$BUNDLE_UID" -g "$BUNDLE_GID" -m 0700 -- "$BUNDLE_ROOT"
  candidate_bundle_path="$BUNDLE_ROOT/disabled"
  install -d -o "$BUNDLE_UID" -g "$BUNDLE_GID" -m 0550 -- "$candidate_bundle_path"
fi

current_json="$(mktemp "$RUN_ROOT/kinvest-v3.current.XXXXXX")"
chmod 0600 "$current_json"
[[ -f "$CURRENT_STATE" && ! -L "$CURRENT_STATE" ]] || fail DEPLOY_V3_CURRENT_STATE_MISSING
current_original_file="$(mktemp "$RUN_ROOT/kinvest-v3.current-original.XXXXXX")"
chmod 0600 "$current_original_file"
cp -- "$CURRENT_STATE" "$current_original_file"
if [[ "$(head -n 1 "$current_original_file")" == protocolVersion=3 ]]; then
  current_was_legacy='true'
fi
"$CONTRACT" parse-state <"$CURRENT_STATE" >"$current_json"
current_schema_version="$(json_field "$current_json" schemaVersion)"
current_digest="$(json_field "$current_json" imageDigest)"
current_commit="$(json_field "$current_json" commit)"
current_provider="$(json_field "$current_json" secretProviderMode)"
current_versions="$(json_field "$current_json" secretVersionIds)"
current_fingerprints="$(json_field "$current_json" secretMaterialFingerprints)"
current_bundle_id="$(json_field "$current_json" secretBundleId)"
if [[ "$current_provider" == github-tmpfs-v1 ]]; then
  current_bundle_path="$BUNDLE_ROOT/$current_bundle_id"
else
  current_bundle_path="$BUNDLE_ROOT/disabled"
fi
if [[ "$DEPLOY_PROTOCOL" == 4 ]]; then
  current_access_mode="$(json_field "$current_json" accessControlMode)"
  current_access_contract="$(json_field "$current_json" imageAccessControlContract)"
  current_trusted_proxies="$(json_field "$current_json" trustedProxyAddresses)"
  current_proxy_checksum="$(json_field "$current_json" trustedProxyConfigChecksum)"
fi
if [[ "$current_was_legacy" == true && "$request_provider" != disabled ]]; then
  fail DEPLOY_V3_LEGACY_BASELINE_REQUIRED
fi

if [[ -e "$ATTEMPT_STATE" ]]; then
  [[ -f "$ATTEMPT_STATE" && ! -L "$ATTEMPT_STATE" ]] || fail DEPLOY_V3_ATTEMPT_STATE_INVALID
  if [[ "$intent" != RESTORE ]]; then
    fail DEPLOY_V3_ATTEMPT_PENDING
  fi
  attempt_json="$(mktemp "$RUN_ROOT/kinvest-v3.attempt.XXXXXX")"
  chmod 0600 "$attempt_json"
  "$CONTRACT" parse-state <"$ATTEMPT_STATE" >"$attempt_json"
fi

previous_argument='none'
if [[ -e "$PREVIOUS_STATE" ]]; then
  [[ -f "$PREVIOUS_STATE" && ! -L "$PREVIOUS_STATE" ]] || fail DEPLOY_V3_PREVIOUS_STATE_INVALID
  previous_json="$(mktemp "$RUN_ROOT/kinvest-v3.previous.XXXXXX")"
  chmod 0600 "$previous_json"
  previous_original_file="$(mktemp "$RUN_ROOT/kinvest-v3.previous-original.XXXXXX")"
  chmod 0600 "$previous_original_file"
  cp -- "$PREVIOUS_STATE" "$previous_original_file"
  if [[ "$(head -n 1 "$previous_original_file")" == protocolVersion=3 ]]; then
    previous_was_legacy='true'
  fi
  "$CONTRACT" parse-state <"$PREVIOUS_STATE" >"$previous_json"
  previous_argument="$previous_json"
  previous_state_existed='true'
fi

plan_file="$(mktemp "$RUN_ROOT/kinvest-v3.plan.XXXXXX")"
chmod 0600 "$plan_file"
"$CONTRACT" resolve-files "$prepared_file" "$current_json" "$previous_argument" >"$plan_file"
"$CONTRACT" ledger-check "$VERSION_LEDGER" <"$prepared_file" >/dev/null

base_file="$prepared_file"
if [[ "$intent" != FORWARD ]]; then
  base_file="$(mktemp "$RUN_ROOT/kinvest-v3.base.XXXXXX")"
  chmod 0600 "$base_file"
  json_field "$plan_file" target >"$base_file"
fi

target_digest="$(json_field "$base_file" imageDigest)"
target_commit="$(json_field "$base_file" commit)"
target_provider="$request_provider"
target_versions="$(json_field "$plan_file" secretVersionIds)"
recovery_image_id="$(json_field "$current_json" runtimeImageId)"
if [[ "$DEPLOY_PROTOCOL" == 4 ]]; then
  if [[ "$intent" == FORWARD ]]; then
    target_access_mode="$request_access_mode"
  else
    target_access_mode="$current_access_mode"
  fi
  if [[ "$target_access_mode" == device-approval ]]; then
    load_access_network || fail DEPLOY_V4_PROXY_CONFIG_INVALID
    if [[ "$intent" != FORWARD && ( "$target_trusted_proxies" != "$current_trusted_proxies" || "$target_proxy_checksum" != "$current_proxy_checksum" ) ]]; then
      fail RESTORE_STATE_MISMATCH
    fi
  else
    target_trusted_proxies='[]'
    target_proxy_checksum=''
  fi
fi

verify_repo_digest() {
  local values=''
  values="$(run_inspect image inspect "$1" --format '{{json .RepoDigests}}' 2>/dev/null)" || return 1
  grep -Fq -- "\"$2\"" <<<"$values"
}

resolve_offline_image() {
  [[ -x "$OFFLINE_IMAGE_ATTESTATION" && ! -L "$OFFLINE_IMAGE_ATTESTATION" ]] || return 1
  local output_file error_file status value count available
  output_file="$(mktemp "$RUN_ROOT/kinvest-v3.attestation-out.XXXXXX")"
  error_file="$(mktemp "$RUN_ROOT/kinvest-v3.attestation-err.XXXXXX")"
  chmod 0600 "$output_file" "$error_file"
  status=0
  timeout --signal=TERM --kill-after=5s "$INSPECT_TIMEOUT" \
    "$OFFLINE_IMAGE_ATTESTATION" resolve "$target_digest" "$target_commit" "$verification_run_id" \
    >"$output_file" 2>"$error_file" || status=$?
  if ((status != 0)) || [[ -s "$error_file" ]]; then
    rm -f -- "$output_file" "$error_file"
    return 1
  fi
  value="$(cat "$output_file")" || { rm -f -- "$output_file" "$error_file"; return 1; }
  count="$(wc -c <"$output_file" | tr -d '[:space:]')"
  rm -f -- "$output_file" "$error_file"
  [[ "$value" =~ ^sha256:[0-9a-f]{64}$ && ( "$count" == "${#value}" || "$count" == "$(( ${#value} + 1 ))" ) ]] || return 1
  available="$(inspect_image_id "$value")" || return 1
  [[ "$available" == "$value" ]] || return 1
  verify_repo_digest "$value" "$target_digest" || return 1
  printf '%s\n' "$value"
}

resolve_forward_image() {
  local image_id=''
  if image_id="$(inspect_image_id "$target_digest")" && verify_repo_digest "$image_id" "$target_digest"; then
    printf '%s\n' "$image_id"
    return 0
  fi
  if image_id="$(resolve_offline_image)"; then
    printf '%s\n' "$image_id"
    return 0
  fi
  timeout --signal=TERM --kill-after=10s "$PULL_TIMEOUT" docker pull "$target_digest" >/dev/null 2>&1 || return 1
  image_id="$(inspect_image_id "$target_digest")" || return 1
  verify_repo_digest "$image_id" "$target_digest" || return 1
  printf '%s\n' "$image_id"
}

if [[ "$intent" == FORWARD ]]; then
  runtime_image_id="$(resolve_forward_image)" || fail DEPLOY_V3_IMAGE_RESOLUTION_FAILED
else
  runtime_image_id="$(json_field "$base_file" runtimeImageId)"
  available_image_id="$(inspect_image_id "$runtime_image_id")" || fail DEPLOY_V3_STATE_IMAGE_UNAVAILABLE
  [[ "$available_image_id" == "$runtime_image_id" ]] || fail DEPLOY_V3_STATE_IMAGE_MISMATCH
  if ! verify_repo_digest "$runtime_image_id" "$target_digest"; then
    attested_image_id="$(resolve_offline_image)" || fail DEPLOY_V3_STATE_IMAGE_UNATTESTED
    [[ "$attested_image_id" == "$runtime_image_id" ]] || fail DEPLOY_V3_STATE_IMAGE_MISMATCH
  fi
fi

schema_before="$(read_schema_version)" || fail DEPLOY_V3_SCHEMA_READ_FAILED
if [[ "$DEPLOY_PROTOCOL" == 4 && "$intent" == RESTORE && "$schema_before" != "$current_schema_version" ]]; then
  fail RESTORE_SCHEMA_MISMATCH
fi
target_schema_min="$(read_image_label "$runtime_image_id" io.kinvest.schema.min)" || fail DEPLOY_V3_IMAGE_CAPABILITY_INVALID
target_schema_max="$(read_image_label "$runtime_image_id" io.kinvest.schema.max)" || fail DEPLOY_V3_IMAGE_CAPABILITY_INVALID
target_bootstrap="$(read_image_label "$runtime_image_id" io.kinvest.secret-bootstrap)" || fail DEPLOY_V3_IMAGE_CAPABILITY_INVALID
target_access_contract='0'
if [[ "$DEPLOY_PROTOCOL" == 4 ]]; then
  target_access_contract="$(read_image_label "$runtime_image_id" io.kinvest.access-control.contract)" || fail DEPLOY_V4_IMAGE_ACCESS_CONTRACT_INVALID
  [[ "$target_access_contract" == 1 ]] || fail DEPLOY_V4_IMAGE_ACCESS_CONTRACT_INVALID
fi
[[ "$target_schema_min" =~ ^[0-9]+$ && "$target_schema_max" =~ ^[0-9]+$ && "$target_schema_min" -le "$target_schema_max" && "$target_bootstrap" == 1 ]] || fail DEPLOY_V3_IMAGE_CAPABILITY_INVALID
[[ "$schema_before" -ge "$target_schema_min" && "$schema_before" -le "$target_schema_max" ]] || fail ROLLBACK_REQUIRES_DB_RESTORE

available_recovery_id="$(inspect_image_id "$recovery_image_id")" || fail ROLLBACK_REQUIRES_DB_RESTORE
[[ "$available_recovery_id" == "$recovery_image_id" ]] || fail ROLLBACK_REQUIRES_DB_RESTORE
recovery_schema_min="$(read_image_label "$recovery_image_id" io.kinvest.schema.min)" || fail ROLLBACK_REQUIRES_DB_RESTORE
recovery_schema_max="$(read_image_label "$recovery_image_id" io.kinvest.schema.max)" || fail ROLLBACK_REQUIRES_DB_RESTORE
recovery_bootstrap="$(read_image_label "$recovery_image_id" io.kinvest.secret-bootstrap)" || fail ROLLBACK_REQUIRES_DB_RESTORE
recovery_access_contract="$current_access_contract"
if [[ "$DEPLOY_PROTOCOL" == 4 && "$current_access_mode" == device-approval ]]; then
  recovery_access_contract="$(read_image_label "$recovery_image_id" io.kinvest.access-control.contract)" || fail ROLLBACK_ACCESS_CONTROL_INCOMPATIBLE
  [[ "$recovery_access_contract" == 1 ]] || fail ROLLBACK_ACCESS_CONTROL_INCOMPATIBLE
fi
[[ "$recovery_schema_min" =~ ^[0-9]+$ && "$recovery_schema_max" =~ ^[0-9]+$ && "$recovery_schema_min" -le "$recovery_schema_max" && "$recovery_bootstrap" == 1 ]] || fail ROLLBACK_REQUIRES_DB_RESTORE
[[ "$schema_before" -ge "$recovery_schema_min" && "$schema_before" -le "$recovery_schema_max" ]] || fail ROLLBACK_REQUIRES_DB_RESTORE

legacy_disabled_recovery_preflight_allowed() {
  [[ "$intent" == FORWARD && \
    "$current_was_legacy" == true && \
    "$current_provider" == disabled && \
    "$current_versions" == '{}' && \
    "$current_fingerprints" == '{}' && \
    "$current_bundle_id" == none && \
    "$request_provider" == disabled && \
    "$request_versions" == '{}' && \
    "$request_fingerprints" == '{}' && \
    "$request_bundle_id" == none && \
    "$current_digest" == "$LEGACY_RECOVERY_IMAGE_DIGEST" && \
    "$recovery_image_id" == "$LEGACY_RECOVERY_RUNTIME_IMAGE_ID" && \
    "$current_commit" == "$LEGACY_RECOVERY_COMMIT" ]]
}

run_secret_preflight "$runtime_image_id" "$target_provider" "$target_versions" "$candidate_bundle_path" || fail DEPLOY_V3_PREFLIGHT_FAILED
if [[ "$DEPLOY_PROTOCOL" == 4 ]]; then
  run_secret_preflight "$recovery_image_id" "$current_provider" "$current_versions" "$current_bundle_path" || fail DEPLOY_V4_RECOVERY_PREFLIGHT_FAILED
elif ! run_secret_preflight "$recovery_image_id" "$request_provider" "$request_versions" "$candidate_bundle_path"; then
  if [[ "$last_preflight_legacy_failure" != true ]] || \
    ! legacy_disabled_recovery_preflight_allowed || \
    ! run_legacy_disabled_recovery_preflight "$recovery_image_id"; then
    fail DEPLOY_V3_RECOVERY_PREFLIGHT_FAILED
  fi
fi
if [[ "$DEPLOY_PROTOCOL" == 4 && "$target_access_mode" == device-approval ]]; then
  create_access_snapshot || fail DEPLOY_V4_ACCESS_SNAPSHOT_FAILED
  run_access_preflight "$runtime_image_id" "$target_provider" "$target_versions" "$candidate_bundle_path" "$target_access_mode" "$target_trusted_proxies" || fail DEPLOY_V4_ACCESS_PREFLIGHT_FAILED
  if [[ "$current_access_mode" == device-approval ]]; then
    run_access_preflight "$recovery_image_id" "$current_provider" "$current_versions" "$current_bundle_path" "$current_access_mode" "$current_trusted_proxies" || fail DEPLOY_V4_RECOVERY_ACCESS_PREFLIGHT_FAILED
  fi
fi
"$CONTRACT" ledger-commit "$VERSION_LEDGER" <"$prepared_file"

database_backup_path='none'
database_backup_checksum='none'
create_database_backup() {
  local timestamp temporary
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  database_backup_path="$BACKUP_DIR/${timestamp}-${target_commit}.sqlite"
  temporary="$(mktemp "$BACKUP_DIR/.backup-v3.XXXXXX")"
  if ! python3 - "$DATABASE" "$temporary" <<'PY'
import sqlite3, sys
source = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
destination = sqlite3.connect(sys.argv[2])
try:
    source.backup(destination)
    if destination.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise SystemExit(1)
finally:
    destination.close(); source.close()
PY
  then
    rm -f -- "$temporary"
    return 1
  fi
  chmod 0600 "$temporary" || { rm -f -- "$temporary"; return 1; }
  mv -f -- "$temporary" "$database_backup_path" || { rm -f -- "$temporary"; return 1; }
  if ! python3 - "$database_backup_path" <<'PY'
import sqlite3, sys
connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise SystemExit(1)
finally:
    connection.close()
PY
  then
    rm -f -- "$database_backup_path"
    return 1
  fi
  database_backup_checksum="$(sha256sum "$database_backup_path" | awk '{print $1}')" || {
    rm -f -- "$database_backup_path"
    return 1
  }
  [[ "$database_backup_checksum" =~ ^[0-9a-f]{64}$ ]] || {
    rm -f -- "$database_backup_path"
    return 1
  }
}

if [[ "$intent" != RESTORE ]]; then
  create_database_backup || fail DEPLOY_V3_DATABASE_BACKUP_FAILED
fi

candidate_state_file="$(mktemp "$RUN_ROOT/kinvest-v3.candidate-state.XXXXXX")"
chmod 0600 "$candidate_state_file"
if [[ "$intent" == RESTORE ]]; then
  restore_backup_path="$(json_field "$current_json" databaseBackupPath)"
  restore_backup_checksum="$(json_field "$current_json" databaseBackupChecksum)"
  if [[ -n "$attempt_json" ]]; then
    attempt_backup_path="$(json_field "$attempt_json" databaseBackupPath)"
    attempt_backup_checksum="$(json_field "$attempt_json" databaseBackupChecksum)"
    if [[ "$attempt_backup_path" != none ]]; then
      restore_backup_path="$attempt_backup_path"
      restore_backup_checksum="$attempt_backup_checksum"
    fi
  fi
  envelope_file="$(mktemp "$RUN_ROOT/kinvest-v3.restore-envelope.XXXXXX")"
  chmod 0600 "$envelope_file"
  make_approved_envelope "$current_json" "$envelope_file" "$current_access_mode" "$current_access_contract" "$current_trusted_proxies" "$current_proxy_checksum"
  "$CONTRACT" make-restore-state "$schema_before" "$restore_backup_path" "$restore_backup_checksum" <"$envelope_file" >"$candidate_state_file"
else
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ "$DEPLOY_PROTOCOL" == 4 ]]; then
    "$CONTRACT" make-state "$runtime_image_id" "$schema_before" "$target_schema_min" "$target_schema_max" \
      "$candidate_bundle_id" "$database_backup_path" "$database_backup_checksum" "$started_at" \
      "$target_access_contract" "$target_trusted_proxies" "$target_proxy_checksum" <"$base_file" >"$candidate_state_file"
  else
    "$CONTRACT" make-state "$runtime_image_id" "$schema_before" "$target_schema_min" "$target_schema_max" \
      "$candidate_bundle_id" "$database_backup_path" "$database_backup_checksum" "$started_at" \
      <"$base_file" >"$candidate_state_file"
  fi
fi

"$CONTRACT" atomic-state "$ATTEMPT_STATE" <"$candidate_state_file"
transaction_started='true'
if [[ "$intent" != RESTORE ]]; then
  "$CONTRACT" atomic-state "$PREVIOUS_STATE" <"$current_json"
fi

compose_up "$runtime_image_id" "$target_provider" "$target_versions" "$candidate_bundle_path" "$target_access_mode" "$target_trusted_proxies" >/dev/null || fail DEPLOY_V3_COMPOSE_FAILED
wait_for_container "$runtime_image_id" || fail DEPLOY_V3_HEALTH_FAILED
schema_after="$(read_schema_version)" || fail DEPLOY_V3_SCHEMA_READ_FAILED
if [[ "$DEPLOY_PROTOCOL" == 4 && "$intent" == RESTORE && "$schema_after" != "$current_schema_version" ]]; then
  fail RESTORE_SCHEMA_MISMATCH
fi
[[ "$schema_after" -ge "$target_schema_min" && "$schema_after" -le "$target_schema_max" ]] || fail ROLLBACK_REQUIRES_DB_RESTORE
verify_public_health || fail DEPLOY_V3_PUBLIC_HEALTH_FAILED
if [[ "$DEPLOY_PROTOCOL" == 4 ]]; then
  verify_access_behavior "$target_access_mode" || fail DEPLOY_V4_ACCESS_ACCEPTANCE_FAILED
fi

if [[ "$intent" != RESTORE ]]; then
  deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ "$DEPLOY_PROTOCOL" == 4 ]]; then
    "$CONTRACT" make-state "$runtime_image_id" "$schema_after" "$target_schema_min" "$target_schema_max" \
      "$candidate_bundle_id" "$database_backup_path" "$database_backup_checksum" "$deployed_at" \
      "$target_access_contract" "$target_trusted_proxies" "$target_proxy_checksum" <"$base_file" >"$candidate_state_file"
  else
    "$CONTRACT" make-state "$runtime_image_id" "$schema_after" "$target_schema_min" "$target_schema_max" \
      "$candidate_bundle_id" "$database_backup_path" "$database_backup_checksum" "$deployed_at" \
      <"$base_file" >"$candidate_state_file"
  fi
else
  make_approved_envelope "$current_json" "$envelope_file" "$current_access_mode" "$current_access_contract" "$current_trusted_proxies" "$current_proxy_checksum"
  "$CONTRACT" make-restore-state "$schema_after" "$restore_backup_path" "$restore_backup_checksum" <"$envelope_file" >"$candidate_state_file"
fi
candidate_bundle_keep='true'
"$CONTRACT" atomic-state "$CURRENT_STATE" <"$candidate_state_file"
current_committed='true'
rm -f -- "$ATTEMPT_STATE" || fail DEPLOY_V3_CLEANUP_PENDING 71
prune_unreferenced_bundles "$candidate_bundle_id" || fail DEPLOY_V3_CLEANUP_PENDING 71
deployment_succeeded='true'

printf 'KINVEST_DEPLOY_V%s_OK intent=%s commit=%s mode=%s contract=%s\n' "$DEPLOY_PROTOCOL" "$intent" "$target_commit" "$target_access_mode" "$target_access_contract"
