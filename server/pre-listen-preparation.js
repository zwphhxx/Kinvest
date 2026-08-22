const { bootstrapSecrets } = require('./security/secret-bootstrap')
const {
  createAccessControlRuntime
} = require('./security/access-control-runtime')
const { closeDb, openDb } = require('./db/refresh-db')
const { parseTrustedProxyAddresses } = require('./http/trusted-client')

function httpSecurityConfigurationError() {
  return Object.assign(new Error('HTTP security configuration invalid'), {
    code: 'HTTP_SECURITY_CONFIG_INVALID'
  })
}

function defaultCreateHandler(options) {
  return require('./server').createRequestHandler(options)
}

function clearRuntimes(accessRuntime, secretRuntime) {
  try {
    if (accessRuntime) accessRuntime.clear()
  } catch {
    // Cleanup remains best-effort so every secret container is reached.
  }
  try {
    if (secretRuntime) secretRuntime.clear()
  } catch {
    // Cleanup errors must not replace stable startup or preflight errors.
  }
}

function throwIfAborted(signal) {
  if (!signal || !signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw Object.assign(new Error('Application preparation interrupted'), {
    code: 'ACCESS_PREFLIGHT_INTERRUPTED'
  })
}

/** @param {any} [options] */
async function prepareApplication({
  env = process.env,
  bootstrap = bootstrapSecrets,
  loadSecrets,
  signal,
  createAccessRuntime = createAccessControlRuntime,
  openDatabase = openDb,
  closeDatabase = closeDb,
  createHandler = defaultCreateHandler
} = {}) {
  throwIfAborted(signal)
  const secretRuntime = await bootstrap({ env, loadSecrets, signal })
  try {
    throwIfAborted(signal)
  } catch (error) {
    clearRuntimes(null, secretRuntime)
    throw error
  }
  let accessRuntime
  try {
    accessRuntime = createAccessRuntime({
      env,
      secretRuntime,
      openDatabase,
      closeDatabase
    })
  } catch (error) {
    clearRuntimes(null, secretRuntime)
    throw error
  }

  let trustedProxyAddresses
  let handler
  try {
    trustedProxyAddresses = parseTrustedProxyAddresses(
      env.KINVEST_TRUSTED_PROXY_ADDRESSES,
      { required: accessRuntime.status.mode === 'device-approval' }
    )
    handler = createHandler({
      accessRuntime,
      trustedProxyAddresses
    })
  } catch {
    clearRuntimes(accessRuntime, secretRuntime)
    throw httpSecurityConfigurationError()
  }

  const references = secretRuntime && secretRuntime.status &&
    secretRuntime.status.referenceCount
  if (!Number.isSafeInteger(references) || references < 0 ||
    (accessRuntime.status.mode === 'device-approval' && references !== 2)) {
    clearRuntimes(accessRuntime, secretRuntime)
    throw Object.assign(new Error('Access control configuration invalid'), {
      code: 'ACCESS_CONTROL_CONFIG_INVALID'
    })
  }

  let cleared = false
  return Object.freeze({
    status: Object.freeze({
      mode: accessRuntime.status.mode,
      references,
      database: accessRuntime.status.mode === 'device-approval'
        ? 'ready'
        : 'not-required',
      proxy: 'ready'
    }),
    handler,
    clear() {
      if (cleared) return
      cleared = true
      clearRuntimes(accessRuntime, secretRuntime)
    }
  })
}

module.exports = {
  prepareApplication
}
