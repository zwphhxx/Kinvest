'use strict'

const { types } = require('node:util')

/** @typedef {'envelope-record' | 'envelope-fields' | 'metadata-errmsg' | 'metadata-perf' | 'metadata-datatype' | 'metadata-inputParams' | 'errorcode-type' | 'data-volume-type' | 'success-envelope'} IfindProbeEnvelopeRejectionRule */
/** @typedef {'errorcode' | 'tables' | 'dataVol' | 'errmsg' | 'perf' | 'datatype' | 'inputParams' | 'indicators' | 'time' | 'thscode' | 'data'} IfindProbeEnvelopeField */
/** @typedef {'missing' | 'null' | 'boolean' | 'integer' | 'number' | 'string' | 'array' | 'object' | 'accessor' | 'other' | 'uninspectable'} IfindProbeEnvelopeFieldType */
/** @typedef {Exclude<IfindProbeEnvelopeFieldType, 'missing' | 'accessor'>} IfindProbeEnvelopeType */
/** @typedef {{rejectionRule: IfindProbeEnvelopeRejectionRule, envelopeType: IfindProbeEnvelopeType, fields: Record<IfindProbeEnvelopeField, IfindProbeEnvelopeFieldType>, unknownFieldCount: number | null}} IfindProbeEnvelopeSummary */

const IFIND_PROBE_ENVELOPE_SUMMARY_INVALID = 'IFIND_PROBE_ENVELOPE_SUMMARY_INVALID'
/** @type {ReadonlyArray<IfindProbeEnvelopeField>} */
const IFIND_PROBE_ENVELOPE_FIELDS = Object.freeze(['errorcode', 'tables', 'dataVol',
  'errmsg', 'perf', 'datatype', 'inputParams', 'indicators', 'time', 'thscode', 'data'])
const SUMMARY_KEYS = Object.freeze(['rejectionRule', 'envelopeType', 'fields', 'unknownFieldCount'])
const RULES = new Set(['envelope-record', 'envelope-fields', 'metadata-errmsg',
  'metadata-perf', 'metadata-datatype', 'metadata-inputParams', 'errorcode-type',
  'data-volume-type', 'success-envelope'])
const FIELD_TYPES = new Set(['missing', 'null', 'boolean', 'integer', 'number', 'string',
  'array', 'object', 'accessor', 'other', 'uninspectable'])
const ENVELOPE_TYPES = new Set([...FIELD_TYPES].filter((type) => type !== 'missing' && type !== 'accessor'))
const KNOWN_FIELDS = new Set(/** @type {ReadonlyArray<string>} */ (IFIND_PROBE_ENVELOPE_FIELDS))

/** @returns {never} */
function invalid() {
  throw Object.assign(new Error('The iFinD probe envelope summary is invalid'), {
    code: IFIND_PROBE_ENVELOPE_SUMMARY_INVALID
  })
}

/** @param {unknown} value @returns {IfindProbeEnvelopeType} */
function valueType(value) {
  if (types.isProxy(value)) return 'uninspectable'
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean': return 'boolean'
    case 'number': return Number.isInteger(value) ? 'integer' : 'number'
    case 'string': return 'string'
    case 'object': return Array.isArray(value) ? 'array' : 'object'
    default: return 'other'
  }
}

/**
 * Capture only fixed type flags. Never traverse values, read accessors, coerce
 * objects, or inspect a proxy (including revoked proxies).
 * @param {unknown} response
 * @param {unknown} rejectionRule
 * @returns {IfindProbeEnvelopeSummary}
 */
function createIfindProbeEnvelopeSummary(response, rejectionRule) {
  if (typeof rejectionRule !== 'string' || !RULES.has(rejectionRule)) invalid()
  const envelopeType = valueType(response)
  const fields = /** @type {Record<IfindProbeEnvelopeField, IfindProbeEnvelopeFieldType>} */ ({})
  const fallback = envelopeType === 'uninspectable' ? 'uninspectable' : 'missing'
  for (const key of IFIND_PROBE_ENVELOPE_FIELDS) fields[key] = fallback
  let unknownFieldCount = null
  if (response !== null && typeof response === 'object' && !types.isProxy(response)) {
    // Only eleven descriptors are inspected; no descriptor value is traversed.
    for (const key of IFIND_PROBE_ENVELOPE_FIELDS) {
      try {
        const descriptor = Reflect.getOwnPropertyDescriptor(response, key)
        fields[key] = descriptor === undefined ? 'missing'
          : !Object.hasOwn(descriptor, 'value') ? 'accessor' : valueType(descriptor.value)
      } catch { fields[key] = 'uninspectable' }
    }
    try {
      unknownFieldCount = 0
      // Enumeration is shallow; stop counting at the overflow bucket. The HTTP
      // caller additionally enforces its unchanged 256 KiB response-size limit.
      for (const key of Reflect.ownKeys(response)) {
        if (typeof key !== 'string' || !KNOWN_FIELDS.has(key)) {
          unknownFieldCount += 1
          if (unknownFieldCount === 65) break
        }
      }
    } catch { unknownFieldCount = null }
  }
  return Object.freeze({
    rejectionRule: /** @type {IfindProbeEnvelopeRejectionRule} */ (rejectionRule),
    envelopeType, fields: Object.freeze(fields), unknownFieldCount
  })
}

/** @param {unknown} value @param {ReadonlyArray<string>} keys @returns {Record<string, unknown>} */
function exactRecord(value, keys) {
  if (types.isProxy(value) || value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== keys.length || keys.some((key) => !ownKeys.includes(key))) invalid()
  const result = Object.create(null)
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    result[key] = descriptor.value
  }
  return result
}

/** @param {unknown} value @returns {IfindProbeEnvelopeSummary} */
function copyIfindProbeEnvelopeSummary(value) {
  try {
    const input = exactRecord(value, SUMMARY_KEYS)
    if (typeof input.rejectionRule !== 'string' || !RULES.has(input.rejectionRule) ||
        typeof input.envelopeType !== 'string' || !ENVELOPE_TYPES.has(input.envelopeType) ||
        (input.unknownFieldCount !== null && (typeof input.unknownFieldCount !== 'number' ||
          !Number.isSafeInteger(input.unknownFieldCount) || input.unknownFieldCount < 0 ||
          input.unknownFieldCount > 65))) invalid()
    const sourceFields = exactRecord(input.fields, IFIND_PROBE_ENVELOPE_FIELDS)
    const fields = /** @type {Record<IfindProbeEnvelopeField, IfindProbeEnvelopeFieldType>} */ ({})
    for (const key of IFIND_PROBE_ENVELOPE_FIELDS) {
      const type = sourceFields[key]
      if (typeof type !== 'string' || !FIELD_TYPES.has(type)) invalid()
      fields[key] = /** @type {IfindProbeEnvelopeFieldType} */ (type)
    }
    return {
      rejectionRule: /** @type {IfindProbeEnvelopeRejectionRule} */ (input.rejectionRule),
      envelopeType: /** @type {IfindProbeEnvelopeType} */ (input.envelopeType),
      fields, unknownFieldCount: /** @type {number | null} */ (input.unknownFieldCount)
    }
  } catch { return invalid() }
}

module.exports = {
  IFIND_PROBE_ENVELOPE_SUMMARY_INVALID,
  IFIND_PROBE_ENVELOPE_FIELDS,
  createIfindProbeEnvelopeSummary,
  copyIfindProbeEnvelopeSummary
}
