'use strict'

const {
  LOCAL_FINANCIAL_METADATA_SOURCES,
  createVerifiedMarketEvidenceBundle,
  validateLiveRequestManifestDefinition
} = require('./ifind-market-manifest-validator')

const IFIND_MARKET_CASE_UNVERIFIED = 'IFIND_MARKET_CASE_UNVERIFIED'
const IFIND_MARKET_CASE_UNKNOWN = 'IFIND_MARKET_CASE_UNKNOWN'
const IFIND_MARKET_CASE_ID_INVALID = 'IFIND_MARKET_CASE_ID_INVALID'
const CASE_ID_PATTERN = /^(?:HK|US|CN)_[A-Z][A-Z0-9]{0,31}_[A-Z0-9]{1,16}$/

const SUPPORTED_ENDPOINTS = new Set([
  '/api/v1/real_time_quotation',
  '/api/v1/basic_data_service'
])

const QUOTE_METRICS = Object.freeze([
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

const FINANCIAL_METRICS = Object.freeze([
  'revenue',
  'grossProfit',
  'attributableNetProfit',
  'operatingCashFlow',
  'receivables',
  'inventory',
  'interestBearingDebt'
])

const FINANCIAL_METADATA_FIELDS = Object.freeze([
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function cloneFrozen(value) {
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error('Fixed iFinD market catalog contains a non-plain array')
    }
    const descriptors = Object.getOwnPropertyDescriptors(/** @type {object} */ (value))
    const length = descriptors.length && descriptors.length.value
    if (!Number.isSafeInteger(length) || length < 0 ||
      Object.getOwnPropertyNames(value).length !== length + 1) {
      throw new Error('Fixed iFinD market catalog contains an invalid array')
    }
    const clone = []
    clone.length = length
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[index]
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new Error('Fixed iFinD market catalog contains an invalid array index')
      }
      clone[index] = cloneFrozen(descriptor.value)
    }
    return Object.freeze(clone)
  }
  if (!value || typeof value !== 'object') return value
  const clone = {}
  for (const [key, nested] of Object.entries(value)) clone[key] = cloneFrozen(nested)
  return Object.freeze(clone)
}

function unverifiedIndicators(metrics) {
  return metrics.map((metric) => ({
    metric,
    vendorIndicatorId: null,
    evidenceStatus: 'unverified'
  }))
}

function unverifiedFinancialMetadata() {
  return Object.fromEntries(FINANCIAL_METADATA_FIELDS.map((field) => [
    field,
    Object.hasOwn(LOCAL_FINANCIAL_METADATA_SOURCES, field)
      ? { source: LOCAL_FINANCIAL_METADATA_SOURCES[field] }
      : {
        vendorIndicatorId: null,
        evidenceStatus: 'unverified',
        sourceReference: null
      }
  ]))
}

function createCase(identity, template) {
  return {
    ...identity,
    marketTemplateId: template.marketTemplateId,
    expectedTradingCurrency: template.expectedTradingCurrency,
    marketTimeZone: template.marketTimeZone,
    vendorCodes: {
      ifind: {
        code: null,
        evidenceStatus: 'unverified'
      }
    },
    requestTemplates: {
      quote: {
        endpoint: '/api/v1/real_time_quotation',
        fields: [],
        evidenceStatus: 'unverified'
      },
      financial: {
        endpoint: '/api/v1/basic_data_service',
        indicatorIds: [],
        evidenceStatus: 'unverified'
      }
    },
    indicators: {
      quote: unverifiedIndicators(QUOTE_METRICS),
      financial: unverifiedIndicators(FINANCIAL_METRICS),
      financialMetadata: unverifiedFinancialMetadata()
    },
    periodRules: {
      fullFiscalYears: 2,
      includeLatestDisclosedInterim: true,
      vendorParameters: null,
      evidenceStatus: 'unverified'
    },
    parserId: template.parserId,
    diagnosticEvidence: {
      quoteVerification: null,
      financialVerification: null,
      financialReportingCurrencyEvidence: null
    },
    liveReady: false
  }
}

const MARKET_CASES = deepFreeze([
  createCase({
    caseId: 'HK_ALIBABA_9988',
    companyName: 'Alibaba',
    companyId: 'company-alibaba-group',
    listingId: 'listing-hkex-9988',
    issuerLegalName: 'Alibaba Group Holding Limited',
    exchange: 'HKEX',
    exchangeCode: '9988',
    displayCode: '9988.HK',
    formatAliases: ['09988.HK']
  }, {
    marketTemplateId: 'HK_EQUITY_V1',
    expectedTradingCurrency: 'HKD',
    marketTimeZone: 'Asia/Hong_Kong',
    parserId: 'ifind-hk-equity-v1'
  }),
  createCase({
    caseId: 'US_APPLE_AAPL',
    companyName: 'Apple',
    companyId: 'company-apple',
    listingId: 'listing-nasdaq-aapl',
    issuerLegalName: 'Apple Inc.',
    exchange: 'NASDAQ',
    exchangeCode: 'AAPL',
    displayCode: 'AAPL.US',
    formatAliases: []
  }, {
    marketTemplateId: 'US_EQUITY_V1',
    expectedTradingCurrency: 'USD',
    marketTimeZone: 'America/New_York',
    parserId: 'ifind-us-equity-v1'
  }),
  createCase({
    caseId: 'CN_MOUTAI_600519',
    companyName: 'Kweichow Moutai',
    companyId: 'company-kweichow-moutai',
    listingId: 'listing-sse-600519',
    issuerLegalName: 'Kweichow Moutai Co., Ltd.',
    exchange: 'SSE',
    exchangeCode: '600519',
    displayCode: '600519.SH',
    formatAliases: []
  }, {
    marketTemplateId: 'CN_EQUITY_V1',
    expectedTradingCurrency: 'CNY',
    marketTimeZone: 'Asia/Shanghai',
    parserId: 'ifind-cn-equity-v1'
  })
])

function caseHasVerifiedRequestEvidence(marketCase) {
  try {
    return validateLiveRequestManifestDefinition(marketCase)
  } catch {
    return false
  }
}

function validateCatalog(catalog) {
  const caseIds = new Set()
  const companyIds = new Set()
  const listingIds = new Set()
  const issuerNames = new Set()

  for (const marketCase of catalog) {
    if (caseIds.has(marketCase.caseId)) throw new Error('Duplicate iFinD market case ID')
    if (companyIds.has(marketCase.companyId) ||
      listingIds.has(marketCase.listingId) ||
      issuerNames.has(marketCase.issuerLegalName)) {
      throw new Error('Duplicate iFinD issuer or listing identity')
    }
    caseIds.add(marketCase.caseId)
    companyIds.add(marketCase.companyId)
    listingIds.add(marketCase.listingId)
    issuerNames.add(marketCase.issuerLegalName)

    if (!/^[A-Z0-9]+\.(HK|US|SH)$/.test(marketCase.displayCode)) {
      throw new Error('Invalid iFinD market display code')
    }
    if (marketCase.caseId === 'HK_ALIBABA_9988' &&
      marketCase.formatAliases.includes('09888.HK')) {
      throw new Error('Alibaba must not claim the 09888.HK alias')
    }
    for (const request of Object.values(marketCase.requestTemplates)) {
      if (!SUPPORTED_ENDPOINTS.has(request.endpoint)) {
        throw new Error('Unsupported iFinD endpoint')
      }
    }
    if (marketCase.liveReady !== caseHasVerifiedRequestEvidence(marketCase)) {
      throw new Error('iFinD live readiness does not match official evidence')
    }
  }
}

validateCatalog(MARKET_CASES)

function listIfindMarketCases() {
  return cloneFrozen(MARKET_CASES)
}

function requireValidCaseId(caseId) {
  if (typeof caseId !== 'string' || caseId.length > 64 || !CASE_ID_PATTERN.test(caseId)) {
    const error = Object.assign(new Error('Invalid fixed iFinD market case ID'), {
      code: IFIND_MARKET_CASE_ID_INVALID
    })
    throw error
  }
  return caseId
}

function getIfindMarketCase(caseId) {
  const validCaseId = requireValidCaseId(caseId)
  const marketCase = MARKET_CASES.find((candidate) => candidate.caseId === validCaseId)
  return marketCase ? cloneFrozen(marketCase) : null
}

function createLiveRequestManifest(caseId) {
  const validCaseId = requireValidCaseId(caseId)
  const marketCase = MARKET_CASES.find((candidate) => candidate.caseId === validCaseId)
  if (!marketCase) {
    const error = Object.assign(new Error('Unknown fixed iFinD market case'), {
      code: IFIND_MARKET_CASE_UNKNOWN,
      caseId
    })
    throw error
  }
  if (!marketCase.liveReady || !caseHasVerifiedRequestEvidence(marketCase)) {
    const error = Object.assign(new Error('Fixed iFinD market case lacks verified official evidence'), {
      code: IFIND_MARKET_CASE_UNVERIFIED,
      caseId: marketCase.caseId
    })
    throw error
  }

  return cloneFrozen({
    caseId: marketCase.caseId,
    vendorCode: marketCase.vendorCodes.ifind.code,
    requestTemplates: marketCase.requestTemplates,
    indicators: marketCase.indicators,
    periodRules: marketCase.periodRules,
    parserId: marketCase.parserId
  })
}

function createLiveRequestManifestBundle(caseId) {
  // Keep the same fixed-case, verified-request gate as the legacy bare manifest.
  createLiveRequestManifest(caseId)
  const marketCase = MARKET_CASES.find((candidate) => candidate.caseId === caseId)
  return createVerifiedMarketEvidenceBundle(marketCase, marketCase.diagnosticEvidence)
}

module.exports = {
  createLiveRequestManifest,
  createLiveRequestManifestBundle,
  getIfindMarketCase,
  listIfindMarketCases
}
