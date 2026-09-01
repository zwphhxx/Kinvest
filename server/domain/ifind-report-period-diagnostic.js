'use strict'

const { types } = require('node:util')
const { copyReportPeriodFailureEvidence } = require('./ifind-report-period-failure')

const REPORT_PERIOD_DIAGNOSTIC_ID = 'HK_ALIBABA_REPORT_PERIOD_20260331_SINGLE_QUARTER_V1'
const REPORT_PERIOD_DIAGNOSTIC_REQUEST = Object.freeze({
  codes: '9988.HK',
  indipara: Object.freeze([
    Object.freeze({ indicator: 'revenue_oas', indiparams: Object.freeze(['20260331', '1', 'BB']) }),
    Object.freeze({ indicator: 'report_sd', indiparams: Object.freeze(['20260331', '1']) }),
    Object.freeze({ indicator: 'report_ed', indiparams: Object.freeze(['20260331', '1']) })
  ])
})
const VERIFICATION_KEYS = Object.freeze([
  'issuerIdentityStatus', 'vendorCodeStatus', 'entitlementStatus',
  'currencyStatus', 'unitStatus', 'reportPeriodStatus', 'scopeStatus'
])
const RESULT_KEYS = Object.freeze([
  'diagnosticId', 'caseId', 'displayCode', 'requestedSelector', 'indicators',
  'status', 'verification', 'observation', 'requestCount', 'businessRequestCount',
  'dataVol', 'attemptedAt', 'errorCode', 'failureEvidence'
])
const IDLE = new Set(['ready', 'busy', 'cooldown', 'daily-limit'])
const PREFIX = 'IFIND_REPORT_PERIOD_DIAGNOSTIC_'

class ReportPeriodDiagnosticContractError extends Error {
  constructor() {
    super('The iFinD report-period diagnostic result is invalid')
    this.name = 'ReportPeriodDiagnosticContractError'
    this.code = PREFIX + 'RESULT_INVALID'
  }
}

function invalid() { throw new ReportPeriodDiagnosticContractError() }

function record(value, allowed, required = allowed) {
  if (types.isProxy(value) || value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
      required.some((key) => !keys.includes(key))) invalid()
  const result = Object.create(null)
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    result[key] = descriptor.value
  }
  return result
}

function array(value, size) {
  if (types.isProxy(value) || !Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) invalid()
  const length = Reflect.getOwnPropertyDescriptor(value, 'length')
  if (!length || !Object.hasOwn(length, 'value') || length.value !== size ||
      Reflect.ownKeys(value).length !== size + 1) invalid()
  const result = []
  for (let index = 0; index < size; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    result.push(descriptor.value)
  }
  return result
}

function calendarDate(value) {
  if (typeof value !== 'string' || value.length !== 10 ||
      !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000-')) return false
  const time = Date.parse(value + 'T00:00:00.000Z')
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

function normalizeProviderCalendarDate(value) {
  if (value === null) return null
  if (typeof value !== 'string') invalid()
  const normalized = /^[0-9]{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : value
  if (!calendarDate(normalized)) invalid()
  return normalized
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length !== 24 ||
      !/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function validVolume(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0)
}

function dateAvailability(start, end) {
  return start !== null && end !== null ? 'present' : start !== null || end !== null ? 'partial' : 'missing'
}

function copyObservation(value) {
  const observed = record(value, ['returnedCode', 'revenue', 'dateEvidence'])
  if (observed.returnedCode !== '9988.HK') invalid()
  const revenue = record(observed.revenue, ['value', 'availability'])
  if (revenue.value === null) {
    if (revenue.availability !== 'missing') invalid()
  } else if (typeof revenue.value !== 'number' || !Number.isFinite(revenue.value) ||
      revenue.availability !== 'present') invalid()
  const dates = record(observed.dateEvidence, [
    'requestedDataType', 'start', 'end', 'availability', 'revenuePeriodLink'
  ])
  if (dates.requestedDataType !== 'single-quarter' || dates.revenuePeriodLink !== 'unverified' ||
      (dates.start !== null && !calendarDate(dates.start)) ||
      (dates.end !== null && !calendarDate(dates.end)) ||
      (dates.start !== null && dates.end !== null && dates.start > dates.end) ||
      dates.availability !== dateAvailability(dates.start, dates.end)) invalid()
  return {
    returnedCode: '9988.HK',
    revenue: { value: revenue.value, availability: revenue.availability },
    dateEvidence: {
      requestedDataType: 'single-quarter', start: dates.start, end: dates.end,
      availability: dates.availability, revenuePeriodLink: 'unverified'
    }
  }
}

function createInitialReportPeriodDiagnosticResult() {
  return {
    diagnosticId: REPORT_PERIOD_DIAGNOSTIC_ID,
    caseId: 'HK_ALIBABA_9988',
    displayCode: '9988.HK',
    requestedSelector: '20260331',
    indicators: REPORT_PERIOD_DIAGNOSTIC_REQUEST.indipara.map((item) => ({
      indicator: item.indicator, parameters: [...item.indiparams]
    })),
    status: 'ready',
    verification: Object.fromEntries(VERIFICATION_KEYS.map((key) => [key, 'unverified'])),
    observation: null,
    requestCount: 0,
    businessRequestCount: 0,
    dataVol: null,
    attemptedAt: null,
    errorCode: null,
    failureEvidence: null
  }
}

function copyReportPeriodDiagnosticResult(value) {
  try {
    const input = record(value, RESULT_KEYS)
    const failureEvidence = copyReportPeriodFailureEvidence(input.failureEvidence)
    if (failureEvidence !== null && (input.status !== 'failed' ||
        input.requestCount !== (failureEvidence.stage === 'auth' ? 1 : 2))) invalid()
    if (input.diagnosticId !== REPORT_PERIOD_DIAGNOSTIC_ID || input.caseId !== 'HK_ALIBABA_9988' ||
        input.displayCode !== '9988.HK' || input.requestedSelector !== '20260331') invalid()
    const indicators = array(input.indicators, 3).map((value, index) => {
      const item = record(value, ['indicator', 'parameters'])
      const expected = REPORT_PERIOD_DIAGNOSTIC_REQUEST.indipara[index]
      const parameters = array(item.parameters, expected.indiparams.length)
      if (item.indicator !== expected.indicator ||
          parameters.some((parameter, index) => parameter !== expected.indiparams[index])) invalid()
      return { indicator: expected.indicator, parameters: [...expected.indiparams] }
    })
    const verification = record(input.verification, VERIFICATION_KEYS)
    for (const key of VERIFICATION_KEYS) if (verification[key] !== 'unverified') invalid()
    if (!Number.isSafeInteger(input.requestCount) || input.requestCount < 0 || input.requestCount > 2 ||
        !Number.isSafeInteger(input.businessRequestCount) ||
        input.businessRequestCount !== (input.requestCount === 2 ? 1 : 0) ||
        !validVolume(input.dataVol) || (input.dataVol !== null && input.businessRequestCount !== 1) ||
        (input.attemptedAt !== null && !canonicalTimestamp(input.attemptedAt)) ||
        (input.requestCount > 0 && input.attemptedAt === null)) invalid()
    const observation = input.observation === null ? null : copyObservation(input.observation)
    if (IDLE.has(input.status)) {
      if (observation !== null || input.requestCount !== 0 || input.dataVol !== null ||
          input.attemptedAt !== null || input.errorCode !== null) invalid()
    } else if (input.status === 'observed-unverified') {
      if (observation === null || input.requestCount !== 2 ||
          input.errorCode !== PREFIX + 'OBSERVED_UNVERIFIED') invalid()
    } else if (input.status === 'failed' || input.status === 'unavailable') {
      if (observation !== null || input.errorCode !== PREFIX +
          (input.status === 'failed' ? 'FAILED' : 'UNAVAILABLE')) invalid()
    } else invalid()
    return {
      diagnosticId: REPORT_PERIOD_DIAGNOSTIC_ID,
      caseId: 'HK_ALIBABA_9988',
      displayCode: '9988.HK',
      requestedSelector: '20260331',
      indicators,
      status: input.status,
      verification: Object.fromEntries(VERIFICATION_KEYS.map((key) => [key, 'unverified'])),
      observation,
      requestCount: input.requestCount,
      businessRequestCount: input.businessRequestCount,
      dataVol: input.dataVol,
      attemptedAt: input.attemptedAt,
      errorCode: input.errorCode,
      failureEvidence
    }
  } catch {
    // Do not expose proxy traps, getters, raw provider values or exceptions.
    throw new ReportPeriodDiagnosticContractError()
  }
}

function parseReportPeriodDiagnosticObservation(payload) {
  try {
    const response = record(payload, ['errorcode', 'tables', 'dataVol'], ['errorcode', 'tables'])
    if (response.errorcode !== 0 || (Object.hasOwn(response, 'dataVol') && !validVolume(response.dataVol))) invalid()
    const row = record(array(response.tables, 1)[0], ['thscode', 'table'])
    if (row.thscode !== '9988.HK') invalid()
    const table = record(row.table, ['revenue_oas', 'report_sd', 'report_ed'], ['revenue_oas'])
    let value = array(table.revenue_oas, 1)[0]
    if (typeof value === 'string') {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.exec(value)
      if (value.length > 64 || !match || match[0] !== value) invalid()
      value = Number(value)
    }
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) invalid()
    const start = normalizeProviderCalendarDate(
      Object.hasOwn(table, 'report_sd') ? array(table.report_sd, 1)[0] : null
    )
    const end = normalizeProviderCalendarDate(
      Object.hasOwn(table, 'report_ed') ? array(table.report_ed, 1)[0] : null
    )
    // Date parameter 1 means single-quarter, not the revenue income-scope parameter.
    // Even matching returned dates cannot establish the revenue's actual period.
    return copyObservation({
      returnedCode: '9988.HK',
      revenue: { value, availability: value === null ? 'missing' : 'present' },
      dateEvidence: {
        requestedDataType: 'single-quarter', start, end,
        availability: dateAvailability(start, end), revenuePeriodLink: 'unverified'
      }
    })
  } catch {
    throw new ReportPeriodDiagnosticContractError()
  }
}

module.exports = {
  REPORT_PERIOD_DIAGNOSTIC_ID,
  REPORT_PERIOD_DIAGNOSTIC_REQUEST,
  createInitialReportPeriodDiagnosticResult,
  copyReportPeriodDiagnosticResult,
  parseReportPeriodDiagnosticObservation
}
