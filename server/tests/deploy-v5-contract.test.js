const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const contractPath = path.join(rootDir, 'deploy/server/deploy-v5-contract.py')
const refreshToken = 'ifind-refresh-token.TEST_20260826-001'

function accessMaterials() {
  const admin = JSON.stringify({
    digest: Buffer.alloc(32, 1).toString('base64url'),
    format: 'kinvest-admin-scrypt-v1',
    n: 65536,
    p: 1,
    r: 8,
    salt: Buffer.alloc(16, 2).toString('base64url')
  })
  return {
    admin: Buffer.from(admin).toString('base64url'),
    hmac: Buffer.alloc(32, 3).toString('base64url')
  }
}

function payload(overrides = {}) {
  const access = accessMaterials()
  const value = {
    magic: 'KINVEST_DEPLOY_V5',
    intent: 'FORWARD',
    digest: `ghcr.io/zwphhxx/kinvest@sha256:${'a'.repeat(64)}`,
    commit: 'b'.repeat(40),
    provenance: '{"artifactSource":"ghcr-public","releaseRecordSchemaVersion":2,"verificationRunId":"123"}',
    registry: '{"host":"ghcr.io","mode":"ghcr-public","repository":"ghcr.io/zwphhxx/kinvest"}',
    provider: 'github-tmpfs-v1',
    adminVersion: 'v20260826-001',
    hmacVersion: 'v20260826-002',
    admin: access.admin,
    hmac: access.hmac,
    policy: '{"accessControlMode":"device-approval","schemaVersion":1}',
    ifindMode: 'diagnostic',
    ifindVersion: 'v20260826-003',
    ifindMaterial: refreshToken,
    end: 'EOF',
    ...overrides
  }
  return [
    value.magic, value.intent, value.digest, value.commit, value.provenance,
    value.registry, value.provider, value.adminVersion, value.hmacVersion,
    value.admin, value.hmac, value.policy, value.ifindMode,
    value.ifindVersion, value.ifindMaterial, value.end
  ].join('\n') + '\n'
}

function runContract(input, spawn = spawnSync) {
  return spawn(process.env.PYTHON || 'python3', [contractPath, 'validate-payload'], {
    encoding: 'utf8',
    input,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    maxBuffer: 128 * 1024
  })
}

function assertSecretSafeFailure(result, token = refreshToken) {
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^DEPLOY_V5_[A-Z0-9_]+\n$/)
  assert.equal(result.stderr.includes(token), false)
  assert.equal(result.stderr.includes(accessMaterials().admin), false)
  assert.equal(result.stderr.includes(accessMaterials().hmac), false)
}

async function run() {
  const valid = runContract(payload())
  assert.equal(valid.status, 0, valid.stderr)
  const parsed = JSON.parse(valid.stdout)
  assert.equal(parsed.ifindDiagnosticMode, 'diagnostic')
  assert.equal(parsed.ifindRefreshTokenVersionId, 'v20260826-003')
  assert.equal(
    parsed.ifindSecretMaterialFingerprint,
    createHash('sha256').update(refreshToken, 'ascii').digest('hex')
  )
  assert.equal(valid.stdout.includes(refreshToken), false)
  assert.equal(Object.hasOwn(parsed, 'ifindRefreshTokenMaterial'), false)

  const configuredPython = process.env.PYTHON || 'python3'
  const resolvedPython = spawnSync(configuredPython, ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8'
  })
  assert.equal(resolvedPython.status, 0, resolvedPython.stderr)
  const resolvedPythonPath = resolvedPython.stdout.trim()
  assert.notEqual(resolvedPythonPath, '')
  const previousPython = process.env.PYTHON
  let selectedPython
  try {
    process.env.PYTHON = 'kinvest-python-override-probe'
    const probed = runContract(payload(), (command, args, options) => {
      selectedPython = command
      return spawnSync(resolvedPythonPath, args, options)
    })
    assert.equal(selectedPython, 'kinvest-python-override-probe')
    assert.equal(probed.status, 0, probed.stderr)
  } finally {
    if (previousPython === undefined) delete process.env.PYTHON
    else process.env.PYTHON = previousPython
  }

  const disabled = runContract(payload({
    ifindMode: 'disabled', ifindVersion: '', ifindMaterial: ''
  }))
  assert.equal(disabled.status, 0, disabled.stderr)
  assert.deepEqual(
    Object.fromEntries(Object.entries(JSON.parse(disabled.stdout)).filter(([key]) => key.startsWith('ifind'))),
    {
      ifindDiagnosticMode: 'disabled',
      ifindRefreshTokenVersionId: '',
      ifindSecretMaterialFingerprint: ''
    }
  )

  for (const invalid of [
    payload().replace(/\nEOF\n$/, '\n'),
    payload() + 'extra\n',
    payload().replace(/\n/g, '\r\n'),
    payload({ ifindMode: 'enabled' }),
    payload({ ifindMode: 'disabled' }),
    payload({ ifindVersion: '' }),
    payload({ ifindMaterial: '' }),
    payload({ ifindVersion: 'current' }),
    payload({ ifindVersion: 'v2026826-001' }),
    payload({ ifindMaterial: 'contains space' }),
    payload({ ifindMaterial: 'x'.repeat(4097) }),
    payload({ provenance: '{"verificationRunId":"123","releaseRecordSchemaVersion":2,"artifactSource":"ghcr-public"}' }),
    payload({ registry: '{"mode":"ghcr-public","host":"ghcr.io","repository":"ghcr.io/zwphhxx/kinvest"}' }),
    payload({ policy: '{"schemaVersion":1,"accessControlMode":"device-approval"}' })
  ]) assertSecretSafeFailure(runContract(invalid))

  const nonAscii = Buffer.from(payload().replace(refreshToken, '令牌'), 'utf8')
  assertSecretSafeFailure(runContract(nonAscii), '令牌')
}

module.exports = { run }
