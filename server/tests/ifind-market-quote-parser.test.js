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

const NUMERIC_TEST_FIELDS = Object.freeze([
  'latestPrice',
  'previousClose',
  'open',
  'high',
  'low',
  'volume',
  'turnover'
])

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

function labeledScenario(label, operation) {
  try {
    operation()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`[${label}] ${message}`, { cause: error })
  }
}

function labeledTable(group, rows, operation) {
  for (const [label, ...values] of rows) {
    labeledScenario(`${group}: ${label}`, () => operation(...values))
  }
}

async function run() {
  labeledTable(
    'normalization',
    Object.entries(CASES).map(([caseId, definition]) => [caseId, caseId, definition]),
    (caseId, definition) => {
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
  )

  labeledTable('trading states', [
    ['HK suspended', 'HK_ALIBABA_9988', 'SUSPENDED', 'suspended'],
    ['HK closed', 'HK_ALIBABA_9988', 'CLOSED', 'closed'],
    ['US halted', 'US_APPLE_AAPL', 'HALTED', 'suspended'],
    ['US closed', 'US_APPLE_AAPL', 'CLOSED', 'closed'],
    ['CN suspended', 'CN_MOUTAI_600519', 'SUSPEND', 'suspended'],
    ['CN closed', 'CN_MOUTAI_600519', 'CLOSE', 'closed']
  ], (caseId, providerStatus, expectedStatus) => {
    const payload = completePayload(caseId)
    payload.tables[0].table[fieldId(caseId, 'tradingStatus')] = [providerStatus]
    assert.equal(parse(caseId, payload).tradingStatus, expectedStatus)
  })

  labeledScenario('trading states: US pre-market excluded', () => {
    const payload = completePayload('US_APPLE_AAPL')
    payload.tables[0].table[fieldId('US_APPLE_AAPL', 'tradingStatus')] = ['PRE_MARKET']
    assertUnavailable(parse('US_APPLE_AAPL', payload))
  })

  labeledTable(
    'currency absence',
    Object.keys(CASES).map((caseId) => [caseId, caseId]),
    (caseId) => {
      const payload = completePayload(caseId)
      delete payload.tables[0].table[fieldId(caseId, 'currency')]
      const result = parse(caseId, payload)
      assertUnavailable(result)
      assert.equal(result.missingFields.includes('currency'), true)
      assert.equal(result.verification.currencyStatus, 'failed')
    }
  )

  labeledScenario('numeric validation: zero preserved', () => {
    const payload = completePayload('HK_ALIBABA_9988')
    for (const field of NUMERIC_TEST_FIELDS) {
      payload.tables[0].table[fieldId('HK_ALIBABA_9988', field)] = [0]
    }
    const result = parse('HK_ALIBABA_9988', payload)
    assert.equal(result.source, 'real')
    assert.deepEqual(NUMERIC_TEST_FIELDS.map((field) => result[field]), [0, 0, 0, 0, 0, 0, 0])
  })

  labeledTable('numeric validation', [
    ['NaN', NaN],
    ['positive infinity', Infinity],
    ['negative infinity', -Infinity],
    ['numeric string', '0'],
    ['empty string', ''],
    ['null', null]
  ], (invalidNumber) => {
    const payload = completePayload('US_APPLE_AAPL')
    payload.tables[0].table[fieldId('US_APPLE_AAPL', 'latestPrice')] = [invalidNumber]
    const result = parse('US_APPLE_AAPL', payload)
    assertUnavailable(result)
    assert.equal(result.missingFields.includes('latestPrice'), true)
  })

  labeledScenario('missing fields: previous close', () => {
    const payload = completePayload('CN_MOUTAI_600519')
    delete payload.tables[0].table[fieldId('CN_MOUTAI_600519', 'previousClose')]
    const result = parse('CN_MOUTAI_600519', payload)
    assertUnavailable(result)
    assert.deepEqual(result.missingFields, ['previousClose'])
  })

  labeledScenario('timestamp validation: impossible HK date', () => {
    const payload = completePayload('HK_ALIBABA_9988')
    payload.tables[0].table[fieldId('HK_ALIBABA_9988', 'quoteTime')] = ['2026-02-30 15:59:00']
    assertUnavailable(parse('HK_ALIBABA_9988', payload))
  })

  labeledTable('dataVol contract', [
    ['zero', 0],
    ['under contract', 9],
    ['over contract', 11]
  ], (dataVol) => {
    const payload = completePayload('HK_ALIBABA_9988')
    payload.dataVol = dataVol
    const result = parse('HK_ALIBABA_9988', payload)
    assertUnavailable(result)
    assert.equal(result.verification.scopeStatus, 'failed')
  })

  labeledScenario('dataVol contract: absent accepted', () => {
    const payload = completePayload('HK_ALIBABA_9988')
    delete payload.dataVol
    assert.equal(parse('HK_ALIBABA_9988', payload).source, 'real')
  })

  labeledScenario('source integrity: duplicate securities', () => {
    const payload = completePayload('HK_ALIBABA_9988')
    payload.tables.push(clone(payload.tables[0]))
    const result = parse('HK_ALIBABA_9988', payload)
    assertUnavailable(result)
    assert.equal(result.verification.scopeStatus, 'failed')
  })

  labeledScenario('source integrity: wrong vendor code', () => {
    const payload = completePayload('US_APPLE_AAPL')
    payload.tables[0].thscode = 'TEST_ONLY_WRONG_CODE'
    const result = parse('US_APPLE_AAPL', payload)
    assertUnavailable(result)
    assert.equal(result.verification.vendorCodeStatus, 'failed')
  })

  labeledScenario('source integrity: mixed metadata projected out', () => {
    const payload = completePayload('CN_MOUTAI_600519')
    payload.tables[0].table.TEST_ONLY_US_LATEST_PRICE = [999]
    const result = parse('CN_MOUTAI_600519', payload)
    assert.equal(result.source, 'real')
    assert.equal(JSON.stringify(result).includes('TEST_ONLY_US_LATEST_PRICE'), false)
  })

  labeledScenario('verification gate: unverified entitlement', () => {
    const result = parse('HK_ALIBABA_9988', completePayload('HK_ALIBABA_9988'), {
      ...VERIFIED,
      entitlementStatus: 'unverified',
      sourceMode: 'unverified'
    })
    assertUnavailable(result)
    assert.equal(result.verification.entitlementStatus, 'unverified')
  })

  labeledScenario('provider failure: message sanitized', () => {
    const payload = completePayload('HK_ALIBABA_9988')
    payload.errorcode = -403
    payload.errmsg = 'raw provider entitlement message'
    const result = parse('HK_ALIBABA_9988', payload)
    assertUnavailable(result)
    assert.equal(result.verification.entitlementStatus, 'failed')
    assert.equal(JSON.stringify(result).includes('raw provider entitlement message'), false)
  })

  labeledScenario('untrusted records: inherited getter', () => {
    let inheritedRead = false
    const payload = Object.create({
      get tables() {
        inheritedRead = true
        throw new Error('inherited payload getter executed')
      }
    })
    payload.errorcode = 0
    payload.dataVol = 10
    assertUnavailable(parse('HK_ALIBABA_9988', payload))
    assert.equal(inheritedRead, false)
  })

  labeledScenario('untrusted records: own accessor', () => {
    let accessorRead = false
    const payload = completePayload('US_APPLE_AAPL')
    Object.defineProperty(payload.tables[0].table, fieldId('US_APPLE_AAPL', 'latestPrice'), {
      enumerable: true,
      get() {
        accessorRead = true
        throw new Error('provider accessor executed')
      }
    })
    assertUnavailable(parse('US_APPLE_AAPL', payload))
    assert.equal(accessorRead, false)
  })

  labeledScenario('untrusted records: active proxy traps', () => {
    let proxyRead = false
    const payload = new Proxy(completePayload('CN_MOUTAI_600519'), {
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
    assertUnavailable(parse('CN_MOUTAI_600519', payload))
    assert.equal(proxyRead, false)
  })

  labeledScenario('untrusted records: revoked object proxy', () => {
    const revocable = Proxy.revocable(completePayload('HK_ALIBABA_9988'), {})
    revocable.revoke()
    assertUnavailable(parse('HK_ALIBABA_9988', revocable.proxy))
  })

  labeledScenario('untrusted records: revoked array proxy', () => {
    const payload = completePayload('US_APPLE_AAPL')
    const revocable = Proxy.revocable(payload.tables, {})
    payload.tables = revocable.proxy
    revocable.revoke()
    assertUnavailable(parse('US_APPLE_AAPL', payload))
  })

  labeledScenario('untrusted records: arbitrary field mapping rejected', () => {
    let mappingRead = false
    const input = {
      caseId: 'HK_ALIBABA_9988',
      payload: completePayload('HK_ALIBABA_9988'),
      verification: VERIFIED
    }
    Object.defineProperty(input, 'fieldMapping', {
      enumerable: true,
      get() {
        mappingRead = true
        throw new Error('arbitrary field mapping executed')
      }
    })
    assertUnavailable(parseIfindMarketQuote(input))
    assert.equal(mappingRead, false)
  })

  labeledScenario('untrusted records: unknown fixed case', () => {
    const result = parseIfindMarketQuote({
      caseId: 'HK_UNKNOWN_0000',
      payload: completePayload('HK_ALIBABA_9988'),
      verification: VERIFIED
    })
    assertUnavailable(result)
    assert.equal(result.caseId, null)
  })

  labeledScenario('bounded traversal: oversized metadata projected out', () => {
    const payload = completePayload('CN_MOUTAI_600519')
    const providerFields = payload.tables[0].table
    const marker = 'OVERSIZED_UNTRUSTED_METADATA'
    for (let index = 0; index < 4096; index += 1) {
      providerFields[`${marker}_${index}`] = index
    }
    let metadataRead = false
    Object.defineProperty(providerFields, `${marker}_ACCESSOR`, {
      enumerable: true,
      get() {
        metadataRead = true
        throw new Error('oversized metadata accessor executed')
      }
    })

    const originalDescriptors = Object.getOwnPropertyDescriptors
    const originalSymbols = Object.getOwnPropertySymbols
    let wholeRecordReflectionCalls = 0
    Object.getOwnPropertyDescriptors = () => {
      wholeRecordReflectionCalls += 1
      throw new Error('whole-record descriptor traversal attempted')
    }
    Object.getOwnPropertySymbols = () => {
      wholeRecordReflectionCalls += 1
      throw new Error('whole-record symbol traversal attempted')
    }
    let result
    try {
      result = parse('CN_MOUTAI_600519', payload)
    } finally {
      Object.getOwnPropertyDescriptors = originalDescriptors
      Object.getOwnPropertySymbols = originalSymbols
    }
    assert.equal(result.source, 'real')
    assert.equal(metadataRead, false)
    assert.equal(wholeRecordReflectionCalls, 0)
    assert.equal(JSON.stringify(result).includes(marker), false)
  })

  labeledScenario('defensive output: deeply frozen and metadata-free', () => {
    const result = parse('US_APPLE_AAPL')
    assert.throws(() => { result.latestPrice = 1 }, TypeError)
    assert.throws(() => { result.verification.scopeStatus = 'failed' }, TypeError)
    assert.throws(() => { result.missingFields.push('rawProviderMetadata') }, TypeError)
    assert.deepEqual(Object.keys(result), Object.keys(parse('US_APPLE_AAPL')))
    assert.doesNotMatch(JSON.stringify(result), /thscode|dataVol|TEST_ONLY|errmsg|RequestId/i)
  })
}

module.exports = { run }
