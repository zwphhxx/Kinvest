const { bootstrapSecrets } = require('./security/secret-bootstrap')
const {
  createAccessControlRuntime
} = require('./security/access-control-runtime')
const {
  closeTrackedDatabase,
  initializeRefreshDatabase,
  openTrackedDb
} = require('./db/refresh-db')
const { parseTrustedProxyAddresses } = require('./http/trusted-client')
const {
  createIfindDiagnosticRuntime
} = require('./ifind-diagnostic-runtime')

function httpSecurityConfigurationError() {
  return Object.assign(new Error('HTTP security configuration invalid'), {
    code: 'HTTP_SECURITY_CONFIG_INVALID'
  })
}

function defaultCreateHandler(options) {
  return require('./server').createRequestHandler(options)
}

function clearRuntimes(ifindDiagnosticRuntime, accessRuntime, secretRuntime) {
  try {
    if (ifindDiagnosticRuntime) ifindDiagnosticRuntime.clear()
  } catch {
    // Cleanup remains best-effort so every secret container is reached.
  }
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
  createIfindRuntime = createIfindDiagnosticRuntime,
  openDatabase = openTrackedDb,
  closeDatabase = closeTrackedDatabase,
  initializeDatabase = initializeRefreshDatabase,
  createHandler = defaultCreateHandler,
  loadIfindSecrets,
  createIfindRepository,
  createIfindClient,
  createIfindService,
  createIfindMarketRepository,
  createIfindMarketService,
  ifindMarketCatalogLookup,
  ifindMarketManifestLookup,
  ifindMarketQuoteParser,
  ifindMarketFinancialParser,
  ifindMarketIdGenerator
} = {}) {
  throwIfAborted(signal)
  const secretRuntime = await bootstrap({ env, loadSecrets, signal })
  try {
    throwIfAborted(signal)
  } catch (error) {
    clearRuntimes(null, null, secretRuntime)
    throw error
  }
  let accessRuntime
  try {
    accessRuntime = createAccessRuntime({
      env,
      secretRuntime,
      openDatabase,
      closeDatabase,
      initializeDatabase
    })
  } catch (error) {
    clearRuntimes(null, null, secretRuntime)
    throw error
  }

  let trustedProxyAddresses
  try {
    trustedProxyAddresses = parseTrustedProxyAddresses(
      env.KINVEST_TRUSTED_PROXY_ADDRESSES,
      { required: accessRuntime.status.mode === 'device-approval' }
    )
  } catch {
    clearRuntimes(null, accessRuntime, secretRuntime)
    throw httpSecurityConfigurationError()
  }

  let ifindDiagnosticRuntime
  try {
    ifindDiagnosticRuntime = await createIfindRuntime({
      env,
      accessRuntime,
      openDatabase,
      ...(loadIfindSecrets ? { loadSecrets: loadIfindSecrets } : {}),
      ...(createIfindRepository ? { createRepository: createIfindRepository } : {}),
      ...(createIfindClient ? { createClient: createIfindClient } : {}),
      ...(createIfindService ? { createService: createIfindService } : {}),
      ...(createIfindMarketRepository !== undefined
        ? { createMarketRepository: createIfindMarketRepository } : {}),
      ...(createIfindMarketService !== undefined
        ? { createMarketService: createIfindMarketService } : {}),
      ...(ifindMarketCatalogLookup !== undefined
        ? { marketCatalogLookup: ifindMarketCatalogLookup } : {}),
      ...(ifindMarketManifestLookup !== undefined
        ? { marketManifestLookup: ifindMarketManifestLookup } : {}),
      ...(ifindMarketQuoteParser !== undefined
        ? { marketQuoteParser: ifindMarketQuoteParser } : {}),
      ...(ifindMarketFinancialParser !== undefined
        ? { marketFinancialParser: ifindMarketFinancialParser } : {}),
      ...(ifindMarketIdGenerator !== undefined
        ? { marketIdGenerator: ifindMarketIdGenerator } : {})
    })
  } catch (error) {
    clearRuntimes(null, accessRuntime, secretRuntime)
    throw error
  }

  let handler
  try {
    handler = createHandler({
      accessRuntime,
      trustedProxyAddresses,
      ifindDiagnosticRuntime
    })
  } catch {
    clearRuntimes(ifindDiagnosticRuntime, accessRuntime, secretRuntime)
    throw httpSecurityConfigurationError()
  }

  const references = secretRuntime && secretRuntime.status &&
    secretRuntime.status.referenceCount
  if (!Number.isSafeInteger(references) || references < 0 ||
    (accessRuntime.status.mode === 'device-approval' && references !== 2)) {
    clearRuntimes(ifindDiagnosticRuntime, accessRuntime, secretRuntime)
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
    ifindDiagnosticStatus: ifindDiagnosticRuntime.status,
    handler,
    clear() {
      if (cleared) return
      cleared = true
      clearRuntimes(ifindDiagnosticRuntime, accessRuntime, secretRuntime)
    }
  })
}

module.exports = {
  prepareApplication
}
