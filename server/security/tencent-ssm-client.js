const REGION = 'ap-shanghai'
const ENDPOINT = 'ssm.tencentcloudapi.com'

class TencentSsmClientError extends Error {
  constructor(code) {
    const messages = {
      SSM_CLIENT_CONFIG_INVALID: 'The SSM client configuration is invalid',
      SSM_CLIENT_UNAVAILABLE: 'The SSM client is unavailable',
      SSM_REQUEST_FAILED: 'The SSM request failed'
    }
    super(messages[code] || 'The SSM client failed')
    this.name = 'TencentSsmClientError'
    this.code = code
  }
}

function defaultSdkLoader() {
  return require('tencentcloud-sdk-nodejs-ssm')
}

function validCredentials(credentials) {
  return Boolean(credentials &&
    typeof credentials.secretId === 'string' && credentials.secretId.length > 0 &&
    typeof credentials.secretKey === 'string' && credentials.secretKey.length > 0 &&
    typeof credentials.token === 'string' && credentials.token.length > 0)
}

function createTencentSsmClient({
  region,
  credentials,
  sdkLoader = defaultSdkLoader
} = {}) {
  if (region !== REGION || !validCredentials(credentials) || typeof sdkLoader !== 'function') {
    throw new TencentSsmClientError('SSM_CLIENT_CONFIG_INVALID')
  }

  let Client
  try {
    const sdk = sdkLoader()
    Client = sdk && sdk.ssm && sdk.ssm.v20190923 && sdk.ssm.v20190923.Client
  } catch {
    throw new TencentSsmClientError('SSM_CLIENT_UNAVAILABLE')
  }
  if (typeof Client !== 'function') {
    throw new TencentSsmClientError('SSM_CLIENT_UNAVAILABLE')
  }

  let client
  try {
    client = new Client({
      credential: {
        secretId: credentials.secretId,
        secretKey: credentials.secretKey,
        token: credentials.token
      },
      region: REGION,
      profile: {
        signMethod: 'TC3-HMAC-SHA256',
        httpProfile: {
          endpoint: ENDPOINT,
          reqMethod: 'POST',
          reqTimeout: 3
        }
      }
    })
  } catch {
    throw new TencentSsmClientError('SSM_CLIENT_UNAVAILABLE')
  }
  if (!client || typeof client.GetSecretValue !== 'function') {
    throw new TencentSsmClientError('SSM_CLIENT_UNAVAILABLE')
  }

  return Object.freeze({
    async getSecretValue(request) {
      try {
        return await client.GetSecretValue(request)
      } catch {
        throw new TencentSsmClientError('SSM_REQUEST_FAILED')
      }
    }
  })
}

module.exports = {
  ENDPOINT,
  TencentSsmClientError,
  createTencentSsmClient
}
