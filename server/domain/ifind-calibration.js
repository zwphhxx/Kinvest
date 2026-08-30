'use strict'

const { types } = require('node:util')
const { createPeriodEvidence, copyPeriodEvidence } = require('./ifind-report-period-evidence')

const CALIBRATION_ID = 'HK_ALIBABA_REVENUE_OAS_20260331_V1'
const PARAMETERS = Object.freeze(['20260331', '1', 'BB'])
const CALIBRATION_REQUEST = Object.freeze({
  codes: '9988.HK',
  indipara: Object.freeze([
    Object.freeze({ indicator: 'revenue_oas', indiparams: PARAMETERS })
  ])
})
const VERIFICATION_KEYS = Object.freeze([
  'issuerIdentityStatus', 'vendorCodeStatus', 'entitlementStatus',
  'currencyStatus', 'unitStatus', 'reportPeriodStatus', 'scopeStatus'
])
const RESULT_KEYS = Object.freeze([
  'calibrationId', 'caseId', 'displayCode', 'indicator', 'parameters', 'status',
  'verification', 'periodEvidence', 'observation', 'requestCount', 'businessRequestCount',
  'dataVol', 'attemptedAt', 'errorCode'
])
const OBSERVATION_KEYS = Object.freeze([
  'value', 'availability', 'returnedCode', 'currency', 'unit', 'reportPeriod',
  'periodType', 'disclosureScope'
])
const IDLE_STATUSES = new Set(['ready', 'busy', 'cooldown', 'daily-limit'])

class IfindCalibrationContractError extends Error {
  constructor() {
    super('The iFinD calibration result is invalid')
    this.name = 'IfindCalibrationContractError'
    this.code = 'IFIND_CALIBRATION_RESULT_INVALID'
  }
}

function invalid() {
  throw new IfindCalibrationContractError()
}

function dataRecord(value, keys) {
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

function fixedParameters(value) {
  if (types.isProxy(value) || !Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 4 || keys.some((key) => typeof key !== 'string' ||
      !['0', '1', '2', 'length'].includes(key))) invalid()
  const length = Reflect.getOwnPropertyDescriptor(value, 'length')
  if (!length || !Object.hasOwn(length, 'value') || length.value !== 3) invalid()
  for (let index = 0; index < PARAMETERS.length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
        descriptor.value !== PARAMETERS[index]) invalid()
  }
  return [...PARAMETERS]
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length !== 24 ||
      !/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)) return false
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

function createInitialCalibrationResult() {
  return {
    calibrationId: CALIBRATION_ID,
    caseId: 'HK_ALIBABA_9988',
    displayCode: '9988.HK',
    indicator: 'revenue_oas',
    parameters: [...PARAMETERS],
    status: 'ready',
    verification: Object.fromEntries(VERIFICATION_KEYS.map((key) => [key, 'unverified'])),
    periodEvidence: createPeriodEvidence(),
    observation: null,
    requestCount: 0,
    businessRequestCount: 0,
    dataVol: null,
    attemptedAt: null,
    errorCode: null
  }
}

function validateAndCopy(value) {
  const input = dataRecord(value, RESULT_KEYS)
  if (input.calibrationId !== CALIBRATION_ID || input.caseId !== 'HK_ALIBABA_9988' ||
      input.displayCode !== '9988.HK' || input.indicator !== 'revenue_oas') invalid()
  const parameters = fixedParameters(input.parameters)
  const verification = dataRecord(input.verification, VERIFICATION_KEYS)
  for (const key of VERIFICATION_KEYS) if (verification[key] !== 'unverified') invalid()
  if (!Number.isSafeInteger(input.requestCount) || input.requestCount < 0 || input.requestCount > 2 ||
      !Number.isSafeInteger(input.businessRequestCount) ||
      input.businessRequestCount !== (input.requestCount === 2 ? 1 : 0)) invalid()
  if (input.dataVol !== null && (!Number.isSafeInteger(input.dataVol) || input.dataVol < 0 ||
      input.businessRequestCount !== 1)) invalid()
  if (input.attemptedAt !== null && !canonicalTimestamp(input.attemptedAt)) invalid()
  if (input.requestCount > 0 && input.attemptedAt === null) invalid()

  let observation = null
  if (input.observation !== null) {
    const observed = dataRecord(input.observation, OBSERVATION_KEYS)
    if (observed.returnedCode !== '9988.HK' || observed.currency !== null || observed.unit !== null ||
        observed.reportPeriod !== null || observed.periodType !== null || observed.disclosureScope !== null) invalid()
    if (observed.value === null) {
      if (observed.availability !== 'missing') invalid()
    } else if (typeof observed.value !== 'number' || !Number.isFinite(observed.value) ||
        observed.availability !== 'present') invalid()
    observation = {
      value: observed.value, availability: observed.availability, returnedCode: '9988.HK',
      currency: null, unit: null, reportPeriod: null, periodType: null, disclosureScope: null
    }
  }

  if (IDLE_STATUSES.has(input.status)) {
    if (observation !== null || input.requestCount !== 0 || input.dataVol !== null ||
        input.attemptedAt !== null || input.errorCode !== null) invalid()
  } else if (input.status === 'observed-unverified') {
    if (!observation || input.requestCount !== 2 ||
        input.errorCode !== 'IFIND_CALIBRATION_OBSERVED_UNVERIFIED') invalid()
  } else if (input.status === 'failed' || input.status === 'unavailable') {
    if (observation !== null || input.errorCode !== (input.status === 'failed'
      ? 'IFIND_CALIBRATION_FAILED' : 'IFIND_CALIBRATION_UNAVAILABLE')) invalid()
  } else invalid()

  const periodEvidence = copyPeriodEvidence(input.periodEvidence, observation === null ? null : observation.value)

  // Rebuild every field, rather than serializing or spreading caller-owned data.
  return {
    calibrationId: CALIBRATION_ID,
    caseId: 'HK_ALIBABA_9988',
    displayCode: '9988.HK',
    indicator: 'revenue_oas',
    parameters,
    status: input.status,
    verification: Object.fromEntries(VERIFICATION_KEYS.map((key) => [key, 'unverified'])),
    periodEvidence,
    observation,
    requestCount: input.requestCount,
    businessRequestCount: input.businessRequestCount,
    dataVol: input.dataVol,
    attemptedAt: input.attemptedAt,
    errorCode: input.errorCode
  }
}

function copyCalibrationResult(value) {
  try {
    return validateAndCopy(value)
  } catch {
    // Never expose hostile values, thrown proxy text, or accessor exceptions.
    throw new IfindCalibrationContractError()
  }
}

module.exports = {
  CALIBRATION_ID,
  CALIBRATION_REQUEST,
  IfindCalibrationContractError,
  copyCalibrationResult,
  createInitialCalibrationResult
}
