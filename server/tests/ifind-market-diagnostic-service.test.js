'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const {
  createIfindMarketDiagnosticService
} = require('../services/ifind-market-diagnostic-service')
const { createIfindHttpClient } = require('../adapters/ifind-http-client')
const {
  createLiveRequestManifestBundle,
  getIfindMarketCase
} = require('../domain/ifind-market-cases')
const { parseIfindMarketQuote } = require('../domain/ifind-market-quote-parser')
const { parseIfindMarketFinancials } = require('../domain/ifind-market-financial-parser')
const { createVerifiedMarketEvidenceBundle } = require('../domain/ifind-market-manifest-validator')

const CREATED_AT = Date.parse('2026-08-29T04:00:00.000Z')
const RUN_ID = 'market_run_0123456789abcdef01234567'
const TOKEN_VERSION_ID = 'v20260829-001'

const VERIFIED = Object.freeze({
  issuerIdentityStatus: 'verified',
  vendorCodeStatus: 'verified',
  entitlementStatus: 'verified',
  currencyStatus: 'verified',
  unitStatus: 'verified',
  reportPeriodStatus: 'verified',
  scopeStatus: 'verified',
  sourceMode: 'real'
})

const QUOTE_SUFFIXES = Object.freeze({
  latestPrice: 'LATEST_PRICE',
  previousClose: 'PREVIOUS_CLOSE',
  open: 'OPEN',
  high: 'HIGH',
  low: 'LOW',
  volume: 'VOLUME',
  turnover: 'TURNOVER',
  quoteTime: 'QUOTE_TIME',
  tradingStatus: 'TRADING_STATUS',
  currency: 'CURRENCY'
})

const FINANCIAL_SUFFIXES = Object.freeze({
  revenue: 'REVENUE',
  grossProfit: 'GROSS_PROFIT',
  attributableNetProfit: 'NET_PROFIT',
  operatingCashFlow: 'OPERATING_CASH_FLOW',
  receivables: 'RECEIVABLES',
  inventory: 'INVENTORY',
  interestBearingDebt: 'INTEREST_BEARING_DEBT'
})

const FINANCIAL_METADATA_SUFFIXES = Object.freeze({
  currency: 'CURRENCY',
  unit: 'UNIT',
  reportPeriod: 'REPORT_PERIOD',
  reportDate: 'REPORT_DATE',
  periodType: 'PERIOD_TYPE',
  disclosureScope: 'DISCLOSURE_SCOPE',
  sourceTime: 'SOURCE_TIME'
})

const CASES = Object.freeze({
  HK_ALIBABA_9988: Object.freeze({
    market: 'HK',
    companyName: 'Alibaba',
    companyId: 'company-alibaba-group',
    listingId: 'listing-hkex-9988',
    issuerLegalName: 'Alibaba Group Holding Limited',
    exchange: 'HKEX',
    exchangeCode: '9988',
    displayCode: '9988.HK',
    formatAliases: ['09988.HK'],
    marketTemplateId: 'HK_EQUITY_V1',
    tradingCurrency: 'HKD',
    reportingCurrency: 'CNY',
    timeZone: 'Asia/Hong_Kong',
    parserId: 'ifind-hk-equity-v1',
    vendorCode: 'TEST_ONLY_HK_CODE',
    quoteTime: '2026-08-29 15:59:00',
    scope: 'consolidated',
    periods: [
      ['FY2025', '2025-03-31', 'annual', '2025-05-15T17:30:00+08:00'],
      ['FY2024', '2024-03-31', 'annual', '2024-05-16T17:30:00+08:00'],
      ['H1-FY2026', '2025-09-30', 'interim', '2025-11-14T17:30:00+08:00']
    ]
  }),
  US_APPLE_AAPL: Object.freeze({
    market: 'US',
    companyName: 'Apple',
    companyId: 'company-apple',
    listingId: 'listing-nasdaq-aapl',
    issuerLegalName: 'Apple Inc.',
    exchange: 'NASDAQ',
    exchangeCode: 'AAPL',
    displayCode: 'AAPL.US',
    formatAliases: [],
    marketTemplateId: 'US_EQUITY_V1',
    tradingCurrency: 'USD',
    reportingCurrency: 'USD',
    timeZone: 'America/New_York',
    parserId: 'ifind-us-equity-v1',
    vendorCode: 'TEST_ONLY_US_CODE',
    quoteTime: '08/29/2026 15:59:00 EDT',
    scope: 'issuer_consolidated',
    periods: [
      ['FY2024', '2024-09-28', 'annual', '2024-11-01T06:00:00-04:00'],
      ['FY2023', '2023-09-30', 'annual', '2023-11-03T06:00:00-04:00'],
      ['Q3-FY2025', '2025-06-28', 'interim', '2025-08-01T06:00:00-04:00']
    ]
  }),
  CN_MOUTAI_600519: Object.freeze({
    market: 'CN',
    companyName: 'Kweichow Moutai',
    companyId: 'company-kweichow-moutai',
    listingId: 'listing-sse-600519',
    issuerLegalName: 'Kweichow Moutai Co., Ltd.',
    exchange: 'SSE',
    exchangeCode: '600519',
    displayCode: '600519.SH',
    formatAliases: [],
    marketTemplateId: 'CN_EQUITY_V1',
    tradingCurrency: 'CNY',
    reportingCurrency: 'CNY',
    timeZone: 'Asia/Shanghai',
    parserId: 'ifind-cn-equity-v1',
    vendorCode: 'TEST_ONLY_CN_CODE',
    quoteTime: '20260829145900',
    scope: 'consolidated',
    periods: [
      ['2024A', '2024-12-31', 'annual', '2025-04-03T18:00:00+08:00'],
      ['2023A', '2023-12-31', 'annual', '2024-04-03T18:00:00+08:00'],
      ['2025H1', '2025-06-30', 'interim', '2025-08-13T18:00:00+08:00']
    ]
  })
})

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function quoteId(definition, metric) {
  return `TEST_ONLY_${definition.market}_${QUOTE_SUFFIXES[metric]}`
}

function financialId(definition, metric) {
  return `TEST_ONLY_${definition.market}_${FINANCIAL_SUFFIXES[metric]}`
}

function metadataId(definition, suffix) {
  return `TEST_ONLY_${definition.market}_${suffix}`
}

function strictLiveCatalog(caseId) {
  const definition = CASES[caseId]
  const quoteIndicators = Object.keys(QUOTE_SUFFIXES).map((metric) => ({
    metric,
    vendorIndicatorId: quoteId(definition, metric),
    evidenceStatus: 'verified'
  }))
  const financialIndicators = Object.keys(FINANCIAL_SUFFIXES).map((metric) => ({
    metric,
    vendorIndicatorId: financialId(definition, metric),
    evidenceStatus: 'verified'
  }))
  /**
   * @type {Record<string,
   *   {vendorIndicatorId: string, evidenceStatus: string, sourceReference: string, source?: never} |
   *   {source: 'runtime-clock' | 'verified-adapter', vendorIndicatorId?: never, evidenceStatus?: never, sourceReference?: never}
   * >}
   */
  const financialMetadata = Object.fromEntries(
    Object.entries(FINANCIAL_METADATA_SUFFIXES).map(([field, suffix]) => [field, {
      vendorIndicatorId: metadataId(definition, suffix),
      evidenceStatus: 'verified',
      sourceReference: `fixture://ifind/${definition.market.toLowerCase()}/metadata/${field}`
    }])
  )
  financialMetadata.fetchTime = { source: 'runtime-clock' }
  financialMetadata.sourceMode = { source: 'verified-adapter' }
  return {
    caseId,
    companyName: definition.companyName,
    companyId: definition.companyId,
    listingId: definition.listingId,
    issuerLegalName: definition.issuerLegalName,
    exchange: definition.exchange,
    exchangeCode: definition.exchangeCode,
    displayCode: definition.displayCode,
    formatAliases: clone(definition.formatAliases),
    marketTemplateId: definition.marketTemplateId,
    expectedTradingCurrency: definition.tradingCurrency,
    marketTimeZone: definition.timeZone,
    vendorCodes: {
      ifind: { code: definition.vendorCode, evidenceStatus: 'verified' }
    },
    requestTemplates: {
      quote: {
        endpoint: '/api/v1/real_time_quotation',
        fields: quoteIndicators.map((indicator) => indicator.vendorIndicatorId),
        evidenceStatus: 'verified'
      },
      financial: {
        endpoint: '/api/v1/basic_data_service',
        indicatorIds: [
          ...financialIndicators.map((indicator) => indicator.vendorIndicatorId),
          ...Object.keys(FINANCIAL_METADATA_SUFFIXES).map((field) =>
            financialMetadata[field].vendorIndicatorId)
        ],
        evidenceStatus: 'verified'
      }
    },
    indicators: {
      quote: quoteIndicators,
      financial: financialIndicators,
      financialMetadata
    },
    periodRules: {
      fullFiscalYears: 2,
      includeLatestDisclosedInterim: true,
      vendorParameters: {
        fullFiscalYears: {
          count: 2,
          requestParameters: { count: 2, periodType: 'annual' }
        },
        latestDisclosedInterim: {
          enabled: true,
          requestParameters: { latest: true, periodType: 'interim' }
        }
      },
      evidenceStatus: 'verified'
    },
    parserId: definition.parserId,
    liveReady: true
  }
}

function strictManifestEvidence(caseId) {
  const catalog = strictLiveCatalog(caseId)
  const definition = CASES[caseId]
  return createVerifiedMarketEvidenceBundle(catalog, {
    quoteVerification: clone(VERIFIED),
    financialVerification: clone(VERIFIED),
    financialReportingCurrencyEvidence: {
      caseId,
      listingId: definition.listingId,
      currency: definition.reportingCurrency,
      evidenceStatus: 'verified',
      sourceIdentity: 'kinvest-task6-test-evidence',
      sourceReference: `fixture://ifind/${definition.market.toLowerCase()}-financial-success`,
      verifiedAt: '2025-11-20T08:00:00.000Z'
    }
  })
}

function quotePayload(caseId) {
  const definition = CASES[caseId]
  const values = {
    latestPrice: 101.25,
    previousClose: 100,
    open: 100.5,
    high: 102,
    low: 99.75,
    volume: 1234,
    turnover: 123456.75,
    quoteTime: definition.quoteTime,
    tradingStatus: definition.market === 'US' ? 'REGULAR' : definition.market === 'CN' ? 'TRADE' : 'TRADING',
    currency: definition.tradingCurrency
  }
  const table = {}
  for (const metric of Object.keys(QUOTE_SUFFIXES)) {
    table[quoteId(definition, metric)] = [values[metric]]
  }
  return {
    errorcode: 0,
    tables: [{ thscode: definition.vendorCode, table }],
    dataVol: Object.keys(table).length
  }
}

function financialPayload(caseId) {
  const definition = CASES[caseId]
  const periodCount = definition.periods.length
  const table = {}
  let seed = 100
  for (const metric of Object.keys(FINANCIAL_SUFFIXES)) {
    table[financialId(definition, metric)] = Array.from(
      { length: periodCount },
      (_, index) => seed + index
    )
    seed += 100
  }
  table[metadataId(definition, 'CURRENCY')] = definition.periods.map(() => definition.reportingCurrency)
  table[metadataId(definition, 'UNIT')] = definition.periods.map(() => 'million')
  table[metadataId(definition, 'REPORT_PERIOD')] = definition.periods.map((period) => period[0])
  table[metadataId(definition, 'REPORT_DATE')] = definition.periods.map((period) => period[1])
  table[metadataId(definition, 'PERIOD_TYPE')] = definition.periods.map((period) => period[2])
  table[metadataId(definition, 'DISCLOSURE_SCOPE')] = definition.periods.map(() => definition.scope)
  table[metadataId(definition, 'SOURCE_TIME')] = definition.periods.map((period) => period[3])
  return {
    errorcode: 0,
    tables: [{ thscode: definition.vendorCode, table }],
    dataVol: Object.values(table).reduce((total, values) => total + values.length, 0)
  }
}

function quota(caseId) {
  return {
    localDayKey: '2026-08-29',
    caseAttemptCount: 0,
    globalAttemptCount: 0,
    caseRemaining: 5,
    globalRemaining: 12,
    cooldownUntil: null,
    inFlight: false,
    inFlightCaseId: null,
    inFlightExpiresAt: null,
    caseId
  }
}

function reservation(caseId) {
  return {
    runId: RUN_ID,
    caseId,
    createdAt: CREATED_AT,
    tokenVersionId: TOKEN_VERSION_ID,
    leaseExpiresAt: CREATED_AT + 30_000
  }
}

function safeClientError({
  code = 'IFIND_TIMEOUT',
  errorClass = 'NETWORK',
  stage = 'quote',
  requestCount = 1,
  vendorErrorCode = null
} = {}) {
  return Object.assign(new Error('secret provider message RequestId=unsafe token=unsafe'), {
    failureCode: code,
    class: errorClass,
    stage,
    requestCount,
    vendorErrorCode,
    RequestId: 'unsafe-request-id',
    accessToken: 'unsafe-access-token'
  })
}

function createProductionTransport(responses) {
  const calls = []
  return {
    calls,
    request(url, options, callback) {
      const call = { url, options, body: null }
      calls.push(call)
      const outgoing = Object.assign(new EventEmitter(), {
        write(body) { call.body = body },
        destroy() {},
        end() {
          queueMicrotask(() => {
            const response = Object.assign(new EventEmitter(), {
              statusCode: 200,
              headers: Object.freeze({}),
              destroy() {}
            })
            callback(response)
            response.emit('data', Buffer.from(JSON.stringify(responses.shift()), 'utf8'))
            response.emit('end')
          })
        }
      })
      return outgoing
    }
  }
}

function createHarness(caseId = 'HK_ALIBABA_9988', overrides = {}) {
  const calls = []
  const refreshTokens = []
  const accessTokens = []
  const rawBuffers = []
  const terminal = { complete: [], fail: [] }

  class ExistingInMemoryProvider {
    readRefreshToken() {
      calls.push('provider')
      const token = Buffer.from('refresh-token')
      refreshTokens.push(token)
      return token
    }
  }

  const repository = {
    /**
     * @returns {{
     *   status: string, reservation?: ReturnType<typeof reservation>,
     *   localDayKey?: string, caseAttemptCount?: number, globalAttemptCount?: number,
     *   retryAt?: number, inFlight?: boolean, inFlightCaseId?: string | null,
     *   inFlightExpiresAt?: number | null
     * }} Test doubles include reserved and rejected reservation outcomes.
     */
    reserve(input) {
      calls.push('reserve')
      assert.deepEqual(input, {
        runId: RUN_ID,
        caseId,
        createdAt: CREATED_AT,
        tokenVersionId: TOKEN_VERSION_ID
      })
      return {
        status: 'reserved',
        reservation: reservation(caseId),
        localDayKey: '2026-08-29',
        caseAttemptCount: 1,
        globalAttemptCount: 1
      }
    },
    complete(input) {
      calls.push('complete')
      terminal.complete.push(input)
      return { status: 'completed', cooldownUntil: input.result.completedAt + 300_000 }
    },
    fail(input) {
      calls.push('fail')
      terminal.fail.push(input)
      return { status: 'completed', cooldownUntil: input.result.completedAt + 300_000 }
    },
    latest(input) {
      calls.push('latest')
      return { kind: 'latest', input }
    },
    history(input) {
      calls.push('history')
      return [{ kind: 'history', input }]
    },
    quotaStatus(input) {
      calls.push('quota-status')
      return { kind: 'quota-status', input }
    }
  }

  const client = {
    /** @returns {Promise<{accessToken?: Buffer, requestCount: number}>} Includes malformed auth responses under test. */
    async authenticate(refreshToken) {
      calls.push('auth')
      assert.equal(Buffer.isBuffer(refreshToken), true)
      const accessToken = Buffer.from('access-token')
      accessTokens.push(accessToken)
      return { accessToken, requestCount: 1 }
    },
    /** @returns {Promise<{payload?: unknown, requestCount: number, dataVol: number}>} Includes hostile protocol responses. */
    async quote(accessToken, request) {
      calls.push('quote')
      assert.equal(Buffer.isBuffer(accessToken), true)
      assert.deepEqual(request, {
        vendorCode: CASES[caseId].vendorCode,
        fields: Object.keys(QUOTE_SUFFIXES).map((metric) => quoteId(CASES[caseId], metric))
      })
      const raw = Buffer.from('raw-quote')
      rawBuffers.push(raw)
      return { payload: quotePayload(caseId), requestCount: 1, dataVol: 10 }
    },
    /** @returns {Promise<{payload?: unknown, requestCount: number, dataVol: number}>} Includes missing financial responses. */
    async financial(accessToken, request) {
      calls.push('financial')
      assert.equal(Buffer.isBuffer(accessToken), true)
      assert.deepEqual(request, {
        vendorCode: CASES[caseId].vendorCode,
        indicatorIds: [
          ...Object.keys(FINANCIAL_SUFFIXES).map((metric) =>
            financialId(CASES[caseId], metric)),
          ...[
            'CURRENCY', 'UNIT', 'REPORT_PERIOD', 'REPORT_DATE', 'PERIOD_TYPE',
            'DISCLOSURE_SCOPE', 'SOURCE_TIME'
          ].map((suffix) => metadataId(CASES[caseId], suffix))
        ],
        periodParameters: {
          fullFiscalYears: { count: 2, periodType: 'annual' },
          latestDisclosedInterim: { latest: true, periodType: 'interim' }
        }
      })
      const raw = Buffer.from('raw-financial')
      rawBuffers.push(raw)
      return {
        payload: financialPayload(caseId),
        requestCount: 1,
        dataVol: financialPayload(caseId).dataVol
      }
    },
    clear() {
      calls.push('client-clear')
      for (const value of rawBuffers) value.fill(0)
    }
  }

  const dependencies = {
    tokenVersionId: TOKEN_VERSION_ID,
    clock: () => CREATED_AT,
    idGenerator: () => RUN_ID,
    catalogLookup(value) {
      calls.push('catalog')
      assert.equal(value, caseId)
      return strictLiveCatalog(value)
    },
    manifestLookup(value) {
      calls.push('manifest')
      assert.equal(value, caseId)
      return strictManifestEvidence(value)
    },
    client,
    quoteParser(input) {
      calls.push('quote-parser')
      return parseIfindMarketQuote(input)
    },
    financialParser(input) {
      calls.push('financial-parser')
      return parseIfindMarketFinancials(input)
    },
    repository,
    secretProvider: new ExistingInMemoryProvider(),
    ...overrides
  }

  return {
    calls,
    client,
    dependencies,
    repository,
    terminal,
    refreshTokens,
    accessTokens,
    rawBuffers,
    service: createIfindMarketDiagnosticService(dependencies)
  }
}

function assertZeroed(values, label) {
  for (const value of values) {
    assert.equal(value.equals(Buffer.alloc(value.length)), true, label)
  }
}

function assertSafeFailure(result, expected) {
  assert.deepEqual(result, {
    status: expected.status || 'failed',
    failureCode: expected.failureCode,
    safeErrorClass: expected.safeErrorClass,
    stage: expected.stage,
    vendorErrorCode: expected.vendorErrorCode === undefined
      ? null
      : expected.vendorErrorCode
  })
  const serialized = JSON.stringify(result).toLowerCase()
  for (const forbidden of ['message', 'requestid', 'token', 'raw']) {
    assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`)
  }
}

function assertQuotePreservingPartial(harness, result, expected) {
  assert.equal(result.status, 'partial')
  assert.equal(result.caseId, 'HK_ALIBABA_9988')
  assert.equal(result.runId, RUN_ID)
  assert.equal(result.quoteStatus, 'available')
  assert.equal(result.financeStatus, 'unavailable')
  assert.equal(result.failureCode, expected.failureCode)
  assert.equal(result.safeErrorClass, expected.safeErrorClass)
  assert.equal(result.stage, expected.stage)
  assert.equal(result.vendorErrorCode, expected.vendorErrorCode || null)
  assert.equal(harness.terminal.complete.length, 1)
  assert.equal(harness.terminal.fail.length, 0)
  assert.equal(
    harness.terminal.complete[0].quoteSnapshot.listingId,
    CASES.HK_ALIBABA_9988.listingId
  )
  assert.deepEqual(harness.terminal.complete[0].financialPoints, [])
  assert.equal(harness.terminal.complete[0].result.status, 'partial')
  assert.equal(harness.terminal.complete[0].result.financeStatus, 'unavailable')
  assert.equal(harness.terminal.complete[0].result.failureCode, expected.failureCode)
}

async function testRepositoryReadersAreExposed() {
  const harness = createHarness()
  const latestInput = { caseId: 'HK_ALIBABA_9988' }
  const historyInput = { caseId: 'HK_ALIBABA_9988', limit: 10 }
  const quotaInput = { caseId: 'HK_ALIBABA_9988', now: CREATED_AT }

  assert.deepEqual(harness.service.latest(latestInput), {
    kind: 'latest', input: latestInput
  })
  assert.deepEqual(harness.service.history(historyInput), [{
    kind: 'history', input: historyInput
  }])
  assert.deepEqual(harness.service.quotaStatus(quotaInput), {
    kind: 'quota-status', input: quotaInput
  })
  assert.deepEqual(harness.calls, ['latest', 'history', 'quota-status'])
}

async function testThreeMarketSuccess() {
  for (const caseId of Object.keys(CASES)) {
    const harness = createHarness(caseId)
    const result = await harness.service.run({ caseId })
    assert.deepEqual(result, {
      status: 'complete',
      caseId,
      runId: RUN_ID,
      quoteStatus: 'available',
      financeStatus: 'available',
      requestCount: 3
    })
    assert.deepEqual(harness.calls, [
      'catalog', 'manifest', 'reserve', 'provider', 'auth', 'quote',
      'financial', 'quote-parser', 'financial-parser', 'complete', 'client-clear'
    ])
    assert.equal(harness.terminal.complete.length, 1)
    assert.equal(harness.terminal.fail.length, 0)
    const stored = harness.terminal.complete[0]
    assert.equal(stored.result.status, 'complete')
    assert.equal(stored.result.requestCount, 3)
    assert.equal(stored.quoteSnapshot.listingId, CASES[caseId].listingId)
    assert.equal(stored.quoteSnapshot.displayCode, CASES[caseId].displayCode)
    assert.equal(stored.financialPoints.length, 21)
    for (const point of stored.financialPoints) {
      assert.equal(new Date(point.fetchTime).toISOString(), new Date(CREATED_AT).toISOString(),
        `${caseId}: persistence uses the service clock`)
      assert.ok(new Date(point.sourceTime).getTime() <= CREATED_AT)
    }
    assert.equal(
      stored.financialPoints.every((point) =>
        /^20[0-9]{2}(?:Q[1-3]|H1|FY)$/.test(point.reportPeriod)),
      true,
      'persisted financial periods must use the repository canonical form'
    )
    assert.deepEqual(Object.keys(stored.quoteSnapshot), [
      'listingId', 'displayCode', 'latestPrice', 'previousClose', 'open',
      'high', 'low', 'volume', 'turnover', 'quoteTime', 'tradingStatus',
      'currency'
    ])
    assert.deepEqual(Object.keys(stored.financialPoints[0]), [
      'indicatorId', 'metricKey', 'reportPeriod', 'periodEnd', 'periodType',
      'value', 'availability', 'currency', 'unit', 'disclosureScope',
      'sourceTime', 'fetchTime'
    ])
    assert.equal(JSON.stringify(stored).includes('verification'), false)
    assertZeroed(harness.refreshTokens, 'refresh token was not cleared')
    assertZeroed(harness.accessTokens, 'access token was not cleared')
    assertZeroed(harness.rawBuffers, 'raw buffer was not cleared')
  }
}

async function testProductionCatalogFailsClosed() {
  for (const caseId of Object.keys(CASES)) {
    const harness = createHarness(caseId, {
      catalogLookup: getIfindMarketCase,
      manifestLookup: createLiveRequestManifestBundle
    })
    const result = await harness.service.run({ caseId })
    assertSafeFailure(result, {
      status: 'rejected',
      failureCode: 'IFIND_MARKET_CASE_UNVERIFIED',
      safeErrorClass: 'CONFIG',
      stage: 'catalog'
    })
    assert.deepEqual(harness.calls, [], `${caseId}: zero reservation, secret, or network access`)
  }
}

async function testUnbrandedBundleFailsClosed() {
  const harness = createHarness('HK_ALIBABA_9988', {
    manifestLookup: (caseId) => clone(strictManifestEvidence(caseId))
  })
  const result = await harness.service.run({ caseId: 'HK_ALIBABA_9988' })
  assert.equal(result.status, 'rejected')
  assert.equal(result.failureCode, 'IFIND_MARKET_CASE_UNVERIFIED')
  for (const operation of ['reserve', 'provider', 'auth', 'quote', 'financial']) {
    assert.equal(harness.calls.includes(operation), false, 'unbranded evidence: ' + operation)
  }
}

async function testCallerCannotOverrideFixedRequest() {
  const harness = createHarness()
  const result = await harness.service.run({
    caseId: 'HK_ALIBABA_9988',
    vendorCode: 'ATTACKER',
    endpoint: 'https://attacker.invalid',
    fields: ['ATTACKER_FIELD'],
    parser: () => ({ source: 'real' })
  })
  assertSafeFailure(result, {
    status: 'rejected',
    failureCode: 'IFIND_MARKET_CASE_ID_INVALID',
    safeErrorClass: 'CONFIG',
    stage: 'input'
  })
  assert.deepEqual(harness.calls, [])
}

async function testPartialFinancialAvailability() {
  const caseId = 'US_APPLE_AAPL'
  const harness = createHarness(caseId)
  harness.client.financial = async function financial(accessToken) {
    harness.calls.push('financial')
    assert.equal(Buffer.isBuffer(accessToken), true)
    return { payload: { errorcode: 0 }, requestCount: 1, dataVol: 0 }
  }
  harness.service = createIfindMarketDiagnosticService(harness.dependencies)
  const result = await harness.service.run({ caseId })
  assert.equal(result.status, 'partial')
  assert.equal(result.failureCode, 'IFIND_MARKET_FINANCIAL_UNAVAILABLE')
  assert.equal(harness.terminal.complete.length, 1)
  assert.equal(harness.terminal.complete[0].result.status, 'partial')
  assert.equal(harness.terminal.complete[0].quoteSnapshot.listingId, CASES[caseId].listingId)
  assert.deepEqual(harness.terminal.complete[0].financialPoints, [])
  assertZeroed(harness.refreshTokens, 'partial refresh token cleanup')
  assertZeroed(harness.accessTokens, 'partial access token cleanup')
}

async function testStageFailures() {
  const scenarios = [
    {
      label: 'auth failure',
      method: 'authenticate',
      error: safeClientError({
        code: 'IFIND_AUTH_REJECTED', errorClass: 'AUTH', stage: 'auth',
        vendorErrorCode: -401
      }),
      expectedCode: 'IFIND_AUTH_REJECTED',
      expectedClass: 'AUTH',
      expectedStage: 'auth',
      vendorErrorCode: -401,
      absent: ['quote', 'financial']
    },
    {
      label: 'quote timeout',
      method: 'quote',
      error: safeClientError(),
      expectedCode: 'IFIND_TIMEOUT',
      expectedClass: 'NETWORK',
      expectedStage: 'quote',
      absent: ['financial']
    },
    {
      label: 'quote rejection',
      method: 'quote',
      error: safeClientError({
        code: 'IFIND_QUOTE_REJECTED', errorClass: 'API', stage: 'quote',
        vendorErrorCode: 712
      }),
      expectedCode: 'IFIND_QUOTE_REJECTED',
      expectedClass: 'API',
      expectedStage: 'quote',
      vendorErrorCode: 712,
      absent: ['financial']
    }
  ]

  for (const scenario of scenarios) {
    const harness = createHarness()
    harness.client[scenario.method] = async function failStage() {
      harness.calls.push(scenario.method === 'authenticate' ? 'auth' : scenario.method)
      throw scenario.error
    }
    harness.service = createIfindMarketDiagnosticService(harness.dependencies)
    const result = await harness.service.run({ caseId: 'HK_ALIBABA_9988' })
    assertSafeFailure(result, {
      failureCode: scenario.expectedCode,
      safeErrorClass: scenario.expectedClass,
      stage: scenario.expectedStage,
      vendorErrorCode: scenario.vendorErrorCode
    })
    assert.equal(harness.terminal.fail.length, 1, scenario.label)
    assert.equal(harness.terminal.complete.length, 0, scenario.label)
    for (const call of scenario.absent) assert.equal(harness.calls.includes(call), false)
    assert.equal(harness.calls.at(-1), 'client-clear')
    assertZeroed(harness.refreshTokens, `${scenario.label} refresh cleanup`)
    assertZeroed(harness.accessTokens, `${scenario.label} access cleanup`)
  }
}

async function testFinancialFailureIsPersistedPartial() {
  const harness = createHarness()
  harness.client.financial = async function failFinancial() {
    harness.calls.push('financial')
    throw safeClientError({
      code: 'IFIND_FINANCIAL_REJECTED',
      errorClass: 'API',
      stage: 'financial',
      vendorErrorCode: 713
    })
  }
  harness.service = createIfindMarketDiagnosticService(harness.dependencies)
  const result = await harness.service.run({ caseId: 'HK_ALIBABA_9988' })
  assert.equal(result.status, 'partial')
  assert.equal(result.failureCode, 'IFIND_FINANCIAL_REJECTED')
  assert.equal(result.vendorErrorCode, 713)
  assert.equal(harness.terminal.complete.length, 1)
  assert.equal(harness.terminal.complete[0].result.status, 'partial')
  assert.equal(harness.terminal.complete[0].result.financeStatus, 'unavailable')
  assert.equal(harness.terminal.fail.length, 0)
  assert.equal(harness.calls.includes('financial-parser'), false)
  assert.equal(harness.calls.at(-1), 'client-clear')
}

async function testReservationRejections() {
  const scenarios = [
    ['busy', 'IFIND_MARKET_LEASE_CONFLICT', 'BUSY'],
    ['cooldown', 'IFIND_MARKET_COOLDOWN', 'RATE_LIMITED'],
    ['case-daily-limit', 'IFIND_MARKET_CASE_DAILY_LIMIT', 'RATE_LIMITED'],
    ['global-daily-limit', 'IFIND_MARKET_GLOBAL_DAILY_LIMIT', 'RATE_LIMITED']
  ]
  for (const [status, failureCode, safeErrorClass] of scenarios) {
    const harness = createHarness()
    harness.repository.reserve = function rejectReservation() {
      harness.calls.push('reserve')
      return {
        status,
        retryAt: CREATED_AT + 30_000,
        ...Object.fromEntries(Object.entries(quota('HK_ALIBABA_9988'))
          .filter(([key]) => key !== 'caseId')),
        inFlight: status === 'busy',
        inFlightCaseId: status === 'busy' ? 'US_APPLE_AAPL' : null,
        inFlightExpiresAt: status === 'busy' ? CREATED_AT + 30_000 : null
      }
    }
    harness.service = createIfindMarketDiagnosticService(harness.dependencies)
    const result = await harness.service.run({ caseId: 'HK_ALIBABA_9988' })
    assertSafeFailure(result, {
      status,
      failureCode,
      safeErrorClass,
      stage: 'reserve'
    })
    assert.equal(harness.calls.includes('provider'), false)
    assert.equal(harness.calls.includes('auth'), false)
    assert.equal(harness.calls.includes('client-clear'), false)
  }
}

async function testParserMismatchAndUnavailable() {
  const mismatched = createHarness()
  mismatched.dependencies.quoteParser = function mismatch(input) {
    mismatched.calls.push('quote-parser')
    return { ...parseIfindMarketQuote(input), caseId: 'US_APPLE_AAPL' }
  }
  mismatched.service = createIfindMarketDiagnosticService(mismatched.dependencies)
  const mismatchResult = await mismatched.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertSafeFailure(mismatchResult, {
    failureCode: 'IFIND_MARKET_QUOTE_UNAVAILABLE',
    safeErrorClass: 'RESPONSE_SHAPE',
    stage: 'quote-parser'
  })
  assert.equal(mismatched.terminal.fail.length, 1)
  assert.equal(mismatched.calls.at(-1), 'client-clear')

  const unavailable = createHarness()
  unavailable.dependencies.quoteParser = function unavailableQuote() {
    unavailable.calls.push('quote-parser')
    return {
      caseId: 'HK_ALIBABA_9988',
      listingId: 'listing-hkex-9988',
      displayCode: '9988.HK',
      latestPrice: null,
      previousClose: null,
      open: null,
      high: null,
      low: null,
      volume: null,
      turnover: null,
      quoteTime: null,
      tradingStatus: null,
      currency: null,
      source: 'unavailable',
      verification: { ...VERIFIED, sourceMode: 'failed' },
      missingFields: Object.keys(QUOTE_SUFFIXES)
    }
  }
  unavailable.service = createIfindMarketDiagnosticService(unavailable.dependencies)
  const unavailableResult = await unavailable.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertSafeFailure(unavailableResult, {
    failureCode: 'IFIND_MARKET_QUOTE_UNAVAILABLE',
    safeErrorClass: 'RESPONSE_SHAPE',
    stage: 'quote-parser'
  })
  assert.equal(unavailable.terminal.fail.length, 1)
  assert.equal(unavailable.calls.at(-1), 'client-clear')
}

async function testRepositoryFailureAndOriginalFailurePreservation() {
  const reserveFailure = createHarness()
  reserveFailure.repository.reserve = function failReserve() {
    reserveFailure.calls.push('reserve')
    throw new Error('sqlite message with token and RequestId')
  }
  reserveFailure.service = createIfindMarketDiagnosticService(reserveFailure.dependencies)
  const reserveResult = await reserveFailure.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertSafeFailure(reserveResult, {
    failureCode: 'IFIND_MARKET_REPOSITORY_FAILED',
    safeErrorClass: 'API',
    stage: 'repository'
  })
  assert.equal(reserveFailure.calls.includes('provider'), false)
  assert.equal(reserveFailure.calls.includes('client-clear'), false)

  const terminalFailure = createHarness()
  terminalFailure.client.quote = async function timeout() {
    terminalFailure.calls.push('quote')
    throw safeClientError()
  }
  terminalFailure.repository.fail = function cleanupFailure(input) {
    terminalFailure.calls.push('fail')
    terminalFailure.terminal.fail.push(input)
    throw new Error('cleanup repository failure')
  }
  terminalFailure.client.clear = function clearFailure() {
    terminalFailure.calls.push('client-clear')
    throw new Error('cleanup client failure')
  }
  terminalFailure.service = createIfindMarketDiagnosticService(terminalFailure.dependencies)
  const terminalResult = await terminalFailure.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertSafeFailure(terminalResult, {
    failureCode: 'IFIND_TIMEOUT',
    safeErrorClass: 'NETWORK',
    stage: 'quote'
  })
  assert.equal(terminalFailure.terminal.fail.length, 1)
  assert.equal(terminalFailure.calls.at(-1), 'client-clear')

  const completeFailure = createHarness()
  completeFailure.repository.complete = function failComplete() {
    completeFailure.calls.push('complete')
    throw new Error('atomic write failed')
  }
  completeFailure.service = createIfindMarketDiagnosticService(completeFailure.dependencies)
  const completeResult = await completeFailure.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertSafeFailure(completeResult, {
    failureCode: 'IFIND_MARKET_REPOSITORY_FAILED',
    safeErrorClass: 'API',
    stage: 'repository'
  })
  assert.equal(completeFailure.terminal.fail.length, 1)
  assert.equal(completeFailure.calls.at(-1), 'client-clear')
}

async function testRequestBudgetExhaustion() {
  const harness = createHarness()
  harness.client.financial = async function exhaustBudget(accessToken) {
    harness.calls.push('financial')
    assert.equal(Buffer.isBuffer(accessToken), true)
    return {
      payload: financialPayload('HK_ALIBABA_9988'),
      requestCount: 4,
      dataVol: 1
    }
  }
  harness.service = createIfindMarketDiagnosticService(harness.dependencies)
  const result = await harness.service.run({ caseId: 'HK_ALIBABA_9988' })
  assert.equal(result.status, 'partial')
  assert.equal(result.failureCode, 'IFIND_MARKET_CLIENT_CONTRACT_INVALID')
  assert.equal(result.requestCount, 3)
  assert.equal(harness.terminal.complete.length, 1)
  assert.equal(harness.terminal.complete[0].result.requestCount, 3)
  assert.deepEqual(
    harness.calls.filter((call) => ['auth', 'quote', 'financial'].includes(call)),
    ['auth', 'quote', 'financial']
  )
  assert.equal(
    harness.calls.filter((call) => ['auth', 'quote', 'financial'].includes(call)).length < 6,
    true,
    'a sixth transport operation must never be invoked'
  )
  assert.equal(harness.calls.includes('financial-parser'), false)
  assert.equal(harness.calls.at(-1), 'client-clear')
}

async function testMalformedAuthTokenIsAlwaysZeroed() {
  const harness = createHarness()
  const returnedAccessToken = Buffer.from('malformed-auth-access-token')
  Object.defineProperty(returnedAccessToken, 'fill', {
    configurable: true,
    value() { throw new Error('overridden fill must not run') }
  })
  harness.client.authenticate = async function malformedAuth() {
    harness.calls.push('auth')
    return { accessToken: returnedAccessToken, requestCount: 2 }
  }
  harness.client.clear = function failedClientCleanup() {
    harness.calls.push('client-clear')
    throw new Error('client cleanup failed')
  }
  harness.service = createIfindMarketDiagnosticService(harness.dependencies)

  const result = await harness.service.run({ caseId: 'HK_ALIBABA_9988' })

  assertSafeFailure(result, {
    failureCode: 'IFIND_MARKET_CLIENT_CONTRACT_INVALID',
    safeErrorClass: 'RESPONSE_SHAPE',
    stage: 'auth'
  })
  assert.equal(
    returnedAccessToken.equals(Buffer.alloc(returnedAccessToken.length)),
    true,
    'the original malformed auth token buffer must be zeroed'
  )
  assert.equal(harness.terminal.fail[0].result.requestCount, 1)
  assert.equal(harness.calls.at(-1), 'client-clear')

  const nonEnumerableHarness = createHarness()
  const nonEnumerableToken = Buffer.from('non-enumerable-access-token')
  nonEnumerableHarness.client.authenticate = async function malformedAuth() {
    nonEnumerableHarness.calls.push('auth')
    const output = { requestCount: 2 }
    Object.defineProperty(output, 'accessToken', {
      enumerable: false,
      value: nonEnumerableToken
    })
    return output
  }
  nonEnumerableHarness.client.clear = function failedClientCleanup() {
    nonEnumerableHarness.calls.push('client-clear')
    throw new Error('client cleanup failed')
  }
  nonEnumerableHarness.service = createIfindMarketDiagnosticService(
    nonEnumerableHarness.dependencies
  )
  const nonEnumerableResult = await nonEnumerableHarness.service.run({
    caseId: 'HK_ALIBABA_9988'
  })
  assertSafeFailure(nonEnumerableResult, {
    failureCode: 'IFIND_MARKET_CLIENT_OUTPUT_INVALID',
    safeErrorClass: 'RESPONSE_SHAPE',
    stage: 'auth'
  })
  assert.equal(nonEnumerableToken.equals(Buffer.alloc(nonEnumerableToken.length)), true)
}

async function testHostileNestedParserOutputsAreRejectedWithoutObservation() {
  const quoteHarness = createHarness()
  quoteHarness.dependencies.quoteParser = function hostileQuoteVerification(input) {
    quoteHarness.calls.push('quote-parser')
    const parsed = parseIfindMarketQuote(input)
    const verification = Object.assign(
      Object.create({ inheritedEvidence: 'must-not-cross' }),
      VERIFIED
    )
    return { ...parsed, verification }
  }
  quoteHarness.service = createIfindMarketDiagnosticService(quoteHarness.dependencies)
  const quoteResult = await quoteHarness.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertSafeFailure(quoteResult, {
    failureCode: 'IFIND_MARKET_QUOTE_UNAVAILABLE',
    safeErrorClass: 'RESPONSE_SHAPE',
    stage: 'quote-parser'
  })
  assert.equal(quoteHarness.terminal.complete.length, 0)
  assert.equal(quoteHarness.terminal.fail.length, 1)

  const proxyHarness = createHarness()
  let proxyTrapCount = 0
  proxyHarness.dependencies.financialParser = function proxiedPoints(input) {
    proxyHarness.calls.push('financial-parser')
    const parsed = parseIfindMarketFinancials(input)
    return {
      ...parsed,
      points: new Proxy([...parsed.points], {
        get(target, key, receiver) {
          proxyTrapCount += 1
          return Reflect.get(target, key, receiver)
        }
      })
    }
  }
  proxyHarness.service = createIfindMarketDiagnosticService(proxyHarness.dependencies)
  const proxyResult = await proxyHarness.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertQuotePreservingPartial(proxyHarness, proxyResult, {
    failureCode: 'IFIND_MARKET_FINANCIAL_UNAVAILABLE',
    safeErrorClass: 'RESPONSE_SHAPE',
    stage: 'financial-parser'
  })
  assert.equal(proxyTrapCount, 0, 'parser array proxy traps must not be invoked')

  const iteratorHarness = createHarness()
  let iteratorCallCount = 0
  iteratorHarness.dependencies.financialParser = function customIteratorPoints(input) {
    iteratorHarness.calls.push('financial-parser')
    const parsed = parseIfindMarketFinancials(input)
    const points = [...parsed.points]
    Object.defineProperty(points, Symbol.iterator, {
      value() {
        iteratorCallCount += 1
        return Array.prototype[Symbol.iterator].call(this)
      }
    })
    return { ...parsed, points }
  }
  iteratorHarness.service = createIfindMarketDiagnosticService(iteratorHarness.dependencies)
  const iteratorResult = await iteratorHarness.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertQuotePreservingPartial(iteratorHarness, iteratorResult, {
    failureCode: 'IFIND_MARKET_FINANCIAL_UNAVAILABLE',
    safeErrorClass: 'RESPONSE_SHAPE',
    stage: 'financial-parser'
  })
  assert.equal(iteratorCallCount, 0, 'custom parser iterators must not be invoked')

  const accessorHarness = createHarness()
  let accessorReadCount = 0
  accessorHarness.dependencies.financialParser = function accessorPoint(input) {
    accessorHarness.calls.push('financial-parser')
    const parsed = parseIfindMarketFinancials(input)
    const firstPoint = { ...parsed.points[0] }
    Object.defineProperty(firstPoint, 'value', {
      enumerable: true,
      get() {
        accessorReadCount += 1
        return 100
      }
    })
    return { ...parsed, points: [firstPoint, ...parsed.points.slice(1)] }
  }
  accessorHarness.service = createIfindMarketDiagnosticService(accessorHarness.dependencies)
  const accessorResult = await accessorHarness.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertQuotePreservingPartial(accessorHarness, accessorResult, {
    failureCode: 'IFIND_MARKET_FINANCIAL_UNAVAILABLE',
    safeErrorClass: 'RESPONSE_SHAPE',
    stage: 'financial-parser'
  })
  assert.equal(accessorReadCount, 0, 'nested parser accessors must not be invoked')

  const prototypeHarness = createHarness()
  prototypeHarness.dependencies.financialParser = function customArrayPrototype(input) {
    prototypeHarness.calls.push('financial-parser')
    const parsed = parseIfindMarketFinancials(input)
    const points = [...parsed.points]
    Object.setPrototypeOf(points, Object.create(Array.prototype))
    return { ...parsed, points }
  }
  prototypeHarness.service = createIfindMarketDiagnosticService(prototypeHarness.dependencies)
  const prototypeResult = await prototypeHarness.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertQuotePreservingPartial(prototypeHarness, prototypeResult, {
    failureCode: 'IFIND_MARKET_FINANCIAL_UNAVAILABLE',
    safeErrorClass: 'RESPONSE_SHAPE',
    stage: 'financial-parser'
  })

  const revokedHarness = createHarness()
  revokedHarness.dependencies.financialParser = function revokedArrayProxy(input) {
    revokedHarness.calls.push('financial-parser')
    const parsed = parseIfindMarketFinancials(input)
    const revocable = Proxy.revocable([...parsed.points], {})
    revocable.revoke()
    return { ...parsed, points: revocable.proxy }
  }
  revokedHarness.service = createIfindMarketDiagnosticService(revokedHarness.dependencies)
  const revokedResult = await revokedHarness.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertQuotePreservingPartial(revokedHarness, revokedResult, {
    failureCode: 'IFIND_MARKET_FINANCIAL_UNAVAILABLE',
    safeErrorClass: 'RESPONSE_SHAPE',
    stage: 'financial-parser'
  })
}

async function testOwnProtoKeyNeverReachesParsersOrPersistence() {
  const harness = createHarness()
  let parserObservedPayload = false
  harness.client.quote = async function ownProtoPayload() {
    harness.calls.push('quote')
    const payload = quotePayload('HK_ALIBABA_9988')
    Object.defineProperty(payload, '__proto__', {
      value: { inheritedProviderData: 'must-not-cross' },
      enumerable: true,
      configurable: true
    })
    return { payload, requestCount: 1, dataVol: 10 }
  }
  harness.dependencies.quoteParser = function observeQuoteParser(input) {
    parserObservedPayload = true
    harness.calls.push('quote-parser')
    return parseIfindMarketQuote(input)
  }
  harness.service = createIfindMarketDiagnosticService(harness.dependencies)

  const result = await harness.service.run({ caseId: 'HK_ALIBABA_9988' })

  assertSafeFailure(result, {
    failureCode: 'IFIND_MARKET_CLIENT_OUTPUT_INVALID',
    safeErrorClass: 'RESPONSE_SHAPE',
    stage: 'quote'
  })
  assert.equal(parserObservedPayload, false)
  assert.equal(harness.terminal.complete.length, 0)
  assert.equal(harness.terminal.fail.length, 1)
  assert.equal(
    JSON.stringify(harness.terminal.fail[0]).includes('inheritedProviderData'),
    false
  )
}

async function testInvalidNestedPersistedDatesAreRejected() {
  const quoteHarness = createHarness()
  quoteHarness.dependencies.quoteParser = function invalidQuoteDate(input) {
    quoteHarness.calls.push('quote-parser')
    return {
      ...parseIfindMarketQuote(input),
      quoteTime: '2026-02-30T12:00:00+08:00'
    }
  }
  quoteHarness.service = createIfindMarketDiagnosticService(quoteHarness.dependencies)
  const quoteResult = await quoteHarness.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertSafeFailure(quoteResult, {
    failureCode: 'IFIND_MARKET_QUOTE_UNAVAILABLE',
    safeErrorClass: 'RESPONSE_SHAPE',
    stage: 'quote-parser'
  })
  assert.equal(quoteHarness.terminal.complete.length, 0)

  const financialHarness = createHarness()
  financialHarness.dependencies.financialParser = function invalidReportDate(input) {
    financialHarness.calls.push('financial-parser')
    const parsed = parseIfindMarketFinancials(input)
    const points = parsed.points.map((point, index) => ({
      ...point,
      reportDate: index === 0 ? '2025-02-30' : point.reportDate
    }))
    return { ...parsed, points }
  }
  financialHarness.service = createIfindMarketDiagnosticService(financialHarness.dependencies)
  const financialResult = await financialHarness.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertQuotePreservingPartial(financialHarness, financialResult, {
    failureCode: 'IFIND_MARKET_FINANCIAL_UNAVAILABLE',
    safeErrorClass: 'RESPONSE_SHAPE',
    stage: 'financial-parser'
  })
}

async function testHostileProviderAndClientValues() {
  const providerProxy = createHarness()
  providerProxy.dependencies.secretProvider = {
    readRefreshToken() {
      providerProxy.calls.push('provider')
      return new Proxy(Buffer.from('refresh-token'), {})
    }
  }
  providerProxy.service = createIfindMarketDiagnosticService(providerProxy.dependencies)
  const providerResult = await providerProxy.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertSafeFailure(providerResult, {
    failureCode: 'IFIND_MARKET_SECRET_UNAVAILABLE',
    safeErrorClass: 'AUTH',
    stage: 'provider'
  })
  assert.equal(providerProxy.terminal.fail.length, 1)
  assert.equal(providerProxy.calls.includes('auth'), false)
  assert.equal(providerProxy.calls.at(-1), 'client-clear')

  const clientAccessor = createHarness()
  clientAccessor.client.quote = async function accessorOutput() {
    clientAccessor.calls.push('quote')
    const output = { requestCount: 1, dataVol: 1 }
    Object.defineProperty(output, 'payload', {
      enumerable: true,
      get() { throw new Error('unsafe accessor') }
    })
    return output
  }
  clientAccessor.service = createIfindMarketDiagnosticService(clientAccessor.dependencies)
  const clientResult = await clientAccessor.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertSafeFailure(clientResult, {
    failureCode: 'IFIND_MARKET_CLIENT_OUTPUT_INVALID',
    safeErrorClass: 'RESPONSE_SHAPE',
    stage: 'quote'
  })
  assert.equal(clientAccessor.terminal.fail.length, 1)
  assert.equal(clientAccessor.calls.includes('financial'), false)
  assert.equal(clientAccessor.calls.at(-1), 'client-clear')
}

async function testDirectProductionClientComposition() {
  const caseId = 'HK_ALIBABA_9988'
  const transport = createProductionTransport([
    { errorcode: 0, data: { access_token: 'production-contract-access-token' } },
    quotePayload(caseId),
    financialPayload(caseId)
  ])
  const productionClient = createIfindHttpClient({ request: transport.request })
  const harness = createHarness(caseId, { client: productionClient })

  const result = await harness.service.run({ caseId })

  assert.equal(result.status, 'complete')
  assert.equal(result.requestCount, 3)
  assert.deepEqual(
    transport.calls.map((call) => new URL(call.url).pathname),
    [
      '/api/v1/get_access_token',
      '/api/v1/real_time_quotation',
      '/api/v1/basic_data_service'
    ]
  )
  assert.equal(transport.calls.length, 3)
  assert.equal(harness.terminal.complete[0].result.requestCount, 3)
}

async function testFinancialRequestUsesOnlyManifestMetadataIds() {
  const caseId = 'HK_ALIBABA_9988'
  const catalog = strictLiveCatalog(caseId)
  const expectedMetadataIds = Object.keys(FINANCIAL_METADATA_SUFFIXES).map((field) => {
    const id = `FIXTURE_MANIFEST_METADATA_${field}`
    catalog.indicators.financialMetadata[field].vendorIndicatorId = id
    return id
  })
  catalog.requestTemplates.financial.indicatorIds = [
    ...catalog.indicators.financial.map((indicator) => indicator.vendorIndicatorId),
    ...expectedMetadataIds
  ]
  const originalEvidence = strictManifestEvidence(caseId)
  const evidence = createVerifiedMarketEvidenceBundle(catalog, {
    quoteVerification: originalEvidence.quoteVerification,
    financialVerification: originalEvidence.financialVerification,
    financialReportingCurrencyEvidence: originalEvidence.financialReportingCurrencyEvidence
  })
  const harness = createHarness(caseId, {
    catalogLookup: () => catalog,
    manifestLookup: () => evidence
  })
  harness.client.financial = async function inspectManifestRequest(accessToken, request) {
    harness.calls.push('financial')
    assert.equal(Buffer.isBuffer(accessToken), true)
    assert.deepEqual(
      request.indicatorIds,
      catalog.requestTemplates.financial.indicatorIds
    )
    assert.equal(request.indicatorIds.length, 14)
    assert.doesNotMatch(JSON.stringify(request.indicatorIds), /FETCH_TIME|SOURCE_MODE|fetchTime|sourceMode/)
    throw safeClientError({
      code: 'IFIND_FINANCIAL_REJECTED',
      errorClass: 'API',
      stage: 'financial',
      vendorErrorCode: 713
    })
  }
  harness.service = createIfindMarketDiagnosticService(harness.dependencies)

  const result = await harness.service.run({ caseId })

  assertQuotePreservingPartial(harness, result, {
    failureCode: 'IFIND_FINANCIAL_REJECTED',
    safeErrorClass: 'API',
    stage: 'financial',
    vendorErrorCode: 713
  })
}

async function testFinancialCompletionClockFailureAccountsResponse() {
  const caseId = 'HK_ALIBABA_9988'
  const recoveredAt = CREATED_AT + 1_000
  const completionClocks = [
    { label: 'NaN', value: NaN },
    { label: 'undefined', value: undefined },
    { label: 'after lease expiry', value: CREATED_AT + 30_001 },
    { label: 'before lease creation', value: CREATED_AT - 1 }
  ]
  const accounting = []

  for (const { label, value } of completionClocks) {
    let responseCompleted = false
    let completionClockRead = false
    const clockValues = []
    const harness = createHarness(caseId, {
      clock() {
        const timestamp = !responseCompleted
          ? CREATED_AT
          : completionClockRead ? recoveredAt : value
        if (responseCompleted) completionClockRead = true
        clockValues.push(timestamp)
        return timestamp
      }
    })
    const originalFinancial = harness.client.financial
    harness.client.financial = async function completedFinancialResponse(accessToken, request) {
      const response = await originalFinancial.call(this, accessToken, request)
      assert.equal(response.dataVol, 42, `${label}: successful financial response volume`)
      responseCompleted = true
      return response
    }
    harness.service = createIfindMarketDiagnosticService(harness.dependencies)

    const result = await harness.service.run({ caseId })

    assert.deepEqual(clockValues, [CREATED_AT, value, recoveredAt],
      `${label}: completion capture fails once, then settlement clock recovers`)
    assert.equal(result.status, 'partial', label)
    assert.equal(result.quoteStatus, 'available', label)
    assert.equal(result.financeStatus, 'unavailable', label)
    assert.equal(result.requestCount, 3, label)
    assert.equal(typeof result.failureCode, 'string', `${label}: capture failure is reported`)
    assert.equal(harness.calls.includes('financial-parser'), false,
      `${label}: financial parsing requires a trusted completion timestamp`)
    assert.equal(harness.terminal.complete.length, 1, label)
    assert.equal(harness.terminal.fail.length, 0, label)
    const stored = harness.terminal.complete[0]
    assert.equal(stored.result.status, 'partial', label)
    assert.equal(stored.result.quoteStatus, 'available', label)
    assert.equal(stored.result.financeStatus, 'unavailable', label)
    assert.equal(stored.result.completedAt, recoveredAt, label)
    assert.equal(stored.result.requestCount, 3, label)
    assert.equal(stored.result.failureCode, result.failureCode, label)
    assert.equal(stored.quoteSnapshot.listingId, CASES[caseId].listingId, label)
    assert.deepEqual(stored.financialPoints, [], `${label}: no financial point persistence`)
    assert.equal(harness.calls.at(-1), 'client-clear', label)
    assertZeroed(harness.refreshTokens, `${label}: refresh token cleanup`)
    assertZeroed(harness.accessTokens, `${label}: access token cleanup`)
    assertZeroed(harness.rawBuffers, `${label}: raw buffer cleanup`)
    accounting.push({ clock: label, dataVol: stored.result.dataVol })
  }

  assert.deepEqual(accounting, completionClocks.map(({ label }) => ({
    clock: label, dataVol: 52
  })), 'successful quote (10) and financial (42) responses both count when timestamp capture fails')
}

async function testExpiredLeaseCannotSettle() {
  let clockReads = 0
  const harness = createHarness('HK_ALIBABA_9988', {
    clock() {
      clockReads += 1
      return clockReads === 1 ? CREATED_AT : CREATED_AT + 30_001
    }
  })

  const result = await harness.service.run({ caseId: 'HK_ALIBABA_9988' })

  assertSafeFailure(result, {
    failureCode: 'IFIND_MARKET_LEASE_EXPIRED',
    safeErrorClass: 'API',
    stage: 'lease'
  })
  assert.equal(harness.terminal.complete.length, 0)
  assert.equal(harness.terminal.fail.length, 0)
  assert.equal(harness.calls.includes('complete'), false)
  assert.equal(harness.calls.includes('fail'), false)
  assert.equal(harness.calls.at(-1), 'client-clear')
}

async function testReservationCorrelationAndStableStatuses() {
  /** @type {[string, string | number][]} */
  const mismatches = [
    ['runId', 'market_run_ffffffffffffffffffffffff'],
    ['caseId', 'US_APPLE_AAPL'],
    ['createdAt', CREATED_AT + 1],
    ['tokenVersionId', 'v20260829-002'],
    ['leaseExpiresAt', CREATED_AT + 29_999]
  ]
  for (const [field, value] of mismatches) {
    const harness = createHarness()
    harness.repository.reserve = function mismatchedReservation(input) {
      harness.calls.push('reserve')
      return {
        status: 'reserved',
        reservation: { ...reservation(input.caseId), [field]: value },
        localDayKey: '2026-08-29',
        caseAttemptCount: 1,
        globalAttemptCount: 1
      }
    }
    harness.service = createIfindMarketDiagnosticService(harness.dependencies)
    const result = await harness.service.run({ caseId: 'HK_ALIBABA_9988' })
    assertSafeFailure(result, {
      failureCode: 'IFIND_MARKET_REPOSITORY_FAILED',
      safeErrorClass: 'API',
      stage: 'repository'
    })
    assert.equal(harness.calls.includes('provider'), false, field)
  }

  const statuses = [
    ['duplicate', 'IFIND_MARKET_RESERVATION_DUPLICATE', 'rejected'],
    ['clock-rollback', 'IFIND_MARKET_CLOCK_ROLLBACK', 'clock-rollback']
  ]
  for (const [status, failureCode, resultStatus] of statuses) {
    const harness = createHarness()
    harness.repository.reserve = function stableReservationStatus() {
      harness.calls.push('reserve')
      const snapshot = { ...quota('HK_ALIBABA_9988') }
      delete snapshot.caseId
      return { status, ...snapshot }
    }
    harness.service = createIfindMarketDiagnosticService(harness.dependencies)
    const result = await harness.service.run({ caseId: 'HK_ALIBABA_9988' })
    assertSafeFailure(result, {
      status: resultStatus,
      failureCode,
      safeErrorClass: 'CONFIG',
      stage: 'reserve'
    })
    assert.equal(harness.calls.includes('provider'), false)
  }
}

async function testExactFinancialParserBoundary() {
  const malformedCases = [
    ['one point', (parsed) => ({ ...parsed, points: [parsed.points[0]] })],
    ['duplicate identity', (parsed) => ({
      ...parsed,
      points: [...parsed.points.slice(0, -1), { ...parsed.points[0] }]
    })],
    ['wrong currency', (parsed) => ({
      ...parsed,
      points: parsed.points.map((point, index) => ({
        ...point,
        currency: index === 0 ? 'USD' : point.currency
      }))
    })],
    ['wrong indicator', (parsed) => ({
      ...parsed,
      points: parsed.points.map((point, index) => ({
        ...point,
        indicatorId: index === 0 ? 'TEST_ONLY_HK_WRONG' : point.indicatorId
      }))
    })],
    ['wrong scope', (parsed) => ({
      ...parsed,
      points: parsed.points.map((point, index) => ({
        ...point,
        disclosureScope: index === 0 ? 'standalone' : point.disclosureScope
      }))
    })],
    ['last point spoofs trusted fetch time', (parsed) => ({
      ...parsed,
      points: parsed.points.map((point, index) => ({
        ...point,
        fetchTime: index === parsed.points.length - 1
          ? new Date(CREATED_AT + 1).toISOString() : point.fetchTime
      }))
    })],
    ['same instant is not an exact trusted timestamp', (parsed) => ({
      ...parsed,
      points: parsed.points.map((point, index) => ({
        ...point,
        fetchTime: index === 0 ? '2026-08-29T04:00:00Z' : point.fetchTime
      }))
    })],
    ['missing parser fetch time', (parsed) => ({
      ...parsed,
      points: parsed.points.map((point, index) => ({
        ...point, fetchTime: index === 0 ? undefined : point.fetchTime
      }))
    })]
  ]

  for (const entry of malformedCases) {
    const [label, mutate] = /** @type {[string, (parsed: ReturnType<typeof parseIfindMarketFinancials>) => ReturnType<typeof parseIfindMarketFinancials>]} */ (entry)
    const harness = createHarness()
    harness.dependencies.financialParser = function malformedFinancial(input) {
      harness.calls.push('financial-parser')
      return mutate(parseIfindMarketFinancials(input))
    }
    harness.service = createIfindMarketDiagnosticService(harness.dependencies)
    const result = await harness.service.run({ caseId: 'HK_ALIBABA_9988' })
    assertQuotePreservingPartial(harness, result, {
      failureCode: 'IFIND_MARKET_FINANCIAL_UNAVAILABLE',
      safeErrorClass: 'RESPONSE_SHAPE',
      stage: 'financial-parser'
    })
    assert.equal(harness.calls.includes('complete'), true, label)
  }

  const explicitMissing = createHarness()
  explicitMissing.dependencies.financialParser = function partialValues(input) {
    explicitMissing.calls.push('financial-parser')
    const parsed = parseIfindMarketFinancials(input)
    return {
      ...parsed,
      points: parsed.points.map((point, index) => index === 0
        ? { ...point, value: null, availability: 'missing' }
        : { ...point })
    }
  }
  explicitMissing.service = createIfindMarketDiagnosticService(explicitMissing.dependencies)
  const missingResult = await explicitMissing.service.run({ caseId: 'HK_ALIBABA_9988' })
  assert.equal(missingResult.status, 'complete')
  assert.equal(explicitMissing.terminal.complete[0].financialPoints.length, 21)
  assert.equal(explicitMissing.terminal.complete[0].financialPoints[0].value, null)
  assert.equal(explicitMissing.terminal.complete[0].financialPoints[0].availability, 'missing')
}

async function testFinancialIdentityConflictFailsWholeRun() {
  const parserConflict = createHarness()
  parserConflict.dependencies.financialParser = function conflictingFinancialIdentity(input) {
    parserConflict.calls.push('financial-parser')
    return { ...parseIfindMarketFinancials(input), listingId: 'listing-nasdaq-aapl' }
  }
  parserConflict.service = createIfindMarketDiagnosticService(parserConflict.dependencies)
  const parserResult = await parserConflict.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertSafeFailure(parserResult, {
    failureCode: 'IFIND_MARKET_IDENTITY_CONFLICT',
    safeErrorClass: 'IDENTITY_CONFLICT',
    stage: 'financial-parser'
  })
  assert.equal(parserConflict.terminal.complete.length, 0)
  assert.equal(parserConflict.terminal.fail.length, 1)
}

async function testSharedSnapshotBudgetAndNullPrototype() {
  const budgetHarness = createHarness()
  let budgetParserCalled = false
  budgetHarness.client.quote = async function broadSiblingPayload() {
    budgetHarness.calls.push('quote')
    const payload = quotePayload('HK_ALIBABA_9988')
    payload.broad = {}
    for (let index = 0; index < 4096; index += 1) {
      payload.broad[`sibling${index}`] = { value: index }
    }
    return { payload, requestCount: 1, dataVol: 1 }
  }
  budgetHarness.dependencies.quoteParser = function mustNotParse(input) {
    budgetParserCalled = true
    return parseIfindMarketQuote(input)
  }
  budgetHarness.service = createIfindMarketDiagnosticService(budgetHarness.dependencies)
  const budgetResult = await budgetHarness.service.run({ caseId: 'HK_ALIBABA_9988' })
  assertSafeFailure(budgetResult, {
    failureCode: 'IFIND_MARKET_CLIENT_OUTPUT_INVALID',
    safeErrorClass: 'RESPONSE_SHAPE',
    stage: 'quote'
  })
  assert.equal(budgetParserCalled, false)

  const prototypeHarness = createHarness()
  prototypeHarness.dependencies.quoteParser = function observeSnapshot(input) {
    const parsed = parseIfindMarketQuote(input)
    return Object.assign(Object.create(null), parsed)
  }
  prototypeHarness.service = createIfindMarketDiagnosticService(prototypeHarness.dependencies)
  const prototypeResult = await prototypeHarness.service.run({ caseId: 'HK_ALIBABA_9988' })
  assert.equal(prototypeResult.status, 'complete')
}

async function run() {
  await testRepositoryReadersAreExposed()
  await testThreeMarketSuccess()
  await testFinancialCompletionClockFailureAccountsResponse()
  await testProductionCatalogFailsClosed()
  await testUnbrandedBundleFailsClosed()
  await testCallerCannotOverrideFixedRequest()
  await testPartialFinancialAvailability()
  await testStageFailures()
  await testFinancialFailureIsPersistedPartial()
  await testReservationRejections()
  await testParserMismatchAndUnavailable()
  await testRepositoryFailureAndOriginalFailurePreservation()
  await testRequestBudgetExhaustion()
  await testMalformedAuthTokenIsAlwaysZeroed()
  await testHostileNestedParserOutputsAreRejectedWithoutObservation()
  await testOwnProtoKeyNeverReachesParsersOrPersistence()
  await testInvalidNestedPersistedDatesAreRejected()
  await testHostileProviderAndClientValues()
  await testDirectProductionClientComposition()
  await testFinancialRequestUsesOnlyManifestMetadataIds()
  await testExpiredLeaseCannotSettle()
  await testReservationCorrelationAndStableStatuses()
  await testExactFinancialParserBoundary()
  await testFinancialIdentityConflictFailsWholeRun()
  await testSharedSnapshotBudgetAndNullPrototype()
}

module.exports = { run }
