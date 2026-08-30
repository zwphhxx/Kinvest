'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { parseIfindMarketFinancials } = require('../domain/ifind-market-financial-parser')
const { fixtureBundle } = require('./helpers/ifind-market-evidence')
const {
  createLiveRequestManifest,
  getIfindMarketCase
} = require('../domain/ifind-market-cases')

const METRIC_KEYS = Object.freeze([
  'revenue',
  'grossProfit',
  'attributableNetProfit',
  'operatingCashFlow',
  'receivables',
  'inventory',
  'interestBearingDebt'
])

const POINT_KEYS = Object.freeze([
  'availability',
  'currency',
  'disclosureScope',
  'fetchTime',
  'indicatorId',
  'metricKey',
  'periodType',
  'reportDate',
  'reportPeriod',
  'sourceTime',
  'unit',
  'value',
  'verification'
].sort())

const FETCH_TIME = '2025-12-01T12:00:00.000Z'
const VERIFIED_AT = '2025-11-20T08:00:00.000Z'

function readFixture(name) {
  return JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'ifind', name),
    'utf8'
  ))
}

function metricIds(market) {
  return Object.freeze({
    revenue: `TEST_ONLY_${market}_REVENUE`,
    grossProfit: `TEST_ONLY_${market}_GROSS_PROFIT`,
    attributableNetProfit: `TEST_ONLY_${market}_NET_PROFIT`,
    operatingCashFlow: `TEST_ONLY_${market}_OPERATING_CASH_FLOW`,
    receivables: `TEST_ONLY_${market}_RECEIVABLES`,
    inventory: `TEST_ONLY_${market}_INVENTORY`,
    interestBearingDebt: `TEST_ONLY_${market}_INTEREST_BEARING_DEBT`
  })
}

function metadataIds(market) {
  return Object.freeze({
    currency: `TEST_ONLY_${market}_CURRENCY`,
    unit: `TEST_ONLY_${market}_UNIT`,
    reportPeriod: `TEST_ONLY_${market}_REPORT_PERIOD`,
    reportDate: `TEST_ONLY_${market}_REPORT_DATE`,
    periodType: `TEST_ONLY_${market}_PERIOD_TYPE`,
    disclosureScope: `TEST_ONLY_${market}_DISCLOSURE_SCOPE`,
    sourceTime: `TEST_ONLY_${market}_SOURCE_TIME`
  })
}

const ISSUERS = Object.freeze([
  Object.freeze({
    label: 'Alibaba HK issuer',
    market: 'HK',
    fixtureName: 'hk-financial-success.json',
    fixture: readFixture('hk-financial-success.json'),
    caseId: 'HK_ALIBABA_9988',
    listingId: 'listing-hkex-9988',
    displayCode: '9988.HK',
    currency: 'CNY',
    scope: 'consolidated',
    metricIds: metricIds('HK'),
    metadataIds: metadataIds('HK'),
    periods: Object.freeze([
      Object.freeze({
        reportPeriod: 'FY2025',
        reportDate: '2025-03-31',
        periodType: 'annual',
        sourceTime: '2025-05-15T17:30:00+08:00'
      }),
      Object.freeze({
        reportPeriod: 'FY2024',
        reportDate: '2024-03-31',
        periodType: 'annual',
        sourceTime: '2024-05-16T17:30:00+08:00'
      }),
      Object.freeze({
        reportPeriod: 'H1-FY2026',
        reportDate: '2025-09-30',
        periodType: 'interim',
        sourceTime: '2025-11-14T17:30:00+08:00'
      })
    ])
  }),
  Object.freeze({
    label: 'Apple US issuer',
    market: 'US',
    fixtureName: 'us-financial-success.json',
    fixture: readFixture('us-financial-success.json'),
    caseId: 'US_APPLE_AAPL',
    listingId: 'listing-nasdaq-aapl',
    displayCode: 'AAPL.US',
    currency: 'USD',
    scope: 'issuer_consolidated',
    metricIds: metricIds('US'),
    metadataIds: metadataIds('US'),
    periods: Object.freeze([
      Object.freeze({
        reportPeriod: 'FY2024',
        reportDate: '2024-09-28',
        periodType: 'annual',
        sourceTime: '2024-11-01T06:00:00-04:00'
      }),
      Object.freeze({
        reportPeriod: 'FY2023',
        reportDate: '2023-09-30',
        periodType: 'annual',
        sourceTime: '2023-11-03T06:00:00-04:00'
      }),
      Object.freeze({
        reportPeriod: 'Q3-FY2025',
        reportDate: '2025-06-28',
        periodType: 'interim',
        sourceTime: '2025-08-01T06:00:00-04:00'
      })
    ])
  }),
  Object.freeze({
    label: 'Moutai A-share issuer',
    market: 'CN',
    fixtureName: 'cn-financial-success.json',
    fixture: readFixture('cn-financial-success.json'),
    caseId: 'CN_MOUTAI_600519',
    listingId: 'listing-sse-600519',
    displayCode: '600519.SH',
    currency: 'CNY',
    scope: 'consolidated',
    metricIds: metricIds('CN'),
    metadataIds: metadataIds('CN'),
    periods: Object.freeze([
      Object.freeze({
        reportPeriod: '2024A',
        reportDate: '2024-12-31',
        periodType: 'annual',
        sourceTime: '2025-04-03T18:00:00+08:00'
      }),
      Object.freeze({
        reportPeriod: '2023A',
        reportDate: '2023-12-31',
        periodType: 'annual',
        sourceTime: '2024-04-03T18:00:00+08:00'
      }),
      Object.freeze({
        reportPeriod: '2025H1',
        reportDate: '2025-06-30',
        periodType: 'interim',
        sourceTime: '2025-08-13T18:00:00+08:00'
      })
    ])
  })
])

const MANIFEST_BUNDLES = Object.fromEntries(ISSUERS.map((issuer) => [
  issuer.caseId, fixtureBundle(issuer.caseId)
]))

function verified(overrides = {}) {
  return {
    issuerIdentityStatus: 'verified',
    vendorCodeStatus: 'verified',
    entitlementStatus: 'verified',
    currencyStatus: 'verified',
    unitStatus: 'verified',
    reportPeriodStatus: 'verified',
    scopeStatus: 'verified',
    sourceMode: 'real',
    ...overrides
  }
}

function currencyEvidence(issuer, overrides = {}) {
  return {
    caseId: issuer.caseId,
    listingId: issuer.listingId,
    currency: issuer.currency,
    evidenceStatus: 'verified',
    sourceIdentity: 'kinvest-task2-sanitized-fixture',
    sourceReference: `fixture://ifind/${issuer.fixtureName}`,
    verifiedAt: VERIFIED_AT,
    ...overrides
  }
}

function resizeFixtureArrays(record, length) {
  return Object.fromEntries(Object.entries(record).map(([key, values]) => [
    key,
    Array.from({ length }, (_, index) => values[index] === undefined
      ? values[values.length - 1] + index + 1
      : values[index])
  ]))
}

function makePayload(issuer, periods = issuer.periods) {
  const fixtureMetrics = Object.fromEntries(Object.entries(issuer.fixture.tables[0].table)
    .filter(([id]) => Object.values(issuer.metricIds).includes(id)))
  const fields = resizeFixtureArrays(fixtureMetrics, periods.length)
  const offset = issuer.market === 'HK' ? 400 : issuer.market === 'US' ? 500 : 600
  fields[issuer.metricIds.receivables] = periods.map((_, index) => offset + index + 1)
  fields[issuer.metricIds.inventory] = periods.map((_, index) => offset + index + 11)
  fields[issuer.metricIds.interestBearingDebt] = periods.map((_, index) => offset + index + 21)
  fields[issuer.metadataIds.currency] = periods.map(() => issuer.currency)
  fields[issuer.metadataIds.unit] = periods.map(() => 'million')
  fields[issuer.metadataIds.reportPeriod] = periods.map((period) => period.reportPeriod)
  fields[issuer.metadataIds.reportDate] = periods.map((period) => period.reportDate)
  fields[issuer.metadataIds.periodType] = periods.map((period) => period.periodType)
  fields[issuer.metadataIds.disclosureScope] = periods.map(() => issuer.scope)
  fields[issuer.metadataIds.sourceTime] = periods.map((period) => period.sourceTime)
  return {
    errorcode: 0,
    tables: [{
      thscode: issuer.fixture.tables[0].thscode,
      table: fields
    }],
    dataVol: Object.values(fields).reduce((total, values) => total + values.length, 0)
  }
}

function recalculateDataVol(payload) {
  payload.dataVol = Object.values(payload.tables[0].table)
    .reduce((total, values) => total + values.length, 0)
  return payload
}

function parse(
  issuer,
  payload = makePayload(issuer),
  verification = verified(),
  evidence = currencyEvidence(issuer),
  fetchTime = FETCH_TIME
) {
  return parseIfindMarketFinancials({
    caseId: issuer.caseId,
    fetchTime,
    payload,
    verification,
    manifestBundle: MANIFEST_BUNDLES[issuer.caseId],
    financialReportingCurrencyEvidence: evidence
  })
}

function pointFor(result, metricKey, reportPeriod) {
  return result.points.find((point) =>
    point.metricKey === metricKey && point.reportPeriod === reportPeriod
  )
}

function assertDeepFrozen(value, label) {
  if (!value || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true, `${label}: expected frozen output`)
  for (const nested of Object.values(value)) assertDeepFrozen(nested, label)
}

function assertUnavailable(result, label, failedField) {
  assert.equal(result.source, 'unavailable', `${label}: source`)
  assert.equal(result.availability, 'unavailable', `${label}: availability`)
  assert.deepEqual(result.points, [], `${label}: sanitized points`)
  assert.notEqual(result.verification.sourceMode, 'real', `${label}: no real provenance on rejection`)
  if (failedField) {
    assert.equal(result.verification[failedField], 'failed', `${label}: failed dimension`)
  }
  assertDeepFrozen(result, label)
}

function testIssuerSemantics() {
  for (const issuer of ISSUERS) {
    const result = parse(issuer)
    assert.equal(result.source, 'real', `${issuer.label}: valid issuer periods`)
    assert.deepEqual(
      result.points.filter((point) => point.metricKey === 'revenue')
        .map((point) => point.reportPeriod),
      issuer.periods.map((period) => period.reportPeriod),
      `${issuer.label}: selected period labels`
    )
  }

  const mismatchCases = [
    ['Alibaba annual fiscal label', ISSUERS[0], (payload, issuer) => {
      payload.tables[0].table[issuer.metadataIds.reportPeriod][0] = 'FY2024'
    }],
    ['Alibaba H1 following fiscal year', ISSUERS[0], (payload, issuer) => {
      payload.tables[0].table[issuer.metadataIds.reportPeriod][2] = 'H1-FY2025'
    }],
    ['Apple annual fiscal label', ISSUERS[1], (payload, issuer) => {
      payload.tables[0].table[issuer.metadataIds.reportPeriod][0] = 'FY2025'
    }],
    ['Apple quarter date sequence', ISSUERS[1], (payload, issuer) => {
      payload.tables[0].table[issuer.metadataIds.reportPeriod][2] = 'Q2-FY2025'
    }],
    ['Moutai annual calendar label', ISSUERS[2], (payload, issuer) => {
      payload.tables[0].table[issuer.metadataIds.reportPeriod][0] = '2023A'
    }],
    ['Moutai interim date sequence', ISSUERS[2], (payload, issuer) => {
      payload.tables[0].table[issuer.metadataIds.reportPeriod][2] = '2025Q1'
    }],
    ['period type and label binding', ISSUERS[0], (payload, issuer) => {
      payload.tables[0].table[issuer.metadataIds.periodType][0] = 'interim'
    }]
  ]
  for (const entry of mismatchCases) {
    const [label, issuer, mutate] = /** @type {[string, typeof ISSUERS[number], (payload: ReturnType<typeof makePayload>, issuer: typeof ISSUERS[number]) => void]} */ (entry)
    const payload = makePayload(issuer)
    mutate(payload, issuer)
    assertUnavailable(parse(issuer, payload), label, 'reportPeriodStatus')
  }
}

function selectionPeriods() {
  return [
    {
      issuer: ISSUERS[0],
      label: 'Alibaba unsorted issuer periods',
      periods: [
        { reportPeriod: 'FY2023', reportDate: '2023-03-31', periodType: 'annual', sourceTime: '2023-05-18T17:30:00+08:00' },
        { reportPeriod: 'H1-FY2025', reportDate: '2024-09-30', periodType: 'interim', sourceTime: '2024-11-15T17:30:00+08:00' },
        { reportPeriod: 'FY2025', reportDate: '2025-03-31', periodType: 'annual', sourceTime: '2025-05-15T17:30:00+08:00' },
        { reportPeriod: 'FY2024', reportDate: '2024-03-31', periodType: 'annual', sourceTime: '2024-05-16T17:30:00+08:00' },
        { reportPeriod: 'H1-FY2026', reportDate: '2025-09-30', periodType: 'interim', sourceTime: '2025-11-14T17:30:00+08:00' }
      ],
      expected: ['FY2025', 'FY2024', 'H1-FY2026']
    },
    {
      issuer: ISSUERS[1],
      label: 'Apple unsorted issuer periods',
      periods: [
        { reportPeriod: 'Q2-FY2024', reportDate: '2024-03-30', periodType: 'interim', sourceTime: '2024-05-03T06:00:00-04:00' },
        { reportPeriod: 'FY2023', reportDate: '2023-09-30', periodType: 'annual', sourceTime: '2023-11-03T06:00:00-04:00' },
        { reportPeriod: 'FY2024', reportDate: '2024-09-28', periodType: 'annual', sourceTime: '2024-11-01T06:00:00-04:00' },
        { reportPeriod: 'Q3-FY2025', reportDate: '2025-06-28', periodType: 'interim', sourceTime: '2025-08-01T06:00:00-04:00' },
        { reportPeriod: 'FY2022', reportDate: '2022-09-24', periodType: 'annual', sourceTime: '2022-10-28T06:00:00-04:00' }
      ],
      expected: ['FY2024', 'FY2023', 'Q3-FY2025']
    },
    {
      issuer: ISSUERS[2],
      label: 'Moutai unsorted issuer periods',
      periods: [
        { reportPeriod: '2023A', reportDate: '2023-12-31', periodType: 'annual', sourceTime: '2024-04-03T18:00:00+08:00' },
        { reportPeriod: '2025Q1', reportDate: '2025-03-31', periodType: 'interim', sourceTime: '2025-04-26T18:00:00+08:00' },
        { reportPeriod: '2022A', reportDate: '2022-12-31', periodType: 'annual', sourceTime: '2023-03-31T18:00:00+08:00' },
        { reportPeriod: '2024A', reportDate: '2024-12-31', periodType: 'annual', sourceTime: '2025-04-03T18:00:00+08:00' },
        { reportPeriod: '2025H1', reportDate: '2025-06-30', periodType: 'interim', sourceTime: '2025-08-13T18:00:00+08:00' }
      ],
      expected: ['2024A', '2023A', '2025H1']
    }
  ]
}

function testSelectionAndChronology() {
  for (const testCase of selectionPeriods()) {
    const payload = makePayload(testCase.issuer, testCase.periods)
    const result = parse(testCase.issuer, payload)
    assert.equal(result.source, 'real', `${testCase.label}: source`)
    assert.deepEqual(
      result.points.filter((point) => point.metricKey === 'revenue')
        .map((point) => point.reportPeriod),
      testCase.expected,
      `${testCase.label}: latest two annual plus latest interim`
    )
    for (const reportPeriod of testCase.expected) {
      const providerIndex = testCase.periods.findIndex((period) =>
        period.reportPeriod === reportPeriod
      )
      assert.equal(
        pointFor(result, 'revenue', reportPeriod).value,
        payload.tables[0].table[testCase.issuer.metricIds.revenue][providerIndex],
        `${testCase.label}: selected provider value`
      )
    }
  }

  const hk = ISSUERS[0]
  const chronologyCases = [
    ['future report end after fetch', 'reportPeriodStatus', (payload) => {
      payload.tables[0].table[hk.metadataIds.reportPeriod][2] = 'H1-FY2027'
      payload.tables[0].table[hk.metadataIds.reportDate][2] = '2026-09-30'
      payload.tables[0].table[hk.metadataIds.sourceTime][2] = '2026-11-13T17:30:00+08:00'
    }],
    ['source before report end', 'scopeStatus', (payload) => {
      payload.tables[0].table[hk.metadataIds.sourceTime][0] = '2025-03-30T17:30:00+08:00'
    }],
    ['source after fetch', 'scopeStatus', (payload) => {
      payload.tables[0].table[hk.metadataIds.sourceTime][0] = '2025-12-02T17:30:00+08:00'
    }],
    ['same issuer-local report date', 'scopeStatus', (payload) => {
      payload.tables[0].table[hk.metadataIds.sourceTime][0] = '2025-03-31T15:59:59.000Z'
    }]
  ]
  for (const entry of chronologyCases) {
    const [label, failedField, mutate] = /** @type {[string, string, (payload: ReturnType<typeof makePayload>) => void]} */ (entry)
    const payload = makePayload(hk)
    mutate(payload)
    assertUnavailable(parse(hk, payload), label, failedField)
  }

  const undisclosedPayload = makePayload(hk)
  undisclosedPayload.tables[0].table[hk.metadataIds.sourceTime][2] = '2025-08-29T17:30:00+08:00'
  assertUnavailable(
    parse(hk, undisclosedPayload, verified(), currencyEvidence(hk), '2025-08-29T12:00:00.000Z'),
    'old Alibaba H1 fixture was undisclosed at trusted fetch time',
    'reportPeriodStatus'
  )

  const sourceAtFetch = makePayload(hk)
  sourceAtFetch.tables[0].table[hk.metadataIds.sourceTime][0] = FETCH_TIME
  assert.equal(parse(hk, sourceAtFetch).source, 'real', 'source time may equal trusted fetch time')

  const nextLocalDayPayload = makePayload(hk)
  nextLocalDayPayload.tables[0].table[hk.metadataIds.sourceTime][0] =
    '2025-03-31T16:00:01.000Z'
  assert.equal(parse(hk, nextLocalDayPayload).source, 'real', 'Shanghai next local day accepted')

  const unselected = selectionPeriods()[0]
  const invalidUnselectedPayload = makePayload(unselected.issuer, unselected.periods)
  invalidUnselectedPayload.tables[0].table[hk.metadataIds.sourceTime][0] =
    '2023-03-01T17:30:00+08:00'
  assertUnavailable(
    parse(hk, invalidUnselectedPayload),
    'chronology validation precedes selection',
    'scopeStatus'
  )
}

function testCurrencyEvidence() {
  const hk = ISSUERS[0]
  const apple = ISSUERS[1]
  const missing = parseIfindMarketFinancials({
    caseId: hk.caseId,
    fetchTime: FETCH_TIME,
    payload: makePayload(hk),
    manifestBundle: MANIFEST_BUNDLES[hk.caseId],
    verification: verified()
  })
  assertUnavailable(missing, 'missing currency evidence', 'currencyStatus')

  const unverified = parse(
    hk,
    makePayload(hk),
    verified(),
    currencyEvidence(hk, { currency: null, evidenceStatus: 'unverified' })
  )
  assertUnavailable(unverified, 'unverified currency evidence')
  assert.equal(unverified.verification.currencyStatus, 'unverified')

  const evidenceCases = [
    ['cross-issuer evidence case', currencyEvidence(apple), 'issuerIdentityStatus'],
    ['cross-listing evidence', currencyEvidence(hk, { listingId: apple.listingId }), 'issuerIdentityStatus'],
    ['evidence currency mismatch', currencyEvidence(hk, { currency: 'HKD' }), 'currencyStatus'],
    ['missing source identity', (() => {
      const evidence = currencyEvidence(hk)
      delete evidence.sourceIdentity
      return evidence
    })(), 'currencyStatus'],
    ['secret-like source reference', currencyEvidence(hk, {
      sourceReference: 'fixture://ifind/access_token'
    }), 'currencyStatus'],
    ['non-canonical verifiedAt', currencyEvidence(hk, {
      verifiedAt: '2025-02-30T08:00:00.000Z'
    }), 'currencyStatus']
  ]
  for (const entry of evidenceCases) {
    const [label, evidence, failedField] = /** @type {[string, ReturnType<typeof currencyEvidence>, string]} */ (entry)
    assertUnavailable(parse(hk, makePayload(hk), verified(), evidence), label, failedField)
  }

  const providerMismatch = makePayload(hk)
  providerMismatch.tables[0].table[hk.metadataIds.currency][0] = 'HKD'
  assertUnavailable(parse(hk, providerMismatch), 'provider currency mismatch', 'currencyStatus')

  const resultText = JSON.stringify(parse(hk))
  assert.equal(resultText.includes('HKD'), false, 'trading currency not synthesized')
  assert.equal(resultText.includes('sourceIdentity'), false, 'evidence identity omitted')
  assert.equal(resultText.includes('fixture://'), false, 'evidence reference omitted')

  for (const issuer of ISSUERS) {
    assert.equal(getIfindMarketCase(issuer.caseId).liveReady, false, `${issuer.label}: catalog closed`)
    assert.throws(
      () => createLiveRequestManifest(issuer.caseId),
      (error) => error instanceof Error && 'code' in error &&
        error.code === 'IFIND_MARKET_CASE_UNVERIFIED',
      `${issuer.label}: fixture evidence is not production evidence`
    )
  }
}

function testMalformedPayloads() {
  const hk = ISSUERS[0]
  const metadataCases = [
    ['missing currency', 'currency', 'delete', 'currencyStatus'],
    ['short currency', 'currency', 'short', 'currencyStatus'],
    ['missing unit', 'unit', 'delete', 'unitStatus'],
    ['short unit', 'unit', 'short', 'unitStatus'],
    ['missing reportPeriod', 'reportPeriod', 'delete', 'reportPeriodStatus'],
    ['short reportDate', 'reportDate', 'short', 'reportPeriodStatus'],
    ['missing periodType', 'periodType', 'delete', 'reportPeriodStatus'],
    ['short periodType', 'periodType', 'short', 'reportPeriodStatus'],
    ['missing disclosureScope', 'disclosureScope', 'delete', 'scopeStatus'],
    ['short disclosureScope', 'disclosureScope', 'short', 'scopeStatus'],
    ['missing sourceTime', 'sourceTime', 'delete', 'scopeStatus'],
    ['short sourceTime', 'sourceTime', 'short', 'scopeStatus']
  ]
  for (const [label, field, mutation, failedField] of metadataCases) {
    const payload = makePayload(hk)
    const indicatorId = hk.metadataIds[field]
    if (mutation === 'delete') delete payload.tables[0].table[indicatorId]
    else payload.tables[0].table[indicatorId].pop()
    recalculateDataVol(payload)
    assertUnavailable(parse(hk, payload), label, failedField)
  }

  for (const [label, field, failedField] of [
    ['accessor currency', 'currency', 'currencyStatus'],
    ['accessor unit', 'unit', 'unitStatus'],
    ['accessor reportDate', 'reportDate', 'reportPeriodStatus'],
    ['accessor disclosureScope', 'disclosureScope', 'scopeStatus']
  ]) {
    let invoked = false
    const payload = makePayload(hk)
    const indicatorId = hk.metadataIds[field]
    Object.defineProperty(payload.tables[0].table, indicatorId, {
      enumerable: true,
      get() {
        invoked = true
        return []
      }
    })
    assertUnavailable(parse(hk, payload), label, failedField)
    assert.equal(invoked, false, `${label}: getter not invoked`)
  }

  const semanticCases = [
    ['wrong provider code', 'vendorCodeStatus', (payload) => {
      payload.tables[0].thscode = 'TEST_ONLY_WRONG_CODE'
    }],
    ['provider rejection', 'entitlementStatus', (payload) => {
      payload.errorcode = -4301
    }],
    ['incompatible unit', 'unitStatus', (payload) => {
      payload.tables[0].table[hk.metadataIds.unit][0] = 'thousand'
    }],
    ['wrong scope', 'scopeStatus', (payload) => {
      payload.tables[0].table[hk.metadataIds.disclosureScope][0] = 'issuer_only'
    }],
    ['duplicate period', 'reportPeriodStatus', (payload) => {
      payload.tables[0].table[hk.metadataIds.reportPeriod][1] =
        payload.tables[0].table[hk.metadataIds.reportPeriod][0]
    }],
    ['normalized invalid source date', 'scopeStatus', (payload) => {
      payload.tables[0].table[hk.metadataIds.sourceTime][0] = '2025-02-30T17:30:00+08:00'
    }],
    ['invalid timestamp offset', 'scopeStatus', (payload) => {
      payload.tables[0].table[hk.metadataIds.sourceTime][0] = '2025-05-15T17:30:00+15:00'
    }]
  ]
  for (const entry of semanticCases) {
    const [label, failedField, mutate] = /** @type {[string, string, (payload: ReturnType<typeof makePayload>) => void]} */ (entry)
    const payload = makePayload(hk)
    mutate(payload)
    assertUnavailable(parse(hk, payload), label, failedField)
  }

  const selection = selectionPeriods()[0]
  for (const [label, value] of [
    ['non-finite older value', Number.POSITIVE_INFINITY],
    ['string older value', 'not-a-number'],
    ['undefined older value', undefined]
  ]) {
    const payload = makePayload(selection.issuer, selection.periods)
    payload.tables[0].table[hk.metricIds.revenue][0] = value
    assertUnavailable(parse(hk, payload), label, 'scopeStatus')
  }

  const shortMetric = makePayload(selection.issuer, selection.periods)
  shortMetric.tables[0].table[hk.metricIds.inventory].pop()
  recalculateDataVol(shortMetric)
  assertUnavailable(parse(hk, shortMetric), 'short metric array', 'scopeStatus')

  const nullOlder = makePayload(selection.issuer, selection.periods)
  nullOlder.tables[0].table[hk.metricIds.revenue][0] = null
  assert.equal(parse(hk, nullOlder).source, 'real', 'null is valid missing data')

  const rawField = makePayload(hk)
  rawField.tables[0].table.TEST_ONLY_RAW_SENTINEL = ['raw-provider-sentinel']
  const rawResult = parse(hk, rawField)
  assertUnavailable(rawResult, 'unknown provider field', 'scopeStatus')
  assert.equal(JSON.stringify(rawResult).includes('raw-provider-sentinel'), false)
}

function hostileProxy(target, state) {
  return new Proxy(target, {
    get() {
      state.invoked = true
      throw new Error('proxy trap must not run')
    },
    getPrototypeOf() {
      state.invoked = true
      throw new Error('proxy trap must not run')
    },
    ownKeys() {
      state.invoked = true
      throw new Error('proxy trap must not run')
    },
    getOwnPropertyDescriptor() {
      state.invoked = true
      throw new Error('proxy trap must not run')
    }
  })
}

function testLocalProvenanceContext() {
  for (const issuer of ISSUERS) {
    const fetchTime = '2025-12-01T12:34:56.789Z'
    const payload = makePayload(issuer)
    const fields = payload.tables[0].table
    const remoteFieldIds = Object.keys(fields)
    /** @type {string[]} */
    const allowedRemoteFieldIds = [
      ...Object.values(issuer.metricIds), ...Object.values(issuer.metadataIds)
    ]
    for (const id of remoteFieldIds) {
      assert.ok(allowedRemoteFieldIds.includes(id), `${issuer.label}: only vendor fields`)
      assert.equal(fields[id].length, issuer.periods.length, `${issuer.label}: remote row count`)
    }
    assert.doesNotMatch(JSON.stringify(remoteFieldIds), /FETCH_TIME|SOURCE_MODE|fetchTime|sourceMode/,
      `${issuer.label}: local provenance is not a remote field`)
    assert.equal(payload.dataVol, remoteFieldIds.length * issuer.periods.length,
      `${issuer.label}: only actual remote values count, including missing-metric fixtures`)
    const result = parse(issuer, payload, verified(), currencyEvidence(issuer), fetchTime)
    assert.equal(result.source, 'real')
    assert.equal(result.points.length, 21)
    for (const point of result.points) {
      assert.equal(point.fetchTime, fetchTime, `${issuer.label}: trusted timestamp copied exactly`)
      assert.equal(point.verification.sourceMode, 'real')
      assert.equal(point.sourceTime, issuer.periods.find((period) =>
        period.reportPeriod === point.reportPeriod).sourceTime)
    }
  }

  const hk = ISSUERS[0]
  const input = () => ({
    caseId: hk.caseId, fetchTime: FETCH_TIME, payload: makePayload(hk),
    verification: verified(), manifestBundle: MANIFEST_BUNDLES[hk.caseId],
    financialReportingCurrencyEvidence: currencyEvidence(hk)
  })
  const missing = input()
  delete missing.fetchTime
  assertUnavailable(parseIfindMarketFinancials(missing), 'missing trusted fetch time', 'scopeStatus')
  for (const fetchTime of [
    undefined, null, '', false, Date.parse(FETCH_TIME), new Date(FETCH_TIME),
    [FETCH_TIME], { value: FETCH_TIME },
    'not-a-timestamp', '2025-12-01', '2025-12-01T12:00:00',
    '2025-02-30T12:00:00.000Z', '2025-12-01T24:00:00.000Z',
    '2025-12-01T12:00:00+15:00', ` ${FETCH_TIME}`, `${FETCH_TIME} `
  ]) {
    assertUnavailable(parseIfindMarketFinancials({ ...input(), fetchTime }),
      'malformed trusted fetch time', 'scopeStatus')
  }

  let accessorRead = false
  const accessor = input()
  Object.defineProperty(accessor, 'fetchTime', {
    enumerable: true,
    get() { accessorRead = true; throw new Error('trusted context getter must not run') }
  })
  assertUnavailable(parseIfindMarketFinancials(accessor), 'accessor trusted fetch time')
  assert.equal(accessorRead, false)
  const state = { invoked: false }
  assertUnavailable(parseIfindMarketFinancials({
    ...input(), fetchTime: hostileProxy({ value: FETCH_TIME }, state)
  }), 'proxied trusted fetch time')
  assert.equal(state.invoked, false)
  const revoked = Proxy.revocable({ value: FETCH_TIME }, {})
  revoked.revoke()
  assertUnavailable(parseIfindMarketFinancials({ ...input(), fetchTime: revoked.proxy }),
    'revoked trusted fetch time')

  const dimensions = [
    'issuerIdentityStatus', 'vendorCodeStatus', 'entitlementStatus',
    'currencyStatus', 'unitStatus', 'reportPeriodStatus', 'scopeStatus'
  ]
  for (const field of dimensions) {
    for (const status of ['unverified', 'failed']) {
      assertUnavailable(parse(hk, makePayload(hk), verified({ [field]: status })),
        `${field}: local descriptors do not replace vendor evidence`)
    }
  }
  for (const sourceMode of ['Mock', 'mixed', 'unverified', undefined]) {
    assertUnavailable(parse(hk, makePayload(hk), verified({ sourceMode })),
      'untrusted verification source mode')
  }
}

function testProviderLocalProvenanceRejected() {
  for (const issuer of ISSUERS) {
    for (const field of [
      'fetchTime', 'sourceMode',
      `TEST_ONLY_${issuer.market}_FETCH_TIME`, `TEST_ONLY_${issuer.market}_SOURCE_MODE`
    ]) {
      const isMode = field === 'sourceMode' || field.endsWith('SOURCE_MODE')
      for (const length of [issuer.periods.length, issuer.periods.length - 1]) {
        for (const value of isMode ? ['real', 'Mock'] : [FETCH_TIME, '2026-08-30T04:00:00.000Z']) {
          const payload = makePayload(issuer)
          payload.tables[0].table[field] = Array.from({ length }, () => value)
          recalculateDataVol(payload)
          assertUnavailable(parse(issuer, payload), `${field}: provider injection`, 'scopeStatus')
        }
      }

      let getterRead = false
      const accessorPayload = makePayload(issuer)
      Object.defineProperty(accessorPayload.tables[0].table, field, {
        enumerable: true,
        get() { getterRead = true; throw new Error('provider local getter must not run') }
      })
      accessorPayload.dataVol += issuer.periods.length
      assertUnavailable(parse(issuer, accessorPayload), `${field}: provider accessor`)
      assert.equal(getterRead, false)

      const state = { invoked: false }
      const proxyPayload = makePayload(issuer)
      proxyPayload.tables[0].table[field] = hostileProxy([isMode ? 'real' : FETCH_TIME], state)
      proxyPayload.dataVol += 1
      assertUnavailable(parse(issuer, proxyPayload), `${field}: provider proxy`)
      assert.equal(state.invoked, false)
    }
  }
}

function testHostileObjects() {
  const hk = ISSUERS[0]
  const proxyCases = [
    ['proxied input', 'input'],
    ['proxied payload', 'payload'],
    ['proxied evidence', 'evidence']
  ]
  for (const [label, kind] of proxyCases) {
    const state = { invoked: false }
    const target = kind === 'input'
      ? {
          caseId: hk.caseId,
          fetchTime: FETCH_TIME,
          manifestBundle: MANIFEST_BUNDLES[hk.caseId],
          payload: makePayload(hk),
          verification: verified(),
          financialReportingCurrencyEvidence: currencyEvidence(hk)
        }
      : kind === 'payload' ? makePayload(hk) : currencyEvidence(hk)
    const proxy = hostileProxy(target, state)
    const input = kind === 'input'
      ? proxy
      : {
          caseId: hk.caseId,
          fetchTime: FETCH_TIME,
          manifestBundle: MANIFEST_BUNDLES[hk.caseId],
          payload: kind === 'payload' ? proxy : makePayload(hk),
          verification: verified(),
          financialReportingCurrencyEvidence: kind === 'evidence'
            ? proxy
            : currencyEvidence(hk)
        }
    assertUnavailable(parseIfindMarketFinancials(input), label)
    assert.equal(state.invoked, false, `${label}: traps not invoked`)
  }

  let inputAccessorInvoked = false
  const accessorInput = {
    fetchTime: FETCH_TIME,
    manifestBundle: MANIFEST_BUNDLES[hk.caseId],
    payload: makePayload(hk),
    verification: verified(),
    financialReportingCurrencyEvidence: currencyEvidence(hk)
  }
  Object.defineProperty(accessorInput, 'caseId', {
    enumerable: true,
    get() {
      inputAccessorInvoked = true
      return hk.caseId
    }
  })
  assertUnavailable(parseIfindMarketFinancials(accessorInput), 'accessor input')
  assert.equal(inputAccessorInvoked, false, 'input accessor not invoked')

  let evidenceAccessorInvoked = false
  const accessorEvidence = currencyEvidence(hk)
  Object.defineProperty(accessorEvidence, 'currency', {
    enumerable: true,
    get() {
      evidenceAccessorInvoked = true
      return hk.currency
    }
  })
  assertUnavailable(
    parse(hk, makePayload(hk), verified(), accessorEvidence),
    'accessor evidence',
    'currencyStatus'
  )
  assert.equal(evidenceAccessorInvoked, false, 'evidence accessor not invoked')

  const revoked = Proxy.revocable(makePayload(hk), {})
  revoked.revoke()
  assertUnavailable(parseIfindMarketFinancials({
    caseId: hk.caseId,
    fetchTime: FETCH_TIME,
    manifestBundle: MANIFEST_BUNDLES[hk.caseId],
    payload: revoked.proxy,
    verification: verified(),
    financialReportingCurrencyEvidence: currencyEvidence(hk)
  }), 'revoked payload')

  const customEvidence = Object.create({ inherited: true })
  Object.assign(customEvidence, currencyEvidence(hk))
  assertUnavailable(
    parse(hk, makePayload(hk), verified(), customEvidence),
    'custom evidence prototype',
    'currencyStatus'
  )

  class HostileArray extends Array {}
  const customArray = makePayload(hk)
  customArray.tables[0].table[hk.metadataIds.currency] = new HostileArray(
    ...customArray.tables[0].table[hk.metadataIds.currency]
  )
  assertUnavailable(parse(hk, customArray), 'custom array prototype', 'currencyStatus')
}

function testOutputPurity() {
  for (const issuer of ISSUERS) {
    const result = parse(issuer)
    assert.equal(result.caseId, issuer.caseId, `${issuer.label}: case identity`)
    assert.equal(result.listingId, issuer.listingId, `${issuer.label}: listing identity`)
    assert.equal(result.displayCode, issuer.displayCode, `${issuer.label}: display identity`)
    assert.equal(result.source, 'real', `${issuer.label}: real source`)
    assert.equal(result.availability, 'available', `${issuer.label}: availability`)
    assert.equal(result.points.length, METRIC_KEYS.length * 3, `${issuer.label}: point count`)
    assert.deepEqual(
      [...new Set(result.points.map((point) => point.metricKey))],
      METRIC_KEYS,
      `${issuer.label}: exact metrics`
    )
    for (const point of result.points) {
      assert.deepEqual(Object.keys(point).sort(), POINT_KEYS, `${issuer.label}: point schema`)
      assert.equal(point.indicatorId, issuer.metricIds[point.metricKey])
      assert.equal(point.currency, issuer.currency)
      assert.equal(point.unit, 'million')
      assert.equal(point.fetchTime, FETCH_TIME)
      assert.deepEqual(point.verification, verified())
    }
    for (const period of issuer.periods) {
      const grossProfit = pointFor(result, 'grossProfit', period.reportPeriod)
      assert.equal(grossProfit.value, null, `${issuer.label}: gross profit null`)
      assert.equal(grossProfit.availability, 'missing', `${issuer.label}: gross profit missing`)
    }
    assertDeepFrozen(result, issuer.label)
  }

  const hk = ISSUERS[0]
  const nullPayload = makePayload(hk)
  nullPayload.tables[0].table[hk.metricIds.revenue][0] = null
  const missingRevenue = pointFor(parse(hk, nullPayload), 'revenue', hk.periods[0].reportPeriod)
  assert.equal(missingRevenue.value, null, 'provider null preserved')
  assert.equal(missingRevenue.availability, 'missing', 'provider null marked missing')

  const unverified = parse(hk, makePayload(hk), verified({ scopeStatus: 'unverified' }))
  assertUnavailable(unverified, 'unverified context')
  assert.equal(unverified.verification.scopeStatus, 'unverified')

  const serialized = JSON.stringify(parse(hk))
  for (const forbidden of [
    'sourceIdentity',
    'sourceReference',
    'verifiedAt',
    'raw-provider-sentinel',
    'Mock',
    'access_token',
    'refresh_token'
  ]) {
    assert.equal(serialized.includes(forbidden), false, `output excludes ${forbidden}`)
  }
}

async function run() {
  /** @type {[string, () => void][]} */
  const routines = [
    ['issuer semantics', testIssuerSemantics],
    ['selection and chronology', testSelectionAndChronology],
    ['currency evidence', testCurrencyEvidence],
    ['malformed payloads', testMalformedPayloads],
    ['trusted local provenance context', testLocalProvenanceContext],
    ['provider local provenance rejection', testProviderLocalProvenanceRejected],
    ['hostile objects', testHostileObjects],
    ['output purity', testOutputPurity]
  ]
  for (const [label, routine] of routines) {
    try {
      await routine()
    } catch (error) {
      error.message = `[${label}] ${error.message}`
      throw error
    }
  }
}

module.exports = { run }
