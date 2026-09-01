'use strict'

const assert = require('assert')
const {
  IFIND_MARKET_TEMPLATE_EVIDENCE_INVALID,
  IfindMarketTemplateEvidenceError,
  copyIfindMarketTemplateEvidence,
  getIfindMarketTemplateEvidence,
  listIfindMarketTemplateEvidence
} = require('../domain/ifind-market-template-evidence')
const { createLiveRequestManifest } = require('../domain/ifind-market-cases')
const {
  validateLiveRequestManifestDefinition
} = require('../domain/ifind-market-manifest-validator')

const expectedIds = [
  'HK_EQUITY_V2',
  'US_EQUITY_V2',
  'CN_SH_EQUITY_V2',
  'CN_SZ_EQUITY_V2',
  'CN_BJ_EQUITY_V1'
]

function isInvalidEvidence(error) {
  return error instanceof IfindMarketTemplateEvidenceError &&
    error.code === IFIND_MARKET_TEMPLATE_EVIDENCE_INVALID
}

async function runIfindMarketTemplateEvidence() {
  const templates = listIfindMarketTemplateEvidence()
  assert.deepStrictEqual(templates.map((entry) => entry.templateId), expectedIds)
  assert.equal(new Set(templates.map((entry) => entry.sample.listingId)).size, 5)

  for (const template of templates) {
    assert.equal(
      template.templateVersion,
      template.templateId.endsWith('_V2') ? 2 : 1
    )
    assert.equal(template.executable, false)
    assert.equal(template.liveReady, false)
    assert.equal(template.executionStatus, 'blocked')
    assert.equal(template.reasonCode, 'IFIND_TEMPLATE_NOT_EXECUTABLE')
    assert.equal(template.sample.vendorCode, null)
    assert.equal(template.sample.vendorCodeStatus, 'unverified')
    assert.deepStrictEqual(template.activationBlockers, [
      'IFIND_ISSUER_IDENTITY_UNVERIFIED',
      'IFIND_VENDOR_CODE_UNVERIFIED',
      'IFIND_QUOTE_TEMPLATE_UNVERIFIED',
      'IFIND_FINANCIAL_TEMPLATE_UNVERIFIED'
    ])
    assert.equal(template.requestEvidence.identity.status, 'unverified')
    assert.equal(template.requestEvidence.quote.status, 'unverified')
    assert.equal(template.requestEvidence.financial.status, 'unverified')
    assert.equal(Object.isFrozen(template), true)
    assert.equal(Object.isFrozen(template.sample), true)
    assert.throws(
      () => validateLiveRequestManifestDefinition(template),
      (error) => error instanceof Error &&
        /** @type {{ code?: unknown }} */ (error).code === 'IFIND_MARKET_MANIFEST_INVALID'
    )
  }

  const hk = getIfindMarketTemplateEvidence('HK_EQUITY_V2')
  assert.equal(hk.sample.displayCode, '9988.HK')
  assert.deepStrictEqual(hk.sample.formatAliases, ['09988.HK'])
  assert.equal(hk.sample.formatAliases.includes('09888.HK'), false)
  assert.deepStrictEqual(hk.requestEvidence.quote.candidateIndicatorIds, [
    'latest', 'preClose', 'open', 'high', 'low', 'amount', 'volume', 'tradeDate', 'tradeTime'
  ])

  const us = getIfindMarketTemplateEvidence('US_EQUITY_V2')
  assert.equal(us.sample.displayCode, 'AAPL.US')
  assert.equal(us.sample.vendorCode, null)
  assert.equal(us.evidenceNotes.some((note) => note.includes('AAPL.O')), true)

  const sh = getIfindMarketTemplateEvidence('CN_SH_EQUITY_V2')
  const sz = getIfindMarketTemplateEvidence('CN_SZ_EQUITY_V2')
  assert.deepStrictEqual(sh.requestEvidence.quote.candidateIndicatorIds, ['open', 'high', 'low', 'latest'])
  assert.deepStrictEqual(sz.requestEvidence.quote.candidateIndicatorIds, ['open', 'high', 'low', 'latest'])

  const bj = getIfindMarketTemplateEvidence('CN_BJ_EQUITY_V1')
  assert.equal(bj.sample.displayCode, '920953.BJ')
  assert.deepStrictEqual(bj.sample.formatAliases, [])
  assert.equal(bj.evidenceNotes.some((note) => note.includes('872953.BJ')), true)

  assert.equal(getIfindMarketTemplateEvidence('UNKNOWN'), null)
  assert.throws(
    () => createLiveRequestManifest('HK_EQUITY_V2'),
    (error) => error instanceof Error &&
      /** @type {{ code?: unknown }} */ (error).code === 'IFIND_MARKET_CASE_UNKNOWN'
  )
  assert.throws(() => getIfindMarketTemplateEvidence('../HK'), isInvalidEvidence)
  assert.throws(
    () => copyIfindMarketTemplateEvidence({ ...hk, executable: true }),
    isInvalidEvidence
  )
  assert.throws(
    () => copyIfindMarketTemplateEvidence({ ...hk, extra: true }),
    isInvalidEvidence
  )

  const accessor = {}
  Object.defineProperty(accessor, 'templateId', {
    enumerable: true,
    get() { return 'HK_EQUITY_V2' }
  })
  assert.throws(() => copyIfindMarketTemplateEvidence(accessor), isInvalidEvidence)
  assert.throws(
    () => copyIfindMarketTemplateEvidence(new Proxy({}, {
      ownKeys() { throw new Error('proxy trap') }
    })),
    isInvalidEvidence
  )
  assert.throws(
    () => copyIfindMarketTemplateEvidence(new Proxy(hk, {})),
    isInvalidEvidence
  )
  assert.throws(
    () => copyIfindMarketTemplateEvidence({
      ...hk,
      sample: new Proxy(hk.sample, {})
    }),
    isInvalidEvidence
  )
  assert.throws(
    () => copyIfindMarketTemplateEvidence({
      ...hk,
      evidenceNotes: new Proxy(hk.evidenceNotes, {})
    }),
    isInvalidEvidence
  )
  const revoked = Proxy.revocable(hk, {})
  revoked.revoke()
  assert.throws(() => copyIfindMarketTemplateEvidence(revoked.proxy), isInvalidEvidence)
}

module.exports = { run: runIfindMarketTemplateEvidence }
