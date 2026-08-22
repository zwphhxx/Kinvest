#!/usr/bin/env bash
set -euo pipefail

fail() { printf '%s\n' "${1:-KINVEST_ACCESS_PREFLIGHT_RUNTIME_SMOKE_FAILED}" >&2; exit 1; }
[[ "$#" -eq 1 && "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,255}$ ]] || fail KINVEST_ACCESS_PREFLIGHT_RUNTIME_SMOKE_USAGE
image="$1"
fixture="$(mktemp -d)"
stdout_file="$fixture/stdout"
stderr_file="$fixture/stderr"
candidate="$fixture/candidate.sqlite"
bundle="$fixture/secrets"
cleanup() {
  local status=$? cleanup_script
  trap - EXIT HUP INT TERM
  cleanup_script='const fs=require("node:fs"),path=require("node:path");const target="/fixture/secrets";if(fs.existsSync(target)){fs.chmodSync(target,0o700);for(const entry of fs.readdirSync(target)){fs.rmSync(path.join(target,entry),{recursive:true,force:true})}fs.chmodSync(target,0o755)}'
  if [[ -e "$bundle" ]]; then
    docker run --rm --platform linux/amd64 --user 0:0 --read-only --cap-drop ALL \
      --security-opt no-new-privileges:true --network none --volume "$fixture:/fixture" \
      --entrypoint node "$image" -e "$cleanup_script" > /dev/null 2>&1 || status=1
  fi
  rm -rf -- "$fixture" || status=1
  return "$status"
}
trap cleanup EXIT HUP INT TERM
chmod 0755 "$fixture"

cat >"$fixture/prepare.js" <<'JS'
const crypto = require('node:crypto')
const fs = require('node:fs')
const { DatabaseSync } = require('node:sqlite')
const version = 'v20000101-001'
const database = new DatabaseSync('/fixture/candidate.sqlite')
database.exec('CREATE TABLE smoke_payload (value BLOB NOT NULL); INSERT INTO smoke_payload VALUES (zeroblob(2097152));')
database.close()
const admin = Buffer.from(JSON.stringify({
  digest: Buffer.alloc(32, 1).toString('base64url'), format: 'kinvest-admin-scrypt-v1',
  n: 65536, p: 1, r: 8, salt: Buffer.alloc(16, 2).toString('base64url')
}))
const hmac = Buffer.from(Buffer.alloc(32, 3).toString('base64url'))
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const manifest = Buffer.from(JSON.stringify({
  format: 'kinvest-github-tmpfs-v1',
  adminPasswordVerifier: { file: 'admin-password-verifier', versionId: version, sha256: sha256(admin) },
  deviceTokenHmac: { file: 'device-token-hmac-key', versionId: version, sha256: sha256(hmac) }
}))
fs.mkdirSync('/fixture/secrets', { mode: 0o700 })
for (const [name, value] of [['manifest.json', manifest], ['admin-password-verifier', admin], ['device-token-hmac-key', hmac]]) {
  const target = `/fixture/secrets/${name}`
  fs.writeFileSync(target, value, { mode: 0o440 })
  fs.chownSync(target, 0, 10001)
  fs.chmodSync(target, 0o440)
}
fs.chownSync('/fixture/secrets', 0, 10001)
fs.chmodSync('/fixture/secrets', 0o550)
fs.chownSync('/fixture/candidate.sqlite', 10001, 10001)
fs.chmodSync('/fixture/candidate.sqlite', 0o440)
JS

docker run --rm --platform linux/amd64 --user 0:0 --volume "$fixture:/fixture" --entrypoint node "$image" /fixture/prepare.js > /dev/null 2>"$stderr_file" || fail KINVEST_ACCESS_PREFLIGHT_RUNTIME_SMOKE_FIXTURE_FAILED
rm -f -- "$fixture/prepare.js"

version_config='{"adminPasswordVerifier":"v20000101-001","deviceTokenHmac":{"accepted":["v20000101-001"],"active":"v20000101-001"}}'
common=(
  run --rm --platform linux/amd64 --user 10001:10001 --read-only --cap-drop ALL
  --security-opt no-new-privileges:true --network none
  --ulimit fsize=268435456:268435456
  --env KINVEST_SECRET_PROVIDER_MODE=github-tmpfs-v1
  --env "KINVEST_SECRET_VERSION_IDS=$version_config"
  --env NODE_NO_WARNINGS=1
  --env KINVEST_SECRET_BUNDLE_PATH=/run/secrets/kinvest
  --env KINVEST_ACCESS_CONTROL_MODE=device-approval
  --env 'KINVEST_TRUSTED_PROXY_ADDRESSES=["127.0.0.1"]'
  --volume "$bundle:/run/secrets/kinvest:ro"
  --volume "$candidate:/preflight/candidate.sqlite:ro"
)

run_case() {
  local name="$1" expected_error="$2" tmpfs="$3" production="$4" candidate_argument="$5" status=0
  shift 5
  : >"$stdout_file"
  : >"$stderr_file"
  local command=(docker "${common[@]}")
  [[ "$tmpfs" == none ]] || command+=(--tmpfs "$tmpfs")
  command+=(--env "KINVEST_DB_PATH=$production")
  command+=(--entrypoint node "$image" server/access-preflight.js)
  [[ "$candidate_argument" == none ]] || command+=("$candidate_argument")
  "${command[@]}" >"$stdout_file" 2>"$stderr_file" || status=$?
  if [[ -z "$expected_error" ]]; then
    [[ "$status" -eq 0 ]] || fail "KINVEST_ACCESS_PREFLIGHT_RUNTIME_SMOKE_${name}_FAILED"
    [[ "$(cat "$stdout_file")" == 'KINVEST_ACCESS_PREFLIGHT_OK mode=device-approval references=2 database=ready proxy=ready' ]] || fail "KINVEST_ACCESS_PREFLIGHT_RUNTIME_SMOKE_${name}_STDOUT"
    [[ ! -s "$stderr_file" ]] || fail "KINVEST_ACCESS_PREFLIGHT_RUNTIME_SMOKE_${name}_STDERR"
  else
    [[ "$status" -ne 0 && ! -s "$stdout_file" && "$(cat "$stderr_file")" == "$expected_error" ]] || fail "KINVEST_ACCESS_PREFLIGHT_RUNTIME_SMOKE_${name}_FAIL_OPEN"
  fi
}

run_case success '' '/tmp:rw,noexec,nosuid,nodev,uid=10001,gid=10001,mode=0700,size=512m' /data/kinvest.sqlite /preflight/candidate.sqlite
run_case missing-candidate-argument ACCESS_PREFLIGHT_DATABASE_PATH_REQUIRED '/tmp:rw,noexec,nosuid,nodev,uid=10001,gid=10001,mode=0700,size=512m' /data/kinvest.sqlite none
run_case candidate-equals-production ACCESS_PREFLIGHT_DATABASE_PATH_INVALID '/tmp:rw,noexec,nosuid,nodev,uid=10001,gid=10001,mode=0700,size=512m' /preflight/candidate.sqlite /preflight/candidate.sqlite
run_case missing-tmpfs ACCESS_PREFLIGHT_DATABASE_PATH_INVALID none /data/kinvest.sqlite /preflight/candidate.sqlite
run_case insufficient-tmpfs ACCESS_PREFLIGHT_DATABASE_SNAPSHOT_INVALID '/tmp:rw,noexec,nosuid,nodev,uid=10001,gid=10001,mode=0700,size=1m' /data/kinvest.sqlite /preflight/candidate.sqlite
printf '%s\n' KINVEST_ACCESS_PREFLIGHT_RUNTIME_SMOKE_OK
