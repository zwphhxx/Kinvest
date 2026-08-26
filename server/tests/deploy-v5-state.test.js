const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const contractPath = path.join(rootDir, 'deploy/server/deploy-v5-contract.py')
const v4ContractPath = path.join(rootDir, 'deploy/server/deploy-v3-contract.py')

function runContract(command, input) {
  return spawnSync(process.env.PYTHON || 'python3', [contractPath, command], {
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

function realV4StateText() {
  const legacy = { ...state({ protocolVersion: 4 }) }
  for (const key of [
    'accessControlMode', 'imageAccessControlContract', 'trustedProxyAddresses',
    'trustedProxyConfigChecksum', 'ifindDiagnosticMode',
    'ifindRefreshTokenVersionId', 'ifindSecretBundleId',
    'ifindSecretMaterialFingerprint'
  ]) delete legacy[key]
  const generated = spawnSync(process.env.PYTHON || 'python3', [v4ContractPath, 'canonical-state'], {
    encoding: 'utf8',
    input: `${JSON.stringify(legacy)}\n`,
    env: { ...process.env, KINVEST_DEPLOY_PROTOCOL: '3', PYTHONDONTWRITEBYTECODE: '1' }
  })
  assert.equal(generated.status, 0, generated.stderr)
  assert.match(generated.stdout, /^protocolVersion=4\n/)
  return { legacy, text: generated.stdout }
}

function assertFailure(result, code) {
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, `${code}\n`)
  assert.equal(result.stderr.includes('ifind-refresh-token'), false)
}

function withDuplicate(raw, needle, duplicate) {
  assert.equal(raw.includes(needle), true, `missing duplicate-key insertion point: ${needle}`)
  return raw.replace(needle, `${needle}${duplicate}`)
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

  const v4Golden = realV4StateText()
  const chained = runContract('parse-state', v4Golden.text)
  assert.equal(chained.status, 0, chained.stderr)
  assert.deepEqual(JSON.parse(chained.stdout), {
    ...v4Golden.legacy,
    protocolVersion: 6,
    accessControlMode: 'disabled',
    imageAccessControlContract: 0,
    trustedProxyAddresses: [],
    trustedProxyConfigChecksum: '',
    ifindDiagnosticMode: 'disabled',
    ifindRefreshTokenVersionId: '',
    ifindSecretBundleId: 'none',
    ifindSecretMaterialFingerprint: ''
  })

  for (const invalid of [
    state({ extra: true }),
    state({ imageDigest: [] }),
    state({ runtimeImageId: null }),
    state({ commit: 7 }),
    state({ secretProviderMode: [] }),
    state({
      secretVersionIds: {
        adminPasswordVerifier: null,
        deviceTokenHmac: { accepted: ['v20260826-002'], active: 'v20260826-002' }
      }
    }),
    state({ secretBundleId: 7 }),
    state({
      secretMaterialFingerprints: {
        adminPasswordVerifier: [],
        deviceTokenHmac: 'f'.repeat(64)
      }
    }),
    state({ accessControlMode: {} }),
    state({ ifindDiagnosticMode: 'enabled' }),
    state({ ifindDiagnosticMode: [] }),
    state({ ifindRefreshTokenVersionId: 'current' }),
    state({ ifindRefreshTokenVersionId: null }),
    state({ ifindSecretBundleId: 'none' }),
    state({ ifindSecretBundleId: [] }),
    state({ ifindSecretMaterialFingerprint: '' }),
    state({ ifindSecretMaterialFingerprint: 7 }),
    state({
      ifindDiagnosticMode: 'disabled',
      ifindRefreshTokenVersionId: 'v20260826-003',
      ifindSecretBundleId: 'none',
      ifindSecretMaterialFingerprint: ''
    }),
    state({
      databaseBackupPath: '/tmp/kinvest.sqlite.backup',
      databaseBackupChecksum: '4'.repeat(64)
    }),
    state({
      databaseBackupPath: '/root/docker/kinvest/backups/kinvest.sqlite.backup',
      databaseBackupChecksum: 'not-a-sha256'
    }),
    state({ databaseBackupPath: 'none', databaseBackupChecksum: '4'.repeat(64) }),
    state({
      databaseBackupPath: '/root/docker/kinvest/backups/kinvest.sqlite.backup',
      databaseBackupChecksum: 'none'
    }),
    // H4-1 validates canonical state strings only. H4-2 must enforce openat,
    // O_NOFOLLOW, regular-file checks, and checksum recomputation at execution.
    state({
      databaseBackupPath: '/root/docker/kinvest/backups/../secrets/kinvest.sqlite',
      databaseBackupChecksum: '4'.repeat(64)
    }),
    state({
      databaseBackupPath: '/root/docker/kinvest/backups/',
      databaseBackupChecksum: '4'.repeat(64)
    }),
    state({
      databaseBackupPath: '/root/docker/kinvest/backups//kinvest.sqlite.backup',
      databaseBackupChecksum: '4'.repeat(64)
    }),
    state({ deployedAt: '2026-02-30T00:00:00Z' })
  ]) assertFailure(runContract('canonical-state', invalid), 'DEPLOY_V5_STATE_INVALID')

  const forward = runContract('resolve-intent', {
    intent: 'FORWARD', request: request(), current: state(), previous: null
  })
  assert.equal(forward.status, 0, forward.stderr)
  assert.equal(JSON.parse(forward.stdout).ifindDiagnosticMode, 'diagnostic')

  const resolveInput = JSON.stringify({
    intent: 'FORWARD', request: request(), current: state(), previous: null
  })
  for (const injected of [
    withDuplicate(resolveInput, '{"intent":"FORWARD",', '"intent":"RESTORE",'),
    withDuplicate(resolveInput, `"imageDigest":"${state().imageDigest}",`, `"imageDigest":"ghcr.io/zwphhxx/kinvest@sha256:${'9'.repeat(64)}",`),
    withDuplicate(resolveInput, `"commit":"${state().commit}",`, `"commit":"${'9'.repeat(40)}",`),
    withDuplicate(resolveInput, '"adminPasswordVerifier":"v20260826-001",', '"adminPasswordVerifier":"v20260826-009",'),
    withDuplicate(resolveInput, `"adminPasswordVerifier":"${'e'.repeat(64)}",`, `"adminPasswordVerifier":"${'9'.repeat(64)}",`)
  ]) assertFailure(runContract('resolve-intent', injected), 'DEPLOY_V5_INPUT_INVALID')

  for (const invalidIntent of [[], {}, null]) {
    const malformedIntent = runContract('resolve-intent', {
      intent: invalidIntent,
      request: request(),
      current: state(),
      previous: null
    })
    assertFailure(malformedIntent, 'DEPLOY_V5_INTENT_INVALID')
  }

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

  const noPrevious = runContract('resolve-intent', {
    intent: 'ROLLBACK', request: request(), current: state(), previous: null
  })
  assertFailure(noPrevious, 'ROLLBACK_STATE_UNAVAILABLE')

  const targetMismatch = runContract('resolve-intent', {
    intent: 'ROLLBACK', request: request(), current: state(), previous
  })
  assertFailure(targetMismatch, 'ROLLBACK_STATE_MISMATCH')

  const incompatiblePrevious = state({
    imageDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'5'.repeat(64)}`,
    runtimeImageId: `sha256:${'6'.repeat(64)}`,
    commit: '7'.repeat(40),
    schemaVersion: 1,
    imageSchemaMin: 1,
    imageSchemaMax: 1
  })
  const databaseRestoreBoundary = runContract('resolve-intent', {
    intent: 'ROLLBACK',
    request: request({
      imageDigest: incompatiblePrevious.imageDigest,
      commit: incompatiblePrevious.commit
    }),
    current: state(),
    previous: incompatiblePrevious
  })
  assertFailure(databaseRestoreBoundary, 'ROLLBACK_REQUIRES_DB_RESTORE')

  const accessVersionReuse = runContract('resolve-intent', {
    intent: 'FORWARD',
    request: request({
      secretMaterialFingerprints: {
        adminPasswordVerifier: '4'.repeat(64),
        deviceTokenHmac: state().secretMaterialFingerprints.deviceTokenHmac
      }
    }),
    current: state(),
    previous: null
  })
  assertFailure(accessVersionReuse, 'SECRET_VERSION_REUSE_CONFLICT')

  const accessDowngrade = runContract('resolve-intent', {
    intent: 'FORWARD',
    request: request({ accessControlMode: 'disabled' }),
    current: state(),
    previous: null
  })
  assertFailure(accessDowngrade, 'ACCESS_CONTROL_DOWNGRADE_FORBIDDEN')

  const accessDisabledCurrent = state({
    accessControlMode: 'disabled',
    trustedProxyAddresses: [],
    trustedProxyConfigChecksum: ''
  })
  const providerDowngrade = runContract('resolve-intent', {
    intent: 'FORWARD',
    request: request({
      secretProviderMode: 'disabled',
      secretVersionIds: {},
      secretMaterialFingerprints: {},
      accessControlMode: 'disabled'
    }),
    current: accessDisabledCurrent,
    previous: null
  })
  assertFailure(providerDowngrade, 'SECRET_PROVIDER_DOWNGRADE_FORBIDDEN')

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
