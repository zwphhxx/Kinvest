const assert = require('node:assert/strict')

const VERSION_ID = 'v20260826-001'

function hasCode(code) {
  return (error) => error instanceof Error && error.code === code
}

async function run() {
  const {
    IFIND_BUNDLE_PATH,
    IFIND_DIAGNOSTIC_MODE_ADMIN,
    IFIND_DIAGNOSTIC_MODE_DISABLED,
    IfindSecretContractError,
    createIfindSecretContract
  } = require('../security/ifind-secret-contract')

  assert.equal(IFIND_BUNDLE_PATH, '/run/secrets/kinvest-ifind')
  assert.equal(IFIND_DIAGNOSTIC_MODE_DISABLED, 'disabled')
  assert.equal(IFIND_DIAGNOSTIC_MODE_ADMIN, 'admin-diagnostic')
  assert.equal(typeof IfindSecretContractError, 'function')

  const disabled = createIfindSecretContract({ mode: 'disabled' })
  assert.deepEqual(disabled, { mode: 'disabled' })
  assert.equal(Object.hasOwn(disabled, 'versionId'), false)
  assert.equal(Object.hasOwn(disabled, 'bundlePath'), false)
  assert.equal(Object.isFrozen(disabled), true)

  const enabled = createIfindSecretContract({
    mode: 'admin-diagnostic',
    versionId: VERSION_ID,
    bundlePath: IFIND_BUNDLE_PATH
  })
  assert.deepEqual(enabled, {
    mode: 'admin-diagnostic',
    versionId: VERSION_ID,
    bundlePath: IFIND_BUNDLE_PATH
  })
  assert.equal(Object.isFrozen(enabled), true)

  const invalidValues = [
    undefined,
    null,
    {},
    { mode: 'enabled' },
    { mode: 'disabled', versionId: VERSION_ID },
    { mode: 'disabled', bundlePath: IFIND_BUNDLE_PATH },
    { mode: 'disabled', extra: true },
    { mode: 'admin-diagnostic' },
    { mode: 'admin-diagnostic', versionId: VERSION_ID },
    { mode: 'admin-diagnostic', bundlePath: IFIND_BUNDLE_PATH },
    { mode: 'admin-diagnostic', versionId: 'current', bundlePath: IFIND_BUNDLE_PATH },
    { mode: 'admin-diagnostic', versionId: 'previous', bundlePath: IFIND_BUNDLE_PATH },
    { mode: 'admin-diagnostic', versionId: 'v2026826-001', bundlePath: IFIND_BUNDLE_PATH },
    { mode: 'admin-diagnostic', versionId: 'v20260826-01', bundlePath: IFIND_BUNDLE_PATH },
    { mode: 'admin-diagnostic', versionId: `${VERSION_ID}\n`, bundlePath: IFIND_BUNDLE_PATH },
    { mode: 'admin-diagnostic', versionId: VERSION_ID, bundlePath: '/tmp/ifind' },
    { mode: 'admin-diagnostic', versionId: VERSION_ID, bundlePath: IFIND_BUNDLE_PATH, extra: true }
  ]

  for (const value of invalidValues) {
    assert.throws(
      () => createIfindSecretContract(value),
      (error) => {
        assert.equal(hasCode('IFIND_SECRET_CONFIG_INVALID')(error), true)
        const serialized = `${error.name}:${error.message}:${error.code}`
        assert.equal(serialized.includes(VERSION_ID), false)
        assert.equal(serialized.includes(IFIND_BUNDLE_PATH), false)
        assert.equal('cause' in error, false)
        return true
      }
    )
  }
}

module.exports = { run }
