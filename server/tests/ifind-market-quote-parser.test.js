'use strict'

const assert = require('node:assert/strict')

const { parseIfindMarketQuote } = require('../domain/ifind-market-quote-parser')
const hkFixture = require('./fixtures/ifind/hk-quote-success.json')
const usFixture = require('./fixtures/ifind/us-quote-success.json')
const cnFixture = require('./fixtures/ifind/cn-quote-success.json')

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

const CASES = Object.freeze({
  HK_ALIBABA_9988: Object.freeze({
    fixture: hkFixture,
    listingId: 'listing-hkex-9988',
    displayCode: '9988.HK',
    prefix: 'TEST_ONLY_HK_',
    values: Object.freeze({
      latestPrice: 101.25,
      previousClose: 100,
      open: 100.5,
      high: 102,
      low: 99.75,
      volume: 0,
      turnover: 123456.75,
      quoteTime: '2026-08-29 15:59:00',
      tradingStatus: 'TRADING',
      currency: 'HKD'
    }),
    expectedTime: '2026-08-29T15:59:00+08:00',
    expectedStatus: 'trading'
  }),
  US_APPLE_AAPL: Object.freeze({
    fixture: usFixture,
    listingId: 'listing-nasdaq-aapl',
    displayCode: 'AAPL.US',
    prefix: 'TEST_ONLY_US_',
    values: Object.freeze({
      latestPrice: 202.5,
      previousClose: 201.25,
      open: 201.5,
      high: 203,
      low: 200.75,
      volume: 1234,
      turnover: 249999.5,
      quoteTime: '08/29/2026 15:59:00 EDT',
      tradingStatus: 'REGULAR',
      currency: 'USD'
    }),
    expectedTime: '2026-08-29T15:59:00-04:00',
    expectedStatus: 'trading'
  }),
  CN_MOUTAI_600519: Object.freeze({
    fixture: cnFixture,
    listingId: 'listing-sse-600519',
    displayCode: '600519.SH',
    prefix: 'TEST_ONLY_CN_',
    values: Object.freeze({
      latestPrice: 303.75,
      previousClose: 300,
      open: 301,
      high: 305,
      low: 299.5,
      volume: 5678,
      turnover: 1725000,
      quoteTime: '20260829145900',
      tradingStatus: 'TRADE',
      currency: 'CNY'
    }),
    expectedTime: '2026-08-29T14:59:00+08:00',
    expectedStatus: 'trading'
  })
})

const FIELD_SUFFIXES = Object.freeze({
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

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function completePayload(caseId) {
  const definition = CASES[caseId]
  const payload = clone(definition.fixture)
  const table = payload.tables[0].table
  for (const [field, suffix] of Object.entries(FIELD_SUFFIXES)) {
    table[`${definition.prefix}${suffix}`] = [definition.values[field]]
  }
  payload.dataVol = Object.keys(FIELD_SUFFIXES).length
  return payload
}

function parse(caseId, payload = completePayload(caseId), verification = VERIFIED) {
  return parseIfindMarketQuote({ caseId, payload, verification })
}

function fieldId(caseId, field) {
  return `${CASES[caseId].prefix}${FIELD_SUFFIXES[field]}`
}

function assertUnavailable(result) {
  assert.equal(result.source, 'unavailable')
  for (const field of [
    'latestPrice',
    'previousClose',
    'open',
    'high',
    'low',
    'volume',
    'turnover',
    'quoteTime',
    'tradingStatus',
    'currency'
  ]) {
    assert.equal(result[field], null)
  }
  assert.notEqual(result.verification.sourceMode, 'real')
  assert.equal(JSON.stringify(result).includes('Mock'), false)
}

function assertDeepFrozen(value) {
  assert.equal(Object.isFrozen(value), true)
  if (!value || typeof value !== 'object') return
  for (const nested of Object.values(value)) assertDeepFrozen(nested)
}

async function run() {
  for (const [caseId, definition] of Object.entries(CASES)) {
    const result = parse(caseId)
    assert.deepEqual(Object.keys(result), [
      'caseId',
      'listingId',
      'displayCode',
      'latestPrice',
      'previousClose',
      'open',
      'high',
      'low',
      'volume',
      'turnover',
      'quoteTime',
      'tradingStatus',
      'currency',
      'source',
      'verification',
      'missingFields'
    ])
    assert.deepEqual(result, {
      caseId,
      listingId: definition.listingId,
      displayCode: definition.displayCode,
      latestPrice: definition.values.latestPrice,
      previousClose: definition.values.previousClose,
      open: definition.values.open,
      high: definition.values.high,
      low: definition.values.low,
      volume: definition.values.volume,
      turnover: definition.values.turnover,
      quoteTime: definition.expectedTime,
      tradingStatus: definition.expectedStatus,
      currency: definition.values.currency,
      source: 'real',
      verification: VERIFIED,
      missingFields: []
    })
    assertDeepFrozen(result)
  }

  const statusCases = [
    ['HK_ALIBABA_9988', 'SUSPENDED', 'suspended'],
    ['HK_ALIBABA_9988', 'CLOSED', 'closed'],
    ['US_APPLE_AAPL', 'HALTED', 'suspended'],
    ['US_APPLE_AAPL', 'CLOSED', 'closed'],
    ['CN_MOUTAI_600519', 'SUSPEND', 'suspended'],
    ['CN_MOUTAI_600519', 'CLOSE', 'closed']
  ]
  for (const [caseId, providerStatus, expectedStatus] of statusCases) {
    const payload = completePayload(caseId)
    payload.tables[0].table[fieldId(caseId, 'tradingStatus')] = [providerStatus]
    assert.equal(parse(caseId, payload).tradingStatus, expectedStatus)
  }

  const preMarket = completePayload('US_APPLE_AAPL')
  preMarket.tables[0].table[fieldId('US_APPLE_AAPL', 'tradingStatus')] = ['PRE_MARKET']
  assertUnavailable(parse('US_APPLE_AAPL', preMarket))

  for (const caseId of Object.keys(CASES)) {
    const withoutCurrency = completePayload(caseId)
    delete withoutCurrency.tables[0].table[fieldId(caseId, 'currency')]
    const unavailable = parse(caseId, withoutCurrency)
    assertUnavailable(unavailable)
    assert.equal(unavailable.currency, null)
    assert.equal(unavailable.missingFields.includes('currency'), true)
    assert.equal(unavailable.verification.currencyStatus, 'failed')
  }

  const zeroPayload = completePayload('HK_ALIBABA_9988')
  for (const field of ['latestPrice', 'previousClose', 'open', 'high', 'low', 'volume', 'turnover']) {
    zeroPayload.tables[0].table[fieldId('HK_ALIBABA_9988', field)] = [0]
  }
  const zeros = parse('HK_ALIBABA_9988', zeroPayload)
  assert.equal(zeros.source, 'real')
  assert.deepEqual(
    [zeros.latestPrice, zeros.previousClose, zeros.open, zeros.high, zeros.low, zeros.volume, zeros.turnover],
    [0, 0, 0, 0, 0, 0, 0]
  )

  for (const invalidNumber of [NaN, Infinity, -Infinity, '0', '', null]) {
    const invalidPayload = completePayload('US_APPLE_AAPL')
    invalidPayload.tables[0].table[fieldId('US_APPLE_AAPL', 'latestPrice')] = [invalidNumber]
    const unavailable = parse('US_APPLE_AAPL', invalidPayload)
    assertUnavailable(unavailable)
    assert.equal(unavailable.missingFields.includes('latestPrice'), true)
  }

  const missingPrice = completePayload('CN_MOUTAI_600519')
  delete missingPrice.tables[0].table[fieldId('CN_MOUTAI_600519', 'previousClose')]
  const missingPriceResult = parse('CN_MOUTAI_600519', missingPrice)
  assertUnavailable(missingPriceResult)
  assert.deepEqual(missingPriceResult.missingFields, ['previousClose'])

  const invalidTime = completePayload('HK_ALIBABA_9988')
  invalidTime.tables[0].table[fieldId('HK_ALIBABA_9988', 'quoteTime')] = ['2026-02-30 15:59:00']
  assertUnavailable(parse('HK_ALIBABA_9988', invalidTime))

  const duplicateSecurities = completePayload('HK_ALIBABA_9988')
  duplicateSecurities.tables.push(clone(duplicateSecurities.tables[0]))
  const duplicateResult = parse('HK_ALIBABA_9988', duplicateSecurities)
  assertUnavailable(duplicateResult)
  assert.equal(duplicateResult.verification.scopeStatus, 'failed')

  const wrongCode = completePayload('US_APPLE_AAPL')
  wrongCode.tables[0].thscode = 'TEST_ONLY_WRONG_CODE'
  const wrongCodeResult = parse('US_APPLE_AAPL', wrongCode)
  assertUnavailable(wrongCodeResult)
  assert.equal(wrongCodeResult.verification.vendorCodeStatus, 'failed')

  const mixedSource = completePayload('CN_MOUTAI_600519')
  mixedSource.tables[0].table.TEST_ONLY_US_LATEST_PRICE = [999]
  const mixedResult = parse('CN_MOUTAI_600519', mixedSource)
  assertUnavailable(mixedResult)
  assert.equal(mixedResult.verification.scopeStatus, 'failed')
  assert.equal(JSON.stringify(mixedResult).includes('TEST_ONLY_US_LATEST_PRICE'), false)

  const unverified = parse('HK_ALIBABA_9988', completePayload('HK_ALIBABA_9988'), {
    ...VERIFIED,
    entitlementStatus: 'unverified',
    sourceMode: 'unverified'
  })
  assertUnavailable(unverified)
  assert.equal(unverified.verification.entitlementStatus, 'unverified')

  const failedPayload = completePayload('HK_ALIBABA_9988')
  failedPayload.errorcode = -403
  failedPayload.errmsg = 'raw provider entitlement message'
  const failed = parse('HK_ALIBABA_9988', failedPayload)
  assertUnavailable(failed)
  assert.equal(failed.verification.entitlementStatus, 'failed')
  assert.equal(JSON.stringify(failed).includes('raw provider entitlement message'), false)

  let inheritedRead = false
  const inheritedPayload = Object.create({
    get tables() {
      inheritedRead = true
      throw new Error('inherited payload getter executed')
    }
  })
  inheritedPayload.errorcode = 0
  inheritedPayload.dataVol = 10
  assertUnavailable(parse('HK_ALIBABA_9988', inheritedPayload))
  assert.equal(inheritedRead, false)

  let accessorRead = false
  const accessorPayload = completePayload('US_APPLE_AAPL')
  Object.defineProperty(accessorPayload.tables[0].table, fieldId('US_APPLE_AAPL', 'latestPrice'), {
    enumerable: true,
    get() {
      accessorRead = true
      throw new Error('provider accessor executed')
    }
  })
  assertUnavailable(parse('US_APPLE_AAPL', accessorPayload))
  assert.equal(accessorRead, false)

  let proxyRead = false
  const proxyPayload = new Proxy(completePayload('CN_MOUTAI_600519'), {
    get() {
      proxyRead = true
      throw new Error('provider proxy executed')
    },
    getPrototypeOf() {
      proxyRead = true
      throw new Error('provider proxy prototype trap executed')
    },
    ownKeys() {
      proxyRead = true
      throw new Error('provider proxy ownKeys trap executed')
    }
  })
  assertUnavailable(parse('CN_MOUTAI_600519', proxyPayload))
  assert.equal(proxyRead, false)

  let mappingRead = false
  const arbitraryMappingInput = {
    caseId: 'HK_ALIBABA_9988',
    payload: completePayload('HK_ALIBABA_9988'),
    verification: VERIFIED
  }
  Object.defineProperty(arbitraryMappingInput, 'fieldMapping', {
    enumerable: true,
    get() {
      mappingRead = true
      throw new Error('arbitrary field mapping executed')
    }
  })
  assertUnavailable(parseIfindMarketQuote(arbitraryMappingInput))
  assert.equal(mappingRead, false)

  const unknownCase = parseIfindMarketQuote({
    caseId: 'HK_UNKNOWN_0000',
    payload: completePayload('HK_ALIBABA_9988'),
    verification: VERIFIED
  })
  assertUnavailable(unknownCase)
  assert.equal(unknownCase.caseId, null)

  const frozen = parse('US_APPLE_AAPL')
  assert.throws(() => { frozen.latestPrice = 1 }, TypeError)
  assert.throws(() => { frozen.verification.scopeStatus = 'failed' }, TypeError)
  assert.throws(() => { frozen.missingFields.push('rawProviderMetadata') }, TypeError)
  assert.deepEqual(Object.keys(frozen), Object.keys(parse('US_APPLE_AAPL')))
  assert.doesNotMatch(JSON.stringify(frozen), /thscode|dataVol|TEST_ONLY|errmsg|RequestId/i)
}

module.exports = { run }
