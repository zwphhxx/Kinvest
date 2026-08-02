const assert = require('node:assert/strict')
const {
  IFIND_VERIFICATION_FIELDS,
  createMockVerificationState,
  isPureSourceBlock,
  isVerifiedDataBlock
} = require('../../public/data-source-contract')
const { isVerifiedFinanceRow, prepareFinanceRows } = require('../../public/finance-contract')
const { createIfindClient, getFixtureContractMetrics } = require('../adapters/ifindAdapter')
const { getCompany } = require('../data/mockData')
const { apiCompany, sanitizeCompanyData } = require('../server')

const REAL_SOURCE_TYPES = ['ifind_indicator', 'ifind_topic_report', 'official_announcement']

function makeVerification(status = 'verified') {
  return Object.fromEntries(IFIND_VERIFICATION_FIELDS.map((field) => [field, status]))
}

function makeRealRow(overrides = {}) {
  const sourceOverrides = overrides.source || {}
  return {
    dataMode: 'real',
    periodType: 'annual',
    period: '2026',
    reportDate: '2026-12-31',
    currency: 'CNY',
    unit: '百万元',
    values: { revenue: 100, grossMargin: null },
    ...overrides,
    source: {
      sourceMode: 'real',
      sourceName: '已验证 iFinD 指标来源',
      sourceType: 'ifind_indicator',
      sourceTime: '2026-07-27T20:13:00.000Z',
      fetchTime: '2026-07-28T03:10:00.000Z',
      verification: makeVerification(),
      ...sourceOverrides
    }
  }
}

async function run() {
  const verifiedReal = makeRealRow()
  assert.equal(isVerifiedDataBlock(verifiedReal, REAL_SOURCE_TYPES), true)
  assert.equal(isVerifiedFinanceRow(verifiedReal), true)
  assert.equal(verifiedReal.values.grossMargin, null, 'missing real fields must remain missing')

  for (const field of IFIND_VERIFICATION_FIELDS) {
    for (const status of ['unverified', 'failed', 'not_applicable']) {
      const row = makeRealRow()
      row.source.verification[field] = status
      assert.equal(isVerifiedFinanceRow(row), false, `${field}=${status} must reject a real row`)
    }
  }

  const legacyBooleanOnly = makeRealRow({ source: { scopeVerified: true } })
  delete legacyBooleanOnly.source.verification
  assert.equal(isVerifiedFinanceRow(legacyBooleanOnly), false)

  const mockFallback = makeRealRow()
  mockFallback.values.grossMargin = { value: 31, dataMode: 'mock' }
  assert.equal(isPureSourceBlock(mockFallback), false)
  assert.equal(isVerifiedFinanceRow(mockFallback), false)

  const prepared = prepareFinanceRows({ annual: [verifiedReal, mockFallback] }, 'annual')
  assert.deepEqual(prepared.rows, [verifiedReal])
  assert.equal(prepared.rejectedCount, 1)

  const alibaba = getCompany('9988.HK')
  for (const row of [...alibaba.financials.annual, ...alibaba.financials.quarterly]) {
    assert.equal(isVerifiedFinanceRow(row), true)
    assert.deepEqual(row.source.verification, createMockVerificationState())
  }
  assert.equal(isVerifiedDataBlock(alibaba.businessBreakdown), true)

  const mixed = prepareFinanceRows({
    annual: [alibaba.financials.annual[0], makeRealRow()]
  }, 'annual')
  assert.deepEqual(mixed.rows, [])
  assert.equal(mixed.rejectedCount, 2)
  assert.equal(mixed.sourceMode, null)
  assert.equal(mixed.errorCode, 'MIXED_SOURCE_MODE')

  assert.deepEqual(getFixtureContractMetrics().sort(), [
    'announcements',
    'company',
    'data-pool',
    'history',
    'realtime',
    'series'
  ])

  const supported = await createIfindClient().getFinancial('realtime')
  assert.equal(supported.dataMode, 'mock')
  assert.equal(supported.contractStatus, 'verified_fixture')
  assert.equal(Object.hasOwn(supported, 'verified'), false)
  assert.deepEqual(supported.source.verification, createMockVerificationState())
  const unsupported = await createIfindClient().getFinancial('unknown-metric')
  assert.equal(unsupported.contractStatus, 'unsupported')
  assert.equal(unsupported.source.mockContractVerified, false)

  const originalAnnual = alibaba.financials.annual
  alibaba.financials.annual = [...originalAnnual, makeRealRow()]
  try {
    const sanitized = sanitizeCompanyData(alibaba)
    assert.deepEqual(sanitized.financials.annual, [])
    assert.equal(sanitized.financials.validation.annual.errorCode, 'MIXED_SOURCE_MODE')

    const response = {
      body: null,
      status: null,
      writeHead(status) {
        this.status = status
      },
      end(payload) {
        this.body = JSON.parse(payload)
      }
    }
    await apiCompany({}, response, '9988.HK')
    assert.equal(response.status, 200)
    assert.deepEqual(response.body.data.financials.annual, [])
    assert.equal(
      response.body.data.financials.validation.annual.errorCode,
      'MIXED_SOURCE_MODE'
    )
  } finally {
    alibaba.financials.annual = originalAnnual
  }
}

module.exports = { run }
