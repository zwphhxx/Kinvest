'use strict'

const { types } = require('node:util')

const INVALID = 'IFIND_REPORT_PERIOD_EVIDENCE_INVALID'
const MISMATCH = 'IFIND_REPORT_PERIOD_MISMATCH'
const PERIOD_KEYS = Object.freeze(['type', 'start', 'end'])

class IfindReportPeriodEvidenceError extends Error {
  constructor(code = INVALID) {
    super('The iFinD report-period evidence is invalid')
    this.name = 'IfindReportPeriodEvidenceError'
    this.code = code === MISMATCH ? MISMATCH : INVALID
  }
}

function invalid(code = INVALID) {
  throw new IfindReportPeriodEvidenceError(code)
}

function dataRecord(value, keys) {
  // Reject proxies (including revoked proxies) before any reflective operation.
  if (types.isProxy(value) || value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const actual = Reflect.ownKeys(value)
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid()
  const result = Object.create(null)
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    result[key] = descriptor.value
  }
  return result
}

function dataArray(value, expectedLength) {
  if (types.isProxy(value) || !Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) invalid()
  const indices = Array.from({ length: expectedLength }, (_, index) => String(index))
  const keys = [...indices, 'length']
  const actual = Reflect.ownKeys(value)
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid()
  const length = Reflect.getOwnPropertyDescriptor(value, 'length')
  if (!length || !Object.hasOwn(length, 'value') || length.enumerable || length.value !== expectedLength) invalid()
  return indices.map((key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    return descriptor.value
  })
}

function calendarDate(value) {
  if (typeof value !== 'string' || value.length !== 10 || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false
  const milliseconds = Date.parse(value + 'T00:00:00.000Z')
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value
}

function copyPeriod(value) {
  if (value === null) return null
  const period = dataRecord(value, PERIOD_KEYS)
  if ((period.type !== 'quarter' && period.type !== 'fiscal-year') ||
      !calendarDate(period.start) || !calendarDate(period.end) || period.start > period.end) invalid()
  return { type: period.type, start: period.start, end: period.end }
}

function compareReportPeriods(expectedPeriod, actualPeriod) {
  // Validate both sides before treating a missing side as unknown.
  const expected = copyPeriod(expectedPeriod)
  const actual = copyPeriod(actualPeriod)
  if (expected === null || actual === null) return 'unverified'
  return expected.type === actual.type && expected.start === actual.start && expected.end === actual.end
    ? 'consistent' : 'mismatch'
}

function createPeriodEvidence(observedValue = null) {
  if (observedValue !== null && (typeof observedValue !== 'number' || !Number.isFinite(observedValue))) invalid()
  // These curated documents describe reference periods, not the vendor's response.
  // Fresh literals keep every mutable level detached from previous results.
  const references = [
    {
      id: 'ALIBABA_REVENUE_20250630_QUARTER',
      url: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2025/0829/2025082901541_c.pdf',
      publishedAt: '2025-08-29',
      pdfPages: [5, 6],
      period: { type: 'quarter', start: '2025-04-01', end: '2025-06-30' },
      currency: 'CNY', unit: 'million', revenue: 247652
    },
    {
      id: 'ALIBABA_REVENUE_20260331_QUARTER',
      url: 'https://www.alibabagroup.com/zh-HK/document-1991237455038119936',
      publishedAt: '2026-05-13',
      pdfPages: [],
      period: { type: 'quarter', start: '2026-01-01', end: '2026-03-31' },
      currency: 'CNY', unit: 'million', revenue: 243380
    },
    {
      id: 'ALIBABA_REVENUE_20260331_YEAR',
      url: 'https://www.alibabagroup.com/zh-HK/document-1991237455038119936',
      publishedAt: '2026-05-13',
      pdfPages: [],
      period: { type: 'fiscal-year', start: '2025-04-01', end: '2026-03-31' },
      currency: 'CNY', unit: 'million', revenue: 1023670
    }
  ]
  return {
    requestedSelector: '20260331',
    actualPeriod: null,
    decision: 'unverified',
    reasonCode: 'IFIND_REPORT_PERIOD_UNPROVEN',
    references,
    // Equality is a comparison signal only, never currency, unit, or period proof.
    comparisonOnly: references.filter((reference) => observedValue === reference.revenue * 1000000)
      .map((reference) => ({ sourceId: reference.id, signal: 'numerical-match-only' })),
    parameterEvidence: {
      source: 'ifind-supercommand-ui', observedAt: '2026-08-30',
      statementScope: { raw: '1', meaning: 'consolidated-statements' },
      currencyBasis: { raw: 'BB', meaning: 'original-currency' },
      currentMrqSelector: '8', frozenSelectorMapping: 'unproven'
    }
  }
}

function validateExactData(value, expected) {
  if (expected === null || typeof expected !== 'object') {
    if (value !== expected) invalid()
    return
  }
  if (Array.isArray(expected)) {
    const items = dataArray(value, expected.length)
    for (let index = 0; index < expected.length; index += 1) validateExactData(items[index], expected[index])
    return
  }
  const keys = Object.keys(expected)
  const input = dataRecord(value, keys)
  for (const key of keys) {
    if (key === 'period') {
      const comparison = compareReportPeriods(expected[key], input[key])
      if (comparison === 'mismatch') invalid(MISMATCH)
      if (comparison !== 'consistent') invalid()
    } else {
      validateExactData(input[key], expected[key])
    }
  }
}

function copyPeriodEvidence(value, observedValue = null) {
  const expected = createPeriodEvidence(observedValue)
  validateExactData(value, expected)
  // No caller-owned object, accessor, serialization hook, or source URL escapes.
  return expected
}

module.exports = {
  createPeriodEvidence,
  copyPeriodEvidence,
  compareReportPeriods,
  IfindReportPeriodEvidenceError
}
