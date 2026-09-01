'use strict'

const assert = require('assert')
const {
  IFIND_MARKET_PROBE_PROPOSAL_INVALID,
  IfindMarketProbeProposalError,
  copyIfindMarketProbeProposal,
  getIfindMarketProbeProposal,
  listIfindMarketProbeProposals
} = require('../domain/ifind-market-probe-proposals')
const {
  validateLiveRequestManifestDefinition
} = require('../domain/ifind-market-manifest-validator')

function isInvalidProposal(error) {
  return error instanceof IfindMarketProbeProposalError &&
    error.code === IFIND_MARKET_PROBE_PROPOSAL_INVALID
}

async function runIfindMarketProbeProposals() {
  const proposals = listIfindMarketProbeProposals()
  assert.equal(proposals.length, 1)
  const proposal = proposals[0]
  assert.equal(proposal.proposalId, 'HK_ALIBABA_9988_V1')
  assert.equal(proposal.templateId, 'HK_EQUITY_V2')
  assert.equal(proposal.templateVersion, 2)
  assert.equal(proposal.executionStatus, 'blocked')
  assert.equal(proposal.reasonCode, 'IFIND_PROBE_REQUIRES_EXPLICIT_APPROVAL')
  assert.deepStrictEqual(proposal.budget, {
    maxAuthenticationRequests: 1,
    maxBusinessRequests: 3,
    maxRetries: 0,
    maxConcurrency: 1
  })
  assert.deepStrictEqual(proposal.requests.map((request) => request.stage), [
    'identity', 'quote', 'financial'
  ])
  assert.deepStrictEqual(proposal.requests.map((request) => request.sequence), [1, 2, 3])
  assert.deepStrictEqual(proposal.requests[0].body, {
    codes: '9988.HK',
    indipara: [{ indicator: 'ths_stock_short_name_stock' }]
  })
  assert.deepStrictEqual(proposal.requests[1].body, {
    codes: '9988.HK',
    indicators: 'latest,preClose,open,high,low,amount,volume,tradeDate,tradeTime'
  })
  assert.deepStrictEqual(proposal.requests[2].body, {
    codes: '9988.HK',
    indipara: [{
      indicator: 'revenue_oas',
      indiparams: ['20260331', '1', 'BB']
    }]
  })
  assert.equal(proposal.requests[0].evidenceStatus, 'candidate')
  assert.match(proposal.requests[0].limitations[0], /A-share-specific/)
  assert.equal(proposal.resultPolicy.automaticPromotion, false)
  assert.equal(proposal.resultPolicy.persistRawResponse, false)
  assert.equal(proposal.resultPolicy.persistRequestId, false)
  assert.equal(proposal.resultPolicy.sourceModeAfterRun, null)
  assert.equal(Object.isFrozen(proposal), true)
  assert.equal(Object.isFrozen(proposal.requests[0].body), true)
  assert.equal(Object.getPrototypeOf(proposal), Object.prototype)
  assert.equal(getIfindMarketProbeProposal('UNKNOWN'), null)
  assert.throws(() => getIfindMarketProbeProposal('../HK'), isInvalidProposal)
  assert.throws(
    () => copyIfindMarketProbeProposal({ ...proposal, executionStatus: 'ready' }),
    isInvalidProposal
  )
  assert.throws(
    () => copyIfindMarketProbeProposal({ ...proposal, accessToken: 'forbidden' }),
    isInvalidProposal
  )
  assert.throws(
    () => copyIfindMarketProbeProposal(new Proxy(proposal, {})),
    isInvalidProposal
  )
  assert.throws(
    () => copyIfindMarketProbeProposal({
      ...proposal,
      requests: new Proxy(proposal.requests, {})
    }),
    isInvalidProposal
  )
  for (const dangerousKey of ['__proto__', 'prototype', 'constructor']) {
    const dangerous = { ...proposal }
    Object.defineProperty(dangerous, dangerousKey, {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true
    })
    assert.throws(
      () => copyIfindMarketProbeProposal(dangerous),
      isInvalidProposal,
      dangerousKey
    )
  }
  assert.throws(
    () => validateLiveRequestManifestDefinition(proposal),
    (error) => error instanceof Error &&
      /** @type {{ code?: unknown }} */ (error).code === 'IFIND_MARKET_MANIFEST_INVALID'
  )

  const serialized = canonicalForSafetyScan(proposal)
  assert.doesNotMatch(serialized, /refresh[_-]?token|access[_-]?token|authorization|cookie/i)
}

function canonicalForSafetyScan(value) {
  return JSON.stringify(value)
}

module.exports = { run: runIfindMarketProbeProposals }
