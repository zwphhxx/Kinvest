'use strict'

const assert = require('node:assert/strict')

const {
  createIfindMarketDiagnosticService
} = require('../services/ifind-market-diagnostic-service')
const {
  createLiveRequestManifest,
  getIfindMarketCase
} = require('../domain/ifind-market-cases')
const { parseIfindMarketQuote } = require('../domain/ifind-market-quote-parser')
const { parseIfindMarketFinancials } = require('../domain/ifind-market-financial-parser')

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
        indicatorIds: financialIndicators.map((indicator) => indicator.vendorIndicatorId),
        evidenceStatus: 'verified'
      }
    },
    indicators: { quote: quoteIndicators, financial: financialIndicators },
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
  return {
    manifest: {
      caseId,
      vendorCode: catalog.vendorCodes.ifind.code,
      requestTemplates: clone(catalog.requestTemplates),
      indicators: clone(catalog.indicators),
      periodRules: clone(catalog.periodRules),
      parserId: catalog.parserId
    },
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
  }
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
  table[metadataId(definition, 'FETCH_TIME')] = definition.periods.map(() => '2025-12-01T12:00:00.000Z')
  table[metadataId(definition, 'SOURCE_MODE')] = definition.periods.map(() => 'real')
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
    }
  }

  const client = {
    async authenticate(input) {
      calls.push('auth')
      assert.deepEqual(Object.keys(input), ['refreshToken', 'requestBudget'])
      assert.equal(input.requestBudget, 1)
      assert.equal(Buffer.isBuffer(input.refreshToken), true)
      const accessToken = Buffer.from('access-token')
      accessTokens.push(accessToken)
      return { accessToken, requestCount: 1 }
    },
    async quote(input) {
      calls.push('quote')
      assert.deepEqual(Object.keys(input), ['accessToken', 'request', 'requestBudget'])
      assert.equal(input.requestBudget, 1)
      assert.equal(Object.isFrozen(input), true)
      assert.deepEqual(input.request, {
        vendorCode: CASES[caseId].vendorCode,
        fields: Object.keys(QUOTE_SUFFIXES).map((metric) => quoteId(CASES[caseId], metric))
      })
      const raw = Buffer.from('raw-quote')
      rawBuffers.push(raw)
      return { payload: quotePayload(caseId), requestCount: 1, dataVol: 10 }
    },
    async financial(input) {
      calls.push('financial')
      assert.deepEqual(Object.keys(input), ['accessToken', 'request', 'requestBudget'])
      assert.equal(input.requestBudget, 3)
      assert.equal(Object.isFrozen(input), true)
      assert.deepEqual(input.request, {
        vendorCode: CASES[caseId].vendorCode,
        indicatorIds: Object.keys(FINANCIAL_SUFFIXES).map((metric) =>
          financialId(CASES[caseId], metric)),
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
  const caseId = 'HK_ALIBABA_9988'
  const harness = createHarness(caseId, {
    catalogLookup: getIfindMarketCase,
    manifestLookup(value) {
      return {
        manifest: createLiveRequestManifest(value),
        quoteVerification: clone(VERIFIED),
        financialVerification: clone(VERIFIED),
        financialReportingCurrencyEvidence: {}
      }
    }
  })
  const result = await harness.service.run({ caseId })
  assertSafeFailure(result, {
    status: 'rejected',
    failureCode: 'IFIND_MARKET_CASE_UNVERIFIED',
    safeErrorClass: 'CONFIG',
    stage: 'catalog'
  })
  assert.equal(harness.calls.includes('reserve'), false)
  assert.equal(harness.calls.includes('provider'), false)
  assert.equal(harness.calls.includes('auth'), false)
  assert.deepEqual(harness.calls, ['client-clear'])
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
  assert.deepEqual(harness.calls, ['client-clear'])
}

async function testPartialFinancialAvailability() {
  const caseId = 'US_APPLE_AAPL'
  const harness = createHarness(caseId)
  harness.client.financial = async function financial(input) {
    harness.calls.push('financial')
    assert.equal(input.requestBudget, 3)
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
    assert.equal(harness.calls.at(-1), 'client-clear')
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
  assert.equal(reserveFailure.calls.at(-1), 'client-clear')

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
  harness.client.financial = async function exhaustBudget(input) {
    harness.calls.push('financial')
    assert.equal(input.requestBudget, 3)
    return {
      payload: financialPayload('HK_ALIBABA_9988'),
      requestCount: 4,
      dataVol: 1
    }
  }
  harness.service = createIfindMarketDiagnosticService(harness.dependencies)
  const result = await harness.service.run({ caseId: 'HK_ALIBABA_9988' })
  assert.equal(result.status, 'partial')
  assert.equal(result.failureCode, 'IFIND_MARKET_REQUEST_BUDGET_EXHAUSTED')
  assert.equal(result.requestCount, 5)
  assert.equal(harness.terminal.complete.length, 1)
  assert.equal(harness.terminal.complete[0].result.requestCount, 5)
  assert.equal(harness.calls.includes('financial-parser'), false)
  assert.equal(harness.calls.at(-1), 'client-clear')
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

async function run() {
  await testThreeMarketSuccess()
  await testProductionCatalogFailsClosed()
  await testCallerCannotOverrideFixedRequest()
  await testPartialFinancialAvailability()
  await testStageFailures()
  await testFinancialFailureIsPersistedPartial()
  await testReservationRejections()
  await testParserMismatchAndUnavailable()
  await testRepositoryFailureAndOriginalFailurePreservation()
  await testRequestBudgetExhaustion()
  await testHostileProviderAndClientValues()
}

module.exports = { run }
