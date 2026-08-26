const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const rootDir = path.resolve(__dirname, '../..')
const executorPath = path.join(rootDir, 'deploy/server/deploy-kinvest-v5')

const DIGEST = `ghcr.io/zwphhxx/kinvest@sha256:${'a'.repeat(64)}`
const IMAGE_ID = `sha256:${'b'.repeat(64)}`
const CURRENT_DIGEST = `ghcr.io/zwphhxx/kinvest@sha256:${'c'.repeat(64)}`
const CURRENT_ID = `sha256:${'d'.repeat(64)}`
const COMMIT = 'e'.repeat(40)
const CURRENT_COMMIT = 'f'.repeat(40)
const TOKEN = 'synthetic-ifind-refresh-token-never-log'
const ADMIN_VERSION = 'v20260826-010'
const HMAC_VERSION = 'v20260826-011'
const ADMIN_JSON = JSON.stringify({
  digest: Buffer.alloc(32, 1).toString('base64url'),
  format: 'kinvest-admin-scrypt-v1', n: 65536, p: 1, r: 8,
  salt: Buffer.alloc(16, 2).toString('base64url')
})
const ADMIN_MATERIAL = Buffer.from(ADMIN_JSON).toString('base64url')
const HMAC_MATERIAL = Buffer.alloc(32, 3).toString('base64url')
const ACCESS_FINGERPRINTS = {
  adminPasswordVerifier: crypto.createHash('sha256').update(Buffer.from(ADMIN_MATERIAL, 'base64url')).digest('hex'),
  deviceTokenHmac: crypto.createHash('sha256').update(HMAC_MATERIAL).digest('hex')
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function canonicalState(contract, value) {
  const result = spawnSync(process.env.PYTHON || 'python3', [contract, 'canonical-state'], {
    encoding: 'utf8', input: `${JSON.stringify(value)}\n`,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

function currentState() {
  return {
    protocolVersion: 6, imageDigest: CURRENT_DIGEST, runtimeImageId: CURRENT_ID,
    commit: CURRENT_COMMIT, schemaVersion: 0, imageSchemaMin: 0, imageSchemaMax: 0,
    secretProviderMode: 'github-tmpfs-v1',
    secretVersionIds: {
      adminPasswordVerifier: ADMIN_VERSION,
      deviceTokenHmac: { accepted: [HMAC_VERSION], active: HMAC_VERSION }
    },
    secretBundleId: '1'.repeat(32), secretMaterialFingerprints: ACCESS_FINGERPRINTS,
    accessControlMode: 'device-approval', imageAccessControlContract: 1,
    trustedProxyAddresses: ['172.19.0.2'], trustedProxyConfigChecksum: '2'.repeat(64),
    ifindDiagnosticMode: 'disabled', ifindRefreshTokenVersionId: '',
    ifindSecretBundleId: 'none', ifindSecretMaterialFingerprint: '',
    releaseRecordSchemaVersion: 2, verificationRunId: '1', artifactSource: 'ghcr-public',
    databaseBackupPath: 'none', databaseBackupChecksum: 'none',
    deployedAt: '2026-08-26T00:00:00Z'
  }
}

function diagnosticPayload() {
  return [
    'KINVEST_DEPLOY_V5', 'FORWARD', DIGEST, COMMIT,
    '{"artifactSource":"ghcr-public","releaseRecordSchemaVersion":2,"verificationRunId":"123"}',
    '{"host":"ghcr.io","mode":"ghcr-public","repository":"ghcr.io/zwphhxx/kinvest"}',
    'github-tmpfs-v1', ADMIN_VERSION, HMAC_VERSION, ADMIN_MATERIAL, HMAC_MATERIAL,
    '{"accessControlMode":"device-approval","schemaVersion":1}',
    'diagnostic', 'v20260826-001', TOKEN, 'EOF'
  ].join('\n') + '\n'
}

function disabledPayload() {
  return [
    'KINVEST_DEPLOY_V5', 'FORWARD', DIGEST, COMMIT,
    '{"artifactSource":"ghcr-public","releaseRecordSchemaVersion":2,"verificationRunId":"123"}',
    '{"host":"ghcr.io","mode":"ghcr-public","repository":"ghcr.io/zwphhxx/kinvest"}',
    'github-tmpfs-v1', ADMIN_VERSION, HMAC_VERSION, ADMIN_MATERIAL, HMAC_MATERIAL,
    '{"accessControlMode":"device-approval","schemaVersion":1}',
    'disabled', '', '', 'EOF'
  ].join('\n') + '\n'
}

function makeHarness() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-deploy-v5-test-'))
  const root = path.join(temp, 'root')
  const runRoot = path.join(temp, 'run')
  const bin = path.join(temp, 'bin')
  const libexec = path.join(temp, 'libexec')
  const operations = path.join(temp, 'operations.log')
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.mkdirSync(path.join(root, 'state'), { recursive: true })
  fs.mkdirSync(path.join(root, 'backups'), { recursive: true })
  fs.mkdirSync(runRoot)
  fs.mkdirSync(bin)
  fs.mkdirSync(libexec)
  fs.copyFileSync(path.join(rootDir, 'deploy/server/docker-compose-v5.yml'), path.join(root, 'docker-compose-v5.yml'))
  const sourceContract = path.join(rootDir, 'deploy/server/deploy-v5-contract.py')
  const contract = path.join(libexec, 'deploy-v5-contract.py')
  writeExecutable(contract, fs.readFileSync(sourceContract, 'utf8')
    .replace('/root/docker/kinvest/backups', path.join(root, 'backups')))
  fs.writeFileSync(path.join(root, 'state/current.state'), canonicalState(contract, currentState()))
  spawnSync(process.env.PYTHON || 'python3', ['-c',
    'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("PRAGMA user_version=0"); db.commit(); db.close()',
    path.join(root, 'data/kinvest.sqlite')], { encoding: 'utf8' })

  const transformed = fs.readFileSync(executorPath, 'utf8')
    .replace("ROOT='/root/docker/kinvest'", `ROOT='${root}'`)
    .replace("RUN_ROOT='/run'", `RUN_ROOT='${runRoot}'`)
    .replace("CONTRACT='/usr/local/libexec/kinvest-deploy-v5-contract'", `CONTRACT='${contract}'`)
    .replace("OFFLINE_ATTESTATION='/usr/local/libexec/kinvest-offline-image-attestation'", `OFFLINE_ATTESTATION='${libexec}/attestation'`)
    .replace("NETWORK_CONFIG='/etc/kinvest/metadata-network.conf'", `NETWORK_CONFIG='${temp}/network.conf'`)
    .replace("PUBLIC_HEALTH_URL='https://dearmina.cn/api/health'", "PUBLIC_HEALTH_URL='https://example.invalid/api/health'")
    .replaceAll('os.chown(path, 0, 10001, follow_symlinks=False)', 'pass')
    .replaceAll('os.chown(bundle, 0, 10001)', 'pass')
  const executor = path.join(temp, 'deploy-v5')
  writeExecutable(executor, transformed)
  fs.writeFileSync(path.join(temp, 'network.conf'), 'KINVEST_CONTAINER_IP=172.18.0.2\n')

  writeExecutable(path.join(bin, 'id'), '#!/bin/sh\necho 0\n')
  writeExecutable(path.join(bin, 'findmnt'), '#!/bin/sh\necho tmpfs\n')
  writeExecutable(path.join(bin, 'flock'), '#!/bin/sh\nexit 0\n')
  writeExecutable(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n')
  writeExecutable(path.join(bin, 'shred'), '#!/bin/sh\nfor x in "$@"; do case "$x" in -*) ;; *) rm -f -- "$x" 2>/dev/null || true;; esac; done\n')
  writeExecutable(path.join(bin, 'install'), `#!/usr/bin/env bash
after=false
for value in "$@"; do
  if [[ "$after" == true ]]; then mkdir -p "$value"; fi
  [[ "$value" == -- ]] && after=true
done
exit 0
`)
  writeExecutable(path.join(bin, 'curl'), '#!/bin/sh\nexit 0\n')
  writeExecutable(path.join(bin, 'timeout'), `#!/usr/bin/env bash
while [[ "$#" -gt 0 ]]; do
  case "$1" in --signal=*|--kill-after=*|[0-9]*s) shift ;; *) exec "$@" ;; esac
done
exit 127
`)
  writeExecutable(path.join(libexec, 'attestation'), `#!/bin/sh
printf '%s\n' '${IMAGE_ID}'
`)
  writeExecutable(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf 'docker' >>'${operations}'
printf ' %q' "$@" >>'${operations}'
printf '\n' >>'${operations}'
command="$1"; shift
if [[ "$command" == image && "$1" == inspect ]]; then
  ref="$2"; format="$4"
  if [[ "$ref" == '${CURRENT_ID}' || "$ref" == '${CURRENT_DIGEST}' ]]; then id='${CURRENT_ID}'; digest='${CURRENT_DIGEST}'; else id='${IMAGE_ID}'; digest='${DIGEST}'; fi
  case "$format" in
    *RepoDigests*) printf '["%s"]\n' "$digest" ;;
    *io.kinvest.schema.min*|*io.kinvest.schema.max*) echo 0 ;;
    *io.kinvest.access-control.contract*|*io.kinvest.ifind-secret-bootstrap*) echo 1 ;;
    *) echo "$id" ;;
  esac
elif [[ "$command" == run ]]; then
  [[ " $* " == *' --network none '* && " $* " == *' --read-only '* && " $* " == *' --cap-drop ALL '* && " $* " == *' --user 10001:10001 '* ]] || exit 64
  if [[ "\${FAKE_FAILURE:-}" == ifind-preflight && "$*" == *"server/ifind-secret-preflight.js"* ]]; then exit 1; fi
  exit 0
elif [[ "$command" == compose ]]; then
  exit 0
elif [[ "$command" == inspect ]]; then
  format="$2"
  [[ "$format" == *Health.Status* ]] && echo healthy || echo '${IMAGE_ID}'
else
  exit 1
fi
`)
  return { temp, root, runRoot, bin, executor, operations }
}

function scanPersistentFiles(root) {
  const findings = []
  function visit(input) {
    const stat = fs.lstatSync(input)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(input)) visit(path.join(input, name))
    } else if (stat.isFile() && fs.readFileSync(input).includes(Buffer.from(TOKEN))) {
      findings.push(input)
    }
  }
  visit(root)
  return findings
}

async function run() {
  assert.equal(fs.existsSync(executorPath), true, 'deploy-v5 executor must exist')
  const syntax = spawnSync('bash', ['-n', executorPath], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)

  const source = fs.readFileSync(executorPath, 'utf8')
  assert.match(source, /KINVEST_DEPLOY_PROTOCOL='5'/)
  assert.match(source, /KINVEST_DEPLOY_V5/)
  assert.match(source, /IFIND_BUNDLE_ROOT="\$RUN_ROOT\/kinvest-ifind-secrets"/)
  assert.match(source, /io\.kinvest\.ifind-secret-bootstrap/)
  assert.match(source, /server\/ifind-secret-preflight\.js/)
  assert.match(source, /--network none/)
  assert.match(source, /--read-only/)
  assert.match(source, /--cap-drop ALL/)
  assert.match(source, /--user 10001:10001/)
  assert.match(source, /O_NOFOLLOW/)
  assert.match(source, /ROLLBACK_REQUIRES_DB_RESTORE/)
  assert.match(source, /DEPLOY_V5_IFIND_PREFLIGHT_FAILED/)
  assert.match(source, /resolve_offline_image/)
  assert.match(source, /verify_repo_digest/)

  const preflightAt = source.indexOf('run_ifind_preflight')
  const backupAt = source.indexOf('create_database_backup')
  const composeAt = source.indexOf('compose_up')
  assert.ok(preflightAt >= 0 && backupAt > preflightAt && composeAt > backupAt,
    'iFinD preflight function must be defined before backup and compose')

  assert.match(source, /trap cleanup EXIT/)
  assert.match(source, /prune_ifind_bundles/)
  assert.match(source, /RESTORE/)
  assert.match(source, /ROLLBACK/)
  assert.match(source, /FORWARD/)

  const token = 'synthetic-ifind-refresh-token-never-log'
  for (const relative of [
    'deploy/server/deploy-kinvest-v5',
    'deploy/server/docker-compose-v5.yml',
    'server/ifind-secret-preflight.js'
  ]) {
    assert.equal(fs.readFileSync(path.join(rootDir, relative), 'utf8').includes(token), false)
  }

  const v4 = fs.readFileSync(path.join(rootDir, 'deploy/server/deploy-kinvest-v3.sh'), 'utf8')
  assert.match(v4, /if \[\[ "\$DEPLOY_PROTOCOL" == 4 \]\]/)
  assert.doesNotMatch(v4, /KINVEST_DEPLOY_PROTOCOL:-5/)

  const harness = makeHarness()
  try {
    const executable = process.env.KINVEST_TEST_TRACE === '1' ? 'bash' : harness.executor
    const args = process.env.KINVEST_TEST_TRACE === '1' ? ['-x', harness.executor] : []
    const deployed = spawnSync(executable, args, {
      encoding: 'utf8', input: diagnosticPayload(),
      env: { ...process.env, PATH: `${harness.bin}:${process.env.PATH}` },
      maxBuffer: 1024 * 1024
    })
    assert.equal(deployed.status, 0, JSON.stringify({
      stderr: deployed.stderr, stdout: deployed.stdout, signal: deployed.signal,
      operations: fs.existsSync(harness.operations) ? fs.readFileSync(harness.operations, 'utf8') : ''
    }))
    assert.match(deployed.stdout, /KINVEST_DEPLOY_V5_OK/)
    assert.equal(deployed.stdout.includes(TOKEN), false)
    assert.equal(deployed.stderr.includes(TOKEN), false)
    const operations = fs.readFileSync(harness.operations, 'utf8')
    assert.equal(operations.includes(TOKEN), false)
    assert.ok(operations.indexOf('server/ifind-secret-preflight.js') < operations.indexOf(' compose '))
    assert.deepEqual(scanPersistentFiles(harness.root), [])
    const state = fs.readFileSync(path.join(harness.root, 'state/current.state'), 'utf8')
    assert.match(state, /ifindDiagnosticMode=diagnostic/)
    assert.match(state, /ifindRefreshTokenVersionId=v20260826-001/)
    assert.doesNotMatch(state, new RegExp(TOKEN))
    const previous = spawnSync(process.env.PYTHON || 'python3', [
      path.join(harness.temp, 'libexec/deploy-v5-contract.py'), 'parse-state'
    ], {
      encoding: 'utf8', input: fs.readFileSync(path.join(harness.root, 'state/previous.state'), 'utf8'),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    })
    assert.equal(previous.status, 0, previous.stderr)
    assert.match(source, /mktemp "\$STATE_ROOT\/\.current-v5\./)
    const bundles = fs.readdirSync(path.join(harness.runRoot, 'kinvest-ifind-secrets'))
    assert.equal(bundles.length, 1)
  } finally {
    for (const bundleRoot of ['kinvest-secrets', 'kinvest-ifind-secrets']) {
      const fullRoot = path.join(harness.runRoot, bundleRoot)
      if (fs.existsSync(fullRoot)) {
        for (const name of fs.readdirSync(fullRoot)) {
          try { fs.chmodSync(path.join(fullRoot, name), 0o700) } catch {
            // Best-effort cleanup must not replace the test result.
          }
        }
      }
    }
    fs.rmSync(harness.temp, { recursive: true, force: true })
  }

  const disabled = makeHarness()
  try {
    const deployed = spawnSync(disabled.executor, [], {
      encoding: 'utf8', input: disabledPayload(),
      env: { ...process.env, PATH: `${disabled.bin}:${process.env.PATH}` }
    })
    assert.equal(deployed.status, 0, JSON.stringify({
      stderr: deployed.stderr, stdout: deployed.stdout,
      operations: fs.existsSync(disabled.operations) ? fs.readFileSync(disabled.operations, 'utf8') : ''
    }))
    assert.equal(fs.readdirSync(path.join(disabled.runRoot, 'kinvest-ifind-secrets')).length, 0)
    const operations = fs.readFileSync(disabled.operations, 'utf8')
    assert.equal(operations.includes('server/ifind-secret-preflight.js'), false)
    assert.match(operations, /kinvest-disabled/)
  } finally {
    for (const rootName of ['kinvest-secrets', 'kinvest-ifind-secrets']) {
      const fullRoot = path.join(disabled.runRoot, rootName)
      if (fs.existsSync(fullRoot)) for (const name of fs.readdirSync(fullRoot)) {
        try { fs.chmodSync(path.join(fullRoot, name), 0o700) } catch {
          // Best-effort cleanup must not replace the test result.
        }
      }
    }
    fs.rmSync(disabled.temp, { recursive: true, force: true })
  }

  const failed = makeHarness()
  try {
    const deployed = spawnSync(failed.executor, [], {
      encoding: 'utf8', input: diagnosticPayload(),
      env: { ...process.env, PATH: `${failed.bin}:${process.env.PATH}`, FAKE_FAILURE: 'ifind-preflight' }
    })
    assert.notEqual(deployed.status, 0)
    assert.equal(deployed.stderr, 'DEPLOY_V5_IFIND_PREFLIGHT_FAILED\n')
    assert.equal(fs.readdirSync(path.join(failed.root, 'backups')).length, 0)
    assert.equal(fs.readdirSync(path.join(failed.runRoot, 'kinvest-ifind-secrets')).length, 0)
    assert.match(fs.readFileSync(path.join(failed.root, 'state/current.state'), 'utf8'),
      new RegExp(`runtimeImageId=${CURRENT_ID}`))
  } finally {
    for (const rootName of ['kinvest-secrets', 'kinvest-ifind-secrets']) {
      const fullRoot = path.join(failed.runRoot, rootName)
      if (fs.existsSync(fullRoot)) for (const name of fs.readdirSync(fullRoot)) {
        try { fs.chmodSync(path.join(fullRoot, name), 0o700) } catch {
          // Best-effort cleanup must not replace the test result.
        }
      }
    }
    fs.rmSync(failed.temp, { recursive: true, force: true })
  }
}

module.exports = { run }
