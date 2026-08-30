'use strict'

const assert = require('node:assert/strict')

const HKEX = 'https://www1.hkexnews.hk/listedco/listconews/sehk/2025/0829/2025082901541_c.pdf'
const ALIBABA = 'https://www.alibabagroup.com/zh-HK/document-1991237455038119936'
const INVALID = 'IFIND_REPORT_PERIOD_EVIDENCE_INVALID'
const MISMATCH = 'IFIND_REPORT_PERIOD_MISMATCH'
let evidence

function expectedEvidence(value = null) {
  const references = [
    {
      id: 'ALIBABA_REVENUE_20250630_QUARTER', url: HKEX, publishedAt: '2025-08-29', pdfPages: [5, 6],
      period: { type: 'quarter', start: '2025-04-01', end: '2025-06-30' },
      currency: 'CNY', unit: 'million', revenue: 247652
    },
    {
      id: 'ALIBABA_REVENUE_20260331_QUARTER', url: ALIBABA, publishedAt: '2026-05-13', pdfPages: [],
      period: { type: 'quarter', start: '2026-01-01', end: '2026-03-31' },
      currency: 'CNY', unit: 'million', revenue: 243380
    },
    {
      id: 'ALIBABA_REVENUE_20260331_YEAR', url: ALIBABA, publishedAt: '2026-05-13', pdfPages: [],
      period: { type: 'fiscal-year', start: '2025-04-01', end: '2026-03-31' },
      currency: 'CNY', unit: 'million', revenue: 1023670
    }
  ]
  return {
    requestedSelector: '20260331', actualPeriod: null, decision: 'unverified',
    reasonCode: 'IFIND_REPORT_PERIOD_UNPROVEN', references,
    comparisonOnly: references.filter((reference) => value === reference.revenue * 1000000)
      .map((reference) => ({ sourceId: reference.id, signal: 'numerical-match-only' })),
    parameterEvidence: {
      source: 'ifind-supercommand-ui', observedAt: '2026-08-30',
      statementScope: { raw: '1', meaning: 'consolidated-statements' },
      currencyBasis: { raw: 'BB', meaning: 'original-currency' },
      currentMrqSelector: '8', frozenSelectorMapping: 'unproven'
    }
  }
}

/** @type {Array<[string, () => void]>} */
const tests = [
  ['focused evidence domain exports exist', () => {
    assert.doesNotThrow(() => { evidence = require('../domain/ifind-report-period-evidence') },
      'the focused report-period evidence domain must exist')
    for (const name of ['createPeriodEvidence', 'copyPeriodEvidence', 'compareReportPeriods',
      'IfindReportPeriodEvidenceError']) assert.equal(typeof evidence[name], 'function')
  }],
  ['curated primary sources and parameter semantics are exact and bounded', () => {
    assert.deepEqual(evidence.createPeriodEvidence(), expectedEvidence())
    assert.equal(JSON.stringify(evidence.createPeriodEvidence()).length < 2500, true)
  }],
  ['unknown periods are not mismatches and full known periods must agree', () => {
    const [june, march, year] = expectedEvidence().references.map((reference) => reference.period)
    assert.equal(evidence.compareReportPeriods(null, null), 'unverified')
    assert.equal(evidence.compareReportPeriods(june, null), 'unverified')
    assert.equal(evidence.compareReportPeriods(null, march), 'unverified')
    assert.equal(evidence.compareReportPeriods(march, { ...march }), 'consistent')
    assert.equal(evidence.compareReportPeriods(march, june), 'mismatch')
    assert.equal(evidence.compareReportPeriods(march, year), 'mismatch', 'same end date does not prove same period')
    assert.equal(evidence.compareReportPeriods(march, { ...march, start: '2026-02-01' }), 'mismatch')
    assert.equal(evidence.compareReportPeriods(march, { ...march, end: '2026-03-30' }), 'mismatch')
  }],
  ['malformed periods fail even when the other side is unknown', () => {
    const quarter = expectedEvidence().references[1].period
    for (const period of [undefined, [], '20260331', {}, { ...quarter, extra: true },
      { ...quarter, type: 'Q1' }, { ...quarter, start: '2026-02-30' },
      { ...quarter, start: '2026-04-01' }, { ...quarter, end: '20260331' }]) {
      assert.throws(() => evidence.compareReportPeriods(null, period), { code: INVALID })
      assert.throws(() => evidence.compareReportPeriods(period, null), { code: INVALID })
    }
  }],
  ['calendar validation distinguishes leap days from normalized invalid dates', () => {
    for (const year of ['1900', '2025', '2100']) {
      const period = { type: 'quarter', start: year + '-02-29', end: year + '-03-31' }
      assert.throws(() => evidence.compareReportPeriods(period, null), { code: INVALID })
    }
    for (const year of ['2000', '2024']) {
      const period = { type: 'quarter', start: year + '-02-29', end: year + '-03-31' }
      assert.equal(evidence.compareReportPeriods(period, { ...period }), 'consistent')
    }
  }],
  ['numerical matches remain comparison-only and never identify the returned period', () => {
    for (const value of [null, 0, 247652, 247652000001, 247652000000, 243380000000, 1023670000000]) {
      const result = evidence.createPeriodEvidence(value)
      assert.deepEqual(result, expectedEvidence(value))
      assert.equal(result.actualPeriod, null)
      assert.equal(result.decision, 'unverified')
      assert.deepEqual(evidence.copyPeriodEvidence(result, value), result)
    }
    for (const value of ['247652000000', NaN, Infinity, {}, []]) {
      assert.throws(() => evidence.createPeriodEvidence(value), { code: INVALID })
    }
  }],
  ['copied evidence is detached at every mutable level', () => {
    const source = evidence.createPeriodEvidence(247652000000)
    const copied = evidence.copyPeriodEvidence(source, 247652000000)
    source.references[0].period.start = '2026-01-01'
    source.references[0].pdfPages.push(99)
    source.references[0].url = 'https://untrusted.invalid/'
    source.comparisonOnly[0].sourceId = 'injected'
    source.parameterEvidence.currencyBasis.meaning = 'CNY'
    assert.deepEqual(copied, expectedEvidence(247652000000))
    copied.references.length = 0
    assert.deepEqual(evidence.createPeriodEvidence(), expectedEvidence())
  }],
  ['source integrity and no-promotion validation reject tampering', () => {
    const source = expectedEvidence(247652000000)
    const invalid = [
      { ...source, requestedSelector: '8' }, { ...source, actualPeriod: source.references[0].period },
      { ...source, decision: 'verified' }, { ...source, decision: 'mismatch' },
      { ...source, reasonCode: 'verified' }, { ...source, sourceUrl: HKEX },
      { ...source, comparisonOnly: [] },
      { ...source, comparisonOnly: [{ sourceId: source.references[1].id, signal: 'numerical-match-only' }] },
      { ...source, comparisonOnly: [{ sourceId: source.references[0].id, signal: 'verified' }] },
      { ...source, references: source.references.slice(1) },
      { ...source, parameterEvidence: { ...source.parameterEvidence, source: 'vendor-response' } },
      { ...source, parameterEvidence: { ...source.parameterEvidence, observedAt: '2026-08-31' } },
      { ...source, parameterEvidence: { ...source.parameterEvidence, currentMrqSelector: '20260331' } },
      { ...source, parameterEvidence: { ...source.parameterEvidence, frozenSelectorMapping: 'proven' } },
      { ...source, parameterEvidence: { ...source.parameterEvidence, currencyBasis: { raw: 'CNY', meaning: 'original-currency' } } },
      { ...source, parameterEvidence: { ...source.parameterEvidence, currencyBasis: { raw: 'BB', meaning: 'CNY' } } },
      { ...source, parameterEvidence: { ...source.parameterEvidence, statementScope: { raw: '2', meaning: 'consolidated-statements' } } },
      { ...source, parameterEvidence: { ...source.parameterEvidence, statementScope: { raw: '1', meaning: 'Q1' } } }
    ]
    /** @type {Array<[string, unknown]>} */
    const changes = [['url', 'https://untrusted.invalid/'], ['publishedAt', '2026-08-30'],
      ['currency', 'USD'], ['unit', 'yuan'], ['revenue', 1], ['id', 'injected'], ['pdfPages', [6]],
      ['period', null], ['copyrightedText', 'untrusted']]
    for (const [key, value] of changes) {
      const references = source.references.map((reference) => ({ ...reference }))
      references[0][key] = value
      invalid.push({ ...source, references })
    }
    for (const value of invalid) assert.throws(() => evidence.copyPeriodEvidence(value, 247652000000), { code: INVALID })
    assert.throws(() => evidence.copyPeriodEvidence(source, null), { code: INVALID })
  }],
  ['inconsistent known source periods fail closed with a stable mismatch code', () => {
    for (const period of [expectedEvidence().references[1].period, expectedEvidence().references[2].period]) {
      const result = expectedEvidence(247652000000)
      result.references[0].period = period
      assert.throws(() => evidence.copyPeriodEvidence(result, 247652000000), {
        code: MISMATCH, message: 'The iFinD report-period evidence is invalid'
      })
    }
  }],
  ['nested proxies, accessors, symbols, hidden fields and nonplain objects are rejected without execution', () => {
    let touches = 0
    const hostile = () => { touches += 1; throw new Error('must-not-expose') }
    const proxy = (value) => new Proxy(value, {
      get: hostile, getPrototypeOf: hostile, ownKeys: hostile, getOwnPropertyDescriptor: hostile
    })
    const invalid = [proxy(expectedEvidence()), Object.assign(Object.create({}), expectedEvidence())]
    for (const mutate of [
      (value) => { value.references = proxy(value.references) },
      (value) => { value.references[0] = proxy(value.references[0]) },
      (value) => { value.references[0].period = proxy(value.references[0].period) },
      (value) => { value.references[0].pdfPages = proxy(value.references[0].pdfPages) },
      (value) => { value.comparisonOnly = proxy(value.comparisonOnly) },
      (value) => { value.parameterEvidence.currencyBasis = proxy(value.parameterEvidence.currencyBasis) },
      (value) => { Object.defineProperty(value.references[0], 'url', { enumerable: true, get: hostile }) },
      (value) => { Object.defineProperty(value.references, '0', { enumerable: true, get: hostile }) },
      (value) => { Object.defineProperty(value.references[0].period, 'start', { enumerable: true, get: hostile }) },
      (value) => { Object.defineProperty(value.parameterEvidence, 'hidden', { value: true }) },
      (value) => { value.references[Symbol('hidden')] = true },
      (value) => { value.references[0].toJSON = hostile }
    ]) {
      const value = expectedEvidence()
      mutate(value)
      invalid.push(value)
    }
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    invalid.push(revoked.proxy)
    for (const value of invalid) assert.throws(() => evidence.copyPeriodEvidence(value), { code: INVALID })
    assert.throws(() => evidence.compareReportPeriods(null, proxy({})), { code: INVALID })
    assert.equal(touches, 0)
  }]
]

async function runIfindReportPeriodEvidenceTests() {
  for (const [name, test] of tests) {
    try { test() } catch (error) { error.message = name + ': ' + error.message; throw error }
  }
}

module.exports = { run: runIfindReportPeriodEvidenceTests, expectedEvidence }
