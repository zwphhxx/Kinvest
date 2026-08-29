'use strict'

const { types } = require('node:util')
const { getIfindMarketCase } = require('./ifind-market-cases')

const METRIC_KEYS = Object.freeze([
  'revenue',
  'grossProfit',
  'attributableNetProfit',
  'operatingCashFlow',
  'receivables',
  'inventory',
  'interestBearingDebt'
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

function catalogIdentity(caseId) {
  const marketCase = getIfindMarketCase(caseId)
  if (!marketCase) throw new Error('Fixed iFinD financial profile is missing its catalog case')
  return Object.freeze({
    caseId: marketCase.caseId,
    listingId: marketCase.listingId,
    displayCode: marketCase.displayCode,
    currency: marketCase.expectedTradingCurrency
  })
}

function metricIds(market) {
  return Object.freeze({
    revenue: `TEST_ONLY_${market}_REVENUE`,
    grossProfit: `TEST_ONLY_${market}_GROSS_PROFIT`,
    attributableNetProfit: `TEST_ONLY_${market}_NET_PROFIT`,
    operatingCashFlow: `TEST_ONLY_${market}_OPERATING_CASH_FLOW`,
    receivables: `TEST_ONLY_${market}_RECEIVABLES`,
    inventory: `TEST_ONLY_${market}_INVENTORY`,
    interestBearingDebt: `TEST_ONLY_${market}_INTEREST_BEARING_DEBT`
  })
}

function metadataIds(market) {
  return Object.freeze({
    currency: `TEST_ONLY_${market}_CURRENCY`,
    unit: `TEST_ONLY_${market}_UNIT`,
    reportPeriod: `TEST_ONLY_${market}_REPORT_PERIOD`,
    reportDate: `TEST_ONLY_${market}_REPORT_DATE`,
    periodType: `TEST_ONLY_${market}_PERIOD_TYPE`,
    disclosureScope: `TEST_ONLY_${market}_DISCLOSURE_SCOPE`,
    sourceTime: `TEST_ONLY_${market}_SOURCE_TIME`,
    fetchTime: `TEST_ONLY_${market}_FETCH_TIME`,
    sourceMode: `TEST_ONLY_${market}_SOURCE_MODE`
  })
}

function period(reportPeriod, reportDate, periodType) {
  return Object.freeze({ reportPeriod, reportDate, periodType })
}

function profile(identity, market, vendorCode, scope, periods) {
  return Object.freeze({
    ...identity,
    market,
    vendorCode,
    scope,
    unit: 'million',
    metricIds: metricIds(market),
    metadataIds: metadataIds(market),
    periods: Object.freeze(periods)
  })
}

const PROFILES = Object.freeze({
  HK_ALIBABA_9988: profile(
    catalogIdentity('HK_ALIBABA_9988'),
    'HK',
    'TEST_ONLY_HK_CODE',
    'consolidated',
    [
      period('FY2024', '2024-12-31', 'annual'),
      period('FY2023', '2023-12-31', 'annual'),
      period('H1-2025', '2025-06-30', 'interim')
    ]
  ),
  US_APPLE_AAPL: profile(
    catalogIdentity('US_APPLE_AAPL'),
    'US',
    'TEST_ONLY_US_CODE',
    'issuer_consolidated',
    [
      period('FY2024', '2024-09-28', 'annual'),
      period('FY2023', '2023-09-30', 'annual'),
      period('Q3-FY2025', '2025-06-28', 'interim')
    ]
  ),
  CN_MOUTAI_600519: profile(
    catalogIdentity('CN_MOUTAI_600519'),
    'CN',
    'TEST_ONLY_CN_CODE',
    'consolidated',
    [
      period('2024A', '2024-12-31', 'annual'),
      period('2023A', '2023-12-31', 'annual'),
      period('2025H1', '2025-06-30', 'interim')
    ]
  )
})

function ownDataRecord(value, allowedKeys, requiredKeys = allowedKeys) {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value) ||
      Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null
    }
    const names = Object.getOwnPropertyNames(value)
    if (Object.getOwnPropertySymbols(value).length !== 0 || names.length > allowedKeys.length) {
      return null
    }
    const allowed = new Set(allowedKeys)
    const descriptors = {}
    for (const name of names) {
      if (!allowed.has(name)) return null
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        return null
      }
      descriptors[name] = descriptor
    }
    if (requiredKeys.some((key) => !Object.hasOwn(descriptors, key))) return null
    return descriptors
  } catch {
    return null
  }
}

function ownDataArray(value, expectedLength) {
  try {
    if (!value || typeof value !== 'object' || types.isProxy(value) ||
      !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return null
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
      lengthDescriptor.value !== expectedLength || expectedLength > 32) {
      return null
    }
    const names = Object.getOwnPropertyNames(value)
    if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== expectedLength + 1) {
      return null
    }
    const values = []
    for (let index = 0; index < expectedLength; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        return null
      }
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

function financialResult(profileDefinition, source, availability, verification, points) {
  return Object.freeze({
    caseId: profileDefinition ? profileDefinition.caseId : null,
    listingId: profileDefinition ? profileDefinition.listingId : null,
    displayCode: profileDefinition ? profileDefinition.displayCode : null,
    source,
    availability,
    verification,
    points: Object.freeze(points)
  })
}

function unavailable(profileDefinition, verification, failedFields = []) {
  return financialResult(
    profileDefinition,
    'unavailable',
    'unavailable',
    unavailableVerification(verification, failedFields),
    []
  )
}

function validDate(value) {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
}

function validDateTime(value) {
  return typeof value === 'string' && value.length <= 35 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
}

function parsePayload(profileDefinition, payload, verification) {
  const payloadDescriptors = ownDataRecord(
    payload,
    ['errorcode', 'tables', 'dataVol']
  )
  if (!payloadDescriptors) return { failedFields: ['scopeStatus'] }

  const errorCode = descriptorValue(payloadDescriptors, 'errorcode')
  if (!Number.isSafeInteger(errorCode)) return { failedFields: ['scopeStatus'] }
  if (errorCode !== 0) return { failedFields: ['entitlementStatus'] }

  const tables = ownDataArray(descriptorValue(payloadDescriptors, 'tables'), 1)
  if (!tables) return { failedFields: ['scopeStatus'] }
  const tableDescriptors = ownDataRecord(tables[0], ['thscode', 'table'])
  if (!tableDescriptors) return { failedFields: ['scopeStatus'] }
  if (descriptorValue(tableDescriptors, 'thscode') !== profileDefinition.vendorCode) {
    return { failedFields: ['vendorCodeStatus'] }
  }

  const metricIds = METRIC_KEYS.map((metricKey) => profileDefinition.metricIds[metricKey])
  const metadataIds = Object.values(profileDefinition.metadataIds)
  const fieldDescriptors = ownDataRecord(
    descriptorValue(tableDescriptors, 'table'),
    [...metricIds, ...metadataIds],
    metadataIds
  )
  if (!fieldDescriptors) return { failedFields: ['scopeStatus'] }

  const periodCount = profileDefinition.periods.length
  const metadata = {}
  let expectedDataVol = 0
  for (const [field, indicatorId] of Object.entries(profileDefinition.metadataIds)) {
    const values = ownDataArray(descriptorValue(fieldDescriptors, indicatorId), periodCount)
    if (!values) return { failedFields: ['scopeStatus'] }
    metadata[field] = values
    expectedDataVol += values.length
  }

  const metricValues = {}
  for (const metricKey of METRIC_KEYS) {
    const indicatorId = profileDefinition.metricIds[metricKey]
    if (!fieldDescriptors[indicatorId]) {
      metricValues[metricKey] = null
      continue
    }
    const values = ownDataArray(descriptorValue(fieldDescriptors, indicatorId), periodCount)
    if (!values) return { failedFields: ['scopeStatus'] }
    metricValues[metricKey] = values
    expectedDataVol += values.length
  }

  const dataVol = descriptorValue(payloadDescriptors, 'dataVol')
  if (!Number.isSafeInteger(dataVol) || dataVol !== expectedDataVol) {
    return { failedFields: ['scopeStatus'] }
  }

  const seenPeriods = new Set()
  for (let index = 0; index < periodCount; index += 1) {
    const expected = profileDefinition.periods[index]
    if (metadata.currency[index] !== profileDefinition.currency) {
      return { failedFields: ['currencyStatus'] }
    }
    if (metadata.unit[index] !== profileDefinition.unit) {
      return { failedFields: ['unitStatus'] }
    }
    if (metadata.reportPeriod[index] !== expected.reportPeriod ||
      metadata.reportDate[index] !== expected.reportDate ||
      metadata.periodType[index] !== expected.periodType ||
      !validDate(metadata.reportDate[index])) {
      return { failedFields: ['reportPeriodStatus'] }
    }
    if (seenPeriods.has(metadata.reportPeriod[index])) {
      return { failedFields: ['reportPeriodStatus'] }
    }
    seenPeriods.add(metadata.reportPeriod[index])
    if (metadata.disclosureScope[index] !== profileDefinition.scope) {
      return { failedFields: ['scopeStatus'] }
    }
    if (!validDateTime(metadata.sourceTime[index]) || !validDateTime(metadata.fetchTime[index])) {
      return { failedFields: ['scopeStatus'] }
    }
    if (metadata.sourceMode[index] !== 'real') return { failedFields: ['sourceMode'] }
  }

  const points = []
  const seenMetricPeriods = new Set()
  for (const metricKey of METRIC_KEYS) {
    for (let index = 0; index < periodCount; index += 1) {
      const pointIdentity = `${metricKey}\u0000${metadata.reportPeriod[index]}`
      if (seenMetricPeriods.has(pointIdentity)) {
        return { failedFields: ['reportPeriodStatus'] }
      }
      seenMetricPeriods.add(pointIdentity)
      const values = metricValues[metricKey]
      const value = values ? values[index] : null
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        return { failedFields: ['scopeStatus'] }
      }
      points.push(Object.freeze({
        metricKey,
        indicatorId: profileDefinition.metricIds[metricKey],
        value,
        currency: metadata.currency[index],
        unit: metadata.unit[index],
        reportPeriod: metadata.reportPeriod[index],
        reportDate: metadata.reportDate[index],
        periodType: metadata.periodType[index],
        disclosureScope: metadata.disclosureScope[index],
        sourceTime: metadata.sourceTime[index],
        fetchTime: metadata.fetchTime[index],
        verification,
        availability: value === null ? 'missing' : 'available'
      }))
    }
  }
  return { points }
}

function parseIfindMarketFinancials(input) {
  const inputDescriptors = ownDataRecord(
    input,
    ['caseId', 'payload', 'verification']
  )
  if (!inputDescriptors) return unavailable(null, null)

  const caseId = descriptorValue(inputDescriptors, 'caseId')
  const profileDefinition = typeof caseId === 'string' && Object.hasOwn(PROFILES, caseId)
    ? PROFILES[caseId]
    : null
  if (!profileDefinition) return unavailable(null, null)

  const verification = verificationSnapshot(descriptorValue(inputDescriptors, 'verification'))
  if (!verification) return unavailable(profileDefinition, null)
  if (!hasApprovedVerification(verification)) return unavailable(profileDefinition, verification)

  const parsed = parsePayload(
    profileDefinition,
    descriptorValue(inputDescriptors, 'payload'),
    verification
  )
  if (!parsed.points) return unavailable(profileDefinition, verification, parsed.failedFields)
  return financialResult(
    profileDefinition,
    'real',
    'available',
    verification,
    parsed.points
  )
}

module.exports = { parseIfindMarketFinancials }
