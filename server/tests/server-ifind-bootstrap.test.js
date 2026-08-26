const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const VERSION_ID = 'v20260826-001'

function enabledEnv() {
  return {
    KINVEST_IFIND_DIAGNOSTIC_MODE: 'admin-diagnostic',
    KINVEST_IFIND_SECRET_BUNDLE_PATH: '/run/secrets/kinvest-ifind',
    KINVEST_IFIND_REFRESH_TOKEN_VERSION_ID: VERSION_ID,
    KINVEST_TRUSTED_PROXY_ADDRESSES: '["127.0.0.1"]'
  }
}

function disabledAccess(events = []) {
  return {
    status: Object.freeze({ mode: 'disabled' }),
    adminAuth: null,
    deviceApproval: null,
    clear() { events.push('access') }
  }
}

function enabledAccess(events = []) {
  return {
    status: Object.freeze({ mode: 'device-approval' }),
    adminAuth: {},
    deviceApproval: {},
    clear() { events.push('access') }
  }
}

function providerFixture(events = []) {
  return {
    readRefreshToken() { return Buffer.from('fixture-refresh-token') },
    clear() { events.push('provider') }
  }
}

function repositoryFixture() {
  return {
    initialize() {},
    reserve() {},
    complete() {},
    fail() {},
    latest() { return null },
    status() {}
  }
}

function clientFixture(events = [], transportCalls = { count: 0 }) {
  return {
    async diagnose() {
      transportCalls.count += 1
      throw new Error('transport must not run during startup')
    },
    clear() { events.push('client') }
  }
}

function serviceFactory(events = []) {
  return (options) => Object.freeze({
    status() { return { mode: options.mode } },
    async run() { return { status: 'disabled' } },
    clear() {
      events.push('service')
      options.client.clear()
    }
  })
}

function runtimeDependencies(events = [], overrides = {}) {
  const database = overrides.database || {}
  const transportCalls = overrides.transportCalls || { count: 0 }
  return {
    database,
    transportCalls,
    options: {
      env: enabledEnv(),
      accessRuntime: enabledAccess(events),
      openDatabase() {
        events.push('database-open')
        return database
      },
      loadSecrets: async () => providerFixture(events),
      createRepository: () => repositoryFixture(),
      createClient: () => clientFixture(events, transportCalls),
      createService: serviceFactory(events),
      ...overrides
    }
  }
}

function hasCode(code) {
  return (error) => {
    const record = errorRecord(error)
    return error instanceof Error && record.code === code
  }
}

function errorRecord(error) {
  return error !== null && typeof error === 'object'
    ? /** @type {Record<string, unknown>} */ (error)
    : Object.create(null)
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

async function testDisabledRuntimeTouchesNothing() {
  const {
    createIfindDiagnosticRuntime
  } = require('../ifind-diagnostic-runtime')
  for (const env of [{}, { KINVEST_IFIND_DIAGNOSTIC_MODE: 'disabled' }]) {
    const calls = []
    const runtime = await createIfindDiagnosticRuntime({
      env,
      accessRuntime: disabledAccess(),
      openDatabase() { calls.push('database') },
      loadSecrets() { calls.push('provider') },
      createRepository() { calls.push('repository') },
      createClient() { calls.push('client') },
      createService() { calls.push('service') }
    })
    assert.deepStrictEqual(runtime.status, {
      mode: 'disabled',
      configured: false,
      versionId: null
    })
    assert.equal(Object.isFrozen(runtime), true)
    assert.equal(Object.isFrozen(runtime.status), true)
    runtime.clear()
    runtime.clear()
    assert.deepStrictEqual(calls, [])
  }

  for (const env of [
    { KINVEST_IFIND_DIAGNOSTIC_MODE: 'invalid' },
    { KINVEST_IFIND_DIAGNOSTIC_MODE: 'disabled', KINVEST_IFIND_SECRET_BUNDLE_PATH: '/run/secrets/kinvest-ifind' },
    { KINVEST_IFIND_REFRESH_TOKEN_VERSION_ID: VERSION_ID },
    { ...enabledEnv(), KINVEST_IFIND_SECRET_BUNDLE_PATH: '/tmp/hostile-path' },
    { ...enabledEnv(), KINVEST_IFIND_REFRESH_TOKEN_VERSION_ID: 'latest' }
  ]) {
    await assert.rejects(
      createIfindDiagnosticRuntime({ env, accessRuntime: disabledAccess() }),
      hasCode('IFIND_SECRET_CONFIG_INVALID')
    )
  }
}

async function testEnabledRuntimeRequiresDeviceApprovalAndSharesDatabase() {
  const {
    createIfindDiagnosticRuntime
  } = require('../ifind-diagnostic-runtime')
  let loadCalls = 0
  await assert.rejects(createIfindDiagnosticRuntime({
    env: enabledEnv(),
    accessRuntime: disabledAccess(),
    loadSecrets() { loadCalls += 1 }
  }), hasCode('IFIND_DIAGNOSTIC_ACCESS_REQUIRED'))
  assert.equal(loadCalls, 0)

  const events = []
  const fixture = runtimeDependencies(events)
  let repositoryDatabase
  fixture.options.createRepository = (database) => {
    repositoryDatabase = database
    return repositoryFixture()
  }
  const runtime = await createIfindDiagnosticRuntime(fixture.options)
  assert.equal(repositoryDatabase, fixture.database)
  assert.equal(fixture.transportCalls.count, 0)
  assert.deepStrictEqual(runtime.status, {
    mode: 'admin-diagnostic',
    configured: true,
    versionId: VERSION_ID
  })
  runtime.clear()
  runtime.clear()
  assert.deepStrictEqual(events, [
    'database-open', 'service', 'client', 'provider'
  ])
}

async function testFailureCleanupAndSanitization() {
  const {
    createIfindDiagnosticRuntime
  } = require('../ifind-diagnostic-runtime')
  const sensitive = 'path=/run/secrets/kinvest-ifind token=fixture VersionId=' + VERSION_ID

  const providerEvents = []
  const providerFailure = runtimeDependencies(providerEvents, {
    loadSecrets: async () => {
      throw Object.assign(new Error(sensitive), {
        code: 'IFIND_TMPFS_BUNDLE_INVALID'
      })
    }
  })
  await assert.rejects(
    createIfindDiagnosticRuntime(providerFailure.options),
    (error) => {
      const record = errorRecord(error)
      assert.equal(record.code, 'IFIND_TMPFS_BUNDLE_INVALID')
      assert.equal(`${record.name}:${record.message}`.includes(sensitive), false)
      return true
    }
  )
  assert.deepStrictEqual(providerEvents, [])

  for (const fixture of [
    {
      name: 'repository',
      mutate(options) {
        options.createRepository = () => { throw new Error(sensitive) }
      },
      code: 'IFIND_DIAGNOSTIC_DATABASE_INVALID',
      expected: ['database-open', 'provider']
    },
    {
      name: 'client',
      mutate(options) {
        options.createClient = () => { throw new Error(sensitive) }
      },
      code: 'IFIND_DIAGNOSTIC_RUNTIME_INVALID',
      expected: ['database-open', 'provider']
    },
    {
      name: 'service',
      mutate(options) {
        options.createService = () => { throw new Error(sensitive) }
      },
      code: 'IFIND_DIAGNOSTIC_RUNTIME_INVALID',
      expected: ['database-open', 'client', 'provider']
    },
    {
      name: 'hostile provider',
      mutate(options) {
        options.loadSecrets = async () => new Proxy({}, {})
      },
      code: 'IFIND_DIAGNOSTIC_PROVIDER_INVALID',
      expected: []
    },
    {
      name: 'hostile service',
      mutate(options) {
        options.createService = () => new Proxy({}, {})
      },
      code: 'IFIND_DIAGNOSTIC_RUNTIME_INVALID',
      expected: ['database-open', 'client', 'provider']
    }
  ]) {
    const events = []
    const runtimeFixture = runtimeDependencies(events)
    fixture.mutate(runtimeFixture.options)
    await assert.rejects(
      createIfindDiagnosticRuntime(runtimeFixture.options),
      (error) => {
        const record = errorRecord(error)
        assert.equal(record.code, fixture.code, fixture.name)
        assert.equal(String(record.message).includes(sensitive), false)
        assert.equal(Object.hasOwn(record, 'cause'), false)
        return true
      }
    )
    assert.deepStrictEqual(events, fixture.expected, fixture.name)
  }

  const factoryEvents = []
  const factoryFixture = runtimeDependencies(factoryEvents)
  let hostileFactoryCalls = 0
  factoryFixture.options.createClient = new Proxy(() => clientFixture(), {
    apply() {
      hostileFactoryCalls += 1
      return clientFixture()
    }
  })
  await assert.rejects(
    createIfindDiagnosticRuntime(factoryFixture.options),
    hasCode('IFIND_DIAGNOSTIC_RUNTIME_INVALID')
  )
  assert.equal(hostileFactoryCalls, 0)
  assert.deepStrictEqual(factoryEvents, [])
}

async function testPreparationPassesFrozenRuntimeAndKeepsHealthUnchanged() {
  const { prepareApplication } = require('../pre-listen-preparation')
  const { createRequestHandler } = require('../server')
  const events = []
  const database = {}
  let accessDatabase
  let repositoryDatabase
  let receivedRuntime
  const prepared = await prepareApplication({
    env: enabledEnv(),
    bootstrap: async () => ({
      status: Object.freeze({ mode: 'github-tmpfs-v1', referenceCount: 2 }),
      clear() { events.push('secret') }
    }),
    createAccessRuntime: ({ openDatabase }) => {
      accessDatabase = openDatabase()
      return enabledAccess(events)
    },
    openDatabase: () => database,
    loadIfindSecrets: async () => providerFixture(events),
    createIfindRepository: (value) => {
      repositoryDatabase = value
      return repositoryFixture()
    },
    createIfindClient: () => clientFixture(events),
    createIfindService: serviceFactory(events),
    createHandler(options) {
      receivedRuntime = options.ifindDiagnosticRuntime
      return () => {}
    }
  })
  assert.equal(accessDatabase, database)
  assert.equal(repositoryDatabase, database)
  assert.equal(Object.isFrozen(receivedRuntime), true)
  assert.deepStrictEqual(prepared.ifindDiagnosticStatus, {
    mode: 'admin-diagnostic', configured: true, versionId: VERSION_ID
  })
  prepared.clear()
  prepared.clear()
  assert.deepStrictEqual(events, ['service', 'client', 'provider', 'access', 'secret'])

  const accessRuntime = disabledAccess()
  const baseline = createRequestHandler({ accessRuntime })
  const withDiagnostic = createRequestHandler({
    accessRuntime,
    ifindDiagnosticRuntime: Object.freeze({
      status: Object.freeze({ mode: 'disabled', configured: false, versionId: null }),
      service: null,
      clear() {}
    })
  })
  async function healthBody(handler) {
    let status
    let headers
    let body
    await handler(
      { method: 'GET', url: '/api/health', headers: {} },
      {
        headersSent: false,
        writeHead(nextStatus, nextHeaders) {
          status = nextStatus
          headers = nextHeaders
          this.headersSent = true
        },
        end(value) { body = String(value) },
        destroy() { throw new Error('health response destroyed') }
      }
    )
    return { status, headers, body }
  }
  const OriginalDate = global.Date
  const fixedNow = OriginalDate.parse('2026-08-26T00:00:00.000Z')
  global.Date = /** @type {DateConstructor} */ (class FixedDate extends OriginalDate {
    constructor(...args) {
      super(args.length === 0 ? fixedNow : args[0])
    }
    static now() { return fixedNow }
  })
  try {
    assert.deepStrictEqual(await healthBody(withDiagnostic), await healthBody(baseline))
  } finally {
    global.Date = OriginalDate
  }
}

async function testStartupFailuresPreventListenAndCleanEveryPhase() {
  const { startServer } = require('../server')
  const cases = [
    {
      name: 'provider',
      override: {
        loadIfindSecrets: async () => {
          throw Object.assign(new Error('sensitive-provider-failure'), {
            code: 'IFIND_TMPFS_BUNDLE_INVALID'
          })
        }
      },
      expected: ['access', 'secret']
    },
    {
      name: 'repository',
      override: { createIfindRepository: () => { throw new Error('sensitive-db') } },
      expected: ['provider', 'access', 'secret']
    },
    {
      name: 'client',
      override: { createIfindClient: () => { throw new Error('sensitive-client') } },
      expected: ['provider', 'access', 'secret']
    },
    {
      name: 'service',
      override: { createIfindService: () => { throw new Error('sensitive-service') } },
      expected: ['client', 'provider', 'access', 'secret']
    },
    {
      name: 'handler',
      override: { createHttpHandler: () => { throw new Error('sensitive-handler') } },
      expected: ['service', 'client', 'provider', 'access', 'secret']
    }
  ]
  for (const fixture of cases) {
    const events = []
    const server = new FakeServer()
    await assert.rejects(startServer({
      env: enabledEnv(),
      runtimeServer: server,
      bootstrap: async () => ({
        status: Object.freeze({ mode: 'github-tmpfs-v1', referenceCount: 2 }),
        clear() { events.push('secret') }
      }),
      createAccessRuntime: () => enabledAccess(events),
      openDatabase: () => ({}),
      loadIfindSecrets: async () => providerFixture(events),
      createIfindRepository: () => repositoryFixture(),
      createIfindClient: () => clientFixture(events),
      createIfindService: serviceFactory(events),
      createHttpHandler: () => () => {},
      processRef: new EventEmitter(),
      logger: { log() {} },
      ...fixture.override
    }), fixture.name)
    assert.equal(server.listenCalls, 0, fixture.name)
    assert.deepStrictEqual(events, fixture.expected, fixture.name)
  }
}

async function testShutdownCleanupOrder() {
  const { startServer } = require('../server')
  for (const shutdown of ['SIGTERM', 'SIGINT', 'close']) {
    const events = []
    const processRef = new EventEmitter()
    const server = new FakeServer()
    const transportCalls = { count: 0 }
    await startServer({
      env: enabledEnv(),
      runtimeServer: server,
      bootstrap: async () => ({
        status: Object.freeze({ mode: 'github-tmpfs-v1', referenceCount: 2 }),
        clear() { events.push('secret') }
      }),
      createAccessRuntime: () => enabledAccess(events),
      openDatabase: () => ({}),
      loadIfindSecrets: async () => providerFixture(events),
      createIfindRepository: () => repositoryFixture(),
      createIfindClient: () => clientFixture(events, transportCalls),
      createIfindService: serviceFactory(events),
      createHttpHandler: () => () => {},
      closeApplicationDatabase: () => events.push('database'),
      processRef,
      logger: { log() {} }
    })
    if (shutdown === 'close') server.close()
    else processRef.emit(shutdown)
    server.emit('close')
    processRef.emit('SIGTERM')
    processRef.emit('SIGINT')
    assert.equal(transportCalls.count, 0)
    assert.deepStrictEqual(events, [
      'service', 'client', 'provider', 'access', 'secret', 'database'
    ], shutdown)
  }
}

async function run() {
  const initialUmask = process.umask()
  try {
    await testDisabledRuntimeTouchesNothing()
    await testEnabledRuntimeRequiresDeviceApprovalAndSharesDatabase()
    await testFailureCleanupAndSanitization()
    await testPreparationPassesFrozenRuntimeAndKeepsHealthUnchanged()
    await testStartupFailuresPreventListenAndCleanEveryPhase()
    await testShutdownCleanupOrder()
  } finally {
    process.umask(initialUmask)
  }
  assert.equal(process.umask(), initialUmask)
}

module.exports = { run }
