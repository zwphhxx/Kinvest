'use strict'

const { types } = require('node:util')

const IFIND_MARKET_PROBE_RESULT_INVALID = 'IFIND_MARKET_PROBE_RESULT_INVALID'
const PROPOSAL_ID = 'HK_ALIBABA_9988_V1'
const CASE_ID = 'HK_ALIBABA_9988'
const DISPLAY_CODE = '9988.HK'
const OBSERVED = 'IFIND_MARKET_PROBE_OBSERVED_UNVERIFIED'
const FAILED = 'IFIND_MARKET_PROBE_FAILED'
const UNAVAILABLE = 'IFIND_MARKET_PROBE_UNAVAILABLE'
const RESULT_KEYS = Object.freeze(['proposalId', 'caseId', 'displayCode', 'status', 'verification',
  'observations', 'requestCount', 'businessRequestCount', 'dataVol', 'attemptedAt',
  'errorCode', 'failureStage'])
const VERIFICATION_KEYS = Object.freeze(['issuerIdentityStatus', 'vendorCodeStatus',
  'entitlementStatus', 'currencyStatus', 'unitStatus', 'reportPeriodStatus', 'scopeStatus'])
const STAGES = Object.freeze(['identity', 'quote', 'financial'])
const FAILURE_STAGES = new Set(['provider', 'auth', ...STAGES, 'lease'])
const IDLE_STATUSES = new Set(['ready', 'busy', 'cooldown', 'daily-limit'])
const FIELD_KEYS = Object.freeze({
  identity: Object.freeze(['ths_stock_short_name_stock']),
  quote: Object.freeze(['latest', 'preClose', 'open', 'high', 'low', 'amount', 'volume',
    'tradeDate', 'tradeTime']),
  financial: Object.freeze(['revenue_oas'])
})
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

class IfindMarketProbeResultContractError extends Error {
  constructor() {
    super('The iFinD market probe result is invalid')
    this.name = 'IfindMarketProbeResultContractError'
    this.code = IFIND_MARKET_PROBE_RESULT_INVALID
  }
}

function invalid() { throw new IfindMarketProbeResultContractError() }

function record(value, allowed, required = allowed) {
  if (types.isProxy(value) || value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string' || DANGEROUS_KEYS.has(key) || !allowed.includes(key)) ||
      required.some((key) => !keys.includes(key))) invalid()
  const result = Object.create(null)
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    result[key] = descriptor.value
  }
  return result
}

function primitiveArray(value) {
  if (types.isProxy(value) || !Array.isArray(value) ||
      Reflect.getPrototypeOf(value) !== Array.prototype) invalid()
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length')
  const length = lengthDescriptor && lengthDescriptor.value
  if (!Number.isSafeInteger(length) || length < 0 || length > 64 ||
      Reflect.ownKeys(value).length !== length + 1) invalid()
  const result = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    const item = descriptor.value
    if (item === null || typeof item === 'boolean') result.push(item)
    else if (typeof item === 'number' && Number.isFinite(item)) result.push(item)
    else if (typeof item === 'string' && Buffer.byteLength(item, 'utf8') <= 256 &&
        !/[\p{Cc}\p{Cf}]/u.test(item)) result.push(item)
    else invalid()
  }
  return result
}

function copySummary(value, stage) {
  const summary = record(value, ['returnedCode', 'fields'])
  if (summary.returnedCode !== DISPLAY_CODE) invalid()
  const fields = record(summary.fields, FIELD_KEYS[stage])
  return {
    returnedCode: DISPLAY_CODE,
    fields: Object.fromEntries(FIELD_KEYS[stage].map((key) => [key, primitiveArray(fields[key])]))
  }
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length !== 24 ||
      !/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function emptyObservations() {
  return { identity: null, quote: null, financial: null }
}

function createInitialIfindMarketProbeResult() {
  return {
    proposalId: PROPOSAL_ID,
    caseId: CASE_ID,
    displayCode: DISPLAY_CODE,
    status: 'ready',
    verification: Object.fromEntries(VERIFICATION_KEYS.map((key) => [key, 'unverified'])),
    observations: emptyObservations(),
    requestCount: 0,
    businessRequestCount: 0,
    dataVol: null,
    attemptedAt: null,
    errorCode: null,
    failureStage: null
  }
}

function copyIfindMarketProbeResult(value) {
  try {
    const input = record(value, RESULT_KEYS)
    if (input.proposalId !== PROPOSAL_ID || input.caseId !== CASE_ID ||
        input.displayCode !== DISPLAY_CODE) invalid()
    const verification = record(input.verification, VERIFICATION_KEYS)
    for (const key of VERIFICATION_KEYS) if (verification[key] !== 'unverified') invalid()
    const sourceObservations = record(input.observations, STAGES)
    const observations = Object.fromEntries(STAGES.map((stage) => [stage,
      sourceObservations[stage] === null ? null : copySummary(sourceObservations[stage], stage)]))
    if (!Number.isSafeInteger(input.requestCount) || input.requestCount < 0 || input.requestCount > 4 ||
        !Number.isSafeInteger(input.businessRequestCount) ||
        input.businessRequestCount !== Math.max(0, input.requestCount - 1) ||
        (input.dataVol !== null && (!Number.isSafeInteger(input.dataVol) || input.dataVol < 0)) ||
        (input.businessRequestCount === 0 && input.dataVol !== null) ||
        (input.attemptedAt !== null && !canonicalTimestamp(input.attemptedAt))) invalid()

    if (IDLE_STATUSES.has(input.status)) {
      if (STAGES.some((stage) => observations[stage] !== null) || input.requestCount !== 0 ||
          input.dataVol !== null || input.attemptedAt !== null || input.errorCode !== null ||
          input.failureStage !== null) invalid()
    } else if (input.status === 'observed-unverified') {
      if (STAGES.some((stage) => observations[stage] === null) || input.requestCount !== 4 ||
          input.businessRequestCount !== 3 || input.attemptedAt === null ||
          input.errorCode !== OBSERVED || input.failureStage !== null) invalid()
    } else if (input.status === 'failed' || input.status === 'unavailable') {
      const expectedError = input.status === 'failed' ? FAILED : UNAVAILABLE
      if (input.errorCode !== expectedError || !FAILURE_STAGES.has(input.failureStage) ||
          (input.requestCount > 0 && input.attemptedAt === null)) invalid()
      let missingSeen = false
      for (let index = 0; index < STAGES.length; index += 1) {
        const present = observations[STAGES[index]] !== null
        if (present && (missingSeen || input.businessRequestCount < index + 1)) invalid()
        if (!present) missingSeen = true
      }
    } else invalid()

    return {
      proposalId: PROPOSAL_ID,
      caseId: CASE_ID,
      displayCode: DISPLAY_CODE,
      status: input.status,
      verification: Object.fromEntries(VERIFICATION_KEYS.map((key) => [key, 'unverified'])),
      observations,
      requestCount: input.requestCount,
      businessRequestCount: input.businessRequestCount,
      dataVol: input.dataVol,
      attemptedAt: input.attemptedAt,
      errorCode: input.errorCode,
      failureStage: input.failureStage
    }
  } catch {
    throw new IfindMarketProbeResultContractError()
  }
}

module.exports = {
  IFIND_MARKET_PROBE_RESULT_INVALID,
  IfindMarketProbeResultContractError,
  createInitialIfindMarketProbeResult,
  copyIfindMarketProbeResult
}
