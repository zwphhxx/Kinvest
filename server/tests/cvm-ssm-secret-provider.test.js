const assert = require('node:assert/strict')
const {
  MAX_VERSIONS_PER_SECRET,
  METADATA_IP,
  loadCvmSsmSecrets
} = require('../security/cvm-ssm-secret-provider')

const SECRET_NAME = 'kinvest-prod-device-token-hmac-key'
const NOW = Date.parse('2026-08-02T01:00:00.000Z')

function hasCode(code) {
  return (error) => error instanceof Error && 'code' in error && error.code === code
}

function metadataPayload(overrides = {}) {
  return {
    TmpSecretId: 'temporary-id',
    TmpSecretKey: 'temporary-key',
    Token: 'temporary-token',
    ExpiredTime: Math.floor(Date.parse('2026-08-02T02:00:00.000Z') / 1000),
    Expiration: '2026-08-02T02:00:00.000Z',
    Code: 'Success',
    ...overrides
  }
}

function metadataRequest(payload, calls) {
  return async (request) => {
    calls.push(request)
    return JSON.stringify(payload)
  }
}

/**
 * @param {Record<string, string>} values
 * @param {Array<{SecretName: string, VersionId: string}>} calls
 * @param {(request: {SecretName: string, VersionId: string}) => unknown} [onRead]
 */
function ssmClient(values, calls, onRead = () => {}) {
  return {
    getSecretValue: async (request) => {
      calls.push(request)
      onRead(request)
      const key = request.SecretName + ':' + request.VersionId
      return {
        SecretName: request.SecretName,
        VersionId: request.VersionId,
        SecretString: values[key]
      }
    }
  }
}

async function run() {
  const metadataCalls = []
  const ssmCalls = []
  const audit = []
  const provider = await loadCvmSsmSecrets({
    references: [
      { secretName: SECRET_NAME, versionId: 'v20260802-001' },
      { secretName: SECRET_NAME, versionId: 'v20260802-001' },
      { secretName: SECRET_NAME, versionId: 'v20260802-002' }
    ],
    roleName: 'KinvestProdRole',
    metadataRequest: metadataRequest(metadataPayload(), metadataCalls),
    clientFactory: ({ region, credentials }) => {
      assert.equal(region, 'ap-shanghai')
      assert.equal(credentials.secretId, 'temporary-id')
      assert.equal(credentials.secretKey, 'temporary-key')
      assert.equal(credentials.token, 'temporary-token')
      return ssmClient({
        [SECRET_NAME + ':v20260802-001']: 'hmac-secret-one',
        [SECRET_NAME + ':v20260802-002']: 'hmac-secret-two'
      }, ssmCalls)
    },
    now: () => NOW,
    audit: (event, metadata) => audit.push({ event, metadata })
  })

  assert.equal(metadataCalls.length, 1)
  assert.deepEqual(metadataCalls[0], {
    host: METADATA_IP,
    path: '/latest/meta-data/cam/security-credentials/KinvestProdRole',
    timeoutMs: 1500,
    maxBytes: 16384
  })
  assert.deepEqual(ssmCalls, [
    { SecretName: SECRET_NAME, VersionId: 'v20260802-001' },
    { SecretName: SECRET_NAME, VersionId: 'v20260802-002' }
  ])
  assert.equal(provider.readSecret({
    secretName: SECRET_NAME,
    versionId: 'v20260802-001'
  }).toString(), 'hmac-secret-one')
  const serializedAudit = JSON.stringify(audit)
  assert.equal(serializedAudit.includes('hmac-secret-one'), false)
  assert.equal(serializedAudit.includes('temporary-key'), false)
  provider.clear()
  assert.throws(() => provider.readSecret({
    secretName: SECRET_NAME,
    versionId: 'v20260802-001'
  }), hasCode('SECRET_NOT_FOUND'))

  await assert.rejects(loadCvmSsmSecrets({
    references: [{ secretName: SECRET_NAME, versionId: 'v20260802-001' }],
    roleName: '../unsafe-role',
    metadataRequest: async () => assert.fail('invalid role must not reach metadata'),
    clientFactory: () => assert.fail('invalid role must not create SSM client'),
    now: () => NOW
  }), hasCode('SSM_BOOTSTRAP_INVALID'))

  for (const payload of [
    metadataPayload({ Token: '' }),
    metadataPayload({
      ExpiredTime: Math.floor((NOW + 30_000) / 1000),
      Expiration: new Date(NOW + 30_000).toISOString()
    }),
    metadataPayload({ Code: 'Failure' })
  ]) {
    await assert.rejects(loadCvmSsmSecrets({
      references: [{ secretName: SECRET_NAME, versionId: 'v20260802-001' }],
      roleName: 'KinvestProdRole',
      metadataRequest: metadataRequest(payload, []),
      clientFactory: () => assert.fail('invalid credentials must not create SSM client'),
      now: () => NOW
    }), hasCode('TEMPORARY_CREDENTIALS_REQUIRED'))
  }

  await assert.rejects(loadCvmSsmSecrets({
    references: [{ secretName: SECRET_NAME, versionId: 'v20260802-001' }],
    roleName: 'KinvestProdRole',
    metadataRequest: async () => {
      throw new Error('metadata timeout')
    },
    clientFactory: () => assert.fail('metadata failure must not create SSM client'),
    now: () => NOW
  }), hasCode('TEMPORARY_CREDENTIALS_REQUIRED'))

  await assert.rejects(loadCvmSsmSecrets({
    references: [{ secretName: SECRET_NAME, versionId: 'v20260802-001' }],
    roleName: 'KinvestProdRole',
    metadataRequest: metadataRequest(metadataPayload(), []),
    clientFactory: () => ({
      getSecretValue: async () => ({
        SecretName: SECRET_NAME,
        VersionId: 'v20260802-999',
        SecretString: 'wrong-version'
      })
    }),
    now: () => NOW
  }), hasCode('SSM_SECRET_LOAD_FAILED'))

  let movingNow = NOW
  await assert.rejects(loadCvmSsmSecrets({
    references: [
      { secretName: SECRET_NAME, versionId: 'v20260802-001' },
      { secretName: SECRET_NAME, versionId: 'v20260802-002' }
    ],
    roleName: 'KinvestProdRole',
    metadataRequest: metadataRequest(metadataPayload({
      ExpiredTime: Math.floor((NOW + 120_000) / 1000),
      Expiration: new Date(NOW + 120_000).toISOString()
    }), []),
    clientFactory: () => ssmClient({
      [SECRET_NAME + ':v20260802-001']: 'one',
      [SECRET_NAME + ':v20260802-002']: 'two'
    }, [], () => {
      movingNow += 70_000
    }),
    now: () => movingNow
  }), hasCode('TEMPORARY_CREDENTIALS_REQUIRED'))

  await assert.rejects(loadCvmSsmSecrets({
    references: Array.from({ length: MAX_VERSIONS_PER_SECRET + 1 }, (_, index) => ({
      secretName: SECRET_NAME,
      versionId: 'v20260802-' + String(index + 1).padStart(3, '0')
    })),
    roleName: 'KinvestProdRole',
    metadataRequest: async () => assert.fail('invalid references must fail before metadata'),
    clientFactory: () => assert.fail('invalid references must fail before client creation'),
    now: () => NOW
  }), hasCode('SSM_BOOTSTRAP_INVALID'))
}

module.exports = { run }
