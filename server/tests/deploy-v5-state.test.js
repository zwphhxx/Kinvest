const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const contractPath = path.join(rootDir, 'deploy/server/deploy-v5-contract.py')

function runContract(command, input) {
  return spawnSync('python3', [contractPath, command], {
    encoding: 'utf8',
    input: typeof input === 'string' ? input : `${JSON.stringify(input)}\n`,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    maxBuffer: 128 * 1024
  })
}

function state(overrides = {}) {
  return {
    protocolVersion: 6,
    imageDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'a'.repeat(64)}`,
    runtimeImageId: `sha256:${'b'.repeat(64)}`,
    commit: 'c'.repeat(40),
    schemaVersion: 0,
    imageSchemaMin: 0,
    imageSchemaMax: 0,
    secretProviderMode: 'github-tmpfs-v1',
    secretVersionIds: {
      adminPasswordVerifier: 'v20260826-001',
      deviceTokenHmac: { accepted: ['v20260826-002'], active: 'v20260826-002' }
    },
    secretBundleId: 'd'.repeat(32),
    secretMaterialFingerprints: {
      adminPasswordVerifier: 'e'.repeat(64),
      deviceTokenHmac: 'f'.repeat(64)
    },
    accessControlMode: 'device-approval',
    imageAccessControlContract: 1,
    trustedProxyAddresses: ['172.19.0.2'],
    trustedProxyConfigChecksum: '1'.repeat(64),
    ifindDiagnosticMode: 'diagnostic',
    ifindRefreshTokenVersionId: 'v20260826-003',
    ifindSecretBundleId: '2'.repeat(32),
    ifindSecretMaterialFingerprint: '3'.repeat(64),
    releaseRecordSchemaVersion: 2,
    verificationRunId: '123',
    artifactSource: 'ghcr-public',
    databaseBackupPath: 'none',
    databaseBackupChecksum: 'none',
    deployedAt: '2026-08-26T00:00:00Z',
    ...overrides
  }
}

function request(overrides = {}) {
  const current = state()
  return {
    imageDigest: current.imageDigest,
    commit: current.commit,
    secretProviderMode: current.secretProviderMode,
    secretVersionIds: current.secretVersionIds,
    secretMaterialFingerprints: current.secretMaterialFingerprints,
    accessControlMode: current.accessControlMode,
    ifindDiagnosticMode: current.ifindDiagnosticMode,
    ifindRefreshTokenVersionId: current.ifindRefreshTokenVersionId,
    ifindSecretMaterialFingerprint: current.ifindSecretMaterialFingerprint,
    ...overrides
  }
}

function stateText(value) {
  return Object.entries(value).map(([key, item]) =>
    `${key}=${typeof item === 'object' ? JSON.stringify(item) : item}`
  ).join('\n') + '\n'
}

function assertFailure(result, code) {
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, `${code}\n`)
  assert.equal(result.stderr.includes('ifind-refresh-token'), false)
}

async function run() {
  const canonical = runContract('canonical-state', state())
  assert.equal(canonical.status, 0, canonical.stderr)
  assert.deepEqual(canonical.stdout.trimEnd().split('\n').map((line) => line.split('=', 1)[0]), [
    'protocolVersion', 'imageDigest', 'runtimeImageId', 'commit', 'schemaVersion',
    'imageSchemaMin', 'imageSchemaMax', 'secretProviderMode', 'secretVersionIds',
    'secretBundleId', 'secretMaterialFingerprints', 'accessControlMode',
    'imageAccessControlContract', 'trustedProxyAddresses', 'trustedProxyConfigChecksum',
    'ifindDiagnosticMode', 'ifindRefreshTokenVersionId', 'ifindSecretBundleId',
    'ifindSecretMaterialFingerprint', 'releaseRecordSchemaVersion', 'verificationRunId',
    'artifactSource', 'databaseBackupPath', 'databaseBackupChecksum', 'deployedAt'
  ])

  const legacy = { ...state({ protocolVersion: 5 }) }
  for (const key of [
    'ifindDiagnosticMode', 'ifindRefreshTokenVersionId',
    'ifindSecretBundleId', 'ifindSecretMaterialFingerprint'
  ]) delete legacy[key]
  const migrated = runContract('parse-state', stateText(legacy))
  assert.equal(migrated.status, 0, migrated.stderr)
  assert.deepEqual(JSON.parse(migrated.stdout), {
    ...legacy,
    protocolVersion: 6,
    ifindDiagnosticMode: 'disabled',
    ifindRefreshTokenVersionId: '',
    ifindSecretBundleId: 'none',
    ifindSecretMaterialFingerprint: ''
  })

  for (const invalid of [
    state({ extra: true }),
    state({ ifindDiagnosticMode: 'enabled' }),
    state({ ifindRefreshTokenVersionId: 'current' }),
    state({ ifindSecretBundleId: 'none' }),
    state({ ifindSecretMaterialFingerprint: '' }),
    state({
      ifindDiagnosticMode: 'disabled',
      ifindRefreshTokenVersionId: 'v20260826-003',
      ifindSecretBundleId: 'none',
      ifindSecretMaterialFingerprint: ''
    })
  ]) assertFailure(runContract('canonical-state', invalid), 'DEPLOY_V5_STATE_INVALID')

  const forward = runContract('resolve-intent', {
    intent: 'FORWARD', request: request(), current: state(), previous: null
  })
  assert.equal(forward.status, 0, forward.stderr)
  assert.equal(JSON.parse(forward.stdout).ifindDiagnosticMode, 'diagnostic')

  const reuse = runContract('resolve-intent', {
    intent: 'FORWARD',
    request: request({ ifindSecretMaterialFingerprint: '4'.repeat(64) }),
    current: state(),
    previous: null
  })
  assertFailure(reuse, 'SECRET_VERSION_REUSE_CONFLICT')

  const previous = state({
    imageDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'5'.repeat(64)}`,
    runtimeImageId: `sha256:${'6'.repeat(64)}`,
    commit: '7'.repeat(40),
    ifindDiagnosticMode: 'disabled',
    ifindRefreshTokenVersionId: '',
    ifindSecretBundleId: 'none',
    ifindSecretMaterialFingerprint: ''
  })
  const rollback = runContract('resolve-intent', {
    intent: 'ROLLBACK',
    request: request({ imageDigest: previous.imageDigest, commit: previous.commit }),
    current: state(),
    previous
  })
  assert.equal(rollback.status, 0, rollback.stderr)
  const rollbackPlan = JSON.parse(rollback.stdout)
  assert.equal(rollbackPlan.target.ifindDiagnosticMode, 'diagnostic')
  assert.equal(rollbackPlan.target.ifindRefreshTokenVersionId, state().ifindRefreshTokenVersionId)
  assert.equal(rollbackPlan.target.ifindSecretMaterialFingerprint, state().ifindSecretMaterialFingerprint)

  const rollbackReplacement = runContract('resolve-intent', {
    intent: 'ROLLBACK',
    request: request({
      imageDigest: previous.imageDigest,
      commit: previous.commit,
      ifindRefreshTokenVersionId: 'v20260826-004',
      ifindSecretMaterialFingerprint: '4'.repeat(64)
    }),
    current: state(),
    previous
  })
  assertFailure(rollbackReplacement, 'ROLLBACK_SECURITY_STATE_MISMATCH')

  const restore = runContract('resolve-intent', {
    intent: 'RESTORE', request: request(), current: state(), previous: null
  })
  assert.equal(restore.status, 0, restore.stderr)
  assert.equal(JSON.parse(restore.stdout).target.ifindSecretBundleId, state().ifindSecretBundleId)

  const restoreMismatch = runContract('resolve-intent', {
    intent: 'RESTORE',
    request: request({ ifindRefreshTokenVersionId: 'v20260826-004' }),
    current: state(),
    previous: null
  })
  assertFailure(restoreMismatch, 'RESTORE_STATE_MISMATCH')
}

module.exports = { run }
