const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const {
  ADMIN_SECRET_NAME,
  DEVICE_HMAC_SECRET_NAME,
  REGION,
  ROLE_NAME,
  generateAdminPasswordVerifier,
  generateDeviceHmacSecret,
  parseAdminPasswordVerifier,
  parseDeviceHmacSecret,
  parseSecretVersionConfig,
  validateLoadedSecretMaterial
} = require('../security/secret-bootstrap-contract')

const ADMIN_VERSION = 'v20260812-001'
const HMAC_VERSION_ONE = 'v20260812-002'
const HMAC_VERSION_TWO = 'v20260812-003'
const ENABLED_JSON = '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["v20260812-002","v20260812-003"],"active":"v20260812-003"}}'

function expectCode(callback, expectedCode, forbidden = []) {
  return assert.rejects(Promise.resolve().then(callback), (error) => {
    assert.ok(error instanceof Error)
    assert.equal(error.code, expectedCode)
    for (const value of forbidden) {
      if (value.length === 0) continue
      assert.equal(error.message.includes(value), false)
    }
    return true
  })
}

function expectSyncCode(callback, expectedCode, forbidden = []) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof Error)
    assert.equal(error.code, expectedCode)
    for (const value of forbidden) {
      if (value.length === 0) continue
      assert.equal(error.message.includes(value), false)
    }
    return true
  })
}

function runtimeBytes(size, marker) {
  return crypto.createHash('sha512')
    .update(`secret-contract-test-${marker}-${size}`)
    .digest()
    .subarray(0, size)
}

function canonicalAdminMaterial() {
  return JSON.stringify({
    digest: runtimeBytes(32, 'digest').toString('base64url'),
    format: 'kinvest-admin-scrypt-v1',
    n: 65536,
    p: 1,
    r: 8,
    salt: runtimeBytes(16, 'salt').toString('base64url')
  })
}

function testConstantsAndVersionConfig() {
  assert.equal(REGION, 'ap-shanghai')
  assert.equal(ROLE_NAME, 'KinvestProdCvmSsmReader')
  assert.equal(ADMIN_SECRET_NAME, 'kinvest-prod-admin-password-verifier')
  assert.equal(DEVICE_HMAC_SECRET_NAME, 'kinvest-prod-device-token-hmac-key')

  const disabled = parseSecretVersionConfig('{}')
  assert.deepEqual(disabled, {
    mode: 'disabled',
    canonicalJson: '{}',
    references: []
  })
  assert.equal(Object.isFrozen(disabled), true)
  assert.equal(Object.isFrozen(disabled.references), true)

  const enabled = parseSecretVersionConfig(ENABLED_JSON)
  assert.deepEqual(enabled, {
    mode: 'cvm-ssm',
    canonicalJson: ENABLED_JSON,
    references: [
      { secretName: ADMIN_SECRET_NAME, versionId: ADMIN_VERSION },
      { secretName: DEVICE_HMAC_SECRET_NAME, versionId: HMAC_VERSION_ONE },
      { secretName: DEVICE_HMAC_SECRET_NAME, versionId: HMAC_VERSION_TWO }
    ]
  })
  assert.equal(Object.isFrozen(enabled), true)
  assert.equal(Object.isFrozen(enabled.references), true)
  assert.equal(enabled.references.every(Object.isFrozen), true)

  const tenVersions = Array.from({ length: 10 }, (_, index) => {
    return `v20260812-${String(index + 1).padStart(3, '0')}`
  })
  const tenVersionJson = JSON.stringify({
    adminPasswordVerifier: 'v20260812-011',
    deviceTokenHmac: { accepted: tenVersions, active: tenVersions[9] }
  })
  assert.equal(parseSecretVersionConfig(tenVersionJson).references.length, 11)

  const invalidInputs = [
    '',
    ' {}',
    '{}\n',
    '{"deviceTokenHmac":{"accepted":["v20260812-002"],"active":"v20260812-002"},"adminPasswordVerifier":"v20260812-001"}',
    '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"active":"v20260812-002","accepted":["v20260812-002"]}}',
    '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["v20260812-003","v20260812-002"],"active":"v20260812-003"}}',
    '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["v20260812-002","v20260812-002"],"active":"v20260812-002"}}',
    '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":[],"active":"v20260812-002"}}',
    '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["v20260812-002"],"active":"v20260812-003"}}',
    '{"adminPasswordVerifier":"current","deviceTokenHmac":{"accepted":["v20260812-002"],"active":"v20260812-002"}}',
    '{"adminPasswordVerifier":"SSM_Current","deviceTokenHmac":{"accepted":["v20260812-002"],"active":"v20260812-002"}}',
    '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["previous"],"active":"previous"}}',
    '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["SSM_Previous"],"active":"SSM_Previous"}}',
    '{"adminPasswordVerifier":"v20260812-01","deviceTokenHmac":{"accepted":["v20260812-002"],"active":"v20260812-002"}}',
    '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["v20260812-002"],"active":"v20260812-002","extra":true}}',
    '{"adminPasswordVerifier":"v20260812-001","deviceTokenHmac":{"accepted":["v20260812-002"],"active":"v20260812-002"},"extra":true}',
    JSON.stringify({
      adminPasswordVerifier: 'v20260812-011',
      deviceTokenHmac: {
        accepted: Array.from({ length: 11 }, (_, index) => {
          return `v20260812-${String(index + 1).padStart(3, '0')}`
        }),
        active: 'v20260812-011'
      }
    })
  ]
  for (const input of invalidInputs) {
    expectSyncCode(
      () => parseSecretVersionConfig(input),
      'SECRET_VERSION_CONFIG_INVALID',
      [input]
    )
  }
  for (const input of [null, Buffer.from('{}'), {}, []]) {
    expectSyncCode(() => parseSecretVersionConfig(input), 'SECRET_VERSION_CONFIG_INVALID')
  }
}

function testAdminVerifierContract() {
  const raw = canonicalAdminMaterial()
  const parsed = parseAdminPasswordVerifier(raw)
  assert.equal(parsed.format, 'kinvest-admin-scrypt-v1')
  assert.equal(parsed.n, 65536)
  assert.equal(parsed.p, 1)
  assert.equal(parsed.r, 8)
  assert.deepEqual(parsed.salt, runtimeBytes(16, 'salt'))
  assert.deepEqual(parsed.digest, runtimeBytes(32, 'digest'))
  assert.deepEqual(parseAdminPasswordVerifier(Buffer.from(raw)), parsed)
  assert.equal(Object.isFrozen(parsed), true)

  const invalid = [
    `${raw}\n`,
    JSON.stringify({
      format: 'kinvest-admin-scrypt-v1',
      digest: runtimeBytes(32, 'digest').toString('base64url'),
      n: 65536,
      p: 1,
      r: 8,
      salt: runtimeBytes(16, 'salt').toString('base64url')
    }),
    JSON.stringify({
      digest: runtimeBytes(31, 'short-digest').toString('base64url'),
      format: 'kinvest-admin-scrypt-v1',
      n: 65536,
      p: 1,
      r: 8,
      salt: runtimeBytes(16, 'salt').toString('base64url')
    }),
    JSON.stringify({
      digest: `${runtimeBytes(32, 'digest').toString('base64url')}=`,
      format: 'kinvest-admin-scrypt-v1',
      n: 65536,
      p: 1,
      r: 8,
      salt: runtimeBytes(16, 'salt').toString('base64url')
    }),
    JSON.stringify({
      digest: runtimeBytes(32, 'digest').toString('base64url'),
      format: 'wrong-format',
      n: 65536,
      p: 1,
      r: 8,
      salt: runtimeBytes(16, 'salt').toString('base64url')
    }),
    JSON.stringify({
      digest: runtimeBytes(32, 'digest').toString('base64url'),
      format: 'kinvest-admin-scrypt-v1',
      n: 32768,
      p: 1,
      r: 8,
      salt: runtimeBytes(16, 'salt').toString('base64url')
    }),
    JSON.stringify({
      digest: runtimeBytes(32, 'digest').toString('base64url'),
      format: 'kinvest-admin-scrypt-v1',
      n: 65536,
      p: 1,
      r: 8,
      salt: runtimeBytes(15, 'short-salt').toString('base64url')
    }),
    JSON.stringify({
      digest: runtimeBytes(32, 'digest').toString('base64url'),
      format: 'kinvest-admin-scrypt-v1',
      n: 65536,
      p: 1,
      r: 8,
      salt: runtimeBytes(16, 'salt').toString('base64url'),
      extra: true
    })
  ]
  for (const input of invalid) {
    expectSyncCode(() => parseAdminPasswordVerifier(input), 'ADMIN_VERIFIER_INVALID', [input])
  }

  const password = '\u5bc6\u7801'.repeat(8)
  const salt = runtimeBytes(16, 'generated-salt')
  const generated = generateAdminPasswordVerifier(password, (size) => {
    assert.equal(size, 16)
    return Buffer.from(salt)
  })
  const generatedObject = JSON.parse(generated)
  assert.deepEqual(Object.keys(generatedObject), ['digest', 'format', 'n', 'p', 'r', 'salt'])
  assert.equal(generated.includes(password), false)
  assert.equal(generatedObject.salt, salt.toString('base64url'))
  assert.equal(generatedObject.digest, crypto.scryptSync(password, salt, 32, {
    N: 65536,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024
  }).toString('base64url'))
  parseAdminPasswordVerifier(generated)

  const fixedRandom = () => Buffer.from(salt)
  assert.notEqual(
    generateAdminPasswordVerifier(`${'a'.repeat(15)} `, fixedRandom),
    generateAdminPasswordVerifier('a'.repeat(16), fixedRandom)
  )
  assert.notEqual(
    generateAdminPasswordVerifier(`\u00e9${'a'.repeat(15)}`, fixedRandom),
    generateAdminPasswordVerifier(`e\u0301${'a'.repeat(15)}`, fixedRandom)
  )
  generateAdminPasswordVerifier('\ud83d\ude00'.repeat(16), fixedRandom)
  for (const invalidPassword of ['a'.repeat(15), 'a'.repeat(129)]) {
    expectSyncCode(
      () => generateAdminPasswordVerifier(invalidPassword, fixedRandom),
      'ADMIN_PASSWORD_INVALID',
      [invalidPassword]
    )
  }
  for (const invalidPassword of [null, Buffer.from('a'.repeat(16))]) {
    expectSyncCode(
      () => generateAdminPasswordVerifier(invalidPassword, fixedRandom),
      'ADMIN_PASSWORD_INVALID'
    )
  }
  expectSyncCode(
    () => generateAdminPasswordVerifier('a'.repeat(16), () => Buffer.alloc(15)),
    'SECRET_RANDOM_SOURCE_INVALID'
  )
}

function testDeviceHmacContract() {
  const bytes = runtimeBytes(32, 'device-hmac')
  const raw = bytes.toString('base64url')
  assert.equal(raw.length, 43)
  assert.deepEqual(parseDeviceHmacSecret(raw), bytes)
  assert.deepEqual(parseDeviceHmacSecret(Buffer.from(raw)), bytes)

  for (const input of [
    `${raw}\n`,
    ` ${raw}`,
    `${raw}=`,
    runtimeBytes(31, 'short-hmac').toString('base64url'),
    ''
  ]) {
    expectSyncCode(() => parseDeviceHmacSecret(input), 'DEVICE_HMAC_INVALID', [input])
  }
  for (const input of [null, {}, Buffer.from([0xff, 0xfe])]) {
    expectSyncCode(() => parseDeviceHmacSecret(input), 'DEVICE_HMAC_INVALID')
  }

  const generated = generateDeviceHmacSecret((size) => {
    assert.equal(size, 32)
    return Buffer.from(bytes)
  })
  assert.equal(generated, raw)
  parseDeviceHmacSecret(generated)
  expectSyncCode(
    () => generateDeviceHmacSecret(() => Buffer.alloc(31)),
    'SECRET_RANDOM_SOURCE_INVALID'
  )
}

async function testLoadedMaterialValidation() {
  let disabledReads = 0
  const disabledResult = await validateLoadedSecretMaterial({
    readSecret: () => {
      disabledReads += 1
      assert.fail('disabled mode must not read the provider')
    }
  }, parseSecretVersionConfig('{}'))
  assert.deepEqual(disabledResult, { mode: 'disabled', referenceCount: 0 })
  assert.equal(Object.isFrozen(disabledResult), true)
  assert.equal(disabledReads, 0)

  const config = parseSecretVersionConfig(ENABLED_JSON)
  const adminMaterial = canonicalAdminMaterial()
  const firstHmac = generateDeviceHmacSecret(() => runtimeBytes(32, 'first-hmac'))
  const secondHmac = generateDeviceHmacSecret(() => runtimeBytes(32, 'second-hmac'))
  const calls = []
  const values = new Map([
    [`${ADMIN_SECRET_NAME}:${ADMIN_VERSION}`, Buffer.from(adminMaterial)],
    [`${DEVICE_HMAC_SECRET_NAME}:${HMAC_VERSION_ONE}`, firstHmac],
    [`${DEVICE_HMAC_SECRET_NAME}:${HMAC_VERSION_TWO}`, Buffer.from(secondHmac)]
  ])
  const result = await validateLoadedSecretMaterial({
    readSecret: async (reference) => {
      calls.push({ ...reference })
      return values.get(`${reference.secretName}:${reference.versionId}`)
    }
  }, config)
  assert.deepEqual(calls, config.references)
  assert.deepEqual(result, { mode: 'cvm-ssm', referenceCount: 3 })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(JSON.stringify(result).includes(ADMIN_VERSION), false)
  assert.equal(JSON.stringify(result).includes(firstHmac), false)

  await expectCode(
    () => validateLoadedSecretMaterial({}, config),
    'SECRET_MATERIAL_PROVIDER_INVALID',
    [ADMIN_SECRET_NAME, ADMIN_VERSION]
  )
  const circularConfig = {
    mode: 'cvm-ssm',
    canonicalJson: ENABLED_JSON
  }
  circularConfig.references = circularConfig
  await expectCode(
    () => validateLoadedSecretMaterial({}, circularConfig),
    'SECRET_VERSION_CONFIG_INVALID',
    [ADMIN_SECRET_NAME, ADMIN_VERSION]
  )
  const providerGetterLeak = runtimeBytes(32, 'provider-getter-leak').toString('base64url')
  await expectCode(
    () => validateLoadedSecretMaterial(Object.defineProperty({}, 'readSecret', {
      get() {
        throw new Error(providerGetterLeak)
      }
    }), config),
    'SECRET_MATERIAL_PROVIDER_INVALID',
    [providerGetterLeak, ADMIN_SECRET_NAME, ADMIN_VERSION]
  )
  const leakMarker = runtimeBytes(32, 'leak-marker').toString('base64url')
  await expectCode(
    () => validateLoadedSecretMaterial({
      readSecret: () => {
        throw new Error(`provider failure ${leakMarker} ${ADMIN_SECRET_NAME} ${ADMIN_VERSION}`)
      }
    }, config),
    'SECRET_MATERIAL_LOAD_FAILED',
    [leakMarker, ADMIN_SECRET_NAME, ADMIN_VERSION]
  )
  await expectCode(
    () => validateLoadedSecretMaterial({
      readSecret: (reference) => reference.secretName === ADMIN_SECRET_NAME
        ? adminMaterial
        : Buffer.from('invalid-material')
    }, config),
    'SECRET_MATERIAL_INVALID',
    ['invalid-material', DEVICE_HMAC_SECRET_NAME, HMAC_VERSION_ONE]
  )
}

async function run() {
  testConstantsAndVersionConfig()
  testAdminVerifierContract()
  testDeviceHmacContract()
  await testLoadedMaterialValidation()
}

module.exports = { run }
