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
const CVM_SSM_LOAD_DEADLINE_MS = 5000
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

function abortError(signal, fallbackCode) {
  if (signal && signal.aborted && signal.reason instanceof Error) {
    return signal.reason
  }
  return new CvmSsmSecretProviderError(fallbackCode)
}

function createOperationSignal(parentSignal, deadlineMs) {
  const controller = new AbortController()
  const relayAbort = () => controller.abort(abortError(
    parentSignal,
    'SSM_SECRET_LOAD_FAILED'
  ))
  if (parentSignal) {
    if (parentSignal.aborted) relayAbort()
    else parentSignal.addEventListener('abort', relayAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(
    new CvmSsmSecretProviderError('TEMPORARY_CREDENTIALS_REQUIRED')
  ), deadlineMs)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer)
      if (parentSignal) parentSignal.removeEventListener('abort', relayAbort)
    }
  }
}

function awaitAbortable(startOperation, signal) {
  if (signal.aborted) return Promise.reject(abortError(
    signal,
    'SSM_SECRET_LOAD_FAILED'
  ))
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', handleAbort)
      callback(value)
    }
    const handleAbort = () => settle(
      reject,
      abortError(signal, 'SSM_SECRET_LOAD_FAILED')
    )
    signal.addEventListener('abort', handleAbort, { once: true })
    let operation
    try {
      operation = startOperation()
    } catch (error) {
      settle(reject, error)
      return
    }
    Promise.resolve(operation).then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error)
    )
  })
}

/**
 * @param {{host: string, path: string, timeoutMs: number, maxBytes: number, signal?: AbortSignal}} options
 * @param {(options: any, onResponse: (response: any) => void) => any} [requestFactory]
 */
function requestCvmMetadata(
  { host, path, timeoutMs, maxBytes, signal },
  requestFactory = http.request
) {
  return new Promise((resolve, reject) => {
    let settled = false
    let request
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', handleAbort)
    }
    const rejectOnce = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const resolveOnce = (value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const rejectSanitized = () => {
      rejectOnce(signal && signal.aborted
        ? abortError(signal, 'TEMPORARY_CREDENTIALS_REQUIRED')
        : new CvmSsmSecretProviderError('TEMPORARY_CREDENTIALS_REQUIRED'))
    }
    const handleAbort = () => {
      const error = abortError(signal, 'TEMPORARY_CREDENTIALS_REQUIRED')
      if (request && typeof request.destroy === 'function') {
        try { request.destroy(error) } catch {
          // Rejection below remains the stable cancellation result.
        }
      }
      rejectOnce(error)
    }
    if (signal && signal.aborted) {
      rejectOnce(abortError(signal, 'TEMPORARY_CREDENTIALS_REQUIRED'))
      return
    }
    request = requestFactory({
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
        rejectSanitized()
        return
      }
      const chunks = []
      let totalBytes = 0
      response.on('data', (chunk) => {
        totalBytes += chunk.length
        if (totalBytes > maxBytes) {
          response.destroy(new CvmSsmSecretProviderError('TEMPORARY_CREDENTIALS_REQUIRED'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        resolveOnce(Buffer.concat(chunks).toString('utf8'))
      })
      response.on('error', rejectSanitized)
    })
    request.setTimeout(timeoutMs, () => {
      request.destroy(new CvmSsmSecretProviderError('TEMPORARY_CREDENTIALS_REQUIRED'))
    })
    request.on('error', rejectSanitized)
    if (signal) signal.addEventListener('abort', handleAbort, { once: true })
    request.end()
  })
}

async function loadTemporaryCredentials({ roleName, metadataRequest, now, signal }) {
  if (!ROLE_NAME_PATTERN.test(roleName)) {
    throw new CvmSsmSecretProviderError('SSM_BOOTSTRAP_INVALID')
  }
  let payload
  try {
    const body = await metadataRequest({
      host: METADATA_IP,
      path: '/latest/meta-data/cam/security-credentials/' + encodeURIComponent(roleName),
      timeoutMs: METADATA_TIMEOUT_MS,
      maxBytes: METADATA_MAX_BYTES,
      signal
    })
    payload = JSON.parse(body)
  } catch {
    if (signal.aborted) throw abortError(
      signal,
      'TEMPORARY_CREDENTIALS_REQUIRED'
    )
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
 * @param {(request: {host: string, path: string, timeoutMs: number, maxBytes: number, signal?: AbortSignal}) => Promise<string>} [options.metadataRequest]
 * @param {(input: {region: string, credentials: {secretId: string, secretKey: string, token: string, expiresAt: string}}) => {getSecretValue: (input: {SecretName: string, VersionId: string}, options?: {signal?: AbortSignal}) => Promise<{SecretName?: string, VersionId?: string, SecretString?: string}>}} [options.clientFactory]
 * @param {string} [options.region]
 * @param {() => number} [options.now]
 * @param {(event: string, metadata: {loadedCount: number, region: string}) => void} [options.audit]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.deadlineMs]
 */
async function loadCvmSsmSecrets({
  references,
  roleName,
  metadataRequest = requestCvmMetadata,
  clientFactory = createTencentSsmClient,
  region = REGION,
  now = Date.now,
  audit = () => {},
  signal,
  deadlineMs = CVM_SSM_LOAD_DEADLINE_MS
} = {}) {
  if (region !== REGION ||
    typeof roleName !== 'string' ||
    typeof metadataRequest !== 'function' ||
    typeof clientFactory !== 'function' ||
    typeof now !== 'function' ||
    typeof audit !== 'function' ||
    (signal !== undefined && (!signal ||
      typeof signal.addEventListener !== 'function')) ||
    !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) {
    throw new CvmSsmSecretProviderError('SSM_BOOTSTRAP_INVALID')
  }
  const normalizedReferences = normalizeReferences(references)
  const operation = createOperationSignal(signal, deadlineMs)
  try {
    const credentials = await loadTemporaryCredentials({
      roleName,
      metadataRequest,
      now,
      signal: operation.signal
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
        if (operation.signal.aborted) throw abortError(
          operation.signal,
          'SSM_SECRET_LOAD_FAILED'
        )
        if (!isValidTemporaryCredentials(credentials, now())) {
          throw new CvmSsmSecretProviderError('TEMPORARY_CREDENTIALS_REQUIRED')
        }
        const response = await awaitAbortable(() => client.getSecretValue({
          SecretName: reference.secretName,
          VersionId: reference.versionId
        }, { signal: operation.signal }), operation.signal)
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
      if (operation.signal.aborted) throw abortError(
        operation.signal,
        'SSM_SECRET_LOAD_FAILED'
      )
      if (error instanceof CvmSsmSecretProviderError) throw error
      throw new CvmSsmSecretProviderError('SSM_SECRET_LOAD_FAILED')
    }
    return new LoadedSecretProvider(entries)
  } finally {
    operation.clear()
  }
}

module.exports = {
  CvmSsmSecretProviderError,
  CVM_SSM_LOAD_DEADLINE_MS,
  LoadedSecretProvider,
  MAX_VERSIONS_PER_SECRET,
  METADATA_IP,
  METADATA_MAX_BYTES,
  REGION,
  loadCvmSsmSecrets,
  requestCvmMetadata
}
