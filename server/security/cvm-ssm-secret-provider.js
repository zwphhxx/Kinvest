const http = require('node:http')
const {
  SecretProviderError,
  validateSecretReference
} = require('./secret-provider')
const { createTencentSsmClient } = require('./tencent-ssm-client')

const REGION = 'ap-shanghai'
const METADATA_IP = '169.254.0.23'
const METADATA_HOST = 'metadata.tencentyun.com'
const METADATA_TIMEOUT_MS = 1500
const METADATA_MAX_BYTES = 16 * 1024
const MAX_VERSIONS_PER_SECRET = 10
const ROLE_NAME_PATTERN = /^[A-Za-z0-9+=,.@_-]{1,64}$/

class CvmSsmSecretProviderError extends Error {
  constructor(code) {
    const messages = {
      SSM_BOOTSTRAP_INVALID: 'The SSM bootstrap configuration is invalid',
      SSM_CLIENT_UNAVAILABLE: 'The SSM client is unavailable',
      SSM_SECRET_LOAD_FAILED: 'A required SSM secret version could not be loaded',
      TEMPORARY_CREDENTIALS_REQUIRED: 'CVM temporary credentials are required'
    }
    super(messages[code] || 'SSM bootstrap failed')
    this.name = 'CvmSsmSecretProviderError'
    this.code = code
  }
}

class LoadedSecretProvider {
  #entries

  constructor(entries) {
    this.#entries = entries
  }

  readSecret(reference) {
    const { secretName, versionId } = validateSecretReference(reference)
    const value = this.#entries.get(secretName + ':' + versionId)
    if (!value) throw new SecretProviderError('SECRET_NOT_FOUND')
    return Buffer.from(value)
  }

  clear() {
    for (const value of this.#entries.values()) value.fill(0)
    this.#entries.clear()
  }
}

function normalizeReferences(references) {
  if (!Array.isArray(references) || references.length === 0) {
    throw new CvmSsmSecretProviderError('SSM_BOOTSTRAP_INVALID')
  }
  const unique = new Map()
  const versionsBySecret = new Map()
  for (const reference of references) {
    let validated
    try {
      validated = validateSecretReference(reference)
    } catch {
      throw new CvmSsmSecretProviderError('SSM_BOOTSTRAP_INVALID')
    }
    const key = validated.secretName + ':' + validated.versionId
    unique.set(key, validated)
    if (!versionsBySecret.has(validated.secretName)) {
      versionsBySecret.set(validated.secretName, new Set())
    }
    versionsBySecret.get(validated.secretName).add(validated.versionId)
  }
  if (Array.from(versionsBySecret.values()).some((versions) => {
    return versions.size > MAX_VERSIONS_PER_SECRET
  })) {
    throw new CvmSsmSecretProviderError('SSM_BOOTSTRAP_INVALID')
  }
  return Array.from(unique.values())
}

function isValidTemporaryCredentials(credentials, now) {
  const expiresAt = credentials && Date.parse(credentials.expiresAt)
  return Boolean(credentials &&
    typeof credentials.secretId === 'string' &&
    credentials.secretId.length > 0 &&
    typeof credentials.secretKey === 'string' &&
    credentials.secretKey.length > 0 &&
    typeof credentials.token === 'string' &&
    credentials.token.length > 0 &&
    Number.isFinite(expiresAt) &&
    expiresAt > now + 60_000)
}

function requestCvmMetadata({ host, path, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host,
      port: 80,
      path,
      method: 'GET',
      agent: false,
      headers: {
        Accept: 'application/json',
        Host: METADATA_HOST
      }
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error('metadata request failed'))
        return
      }
      const chunks = []
      let totalBytes = 0
      response.on('data', (chunk) => {
        totalBytes += chunk.length
        if (totalBytes > maxBytes) {
          response.destroy(new Error('metadata response too large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
      response.on('error', reject)
    })
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('metadata request timed out'))
    })
    request.on('error', reject)
    request.end()
  })
}

async function loadTemporaryCredentials({ roleName, metadataRequest, now }) {
  if (!ROLE_NAME_PATTERN.test(roleName)) {
    throw new CvmSsmSecretProviderError('SSM_BOOTSTRAP_INVALID')
  }
  let payload
  try {
    const body = await metadataRequest({
      host: METADATA_IP,
      path: '/latest/meta-data/cam/security-credentials/' + encodeURIComponent(roleName),
      timeoutMs: METADATA_TIMEOUT_MS,
      maxBytes: METADATA_MAX_BYTES
    })
    payload = JSON.parse(body)
  } catch {
    throw new CvmSsmSecretProviderError('TEMPORARY_CREDENTIALS_REQUIRED')
  }
  const expiredTime = Number(payload && payload.ExpiredTime) * 1000
  const expiration = payload && Date.parse(payload.Expiration)
  const credentials = payload && {
    secretId: payload.TmpSecretId,
    secretKey: payload.TmpSecretKey,
    token: payload.Token,
    expiresAt: payload.Expiration
  }
  const timestampsAgree = Number.isFinite(expiredTime) &&
    Number.isFinite(expiration) &&
    Math.abs(expiredTime - expiration) <= 5000
  if (!payload ||
    payload.Code !== 'Success' ||
    !timestampsAgree ||
    !isValidTemporaryCredentials(credentials, now())) {
    throw new CvmSsmSecretProviderError('TEMPORARY_CREDENTIALS_REQUIRED')
  }
  return credentials
}

/**
 * Load explicitly versioned SSM values with credentials read only from CVM
 * instance metadata. metadataRequest is a bounded transport seam for tests;
 * production startup must use its fixed default.
 *
 * @param {object} [options]
 * @param {Array<{secretName: string, versionId: string}>} [options.references]
 * @param {string} [options.roleName]
 * @param {(request: {host: string, path: string, timeoutMs: number, maxBytes: number}) => Promise<string>} [options.metadataRequest]
 * @param {(input: {region: string, credentials: {secretId: string, secretKey: string, token: string, expiresAt: string}}) => {getSecretValue: (input: {SecretName: string, VersionId: string}) => Promise<{SecretName?: string, VersionId?: string, SecretString?: string}>}} [options.clientFactory]
 * @param {string} [options.region]
 * @param {() => number} [options.now]
 * @param {(event: string, metadata: {loadedCount: number, region: string}) => void} [options.audit]
 */
async function loadCvmSsmSecrets({
  references,
  roleName,
  metadataRequest = requestCvmMetadata,
  clientFactory = createTencentSsmClient,
  region = REGION,
  now = Date.now,
  audit = () => {}
} = {}) {
  if (region !== REGION ||
    typeof roleName !== 'string' ||
    typeof metadataRequest !== 'function' ||
    typeof clientFactory !== 'function' ||
    typeof now !== 'function' ||
    typeof audit !== 'function') {
    throw new CvmSsmSecretProviderError('SSM_BOOTSTRAP_INVALID')
  }
  const normalizedReferences = normalizeReferences(references)
  const credentials = await loadTemporaryCredentials({
    roleName,
    metadataRequest,
    now
  })

  let client
  try {
    client = clientFactory({ region, credentials })
  } catch {
    throw new CvmSsmSecretProviderError('SSM_CLIENT_UNAVAILABLE')
  }
  if (!client || typeof client.getSecretValue !== 'function') {
    throw new CvmSsmSecretProviderError('SSM_CLIENT_UNAVAILABLE')
  }

  const entries = new Map()
  try {
    for (const [referenceIndex, reference] of normalizedReferences.entries()) {
      if (!isValidTemporaryCredentials(credentials, now())) {
        throw new CvmSsmSecretProviderError('TEMPORARY_CREDENTIALS_REQUIRED')
      }
      const response = await client.getSecretValue({
        SecretName: reference.secretName,
        VersionId: reference.versionId
      })
      const validResponse = response &&
        response.SecretName === reference.secretName &&
        response.VersionId === reference.versionId &&
        typeof response.SecretString === 'string' &&
        response.SecretString.length > 0
      if (!validResponse) {
        throw new CvmSsmSecretProviderError('SSM_SECRET_LOAD_FAILED')
      }
      entries.set(
        reference.secretName + ':' + reference.versionId,
        Buffer.from(response.SecretString)
      )
      audit('ssm_secret_version_loaded', {
        loadedCount: referenceIndex + 1,
        region
      })
    }
  } catch (error) {
    for (const value of entries.values()) value.fill(0)
    entries.clear()
    if (error instanceof CvmSsmSecretProviderError) throw error
    throw new CvmSsmSecretProviderError('SSM_SECRET_LOAD_FAILED')
  }
  return new LoadedSecretProvider(entries)
}

module.exports = {
  CvmSsmSecretProviderError,
  LoadedSecretProvider,
  MAX_VERSIONS_PER_SECRET,
  METADATA_IP,
  REGION,
  loadCvmSsmSecrets
}
