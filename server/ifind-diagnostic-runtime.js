const crypto = require('node:crypto')
const { types } = require('node:util')
const { createIfindHttpClient } = require('./adapters/ifind-http-client')
const {
  IfindDiagnosticRepository
} = require('./db/ifind-diagnostic-repository')
const {
  IfindMarketDiagnosticRepository
} = require('./db/ifind-market-diagnostic-repository')
const {
  createLiveRequestManifestBundle,
  getIfindMarketCase
} = require('./domain/ifind-market-cases')
const {
  parseIfindMarketFinancials
} = require('./domain/ifind-market-financial-parser')
const {
  parseIfindMarketQuote
} = require('./domain/ifind-market-quote-parser')
const {
  IFIND_BUNDLE_PATH,
  IFIND_DIAGNOSTIC_MODE_ADMIN,
  IFIND_DIAGNOSTIC_MODE_DISABLED,
  createIfindSecretContract
} = require('./security/ifind-secret-contract')
const {
  loadIfindTmpfsSecrets
} = require('./security/ifind-tmpfs-secret-provider')
const {
  createDefaultDiagnosticId,
  createIfindDiagnosticService
} = require('./services/ifind-diagnostic-service')
const {
  createIfindMarketDiagnosticService
} = require('./services/ifind-market-diagnostic-service')
const {
  createIfindCalibrationService
} = require('./services/ifind-calibration-service')
const {
  createIfindReportPeriodDiagnosticService
} = require('./services/ifind-report-period-diagnostic-service')
const {
  createIfindMarketProbeService
} = require('./services/ifind-market-probe-service')

const SAFE_CODES = new Set([
  'IFIND_DIAGNOSTIC_ACCESS_REQUIRED',
  'IFIND_DIAGNOSTIC_DATABASE_INVALID',
  'IFIND_DIAGNOSTIC_PROVIDER_INVALID',
  'IFIND_DIAGNOSTIC_RUNTIME_INVALID',
  'IFIND_DIAGNOSTIC_SCHEMA_INCOMPATIBLE',
  'IFIND_REFRESH_TOKEN_UNAVAILABLE',
  'IFIND_SECRET_CONFIG_INVALID',
  'IFIND_TMPFS_BUNDLE_INVALID'
])

const MESSAGES = Object.freeze({
  IFIND_DIAGNOSTIC_ACCESS_REQUIRED: 'The iFinD diagnostic access mode is invalid',
  IFIND_DIAGNOSTIC_DATABASE_INVALID: 'The iFinD diagnostic database is invalid',
  IFIND_DIAGNOSTIC_PROVIDER_INVALID: 'The iFinD diagnostic provider is invalid',
  IFIND_DIAGNOSTIC_RUNTIME_INVALID: 'The iFinD diagnostic runtime is invalid',
  IFIND_DIAGNOSTIC_SCHEMA_INCOMPATIBLE: 'The iFinD diagnostic schema is incompatible',
  IFIND_REFRESH_TOKEN_UNAVAILABLE: 'The iFinD refresh token is unavailable',
  IFIND_SECRET_CONFIG_INVALID: 'The iFinD secret configuration is invalid',
  IFIND_TMPFS_BUNDLE_INVALID: 'The iFinD tmpfs secret bundle is invalid'
})

class IfindDiagnosticRuntimeError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.IFIND_DIAGNOSTIC_RUNTIME_INVALID)
    this.name = 'IfindDiagnosticRuntimeError'
    this.code = SAFE_CODES.has(code) ? code : 'IFIND_DIAGNOSTIC_RUNTIME_INVALID'
  }
}

function fail(code) {
  throw new IfindDiagnosticRuntimeError(code)
}

function safeErrorCode(error) {
  try {
    if (types.isProxy(error) || error === null ||
      (typeof error !== 'object' && typeof error !== 'function')) return null
    const descriptor = Reflect.getOwnPropertyDescriptor(error, 'code')
    return descriptor && Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'string' ? descriptor.value : null
  } catch {
    return null
  }
}

function sanitizedError(error, fallbackCode) {
  const code = safeErrorCode(error)
  return new IfindDiagnosticRuntimeError(SAFE_CODES.has(code) ? code : fallbackCode)
}

function readDataProperty(value, key) {
  try {
    if (types.isProxy(value) || value === null || typeof value !== 'object') return null
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    return descriptor && Object.hasOwn(descriptor, 'value')
      ? { found: true, value: descriptor.value }
      : { found: false, value: undefined }
  } catch {
    return null
  }
}

function readMethod(value, key) {
  try {
    let current = value
    for (let depth = 0; depth < 4 && current !== null; depth += 1) {
      if (types.isProxy(current)) return null
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key)
      if (descriptor) {
        return Object.hasOwn(descriptor, 'value') &&
          typeof descriptor.value === 'function'
          ? descriptor.value.bind(value)
          : null
      }
      current = Reflect.getPrototypeOf(current)
    }
  } catch {
    // Hostile reflection is treated as an absent method.
  }
  return null
}

function readOptions(options) {
  if (options === undefined) return Object.create(null)
  try {
    if (types.isProxy(options) || options === null || typeof options !== 'object' ||
      Array.isArray(options)) fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
    const prototype = Reflect.getPrototypeOf(options)
    if (prototype !== Object.prototype && prototype !== null) {
      fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
    }
    const result = Object.create(null)
    for (const key of [
      'env', 'accessRuntime', 'openDatabase', 'loadSecrets', 'createRepository',
      'createClient', 'createService', 'clock', 'idSource',
      'createMarketRepository', 'createMarketService', 'marketCatalogLookup',
      'marketManifestLookup', 'marketQuoteParser', 'marketFinancialParser',
      'marketIdGenerator', 'createMarketProbeService'
    ]) {
      const property = readDataProperty(options, key)
      if (!property) fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
      if (property.found) result[key] = property.value
    }
    return result
  } catch (error) {
    if (error instanceof IfindDiagnosticRuntimeError) throw error
    fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
  }
}

function parseConfiguration(env) {
  try {
    if (types.isProxy(env) || env === null || typeof env !== 'object') {
      fail('IFIND_SECRET_CONFIG_INVALID')
    }
    const mode = readDataProperty(env, 'KINVEST_IFIND_DIAGNOSTIC_MODE')
    const bundlePath = readDataProperty(env, 'KINVEST_IFIND_SECRET_BUNDLE_PATH')
    const versionId = readDataProperty(env, 'KINVEST_IFIND_REFRESH_TOKEN_VERSION_ID')
    if (!mode || !bundlePath || !versionId) fail('IFIND_SECRET_CONFIG_INVALID')
    if (!mode.found && !bundlePath.found && !versionId.found) {
      return createIfindSecretContract({ mode: IFIND_DIAGNOSTIC_MODE_DISABLED })
    }
    if (mode.found && mode.value === IFIND_DIAGNOSTIC_MODE_DISABLED &&
      !bundlePath.found && !versionId.found) {
      return createIfindSecretContract({ mode: IFIND_DIAGNOSTIC_MODE_DISABLED })
    }
    return createIfindSecretContract({
      mode: mode.value,
      versionId: versionId.value,
      bundlePath: bundlePath.value
    })
  } catch (error) {
    throw sanitizedError(error, 'IFIND_SECRET_CONFIG_INVALID')
  }
}

function assertAccessRuntime(accessRuntime) {
  const statusProperty = readDataProperty(accessRuntime, 'status')
  const modeProperty = statusProperty && readDataProperty(statusProperty.value, 'mode')
  if (!modeProperty || !modeProperty.found ||
    modeProperty.value !== 'device-approval') {
    fail('IFIND_DIAGNOSTIC_ACCESS_REQUIRED')
  }
}

function disabledRuntime() {
  return Object.freeze({
    status: Object.freeze({
      mode: IFIND_DIAGNOSTIC_MODE_DISABLED,
      configured: false,
      versionId: null
    }),
    service: null,
    marketService: null,
    marketProbeService: null,
    reportPeriodService: null,
    clear() {}
  })
}

function clearBestEffort(...operations) {
  for (const operation of operations) {
    try { operation() } catch {
      // Every diagnostic resource must still receive cleanup.
    }
  }
}

function createDefaultMarketDiagnosticId() {
  return `market_run_${crypto.randomBytes(16).toString('hex')}`
}

function clearServiceClient(service, client) {
  const clearService = service && readMethod(service, 'clear')
  if (clearService) {
    try {
      clearService()
      return
    } catch {
      // Fall through so the client buffer is still cleared directly.
    }
  }
  const clearClient = client && readMethod(client, 'clear')
  if (clearClient) clearClient()
}

async function createIfindDiagnosticRuntime(options) {
  const config = readOptions(options)
  const contract = parseConfiguration(config.env || process.env)
  if (contract.mode === IFIND_DIAGNOSTIC_MODE_DISABLED) return disabledRuntime()

  assertAccessRuntime(config.accessRuntime)
  const openDatabase = config.openDatabase
  const loadSecrets = config.loadSecrets || loadIfindTmpfsSecrets
  const createRepository = config.createRepository ||
    ((database) => new IfindDiagnosticRepository(database))
  const createClient = config.createClient || createIfindHttpClient
  const createService = config.createService || createIfindDiagnosticService
  const createMarketRepository = Object.hasOwn(config, 'createMarketRepository')
    ? config.createMarketRepository
    : (database) => new IfindMarketDiagnosticRepository(database)
  const createMarketService = Object.hasOwn(config, 'createMarketService')
    ? config.createMarketService
    : createIfindMarketDiagnosticService
  const createMarketProbe = Object.hasOwn(config, 'createMarketProbeService')
    ? config.createMarketProbeService
    : createIfindMarketProbeService
  const marketCatalogLookup = Object.hasOwn(config, 'marketCatalogLookup')
    ? config.marketCatalogLookup
    : getIfindMarketCase
  const marketManifestLookup = Object.hasOwn(config, 'marketManifestLookup')
    ? config.marketManifestLookup
    : createLiveRequestManifestBundle
  const marketQuoteParser = Object.hasOwn(config, 'marketQuoteParser')
    ? config.marketQuoteParser
    : parseIfindMarketQuote
  const marketFinancialParser = Object.hasOwn(config, 'marketFinancialParser')
    ? config.marketFinancialParser
    : parseIfindMarketFinancials
  const marketIdGenerator = Object.hasOwn(config, 'marketIdGenerator')
    ? config.marketIdGenerator
    : createDefaultMarketDiagnosticId
  const clock = config.clock || Date.now
  const idSource = config.idSource || createDefaultDiagnosticId
  if (typeof openDatabase !== 'function' || typeof loadSecrets !== 'function' ||
    typeof createRepository !== 'function' || typeof createClient !== 'function' ||
    typeof createService !== 'function' || typeof clock !== 'function' ||
    typeof idSource !== 'function' || typeof createMarketRepository !== 'function' ||
    typeof createMarketService !== 'function' || typeof marketCatalogLookup !== 'function' ||
    typeof createMarketProbe !== 'function' ||
    typeof marketManifestLookup !== 'function' || typeof marketQuoteParser !== 'function' ||
    typeof marketFinancialParser !== 'function' || typeof marketIdGenerator !== 'function' ||
    types.isProxy(openDatabase) ||
    types.isProxy(loadSecrets) || types.isProxy(createRepository) ||
    types.isProxy(createClient) || types.isProxy(createService) ||
    types.isProxy(createMarketRepository) || types.isProxy(createMarketService) ||
    types.isProxy(createMarketProbe) ||
    types.isProxy(marketCatalogLookup) || types.isProxy(marketManifestLookup) ||
    types.isProxy(marketQuoteParser) || types.isProxy(marketFinancialParser) ||
    types.isProxy(marketIdGenerator) || types.isProxy(clock) ||
    types.isProxy(idSource)) {
    fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
  }

  let provider
  let legacyClient
  let marketClient
  let service
  let marketService
  let calibrationService = null
  let reportPeriodClient = null
  let reportPeriodService = null
  let probeClient = null
  let marketProbeService = null
  try {
    try {
      provider = await loadSecrets(Object.freeze({
        mode: IFIND_DIAGNOSTIC_MODE_ADMIN,
        versionId: contract.versionId,
        bundlePath: IFIND_BUNDLE_PATH
      }))
    } catch (error) {
      throw sanitizedError(error, 'IFIND_DIAGNOSTIC_PROVIDER_INVALID')
    }
    const readRefreshToken = readMethod(provider, 'readRefreshToken')
    const clearProvider = readMethod(provider, 'clear')
    if (!readRefreshToken || !clearProvider) {
      fail('IFIND_DIAGNOSTIC_PROVIDER_INVALID')
    }

    let database
    let repository
    try {
      database = openDatabase()
      repository = createRepository(database)
      const initialize = readMethod(repository, 'initialize')
      if (!initialize || !readMethod(repository, 'reserve') ||
        !readMethod(repository, 'complete') || !readMethod(repository, 'fail') ||
        !readMethod(repository, 'latest') || !readMethod(repository, 'status')) {
        fail('IFIND_DIAGNOSTIC_DATABASE_INVALID')
      }
      initialize()
    } catch (error) {
      throw sanitizedError(error, 'IFIND_DIAGNOSTIC_DATABASE_INVALID')
    }

    try {
      legacyClient = createClient()
      if (!readMethod(legacyClient, 'diagnose') ||
        !readMethod(legacyClient, 'clear')) {
        fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
      }
      marketClient = createClient()
      if (marketClient === legacyClient) {
        fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
      }
      const marketMethods = ['authenticate', 'quote', 'financial']
        .map((method) => readMethod(marketClient, method))
      if (!marketMethods.every(Boolean) || !readMethod(marketClient, 'clear')) {
        fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
      }

      let marketRepository
      try {
        marketRepository = createMarketRepository(database)
        const initialize = readMethod(marketRepository, 'initialize')
        if (!initialize || !readMethod(marketRepository, 'reserve') ||
          !readMethod(marketRepository, 'complete') ||
          !readMethod(marketRepository, 'fail') ||
          !readMethod(marketRepository, 'latest') ||
          !readMethod(marketRepository, 'history') ||
          !readMethod(marketRepository, 'quotaStatus')) {
          fail('IFIND_DIAGNOSTIC_DATABASE_INVALID')
        }
        initialize()
      } catch (error) {
        throw sanitizedError(error, 'IFIND_DIAGNOSTIC_DATABASE_INVALID')
      }

      service = createService({
        mode: IFIND_DIAGNOSTIC_MODE_ADMIN,
        tokenVersionId: contract.versionId,
        repository,
        client: legacyClient,
        secretProvider: provider,
        clock,
        idSource
      })
      if (!readMethod(service, 'status') || !readMethod(service, 'run') ||
        !readMethod(service, 'clear')) fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
      marketService = createMarketService({
        tokenVersionId: contract.versionId,
        clock,
        idGenerator: marketIdGenerator,
        catalogLookup: marketCatalogLookup,
        manifestLookup: marketManifestLookup,
        client: marketClient,
        quoteParser: marketQuoteParser,
        financialParser: marketFinancialParser,
        repository: marketRepository,
        secretProvider: provider
      })
      if (!readMethod(marketService, 'run') ||
          !readMethod(marketService, 'latest') ||
          !readMethod(marketService, 'history') ||
          !readMethod(marketService, 'quotaStatus')) {
        fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
      }
      // Older injected clients remain usable for their existing diagnostics.
      // Only the fixed production client capability can expose calibration.
      if (readMethod(marketClient, 'calibrateFinancial')) {
        calibrationService = createIfindCalibrationService({
          repository: marketRepository,
          client: marketClient,
          secretProvider: provider,
          tokenVersionId: contract.versionId,
          clock,
          idGenerator: marketIdGenerator
        })
      }
      // Preserve older injected clients. The new capability uses its own instance
      // so late cleanup cannot clear a running market case or calibration token.
      if (readMethod(marketClient, 'diagnoseReportPeriod')) {
        const candidate = createClient()
        if (candidate === legacyClient || candidate === marketClient) {
          fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
        }
        reportPeriodClient = candidate
        if (!readMethod(reportPeriodClient, 'authenticate') ||
            !readMethod(reportPeriodClient, 'diagnoseReportPeriod') ||
            !readMethod(reportPeriodClient, 'clear')) fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
        reportPeriodService = createIfindReportPeriodDiagnosticService({
          repository: marketRepository,
          client: reportPeriodClient,
          secretProvider: provider,
          tokenVersionId: contract.versionId,
          clock,
          idGenerator: marketIdGenerator
        })
      }
      if (readMethod(marketClient, 'probeFixed')) {
        const candidate = createClient()
        if (candidate === legacyClient || candidate === marketClient ||
            candidate === reportPeriodClient) {
          fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
        }
        probeClient = candidate
        if (!readMethod(probeClient, 'authenticate') ||
            !readMethod(probeClient, 'probeFixed') ||
            !readMethod(probeClient, 'clear')) {
          fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
        }
        marketProbeService = createMarketProbe({
          repository: marketRepository,
          client: probeClient,
          secretProvider: provider,
          tokenVersionId: contract.versionId,
          clock,
          idGenerator: marketIdGenerator
        })
        if (!readMethod(marketProbeService, 'describe') ||
            !readMethod(marketProbeService, 'run') ||
            !readMethod(marketProbeService, 'clear')) {
          fail('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
        }
      }
    } catch (error) {
      throw sanitizedError(error, 'IFIND_DIAGNOSTIC_RUNTIME_INVALID')
    }

    let cleared = false
    return Object.freeze({
      status: Object.freeze({
        mode: IFIND_DIAGNOSTIC_MODE_ADMIN,
        configured: true,
        versionId: contract.versionId
      }),
      service,
      marketService,
      marketProbeService,
      ...(calibrationService ? { calibrationService } : {}),
      reportPeriodService,
      clear() {
        if (cleared) return
        cleared = true
        clearBestEffort(
          () => clearServiceClient(service, legacyClient),
          () => { if (calibrationService) calibrationService.clear() },
          () => { if (reportPeriodService) reportPeriodService.clear() },
          () => { if (reportPeriodClient) readMethod(reportPeriodClient, 'clear')() },
          () => clearServiceClient(marketProbeService, probeClient),
          () => readMethod(marketClient, 'clear')(),
          () => readMethod(provider, 'clear')()
        )
      }
    })
  } catch (error) {
    clearBestEffort(
      () => clearServiceClient(service, legacyClient),
      () => { if (calibrationService) calibrationService.clear() },
      () => { if (reportPeriodService) reportPeriodService.clear() },
      () => {
        const clearReportClient = reportPeriodClient && readMethod(reportPeriodClient, 'clear')
        if (clearReportClient) clearReportClient()
      },
      () => clearServiceClient(marketProbeService, probeClient),
      () => {
        if (!marketClient || marketClient === legacyClient) return
        const clearMarketClient = readMethod(marketClient, 'clear')
        if (clearMarketClient) clearMarketClient()
      },
      () => { if (provider) readMethod(provider, 'clear')() }
    )
    if (error instanceof IfindDiagnosticRuntimeError) throw error
    throw sanitizedError(error, 'IFIND_DIAGNOSTIC_RUNTIME_INVALID')
  }
}

module.exports = {
  IfindDiagnosticRuntimeError,
  createIfindDiagnosticRuntime
}
