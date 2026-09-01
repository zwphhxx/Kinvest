'use strict'

const { types: { isProxy } } = require('node:util')

const IFIND_MARKET_TEMPLATE_EVIDENCE_INVALID = 'IFIND_MARKET_TEMPLATE_EVIDENCE_INVALID'

class IfindMarketTemplateEvidenceError extends Error {
  constructor(message = 'Invalid iFinD market template evidence') {
    super(message)
    this.name = 'IfindMarketTemplateEvidenceError'
    this.code = IFIND_MARKET_TEMPLATE_EVIDENCE_INVALID
  }
}

const OFFICIAL_MANUAL = Object.freeze({
  sourceId: 'IFIND_QUANTAPI_MANUAL',
  url: 'https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/help-center/manual.html',
  evidenceType: 'official-documentation',
  recordedAt: '2026-09-01',
  scope: 'basic-data-and-real-time-http-contracts'
})

const OFFICIAL_EXAMPLES = Object.freeze({
  sourceId: 'IFIND_QUANTAPI_EXAMPLES',
  url: 'https://quantapi.51ifind.com/gwstatic/static/ds_web/quantapi-web/example.html',
  evidenceType: 'official-documentation',
  recordedAt: '2026-09-01',
  scope: 'a-share-real-time-and-us-date-sequence-examples'
})

const OFFICIAL_SUPER_COMMAND = Object.freeze({
  sourceId: 'IFIND_SUPER_COMMAND_OBSERVATION',
  url: 'https://quantapi.51ifind.com/gwstatic/static/ds_web/super-command-web/index.html#/BasicData',
  evidenceType: 'official-ui-observation',
  recordedAt: '2026-08-30',
  scope: 'hk-alibaba-candidate-quote-and-revenue-fields'
})

const SZSE_PING_AN = Object.freeze({
  sourceId: 'SZSE_PING_AN_BANK_DISCLOSURE',
  url: 'https://disc.static.szse.cn/download/disc/disk03/finalpage/2026-01-24/93eea4ce-2e60-43ed-a0fa-c57d5fe41871.PDF',
  evidenceType: 'official-exchange-disclosure',
  recordedAt: '2026-09-01',
  scope: 'ping-an-bank-exchange-identity'
})

const BSE_CODE_MAPPING = Object.freeze({
  sourceId: 'BSE_CODE_MAPPING',
  url: 'https://www.bse.cn/service/code_mapping.html',
  evidenceType: 'official-exchange-reference',
  recordedAt: '2026-09-01',
  scope: 'bse-current-and-historical-code-mapping'
})

const ACTIVATION_BLOCKERS = Object.freeze([
  'IFIND_ISSUER_IDENTITY_UNVERIFIED',
  'IFIND_VENDOR_CODE_UNVERIFIED',
  'IFIND_QUOTE_TEMPLATE_UNVERIFIED',
  'IFIND_FINANCIAL_TEMPLATE_UNVERIFIED'
])

function requestEvidence(endpoint, candidateIndicatorIds, sourceReferences) {
  return {
    status: 'unverified',
    endpoint,
    candidateIndicatorIds,
    sourceReferences
  }
}

function template({
  templateId,
  templateVersion,
  market,
  exchange,
  sample,
  identity,
  quote,
  financial,
  evidenceNotes
}) {
  return {
    templateId,
    templateVersion,
    market,
    exchange,
    sample: {
      ...sample,
      vendorCode: null,
      vendorCodeStatus: 'unverified'
    },
    requestEvidence: { identity, quote, financial },
    evidenceNotes,
    activationBlockers: ACTIVATION_BLOCKERS,
    executionStatus: 'blocked',
    reasonCode: 'IFIND_TEMPLATE_NOT_EXECUTABLE',
    executable: false,
    liveReady: false
  }
}

const MARKET_TEMPLATE_EVIDENCE = Object.freeze([
  template({
    templateId: 'HK_EQUITY_V2',
    templateVersion: 2,
    market: 'HK',
    exchange: 'HKEX',
    sample: {
      companyName: 'Alibaba',
      companyId: 'company-alibaba-group',
      listingId: 'listing-hkex-9988',
      issuerLegalName: 'Alibaba Group Holding Limited',
      exchangeCode: '9988',
      displayCode: '9988.HK',
      formatAliases: ['09988.HK']
    },
    identity: requestEvidence(null, [], [OFFICIAL_SUPER_COMMAND]),
    quote: requestEvidence(
      '/api/v1/real_time_quotation',
      ['latest', 'preClose', 'open', 'high', 'low', 'amount', 'volume', 'tradeDate', 'tradeTime'],
      [OFFICIAL_SUPER_COMMAND, OFFICIAL_MANUAL]
    ),
    financial: requestEvidence(
      '/api/v1/basic_data_service',
      ['revenue_oas'],
      [OFFICIAL_SUPER_COMMAND, OFFICIAL_MANUAL]
    ),
    evidenceNotes: [
      'The SuperCommand observation records candidate fields only; no account response or entitlement was verified.',
      '09988.HK is a formatting alias for Alibaba; 09888.HK is not an Alibaba alias.',
      'Original-currency selection does not prove the returned currency, unit or report period.'
    ]
  }),
  template({
    templateId: 'US_EQUITY_V2',
    templateVersion: 2,
    market: 'US',
    exchange: 'NASDAQ',
    sample: {
      companyName: 'Apple',
      companyId: 'company-apple',
      listingId: 'listing-nasdaq-aapl',
      issuerLegalName: 'Apple Inc.',
      exchangeCode: 'AAPL',
      displayCode: 'AAPL.US',
      formatAliases: []
    },
    identity: requestEvidence(null, [], [OFFICIAL_MANUAL]),
    quote: requestEvidence(null, [], [OFFICIAL_EXAMPLES]),
    financial: requestEvidence(null, [], [OFFICIAL_MANUAL]),
    evidenceNotes: [
      'The official date-sequence example uses AAPL.O; that example does not authorize mapping AAPL.US to an iFinD vendor code.',
      'US quote, timezone, extended-hours and 52/53-week fiscal-year semantics remain unverified.'
    ]
  }),
  template({
    templateId: 'CN_SH_EQUITY_V2',
    templateVersion: 2,
    market: 'CN_SH',
    exchange: 'SSE',
    sample: {
      companyName: 'Kweichow Moutai',
      companyId: 'company-kweichow-moutai',
      listingId: 'listing-sse-600519',
      issuerLegalName: 'Kweichow Moutai Co., Ltd.',
      exchangeCode: '600519',
      displayCode: '600519.SH',
      formatAliases: []
    },
    identity: requestEvidence(
      '/api/v1/basic_data_service',
      ['ths_stock_short_name_stock'],
      [OFFICIAL_MANUAL]
    ),
    quote: requestEvidence(
      '/api/v1/real_time_quotation',
      ['open', 'high', 'low', 'latest'],
      [OFFICIAL_MANUAL, OFFICIAL_EXAMPLES]
    ),
    financial: requestEvidence(null, [], [OFFICIAL_MANUAL]),
    evidenceNotes: [
      'Official A-share examples document generic request fields, not a verified 600519.SH response.',
      'Currency, units, reporting scope and financial indicator parameters remain unverified.'
    ]
  }),
  template({
    templateId: 'CN_SZ_EQUITY_V2',
    templateVersion: 2,
    market: 'CN_SZ',
    exchange: 'SZSE',
    sample: {
      companyName: 'Ping An Bank',
      companyId: 'company-ping-an-bank',
      listingId: 'listing-szse-000001',
      issuerLegalName: 'Ping An Bank Co., Ltd.',
      exchangeCode: '000001',
      displayCode: '000001.SZ',
      formatAliases: []
    },
    identity: requestEvidence(
      '/api/v1/basic_data_service',
      ['ths_stock_short_name_stock'],
      [OFFICIAL_MANUAL, SZSE_PING_AN]
    ),
    quote: requestEvidence(
      '/api/v1/real_time_quotation',
      ['open', 'high', 'low', 'latest'],
      [OFFICIAL_MANUAL, OFFICIAL_EXAMPLES]
    ),
    financial: requestEvidence(null, [], [OFFICIAL_MANUAL]),
    evidenceNotes: [
      'The exchange disclosure supports the display identity but does not prove the iFinD vendor code.',
      'Bank-specific missing or not-applicable metrics require response evidence and must never be filled with zero.'
    ]
  }),
  template({
    templateId: 'CN_BJ_EQUITY_V1',
    templateVersion: 1,
    market: 'CN_BJ',
    exchange: 'BSE',
    sample: {
      companyName: 'Guozi Software',
      companyId: 'company-guozi-software',
      listingId: 'listing-bse-920953',
      issuerLegalName: 'Shandong Guozi Software Co., Ltd.',
      exchangeCode: '920953',
      displayCode: '920953.BJ',
      formatAliases: []
    },
    identity: requestEvidence(null, [], [BSE_CODE_MAPPING]),
    quote: requestEvidence(null, [], [OFFICIAL_MANUAL]),
    financial: requestEvidence(null, [], [OFFICIAL_MANUAL]),
    evidenceNotes: [
      'The official exchange mapping identifies 872953.BJ as a historical-code candidate only.',
      'The historical code is not activated as an alias until an iFinD identity response independently agrees.',
      'No BJ quote or financial request template is currently verified.'
    ]
  })
])

function invalidEvidence() {
  return new IfindMarketTemplateEvidenceError()
}

function clonePlainData(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidEvidence()
    return value
  }
  if (!value || typeof value !== 'object' || isProxy(value) || seen.has(value)) {
    throw invalidEvidence()
  }

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw invalidEvidence()
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length')
      if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) throw invalidEvidence()
      const length = lengthDescriptor.value
      if (!Number.isSafeInteger(length) || length < 0) throw invalidEvidence()
      if (Reflect.ownKeys(value).length !== length + 1) throw invalidEvidence()
      const result = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[index]
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
          throw invalidEvidence()
        }
        result.push(clonePlainData(descriptor.value, seen))
      }
      return result
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) throw invalidEvidence()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const result = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw invalidEvidence()
      const descriptor = descriptors[key]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw invalidEvidence()
      }
      result[key] = clonePlainData(descriptor.value, seen)
    }
    return result
  } catch (error) {
    if (error instanceof IfindMarketTemplateEvidenceError) throw error
    throw invalidEvidence()
  } finally {
    seen.delete(value)
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function copyIfindMarketTemplateEvidence(value) {
  const clone = clonePlainData(value)
  const templateId = clone && clone.templateId
  const expected = MARKET_TEMPLATE_EVIDENCE.find((entry) => entry.templateId === templateId)
  if (!expected || canonicalJson(clone) !== canonicalJson(expected)) throw invalidEvidence()
  return deepFreeze(clone)
}

function listIfindMarketTemplateEvidence() {
  return MARKET_TEMPLATE_EVIDENCE.map(copyIfindMarketTemplateEvidence)
}

function getIfindMarketTemplateEvidence(templateId) {
  if (typeof templateId !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(templateId)) {
    throw invalidEvidence()
  }
  const evidence = MARKET_TEMPLATE_EVIDENCE.find((entry) => entry.templateId === templateId)
  return evidence ? copyIfindMarketTemplateEvidence(evidence) : null
}

module.exports = {
  IFIND_MARKET_TEMPLATE_EVIDENCE_INVALID,
  IfindMarketTemplateEvidenceError,
  copyIfindMarketTemplateEvidence,
  getIfindMarketTemplateEvidence,
  listIfindMarketTemplateEvidence
}
