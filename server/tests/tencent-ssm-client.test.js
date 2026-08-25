const assert = require('node:assert/strict')

const TEMPORARY_CREDENTIALS = Object.freeze({
  secretId: 'temporary-id',
  secretKey: 'temporary-key',
  token: 'temporary-token'
})

async function run() {
  const { createTencentSsmClient } = require('../security/tencent-ssm-client')
  const configurations = []
  const requests = []
  class FakeClient {
    constructor(configuration) {
      configurations.push(configuration)
    }

    async GetSecretValue(request) {
      requests.push(request)
      return { SecretString: 'fixture-only' }
    }
  }

  const client = createTencentSsmClient({
    region: 'ap-shanghai',
    credentials: TEMPORARY_CREDENTIALS,
    sdkLoader: () => ({ ssm: { v20190923: { Client: FakeClient } } })
  })
  assert.deepEqual(Object.keys(client), ['getSecretValue'])
  assert.deepEqual(configurations, [{
    credential: {
      secretId: 'temporary-id',
      secretKey: 'temporary-key',
      token: 'temporary-token'
    },
    region: 'ap-shanghai',
    profile: {
      signMethod: 'TC3-HMAC-SHA256',
      httpProfile: {
        endpoint: 'ssm.tencentcloudapi.com',
        reqMethod: 'POST',
        reqTimeout: 3
      }
    }
  }])
  assert.deepEqual(await client.getSecretValue({
    SecretName: 'fixture-name',
    VersionId: 'v20260812-001'
  }), { SecretString: 'fixture-only' })
  assert.deepEqual(requests, [{
    SecretName: 'fixture-name',
    VersionId: 'v20260812-001'
  }])

  const sdkModuleName = ['tencentcloud-sdk-nodejs', 'ssm'].join('-')
  const actualSdk = require(sdkModuleName)
  assert.equal(typeof actualSdk.ssm.v20190923.Client, 'function')
  const smokeClient = createTencentSsmClient({
    region: 'ap-shanghai',
    credentials: TEMPORARY_CREDENTIALS,
    sdkLoader: () => actualSdk
  })
  assert.equal(typeof smokeClient.getSecretValue, 'function')

  const secretMarker = 'fixture-secret-must-not-leak'
  const failingClient = createTencentSsmClient({
    region: 'ap-shanghai',
    credentials: TEMPORARY_CREDENTIALS,
    sdkLoader: () => ({
      ssm: {
        v20190923: {
          Client: class {
            async GetSecretValue() {
              throw new Error(`${secretMarker} RequestId=fixture`)
            }
          }
        }
      }
    })
  })
  await assert.rejects(failingClient.getSecretValue({
    SecretName: 'fixture-name',
    VersionId: 'v20260812-001'
  }), (error) => {
    assert.ok(error instanceof Error)
    assert.equal('code' in error && error.code, 'SSM_REQUEST_FAILED')
    assert.equal(error.message.includes(secretMarker), false)
    assert.equal(error.message.includes('RequestId'), false)
    return true
  })

  assert.throws(() => createTencentSsmClient({
    region: 'ap-shanghai',
    credentials: TEMPORARY_CREDENTIALS,
    sdkLoader: () => { throw new Error(secretMarker) }
  }), (error) => {
    assert.ok(error instanceof Error)
    assert.equal('code' in error && error.code, 'SSM_CLIENT_UNAVAILABLE')
    assert.equal(error.message.includes(secretMarker), false)
    return true
  })
}

module.exports = { run }
