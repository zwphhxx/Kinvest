'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { DatabaseSync } = require('node:sqlite')

const { createIfindHttpClient } = require('../adapters/ifind-http-client')
const {
  IfindMarketDiagnosticRepository
} = require('../db/ifind-market-diagnostic-repository')
const {
  KINVEST_SQLITE_APPLICATION_ID
} = require('../db/database-identity')
const {
  createLiveRequestManifest,
  getIfindMarketCase
} = require('../domain/ifind-market-cases')
const {
  parseIfindMarketFinancials
} = require('../domain/ifind-market-financial-parser')
const {
  parseIfindMarketQuote
} = require('../domain/ifind-market-quote-parser')
const {
  createIfindMarketDiagnosticService
} = require('../services/ifind-market-diagnostic-service')

const VERSION_ID = 'v20260830-001'

function enabledEnv() {
  return {
    KINVEST_IFIND_DIAGNOSTIC_MODE: 'admin-diagnostic',
    KINVEST_IFIND_SECRET_BUNDLE_PATH: '/run/secrets/kinvest-ifind',
    KINVEST_IFIND_REFRESH_TOKEN_VERSION_ID: VERSION_ID,
    KINVEST_TRUSTED_PROXY_ADDRESSES: '["127.0.0.1"]'
  }
}

function enabledAccess(clear = () => {}) {
  return {
    status: Object.freeze({ mode: 'device-approval' }),
    adminAuth: {},
    deviceApproval: {},
    clear
  }
}

function secretProvider(state) {
  const token = Buffer.from('fixture-refresh-token')
  return {
    readRefreshToken() {
      state.reads += 1
      return Buffer.from(token)
    },
    clear() {
      if (state.cleared) return
      state.cleared = true
      state.clearCalls += 1
      token.fill(0)
    }
  }
}

function noNetworkClient(state) {
  return createIfindHttpClient({
    request() {
      state.transportCalls += 1
      throw new Error('transport must not run')
    }
  })
}

function instrumentedProductionClient(state) {
  const client = noNetworkClient(state)
  return {
    diagnose: client.diagnose,
    authenticate: client.authenticate,
    quote: client.quote,
    financial: client.financial,
    clear() {
      state.clientClearCalls += 1
      client.clear()
    }
  }
}

function incompleteProductionClient(state, missing) {
  const complete = instrumentedProductionClient(state)
  const client = {}
  for (const method of ['diagnose', 'authenticate', 'quote', 'financial', 'clear']) {
    if (method !== missing && !(missing === 'all-market' &&
      ['authenticate', 'quote', 'financial'].includes(method))) {
      client[method] = complete[method]
    }
  }
  return client
}

class FakeServer extends EventEmitter {
  constructor() {
    super()
    this.listenCalls = 0
    this.closeCalls = 0
  }

  listen(_port, callback) {
    this.listenCalls += 1
    callback()
    return this
  }

  close(callback) {
    this.closeCalls += 1
    this.emit('close')
    if (callback) callback()
  }
}

function createServerHarness(overrides = {}) {
  const { startServer } = require('../server')
  const database = new DatabaseSync(':memory:')
  if (overrides.prepareDatabase) overrides.prepareDatabase(database)
  const server = new FakeServer()
  const processRef = new EventEmitter()
  const providerState = { reads: 0, clearCalls: 0, cleared: false }
  const provider = secretProvider(providerState)
  const state = {
    transportCalls: 0,
    clientClearCalls: 0,
    clientCreates: 0,
    providerLoads: 0,
    databaseCloseCalls: 0,
    fallbackCloseCalls: 0,
    secretClearCalls: 0,
    handlerCalls: 0,
    runtime: null
  }
  const options = {
    env: enabledEnv(),
    runtimeServer: server,
    bootstrap: async () => ({
      status: Object.freeze({ mode: 'github-tmpfs-v1', referenceCount: 2 }),
      clear() { state.secretClearCalls += 1 }
    }),
    createAccessRuntime: ({ openDatabase, closeDatabase }) => {
      const shared = openDatabase()
      let cleared = false
      return enabledAccess(() => {
        if (cleared) return
        cleared = true
        closeDatabase(shared)
      })
    },
    openDatabase: () => database,
    closeDatabase: (value) => {
      state.databaseCloseCalls += 1
      value.close()
    },
    closeApplicationDatabase: () => { state.fallbackCloseCalls += 1 },
    loadIfindSecrets: async (config) => {
      state.providerLoads += 1
      if (overrides.loadIfindSecrets) {
        return overrides.loadIfindSecrets({ config, provider, providerState, state })
      }
      return provider
    },
    createIfindClient: () => {
      state.clientCreates += 1
      return overrides.createIfindClient
        ? overrides.createIfindClient(state)
        : instrumentedProductionClient(state)
    },
    createHttpHandler: (handlerOptions) => {
      state.handlerCalls += 1
      state.runtime = handlerOptions.ifindDiagnosticRuntime
      return () => {}
    },
    processRef,
    logger: { log() {} },
    ...(overrides.runtimeOptions || {})
  }
  return {
    database,
    options,
    processRef,
    providerState,
    server,
    state,
    start: () => startServer(options),
    dispose() {
      if (state.databaseCloseCalls === 0) database.close()
    }
  }
}

function hasCode(code) {
  return (error) => error && error.code === code
}

async function testDisabledModeDoesNotInitializeMarketRuntime() {
  const {
    createIfindDiagnosticRuntime
  } = require('../ifind-diagnostic-runtime')
  const calls = []
  const runtime = await createIfindDiagnosticRuntime({
    env: {},
    accessRuntime: enabledAccess(),
    openDatabase() { calls.push('database') },
    loadSecrets() { calls.push('provider') },
    createClient() { calls.push('client') },
    createMarketRepository() { calls.push('market-repository') },
    createMarketService() { calls.push('market-service') }
  })

  assert.equal(runtime.marketService, null)
  assert.deepEqual(calls, [])
}

async function testEnabledModeRejectsIncompleteProductionClient() {
  for (const missing of [
    'authenticate', 'quote', 'financial', 'clear', 'all-market'
  ]) {
    const harness = createServerHarness({
      createIfindClient: (state) => incompleteProductionClient(state, missing)
    })
    try {
      await assert.rejects(
        harness.start(),
        hasCode('IFIND_DIAGNOSTIC_RUNTIME_INVALID'),
        missing
      )
      assert.equal(harness.server.listenCalls, 0, missing)
      assert.equal(harness.state.handlerCalls, 0, missing)
      assert.equal(harness.state.runtime, null, missing)
      assert.equal(harness.providerState.clearCalls, 1, missing)
      assert.equal(harness.state.databaseCloseCalls, 1, missing)
      assert.equal(
        harness.state.clientClearCalls,
        missing === 'clear' ? 0 : 1,
        missing
      )
    } finally {
      harness.dispose()
    }
  }
}

async function testEnabledRuntimeComposesProductionMarketService() {
  const {
    createIfindDiagnosticRuntime
  } = require('../ifind-diagnostic-runtime')
  const database = new DatabaseSync(':memory:')
  const providerState = { reads: 0, clearCalls: 0, cleared: false }
  const provider = secretProvider(providerState)
  const clientState = { transportCalls: 0 }
  let loadedConfig
  let repositoryDatabase
  let serviceOptions
  let createdMarketService

  try {
    const runtime = await createIfindDiagnosticRuntime({
      env: enabledEnv(),
      accessRuntime: enabledAccess(),
      openDatabase: () => database,
      loadSecrets: async (config) => {
        loadedConfig = config
        return provider
      },
      createClient: () => noNetworkClient(clientState),
      createMarketRepository(value) {
        repositoryDatabase = value
        return new IfindMarketDiagnosticRepository(value)
      },
      createMarketService(options) {
        serviceOptions = options
        createdMarketService = createIfindMarketDiagnosticService(options)
        return createdMarketService
      }
    })

    assert.deepEqual(loadedConfig, {
      mode: 'admin-diagnostic',
      versionId: VERSION_ID,
      bundlePath: '/run/secrets/kinvest-ifind'
    })
    assert.equal(repositoryDatabase, database)
    assert.equal(serviceOptions.tokenVersionId, VERSION_ID)
    assert.equal(serviceOptions.secretProvider, provider)
    assert.equal(serviceOptions.catalogLookup, getIfindMarketCase)
    assert.equal(serviceOptions.manifestLookup, createLiveRequestManifest)
    assert.equal(serviceOptions.quoteParser, parseIfindMarketQuote)
    assert.equal(serviceOptions.financialParser, parseIfindMarketFinancials)
    assert.equal(runtime.marketService, createdMarketService)
    assert.equal(typeof runtime.marketService.run, 'function')

    const result = await runtime.marketService.run({ caseId: 'HK_ALIBABA_9988' })
    assert.equal(result.status, 'rejected')
    assert.equal(result.failureCode, 'IFIND_MARKET_CASE_UNVERIFIED')
    assert.equal(result.stage, 'catalog')
    assert.equal(providerState.reads, 0)
    assert.equal(clientState.transportCalls, 0)
    assert.equal(database.prepare(
      'SELECT COUNT(*) AS count FROM ifind_market_case_runs'
    ).get().count, 0)

    runtime.clear()
    runtime.clear()
    assert.equal(providerState.clearCalls, 1)
    assert.equal(database.prepare('SELECT 1 AS value').get().value, 1)
  } finally {
    database.close()
  }
}

async function testInvalidCatalogPreventsListenBeforeSecretLoad() {
  const { startServer } = require('../server')
  const database = new DatabaseSync(':memory:')
  const server = new FakeServer()
  let providerLoads = 0
  let databaseCloseCalls = 0
  try {
    await assert.rejects(startServer({
      env: enabledEnv(),
      runtimeServer: server,
      bootstrap: async () => ({
        status: Object.freeze({ mode: 'github-tmpfs-v1', referenceCount: 2 }),
        clear() {}
      }),
      createAccessRuntime: ({ openDatabase, closeDatabase }) => {
        const shared = openDatabase()
        return enabledAccess(() => {
          databaseCloseCalls += 1
          closeDatabase(shared)
        })
      },
      openDatabase: () => database,
      closeDatabase: (value) => value.close(),
      closeApplicationDatabase() {},
      loadIfindSecrets: async () => {
        providerLoads += 1
        return secretProvider({ reads: 0, clearCalls: 0, cleared: false })
      },
      createIfindClient: () => noNetworkClient({ transportCalls: 0 }),
      ifindMarketCatalogLookup: null,
      processRef: new EventEmitter(),
      logger: { log() {} }
    }), (error) => error && error.code === 'IFIND_DIAGNOSTIC_RUNTIME_INVALID')
    assert.equal(server.listenCalls, 0)
    assert.equal(providerLoads, 0)
    assert.equal(databaseCloseCalls, 1)
  } finally {
    if (databaseCloseCalls === 0) database.close()
  }
}

async function testStartupFailureCleanupMatrix() {
  const cases = [
    {
      name: 'missing secret',
      code: 'IFIND_REFRESH_TOKEN_UNAVAILABLE',
      overrides: {
        loadIfindSecrets() {
          throw Object.assign(new Error('missing'), {
            code: 'IFIND_REFRESH_TOKEN_UNAVAILABLE'
          })
        }
      },
      expected: { provider: 0, client: 0 }
    },
    {
      name: 'invalid secret',
      code: 'IFIND_TMPFS_BUNDLE_INVALID',
      overrides: {
        loadIfindSecrets() {
          throw Object.assign(new Error('invalid'), {
            code: 'IFIND_TMPFS_BUNDLE_INVALID'
          })
        }
      },
      expected: { provider: 0, client: 0 }
    },
    {
      name: 'wrong application identity',
      code: 'IFIND_DIAGNOSTIC_DATABASE_INVALID',
      overrides: {
        prepareDatabase(database) {
          database.exec('PRAGMA application_id = 305419896')
        }
      },
      expected: { provider: 1, client: 0 }
    },
    {
      name: 'market repository initialize failure',
      code: 'IFIND_DIAGNOSTIC_DATABASE_INVALID',
      overrides: {
        prepareDatabase(database) {
          database.exec(`
            PRAGMA application_id = ${KINVEST_SQLITE_APPLICATION_ID};
            CREATE TABLE ifind_market_case_runs (broken TEXT)
          `)
        }
      },
      expected: { provider: 1, client: 1 }
    }
  ]

  for (const fixture of cases) {
    const harness = createServerHarness(fixture.overrides)
    try {
      await assert.rejects(harness.start(), hasCode(fixture.code), fixture.name)
      assert.equal(harness.server.listenCalls, 0, fixture.name)
      assert.equal(harness.state.handlerCalls, 0, fixture.name)
      assert.equal(harness.state.runtime, null, fixture.name)
      assert.equal(harness.providerState.clearCalls, fixture.expected.provider, fixture.name)
      assert.equal(harness.state.clientClearCalls, fixture.expected.client, fixture.name)
      assert.equal(harness.state.databaseCloseCalls, 1, fixture.name)
      assert.equal(harness.state.secretClearCalls, 1, fixture.name)
      assert.equal(harness.processRef.listenerCount('SIGTERM'), 0, fixture.name)
      assert.equal(harness.processRef.listenerCount('SIGINT'), 0, fixture.name)
    } finally {
      harness.dispose()
    }
  }
}

async function exerciseShutdown(trigger) {
  const harness = createServerHarness()
  await harness.start()
  assert.equal(typeof harness.state.runtime.marketService.run, 'function', trigger)
  assert.equal(harness.processRef.listenerCount('SIGTERM'), 1, trigger)
  assert.equal(harness.processRef.listenerCount('SIGINT'), 1, trigger)
  assert.equal(harness.server.listenerCount('close'), 1, trigger)

  if (trigger === 'close') harness.server.close()
  else harness.processRef.emit(trigger)

  assert.equal(harness.server.closeCalls, 1, trigger)
  assert.equal(harness.providerState.clearCalls, 1, trigger)
  assert.equal(harness.state.clientClearCalls, 1, trigger)
  assert.equal(harness.state.databaseCloseCalls, 1, trigger)
  assert.equal(harness.state.fallbackCloseCalls, 1, trigger)
  assert.equal(harness.state.secretClearCalls, 1, trigger)
  assert.equal(harness.processRef.listenerCount('SIGTERM'), 0, trigger)
  assert.equal(harness.processRef.listenerCount('SIGINT'), 0, trigger)
  assert.equal(harness.server.listenerCount('close'), 0, trigger)

  harness.server.emit('close')
  harness.processRef.emit('SIGTERM')
  harness.processRef.emit('SIGINT')
  assert.equal(harness.providerState.clearCalls, 1, trigger)
  assert.equal(harness.state.clientClearCalls, 1, trigger)
  assert.equal(harness.state.databaseCloseCalls, 1, trigger)
  assert.equal(harness.state.fallbackCloseCalls, 1, trigger)
}

async function testServerCloseClearsSharedResourcesOnce() {
  await exerciseShutdown('close')
}

async function testSigtermClearsSharedResourcesOnce() {
  await exerciseShutdown('SIGTERM')
}

async function testSigintClearsSharedResourcesOnce() {
  await exerciseShutdown('SIGINT')
}

async function run() {
  const initialUmask = process.umask()
  try {
    await testDisabledModeDoesNotInitializeMarketRuntime()
    await testEnabledModeRejectsIncompleteProductionClient()
    await testEnabledRuntimeComposesProductionMarketService()
    await testInvalidCatalogPreventsListenBeforeSecretLoad()
    await testStartupFailureCleanupMatrix()
    await testServerCloseClearsSharedResourcesOnce()
    await testSigtermClearsSharedResourcesOnce()
    await testSigintClearsSharedResourcesOnce()
  } finally {
    process.umask(initialUmask)
  }
}

module.exports = { run }
