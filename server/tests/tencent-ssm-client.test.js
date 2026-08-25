const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const TEMPORARY_CREDENTIALS = Object.freeze({
  secretId: 'temporary-id',
  secretKey: 'temporary-key',
  token: 'temporary-token'
})

async function run() {
  const repositoryRoot = path.resolve(__dirname, '..', '..')
  const source = fs.readFileSync(
    path.join(repositoryRoot, 'server', 'security', 'tencent-ssm-client.js'),
    'utf8'
  )
  assert.match(source, /require\('tencentcloud-sdk-nodejs-ssm'\)/)
  assert.doesNotMatch(source, /\['tencentcloud-sdk-nodejs', 'ssm'\][.]join/)
  assert.ok(
    source.indexOf('function defaultSdkLoader') <
      source.indexOf("require('tencentcloud-sdk-nodejs-ssm')")
  )

  const packageJson = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'package.json'),
    'utf8'
  ))
  assert.equal(packageJson.dependencies['tencentcloud-sdk-nodejs-ssm'], '4.1.275')
  assert.match(
    fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8'),
    /node -e "require\('tencentcloud-sdk-nodejs-ssm'\)/
  )

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
