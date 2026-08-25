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

  let proxyTrapCalls = 0
  const hostileProxy = new Proxy({ mode: 'disabled' }, {
    get() {
      proxyTrapCalls += 1
      throw new Error('proxy get trap ran')
    },
    getOwnPropertyDescriptor() {
      proxyTrapCalls += 1
      throw new Error('proxy descriptor trap ran')
    },
    getPrototypeOf() {
      proxyTrapCalls += 1
      throw new Error('proxy prototype trap ran')
    },
    ownKeys() {
      proxyTrapCalls += 1
      throw new Error('proxy keys trap ran')
    }
  })
  assert.throws(
    () => createIfindSecretContract(hostileProxy),
    hasCode('IFIND_SECRET_CONFIG_INVALID')
  )
  assert.equal(proxyTrapCalls, 0)

  const attackerError = new IfindSecretContractError()
  attackerError.message = 'attacker-sensitive-message'
  attackerError.code = 'ATTACKER_CONTROLLED_CODE'
  const originalGetPrototypeOf = Reflect.getPrototypeOf
  Reflect.getPrototypeOf = () => { throw attackerError }
  try {
    assert.throws(
      () => createIfindSecretContract({ mode: 'disabled' }),
      (error) => {
        assert.notStrictEqual(error, attackerError)
        assert.equal(error.name, 'IfindSecretContractError')
        assert.equal(error.message, 'The iFinD secret configuration is invalid')
        assert.equal(error.code, 'IFIND_SECRET_CONFIG_INVALID')
        assert.equal(`${error.name}:${error.message}:${error.code}`.includes('attacker'), false)
        return true
      }
    )
  } finally {
    Reflect.getPrototypeOf = originalGetPrototypeOf
  }

  const symbolExtra = { mode: 'disabled' }
  symbolExtra[Symbol('hidden')] = true
  const nonEnumerableExtra = { mode: 'disabled' }
  Object.defineProperty(nonEnumerableExtra, 'hidden', { value: true })
  const unsafePrototype = Object.assign(Object.create({ inherited: true }), {
    mode: 'disabled'
  })
  let accessorReads = 0
  const changingAccessor = {}
  Object.defineProperties(changingAccessor, {
    mode: {
      enumerable: true,
      get() {
        accessorReads += 1
        return accessorReads === 1 ? 'admin-diagnostic' : 'disabled'
      }
    },
    versionId: { enumerable: true, value: VERSION_ID },
    bundlePath: { enumerable: true, value: IFIND_BUNDLE_PATH }
  })
  const nulNameCollision = Object.create({
    mode: 'admin-diagnostic',
    bundlePath: IFIND_BUNDLE_PATH
  })
  Object.defineProperties(nulNameCollision, {
    ['bundlePath\0mode']: { enumerable: true, value: true },
    versionId: { enumerable: true, value: VERSION_ID }
  })

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
    { mode: 'admin-diagnostic', versionId: VERSION_ID, bundlePath: IFIND_BUNDLE_PATH, extra: true },
    symbolExtra,
    nonEnumerableExtra,
    unsafePrototype,
    changingAccessor,
    nulNameCollision
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
  assert.equal(accessorReads, 0)
}

module.exports = { run }
