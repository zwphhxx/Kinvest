'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { DatabaseSync } = require('node:sqlite')

const { createIfindHttpClient } = require('../adapters/ifind-http-client')
const {
  IfindMarketDiagnosticRepository
} = require('../db/ifind-market-diagnostic-repository')
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

class FakeServer extends EventEmitter {
  constructor() {
    super()
    this.listenCalls = 0
  }

  listen(_port, callback) {
    this.listenCalls += 1
    callback()
    return this
  }

  close(callback) {
    this.emit('close')
    if (callback) callback()
  }
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

async function testServerCloseClearsSharedResourcesOnce() {
  const { startServer } = require('../server')
  const database = new DatabaseSync(':memory:')
  const server = new FakeServer()
  const processRef = new EventEmitter()
  const providerState = { reads: 0, clearCalls: 0, cleared: false }
  let databaseCloseCalls = 0
  let fallbackCloseCalls = 0

  await startServer({
    env: enabledEnv(),
    runtimeServer: server,
    bootstrap: async () => ({
      status: Object.freeze({ mode: 'github-tmpfs-v1', referenceCount: 2 }),
      clear() {}
    }),
    createAccessRuntime: ({ openDatabase, closeDatabase }) => {
      const shared = openDatabase()
      let cleared = false
      return enabledAccess(() => {
        if (cleared) return
        cleared = true
        databaseCloseCalls += 1
        closeDatabase(shared)
      })
    },
    openDatabase: () => database,
    closeDatabase: (value) => value.close(),
    closeApplicationDatabase: () => { fallbackCloseCalls += 1 },
    loadIfindSecrets: async () => secretProvider(providerState),
    createIfindClient: () => noNetworkClient({ transportCalls: 0 }),
    processRef,
    logger: { log() {} }
  })

  server.close()
  server.emit('close')
  processRef.emit('SIGTERM')
  processRef.emit('SIGINT')
  assert.equal(providerState.clearCalls, 1)
  assert.equal(databaseCloseCalls, 1)
  assert.equal(fallbackCloseCalls, 1)
}

async function run() {
  const initialUmask = process.umask()
  try {
    await testDisabledModeDoesNotInitializeMarketRuntime()
    await testEnabledRuntimeComposesProductionMarketService()
    await testInvalidCatalogPreventsListenBeforeSecretLoad()
    await testServerCloseClearsSharedResourcesOnce()
  } finally {
    process.umask(initialUmask)
  }
}

module.exports = { run }
