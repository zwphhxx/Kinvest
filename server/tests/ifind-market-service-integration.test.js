'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { EventEmitter } = require('node:events')
const { DatabaseSync } = require('node:sqlite')
const { createIfindHttpClient } = require('../adapters/ifind-http-client')
const { createIfindDiagnosticRuntime } = require('../ifind-diagnostic-runtime')
const { createIfindMarketDiagnosticService } = require('../services/ifind-market-diagnostic-service')
const { parseIfindMarketQuote } = require('../domain/ifind-market-quote-parser')
const { parseIfindMarketFinancials } = require('../domain/ifind-market-financial-parser')
const { createRequestHandler } = require('../server')
const { getIfindMarketCase, createLiveRequestManifestBundle } = require('../domain/ifind-market-cases')
const {
  createVerifiedMarketEvidenceBundle
} = require('../domain/ifind-market-manifest-validator')
const {
  fixtureCatalog, fixtureEvidence, REMOTE_FINANCIAL_METADATA_FIELDS
} = require('./helpers/ifind-market-evidence')

const CASE_IDS = ['HK_ALIBABA_9988', 'US_APPLE_AAPL', 'CN_MOUTAI_600519']
const NOW = Date.parse('2026-08-29T04:00:00.000Z')
const VERSION_ID = 'v20260829-001'
const PERIODS = {
  HK: [['FY2025', '2025-03-31'], ['FY2024', '2024-03-31'], ['H1-FY2026', '2025-09-30']],
  US: [['FY2024', '2024-09-28'], ['FY2023', '2023-09-30'], ['Q3-FY2025', '2025-06-28']],
  CN: [['2024A', '2024-12-31'], ['2023A', '2023-12-31'], ['2025H1', '2025-06-30']]
}

function fixtureResponses(catalog, halted = false) {
  const market = catalog.caseId.slice(0, 2)
  const quoteValues = {
    latestPrice: 101.25, previousClose: 100, open: 100.5, high: 102, low: 99.75,
    volume: 1234, turnover: 123456.75, currency: catalog.expectedTradingCurrency,
    quoteTime: { HK: '2026-08-29 15:59:00', US: '08/29/2026 15:59:00 EDT', CN: '20260829145900' }[market],
    tradingStatus: (halted
      ? { HK: 'SUSPENDED', US: 'HALTED', CN: 'SUSPEND' }
      : { HK: 'TRADING', US: 'REGULAR', CN: 'TRADE' })[market]
  }
  const quoteTable = Object.fromEntries(catalog.indicators.quote.map((entry) => [
    entry.vendorIndicatorId, [quoteValues[entry.metric]]
  ]))
  const financialTable = Object.fromEntries(catalog.indicators.financial.map((entry, index) => [
    entry.vendorIndicatorId, [index + 1, index + 2, entry.metric === 'grossProfit' ? null : index + 3]
  ]))
  const periods = PERIODS[market]
  const metadata = {
    currency: periods.map(() => fixtureEvidence(catalog.caseId).financialReportingCurrencyEvidence.currency),
    unit: periods.map(() => 'million'),
    reportPeriod: periods.map((entry) => entry[0]),
    reportDate: periods.map((entry) => entry[1]),
    periodType: ['annual', 'annual', 'interim'],
    disclosureScope: periods.map(() => market === 'US' ? 'issuer_consolidated' : 'consolidated'),
    sourceTime: periods.map(() => '2025-11-20T08:00:00.000Z')
  }
  for (const field of REMOTE_FINANCIAL_METADATA_FIELDS) {
    const entry = catalog.indicators.financialMetadata[field]
    financialTable[entry.vendorIndicatorId] = metadata[field]
  }
  const payload = (table) => ({
    errorcode: 0, tables: [{ thscode: catalog.vendorCodes.ifind.code, table }],
    dataVol: Object.values(table).reduce((count, values) => count + values.length, 0)
  })
  return [
    { errorcode: 0, data: { access_token: 'synthetic-integration-access' } },
    payload(quoteTable), payload(financialTable)
  ]
}

function transportFixture(responses, holdAt = 0) {
  let callCount = 0
  let releaseHeld = () => {}
  let notifyHeld = () => {}
  const held = new Promise((resolve) => { notifyHeld = () => resolve(undefined) })
  const paths = []
  const requests = []
  return {
    held, paths, requests,
    get calls() { return callCount },
    release() { releaseHeld() },
    request(url, _options, callback) {
      paths.push(new URL(url).pathname)
      const captured = { path: new URL(url).pathname, body: '' }
      requests.push(captured)
      const responseIndex = callCount++
      const outgoing = Object.assign(new EventEmitter(), {
        write(body) { captured.body += Buffer.isBuffer(body) ? body.toString('utf8') : body },
        destroy() {},
        end() {
          const respond = () => queueMicrotask(() => {
            const incoming = Object.assign(new EventEmitter(), { statusCode: 200, destroy() {} })
            callback(incoming)
            incoming.emit('data', Buffer.from(JSON.stringify(responses[responseIndex])))
            incoming.emit('end')
          })
          if (callCount === holdAt) {
            releaseHeld = respond
            notifyHeld()
          } else respond()
        }
      })
      return outgoing
    }
  }
}

async function harness(caseId, {
  halted = false, holdAt = 0, errorAt = 0, production = false, configureCatalog = null,
  configureResponses = null, clock = () => NOW, quoteParser = null, financialParser = null
} = {}) {
  const catalog = fixtureCatalog(caseId, 'FIXTURE_MAPPED_')
  if (configureCatalog) configureCatalog(catalog)
  const evidence = fixtureEvidence(caseId)
  /** @type {Array<ReturnType<typeof fixtureResponses>[number] | { errorcode: number, errmsg: string }>} */
  const responses = fixtureResponses(catalog, halted)
  if (configureResponses) configureResponses(responses)
  if (errorAt) responses[errorAt - 1] = { errorcode: -401, errmsg: 'unsafe-provider-detail' }
  const transport = transportFixture(responses, holdAt)
  const database = new DatabaseSync(':memory:')
  let reads = 0
  let reserves = 0
  let clears = 0
  let clients = 0
  let ids = 0
  let serviceOptions
  const runtime = await createIfindDiagnosticRuntime({
    env: {
      KINVEST_IFIND_DIAGNOSTIC_MODE: 'admin-diagnostic',
      KINVEST_IFIND_SECRET_BUNDLE_PATH: '/run/secrets/kinvest-ifind',
      KINVEST_IFIND_REFRESH_TOKEN_VERSION_ID: VERSION_ID
    },
    accessRuntime: { status: { mode: 'device-approval' } },
    openDatabase: () => database,
    clock,
    marketIdGenerator: () => 'market_run_' + (++ids).toString(16).padStart(32, '0'),
    loadSecrets: async () => ({
      readRefreshToken() { reads += 1; return Buffer.from('synthetic-integration-refresh') },
      clear() {}
    }),
    createClient() {
      const index = clients++
      const client = createIfindHttpClient({ request: transport.request })
      return Object.assign({}, client, {
        clear() { if (index === 1) clears += 1; client.clear() }
      })
    },
    ...(!production ? {
      marketCatalogLookup: (id) => id === caseId ? catalog : fixtureCatalog(id, 'FIXTURE_MAPPED_'),
      marketManifestLookup: (id) => createVerifiedMarketEvidenceBundle(
        id === caseId ? catalog : fixtureCatalog(id, 'FIXTURE_MAPPED_'),
        id === caseId ? evidence : fixtureEvidence(id)
      )
    } : {}),
    createMarketService(options) {
      const reserve = options.repository.reserve.bind(options.repository)
      options.repository.reserve = (input) => {
        reserves += 1
        return reserve(input)
      }
      serviceOptions = {
        ...options,
        ...(quoteParser ? { quoteParser } : {}),
        ...(financialParser ? { financialParser } : {})
      }
      return createIfindMarketDiagnosticService(serviceOptions)
    }
  })
  return {
    runtime, database, transport, catalog, evidence,
    get reads() { return reads },
    get reserves() { return reserves },
    get clears() { return clears },
    unverifiedService() {
      return createIfindMarketDiagnosticService({
        ...serviceOptions, catalogLookup: getIfindMarketCase,
        manifestLookup: createLiveRequestManifestBundle
      })
    },
    dispose() { runtime.clear(); database.close() }
  }
}

async function testTrustedBundleFactory() {
  assert.equal(typeof createVerifiedMarketEvidenceBundle, 'function', 'one verified bundle factory must exist')
  assert.equal(typeof createLiveRequestManifestBundle, 'function', 'runtime default must return a bundle')
  for (const caseId of CASE_IDS) {
    const definition = fixtureCatalog(caseId, 'FIXTURE_MAPPED_')
    const evidence = fixtureEvidence(caseId)
    const bundle = createVerifiedMarketEvidenceBundle(definition, evidence)
    assert.equal(bundle.manifest.vendorCode, definition.vendorCodes.ifind.code)
    assert.deepEqual(bundle.manifest.indicators, definition.indicators)
    assert.equal(Object.isFrozen(bundle), true)
    assert.equal(Object.isFrozen(bundle.manifest.indicators.quote[0]), true)
    for (const [field, source] of [
      ['fetchTime', 'runtime-clock'], ['sourceMode', 'verified-adapter']
    ]) {
      assert.deepEqual(bundle.manifest.indicators.financialMetadata[field], { source })
      assert.equal(Object.isFrozen(bundle.manifest.indicators.financialMetadata[field]), true)
      assert.throws(() => { bundle.manifest.indicators.financialMetadata[field].source = 'vendor' }, TypeError)
    }
    assert.equal(fixtureResponses(definition)[2].dataVol, 42)
    for (const family of ['quoteVerification', 'financialVerification']) {
      for (const dimension of [
        'issuerIdentityStatus', 'vendorCodeStatus', 'entitlementStatus',
        'currencyStatus', 'unitStatus', 'reportPeriodStatus', 'scopeStatus'
      ]) {
        for (const status of ['unverified', 'failed']) {
          const incomplete = fixtureEvidence(caseId)
          incomplete[family][dimension] = status
          assert.throws(() => createVerifiedMarketEvidenceBundle(fixtureCatalog(caseId), incomplete),
            `${caseId}: ${family}.${dimension} remains mandatory`)
        }
      }
    }
    definition.indicators.quote[0].vendorIndicatorId = 'UNAPPROVED_CHANGE'
    assert.notEqual(bundle.manifest.indicators.quote[0].vendorIndicatorId, 'UNAPPROVED_CHANGE')
    evidence.quoteVerification.entitlementStatus = 'unverified'
    assert.throws(() => createVerifiedMarketEvidenceBundle(fixtureCatalog(caseId), evidence))
    assert.throws(() => createLiveRequestManifestBundle(caseId), { code: 'IFIND_MARKET_CASE_UNVERIFIED' })
  }
}

async function testRejectedRequestsCannotClearOwner() {
  for (const holdAt of [1, 2]) {
    const test = await harness(CASE_IDS[0], { holdAt })
    let active
    try {
      active = test.runtime.marketService.run({ caseId: CASE_IDS[0] })
      await test.transport.held
      assert.equal((await test.runtime.marketService.run({ caseId: CASE_IDS[1] })).status, 'busy')
      assert.equal((await test.runtime.marketService.run({ caseId: 'UNKNOWN' })).status, 'rejected')
      assert.equal((await test.unverifiedService().run({ caseId: CASE_IDS[0] })).status, 'rejected')
      assert.equal(test.clears, 0, 'non-owner must not clear the real in-flight client')
      assert.equal(test.reads, 1)
      assert.equal(test.transport.calls, holdAt)
      test.transport.release()
      const result = await active
      assert.equal(result.status, 'complete', 'owner survives overlapping rejected calls')
      assert.equal(test.clears, 1)
      assert.equal(test.transport.calls, 3)
      assert.equal(test.runtime.marketService.latest({ caseId: CASE_IDS[0] }).financialPoints.length, 21)
      assert.equal(test.database.prepare('SELECT COUNT(*) AS count FROM ifind_market_case_runs').get().count, 1)
    } finally {
      test.transport.release()
      if (active) await active
      test.dispose()
    }
  }
}

async function testMappedThreeMarketPersistence() {
  for (const caseId of CASE_IDS) {
    const test = await harness(caseId, { halted: true })
    try {
      const result = await test.runtime.marketService.run({ caseId })
      assert.equal(result.status, 'complete', caseId)
      const stored = test.runtime.marketService.latest({ caseId })
      assert.equal(stored.quoteSnapshot.tradingStatus, 'halted', caseId)
      assert.equal(stored.quoteSnapshot.currency, test.catalog.expectedTradingCurrency)
      assert.equal(stored.financialPoints.length, 21)
      assert.ok(stored.financialPoints.every((point) =>
        new Date(point.fetchTime).toISOString() === new Date(NOW).toISOString()),
      caseId + ': persisted fetch time equals the service clock')
      assert.ok(stored.financialPoints.every((point) => point.currency === test.evidence.financialReportingCurrencyEvidence.currency))
      assert.ok(stored.financialPoints.every((point) => point.indicatorId.startsWith('FIXTURE_MAPPED_')))
      assert.ok(stored.financialPoints.some((point) => point.value === null && point.availability === 'missing'))
      assert.equal(stored.financialPoints.filter((point) =>
        point.metricKey === 'grossProfit' && point.value === null && point.availability === 'missing').length, 1,
      'the missing provider metric stays missing without Mock fill')
      assert.doesNotMatch(JSON.stringify(stored.financialPoints), /Mock/)
      assert.deepEqual(test.transport.paths, ['/api/v1/get_access_token', '/api/v1/real_time_quotation', '/api/v1/basic_data_service'])
      assert.equal(test.catalog.requestTemplates.financial.indicatorIds.length, 14)
      for (const id of test.catalog.requestTemplates.financial.indicatorIds) {
        assert.ok(test.transport.requests[2].body.includes(id), caseId + ': requested remote ID ' + id)
      }
      assert.doesNotMatch(test.transport.requests[2].body, /FETCH_TIME|SOURCE_MODE|fetchTime|sourceMode/)
    } finally { test.dispose() }
  }
}

async function testProductionEvidenceStillRejectsBeforeTransport() {
  for (const caseId of CASE_IDS) {
    const test = await harness(caseId, { production: true })
    try {
      const outcome = await test.runtime.marketService.run({ caseId })
      assert.equal(outcome.failureCode, 'IFIND_MARKET_CASE_UNVERIFIED')
      assert.equal(outcome.status, 'rejected')
      assert.equal(test.transport.calls, 0)
      assert.equal(test.reads, 0)
      assert.equal(test.reserves, 0)
      assert.equal(test.clears, 0)
      assert.equal(test.runtime.marketService.latest({ caseId }), null)
      assert.equal(test.database.prepare('SELECT COUNT(*) AS count FROM ifind_market_case_runs').get().count, 0)
    } finally { test.dispose() }
  }
}

async function testFinancialClockCapturedBeforeParsers() {
  const caseId = CASE_IDS[0]
  let now = NOW
  let observedFetchTime
  let quoteParsed = false
  const fetchedAt = NOW + 1234
  const test = await harness(caseId, {
    holdAt: 3,
    clock: () => now,
    quoteParser(input) {
      quoteParsed = true
      now = NOW + 2234
      return parseIfindMarketQuote(input)
    },
    financialParser(input) {
      observedFetchTime = input.fetchTime
      now = NOW + 3234
      return parseIfindMarketFinancials(input)
    }
  })
  let active
  try {
    active = test.runtime.marketService.run({ caseId })
    await Promise.race([
      test.transport.held,
      active.then(() => { throw new Error('run ended before the financial response was held') })
    ])
    now = fetchedAt
    test.transport.release()
    const result = await active
    assert.equal(result.status, 'complete')
    assert.equal(quoteParsed, true)
    assert.equal(observedFetchTime, new Date(fetchedAt).toISOString(),
      'capture after financial completion, before either parser advances the clock')
    const stored = test.runtime.marketService.latest({ caseId })
    assert.equal(stored.financialPoints.length, 21)
    assert.ok(stored.financialPoints.every((point) => new Date(point.fetchTime).getTime() === fetchedAt))
  } finally {
    test.transport.release()
    if (active) await active
    test.dispose()
  }
}

async function testProviderLocalProvenanceCannotPersist() {
  for (const caseId of CASE_IDS) {
    const market = caseId.slice(0, 2)
    for (const field of [
      'fetchTime', 'sourceMode', `TEST_ONLY_${market}_FETCH_TIME`, `TEST_ONLY_${market}_SOURCE_MODE`,
      `FIXTURE_MAPPED_${market}_FETCH_TIME`, `FIXTURE_MAPPED_${market}_SOURCE_MODE`
    ]) {
      const test = await harness(caseId, {
        configureResponses(responses) {
          const value = field === 'sourceMode' || field.endsWith('SOURCE_MODE')
            ? 'real' : new Date(NOW).toISOString()
          responses[2].tables[0].table[field] = [value, value, value]
          responses[2].dataVol += 3
        }
      })
      try {
        const result = await test.runtime.marketService.run({ caseId })
        assert.equal(result.status, 'partial', caseId + ': reject provider ' + field)
        assert.equal(result.failureCode, 'IFIND_MARKET_FINANCIAL_UNAVAILABLE')
        const stored = test.runtime.marketService.latest({ caseId })
        assert.equal(stored.financeStatus, 'unavailable')
        assert.ok(stored.quoteSnapshot)
        assert.deepEqual(stored.financialPoints, [], 'provider provenance must never persist')
        assert.equal(test.transport.calls, 3)
        assert.equal(test.reads, 1)
        assert.equal(test.reserves, 1)
      } finally { test.dispose() }
    }
  }
}

async function testParserFetchTimeSpoofCannotPersist() {
  for (const caseId of CASE_IDS) {
    for (const spoof of [new Date(NOW + 1).toISOString(), '2026-08-29T04:00:00Z']) {
      let observedFetchTime
      let parsedPointCount = 0
      let parsedSource
      const test = await harness(caseId, {
        financialParser(input) {
          observedFetchTime = input.fetchTime
          const parsed = parseIfindMarketFinancials(input)
          parsedPointCount = parsed.points.length
          parsedSource = parsed.source
          return {
            ...parsed,
            points: parsed.points.map((point, index) => index === parsed.points.length - 1
              ? { ...point, fetchTime: spoof } : point)
          }
        }
      })
      try {
        const result = await test.runtime.marketService.run({ caseId })
        assert.equal(observedFetchTime, new Date(NOW).toISOString())
        assert.equal(parsedSource, 'real', 'spoof test starts with valid parser output')
        assert.equal(parsedPointCount, 21)
        assert.equal(result.status, 'partial', caseId + ': last point cannot spoof fetch time')
        assert.equal(result.failureCode, 'IFIND_MARKET_FINANCIAL_UNAVAILABLE')
        const stored = test.runtime.marketService.latest({ caseId })
        assert.ok(stored.quoteSnapshot)
        assert.deepEqual(stored.financialPoints, [])
      } finally { test.dispose() }
    }
  }
}

async function withHttp(test, operation) {
  const adminToken = 'A'.repeat(43)
  const csrf = 'C'.repeat(43)
  const session = { sessionId: 'integration-session', idleExpiresAt: NOW + 1_800_000, absoluteExpiresAt: NOW + 28_800_000 }
  const server = http.createServer(createRequestHandler({
    accessRuntime: {
      status: { mode: 'device-approval' },
      deviceApproval: {
        authenticate() { throw new Error('TOKEN_INVALID') }
      },
      adminAuth: {
        authenticate(token) { assert.equal(token, adminToken); return session },
        authenticateMutation(token, suppliedCsrf) {
          assert.equal(token, adminToken)
          assert.equal(suppliedCsrf, csrf)
          return { status: 'authenticated', ...session }
        }
      }
    },
    ifindDiagnosticRuntime: test.runtime,
    now: () => NOW, publicOrigin: 'https://dearmina.cn', trustedProxyAddresses: ['127.0.0.1']
  }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  try {
    const address = /** @type {import('node:net').AddressInfo} */ (server.address())
    await operation(async (path, method = 'GET') => {
      const response = await fetch(`http://127.0.0.1:${address.port}` + path, {
        method,
        headers: {
          cookie: '__Host-kinvest-admin=' + adminToken,
          origin: 'https://dearmina.cn', 'content-type': 'application/json',
          'x-kinvest-csrf': csrf, 'x-real-ip': '203.0.113.24',
          'x-forwarded-for': '203.0.113.24'
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
        signal: AbortSignal.timeout(5000)
      })
      return { status: response.status, body: await response.json() }
    })
  } finally {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined)))
  }
}

async function testRealHttpRetainsNegativeVendorCodes() {
  for (const errorAt of [1, 3]) {
    const test = await harness(CASE_IDS[0], { errorAt })
    try {
      await withHttp(test, async (request) => {
        const response = await request('/api/admin/ifind/market-cases/' + CASE_IDS[0] + '/run', 'POST')
        assert.equal(response.status, 200, JSON.stringify(response.body))
        assert.equal(response.body.data.status, errorAt === 1 ? 'failed' : 'partial')
        assert.equal(test.runtime.marketService.latest({ caseId: CASE_IDS[0] }).vendorErrorCode, -401)
        assert.equal(Object.hasOwn(response.body.data.case.latest, 'vendorErrorCode'), false)
        assert.ok(response.body.data.case.history.length > 0)
        for (const record of response.body.data.case.history) {
          assert.equal(Object.hasOwn(record, 'vendorErrorCode'), false)
        }
        assert.doesNotMatch(JSON.stringify(response.body), /"vendorCode"|"vendorErrorCode"/)
        assert.doesNotMatch(JSON.stringify(response.body), /unsafe-provider-detail|synthetic-integration-access|synthetic-integration-refresh/)
      })
    } finally { test.dispose() }
  }
}

async function testRealHttpRetainsMarketSemantics() {
  for (const caseId of CASE_IDS) {
    const test = await harness(caseId, { halted: true })
    try {
      await withHttp(test, async (request) => {
        const response = await request('/api/admin/ifind/market-cases/' + caseId + '/run', 'POST')
        assert.equal(response.status, 200, caseId + ': ' + JSON.stringify(response.body))
        assert.equal(response.body.data.status, 'complete')
        const serialized = JSON.stringify(response.body.data.case.latest)
        assert.match(serialized, /"tradingStatus":"halted"/)
        assert.ok(serialized.includes('"currency":"' + test.catalog.expectedTradingCurrency + '"'))
        assert.ok(serialized.includes('"currency":"' + test.evidence.financialReportingCurrencyEvidence.currency + '"'))
        const readback = await request('/api/admin/ifind/market-cases/' + caseId)
        assert.equal(readback.status, 200)
        assert.deepEqual(readback.body.data.latest, response.body.data.case.latest)
        assert.equal(test.transport.calls, 3, 'HTTP readback never invokes the provider')
      })
    } finally { test.dispose() }
  }
}

function synchronizeTemplateIds(catalog) {
  catalog.requestTemplates.quote.fields = catalog.indicators.quote.map((entry) => entry.vendorIndicatorId)
  catalog.requestTemplates.financial.indicatorIds = [
    ...catalog.indicators.financial.map((entry) => entry.vendorIndicatorId),
    ...REMOTE_FINANCIAL_METADATA_FIELDS.map((field) => catalog.indicators.financialMetadata[field].vendorIndicatorId)
  ]
}

function configureBoundaryIds(catalog) {
  for (const [prefix, entries] of [
    ['q', catalog.indicators.quote],
    ['f', catalog.indicators.financial],
    ['m', REMOTE_FINANCIAL_METADATA_FIELDS.map((field) => catalog.indicators.financialMetadata[field])]
  ]) {
    entries.forEach((entry, index) => {
      entry.vendorIndicatorId = index === 0 ? prefix
        : index === 1 ? prefix + 'MiX_09'
          : index === 2 ? prefix + 'X'.repeat(79)
            : prefix + '_lower_' + index
    })
  }
  synchronizeTemplateIds(catalog)
}

async function testIndicatorIdsPreserveCaseAndLengthThroughHttp() {
  const caseId = CASE_IDS[0]
  const test = await harness(caseId, { halted: true, configureCatalog: configureBoundaryIds })
  try {
    await withHttp(test, async (request) => {
      const response = await request('/api/admin/ifind/market-cases/' + caseId + '/run', 'POST')
      assert.equal(response.status, 200, 'legal lowercase/mixed/80-byte ID HTTP status')
      assert.equal(response.body.data.status, 'complete', 'legal IDs must survive the complete production composition')
      const stored = test.runtime.marketService.latest({ caseId })
      assert.equal(stored.quoteSnapshot.tradingStatus, 'halted')
      assert.equal(stored.quoteSnapshot.currency, 'HKD')
      assert.ok(stored.financialPoints.every((point) => point.currency === 'CNY'))
      const expectedIds = test.catalog.indicators.financial.map((entry) => entry.vendorIndicatorId)
      assert.deepEqual([...new Set(stored.financialPoints.map((point) => point.indicatorId))].sort(), [...expectedIds].sort())
      assert.equal(stored.financialPoints.length, 21)
      const serialized = JSON.stringify(response.body.data.case.latest)
      assert.ok(serialized.includes('"metricKey":"revenue"'))
      assert.ok(serialized.includes('"value":1'))
      assert.ok(serialized.includes('"latestPrice":101.25'))
      assert.match(serialized, /"tradingStatus":"halted"/)
      assert.ok(serialized.includes('"currency":"HKD"'))
      assert.ok(serialized.includes('"currency":"CNY"'))
      assert.doesNotMatch(serialized, /"indicatorId"|"vendorCode"|"vendorErrorCode"/)
      for (const id of test.catalog.requestTemplates.quote.fields) {
        assert.ok(test.transport.requests[1].body.includes(id), 'quote request must preserve ID ' + id)
      }
      for (const id of test.catalog.requestTemplates.financial.indicatorIds) {
        assert.ok(test.transport.requests[2].body.includes(id), 'financial request must preserve ID ' + id)
      }
      assert.equal(test.reserves, 1)
      assert.equal(test.reads, 1)
      assert.equal(test.transport.calls, 3)
    })
  } finally { test.dispose() }
}

async function testInvalidIndicatorIdsRejectBeforeReservation() {
  const invalidIds = [
    ['empty', ''], ['null', null], ['undefined', undefined],
    ['81 bytes', 'a'.repeat(81)], ['space only', ' '],
    ['leading space', ' id'], ['trailing space', 'id '], ['embedded space', 'i d'],
    ['tab', 'id\t'], ['CR', 'id\r'], ['LF', 'id\n'], ['CRLF', 'id\r\n'],
    ['dot', 'id.name'], ['hyphen', 'id-name'], ['colon', 'id:name'],
    ['non-ASCII', 'id\u00e9']
  ]
  const targets = ['quote declaration', 'financial declaration', 'metadata declaration', 'quote template', 'financial template']
  const failures = []
  for (const target of targets) {
    for (const [label, id] of invalidIds) {
      const test = await harness(CASE_IDS[0], {
        configureCatalog(catalog) {
          if (target === 'quote declaration') catalog.indicators.quote[0].vendorIndicatorId = id
          if (target === 'financial declaration') catalog.indicators.financial[0].vendorIndicatorId = id
          if (target === 'metadata declaration') catalog.indicators.financialMetadata.unit.vendorIndicatorId = id
          synchronizeTemplateIds(catalog)
          if (target === 'quote template') catalog.requestTemplates.quote.fields[0] = id
          if (target === 'financial template') catalog.requestTemplates.financial.indicatorIds[0] = id
        }
      })
      try {
        const result = await test.runtime.marketService.run({ caseId: CASE_IDS[0] })
        const observed = {
          status: result.status, code: result.failureCode,
          reserves: test.reserves, reads: test.reads, transport: test.transport.calls,
          rows: test.database.prepare('SELECT COUNT(*) AS count FROM ifind_market_case_runs').get().count
        }
        try {
          assert.deepEqual(observed, {
            status: 'rejected', code: 'IFIND_MARKET_CASE_UNVERIFIED',
            reserves: 0, reads: 0, transport: 0, rows: 0
          })
        } catch {
          failures.push({ target, label, ...observed })
        }
      } finally { test.dispose() }
    }
  }
  assert.equal(failures.length, 0, 'IDs admitted past the evidence gate: ' + JSON.stringify(failures))
}

async function runIndicatorIdChecks() {
  const failures = []
  for (const routine of [testIndicatorIdsPreserveCaseAndLengthThroughHttp, testInvalidIndicatorIdsRejectBeforeReservation]) {
    try { await routine() } catch (error) {
      failures.push(routine.name + ': ' + error.message)
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'))
}

async function testRecoveredFinancialClockPersistsPartial() {
  const failures = []
  for (const caseId of CASE_IDS) {
    for (const [label, observedAt] of /** @type {Array<[string, number]>} */ ([
      ['rollback', NOW - 1], ['invalid', Number.NaN], ['expired', NOW + 30_001]
    ])) {
      let transport = null
      let injected = false
      let financialParserCalls = 0
      const test = await harness(caseId, {
        clock() {
          if (transport && transport.calls === 3 && !injected) {
            injected = true
            return observedAt
          }
          return NOW
        },
        financialParser() {
          financialParserCalls += 1
          throw new Error('Financial parser must not run after clock failure')
        }
      })
      transport = test.transport
      try {
        const outcome = await test.runtime.marketService.run({ caseId })
        assert.equal(injected, true, 'completion clock failure must be exercised')
        assert.equal(outcome.status, 'partial', `${caseId}/${label}: ${outcome.failureCode}`)
        const stored = test.runtime.marketService.latest({ caseId })
        assert.equal(stored.status, 'partial')
        assert.equal(stored.safeErrorClass, 'API', 'persist only repository-safe classes')
        assert.equal(stored.failureCode, outcome.failureCode, 'retain originating failure code')
        if (label === 'rollback') assert.equal(stored.failureCode, 'IFIND_MARKET_CLOCK_ROLLBACK')
        assert.equal(stored.quoteSnapshot.latestPrice, 101.25, 'preserve the successful quote')
        assert.equal(stored.quoteSnapshot.currency, test.catalog.expectedTradingCurrency)
        assert.deepEqual(stored.financialPoints, [], 'never persist unverifiable financial points')
        assert.equal(stored.dataVol, 52, 'retain quote and financial response accounting')
        assert.equal(stored.requestCount, 3)
        assert.equal(financialParserCalls, 0)
        assert.equal(test.transport.calls, 3)
        assert.equal(test.reserves, 1)
        assert.equal(test.reads, 1)
        assert.equal(test.clears, 1)
        assert.equal(test.database.prepare('SELECT COUNT(*) AS count FROM ifind_market_case_runs').get().count, 1)
      } catch (error) {
        failures.push(`${caseId}/${label}: ${error.message}`)
      } finally { test.dispose() }
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'))
}

async function runRepositoryChecks() {
  await testRecoveredFinancialClockPersistsPartial()
  await testTrustedBundleFactory()
  await testRejectedRequestsCannotClearOwner()
  await testMappedThreeMarketPersistence()
  await testFinancialClockCapturedBeforeParsers()
  await testProviderLocalProvenanceCannotPersist()
  await testParserFetchTimeSpoofCannotPersist()
  await testProductionEvidenceStillRejectsBeforeTransport()
}

async function runHttpChecks() {
  await testRealHttpRetainsNegativeVendorCodes()
  await testRealHttpRetainsMarketSemantics()
}

async function run() {
  await runRepositoryChecks()
  await runHttpChecks()
  await runIndicatorIdChecks()
}

module.exports = { run, runRepositoryChecks, runHttpChecks, runIndicatorIdChecks }
