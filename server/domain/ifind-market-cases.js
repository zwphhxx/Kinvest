'use strict'

const IFIND_MARKET_CASE_UNVERIFIED = 'IFIND_MARKET_CASE_UNVERIFIED'
const IFIND_MARKET_CASE_UNKNOWN = 'IFIND_MARKET_CASE_UNKNOWN'

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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function cloneFrozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen))
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
      financial: unverifiedIndicators(FINANCIAL_METRICS)
    },
    periodRules: {
      fullFiscalYears: 2,
      includeLatestDisclosedInterim: true,
      vendorParameters: null,
      evidenceStatus: 'unverified'
    },
    parserId: template.parserId,
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

function allIndicatorsVerified(marketCase) {
  return Object.values(marketCase.indicators)
    .flat()
    .every((indicator) => indicator.evidenceStatus === 'verified' &&
      typeof indicator.vendorIndicatorId === 'string' &&
      indicator.vendorIndicatorId.length > 0)
}

function caseHasVerifiedRequestEvidence(marketCase) {
  return marketCase.vendorCodes.ifind.evidenceStatus === 'verified' &&
    typeof marketCase.vendorCodes.ifind.code === 'string' &&
    marketCase.vendorCodes.ifind.code.length > 0 &&
    Object.values(marketCase.requestTemplates)
      .every((request) => request.evidenceStatus === 'verified') &&
    marketCase.periodRules.evidenceStatus === 'verified' &&
    marketCase.periodRules.vendorParameters !== null &&
    allIndicatorsVerified(marketCase)
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

function getIfindMarketCase(caseId) {
  const marketCase = MARKET_CASES.find((candidate) => candidate.caseId === caseId)
  return marketCase ? cloneFrozen(marketCase) : null
}

function createLiveRequestManifest(caseId) {
  const marketCase = MARKET_CASES.find((candidate) => candidate.caseId === caseId)
  if (!marketCase) {
    const error = new Error('Unknown fixed iFinD market case')
    error.code = IFIND_MARKET_CASE_UNKNOWN
    error.caseId = caseId
    throw error
  }
  if (!marketCase.liveReady || !caseHasVerifiedRequestEvidence(marketCase)) {
    const error = new Error('Fixed iFinD market case lacks verified official evidence')
    error.code = IFIND_MARKET_CASE_UNVERIFIED
    error.caseId = marketCase.caseId
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

module.exports = {
  createLiveRequestManifest,
  getIfindMarketCase,
  listIfindMarketCases
}
