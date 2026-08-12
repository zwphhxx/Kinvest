const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const {
  parseSecretVersionConfig
} = require('../security/secret-bootstrap-contract')

const rootDir = path.resolve(__dirname, '../..')
const cli = path.join(rootDir, 'deploy/server/secret-version-config.py')
const enabled = '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["v20260812-001","v20260812-002"],"active":"v20260812-002"}}'

function invoke(command, { input = '', env = {} } = {}) {
  return spawnSync('python3', [cli, command], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      SSM_BOOTSTRAP_ENABLED: '',
      SSM_ADMIN_PASSWORD_VERIFIER_VERSION_ID: '',
      SSM_DEVICE_TOKEN_HMAC_ACTIVE_VERSION_ID: '',
      SSM_DEVICE_TOKEN_HMAC_ACCEPTED_VERSION_IDS: '',
      ...env
    }
  })
}

function assertRejected(input, command = 'mapping') {
  const result = invoke(command, { input: `${input}\n` })
  assert.notEqual(result.status, 0, `unexpectedly accepted ${input}`)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'SECRET_VERSION_CONFIG_INVALID\n')
  assert.doesNotMatch(result.stderr, /v20260812|current|previous/i)
}

async function run() {
  for (const input of ['{}', enabled]) {
    const result = invoke('mapping', { input: `${input}\n` })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `${input}\n`)
    assert.equal(parseSecretVersionConfig(result.stdout.trim()).canonicalJson, input)
  }

  assert.equal(invoke('count', { input: '{}\n' }).stdout, '0\n')
  assert.equal(invoke('count', { input: `${enabled}\n` }).stdout, '3\n')

  for (const invalid of [
    '{"rollback":"previous"}',
    '{"adminPasswordVerifier":"current","deviceTokenHmac":{"accepted":["v20260812-001"],"active":"v20260812-001"}}',
    '{"adminPasswordVerifier":"v20260812-001","extra":true,"deviceTokenHmac":{"accepted":["v20260812-001"],"active":"v20260812-001"}}',
    '{"deviceTokenHmac":{"accepted":["v20260812-001"],"active":"v20260812-001"},"adminPasswordVerifier":"v20260812-001"}',
    '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["v20260812-002","v20260812-001"],"active":"v20260812-001"}}',
    '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["v20260812-001","v20260812-001"],"active":"v20260812-001"}}',
    '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["v20260812-001"],"active":"v20260812-002"}}',
    '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":[],"active":"v20260812-001"}}',
    '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["v20260812-001","v20260812-002","v20260812-003","v20260812-004","v20260812-005","v20260812-006","v20260812-007","v20260812-008","v20260812-009","v20260812-010","v20260812-011"],"active":"v20260812-001"}}',
    `${enabled}\n`,
    '{"adminPasswordVerifier":"v20260812-001","adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["v20260812-001"],"active":"v20260812-001"}}'
  ]) assertRejected(invalid)

  const disabledUnset = invoke('from-env')
  assert.equal(disabledUnset.status, 0, disabledUnset.stderr)
  assert.equal(disabledUnset.stdout, '{}\n')

  const disabled = invoke('from-env', {
    env: { SSM_BOOTSTRAP_ENABLED: 'false' }
  })
  assert.equal(disabled.status, 0, disabled.stderr)
  assert.equal(disabled.stdout, '{}\n')

  const misleadingDisabled = invoke('from-env', {
    env: {
      SSM_BOOTSTRAP_ENABLED: 'false',
      SSM_ADMIN_PASSWORD_VERIFIER_VERSION_ID: 'v20260812-001'
    }
  })
  assert.notEqual(misleadingDisabled.status, 0)
  assert.equal(misleadingDisabled.stderr, 'SECRET_VERSION_CONFIG_INVALID\n')

  const enabledFromEnv = invoke('from-env', {
    env: {
      SSM_BOOTSTRAP_ENABLED: 'true',
      SSM_ADMIN_PASSWORD_VERIFIER_VERSION_ID: 'v20260812-001',
      SSM_DEVICE_TOKEN_HMAC_ACTIVE_VERSION_ID: 'v20260812-002',
      SSM_DEVICE_TOKEN_HMAC_ACCEPTED_VERSION_IDS: '["v20260812-001", "v20260812-002"]'
    }
  })
  assert.equal(enabledFromEnv.status, 0, enabledFromEnv.stderr)
  assert.equal(enabledFromEnv.stdout, `${enabled}\n`)

  for (const env of [
    { SSM_BOOTSTRAP_ENABLED: 'TRUE' },
    {
      SSM_BOOTSTRAP_ENABLED: 'true',
      SSM_ADMIN_PASSWORD_VERIFIER_VERSION_ID: 'v20260812-001',
      SSM_DEVICE_TOKEN_HMAC_ACTIVE_VERSION_ID: 'v20260812-002',
      SSM_DEVICE_TOKEN_HMAC_ACCEPTED_VERSION_IDS: '["v20260812-002","v20260812-001"]'
    },
    {
      SSM_BOOTSTRAP_ENABLED: 'true',
      SSM_ADMIN_PASSWORD_VERIFIER_VERSION_ID: 'v20260812-001',
      SSM_DEVICE_TOKEN_HMAC_ACTIVE_VERSION_ID: 'v20260812-002',
      SSM_DEVICE_TOKEN_HMAC_ACCEPTED_VERSION_IDS: '["v20260812-001"]'
    }
  ]) {
    const result = invoke('from-env', { env })
    assert.notEqual(result.status, 0)
    assert.equal(result.stderr, 'SECRET_VERSION_CONFIG_INVALID\n')
  }
}

module.exports = { run }
