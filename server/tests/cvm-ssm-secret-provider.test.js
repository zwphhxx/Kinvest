const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const {
  MAX_VERSIONS_PER_SECRET,
  METADATA_IP,
  METADATA_MAX_BYTES,
  loadCvmSsmSecrets,
  requestCvmMetadata
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

/**
 * @param {{statusCode?: number, chunks?: Array<string | Buffer>, error?: Error, timeout?: boolean}} options
 */
function fakeMetadataTransport({ statusCode = 200, chunks = [], error, timeout = false }) {
  const calls = []
  /** @type {any[]} */
  const requests = []
  /** @type {any[]} */
  const responses = []
  const requestFactory = (options, onResponse) => {
    calls.push(options)
    /** @type {any} */
    const request = new EventEmitter()
    requests.push(request)
    request.setTimeout = (timeoutMs, handler) => {
      request.timeoutMs = timeoutMs
      request.timeoutHandler = handler
    }
    request.destroy = (cause) => {
      request.destroyed = true
      queueMicrotask(() => request.emit('error', cause))
    }
    request.end = () => {
      if (error) {
        queueMicrotask(() => request.emit('error', error))
        return
      }
      if (timeout) {
        queueMicrotask(() => request.timeoutHandler())
        return
      }
      /** @type {any} */
      const response = new EventEmitter()
      responses.push(response)
      response.statusCode = statusCode
      response.resume = () => { response.resumed = true }
      response.destroy = (cause) => {
        response.destroyed = true
        queueMicrotask(() => response.emit('error', cause))
      }
      onResponse(response)
      queueMicrotask(() => {
        for (const chunk of chunks) {
          response.emit('data', Buffer.from(chunk))
          if (response.destroyed) return
        }
        if (!response.destroyed) response.emit('end')
      })
    }
    return request
  }
  return { calls, requestFactory, requests, responses }
}

async function run() {
  const successTransport = fakeMetadataTransport({
    chunks: [Buffer.alloc(METADATA_MAX_BYTES, 97)]
  })
  const successBody = await requestCvmMetadata({
    host: METADATA_IP,
    path: '/latest/meta-data/cam/security-credentials/KinvestProdCvmSsmReader',
    timeoutMs: 1500,
    maxBytes: METADATA_MAX_BYTES
  }, successTransport.requestFactory)
  assert.equal(Buffer.byteLength(successBody), METADATA_MAX_BYTES)
  assert.deepEqual(successTransport.calls, [{
    host: METADATA_IP,
    port: 80,
    path: '/latest/meta-data/cam/security-credentials/KinvestProdCvmSsmReader',
    method: 'GET',
    agent: false,
    headers: {
      Accept: 'application/json',
      Host: 'metadata.tencentyun.com'
    }
  }])

  for (const transport of [
    fakeMetadataTransport({ statusCode: 404 }),
    fakeMetadataTransport({ chunks: [Buffer.alloc(METADATA_MAX_BYTES + 1, 97)] }),
    fakeMetadataTransport({ timeout: true }),
    fakeMetadataTransport({ error: new Error('sensitive network failure') })
  ]) {
    await assert.rejects(requestCvmMetadata({
      host: METADATA_IP,
      path: '/latest/meta-data/cam/security-credentials/KinvestProdCvmSsmReader',
      timeoutMs: 1500,
      maxBytes: METADATA_MAX_BYTES
    }, transport.requestFactory))
  }
  const timeoutTransport = fakeMetadataTransport({ timeout: true })
  await assert.rejects(requestCvmMetadata({
    host: METADATA_IP,
    path: '/latest/meta-data/cam/security-credentials/KinvestProdCvmSsmReader',
    timeoutMs: 1500,
    maxBytes: METADATA_MAX_BYTES
  }, timeoutTransport.requestFactory))
  assert.equal(timeoutTransport.requests[0].timeoutMs, 1500)
  assert.equal(timeoutTransport.requests[0].destroyed, true)

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
  const firstRead = provider.readSecret({
    secretName: SECRET_NAME,
    versionId: 'v20260802-001'
  })
  const secondRead = provider.readSecret({
    secretName: SECRET_NAME,
    versionId: 'v20260802-001'
  })
  assert.notStrictEqual(firstRead, secondRead)
  firstRead.fill(0)
  assert.equal(secondRead.toString(), 'hmac-secret-one')
  assert.equal(provider.readSecret({
    secretName: SECRET_NAME,
    versionId: 'v20260802-001'
  }).toString(), 'hmac-secret-one')
  const serializedAudit = JSON.stringify(audit)
  assert.equal(serializedAudit.includes('hmac-secret-one'), false)
  assert.equal(serializedAudit.includes('temporary-key'), false)
  assert.equal(serializedAudit.includes(SECRET_NAME), false)
  assert.equal(serializedAudit.includes('v20260802-001'), false)
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
    metadataPayload({ Code: 'Failure' }),
    metadataPayload({
      ExpiredTime: Math.floor(Date.parse('2026-08-02T03:00:00.000Z') / 1000),
      Expiration: '2026-08-02T02:00:00.000Z'
    })
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

  for (const response of [
    {
      SecretName: 'kinvest-prod-other-secret',
      VersionId: 'v20260802-001',
      SecretString: 'fixture-value'
    },
    {
      SecretName: SECRET_NAME,
      VersionId: 'v20260802-999',
      SecretString: 'fixture-value'
    },
    {
      SecretName: SECRET_NAME,
      VersionId: 'v20260802-001',
      SecretString: ''
    }
  ]) {
    const serialized = JSON.stringify(response)
    await assert.rejects(loadCvmSsmSecrets({
      references: [{ secretName: SECRET_NAME, versionId: 'v20260802-001' }],
      roleName: 'KinvestProdRole',
      metadataRequest: metadataRequest(metadataPayload(), []),
      clientFactory: () => ({ getSecretValue: async () => response }),
      now: () => NOW
    }), (failure) => {
      assert.ok(failure instanceof Error)
      assert.equal('code' in failure && failure.code, 'SSM_SECRET_LOAD_FAILED')
      assert.equal(serialized.includes(failure.message), false)
      assert.equal(failure.message.includes(SECRET_NAME), false)
      assert.equal(failure.message.includes('v20260802'), false)
      return true
    })
  }

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
