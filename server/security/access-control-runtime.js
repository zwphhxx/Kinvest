const crypto = require('node:crypto')
const { AdminAuthRepository } = require('../db/admin-auth-repository')
const { DeviceAuthRepository } = require('../db/device-auth-repository')
const { AdminAuthService } = require('./admin-auth')
const { DeviceApprovalService } = require('./device-approval')
const {
  ADMIN_SECRET_NAME,
  DEVICE_HMAC_SECRET_NAME,
  parseDeviceHmacSecret,
  parseSecretVersionConfig
} = require('./secret-bootstrap-contract')

const ADMIN_RATE_LIMIT_KEY_DOMAIN = 'kinvest-admin-rate-limit-key-v1'

class AccessControlRuntimeError extends Error {
  constructor() {
    super('The access control configuration is invalid')
    this.name = 'AccessControlRuntimeError'
    this.code = 'ACCESS_CONTROL_CONFIG_INVALID'
  }
}

function fail() {
  throw new AccessControlRuntimeError()
}

function parseMode(env) {
  if (!env || typeof env !== 'object') fail()
  if (!Object.prototype.hasOwnProperty.call(env, 'KINVEST_ACCESS_CONTROL_MODE')) {
    return 'disabled'
  }
  const mode = env.KINVEST_ACCESS_CONTROL_MODE
  if (mode !== 'disabled' && mode !== 'device-approval') fail()
  return mode
}

function disabledRuntime() {
  return Object.freeze({
    status: Object.freeze({ mode: 'disabled' }),
    adminAuth: null,
    deviceApproval: null,
    clear() {}
  })
}

function readVersionSelection(env, secretRuntime) {
  if (!secretRuntime || !secretRuntime.status ||
    secretRuntime.status.mode !== 'github-tmpfs-v1' ||
    typeof env.KINVEST_SECRET_VERSION_IDS !== 'string') {
    fail()
  }
  let config
  let selection
  try {
    config = parseSecretVersionConfig(env.KINVEST_SECRET_VERSION_IDS)
    selection = JSON.parse(config.canonicalJson)
  } catch {
    fail()
  }
  if (config.mode !== 'cvm-ssm' || config.references.length !== 2 ||
    selection.deviceTokenHmac.accepted.length !== 1 ||
    selection.deviceTokenHmac.accepted[0] !== selection.deviceTokenHmac.active) {
    fail()
  }
  return selection
}

function createAccessControlRuntime({
  env = process.env,
  secretRuntime,
  database,
  openDatabase,
  now = Date.now,
  randomBytes = crypto.randomBytes
} = {}) {
  const mode = parseMode(env)
  if (mode === 'disabled') return disabledRuntime()

  let adminMaterial
  let hmacMaterial
  let parsedHmacMaterial
  let rateLimitKey
  let adminAuth
  try {
    const selection = readVersionSelection(env, secretRuntime)
    adminMaterial = secretRuntime.readSecret({
      secretName: ADMIN_SECRET_NAME,
      versionId: selection.adminPasswordVerifier
    })
    hmacMaterial = secretRuntime.readSecret({
      secretName: DEVICE_HMAC_SECRET_NAME,
      versionId: selection.deviceTokenHmac.active
    })
    if (!Buffer.isBuffer(adminMaterial) || !Buffer.isBuffer(hmacMaterial)) fail()
    parsedHmacMaterial = parseDeviceHmacSecret(hmacMaterial)
    rateLimitKey = crypto.createHmac('sha256', parsedHmacMaterial)
      .update(ADMIN_RATE_LIMIT_KEY_DOMAIN, 'utf8')
      .digest()

    const sharedDatabase = database || (
      typeof openDatabase === 'function' ? openDatabase() : null
    )
    if (!sharedDatabase) fail()
    const adminRepository = new AdminAuthRepository(sharedDatabase)
    const deviceRepository = new DeviceAuthRepository(sharedDatabase)
    adminRepository.initialize()
    deviceRepository.initialize()
    adminAuth = new AdminAuthService({
      repository: adminRepository,
      adminVerifierMaterial: adminMaterial,
      rateLimitKey,
      now,
      randomBytes
    })
    const deviceApproval = new DeviceApprovalService({
      repository: deviceRepository,
      secretProvider: secretRuntime,
      hmacSecretName: DEVICE_HMAC_SECRET_NAME,
      activeHmacVersionId: selection.deviceTokenHmac.active,
      now,
      randomBytes
    })
    let cleared = false
    return Object.freeze({
      status: Object.freeze({ mode: 'device-approval' }),
      adminAuth,
      deviceApproval,
      clear() {
        if (cleared) return
        cleared = true
        adminAuth.clear()
      }
    })
  } catch (error) {
    if (adminAuth) adminAuth.clear()
    if (error instanceof AccessControlRuntimeError) throw error
    fail()
  } finally {
    if (Buffer.isBuffer(adminMaterial)) adminMaterial.fill(0)
    if (Buffer.isBuffer(hmacMaterial)) hmacMaterial.fill(0)
    if (Buffer.isBuffer(parsedHmacMaterial)) parsedHmacMaterial.fill(0)
    if (Buffer.isBuffer(rateLimitKey)) rateLimitKey.fill(0)
  }
}

module.exports = {
  AccessControlRuntimeError,
  createAccessControlRuntime
}
