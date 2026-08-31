'use strict'

const { types } = require('node:util')
const { isClientFailureMetadata } = require('../contracts/ifind-diagnostic-errors')

const MISSING = Symbol('missing')
const INVALID = Symbol('invalid')
const SHAPE_RULES = Object.freeze({
  tablesShape: ['missing', 'invalid', 'empty', 'single', 'multiple'],
  rowShape: ['unavailable', 'invalid', 'exact', 'extra-fields'],
  identityShape: ['unavailable', 'missing', 'match', 'mismatch', 'invalid'],
  columnShape: ['unavailable', 'invalid', 'known-only', 'extra-fields']
})
const VALUE_SHAPES = Object.freeze(['unavailable', 'missing', 'invalid', 'empty-array',
  'multiple-values', 'null', 'number', 'decimal-string', 'iso-date', 'compact-date',
  'datetime', 'other-string', 'object', 'array', 'boolean', 'unsupported'])
const VALUE_KEYS = ['revenueShape', 'reportStartShape', 'reportEndShape']
const SHAPE_KEYS = [...Object.keys(SHAPE_RULES), ...VALUE_KEYS]
const FAILURE_KEYS = ['stage', 'failureCode', 'errorClass', 'vendorErrorCode', 'responseShape']

class ReportPeriodFailureContractError extends Error {
  constructor() {
    super('The iFinD report-period failure evidence is invalid')
    this.code = 'IFIND_REPORT_PERIOD_FAILURE_INVALID'
  }
}

function invalid() { throw new ReportPeriodFailureContractError() }

function plain(value) {
  if (types.isProxy(value) || value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

function own(value, key) {
  if (types.isProxy(value) || value === null || typeof value !== 'object') return INVALID
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
  if (!descriptor) return MISSING
  return Object.hasOwn(descriptor, 'value') && descriptor.enumerable ? descriptor.value : INVALID
}

/** @returns {any} Descriptor-only, exact-key defensive copy. */
function exact(value, keys) {
  if (!plain(value)) invalid()
  const found = Reflect.ownKeys(value)
  if (found.length !== keys.length || found.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid()
  const result = {}
  for (const key of keys) {
    const field = own(value, key)
    if (field === INVALID || field === MISSING) invalid()
    result[key] = field
  }
  return result
}

function arrayLength(value) {
  if (types.isProxy(value) || !Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) return null
  const descriptor = Reflect.getOwnPropertyDescriptor(value, 'length')
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null
  const length = descriptor.value
  if (!Number.isSafeInteger(length) || length < 0) return null
  const keys = Reflect.ownKeys(value)
  if (keys.length !== length + 1 || keys.some((key) => key !== 'length' &&
    (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) return null
  return length
}

function extraFields(value, allowed) {
  return Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.includes(key))
}

// Describe types and cardinalities only. Never retain raw values or unknown key names.
function valueShape(value) {
  if (value === MISSING) return 'missing'
  const length = arrayLength(value)
  if (length === null) return 'invalid'
  if (length === 0) return 'empty-array'
  if (length > 1) return 'multiple-values'
  const item = own(value, '0')
  if (item === INVALID || item === MISSING || types.isProxy(item)) return 'invalid'
  if (item === null) return 'null'
  if (typeof item === 'number') return Number.isFinite(item) ? 'number' : 'unsupported'
  if (typeof item === 'boolean') return 'boolean'
  if (typeof item === 'string') {
    if (item.length > 64) return 'other-string'
    if (/^[0-9]{8}$/.test(item)) return 'compact-date'
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(item)) return 'iso-date'
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}/.test(item)) return 'datetime'
    if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(item)) return 'decimal-string'
    return 'other-string'
  }
  if (Array.isArray(item)) return 'array'
  if (plain(item)) return 'object'
  return 'unsupported'
}

function summarizeReportPeriodResponse(value) {
  const result = { tablesShape: 'invalid', rowShape: 'unavailable', identityShape: 'unavailable',
    columnShape: 'unavailable', revenueShape: 'unavailable', reportStartShape: 'unavailable',
    reportEndShape: 'unavailable' }
  if (!plain(value)) return result
  const tables = own(value, 'tables')
  if (tables === MISSING) { result.tablesShape = 'missing'; return result }
  const length = arrayLength(tables)
  if (length === null) return result
  result.tablesShape = length === 0 ? 'empty' : length === 1 ? 'single' : 'multiple'
  if (length !== 1) return result
  const row = own(tables, '0')
  if (!plain(row)) { result.rowShape = 'invalid'; return result }
  result.rowShape = extraFields(row, ['thscode', 'table']) ? 'extra-fields' : 'exact'
  const identity = own(row, 'thscode')
  result.identityShape = identity === MISSING ? 'missing' : typeof identity !== 'string' ? 'invalid' :
    identity === '9988.HK' ? 'match' : 'mismatch'
  const columns = own(row, 'table')
  if (!plain(columns)) { result.columnShape = 'invalid'; return result }
  result.columnShape = extraFields(columns, ['revenue_oas', 'report_sd', 'report_ed']) ? 'extra-fields' : 'known-only'
  result.revenueShape = valueShape(own(columns, 'revenue_oas'))
  result.reportStartShape = valueShape(own(columns, 'report_sd'))
  result.reportEndShape = valueShape(own(columns, 'report_ed'))
  return result
}

function copyResponseShape(value) {
  const result = exact(value, SHAPE_KEYS)
  for (const key of Object.keys(SHAPE_RULES)) if (!SHAPE_RULES[key].includes(result[key])) invalid()
  for (const key of VALUE_KEYS) if (!VALUE_SHAPES.includes(result[key])) invalid()
  if (result.tablesShape !== 'single' && SHAPE_KEYS.slice(1).some((key) => result[key] !== 'unavailable')) invalid()
  if (result.rowShape === 'invalid' && SHAPE_KEYS.slice(2).some((key) => result[key] !== 'unavailable')) invalid()
  if (['unavailable', 'invalid'].includes(result.columnShape) && VALUE_KEYS.some((key) => result[key] !== 'unavailable')) invalid()
  return result
}

function copyReportPeriodFailureEvidence(value) {
  if (value === null) return null
  const result = exact(value, FAILURE_KEYS)
  if (!['auth', 'financial'].includes(result.stage) || !isClientFailureMetadata(result)) invalid()
  if (result.stage === 'auth' && result.responseShape !== null) invalid()
  result.responseShape = result.responseShape === null ? null : copyResponseShape(result.responseShape)
  return result
}

function createReportPeriodFailureEvidence(error, stage) {
  try {
    const failureCode = own(error, 'failureCode')
    const sourceStage = own(error, 'stage')
    if (own(error, 'code') !== failureCode || (sourceStage !== MISSING && sourceStage !== stage)) return null
    const evidence = { stage, failureCode, errorClass: own(error, 'class'),
      vendorErrorCode: own(error, 'vendorErrorCode'), responseShape: null }
    let responseShape = null
    if (stage === 'financial') {
      try { responseShape = copyResponseShape(own(error, 'responseShape')) } catch { /* Ignore untrusted shape. */ }
    }
    return copyReportPeriodFailureEvidence({ ...evidence, responseShape })
  } catch { return null }
}

module.exports = { summarizeReportPeriodResponse, copyReportPeriodFailureEvidence,
  createReportPeriodFailureEvidence }
