const crypto = require('node:crypto')

const REGION = 'ap-shanghai'
const ROLE_NAME = 'KinvestProdCvmSsmReader'
const ADMIN_SECRET_NAME = 'kinvest-prod-admin-password-verifier'
const DEVICE_HMAC_SECRET_NAME = 'kinvest-prod-device-token-hmac-key'

const ADMIN_FORMAT = 'kinvest-admin-scrypt-v1'
const SCRYPT_N = 65536
const SCRYPT_P = 1
const SCRYPT_R = 8
const SCRYPT_MAXMEM = 128 * 1024 * 1024
const VERSION_ID_PATTERN = /^v[0-9]{8}-[0-9]{3}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const MAX_HMAC_VERSIONS = 10

class SecretBootstrapContractError extends Error {
  constructor(code) {
    const messages = {
      ADMIN_PASSWORD_INVALID: 'The administrator password does not meet the contract',
      ADMIN_VERIFIER_GENERATION_FAILED: 'The administrator verifier could not be generated',
      ADMIN_VERIFIER_INVALID: 'The administrator verifier is invalid',
      DEVICE_HMAC_INVALID: 'The device HMAC material is invalid',
      SECRET_MATERIAL_INVALID: 'Loaded secret material is invalid',
      SECRET_MATERIAL_LOAD_FAILED: 'Required secret material could not be loaded',
      SECRET_MATERIAL_PROVIDER_INVALID: 'The loaded secret provider is invalid',
      SECRET_RANDOM_SOURCE_INVALID: 'The random source returned invalid material',
      SECRET_VERSION_CONFIG_INVALID: 'The secret version configuration is invalid'
    }
    super(messages[code] || 'The secret bootstrap contract failed')
    this.name = 'SecretBootstrapContractError'
    this.code = code
  }
}

function fail(code) {
  throw new SecretBootstrapContractError(code)
}

function hasExactKeys(value, expected) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
}

function isValidVersionId(value) {
  return typeof value === 'string' && VERSION_ID_PATTERN.test(value)
}

function freezeReferences(references) {
  return Object.freeze(references.map((reference) => Object.freeze(reference)))
}

function parseSecretVersionConfig(raw) {
  if (typeof raw !== 'string') fail('SECRET_VERSION_CONFIG_INVALID')
  if (raw === '{}') {
    return Object.freeze({
      mode: 'disabled',
      canonicalJson: '{}',
      references: Object.freeze([])
    })
  }

  let input
  try {
    input = JSON.parse(raw)
  } catch {
    fail('SECRET_VERSION_CONFIG_INVALID')
  }
  if (!hasExactKeys(input, ['adminPasswordVerifier', 'deviceTokenHmac']) ||
    !hasExactKeys(input.deviceTokenHmac, ['accepted', 'active']) ||
    !isValidVersionId(input.adminPasswordVerifier) ||
    !isValidVersionId(input.deviceTokenHmac.active) ||
    !Array.isArray(input.deviceTokenHmac.accepted) ||
    input.deviceTokenHmac.accepted.length < 1 ||
    input.deviceTokenHmac.accepted.length > MAX_HMAC_VERSIONS ||
    input.deviceTokenHmac.accepted.some((versionId) => !isValidVersionId(versionId))) {
    fail('SECRET_VERSION_CONFIG_INVALID')
  }

  const accepted = [...input.deviceTokenHmac.accepted].sort()
  if (new Set(accepted).size !== accepted.length ||
    !accepted.includes(input.deviceTokenHmac.active)) {
    fail('SECRET_VERSION_CONFIG_INVALID')
  }
  const normalized = {
    adminPasswordVerifier: input.adminPasswordVerifier,
    deviceTokenHmac: {
      accepted,
      active: input.deviceTokenHmac.active
    }
  }
  const canonicalJson = JSON.stringify(normalized)
  if (raw !== canonicalJson) fail('SECRET_VERSION_CONFIG_INVALID')

  return Object.freeze({
    mode: 'cvm-ssm',
    canonicalJson,
    references: freezeReferences([
      {
        secretName: ADMIN_SECRET_NAME,
        versionId: normalized.adminPasswordVerifier
      },
      ...accepted.map((versionId) => ({
        secretName: DEVICE_HMAC_SECRET_NAME,
        versionId
      }))
    ])
  })
}

function readSecretText(input, code) {
  if (typeof input === 'string') return input
  if (!Buffer.isBuffer(input)) fail(code)
  const value = input.toString('utf8')
  if (!Buffer.from(value, 'utf8').equals(input)) fail(code)
  return value
}

function decodeCanonicalBase64url(value, byteLength, code) {
  if (typeof value !== 'string' ||
    !BASE64URL_PATTERN.test(value) ||
    value.length !== Math.ceil(byteLength * 8 / 6)) {
    fail(code)
  }
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== byteLength || decoded.toString('base64url') !== value) {
    decoded.fill(0)
    fail(code)
  }
  return decoded
}

function parseAdminPasswordVerifier(input) {
  const raw = readSecretText(input, 'ADMIN_VERIFIER_INVALID')
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    fail('ADMIN_VERIFIER_INVALID')
  }
  if (!hasExactKeys(value, ['digest', 'format', 'n', 'p', 'r', 'salt']) ||
    value.format !== ADMIN_FORMAT ||
    value.n !== SCRYPT_N ||
    value.p !== SCRYPT_P ||
    value.r !== SCRYPT_R) {
    fail('ADMIN_VERIFIER_INVALID')
  }
  const canonicalJson = JSON.stringify({
    digest: value.digest,
    format: value.format,
    n: value.n,
    p: value.p,
    r: value.r,
    salt: value.salt
  })
  if (raw !== canonicalJson) fail('ADMIN_VERIFIER_INVALID')

  const digest = decodeCanonicalBase64url(value.digest, 32, 'ADMIN_VERIFIER_INVALID')
  let salt
  try {
    salt = decodeCanonicalBase64url(value.salt, 16, 'ADMIN_VERIFIER_INVALID')
  } catch (error) {
    digest.fill(0)
    throw error
  }
  return Object.freeze({
    digest,
    format: ADMIN_FORMAT,
    n: SCRYPT_N,
    p: SCRYPT_P,
    r: SCRYPT_R,
    salt
  })
}

function secureRandomBytes(size, randomBytes) {
  if (typeof randomBytes !== 'function') fail('SECRET_RANDOM_SOURCE_INVALID')
  let value
  try {
    value = randomBytes(size)
  } catch {
    fail('SECRET_RANDOM_SOURCE_INVALID')
  }
  if (!Buffer.isBuffer(value) || value.length !== size) {
    if (Buffer.isBuffer(value)) value.fill(0)
    fail('SECRET_RANDOM_SOURCE_INVALID')
  }
  return value
}

function generateAdminPasswordVerifier(password, randomBytes = crypto.randomBytes) {
  if (typeof password !== 'string') fail('ADMIN_PASSWORD_INVALID')
  const codePointLength = Array.from(password).length
  if (codePointLength < 16 || codePointLength > 128) fail('ADMIN_PASSWORD_INVALID')

  const salt = secureRandomBytes(16, randomBytes)
  let digest
  try {
    digest = crypto.scryptSync(password, salt, 32, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM
    })
    return JSON.stringify({
      digest: digest.toString('base64url'),
      format: ADMIN_FORMAT,
      n: SCRYPT_N,
      p: SCRYPT_P,
      r: SCRYPT_R,
      salt: salt.toString('base64url')
    })
  } catch {
    fail('ADMIN_VERIFIER_GENERATION_FAILED')
  } finally {
    salt.fill(0)
    if (digest) digest.fill(0)
  }
}

function parseDeviceHmacSecret(input) {
  return decodeCanonicalBase64url(
    readSecretText(input, 'DEVICE_HMAC_INVALID'),
    32,
    'DEVICE_HMAC_INVALID'
  )
}

function generateDeviceHmacSecret(randomBytes = crypto.randomBytes) {
  const value = secureRandomBytes(32, randomBytes)
  try {
    return value.toString('base64url')
  } finally {
    value.fill(0)
  }
}

function validateConfigObject(config) {
  try {
    if (!config || typeof config !== 'object' || typeof config.canonicalJson !== 'string') {
      fail('SECRET_VERSION_CONFIG_INVALID')
    }
    const normalized = parseSecretVersionConfig(config.canonicalJson)
    if (config.mode !== normalized.mode ||
      JSON.stringify(config.references) !== JSON.stringify(normalized.references)) {
      fail('SECRET_VERSION_CONFIG_INVALID')
    }
    return normalized
  } catch (error) {
    if (error instanceof SecretBootstrapContractError) throw error
    fail('SECRET_VERSION_CONFIG_INVALID')
  }
}

async function validateLoadedSecretMaterial(provider, config) {
  const normalized = validateConfigObject(config)
  if (normalized.mode === 'disabled') {
    return Object.freeze({ mode: 'disabled', referenceCount: 0 })
  }
  let readSecret
  try {
    readSecret = provider && provider.readSecret
  } catch {
    fail('SECRET_MATERIAL_PROVIDER_INVALID')
  }
  if (typeof readSecret !== 'function') {
    fail('SECRET_MATERIAL_PROVIDER_INVALID')
  }

  for (const reference of normalized.references) {
    let raw
    try {
      raw = await readSecret.call(provider, reference)
    } catch {
      fail('SECRET_MATERIAL_LOAD_FAILED')
    }
    try {
      if (reference.secretName === ADMIN_SECRET_NAME) {
        const parsed = parseAdminPasswordVerifier(raw)
        parsed.digest.fill(0)
        parsed.salt.fill(0)
      } else {
        parseDeviceHmacSecret(raw).fill(0)
      }
    } catch {
      fail('SECRET_MATERIAL_INVALID')
    }
  }

  return Object.freeze({
    mode: 'cvm-ssm',
    referenceCount: normalized.references.length
  })
}

module.exports = {
  ADMIN_SECRET_NAME,
  DEVICE_HMAC_SECRET_NAME,
  REGION,
  ROLE_NAME,
  SecretBootstrapContractError,
  generateAdminPasswordVerifier,
  generateDeviceHmacSecret,
  parseAdminPasswordVerifier,
  parseDeviceHmacSecret,
  parseSecretVersionConfig,
  validateLoadedSecretMaterial
}
