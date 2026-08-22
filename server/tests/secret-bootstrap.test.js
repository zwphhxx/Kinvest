const assert = require('node:assert/strict')
const {
  ADMIN_SECRET_NAME,
  DEVICE_HMAC_SECRET_NAME,
  generateAdminPasswordVerifier,
  generateDeviceHmacSecret
} = require('../security/secret-bootstrap-contract')

const VERSION = 'v20260812-001'
const BUNDLE_PATH = '/run/secrets/kinvest'
const ENABLED_JSON = JSON.stringify({
  adminPasswordVerifier: VERSION,
  deviceTokenHmac: {
    accepted: [VERSION],
    active: VERSION
  }
})

function deterministicBytes(length, label) {
  const source = Buffer.from(label.repeat(length), 'utf8')
  return Buffer.from(source.subarray(0, length))
}

function hasCode(code) {
  return (error) => error instanceof Error && 'code' in error && error.code === code
}

async function run() {
  const { bootstrapSecrets } = require('../security/secret-bootstrap')
  let loadCalls = 0
  const disabled = await bootstrapSecrets({
    env: {},
    loadSecrets: async () => {
      loadCalls += 1
      assert.fail('disabled mode must not load metadata or SDK')
    }
  })
  assert.deepEqual(disabled.status, { mode: 'disabled', referenceCount: 0 })
  assert.equal(Object.isFrozen(disabled.status), true)
  assert.equal(loadCalls, 0)
  disabled.clear()
  disabled.clear()

  for (const env of [
    { KINVEST_SECRET_PROVIDER_MODE: 'disabled' },
    { KINVEST_SECRET_VERSION_IDS: '{}' },
    {
      KINVEST_SECRET_PROVIDER_MODE: 'disabled',
      KINVEST_SECRET_VERSION_IDS: ENABLED_JSON
    },
    {
      KINVEST_SECRET_PROVIDER_MODE: 'cvm-ssm',
      KINVEST_SECRET_VERSION_IDS: '{}'
    },
    {
      KINVEST_SECRET_PROVIDER_MODE: 'unknown',
      KINVEST_SECRET_VERSION_IDS: '{}'
    },
    {
      KINVEST_SECRET_PROVIDER_MODE: 'github-tmpfs-v1',
      KINVEST_SECRET_VERSION_IDS: ENABLED_JSON
    },
    {
      KINVEST_SECRET_PROVIDER_MODE: 'github-tmpfs-v1',
      KINVEST_SECRET_VERSION_IDS: ENABLED_JSON,
      KINVEST_SECRET_BUNDLE_PATH: '/tmp/not-production-bundle'
    },
    {
      KINVEST_SECRET_PROVIDER_MODE: 'disabled',
      KINVEST_SECRET_VERSION_IDS: '{}',
      KINVEST_SECRET_BUNDLE_PATH: BUNDLE_PATH
    },
    {
      KINVEST_SECRET_PROVIDER_MODE: 'github-tmpfs-v1',
      KINVEST_SECRET_VERSION_IDS: JSON.stringify({
        adminPasswordVerifier: VERSION,
        deviceTokenHmac: {
          accepted: [VERSION, 'v20260812-002'],
          active: VERSION
        }
      }),
      KINVEST_SECRET_BUNDLE_PATH: BUNDLE_PATH
    }
  ]) {
    await assert.rejects(bootstrapSecrets({ env }), hasCode('SECRET_BOOTSTRAP_CONFIG_INVALID'))
  }

  const adminMaterial = generateAdminPasswordVerifier(
    'correct horse battery staple',
    (length) => deterministicBytes(length, 'admin-salt')
  )
  const hmacMaterial = generateDeviceHmacSecret(
    (length) => deterministicBytes(length, 'device-hmac')
  )
  let clearCount = 0
  const providerValues = new Map([
    [`${ADMIN_SECRET_NAME}:${VERSION}`, Buffer.from(adminMaterial)],
    [`${DEVICE_HMAC_SECRET_NAME}:${VERSION}`, Buffer.from(hmacMaterial)]
  ])
  /** @type {{roleName?: string, bundlePath?: string, references: Array<{secretName: string, versionId: string}>} | undefined} */
  let receivedOptions
  const enabled = await bootstrapSecrets({
    env: {
      KINVEST_SECRET_PROVIDER_MODE: 'cvm-ssm',
      KINVEST_SECRET_VERSION_IDS: ENABLED_JSON
    },
    loadSecrets: async (options) => {
      receivedOptions = options
      return {
        readSecret(reference) {
          return Buffer.from(providerValues.get(
            `${reference.secretName}:${reference.versionId}`
          ))
        },
        clear() {
          clearCount += 1
        }
      }
    }
  })
  assert.ok(receivedOptions)
  assert.equal(receivedOptions.roleName, 'KinvestProdCvmSsmReader')
  assert.deepEqual(receivedOptions.references, [
    { secretName: ADMIN_SECRET_NAME, versionId: VERSION },
    { secretName: DEVICE_HMAC_SECRET_NAME, versionId: VERSION }
  ])
  assert.deepEqual(enabled.status, { mode: 'cvm-ssm', referenceCount: 2 })
  assert.equal(enabled.readSecret({
    secretName: DEVICE_HMAC_SECRET_NAME,
    versionId: VERSION
  }).toString(), hmacMaterial)
  enabled.clear()
  enabled.clear()
  assert.equal(clearCount, 1)

  let githubOptions
  let githubClearCount = 0
  const github = await bootstrapSecrets({
    env: {
      KINVEST_SECRET_PROVIDER_MODE: 'github-tmpfs-v1',
      KINVEST_SECRET_VERSION_IDS: ENABLED_JSON,
      KINVEST_SECRET_BUNDLE_PATH: BUNDLE_PATH
    },
    loadSecrets: async (options) => {
      githubOptions = options
      return {
        readSecret(reference) {
          return Buffer.from(providerValues.get(
            `${reference.secretName}:${reference.versionId}`
          ))
        },
        clear() { githubClearCount += 1 }
      }
    }
  })
  assert.deepEqual(githubOptions, {
    references: [
      { secretName: ADMIN_SECRET_NAME, versionId: VERSION },
      { secretName: DEVICE_HMAC_SECRET_NAME, versionId: VERSION }
    ],
    bundlePath: BUNDLE_PATH
  })
  assert.deepEqual(github.status, {
    mode: 'github-tmpfs-v1',
    referenceCount: 2
  })
  github.clear()
  assert.equal(githubClearCount, 1)

  let failedProviderClears = 0
  await assert.rejects(bootstrapSecrets({
    env: {
      KINVEST_SECRET_PROVIDER_MODE: 'cvm-ssm',
      KINVEST_SECRET_VERSION_IDS: ENABLED_JSON
    },
    loadSecrets: async () => ({
      readSecret: () => Buffer.from('invalid'),
      clear: () => { failedProviderClears += 1 }
    })
  }), hasCode('SECRET_MATERIAL_INVALID'))
  assert.equal(failedProviderClears, 1)

  await assert.rejects(bootstrapSecrets({
    env: {
      KINVEST_SECRET_PROVIDER_MODE: 'cvm-ssm',
      KINVEST_SECRET_VERSION_IDS: ENABLED_JSON
    },
    loadSecrets: async () => ({
      readSecret: () => Buffer.from('invalid'),
      clear: () => {
        throw new Error('sensitive provider cleanup failure')
      }
    })
  }), (error) => {
    assert.ok(error instanceof Error)
    assert.equal('code' in error && error.code, 'SECRET_MATERIAL_INVALID')
    assert.equal(error.message.includes('sensitive provider cleanup failure'), false)
    return true
  })
}

module.exports = { run }
