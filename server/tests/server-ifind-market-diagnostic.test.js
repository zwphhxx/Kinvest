'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
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
  createLiveRequestManifestBundle,
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
function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ifind', name), 'utf8'))
}
const accessTokenSuccess = readFixture('access-token-success.json')
const tradeDatesSuccess = readFixture('trade-dates-success.json')

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

function withoutProbeFixed(client) {
  const result = { ...client }
  delete result.probeFixed
  return result
}

function controlledRequestStub(responseBodies) {
  const pendingBodies = [...responseBodies]
  const pendingResponses = []
  const waiters = []

  function wakeWaiters() {
    while (waiters.length > 0) waiters.shift()()
  }

  function request(_url, _options, callback) {
    const outgoing = Object.assign(new EventEmitter(), {
      write() {},
      destroy() {},
      end() {
        const body = pendingBodies.shift()
        pendingResponses.push(() => {
          const incoming = Object.assign(new EventEmitter(), {
            statusCode: 200,
            destroy() {}
          })
          callback(incoming)
          incoming.emit('data', Buffer.from(JSON.stringify(body)))
          incoming.emit('end')
        })
        wakeWaiters()
      }
    })
    return outgoing
  }

  async function waitForCall(count) {
    while (pendingResponses.length < count) {
      await new Promise((resolve) => waiters.push(resolve))
    }
  }

  function release(index) {
    const respond = pendingResponses[index]
    assert.equal(typeof respond, 'function')
    respond()
  }

  return { release, request, waitForCall }
}

function instrumentedProductionClient(state) {
  const client = noNetworkClient(state)
  const clientIndex = state.clientClearCounts.length
  state.clientClearCounts.push(0)
  return {
    diagnose: client.diagnose,
    authenticate: client.authenticate,
    quote: client.quote,
    financial: client.financial,
    clear() {
      state.clientClearCalls += 1
      state.clientClearCounts[clientIndex] += 1
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
    clientClearCounts: [],
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

function createProbeRuntimeHarness(overrides = {}) {
  const {
    createIfindDiagnosticRuntime
  } = require('../ifind-diagnostic-runtime')
  const database = new DatabaseSync(':memory:')
  const providerState = { reads: 0, clearCalls: 0, cleared: false }
  const provider = secretProvider(providerState)
  const clearCounts = {
    legacy: 0,
    market: 0,
    reportPeriod: 0,
    probe: 0
  }
  const makeClient = (name, methods) => {
    const client = {}
    for (const method of methods) client[method] = async () => ({})
    client.clear = () => { clearCounts[name] += 1 }
    return client
  }
  const legacyClient = makeClient('legacy', ['diagnose'])
  const marketMethods = ['authenticate', 'quote', 'financial', 'diagnoseReportPeriod']
  if (overrides.marketHasProbeFixed !== false) marketMethods.push('probeFixed')
  const marketClient = makeClient('market', marketMethods)
  const reportPeriodClient = makeClient(
    'reportPeriod',
    ['authenticate', 'diagnoseReportPeriod']
  )
  const defaultProbeClient = makeClient('probe', ['authenticate', 'probeFixed'])
  const clients = [legacyClient, marketClient, reportPeriodClient]
  let clientIndex = 0
  let probeClient
  let marketRepository
  let factoryInput
  let factoryCalls = 0
  let serviceClearCalls = 0
  const clock = () => 1_788_364_800_000
  const idGenerator = () => 'market_probe_test'
  const probeService = overrides.probeService || {
    describe() { return { status: 'ready' } },
    async run() { return { status: 'completed' } },
    clear() {
      serviceClearCalls += 1
      if (overrides.serviceClearThrows) throw new Error('probe clear failed')
    }
  }

  const options = {
    env: enabledEnv(),
    accessRuntime: enabledAccess(),
    openDatabase: () => database,
    loadSecrets: async () => provider,
    createClient() {
      if (clientIndex === 3) {
        probeClient = overrides.createProbeClient
          ? overrides.createProbeClient({
              defaultProbeClient,
              legacyClient,
              marketClient,
              reportPeriodClient
            })
          : defaultProbeClient
        clients.push(probeClient)
      }
      const client = clients[clientIndex]
      clientIndex += 1
      if (!client) throw new Error('client sequence underflow')
      return client
    },
    createService({ client }) {
      return {
        status() { return {} },
        async run() { return {} },
        clear() { client.clear() }
      }
    },
    createMarketRepository(value) {
      marketRepository = new IfindMarketDiagnosticRepository(value)
      return marketRepository
    },
    createMarketService() {
      return {
        async run() { return {} },
        latest() { return null },
        history() { return [] },
        quotaStatus() { return {} }
      }
    },
    createMarketProbeService(input) {
      factoryCalls += 1
      factoryInput = input
      if (overrides.factoryThrows) throw new Error('probe factory failed')
      return probeService
    },
    clock,
    marketIdGenerator: idGenerator
  }

  return {
    clearCounts,
    clock,
    database,
    defaultProbeClient,
    idGenerator,
    legacyClient,
    marketClient,
    options,
    provider,
    providerState,
    reportPeriodClient,
    start: () => createIfindDiagnosticRuntime(options),
    state: {
      get factoryCalls() { return factoryCalls },
      get factoryInput() { return factoryInput },
      get marketRepository() { return marketRepository },
      get probeClient() { return probeClient },
      get serviceClearCalls() { return serviceClearCalls }
    }
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
    createMarketService() { calls.push('market-service') },
    createMarketProbeService() { calls.push('market-probe-service') }
  })

  assert.equal(runtime.marketService, null)
  assert.equal(runtime.marketProbeService, null)
  assert.deepEqual(calls, [])
}

async function testReadMethodRejectsProxyCallableWithoutExecutingTraps() {
  const harness = createProbeRuntimeHarness()
  let traps = 0
  harness.legacyClient.diagnose = new Proxy(function () {}, {
    get() {
      traps += 1
      throw new Error('callable property trap must not run')
    },
    apply() {
      traps += 1
      throw new Error('callable apply trap must not run')
    }
  })
  try {
    await assert.rejects(
      harness.start(),
      hasCode('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
    )
    assert.equal(traps, 0)
  } finally {
    harness.database.close()
  }
}

async function testReadMethodUsesTrustedBindForInheritedMethod() {
  const harness = createProbeRuntimeHarness({ marketHasProbeFixed: false })
  let bindReads = 0
  function inheritedDiagnose() { return this }
  Object.defineProperty(inheritedDiagnose, 'bind', {
    get() {
      bindReads += 1
      throw new Error('candidate bind accessor must not run')
    }
  })
  delete harness.legacyClient.diagnose
  Object.setPrototypeOf(harness.legacyClient, { diagnose: inheritedDiagnose })
  try {
    const runtime = await harness.start()
    assert.equal(bindReads, 0)
    runtime.clear()
  } finally {
    harness.database.close()
  }
}

async function testEnabledRuntimeComposesDedicatedMarketProbeService() {
  const harness = createProbeRuntimeHarness()
  try {
    const runtime = await harness.start()

    assert.equal(harness.state.factoryCalls, 1)
    assert.equal(new Set([
      harness.legacyClient,
      harness.marketClient,
      harness.reportPeriodClient,
      harness.state.probeClient
    ]).size, 4)
    assert.equal(harness.state.probeClient, harness.defaultProbeClient)
    assert.deepEqual(Object.keys(harness.state.factoryInput).sort(), [
      'client',
      'clock',
      'idGenerator',
      'repository',
      'secretProvider',
      'tokenVersionId'
    ])
    assert.equal(harness.state.factoryInput.repository, harness.state.marketRepository)
    assert.equal(harness.state.factoryInput.client, harness.defaultProbeClient)
    assert.equal(harness.state.factoryInput.secretProvider, harness.provider)
    assert.equal(harness.state.factoryInput.tokenVersionId, VERSION_ID)
    assert.equal(harness.state.factoryInput.clock, harness.clock)
    assert.equal(harness.state.factoryInput.idGenerator, harness.idGenerator)
    assert.equal(runtime.marketProbeService.describe().status, 'ready')
    assert.equal(typeof runtime.marketProbeService.run, 'function')
    assert.equal(typeof runtime.marketProbeService.clear, 'function')

    runtime.clear()
    assert.equal(harness.state.serviceClearCalls, 1)
    assert.deepEqual(harness.clearCounts, {
      legacy: 1,
      market: 1,
      reportPeriod: 1,
      probe: 0
    })
    runtime.clear()
    assert.equal(harness.state.serviceClearCalls, 1)
    assert.equal(harness.clearCounts.probe, 0)
  } finally {
    harness.database.close()
  }
}

async function testMarketProbeCleanupFallsBackToDedicatedClientOnce() {
  const harness = createProbeRuntimeHarness({ serviceClearThrows: true })
  try {
    const runtime = await harness.start()
    runtime.clear()
    runtime.clear()

    assert.equal(harness.state.serviceClearCalls, 1)
    assert.equal(harness.clearCounts.probe, 1)
    assert.equal(harness.clearCounts.legacy, 1)
    assert.equal(harness.clearCounts.market, 1)
    assert.equal(harness.clearCounts.reportPeriod, 1)
  } finally {
    harness.database.close()
  }
}

async function testOlderMarketClientDoesNotCreateProbeRuntime() {
  const harness = createProbeRuntimeHarness({ marketHasProbeFixed: false })
  try {
    const runtime = await harness.start()

    assert.equal(runtime.marketProbeService, null)
    assert.equal(harness.state.factoryCalls, 0)
    assert.equal(harness.state.probeClient, undefined)
    runtime.clear()
    assert.deepEqual(harness.clearCounts, {
      legacy: 1,
      market: 1,
      reportPeriod: 1,
      probe: 0
    })
  } finally {
    harness.database.close()
  }
}

async function testMarketProbeClientMustBeDistinctAndComplete() {
  for (const [name, createProbeClient, expectedProbeClears] of [
    ['legacy reuse', ({ legacyClient }) => legacyClient, 0],
    ['market reuse', ({ marketClient }) => marketClient, 0],
    ['report-period reuse', ({ reportPeriodClient }) => reportPeriodClient, 0],
    ['missing authenticate', ({ defaultProbeClient }) => ({
      probeFixed: defaultProbeClient.probeFixed,
      clear: defaultProbeClient.clear
    }), 1],
    ['missing probeFixed', ({ defaultProbeClient }) => ({
      authenticate: defaultProbeClient.authenticate,
      clear: defaultProbeClient.clear
    }), 1],
    ['missing clear', ({ defaultProbeClient }) => ({
      authenticate: defaultProbeClient.authenticate,
      probeFixed: defaultProbeClient.probeFixed
    }), 0]
  ]) {
    const harness = createProbeRuntimeHarness({ createProbeClient })
    try {
      await assert.rejects(
        harness.start(),
        hasCode('IFIND_DIAGNOSTIC_RUNTIME_INVALID'),
        name
      )
      assert.equal(harness.state.factoryCalls, 0, name)
      assert.equal(harness.clearCounts.legacy, 1, name)
      assert.equal(harness.clearCounts.market, 1, name)
      assert.equal(harness.clearCounts.reportPeriod, 1, name)
      assert.equal(harness.clearCounts.probe, expectedProbeClears, name)
    } finally {
      harness.database.close()
    }
  }
}

async function testMarketProbeServiceMustExposeRequiredMethods() {
  for (const missing of ['describe', 'run', 'clear']) {
    let serviceClearCalls = 0
    const service = {
      describe() {},
      async run() {},
      clear() { serviceClearCalls += 1 }
    }
    delete service[missing]
    const harness = createProbeRuntimeHarness({ probeService: service })
    try {
      await assert.rejects(
        harness.start(),
        hasCode('IFIND_DIAGNOSTIC_RUNTIME_INVALID'),
        missing
      )
      assert.equal(harness.state.factoryCalls, 1, missing)
      assert.equal(serviceClearCalls, missing === 'clear' ? 0 : 1, missing)
      assert.equal(harness.clearCounts.probe, missing === 'clear' ? 1 : 0, missing)
      assert.equal(harness.clearCounts.legacy, 1, missing)
      assert.equal(harness.clearCounts.market, 1, missing)
      assert.equal(harness.clearCounts.reportPeriod, 1, missing)
    } finally {
      harness.database.close()
    }
  }
}

async function testMarketProbeFactoryFailuresCleanOwnedResourcesOnce() {
  const throwing = createProbeRuntimeHarness({ factoryThrows: true })
  try {
    await assert.rejects(
      throwing.start(),
      hasCode('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
    )
    assert.equal(throwing.state.factoryCalls, 1)
    assert.deepEqual(throwing.clearCounts, {
      legacy: 1,
      market: 1,
      reportPeriod: 1,
      probe: 1
    })
  } finally {
    throwing.database.close()
  }

  const invalid = createProbeRuntimeHarness()
  invalid.options.createMarketProbeService = null
  try {
    await assert.rejects(
      invalid.start(),
      hasCode('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
    )
    assert.equal(invalid.state.factoryCalls, 0)
    assert.equal(invalid.providerState.clearCalls, 0)
    assert.deepEqual(invalid.clearCounts, {
      legacy: 0,
      market: 0,
      reportPeriod: 0,
      probe: 0
    })
  } finally {
    invalid.database.close()
  }
}

async function testEnabledModeRejectsIncompleteProductionClient() {
  for (const missing of [
    'diagnose', 'authenticate', 'quote', 'financial', 'clear', 'all-market'
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
        missing === 'clear' ? 0
          : missing === 'diagnose' ? 1
            : 2,
        missing
      )
    } finally {
      harness.dispose()
    }
  }
}

async function testClientFactoryFailuresCleanDistinctInstances() {
  const secondFailure = createServerHarness({
    createIfindClient(state) {
      if (state.clientCreates === 2) throw new Error('second client failed')
      return instrumentedProductionClient(state)
    }
  })
  try {
    await assert.rejects(
      secondFailure.start(),
      hasCode('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
    )
    assert.equal(secondFailure.server.listenCalls, 0)
    assert.equal(secondFailure.state.clientCreates, 2)
    assert.equal(secondFailure.state.clientClearCalls, 1)
    assert.equal(secondFailure.providerState.clearCalls, 1)
    assert.equal(secondFailure.state.databaseCloseCalls, 1)
  } finally {
    secondFailure.dispose()
  }

  let sharedClient
  const reusedInstance = createServerHarness({
    createIfindClient(state) {
      if (!sharedClient) sharedClient = instrumentedProductionClient(state)
      return sharedClient
    }
  })
  try {
    await assert.rejects(
      reusedInstance.start(),
      hasCode('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
    )
    assert.equal(reusedInstance.server.listenCalls, 0)
    assert.equal(reusedInstance.state.clientCreates, 2)
    assert.equal(reusedInstance.state.clientClearCalls, 1)
    assert.equal(reusedInstance.providerState.clearCalls, 1)
    assert.equal(reusedInstance.state.databaseCloseCalls, 1)
  } finally {
    reusedInstance.dispose()
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
  /** @type {{
   * tokenVersionId: string,
   * secretProvider: ReturnType<typeof secretProvider>,
   * client: ReturnType<typeof noNetworkClient>,
   * catalogLookup: typeof getIfindMarketCase,
   * manifestLookup: typeof createLiveRequestManifestBundle,
   * quoteParser: typeof parseIfindMarketQuote,
   * financialParser: typeof parseIfindMarketFinancials
   * } | undefined} */
  let serviceOptions
  /** @type {ReturnType<typeof createIfindMarketDiagnosticService> | undefined} */
  let createdMarketService
  const clients = []
  const clientClearCounts = []

  try {
    const runtime = await createIfindDiagnosticRuntime({
      env: enabledEnv(),
      accessRuntime: enabledAccess(),
      openDatabase: () => database,
      loadSecrets: async (config) => {
        loadedConfig = config
        return provider
      },
      createClient() {
        const productionClient = noNetworkClient(clientState)
        const clientIndex = clients.length
        clientClearCounts.push(0)
        const client = {
          ...withoutProbeFixed(productionClient),
          clear() {
            clientClearCounts[clientIndex] += 1
            productionClient.clear()
          }
        }
        clients.push(client)
        return client
      },
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
    assert.equal(clients.length, 3)
    assert.equal(new Set(clients).size, 3)
    assert.deepEqual(clientClearCounts, [0, 0, 0])
    assert.notEqual(clients[0], clients[1])
    assert.ok(runtime.reportPeriodService)
    assert.equal(typeof runtime.reportPeriodService.describe, 'function')
    assert.equal(typeof runtime.reportPeriodService.run, 'function')
    assert.equal(typeof runtime.reportPeriodService.clear, 'function')
    assert.equal(runtime.reportPeriodService.describe().status, 'ready')
    assert.ok(serviceOptions)
    assert.equal(serviceOptions.tokenVersionId, VERSION_ID)
    assert.equal(serviceOptions.secretProvider, provider)
    assert.equal(serviceOptions.client, clients[1])
    assert.equal(serviceOptions.catalogLookup, getIfindMarketCase)
    assert.equal(serviceOptions.manifestLookup, createLiveRequestManifestBundle)
    assert.equal(serviceOptions.quoteParser, parseIfindMarketQuote)
    assert.equal(serviceOptions.financialParser, parseIfindMarketFinancials)
    assert.ok(createdMarketService)
    assert.equal(runtime.marketService, createdMarketService)
    assert.ok(runtime.marketService)
    assert.equal(typeof runtime.marketService.run, 'function')
    assert.equal(typeof runtime.marketService.latest, 'function')
    assert.equal(typeof runtime.marketService.history, 'function')
    assert.equal(typeof runtime.marketService.quotaStatus, 'function')
    assert.equal(runtime.marketService.latest({
      caseId: 'HK_ALIBABA_9988'
    }), null)
    assert.deepEqual(runtime.marketService.history({
      caseId: 'HK_ALIBABA_9988',
      limit: 10
    }), [])
    assert.deepEqual(runtime.marketService.quotaStatus({
      caseId: 'HK_ALIBABA_9988',
      now: 1_787_937_600_000
    }), {
      localDayKey: '2026-08-29',
      caseAttemptCount: 0,
      caseRemaining: 5,
      globalAttemptCount: 0,
      globalRemaining: 12,
      cooldownUntil: null,
      inFlight: false,
      inFlightCaseId: null,
      inFlightExpiresAt: null
    })

    const result = await runtime.marketService.run({ caseId: 'HK_ALIBABA_9988' })
    assert.equal(result.status, 'rejected')
    assert.equal(result.failureCode, 'IFIND_MARKET_CASE_UNVERIFIED')
    assert.equal(result.stage, 'catalog')
    assert.equal(providerState.reads, 0)
    assert.equal(clientState.transportCalls, 0)
    assert.equal(database.prepare(
      'SELECT COUNT(*) AS count FROM ifind_market_case_runs'
    ).get().count, 0)

    const beforeClear = clientClearCounts.slice()
    runtime.clear()
    const afterClear = beforeClear.map((count) => count + 1)
    assert.deepEqual(clientClearCounts, afterClear, 'all three distinct clients receive shutdown cleanup')
    runtime.clear()
    assert.deepEqual(clientClearCounts, afterClear, 'runtime shutdown cleanup is idempotent')
    assert.equal(providerState.clearCalls, 1)
    assert.equal(database.prepare('SELECT 1 AS value').get().value, 1)
  } finally {
    database.close()
  }
}

async function testLegacyAndMarketClientLifecyclesDoNotInterfere() {
  const {
    createIfindDiagnosticRuntime
  } = require('../ifind-diagnostic-runtime')
  const database = new DatabaseSync(':memory:')
  const providerState = { reads: 0, clearCalls: 0, cleared: false }
  const legacyTransport = controlledRequestStub([
    accessTokenSuccess,
    tradeDatesSuccess,
    accessTokenSuccess,
    tradeDatesSuccess
  ])
  const marketTransport = controlledRequestStub([accessTokenSuccess, accessTokenSuccess])
  const reportPeriodTransport = controlledRequestStub([accessTokenSuccess])
  const probeTransport = controlledRequestStub([])
  const transports = [
    legacyTransport,
    marketTransport,
    reportPeriodTransport,
    probeTransport
  ]
  const clients = []

  try {
    const runtime = await createIfindDiagnosticRuntime({
      env: enabledEnv(),
      accessRuntime: enabledAccess(),
      openDatabase: () => database,
      loadSecrets: async () => secretProvider(providerState),
      createClient() {
        const transport = transports[clients.length]
        const client = createIfindHttpClient({ request: transport.request })
        clients.push(client)
        return client
      }
    })
    assert.equal(clients.length, 4)
    assert.equal(new Set(clients).size, 4)
    const [legacyClient, marketClient, reportPeriodClient, probeClient] = clients
    assert.notEqual(probeClient, legacyClient)
    assert.notEqual(probeClient, marketClient)
    assert.notEqual(probeClient, reportPeriodClient)

    const activeLegacy = legacyClient.diagnose({
      refreshToken: Buffer.from('fixture-refresh-token')
    })
    await legacyTransport.waitForCall(1)
    const marketResult = await runtime.marketService.run({
      caseId: 'HK_ALIBABA_9988'
    })
    assert.equal(marketResult.failureCode, 'IFIND_MARKET_CASE_UNVERIFIED')
    legacyTransport.release(0)
    await legacyTransport.waitForCall(2)
    legacyTransport.release(1)
    assert.equal((await activeLegacy).route, '/api/v1/get_trade_dates')

    const subsequentLegacy = legacyClient.diagnose({
      refreshToken: Buffer.from('fixture-refresh-token')
    })
    await legacyTransport.waitForCall(3)
    legacyTransport.release(2)
    await legacyTransport.waitForCall(4)
    legacyTransport.release(3)
    assert.equal((await subsequentLegacy).route, '/api/v1/get_trade_dates')

    const activeMarket = marketClient.authenticate(
      Buffer.from('fixture-refresh-token')
    )
    await marketTransport.waitForCall(1)
    legacyClient.clear()
    marketTransport.release(0)
    const authResult = await activeMarket
    assert.equal(Buffer.isBuffer(authResult.accessToken), true)
    assert.equal(authResult.requestCount, 1)
    assert.equal(authResult.accessToken.toString('utf8'), accessTokenSuccess.data.access_token)

    const activeReportPeriod = reportPeriodClient.authenticate(Buffer.from('fixture-refresh-token'))
    await reportPeriodTransport.waitForCall(1)
    marketClient.clear()
    assert.equal(authResult.accessToken.every((byte) => byte === 0), true)
    reportPeriodTransport.release(0)
    const reportPeriodAuth = await activeReportPeriod
    assert.equal(reportPeriodAuth.requestCount, 1)
    assert.equal(reportPeriodAuth.accessToken.toString('utf8'), accessTokenSuccess.data.access_token)

    const subsequentMarket = marketClient.authenticate(Buffer.from('fixture-refresh-token'))
    await marketTransport.waitForCall(2)
    reportPeriodClient.clear()
    assert.equal(reportPeriodAuth.accessToken.every((byte) => byte === 0), true)
    marketTransport.release(1)
    const subsequentMarketAuth = await subsequentMarket
    assert.equal(subsequentMarketAuth.requestCount, 1)
    assert.equal(subsequentMarketAuth.accessToken.toString('utf8'), accessTokenSuccess.data.access_token)

    runtime.clear()
    assert.equal(subsequentMarketAuth.accessToken.every((byte) => byte === 0), true)
    runtime.clear()
    assert.equal(providerState.clearCalls, 1)
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
    }), (error) => error instanceof Error && 'code' in error &&
      error.code === 'IFIND_DIAGNOSTIC_RUNTIME_INVALID')
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
      expected: { provider: 1, client: 2 }
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
  assert.equal(harness.state.clientClearCalls, 2, trigger)
  assert.deepEqual(harness.state.clientClearCounts, [1, 1], trigger)
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
  assert.equal(harness.state.clientClearCalls, 2, trigger)
  assert.deepEqual(harness.state.clientClearCounts, [1, 1], trigger)
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
    await testReadMethodRejectsProxyCallableWithoutExecutingTraps()
    await testReadMethodUsesTrustedBindForInheritedMethod()
    await testEnabledRuntimeComposesDedicatedMarketProbeService()
    await testMarketProbeCleanupFallsBackToDedicatedClientOnce()
    await testOlderMarketClientDoesNotCreateProbeRuntime()
    await testMarketProbeClientMustBeDistinctAndComplete()
    await testMarketProbeServiceMustExposeRequiredMethods()
    await testMarketProbeFactoryFailuresCleanOwnedResourcesOnce()
    await testEnabledModeRejectsIncompleteProductionClient()
    await testClientFactoryFailuresCleanDistinctInstances()
    await testEnabledRuntimeComposesProductionMarketService()
    await testLegacyAndMarketClientLifecyclesDoNotInterfere()
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
