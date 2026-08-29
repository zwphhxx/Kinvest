'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  createLiveRequestManifest,
  getIfindMarketCase,
  listIfindMarketCases
} = require('../domain/ifind-market-cases')
const {
  validateLiveRequestManifestDefinition
} = require('../domain/ifind-market-manifest-validator')

const REQUIRED_QUOTE_METRICS = [
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
]

const REQUIRED_FINANCIAL_METRICS = [
  'revenue',
  'grossProfit',
  'attributableNetProfit',
  'operatingCashFlow',
  'receivables',
  'inventory',
  'interestBearingDebt'
]

const EXPECTED_CASES = [
  {
    caseId: 'HK_ALIBABA_9988',
    companyName: 'Alibaba',
    companyId: 'company-alibaba-group',
    listingId: 'listing-hkex-9988',
    issuerLegalName: 'Alibaba Group Holding Limited',
    exchange: 'HKEX',
    exchangeCode: '9988',
    displayCode: '9988.HK',
    formatAliases: ['09988.HK']
  },
  {
    caseId: 'US_APPLE_AAPL',
    companyName: 'Apple',
    companyId: 'company-apple',
    listingId: 'listing-nasdaq-aapl',
    issuerLegalName: 'Apple Inc.',
    exchange: 'NASDAQ',
    exchangeCode: 'AAPL',
    displayCode: 'AAPL.US',
    formatAliases: []
  },
  {
    caseId: 'CN_MOUTAI_600519',
    companyName: 'Kweichow Moutai',
    companyId: 'company-kweichow-moutai',
    listingId: 'listing-sse-600519',
    issuerLegalName: 'Kweichow Moutai Co., Ltd.',
    exchange: 'SSE',
    exchangeCode: '600519',
    displayCode: '600519.SH',
    formatAliases: []
  }
]

function assertDeepFrozen(value) {
  assert.equal(Object.isFrozen(value), true)
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') assertDeepFrozen(nested)
  }
}

function verifiedIndicator(metric, family) {
  return {
    metric,
    vendorIndicatorId: `FIXTURE_${family}_${metric}`,
    evidenceStatus: 'verified'
  }
}

function completeVerifiedManifestDefinition() {
  const quote = REQUIRED_QUOTE_METRICS.map((metric) => verifiedIndicator(metric, 'QUOTE'))
  const financial = REQUIRED_FINANCIAL_METRICS.map((metric) => verifiedIndicator(metric, 'FINANCIAL'))
  return {
    vendorCodes: {
      ifind: {
        code: 'FIXTURE_VENDOR_CODE',
        evidenceStatus: 'verified'
      }
    },
    requestTemplates: {
      quote: {
        endpoint: '/api/v1/real_time_quotation',
        fields: quote.map((indicator) => indicator.vendorIndicatorId),
        evidenceStatus: 'verified'
      },
      financial: {
        endpoint: '/api/v1/basic_data_service',
        indicatorIds: financial.map((indicator) => indicator.vendorIndicatorId),
        evidenceStatus: 'verified'
      }
    },
    indicators: { quote, financial },
    periodRules: {
      fullFiscalYears: 2,
      includeLatestDisclosedInterim: true,
      vendorParameters: {
        fullFiscalYears: {
          count: 2,
          requestParameters: { reportPeriod: 'FIXTURE_ANNUAL' }
        },
        latestDisclosedInterim: {
          enabled: true,
          requestParameters: { reportPeriod: 'FIXTURE_INTERIM' }
        }
      },
      evidenceStatus: 'verified'
    }
  }
}

function removeMetric(family, metric) {
  return (manifest) => {
    manifest.indicators[family] = manifest.indicators[family]
      .filter((indicator) => indicator.metric !== metric)
  }
}

function assertInvalidManifest(candidate, name) {
  assert.throws(
    () => validateLiveRequestManifestDefinition(candidate),
    (error) => error && error.code === 'IFIND_MARKET_MANIFEST_INVALID',
    name
  )
}

async function run() {
  assert.equal(validateLiveRequestManifestDefinition(completeVerifiedManifestDefinition()), true)

  const corruptions = [
    ...REQUIRED_QUOTE_METRICS.map((metric) => [
      `missing quote metric ${metric}`,
      removeMetric('quote', metric)
    ]),
    ...REQUIRED_FINANCIAL_METRICS.map((metric) => [
      `missing financial metric ${metric}`,
      removeMetric('financial', metric)
    ]),
    ['empty quote evidence', (manifest) => { manifest.indicators.quote = [] }],
    ['empty financial evidence', (manifest) => { manifest.indicators.financial = [] }],
    ['empty quote request fields', (manifest) => { manifest.requestTemplates.quote.fields = [] }],
    ['empty financial request IDs', (manifest) => { manifest.requestTemplates.financial.indicatorIds = [] }],
    ['mismatched quote request ID', (manifest) => { manifest.requestTemplates.quote.fields[0] = 'FIXTURE_MISMATCH' }],
    ['mismatched financial request ID', (manifest) => { manifest.requestTemplates.financial.indicatorIds[0] = 'FIXTURE_MISMATCH' }],
    ['whitespace quote provider ID', (manifest) => {
      manifest.indicators.quote[0].vendorIndicatorId = '   '
      manifest.requestTemplates.quote.fields[0] = '   '
    }],
    ['whitespace financial provider ID', (manifest) => {
      manifest.indicators.financial[0].vendorIndicatorId = '\t'
      manifest.requestTemplates.financial.indicatorIds[0] = '\t'
    }],
    ['duplicate quote provider ID', (manifest) => {
      manifest.indicators.quote[1].vendorIndicatorId = manifest.indicators.quote[0].vendorIndicatorId
      manifest.requestTemplates.quote.fields[1] = manifest.requestTemplates.quote.fields[0]
    }],
    ['extra quote metric', (manifest) => {
      manifest.indicators.quote.push(verifiedIndicator('unapprovedMetric', 'QUOTE'))
      manifest.requestTemplates.quote.fields.push('FIXTURE_QUOTE_unapprovedMetric')
    }],
    ['missing period parameters', (manifest) => { delete manifest.periodRules.vendorParameters }],
    ['undefined period parameters', (manifest) => { manifest.periodRules.vendorParameters = undefined }],
    ['primitive period parameters', (manifest) => { manifest.periodRules.vendorParameters = true }],
    ['empty annual request parameters', (manifest) => {
      manifest.periodRules.vendorParameters.fullFiscalYears.requestParameters = {}
    }],
    ['missing interim period parameters', (manifest) => {
      delete manifest.periodRules.vendorParameters.latestDisclosedInterim.requestParameters
    }],
    ['undefined provider parameter', (manifest) => {
      manifest.periodRules.vendorParameters.fullFiscalYears.requestParameters.reportPeriod = undefined
    }],
    ['unrelated provider schema field', (manifest) => {
      manifest.periodRules.vendorParameters.unrelated = 'configured'
    }],
    ['non-plain period parameters', (manifest) => {
      manifest.periodRules.vendorParameters = new Date(0)
    }],
    ['proxied period parameters', (manifest) => {
      manifest.periodRules.vendorParameters = new Proxy(
        manifest.periodRules.vendorParameters,
        {}
      )
    }],
    ['proxied request fields', (manifest) => {
      manifest.requestTemplates.quote.fields = new Proxy(
        manifest.requestTemplates.quote.fields,
        {}
      )
    }],
    ['array subclass request fields', (manifest) => {
      class FixtureArray extends Array {}
      manifest.requestTemplates.quote.fields = new FixtureArray(
        ...manifest.requestTemplates.quote.fields
      )
    }],
    ['replaced request array prototype', (manifest) => {
      Object.setPrototypeOf(
        manifest.requestTemplates.quote.fields,
        Object.create(Array.prototype)
      )
    }],
    ['whitespace vendor code', (manifest) => { manifest.vendorCodes.ifind.code = '  ' }],
    ['missing quote template', (manifest) => { delete manifest.requestTemplates.quote }],
    ['primitive indicators', (manifest) => { manifest.indicators = 'verified' }]
  ]

  for (const [name, corrupt] of corruptions) {
    const manifest = completeVerifiedManifestDefinition()
    corrupt(manifest)
    assertInvalidManifest(manifest, name)
  }

  let accessorRead = false
  const accessorManifest = completeVerifiedManifestDefinition()
  Object.defineProperty(accessorManifest.periodRules, 'vendorParameters', {
    enumerable: true,
    get() {
      accessorRead = true
      return completeVerifiedManifestDefinition().periodRules.vendorParameters
    }
  })
  assertInvalidManifest(accessorManifest, 'accessor-backed period parameters')
  assert.equal(accessorRead, false)

  let nestedAccessorRead = false
  const nestedAccessorManifest = completeVerifiedManifestDefinition()
  Object.defineProperty(
    nestedAccessorManifest.periodRules.vendorParameters.fullFiscalYears.requestParameters,
    'reportPeriod',
    {
      enumerable: true,
      get() {
        nestedAccessorRead = true
        return 'FIXTURE_ANNUAL'
      }
    }
  )
  assertInvalidManifest(nestedAccessorManifest, 'nested accessor-backed parameter')
  assert.equal(nestedAccessorRead, false)

  let inheritedArrayAccessorRead = false
  const inheritedArrayAccessorManifest = completeVerifiedManifestDefinition()
  const hostileArrayPrototype = Object.create(Array.prototype)
  Object.defineProperty(hostileArrayPrototype, 'map', {
    get() {
      inheritedArrayAccessorRead = true
      throw new Error('must not read inherited array behavior')
    }
  })
  Object.setPrototypeOf(
    inheritedArrayAccessorManifest.requestTemplates.quote.fields,
    hostileArrayPrototype
  )
  assertInvalidManifest(inheritedArrayAccessorManifest, 'hostile inherited array accessor')
  assert.equal(inheritedArrayAccessorRead, false)

  const firstList = listIfindMarketCases()
  const secondList = listIfindMarketCases()

  assert.deepEqual(
    firstList.map((marketCase) => marketCase.caseId),
    EXPECTED_CASES.map((marketCase) => marketCase.caseId)
  )
  assert.equal(firstList.length, 3)
  assert.notStrictEqual(firstList, secondList)
  assert.notStrictEqual(firstList[0], secondList[0])
  assert.notStrictEqual(firstList[0].formatAliases, secondList[0].formatAliases)
  assert.notStrictEqual(firstList[0].vendorCodes, secondList[0].vendorCodes)

  const originalArrayMap = Array.prototype.map
  let inheritedMapInvoked = false
  Array.prototype.map = function hostileInheritedMap() {
    inheritedMapInvoked = true
    throw new Error('catalog cloning must not dispatch inherited array methods')
  }
  try {
    const safelyClonedList = listIfindMarketCases()
    assert.equal(safelyClonedList.length, 3)
    assert.equal(safelyClonedList[0].caseId, 'HK_ALIBABA_9988')
  } finally {
    Array.prototype.map = originalArrayMap
  }
  assert.equal(inheritedMapInvoked, false)

  for (const expected of EXPECTED_CASES) {
    const marketCase = getIfindMarketCase(expected.caseId)
    assert.ok(marketCase)
    for (const [field, value] of Object.entries(expected)) {
      assert.deepEqual(marketCase[field], value)
    }
    assert.ok(marketCase.companyId)
    assert.ok(marketCase.listingId)
    assert.ok(marketCase.issuerLegalName)
    assert.ok(marketCase.exchange)
    assert.ok(marketCase.exchangeCode)
    assert.ok(marketCase.displayCode)
    assert.ok(Array.isArray(marketCase.formatAliases))
    assert.equal(typeof marketCase.vendorCodes, 'object')
    assert.equal(marketCase.vendorCodes.ifind.code, null)
    assert.equal(marketCase.vendorCodes.ifind.evidenceStatus, 'unverified')
    assert.equal(marketCase.liveReady, false)
    assertDeepFrozen(marketCase)
  }

  assert.equal(getIfindMarketCase('HK_UNKNOWN_0000'), null)
  const invalidCaseIds = [
    '09888.HK',
    '',
    'x'.repeat(65),
    9988,
    null,
    undefined,
    { caseId: 'HK_ALIBABA_9988' }
  ]
  for (const invalidCaseId of invalidCaseIds) {
    const unsafeText = typeof invalidCaseId === 'string' && invalidCaseId.length > 0
      ? invalidCaseId
      : null
    for (const lookup of [getIfindMarketCase, createLiveRequestManifest]) {
      assert.throws(
        () => lookup(invalidCaseId),
        (error) => error &&
          error.code === 'IFIND_MARKET_CASE_ID_INVALID' &&
          !Object.hasOwn(error, 'caseId') &&
          (unsafeText === null || !String(error.message).includes(unsafeText))
      )
    }
  }

  let hostileCaseIdRead = false
  const hostileCaseId = {
    get toString() {
      hostileCaseIdRead = true
      throw new Error('must not read hostile case ID')
    }
  }
  assert.throws(
    () => getIfindMarketCase(hostileCaseId),
    (error) => error && error.code === 'IFIND_MARKET_CASE_ID_INVALID'
  )
  assert.equal(hostileCaseIdRead, false)
  assert.equal(firstList[0].formatAliases.includes('09988.HK'), true)
  assert.equal(firstList[0].formatAliases.includes('09888.HK'), false)
  assert.equal(
    firstList.some((marketCase) => marketCase.formatAliases.includes('09888.HK')),
    false
  )

  const hostileBrowserInput = {
    vendorCode: '09888.HK',
    endpoint: 'https://attacker.invalid',
    fields: ['attacker_field'],
    indicatorIds: ['TEST_ONLY_FIXTURE_ID'],
    periodRules: { type: 'attacker' },
    parserId: 'attacker-parser'
  }
  const pristineAlibaba = getIfindMarketCase('HK_ALIBABA_9988')
  const browserAttempt = getIfindMarketCase('HK_ALIBABA_9988', hostileBrowserInput)
  assert.deepEqual(browserAttempt, pristineAlibaba)
  assert.equal(JSON.stringify(browserAttempt).includes('attacker'), false)
  assert.equal(JSON.stringify(browserAttempt).includes('TEST_ONLY_FIXTURE_ID'), false)

  for (const marketCase of firstList) {
    assert.throws(
      () => createLiveRequestManifest(marketCase.caseId, hostileBrowserInput),
      (error) => error &&
        error.code === 'IFIND_MARKET_CASE_UNVERIFIED' &&
        error.caseId === marketCase.caseId
    )
  }

  assertDeepFrozen(firstList)
  assert.throws(() => {
    firstList[0].formatAliases.push('09888.HK')
  }, TypeError)
  assert.throws(() => {
    firstList[0].requestTemplates.quote.endpoint = 'https://attacker.invalid'
  }, TypeError)
  assert.deepEqual(listIfindMarketCases(), secondList)

  const evidencePath = path.resolve(
    __dirname,
    '../../docs/operations/ifind-three-market-indicator-evidence.md'
  )
  const evidence = fs.readFileSync(evidencePath, 'utf8')
  assert.match(evidence, /Verification date: 2026-08-29/)
  assert.match(evidence, /https:\/\/quantapi\.51ifind\.com\/gwstatic\/static\/ds_web\/quantapi-web\/help-center\/manual\.html/)
  assert.match(evidence, /https:\/\/quantapi\.51ifind\.com\/gwstatic\/static\/ds_web\/quantapi-web\/example\.html/)
  assert.match(evidence, /unverified/i)
  assert.doesNotMatch(evidence, /refresh[_ -]?token|access[_ -]?token|requestid/i)
  assert.doesNotMatch(evidence, /TEST_ONLY_FIXTURE_ID/)
  const confidentialAssignments = [
    /password\s*[:=]\s*["'`]?\S+/i,
    /client_secret\s*[:=]\s*["'`]?\S+/i,
    /authorization\s*[:=]\s*(?:bearer|basic)\s+\S+/i,
    /cookies?\s*[:=]\s*["'`]?\S+/i,
    /usernames?\s*[:=]\s*["'`]?\S+/i,
    /account[_ -]?id(?:entifier)?\s*[:=]\s*["'`]?\S+/i,
    /(?:request|response|raw)[_ -]?headers?\s*[:=]/i,
    /(?:raw[_ -]?payload|request[_ -]?body|response[_ -]?body)\s*[:=]/i
  ]
  for (const marker of confidentialAssignments) assert.doesNotMatch(evidence, marker)
  assert.match(evidence, /redacted evidence summary/i)
  assert.match(evidence, /no credentials, account identifiers, raw provider payloads/i)
}

module.exports = { run }
