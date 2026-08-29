'use strict'

const { types } = require('node:util')
const { getIfindMarketCase } = require('./ifind-market-cases')

const QUOTE_FIELDS = Object.freeze([
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
])

const NUMERIC_FIELDS = Object.freeze([
  'latestPrice',
  'previousClose',
  'open',
  'high',
  'low',
  'volume',
  'turnover'
])

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

const EVIDENCE_STATUSES = new Set([
  'unverified',
  'verified',
  'failed',
  'not_applicable'
])

const FAILED_VERIFICATION = Object.freeze({
  issuerIdentityStatus: 'failed',
  vendorCodeStatus: 'failed',
  entitlementStatus: 'failed',
  currencyStatus: 'failed',
  unitStatus: 'failed',
  reportPeriodStatus: 'failed',
  scopeStatus: 'failed',
  sourceMode: 'failed'
})

function hkTradingStatus(value) {
  if (value === 'TRADING') return 'trading'
  if (value === 'SUSPENDED') return 'suspended'
  if (value === 'CLOSED') return 'closed'
  return null
}

function usTradingStatus(value) {
  if (value === 'REGULAR') return 'trading'
  if (value === 'HALTED') return 'suspended'
  if (value === 'CLOSED') return 'closed'
  return null
}

function cnTradingStatus(value) {
  if (value === 'TRADE') return 'trading'
  if (value === 'SUSPEND') return 'suspended'
  if (value === 'CLOSE') return 'closed'
  return null
}

function validDateTime(year, month, day, hour, minute, second) {
  if (!Number.isInteger(year) || year < 2000 || year > 2099) return false
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
}

function canonicalDateTime(match, positions, offset) {
  const year = Number(match[positions.year])
  const month = Number(match[positions.month])
  const day = Number(match[positions.day])
  const hour = Number(match[positions.hour])
  const minute = Number(match[positions.minute])
  const second = Number(match[positions.second])
  if (!validDateTime(year, month, day, hour, minute, second)) return null
  const pad = (value) => String(value).padStart(2, '0')
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${offset}`
}

function hkQuoteTime(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
  return match && canonicalDateTime(match, {
    year: 1,
    month: 2,
    day: 3,
    hour: 4,
    minute: 5,
    second: 6
  }, '+08:00')
}

function usQuoteTime(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2}) (EDT|EST)$/.exec(value)
  if (!match) return null
  return canonicalDateTime(match, {
    year: 3,
    month: 1,
    day: 2,
    hour: 4,
    minute: 5,
    second: 6
  }, match[7] === 'EDT' ? '-04:00' : '-05:00')
}

function cnQuoteTime(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value)
  return match && canonicalDateTime(match, {
    year: 1,
    month: 2,
    day: 3,
    hour: 4,
    minute: 5,
    second: 6
  }, '+08:00')
}

function catalogIdentity(caseId) {
  const marketCase = getIfindMarketCase(caseId)
  if (!marketCase) throw new Error('Fixed iFinD quote profile is missing its catalog case')
  return Object.freeze({
    caseId: marketCase.caseId,
    listingId: marketCase.listingId,
    displayCode: marketCase.displayCode,
    currency: marketCase.expectedTradingCurrency
  })
}

function profile(identity, vendorCode, fields, parseQuoteTime, parseTradingStatus) {
  return Object.freeze({
    ...identity,
    vendorCode,
    fields: Object.freeze({ ...fields }),
    parseQuoteTime,
    parseTradingStatus
  })
}

const PROFILES = Object.freeze({
  HK_ALIBABA_9988: profile(catalogIdentity('HK_ALIBABA_9988'), 'TEST_ONLY_HK_CODE', {
    latestPrice: 'TEST_ONLY_HK_LATEST_PRICE',
    previousClose: 'TEST_ONLY_HK_PREVIOUS_CLOSE',
    open: 'TEST_ONLY_HK_OPEN',
    high: 'TEST_ONLY_HK_HIGH',
    low: 'TEST_ONLY_HK_LOW',
    volume: 'TEST_ONLY_HK_VOLUME',
    turnover: 'TEST_ONLY_HK_TURNOVER',
    quoteTime: 'TEST_ONLY_HK_QUOTE_TIME',
    tradingStatus: 'TEST_ONLY_HK_TRADING_STATUS',
    currency: 'TEST_ONLY_HK_CURRENCY'
  }, hkQuoteTime, hkTradingStatus),
  US_APPLE_AAPL: profile(catalogIdentity('US_APPLE_AAPL'), 'TEST_ONLY_US_CODE', {
    latestPrice: 'TEST_ONLY_US_LATEST_PRICE',
    previousClose: 'TEST_ONLY_US_PREVIOUS_CLOSE',
    open: 'TEST_ONLY_US_OPEN',
    high: 'TEST_ONLY_US_HIGH',
    low: 'TEST_ONLY_US_LOW',
    volume: 'TEST_ONLY_US_VOLUME',
    turnover: 'TEST_ONLY_US_TURNOVER',
    quoteTime: 'TEST_ONLY_US_QUOTE_TIME',
    tradingStatus: 'TEST_ONLY_US_TRADING_STATUS',
    currency: 'TEST_ONLY_US_CURRENCY'
  }, usQuoteTime, usTradingStatus),
  CN_MOUTAI_600519: profile(catalogIdentity('CN_MOUTAI_600519'), 'TEST_ONLY_CN_CODE', {
    latestPrice: 'TEST_ONLY_CN_LATEST_PRICE',
    previousClose: 'TEST_ONLY_CN_PREVIOUS_CLOSE',
    open: 'TEST_ONLY_CN_OPEN',
    high: 'TEST_ONLY_CN_HIGH',
    low: 'TEST_ONLY_CN_LOW',
    volume: 'TEST_ONLY_CN_VOLUME',
    turnover: 'TEST_ONLY_CN_TURNOVER',
    quoteTime: 'TEST_ONLY_CN_QUOTE_TIME',
    tradingStatus: 'TEST_ONLY_CN_TRADING_STATUS',
    currency: 'TEST_ONLY_CN_CURRENCY'
  }, cnQuoteTime, cnTradingStatus)
})

function ownDataRecord(value, allowedKeys, requiredKeys = allowedKeys, forbiddenKeys = []) {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value) ||
      Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null
    }
    const descriptors = {}
    for (const key of allowedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor) continue
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null
      descriptors[key] = descriptor
    }
    if (requiredKeys.some((key) => !Object.hasOwn(descriptors, key))) return null
    for (const key of forbiddenKeys) {
      if (Object.getOwnPropertyDescriptor(value, key)) return null
    }
    return descriptors
  } catch {
    return null
  }
}

function ownDataArray(value, maximumLength = 64) {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value) ||
      !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return null
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) return null
    const length = lengthDescriptor.value
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength) {
      return null
    }
    const values = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null
      values.push(descriptor.value)
    }
    return values
  } catch {
    return null
  }
}

function descriptorValue(descriptors, key) {
  return descriptors[key].value
}

function verificationSnapshot(value) {
  const descriptors = ownDataRecord(value, VERIFICATION_FIELDS)
  if (!descriptors) return null
  const snapshot = {}
  for (const field of VERIFICATION_FIELDS) {
    const status = descriptorValue(descriptors, field)
    if (field === 'sourceMode') {
      if (!['real', 'unverified', 'failed'].includes(status)) return null
    } else if (!EVIDENCE_STATUSES.has(status)) {
      return null
    }
    snapshot[field] = status
  }
  return Object.freeze(snapshot)
}

function hasApprovedVerification(verification) {
  return verification.sourceMode === 'real' &&
    VERIFICATION_FIELDS.slice(0, -1).every((field) => verification[field] === 'verified')
}

function unavailableVerification(verification, failedFields = []) {
  if (!verification) return FAILED_VERIFICATION
  const snapshot = { ...verification }
  for (const field of failedFields) snapshot[field] = 'failed'
  if (snapshot.sourceMode === 'real') {
    snapshot.sourceMode = VERIFICATION_FIELDS.slice(0, -1)
      .some((field) => snapshot[field] === 'failed') ? 'failed' : 'unverified'
  }
  return Object.freeze(snapshot)
}

function sanitizedMissingFields(fields) {
  const selected = new Set(Array.isArray(fields) ? fields : QUOTE_FIELDS)
  return Object.freeze(QUOTE_FIELDS.filter((field) => selected.has(field)))
}

function quoteResult(profileDefinition, values, source, verification, missingFields) {
  return Object.freeze({
    caseId: profileDefinition ? profileDefinition.caseId : null,
    listingId: profileDefinition ? profileDefinition.listingId : null,
    displayCode: profileDefinition ? profileDefinition.displayCode : null,
    latestPrice: values ? values.latestPrice : null,
    previousClose: values ? values.previousClose : null,
    open: values ? values.open : null,
    high: values ? values.high : null,
    low: values ? values.low : null,
    volume: values ? values.volume : null,
    turnover: values ? values.turnover : null,
    quoteTime: values ? values.quoteTime : null,
    tradingStatus: values ? values.tradingStatus : null,
    currency: values ? values.currency : null,
    source,
    verification,
    missingFields: sanitizedMissingFields(missingFields)
  })
}

function unavailable(profileDefinition, verification, failedFields, missingFields = QUOTE_FIELDS) {
  return quoteResult(
    profileDefinition,
    null,
    'unavailable',
    unavailableVerification(verification, failedFields),
    missingFields
  )
}

function scalarValue(descriptor) {
  if (!descriptor) return { present: false }
  const values = ownDataArray(descriptor.value, 1)
  if (!values || values.length !== 1) return { present: false }
  return { present: true, value: values[0] }
}

function parsePayload(profileDefinition, payload) {
  const payloadDescriptors = ownDataRecord(
    payload,
    ['errorcode', 'tables', 'dataVol', 'errmsg'],
    ['errorcode']
  )
  if (!payloadDescriptors) {
    return { failedFields: ['scopeStatus'], missingFields: QUOTE_FIELDS }
  }

  const errorCode = descriptorValue(payloadDescriptors, 'errorcode')
  if (!Number.isSafeInteger(errorCode)) {
    return { failedFields: ['scopeStatus'], missingFields: QUOTE_FIELDS }
  }
  if (errorCode !== 0) {
    return { failedFields: ['entitlementStatus'], missingFields: QUOTE_FIELDS }
  }
  if (!payloadDescriptors.tables || payloadDescriptors.errmsg) {
    return { failedFields: ['scopeStatus'], missingFields: QUOTE_FIELDS }
  }
  if (payloadDescriptors.dataVol) {
    const dataVol = descriptorValue(payloadDescriptors, 'dataVol')
    if (!Number.isSafeInteger(dataVol) || dataVol !== QUOTE_FIELDS.length) {
      return { failedFields: ['scopeStatus'], missingFields: QUOTE_FIELDS }
    }
  }

  const tables = ownDataArray(descriptorValue(payloadDescriptors, 'tables'), 2)
  if (!tables || tables.length !== 1) {
    return { failedFields: ['scopeStatus'], missingFields: QUOTE_FIELDS }
  }
  const tableDescriptors = ownDataRecord(tables[0], ['thscode', 'table'])
  if (!tableDescriptors) {
    return { failedFields: ['scopeStatus'], missingFields: QUOTE_FIELDS }
  }
  if (descriptorValue(tableDescriptors, 'thscode') !== profileDefinition.vendorCode) {
    return { failedFields: ['vendorCodeStatus'], missingFields: QUOTE_FIELDS }
  }

  const providerFieldIds = Object.values(profileDefinition.fields)
  const fieldDescriptors = ownDataRecord(
    descriptorValue(tableDescriptors, 'table'),
    providerFieldIds,
    []
  )
  if (!fieldDescriptors) {
    return { failedFields: ['scopeStatus'], missingFields: QUOTE_FIELDS }
  }

  const values = {}
  const missingFields = []
  for (const field of NUMERIC_FIELDS) {
    const scalar = scalarValue(fieldDescriptors[profileDefinition.fields[field]])
    if (!scalar.present || typeof scalar.value !== 'number' ||
      !Number.isFinite(scalar.value) || scalar.value < 0) {
      missingFields.push(field)
    } else {
      values[field] = scalar.value
    }
  }

  const timeScalar = scalarValue(fieldDescriptors[profileDefinition.fields.quoteTime])
  const quoteTime = timeScalar.present && profileDefinition.parseQuoteTime(timeScalar.value)
  if (!quoteTime) missingFields.push('quoteTime')
  else values.quoteTime = quoteTime

  const statusScalar = scalarValue(fieldDescriptors[profileDefinition.fields.tradingStatus])
  const tradingStatus = statusScalar.present &&
    profileDefinition.parseTradingStatus(statusScalar.value)
  if (!tradingStatus) missingFields.push('tradingStatus')
  else values.tradingStatus = tradingStatus

  const currencyScalar = scalarValue(fieldDescriptors[profileDefinition.fields.currency])
  if (!currencyScalar.present || currencyScalar.value !== profileDefinition.currency) {
    missingFields.push('currency')
  } else {
    values.currency = currencyScalar.value
  }

  if (missingFields.length > 0) {
    const failedFields = ['scopeStatus']
    if (missingFields.includes('currency')) failedFields.push('currencyStatus')
    return { failedFields, missingFields }
  }
  return { values }
}

function parseIfindMarketQuote(input) {
  const inputDescriptors = ownDataRecord(
    input,
    ['caseId', 'payload', 'verification'],
    ['caseId', 'payload', 'verification'],
    ['fieldMapping']
  )
  if (!inputDescriptors) return unavailable(null, null, [])

  const caseId = descriptorValue(inputDescriptors, 'caseId')
  const profileDefinition = typeof caseId === 'string' && Object.hasOwn(PROFILES, caseId)
    ? PROFILES[caseId]
    : null
  if (!profileDefinition) return unavailable(null, null, [])

  const verification = verificationSnapshot(descriptorValue(inputDescriptors, 'verification'))
  if (!verification) return unavailable(profileDefinition, null, [])
  if (!hasApprovedVerification(verification)) {
    return unavailable(profileDefinition, verification, [])
  }

  const parsed = parsePayload(profileDefinition, descriptorValue(inputDescriptors, 'payload'))
  if (!parsed.values) {
    return unavailable(
      profileDefinition,
      verification,
      parsed.failedFields,
      parsed.missingFields
    )
  }
  return quoteResult(profileDefinition, parsed.values, 'real', verification, [])
}

module.exports = { parseIfindMarketQuote }
