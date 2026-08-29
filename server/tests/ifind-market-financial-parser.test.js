'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  parseIfindMarketFinancials
} = require('../domain/ifind-market-financial-parser')
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

const VERIFICATION_FIELDS = Object.freeze([
  'issuerIdentityStatus',
  'vendorCodeStatus',
  'entitlementStatus',
  'currencyStatus',
  'unitStatus',
  'reportPeriodStatus',
  'scopeStatus',
  'sourceMode'
])

const FETCH_TIME = '2025-12-01T12:00:00.000Z'

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
    sourceTime: `TEST_ONLY_${market}_SOURCE_TIME`,
    fetchTime: `TEST_ONLY_${market}_FETCH_TIME`,
    sourceMode: `TEST_ONLY_${market}_SOURCE_MODE`
  })
}

const PROFILES = Object.freeze([
  Object.freeze({
    label: 'HK annual and interim disclosure',
    market: 'HK',
    caseId: 'HK_ALIBABA_9988',
    listingId: 'listing-hkex-9988',
    displayCode: '9988.HK',
    currency: 'CNY',
    scope: 'consolidated',
    fixture: readFixture('hk-financial-success.json'),
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
    label: 'US issuer fiscal years and interim filing period',
    market: 'US',
    caseId: 'US_APPLE_AAPL',
    listingId: 'listing-nasdaq-aapl',
    displayCode: 'AAPL.US',
    currency: 'USD',
    scope: 'issuer_consolidated',
    fixture: readFixture('us-financial-success.json'),
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
    label: 'A-share annual and interim reporting',
    market: 'CN',
    caseId: 'CN_MOUTAI_600519',
    listingId: 'listing-sse-600519',
    displayCode: '600519.SH',
    currency: 'CNY',
    scope: 'consolidated',
    fixture: readFixture('cn-financial-success.json'),
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

function cloneArrays(record, length) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      Array.from({ length }, (_, index) => value[index] === undefined
        ? value[value.length - 1] + index + 1
        : value[index])
    ])
  )
}

function makePayload(profile, periods = profile.periods) {
  const sourceTable = profile.fixture.tables[0].table
  const fields = cloneArrays(sourceTable, periods.length)
  const offset = profile.market === 'HK' ? 400 : profile.market === 'US' ? 500 : 600
  fields[profile.metricIds.receivables] = periods.map((_, index) => offset + index + 1)
  fields[profile.metricIds.inventory] = periods.map((_, index) => offset + index + 11)
  fields[profile.metricIds.interestBearingDebt] = periods.map((_, index) => offset + index + 21)
  fields[profile.metadataIds.currency] = periods.map(() => profile.currency)
  fields[profile.metadataIds.unit] = periods.map(() => 'million')
  fields[profile.metadataIds.reportPeriod] = periods.map((period) => period.reportPeriod)
  fields[profile.metadataIds.reportDate] = periods.map((period) => period.reportDate)
  fields[profile.metadataIds.periodType] = periods.map((period) => period.periodType)
  fields[profile.metadataIds.disclosureScope] = periods.map(() => profile.scope)
  fields[profile.metadataIds.sourceTime] = periods.map((period) => period.sourceTime)
  fields[profile.metadataIds.fetchTime] = periods.map(() => FETCH_TIME)
  fields[profile.metadataIds.sourceMode] = periods.map(() => 'real')
  return {
    errorcode: 0,
    tables: [{
      thscode: profile.fixture.tables[0].thscode,
      table: fields
    }],
    dataVol: Object.values(fields).reduce((total, values) => total + values.length, 0)
  }
}

function reportingCurrencyEvidence(profile, overrides = {}) {
  return {
    currency: profile.currency,
    evidenceStatus: 'verified',
    ...overrides
  }
}

function parse(
  profile,
  payload = makePayload(profile),
  verification = verified(),
  currencyEvidence = reportingCurrencyEvidence(profile)
) {
  return parseIfindMarketFinancials({
    caseId: profile.caseId,
    payload,
    verification,
    financialReportingCurrencyEvidence: currencyEvidence
  })
}

function assertDeepFrozen(value, label) {
  if (!value || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true, `${label}: expected frozen object`)
  for (const nested of Object.values(value)) assertDeepFrozen(nested, label)
}

function assertUnavailable(result, label, failedField) {
  assert.equal(result.source, 'unavailable', `${label}: source`)
  assert.equal(result.availability, 'unavailable', `${label}: availability`)
  assert.deepEqual(result.points, [], `${label}: sanitized points`)
  if (failedField) {
    assert.equal(result.verification[failedField], 'failed', `${label}: failed status`)
  }
  assert.equal(JSON.stringify(result).includes('raw-provider-sentinel'), false, `${label}: raw leak`)
  assertDeepFrozen(result, label)
}

function pointFor(result, metricKey, reportPeriod) {
  return result.points.find((point) =>
    point.metricKey === metricKey && point.reportPeriod === reportPeriod
  )
}

function unavailableVerification() {
  return Object.fromEntries(VERIFICATION_FIELDS.map((field) => [field, 'failed']))
}

async function run() {
  for (const profile of PROFILES) {
    const result = parse(profile)
    assert.equal(result.caseId, profile.caseId, `${profile.label}: case identity`)
    assert.equal(result.listingId, profile.listingId, `${profile.label}: listing identity`)
    assert.equal(result.displayCode, profile.displayCode, `${profile.label}: display identity`)
    assert.equal(result.source, 'real', `${profile.label}: source`)
    assert.equal(result.availability, 'available', `${profile.label}: availability`)
    assert.equal(result.points.length, METRIC_KEYS.length * 3, `${profile.label}: point count`)
    assert.deepEqual(
      [...new Set(result.points.map((point) => point.metricKey))],
      METRIC_KEYS,
      `${profile.label}: seven metrics`
    )

    for (const period of profile.periods) {
      const periodPoints = result.points.filter((point) =>
        point.reportPeriod === period.reportPeriod
      )
      assert.equal(periodPoints.length, METRIC_KEYS.length, `${profile.label}: ${period.reportPeriod}`)
      for (const point of periodPoints) {
        assert.deepEqual(Object.keys(point).sort(), POINT_KEYS, `${profile.label}: exact point keys`)
        assert.equal(point.indicatorId, profile.metricIds[point.metricKey], `${profile.label}: indicator ID`)
        assert.equal(point.currency, profile.currency, `${profile.label}: provider currency`)
        assert.equal(point.unit, 'million', `${profile.label}: provider unit`)
        assert.equal(point.reportDate, period.reportDate, `${profile.label}: report date`)
        assert.equal(point.periodType, period.periodType, `${profile.label}: period type`)
        assert.equal(point.disclosureScope, profile.scope, `${profile.label}: disclosure scope`)
        assert.equal(point.sourceTime, period.sourceTime, `${profile.label}: source time`)
        assert.equal(point.fetchTime, FETCH_TIME, `${profile.label}: fetch time`)
        assert.deepEqual(point.verification, verified(), `${profile.label}: point verification`)
      }
    }

    const revenue = pointFor(result, 'revenue', profile.periods[0].reportPeriod)
    assert.equal(revenue.value, profile.fixture.tables[0].table[profile.metricIds.revenue][0])
    assert.equal(revenue.availability, 'available')
    for (const period of profile.periods) {
      const grossProfit = pointFor(result, 'grossProfit', period.reportPeriod)
      assert.equal(grossProfit.value, null, `${profile.label}: absent gross profit value`)
      assert.equal(grossProfit.availability, 'missing', `${profile.label}: absent gross profit availability`)
    }
    assertDeepFrozen(result, profile.label)
  }

  const periodSelectionCases = [
    {
      label: 'Alibaba March fiscal year and latest issuer interim',
      profile: PROFILES[0],
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
      label: 'Apple 52/53-week fiscal years and latest issuer interim',
      profile: PROFILES[1],
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
      label: 'Moutai calendar annual and latest disclosed interim',
      profile: PROFILES[2],
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

  for (const testCase of periodSelectionCases) {
    const payload = makePayload(testCase.profile, testCase.periods)
    const result = parse(testCase.profile, payload)
    assert.equal(result.source, 'real', `${testCase.label}: source`)
    assert.deepEqual(
      result.points
        .filter((point) => point.metricKey === 'revenue')
        .map((point) => point.reportPeriod),
      testCase.expected,
      `${testCase.label}: chronological selection`
    )
    for (const reportPeriod of testCase.expected) {
      const providerIndex = testCase.periods.findIndex((period) =>
        period.reportPeriod === reportPeriod
      )
      assert.equal(
        pointFor(result, 'revenue', reportPeriod).value,
        payload.tables[0].table[testCase.profile.metricIds.revenue][providerIndex],
        `${testCase.label}: selected provider value`
      )
    }
  }

  const alibabaCalendarAnnual = makePayload(PROFILES[0])
  alibabaCalendarAnnual.tables[0].table[PROFILES[0].metadataIds.reportDate][0] = '2024-12-31'
  assertUnavailable(
    parse(PROFILES[0], alibabaCalendarAnnual),
    'Alibaba calendar-year annual is incompatible',
    'reportPeriodStatus'
  )

  const chronologyCases = [
    {
      label: 'future report period is not disclosed by fetch time',
      failedField: 'reportPeriodStatus',
      mutate(payload) {
        payload.tables[0].table[PROFILES[0].metadataIds.reportPeriod][2] = 'H1-FY2027'
        payload.tables[0].table[PROFILES[0].metadataIds.reportDate][2] = '2026-09-30'
        payload.tables[0].table[PROFILES[0].metadataIds.sourceTime][2] = '2026-11-13T17:30:00+08:00'
      }
    },
    {
      label: 'source time before report end',
      failedField: 'scopeStatus',
      mutate(payload) {
        payload.tables[0].table[PROFILES[0].metadataIds.sourceTime][0] = '2025-03-30T17:30:00+08:00'
      }
    },
    {
      label: 'source time after fetch time',
      failedField: 'scopeStatus',
      mutate(payload) {
        payload.tables[0].table[PROFILES[0].metadataIds.sourceTime][0] = '2025-12-02T17:30:00+08:00'
      }
    },
    {
      label: 'previous Alibaba H1 fixture was not yet disclosed',
      failedField: 'reportPeriodStatus',
      mutate(payload) {
        payload.tables[0].table[PROFILES[0].metadataIds.sourceTime][2] = '2025-08-29T17:30:00+08:00'
        payload.tables[0].table[PROFILES[0].metadataIds.fetchTime][2] = '2025-08-29T12:00:00.000Z'
      }
    }
  ]

  for (const testCase of chronologyCases) {
    const payload = makePayload(PROFILES[0])
    testCase.mutate(payload)
    assertUnavailable(parse(PROFILES[0], payload), testCase.label, testCase.failedField)
  }

  const invalidUnselectedPeriodPayload = makePayload(
    periodSelectionCases[0].profile,
    periodSelectionCases[0].periods
  )
  invalidUnselectedPeriodPayload.tables[0]
    .table[PROFILES[0].metadataIds.sourceTime][0] = '2023-03-01T17:30:00+08:00'
  assertUnavailable(
    parse(PROFILES[0], invalidUnselectedPeriodPayload),
    'chronology validation precedes latest-period selection',
    'scopeStatus'
  )

  for (const profile of PROFILES) {
    const payload = makePayload(profile)
    payload.tables[0].table[profile.metricIds.revenue][0] = null
    const result = parse(profile, payload)
    const point = pointFor(result, 'revenue', profile.periods[0].reportPeriod)
    assert.equal(point.value, null, `${profile.label}: provider null remains null`)
    assert.equal(point.availability, 'missing', `${profile.label}: provider null is missing`)
    assert.equal(point.currency, profile.currency, `${profile.label}: null is not currency-filled`)
  }

  const hk = PROFILES[0]
  const missingCurrencyEvidenceResult = parseIfindMarketFinancials({
    caseId: hk.caseId,
    payload: makePayload(hk),
    verification: verified()
  })
  assertUnavailable(
    missingCurrencyEvidenceResult,
    'missing financial reporting currency evidence',
    'currencyStatus'
  )
  assert.equal(JSON.stringify(missingCurrencyEvidenceResult).includes('HKD'), false)

  const unverifiedCurrencyEvidenceResult = parse(
    hk,
    makePayload(hk),
    verified(),
    reportingCurrencyEvidence(hk, { currency: null, evidenceStatus: 'unverified' })
  )
  assertUnavailable(unverifiedCurrencyEvidenceResult, 'unverified reporting currency evidence')
  assert.equal(unverifiedCurrencyEvidenceResult.verification.currencyStatus, 'unverified')

  const mismatchedCurrencyEvidenceResult = parse(
    hk,
    makePayload(hk),
    verified(),
    reportingCurrencyEvidence(hk, { currency: 'HKD' })
  )
  assertUnavailable(
    mismatchedCurrencyEvidenceResult,
    'provider currency differs from verified reporting currency evidence',
    'currencyStatus'
  )

  const rejectionCases = [
    {
      label: 'mismatched provider code',
      failedField: 'vendorCodeStatus',
      mutate(payload) { payload.tables[0].thscode = 'TEST_ONLY_WRONG_CODE' }
    },
    {
      label: 'incompatible unit',
      failedField: 'unitStatus',
      mutate(payload) { payload.tables[0].table[hk.metadataIds.unit][1] = 'thousand' }
    },
    {
      label: 'currency mismatch',
      failedField: 'currencyStatus',
      mutate(payload) { payload.tables[0].table[hk.metadataIds.currency][0] = 'USD' }
    },
    {
      label: 'period mismatch',
      failedField: 'reportPeriodStatus',
      mutate(payload) { payload.tables[0].table[hk.metadataIds.reportDate][2] = '2025-03-31' }
    },
    {
      label: 'duplicate metric-period points',
      failedField: 'reportPeriodStatus',
      mutate(payload) {
        for (const id of Object.values(hk.metadataIds)) {
          payload.tables[0].table[id][1] = payload.tables[0].table[id][0]
        }
      }
    },
    {
      label: 'wrong disclosure scope',
      failedField: 'scopeStatus',
      mutate(payload) { payload.tables[0].table[hk.metadataIds.disclosureScope][0] = 'issuer_only' }
    },
    {
      label: 'mixed source',
      failedField: 'sourceMode',
      mutate(payload) { payload.tables[0].table[hk.metadataIds.sourceMode][2] = 'Mock' }
    },
    {
      label: 'non-finite value',
      failedField: 'scopeStatus',
      mutate(payload) { payload.tables[0].table[hk.metricIds.revenue][0] = Number.POSITIVE_INFINITY }
    },
    {
      label: 'provider rejection',
      failedField: 'entitlementStatus',
      mutate(payload) { payload.errorcode = -4301 }
    }
  ]

  for (const testCase of rejectionCases) {
    const payload = makePayload(hk)
    testCase.mutate(payload)
    const result = parse(hk, payload)
    assertUnavailable(result, testCase.label, testCase.failedField)
  }

  const verificationCases = [
    ['unverified issuer identity', verified({ issuerIdentityStatus: 'unverified' })],
    ['unverified vendor code', verified({ vendorCodeStatus: 'unverified' })],
    ['unverified entitlement', verified({ entitlementStatus: 'unverified' })],
    ['unverified currency', verified({ currencyStatus: 'unverified' })],
    ['unverified unit', verified({ unitStatus: 'unverified' })],
    ['unverified period', verified({ reportPeriodStatus: 'unverified' })],
    ['unverified scope', verified({ scopeStatus: 'unverified' })],
    ['non-real source context', verified({ sourceMode: 'unverified' })]
  ]
  for (const [label, verification] of verificationCases) {
    assertUnavailable(parse(hk, makePayload(hk), verification), label)
  }

  const strictShapeCases = [
    ['unknown case', () => ({ caseId: 'HK_UNKNOWN', payload: makePayload(hk), verification: verified() })],
    ['extra input field', () => ({
      caseId: hk.caseId,
      payload: makePayload(hk),
      verification: verified(),
      rawMetadata: 'raw-provider-sentinel'
    })],
    ['extra payload field', () => {
      const payload = makePayload(hk)
      payload.errmsg = 'raw-provider-sentinel'
      return {
        caseId: hk.caseId,
        payload,
        verification: verified(),
        financialReportingCurrencyEvidence: reportingCurrencyEvidence(hk)
      }
    }],
    ['extra provider table field', () => {
      const payload = makePayload(hk)
      payload.tables[0].rawSource = 'raw-provider-sentinel'
      return {
        caseId: hk.caseId,
        payload,
        verification: verified(),
        financialReportingCurrencyEvidence: reportingCurrencyEvidence(hk)
      }
    }],
    ['extra provider indicator', () => {
      const payload = makePayload(hk)
      payload.tables[0].table.TEST_ONLY_UNKNOWN = ['raw-provider-sentinel']
      return {
        caseId: hk.caseId,
        payload,
        verification: verified(),
        financialReportingCurrencyEvidence: reportingCurrencyEvidence(hk)
      }
    }]
  ]
  for (const [label, createInput] of strictShapeCases) {
    assertUnavailable(parseIfindMarketFinancials(createInput()), label)
  }

  let accessorInvoked = false
  const accessorInput = {
    payload: makePayload(hk),
    verification: verified(),
    financialReportingCurrencyEvidence: reportingCurrencyEvidence(hk)
  }
  Object.defineProperty(accessorInput, 'caseId', {
    enumerable: true,
    get() {
      accessorInvoked = true
      return hk.caseId
    }
  })
  assertUnavailable(parseIfindMarketFinancials(accessorInput), 'accessor input')
  assert.equal(accessorInvoked, false, 'accessor input: getter was not invoked')

  let nestedAccessorInvoked = false
  const nestedAccessorPayload = makePayload(hk)
  Object.defineProperty(nestedAccessorPayload.tables[0], 'table', {
    enumerable: true,
    get() {
      nestedAccessorInvoked = true
      return makePayload(hk).tables[0].table
    }
  })
  assertUnavailable(parse(hk, nestedAccessorPayload), 'nested accessor')
  assert.equal(nestedAccessorInvoked, false, 'nested accessor: getter was not invoked')

  const proxyCases = []
  for (const [label, target] of [
    ['proxied input', {
      caseId: hk.caseId,
      payload: makePayload(hk),
      verification: verified(),
      financialReportingCurrencyEvidence: reportingCurrencyEvidence(hk)
    }],
    ['proxied payload', makePayload(hk)],
    ['proxied tables array', makePayload(hk).tables]
  ]) {
    let trapInvoked = false
    const proxy = new Proxy(target, {
      getPrototypeOf() {
        trapInvoked = true
        throw new Error('proxy trap must not run')
      },
      getOwnPropertyDescriptor() {
        trapInvoked = true
        throw new Error('proxy trap must not run')
      }
    })
    proxyCases.push([label, proxy, () => trapInvoked])
  }
  for (const [label, proxy, wasTrapInvoked] of proxyCases) {
    let input
    if (label === 'proxied input') input = proxy
    else if (label === 'proxied payload') {
      input = {
        caseId: hk.caseId,
        payload: proxy,
        verification: verified(),
        financialReportingCurrencyEvidence: reportingCurrencyEvidence(hk)
      }
    } else {
      const payload = makePayload(hk)
      payload.tables = proxy
      input = {
        caseId: hk.caseId,
        payload,
        verification: verified(),
        financialReportingCurrencyEvidence: reportingCurrencyEvidence(hk)
      }
    }
    assertUnavailable(parseIfindMarketFinancials(input), label)
    assert.equal(wasTrapInvoked(), false, `${label}: proxy traps were not invoked`)
  }

  const revoked = Proxy.revocable(makePayload(hk), {})
  revoked.revoke()
  assertUnavailable(parseIfindMarketFinancials({
    caseId: hk.caseId,
    payload: revoked.proxy,
    verification: verified(),
    financialReportingCurrencyEvidence: reportingCurrencyEvidence(hk)
  }), 'revoked payload')

  let inheritedGetterInvoked = false
  const hostilePrototype = {}
  Object.defineProperty(hostilePrototype, 'caseId', {
    get() {
      inheritedGetterInvoked = true
      throw new Error('inherited getter must not run')
    }
  })
  const customPrototypeInput = Object.create(hostilePrototype)
  customPrototypeInput.payload = makePayload(hk)
  customPrototypeInput.verification = verified()
  customPrototypeInput.financialReportingCurrencyEvidence = reportingCurrencyEvidence(hk)
  assertUnavailable(parseIfindMarketFinancials(customPrototypeInput), 'custom prototype')
  assert.equal(inheritedGetterInvoked, false, 'custom prototype: inherited getter was not invoked')

  const malformedVerification = verified()
  malformedVerification.sourceMode = 'fixture'
  const malformedResult = parse(hk, makePayload(hk), malformedVerification)
  assertUnavailable(malformedResult, 'invalid verification vocabulary')
  assert.deepEqual(malformedResult.verification, unavailableVerification())

  for (const profile of PROFILES) {
    const marketCase = getIfindMarketCase(profile.caseId)
    assert.equal(marketCase.liveReady, false, `${profile.label}: production catalog remains closed`)
    assert.throws(
      () => createLiveRequestManifest(profile.caseId),
      (error) => error && error.code === 'IFIND_MARKET_CASE_UNVERIFIED',
      `${profile.label}: fixture evidence is not production evidence`
    )
  }
}

module.exports = { run }
