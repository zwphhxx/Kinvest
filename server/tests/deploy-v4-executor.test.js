const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const rootDir = path.resolve(__dirname, '../..')
const deployerSource = fs.readFileSync(path.join(rootDir, 'deploy/server/deploy-kinvest-v3.sh'), 'utf8')
const contractSource = fs.readFileSync(path.join(rootDir, 'deploy/server/deploy-v3-contract.py'), 'utf8')

const identities = Object.freeze({
  candidateDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'a'.repeat(64)}`,
  candidateId: `sha256:${'b'.repeat(64)}`,
  candidateCommit: 'c'.repeat(40),
  currentDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'1'.repeat(64)}`,
  currentId: `sha256:${'2'.repeat(64)}`,
  currentCommit: '3'.repeat(40),
  previousDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'4'.repeat(64)}`,
  previousId: `sha256:${'5'.repeat(64)}`,
  previousCommit: '6'.repeat(40)
})

function materials(seed, adminVersion, hmacVersion) {
  const admin = JSON.stringify({
    digest: Buffer.alloc(32, seed).toString('base64url'), format: 'kinvest-admin-scrypt-v1',
    n: 65536, p: 1, r: 8, salt: Buffer.alloc(16, seed + 1).toString('base64url')
  })
  const adminEncoded = Buffer.from(admin).toString('base64url')
  const hmac = Buffer.alloc(32, seed + 2).toString('base64url')
  return {
    admin: adminEncoded,
    hmac,
    adminVersion,
    hmacVersion,
    fingerprints: {
      adminPasswordVerifier: crypto.createHash('sha256').update(Buffer.from(adminEncoded, 'base64url')).digest('hex'),
      deviceTokenHmac: crypto.createHash('sha256').update(hmac).digest('hex')
    },
    versions: {
      adminPasswordVerifier: adminVersion,
      deviceTokenHmac: { accepted: [hmacVersion], active: hmacVersion }
    }
  }
}

const candidateMaterial = materials(1, 'v20260822-010', 'v20260822-011')
const currentMaterial = materials(8, 'v20260821-001', 'v20260821-002')

function payload({ intent = 'FORWARD', digest = identities.candidateDigest, commit = identities.candidateCommit, mode = 'device-approval', material = candidateMaterial, provider = 'github-tmpfs-v1' } = {}) {
  return [
    'KINVEST_DEPLOY_V4', intent, digest, commit,
    '{"artifactSource":"ghcr-public","releaseRecordSchemaVersion":2,"verificationRunId":"123"}',
    '{"host":"ghcr.io","mode":"ghcr-public","repository":"ghcr.io/zwphhxx/kinvest"}',
    provider,
    provider === 'disabled' ? '' : material.adminVersion,
    provider === 'disabled' ? '' : material.hmacVersion,
    provider === 'disabled' ? '' : material.admin,
    provider === 'disabled' ? '' : material.hmac,
    `{"accessControlMode":"${mode}","schemaVersion":1}`,
    'EOF'
  ].join('\n') + '\n'
}

function state({ image = 'current', device = false } = {}) {
  const identity = image === 'previous'
    ? { digest: identities.previousDigest, id: identities.previousId, commit: identities.previousCommit }
    : { digest: identities.currentDigest, id: identities.currentId, commit: identities.currentCommit }
  return {
    protocolVersion: 5,
    imageDigest: identity.digest,
    runtimeImageId: identity.id,
    commit: identity.commit,
    schemaVersion: 0,
    imageSchemaMin: 0,
    imageSchemaMax: 0,
    secretProviderMode: device ? 'github-tmpfs-v1' : 'disabled',
    secretVersionIds: device ? currentMaterial.versions : {},
    secretBundleId: device ? 'd'.repeat(32) : 'none',
    secretMaterialFingerprints: device ? currentMaterial.fingerprints : {},
    accessControlMode: device ? 'device-approval' : 'disabled',
    imageAccessControlContract: 1,
    trustedProxyAddresses: device ? ['172.19.0.2'] : [],
    trustedProxyConfigChecksum: device ? null : '',
    releaseRecordSchemaVersion: 2,
    verificationRunId: '100',
    artifactSource: 'ghcr-public',
    databaseBackupPath: 'none',
    databaseBackupChecksum: 'none',
    deployedAt: '2026-08-21T00:00:00Z'
  }
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function fakeCommands(bin) {
  writeExecutable(path.join(bin, 'id'), '#!/bin/sh\nif [ "${1:-}" = -u ]; then echo 0; else /usr/bin/id "$@"; fi\n')
  writeExecutable(path.join(bin, 'findmnt'), '#!/bin/sh\necho tmpfs\n')
  writeExecutable(path.join(bin, 'flock'), '#!/bin/sh\nexit 0\n')
  writeExecutable(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n')
  writeExecutable(path.join(bin, 'chown'), '#!/bin/sh\nexit 0\n')
  writeExecutable(path.join(bin, 'install'), `#!/usr/bin/env bash
set -e
if [[ " $* " == *" -d "* ]]; then
  after=false
  for arg in "$@"; do
    if [[ "$after" == true ]]; then mkdir -p "$arg"; fi
    [[ "$arg" == -- ]] && after=true
  done
  exit 0
fi
exit 1
`)
  writeExecutable(path.join(bin, 'timeout'), `#!/usr/bin/env bash
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    docker|"$OFFLINE_ATTESTATION") exec "$@" ;;
    *) shift ;;
  esac
done
exit 127
`)
  writeExecutable(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"$OPERATIONS"
command="$1"; shift
if [[ "$command" == image && "$1" == inspect ]]; then
  ref="$2"; format="$4"
  case "$ref" in
    "$CANDIDATE_DIGEST"|"$CANDIDATE_ID") image="$CANDIDATE_ID"; digest="$CANDIDATE_DIGEST" ;;
    "$CURRENT_DIGEST"|"$CURRENT_ID") image="$CURRENT_ID"; digest="$CURRENT_DIGEST" ;;
    "$PREVIOUS_DIGEST"|"$PREVIOUS_ID") image="$PREVIOUS_ID"; digest="$PREVIOUS_DIGEST" ;;
    *) exit 1 ;;
  esac
  case "$format" in
    *RepoDigests*) printf '["%s"]\n' "$digest" ;;
    *io.kinvest.schema.min*|*io.kinvest.schema.max*) echo 0 ;;
    *io.kinvest.secret-bootstrap*|*io.kinvest.access-control.contract*) echo 1 ;;
    *) echo "$image" ;;
  esac
  exit 0
fi
if [[ "$command" == inspect ]]; then
  format="$2"; target="\${@: -1}"
  if [[ "$target" == nginx ]]; then
    [[ "$format" == *State.Running* ]] && echo true || echo 172.19.0.2
    exit 0
  fi
  active="$(cat "$ACTIVE_IMAGE")"
  if [[ "$format" == *Health.Status* ]]; then
    if [[ "$FAILURE" == health && "$active" == "$CANDIDATE_ID" && ! -e "$FAILURE_MARKER" ]]; then
      : >"$FAILURE_MARKER"; echo unhealthy
    else
      echo healthy
    fi
  else
    echo "$active"
  fi
  exit 0
fi
if [[ "$command" == run ]]; then
  all="$*"; image='unknown'
  [[ "$all" == *"$CANDIDATE_ID"* ]] && image="$CANDIDATE_ID"
  [[ "$all" == *"$CURRENT_ID"* ]] && image="$CURRENT_ID"
  [[ "$all" == *"$PREVIOUS_ID"* ]] && image="$PREVIOUS_ID"
  if [[ "$all" == *server/access-preflight.js* ]]; then
    printf 'preflight access %s %s\n' "$image" "$all" >>"$PREFLIGHTS"
    echo 'KINVEST_ACCESS_PREFLIGHT_OK mode=device-approval references=2 database=ready proxy=ready'
  else
    printf 'preflight secret %s %s\n' "$image" "$all" >>"$PREFLIGHTS"
    if [[ "$all" == *KINVEST_SECRET_PROVIDER_MODE=disabled* ]]; then
      echo 'KINVEST_SECRET_PREFLIGHT_OK mode=disabled references=0'
    else
      echo 'KINVEST_SECRET_PREFLIGHT_OK mode=github-tmpfs-v1 references=2'
    fi
  fi
  exit 0
fi
if [[ "$command" == compose ]]; then
  all="$*"
  if [[ "$all" == *" up "* ]]; then
    printf '%s' "$KINVEST_IMAGE" >"$ACTIVE_IMAGE"
    printf '%s' "$KINVEST_ACCESS_CONTROL_MODE" >"$ACTIVE_MODE"
    printf 'compose up %s %s\n' "$KINVEST_IMAGE" "$KINVEST_ACCESS_CONTROL_MODE" >>"$OPERATIONS"
    if [[ "$FAILURE" == compose && "$KINVEST_IMAGE" == "$CANDIDATE_ID" && ! -e "$FAILURE_MARKER" ]]; then
      : >"$FAILURE_MARKER"; exit 1
    fi
  else
    printf 'compose down %s\n' "$KINVEST_IMAGE" >>"$OPERATIONS"
  fi
  exit 0
fi
exit 1
`)
  writeExecutable(path.join(bin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
out=''; url="\${@: -1}"; previous=''
for arg in "$@"; do
  [[ "$previous" == -o ]] && out="$arg"
  previous="$arg"
done
if [[ "$url" == */api/health ]]; then echo '{"status":"ok","service":"kinvest"}'; exit 0; fi
mode="$(cat "$ACTIVE_MODE")"; active="$(cat "$ACTIVE_IMAGE")"
if [[ "$url" == */api/watchlist ]]; then
  if [[ "$mode" == disabled ]]; then body='{"success":true}'; code=200
  elif [[ "$FAILURE" == auth && "$active" == "$CANDIDATE_ID" && ! -e "$AUTH_MARKER" ]]; then
    : >"$AUTH_MARKER"; body='{"error":"BROKEN"}'; code=401
  else body='{"error":"AUTH_REQUIRED"}'; code=401; fi
else body='{"authorized":false}'; code=200; fi
printf '%s' "$body" >"$out"; printf '%s' "$code"
`)
}

function createFixture({ failure, currentDevice = false }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-v4-executor-'))
  const serverRoot = path.join(base, 'server')
  const runRoot = path.join(base, 'run')
  const bin = path.join(base, 'bin')
  const stateDir = path.join(serverRoot, 'state')
  const bundleRoot = path.join(runRoot, 'kinvest-secrets')
  for (const directory of [stateDir, path.join(serverRoot, 'data'), path.join(serverRoot, 'backups'), runRoot, bin, bundleRoot]) fs.mkdirSync(directory, { recursive: true })
  fs.chmodSync(bundleRoot, 0o700)
  const contract = path.join(base, 'contract.py')
  const deployer = path.join(base, 'deployer.sh')
  const compose = path.join(serverRoot, 'docker-compose-v4.yml')
  const metadata = path.join(base, 'metadata.conf')
  const network = path.join(base, 'access-control-network.conf')
  const offline = path.join(base, 'offline-attestation')
  const activeImage = path.join(base, 'active-image')
  const activeMode = path.join(base, 'active-mode')
  const operations = path.join(base, 'operations.log')
  const preflights = path.join(base, 'preflights.log')
  const failureMarker = path.join(base, 'failure.marker')
  const authMarker = path.join(base, 'auth.marker')
  const contractLog = path.join(base, 'contract.log')
  fs.writeFileSync(compose, 'services: {}\n')
  fs.writeFileSync(path.join(serverRoot, 'docker-compose-v3.yml'), 'services: {}\n')
  fs.writeFileSync(metadata, 'KINVEST_METADATA_NETWORK=test\n')
  const networkBytes = Buffer.from('KINVEST_WEB_NETWORK=web\nKINVEST_NGINX_CONTAINER=nginx\nKINVEST_NGINX_IPV4=172.19.0.2\n')
  fs.writeFileSync(network, networkBytes, { mode: 0o600 })
  writeExecutable(offline, '#!/bin/sh\nexit 1\n')
  fs.writeFileSync(activeImage, identities.currentId)
  fs.writeFileSync(activeMode, currentDevice ? 'device-approval' : 'disabled')
  fs.writeFileSync(operations, '')
  fs.writeFileSync(preflights, '')
  fs.writeFileSync(contractLog, '')

  const uid = process.getuid()
  const gid = process.getgid()
  const instrumentedContract = contractSource
    .replace('BUNDLE_ROOT = Path("/run/kinvest-secrets")', `BUNDLE_ROOT = Path("${bundleRoot}")`)
    .replace('BUNDLE_UID = 0', `BUNDLE_UID = ${uid}`)
    .replace('BUNDLE_GID = 10001', `BUNDLE_GID = ${gid}`)
    .replace('bundle_root.parent != Path("/run")', `bundle_root.parent != Path("${runRoot}")`)
    .replace('info.st_uid != 0', `info.st_uid != ${uid}`)
    .replace('backup_path.startswith("/root/docker/kinvest/backups/")', `backup_path.startswith("${path.join(serverRoot, 'backups')}/")`)
    .replace('def main(argv: list[str]) -> int:', 'def main(argv: list[str]) -> int:\n    with open(os.environ["CONTRACT_LOG"], "a", encoding="ascii") as stream: stream.write(" ".join(argv[1:]) + "\\n")')
  fs.writeFileSync(contract, instrumentedContract, { mode: 0o755 })
  const instrumentedDeployer = deployerSource
    .replace("ROOT='/root/docker/kinvest'", `ROOT='${serverRoot}'`)
    .replace("RUN_ROOT='/run'", `RUN_ROOT='${runRoot}'`)
    .replace("CONTRACT='/usr/local/libexec/kinvest-deploy-v3-contract'", `CONTRACT='${contract}'`)
    .replace("OFFLINE_IMAGE_ATTESTATION='/usr/local/libexec/kinvest-offline-image-attestation'", `OFFLINE_IMAGE_ATTESTATION='${offline}'`)
    .replace("METADATA_NETWORK_CONFIG='/etc/kinvest/metadata-network.conf'", `METADATA_NETWORK_CONFIG='${metadata}'`)
    .replace("ACCESS_NETWORK_CONFIG='/etc/kinvest/access-control-network.conf'", `ACCESS_NETWORK_CONFIG='${network}'`)
  fs.writeFileSync(deployer, instrumentedDeployer, { mode: 0o755 })

  const database = path.join(serverRoot, 'data/kinvest.sqlite')
  const db = spawnSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA user_version=0"); c.commit(); c.close()', database], { encoding: 'utf8' })
  assert.equal(db.status, 0, db.stderr)
  const current = state({ device: currentDevice })
  if (currentDevice) current.trustedProxyConfigChecksum = crypto.createHash('sha256').update(networkBytes).digest('hex')
  const previous = state({ image: 'previous', device: false })
  function writeState(name, value) {
    const rendered = spawnSync('python3', [contract, 'canonical-state'], {
      encoding: 'utf8', input: JSON.stringify(value),
      env: { ...process.env, KINVEST_DEPLOY_PROTOCOL: '4', CONTRACT_LOG: contractLog }
    })
    assert.equal(rendered.status, 0, rendered.stderr)
    fs.writeFileSync(path.join(stateDir, name), rendered.stdout, { mode: 0o600 })
    return rendered.stdout
  }
  const currentText = writeState('current.state', current)
  const previousText = writeState('previous.state', previous)
  const currentBundle = currentDevice ? path.join(bundleRoot, current.secretBundleId) : path.join(bundleRoot, 'disabled')
  fs.mkdirSync(currentBundle)
  if (currentDevice) {
    for (const name of ['manifest.json', 'admin-password-verifier', 'device-token-hmac-key']) {
      fs.writeFileSync(path.join(currentBundle, name), 'fixture\n')
    }
  }
  fakeCommands(bin)
  return { base, bin, contract, contractLog, deployer, compose, current, currentText, previousText, bundleRoot, stateDir, activeImage, activeMode, operations, preflights, failureMarker, authMarker, failure }
}

function execute(context, input, protocol = '4') {
  return spawnSync('bash', [context.deployer], {
    encoding: 'utf8', input,
    env: {
      ...process.env,
      PATH: `${context.bin}:${process.env.PATH}`,
      KINVEST_DEPLOY_PROTOCOL: protocol,
      KINVEST_DEPLOY_CONTRACT: context.contract,
      KINVEST_DEPLOY_COMPOSE: context.compose,
      KINVEST_V4_TEST_ROOT_UID: String(process.getuid()),
      CANDIDATE_DIGEST: identities.candidateDigest, CANDIDATE_ID: identities.candidateId,
      CURRENT_DIGEST: identities.currentDigest, CURRENT_ID: identities.currentId,
      PREVIOUS_DIGEST: identities.previousDigest, PREVIOUS_ID: identities.previousId,
      ACTIVE_IMAGE: context.activeImage, ACTIVE_MODE: context.activeMode,
      OPERATIONS: context.operations, PREFLIGHTS: context.preflights,
      FAILURE: context.failure, FAILURE_MARKER: context.failureMarker, AUTH_MARKER: context.authMarker,
      OFFLINE_ATTESTATION: path.join(context.base, 'offline-attestation')
      , CONTRACT_LOG: context.contractLog
    }
  })
}

function assertRecovered(context, result) {
  assert.notEqual(result.status, 0)
  assert.equal(fs.readFileSync(path.join(context.stateDir, 'current.state'), 'utf8'), context.currentText)
  assert.equal(fs.readFileSync(path.join(context.stateDir, 'previous.state'), 'utf8'), context.previousText)
  assert.equal(fs.existsSync(path.join(context.stateDir, 'attempt.state')), false)
  assert.equal(fs.readFileSync(context.activeImage, 'utf8'), identities.currentId)
  assert.equal(fs.readFileSync(context.activeMode, 'utf8'), context.current.accessControlMode)
  const bundles = fs.readdirSync(context.bundleRoot).sort()
  assert.deepEqual(bundles, [context.current.secretBundleId === 'none' ? 'disabled' : context.current.secretBundleId])
  const operations = fs.readFileSync(context.operations, 'utf8')
  assert.match(
    operations,
    new RegExp(`compose up ${identities.currentId} ${context.current.accessControlMode}`),
    `${result.stderr}\n${operations}\n${fs.readFileSync(context.preflights, 'utf8')}\n${fs.readFileSync(context.contractLog, 'utf8')}`
  )
  const combined = result.stdout + result.stderr + operations
  for (const secret of [candidateMaterial.admin, candidateMaterial.hmac]) assert.equal(combined.includes(secret), false)
}

function parsedState(context, name) {
  const result = spawnSync('python3', [context.contract, 'parse-state'], {
    encoding: 'utf8',
    input: fs.readFileSync(path.join(context.stateDir, name), 'utf8'),
    env: { ...process.env, KINVEST_DEPLOY_PROTOCOL: '4', CONTRACT_LOG: context.contractLog }
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function assertSuccessfulIntent(context, result, { imageId, imageDigest, commit, previousText }) {
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.existsSync(path.join(context.stateDir, 'attempt.state')), false)
  assert.equal(fs.readFileSync(context.activeImage, 'utf8'), imageId)
  assert.equal(fs.readFileSync(context.activeMode, 'utf8'), 'device-approval')
  assert.equal(fs.readFileSync(path.join(context.stateDir, 'previous.state'), 'utf8'), previousText)
  const current = parsedState(context, 'current.state')
  assert.equal(current.runtimeImageId, imageId)
  assert.equal(current.imageDigest, imageDigest)
  assert.equal(current.commit, commit)
  assert.equal(current.secretProviderMode, 'github-tmpfs-v1')
  assert.deepEqual(current.secretVersionIds, context.expectedMaterial.versions)
  assert.deepEqual(current.secretMaterialFingerprints, context.expectedMaterial.fingerprints)
  assert.equal(current.accessControlMode, 'device-approval')
  assert.deepEqual(current.trustedProxyAddresses, ['172.19.0.2'])
  assert.match(current.secretBundleId, /^[0-9a-f]{32}$/)
  assert.equal(fs.existsSync(path.join(context.bundleRoot, current.secretBundleId)), true)
  for (const secret of [context.expectedMaterial.admin, context.expectedMaterial.hmac]) {
    assert.equal((result.stdout + result.stderr).includes(secret), false)
  }
}

async function run() {
  for (const scenario of [
    { failure: 'compose', currentDevice: false },
    { failure: 'health', currentDevice: false },
    { failure: 'auth', currentDevice: true }
  ]) {
    const context = createFixture(scenario)
    try {
      const result = execute(context, payload())
      assertRecovered(context, result)
      const preflights = fs.readFileSync(context.preflights, 'utf8')
      assert.match(preflights, new RegExp(`preflight secret ${identities.candidateId}`))
      assert.match(preflights, new RegExp(`preflight secret ${identities.currentId}`))
      assert.match(preflights, new RegExp(`preflight access ${identities.candidateId}`))
      if (scenario.currentDevice) assert.match(preflights, new RegExp(`preflight access ${identities.currentId}`))
    } finally {
      spawnSync('/bin/rm', ['-rf', context.base])
    }
  }

  const forward = createFixture({ failure: 'none', currentDevice: false })
  forward.expectedMaterial = candidateMaterial
  try {
    const result = execute(forward, payload())
    assertSuccessfulIntent(forward, result, {
      imageId: identities.candidateId,
      imageDigest: identities.candidateDigest,
      commit: identities.candidateCommit,
      previousText: forward.currentText
    })
  } finally {
    spawnSync('/bin/rm', ['-rf', forward.base])
  }

  const rollback = createFixture({ failure: 'none', currentDevice: true })
  rollback.expectedMaterial = currentMaterial
  try {
    const result = execute(rollback, payload({
      intent: 'ROLLBACK', digest: identities.previousDigest, commit: identities.previousCommit,
      material: currentMaterial
    }))
    assertSuccessfulIntent(rollback, result, {
      imageId: identities.previousId,
      imageDigest: identities.previousDigest,
      commit: identities.previousCommit,
      previousText: rollback.currentText
    })
    const preflights = fs.readFileSync(rollback.preflights, 'utf8')
    assert.match(preflights, new RegExp(`preflight access ${identities.previousId}`))
    assert.match(preflights, new RegExp(`preflight access ${identities.currentId}`))
  } finally {
    spawnSync('/bin/rm', ['-rf', rollback.base])
  }

  const restore = createFixture({ failure: 'none', currentDevice: true })
  restore.expectedMaterial = currentMaterial
  try {
    const result = execute(restore, payload({
      intent: 'RESTORE', digest: identities.currentDigest, commit: identities.currentCommit,
      material: currentMaterial
    }))
    assertSuccessfulIntent(restore, result, {
      imageId: identities.currentId,
      imageDigest: identities.currentDigest,
      commit: identities.currentCommit,
      previousText: restore.previousText
    })
  } finally {
    spawnSync('/bin/rm', ['-rf', restore.base])
  }

  const guard = createFixture({ failure: 'none' })
  try {
    const sentinel = 'SECRET_SENTINEL_MUST_NOT_BE_READ'
    const result = execute(guard, sentinel, '3')
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'DEPLOY_V3_PROTOCOL_RETIRED\n')
    assert.equal((result.stdout + result.stderr).includes(sentinel), false)
    assert.equal(fs.readFileSync(guard.preflights, 'utf8'), '')
  } finally {
    spawnSync('/bin/rm', ['-rf', guard.base])
  }
}

module.exports = { run }
