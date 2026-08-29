'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  createLiveRequestManifest,
  getIfindMarketCase,
  listIfindMarketCases
} = require('../domain/ifind-market-cases')

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

async function run() {
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

  assert.equal(getIfindMarketCase('UNKNOWN_CASE'), null)
  assert.equal(getIfindMarketCase('09888.HK'), null)
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
}

module.exports = { run }
