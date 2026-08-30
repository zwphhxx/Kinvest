'use strict'

const { types } = require('node:util')
const { isIfindIndicatorId } = require('./ifind-indicator-id')
const VERIFIED_BUNDLES = new WeakSet()
const VERIFICATION_FIELDS = Object.freeze([
  'issuerIdentityStatus', 'vendorCodeStatus', 'entitlementStatus', 'currencyStatus',
  'unitStatus', 'reportPeriodStatus', 'scopeStatus', 'sourceMode'
])

const REQUIRED_QUOTE_METRICS = Object.freeze([
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

const REQUIRED_FINANCIAL_METRICS = Object.freeze([
  'revenue',
  'grossProfit',
  'attributableNetProfit',
  'operatingCashFlow',
  'receivables',
  'inventory',
  'interestBearingDebt'
])

const REQUIRED_FINANCIAL_METADATA_FIELDS = Object.freeze([
  'currency',
  'unit',
  'reportPeriod',
  'reportDate',
  'periodType',
  'disclosureScope',
  'sourceTime',
  'fetchTime',
  'sourceMode'
])

const LOCAL_FINANCIAL_METADATA_SOURCES = Object.freeze({
  fetchTime: 'runtime-clock',
  sourceMode: 'verified-adapter'
})

function invalidManifest() {
  const error = Object.assign(new Error('iFinD live request manifest is invalid'), {
    code: 'IFIND_MARKET_MANIFEST_INVALID'
  })
  throw error
}

function isProxy(value) {
  return value !== null && typeof value === 'object' && types.isProxy(value)
}

function plainRecord(value, exactKeys = null) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) {
    invalidManifest()
  }

  let prototype
  let descriptors
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    invalidManifest()
  }
  if (prototype !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) {
    invalidManifest()
  }

  const keys = Object.keys(descriptors)
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalidManifest()
  }
  if (exactKeys) {
    if (keys.length !== exactKeys.length || exactKeys.some((key) => !Object.hasOwn(descriptors, key))) {
      invalidManifest()
    }
  }
  return descriptors
}

function dataValue(descriptors, key) {
  const descriptor = descriptors[key]
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) {
    invalidManifest()
  }
  return descriptor.value
}

function arrayValues(value, requireNonEmpty = true) {
  if (!Array.isArray(value) || isProxy(value)) invalidManifest()

  let prototype
  let descriptors
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    invalidManifest()
  }
  if (prototype !== Array.prototype) invalidManifest()
  const lengthDescriptor = descriptors.length
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) invalidManifest()
  const length = lengthDescriptor.value
  if (!Number.isSafeInteger(length) || length < 0 || (requireNonEmpty && length === 0)) {
    invalidManifest()
  }
  if (Object.getOwnPropertySymbols(value).length > 0) invalidManifest()

  const names = Object.keys(descriptors).filter((name) => name !== 'length')
  if (names.length !== length) invalidManifest()
  const values = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index]
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable ||
      descriptor.value === undefined) {
      invalidManifest()
    }
    values.push(descriptor.value)
  }
  return values
}

/** @param {string} value */
function containsControlCharacter(value) {
  return Array.from(value).some((character) =>
    character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function trimmedProviderId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 ||
    value.trim() !== value || containsControlCharacter(value)) {
    invalidManifest()
  }
  return value
}

function supportedIndicatorId(value) {
  if (!isIfindIndicatorId(value)) invalidManifest()
  return value
}

function evidenceSourceReference(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 ||
    value.trim() !== value || containsControlCharacter(value)) {
    invalidManifest()
  }
  return value
}

function verifiedIndicatorIds(value, requiredMetrics) {
  const indicators = arrayValues(value)
  if (indicators.length !== requiredMetrics.length) invalidManifest()

  const metricSet = new Set()
  const idSet = new Set()
  const ids = []
  for (const indicator of indicators) {
    const descriptors = plainRecord(indicator, [
      'metric',
      'vendorIndicatorId',
      'evidenceStatus'
    ])
    const metric = dataValue(descriptors, 'metric')
    const vendorIndicatorId = supportedIndicatorId(dataValue(descriptors, 'vendorIndicatorId'))
    if (typeof metric !== 'string' || !requiredMetrics.includes(metric) || metricSet.has(metric) ||
      dataValue(descriptors, 'evidenceStatus') !== 'verified' || idSet.has(vendorIndicatorId)) {
      invalidManifest()
    }
    metricSet.add(metric)
    idSet.add(vendorIndicatorId)
    ids.push(vendorIndicatorId)
  }
  if (requiredMetrics.some((metric) => !metricSet.has(metric))) invalidManifest()
  return ids
}

function verifiedFinancialMetadataIds(value, metricIds) {
  const descriptors = plainRecord(value, REQUIRED_FINANCIAL_METADATA_FIELDS)
  const usedIds = new Set(metricIds)
  const ids = []
  for (const field of REQUIRED_FINANCIAL_METADATA_FIELDS) {
    const value = dataValue(descriptors, field)
    if (Object.hasOwn(LOCAL_FINANCIAL_METADATA_SOURCES, field)) {
      const mapping = plainRecord(value, ['source'])
      if (dataValue(mapping, 'source') !== LOCAL_FINANCIAL_METADATA_SOURCES[field]) {
        invalidManifest()
      }
      continue
    }
    const mapping = plainRecord(value, [
      'vendorIndicatorId',
      'evidenceStatus',
      'sourceReference'
    ])
    const vendorIndicatorId = supportedIndicatorId(
      dataValue(mapping, 'vendorIndicatorId')
    )
    if (dataValue(mapping, 'evidenceStatus') !== 'verified' ||
      usedIds.has(vendorIndicatorId)) invalidManifest()
    evidenceSourceReference(dataValue(mapping, 'sourceReference'))
    usedIds.add(vendorIndicatorId)
    ids.push(vendorIndicatorId)
  }
  return ids
}

function requestTemplate(value, endpoint, idKey, evidenceIds) {
  const descriptors = plainRecord(value, ['endpoint', idKey, 'evidenceStatus'])
  if (dataValue(descriptors, 'endpoint') !== endpoint ||
    dataValue(descriptors, 'evidenceStatus') !== 'verified') {
    invalidManifest()
  }
  const requestIds = arrayValues(dataValue(descriptors, idKey)).map(supportedIndicatorId)
  if (requestIds.length !== evidenceIds.length ||
    requestIds.some((id, index) => id !== evidenceIds[index])) {
    invalidManifest()
  }
}

function providerParameterValue(value) {
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > 256 || value.trim() !== value ||
      containsControlCharacter(value)) {
      invalidManifest()
    }
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidManifest()
    return
  }
  if (typeof value === 'boolean') return
  if (Array.isArray(value)) {
    for (const item of arrayValues(value)) providerParameterValue(item)
    return
  }
  invalidManifest()
}

function providerParameters(value) {
  const descriptors = plainRecord(value)
  const keys = Object.keys(descriptors)
  if (keys.length === 0) invalidManifest()
  for (const key of keys) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) invalidManifest()
    providerParameterValue(dataValue(descriptors, key))
  }
}

function periodRules(value) {
  const descriptors = plainRecord(value, [
    'fullFiscalYears',
    'includeLatestDisclosedInterim',
    'vendorParameters',
    'evidenceStatus'
  ])
  if (dataValue(descriptors, 'fullFiscalYears') !== 2 ||
    dataValue(descriptors, 'includeLatestDisclosedInterim') !== true ||
    dataValue(descriptors, 'evidenceStatus') !== 'verified') {
    invalidManifest()
  }

  const vendorParameterDescriptors = plainRecord(
    dataValue(descriptors, 'vendorParameters'),
    ['fullFiscalYears', 'latestDisclosedInterim']
  )
  const annualDescriptors = plainRecord(
    dataValue(vendorParameterDescriptors, 'fullFiscalYears'),
    ['count', 'requestParameters']
  )
  if (dataValue(annualDescriptors, 'count') !== 2) invalidManifest()
  providerParameters(dataValue(annualDescriptors, 'requestParameters'))

  const interimDescriptors = plainRecord(
    dataValue(vendorParameterDescriptors, 'latestDisclosedInterim'),
    ['enabled', 'requestParameters']
  )
  if (dataValue(interimDescriptors, 'enabled') !== true) invalidManifest()
  providerParameters(dataValue(interimDescriptors, 'requestParameters'))
}

function validateLiveRequestManifestDefinition(definition) {
  const root = plainRecord(definition)

  const vendorCodes = plainRecord(dataValue(root, 'vendorCodes'), ['ifind'])
  const ifindCode = plainRecord(dataValue(vendorCodes, 'ifind'), ['code', 'evidenceStatus'])
  trimmedProviderId(dataValue(ifindCode, 'code'))
  if (dataValue(ifindCode, 'evidenceStatus') !== 'verified') invalidManifest()

  const indicators = plainRecord(dataValue(root, 'indicators'), [
    'quote', 'financial', 'financialMetadata'
  ])
  const quoteIds = verifiedIndicatorIds(
    dataValue(indicators, 'quote'),
    REQUIRED_QUOTE_METRICS
  )
  const financialIds = verifiedIndicatorIds(
    dataValue(indicators, 'financial'),
    REQUIRED_FINANCIAL_METRICS
  )
  const financialMetadataIds = verifiedFinancialMetadataIds(
    dataValue(indicators, 'financialMetadata'),
    financialIds
  )

  const templates = plainRecord(dataValue(root, 'requestTemplates'), ['quote', 'financial'])
  requestTemplate(
    dataValue(templates, 'quote'),
    '/api/v1/real_time_quotation',
    'fields',
    quoteIds
  )
  requestTemplate(
    dataValue(templates, 'financial'),
    '/api/v1/basic_data_service',
    'indicatorIds',
    [...financialIds, ...financialMetadataIds]
  )

  periodRules(dataValue(root, 'periodRules'))
  return true
}

function cloneVerifiedData(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Object.freeze(value.map(cloneVerifiedData))
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key, cloneVerifiedData(entry)
  ])))
}

function requireVerifiedDimensions(value) {
  const descriptors = plainRecord(value, VERIFICATION_FIELDS)
  for (const field of VERIFICATION_FIELDS) {
    if (dataValue(descriptors, field) !== (field === 'sourceMode' ? 'real' : 'verified')) {
      invalidManifest()
    }
  }
}

// Internal composition boundary only. Neither a provider response nor HTTP input
// may supply evidence. No verification status is synthesized by this factory.
function createVerifiedMarketEvidenceBundle(definition, evidence) {
  validateLiveRequestManifestDefinition(definition)
  const root = plainRecord(definition)
  const caseId = trimmedProviderId(dataValue(root, 'caseId'))
  const listingId = trimmedProviderId(dataValue(root, 'listingId'))
  const parserId = trimmedProviderId(dataValue(root, 'parserId'))
  if (dataValue(root, 'liveReady') !== true) invalidManifest()
  const evidenceDescriptors = plainRecord(evidence, [
    'quoteVerification', 'financialVerification', 'financialReportingCurrencyEvidence'
  ])
  const quoteVerification = dataValue(evidenceDescriptors, 'quoteVerification')
  const financialVerification = dataValue(evidenceDescriptors, 'financialVerification')
  requireVerifiedDimensions(quoteVerification)
  requireVerifiedDimensions(financialVerification)
  const currencyEvidence = dataValue(evidenceDescriptors, 'financialReportingCurrencyEvidence')
  const currency = plainRecord(currencyEvidence, [
    'caseId', 'listingId', 'currency', 'evidenceStatus', 'sourceIdentity',
    'sourceReference', 'verifiedAt'
  ])
  const currencyCode = dataValue(currency, 'currency')
  const verifiedAt = dataValue(currency, 'verifiedAt')
  if (dataValue(currency, 'caseId') !== caseId ||
    dataValue(currency, 'listingId') !== listingId ||
    dataValue(currency, 'evidenceStatus') !== 'verified' ||
    typeof currencyCode !== 'string' || !/^[A-Z]{3}$/.test(currencyCode) ||
    typeof verifiedAt !== 'string' || !Number.isFinite(Date.parse(verifiedAt))) invalidManifest()
  const sourceIdentity = evidenceSourceReference(dataValue(currency, 'sourceIdentity'))
  const sourceReference = evidenceSourceReference(dataValue(currency, 'sourceReference'))
  if (/token|secret|password|authorization|cookie|requestid/i.test(sourceIdentity + sourceReference)) {
    invalidManifest()
  }
  const vendorCodes = plainRecord(dataValue(root, 'vendorCodes'), ['ifind'])
  const ifind = plainRecord(dataValue(vendorCodes, 'ifind'), ['code', 'evidenceStatus'])
  const bundle = cloneVerifiedData({
    manifest: {
      caseId,
      vendorCode: dataValue(ifind, 'code'),
      requestTemplates: dataValue(root, 'requestTemplates'),
      indicators: dataValue(root, 'indicators'),
      periodRules: dataValue(root, 'periodRules'),
      parserId
    },
    quoteVerification,
    financialVerification,
    financialReportingCurrencyEvidence: currencyEvidence
  })
  VERIFIED_BUNDLES.add(bundle)
  return bundle
}

function getVerifiedMarketManifest(bundle, caseId) {
  if (!VERIFIED_BUNDLES.has(bundle)) return null
  return bundle.manifest.caseId === caseId ? bundle.manifest : null
}

module.exports = {
  LOCAL_FINANCIAL_METADATA_SOURCES,
  createVerifiedMarketEvidenceBundle,
  getVerifiedMarketManifest,
  validateLiveRequestManifestDefinition
}
