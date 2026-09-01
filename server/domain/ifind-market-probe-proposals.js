'use strict'

const { types: { isProxy } } = require('node:util')
const {
  getIfindMarketTemplateEvidence
} = require('./ifind-market-template-evidence')

const IFIND_MARKET_PROBE_PROPOSAL_INVALID = 'IFIND_MARKET_PROBE_PROPOSAL_INVALID'
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

class IfindMarketProbeProposalError extends Error {
  constructor() {
    super('Invalid fixed iFinD market probe proposal')
    this.name = 'IfindMarketProbeProposalError'
    this.code = IFIND_MARKET_PROBE_PROPOSAL_INVALID
  }
}

const HK_TEMPLATE = getIfindMarketTemplateEvidence('HK_EQUITY_V2')
if (!HK_TEMPLATE || HK_TEMPLATE.liveReady !== false ||
  HK_TEMPLATE.sample.vendorCode !== null) {
  throw new IfindMarketProbeProposalError()
}

const HK_ALIBABA_PROBE = {
  proposalId: 'HK_ALIBABA_9988_V1',
  proposalVersion: 1,
  templateId: 'HK_EQUITY_V2',
  templateVersion: 2,
  caseId: 'HK_ALIBABA_9988',
  createdAt: '2026-09-01',
  purpose: 'collect-normalized-unverified-template-evidence',
  executionStatus: 'blocked',
  reasonCode: 'IFIND_PROBE_REQUIRES_EXPLICIT_APPROVAL',
  approval: {
    requiredAtExecution: true,
    scope: 'one-fixed-proposal-run'
  },
  budget: {
    maxAuthenticationRequests: 1,
    maxBusinessRequests: 3,
    maxRetries: 0,
    maxConcurrency: 1
  },
  requests: [
    {
      sequence: 1,
      stage: 'identity',
      method: 'POST',
      endpoint: '/api/v1/basic_data_service',
      evidenceStatus: 'candidate',
      body: {
        codes: '9988.HK',
        indipara: [{ indicator: 'ths_stock_short_name_stock' }]
      },
      sourceReferences: ['IFIND_QUANTAPI_MANUAL'],
      limitations: [
        'The official example is A-share-specific and does not prove this indicator applies to HK equities.',
        'A successful response is observation only and cannot automatically verify issuer identity or vendor code.'
      ]
    },
    {
      sequence: 2,
      stage: 'quote',
      method: 'POST',
      endpoint: '/api/v1/real_time_quotation',
      evidenceStatus: 'candidate',
      body: {
        codes: '9988.HK',
        indicators: 'latest,preClose,open,high,low,amount,volume,tradeDate,tradeTime'
      },
      sourceReferences: [
        'IFIND_SUPER_COMMAND_OBSERVATION',
        'IFIND_QUANTAPI_MANUAL'
      ],
      limitations: [
        'Generated fields do not prove entitlement, response shape, currency, unit, timezone or trading status.',
        'Missing fields remain missing and are not filled from Mock data.'
      ]
    },
    {
      sequence: 3,
      stage: 'financial',
      method: 'POST',
      endpoint: '/api/v1/basic_data_service',
      evidenceStatus: 'candidate',
      body: {
        codes: '9988.HK',
        indipara: [{
          indicator: 'revenue_oas',
          indiparams: ['20260331', '1', 'BB']
        }]
      },
      sourceReferences: [
        'IFIND_SUPER_COMMAND_OBSERVATION',
        'IFIND_QUANTAPI_MANUAL'
      ],
      limitations: [
        'The requested selector does not prove the returned report period or period type.',
        'Original-currency selection does not prove the returned currency, unit or scale.'
      ]
    }
  ],
  resultPolicy: {
    automaticPromotion: false,
    persistRawResponse: false,
    persistRequestId: false,
    persistNormalizedSafeSummary: true,
    sourceModeAfterRun: null
  }
}

const PROPOSALS = Object.freeze([HK_ALIBABA_PROBE])

function invalidProposal() {
  return new IfindMarketProbeProposalError()
}

function clonePlainData(value, active = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidProposal()
    return value
  }
  if (!value || typeof value !== 'object' || isProxy(value) || active.has(value)) {
    throw invalidProposal()
  }

  active.add(value)
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.getOwnPropertySymbols(value).length !== 0) throw invalidProposal()
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw invalidProposal()
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length')
      const length = lengthDescriptor && lengthDescriptor.value
      if (!Number.isSafeInteger(length) || length < 0 ||
        Object.getOwnPropertyNames(value).length !== length + 1) throw invalidProposal()
      const result = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[index]
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw invalidProposal()
        }
        result.push(clonePlainData(descriptor.value, active))
      }
      return result
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) throw invalidProposal()
    const result = {}
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (DANGEROUS_KEYS.has(key) || !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')) {
        throw invalidProposal()
      }
      Object.defineProperty(result, key, {
        value: clonePlainData(descriptor.value, active),
        enumerable: true,
        configurable: true,
        writable: true
      })
    }
    return result
  } catch (error) {
    if (error instanceof IfindMarketProbeProposalError) throw error
    throw invalidProposal()
  } finally {
    active.delete(value)
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

function copyIfindMarketProbeProposal(value) {
  const clone = clonePlainData(value)
  const expected = PROPOSALS.find((entry) => entry.proposalId === clone.proposalId)
  if (!expected || canonicalJson(clone) !== canonicalJson(expected)) throw invalidProposal()
  return deepFreeze(clone)
}

function listIfindMarketProbeProposals() {
  return PROPOSALS.map(copyIfindMarketProbeProposal)
}

function getIfindMarketProbeProposal(proposalId) {
  if (typeof proposalId !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(proposalId)) {
    throw invalidProposal()
  }
  const proposal = PROPOSALS.find((entry) => entry.proposalId === proposalId)
  return proposal ? copyIfindMarketProbeProposal(proposal) : null
}

module.exports = {
  IFIND_MARKET_PROBE_PROPOSAL_INVALID,
  IfindMarketProbeProposalError,
  copyIfindMarketProbeProposal,
  getIfindMarketProbeProposal,
  listIfindMarketProbeProposals
}
