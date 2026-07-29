const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '../..')
const appPath = path.join(projectRoot, 'public/app.js')
const cssPath = path.join(projectRoot, 'public/app.css')
const htmlPath = path.join(projectRoot, 'public/index.html')

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function loadFinanceContracts() {
  return require('../../public/finance-contract')
}

function makeVerifiedRealRow(overrides = {}) {
  const sourceOverrides = overrides.source || {}
  return {
    dataMode: 'real',
    periodType: 'annual',
    period: '2026',
    reportDate: '2026-12-31',
    currency: 'CNY',
    unit: '百万元',
    values: { revenue: 100 },
    ...overrides,
    source: {
      sourceName: '已验证指标来源',
      sourceType: 'ifind_indicator',
      scopeVerified: true,
      sourceTime: '2026-07-27T20:13:00.000Z',
      fetchTime: '2026-07-28T03:10:00.000Z',
      ...sourceOverrides
    }
  }
}

function makeVerifiedMockRow(overrides = {}) {
  const sourceOverrides = overrides.source || {}
  return {
    dataMode: 'mock',
    periodType: 'annual',
    period: '2026',
    reportDate: '2026-12-31',
    currency: 'CNY',
    unit: '百万元',
    values: { revenue: 100 },
    ...overrides,
    source: {
      sourceName: 'Mock fixture（模拟 iFinD 指标结构，非真实返回）',
      sourceType: 'mock_fixture',
      mockContractVerified: true,
      sourceTime: '2026-07-27T20:13:00.000Z',
      fetchTime: '2026-07-28T03:10:00.000Z',
      ...sourceOverrides
    }
  }
}

function assertFinanceModeMappingAndFixtureBehavior() {
  const { getFinanceRowsForMode, isVerifiedFinanceRow, prepareFinanceRows } = loadFinanceContracts()
  const { getCompany } = require('../data/mockData')

  const alibaba = getCompany('09888.HK')
  const apple = getCompany('AAPL.US')
  const quarterly = getFinanceRowsForMode(alibaba.financials, 'quarter')
  assert.equal(quarterly.length, 1)
  assert.equal(quarterly[0].period, '2026-Q1')
  assert.equal(getFinanceRowsForMode(alibaba.financials, 'annual').length, 2)
  assert.equal(getFinanceRowsForMode(alibaba.financials, 'unsupported').length, 0)

  for (const row of [...alibaba.financials.annual, ...quarterly, ...apple.financials.annual]) {
    assert.equal(row.dataMode, 'mock')
    assert.equal(row.source.sourceType, 'mock_fixture')
    assert.equal(row.source.mockContractVerified, true)
    assert.notEqual(row.source.scopeVerified, true)
    assert.equal(row.source.sourceName, 'Mock fixture（模拟 iFinD 指标结构，非真实返回）')
    assert.equal(isVerifiedFinanceRow(row), true, `${row.period} must carry verified source metadata`)
  }

  const firstSource = makeVerifiedRealRow({
    period: '2025',
    source: { sourceName: '来源 A' }
  })
  const secondSource = makeVerifiedRealRow({
    period: '2026',
    source: { sourceName: '来源 B', sourceType: 'ifind_topic_report' }
  })
  const missingSource = makeVerifiedRealRow({ period: '2024', source: { sourceName: '' } })
  const prepared = prepareFinanceRows({
    annual: [firstSource, missingSource, secondSource],
    quarterly: []
  }, 'annual')

  assert.deepEqual(prepared.rows.map((row) => row.source.sourceName), ['来源 A', '来源 B'])
  assert.equal(prepared.totalCount, 3)
  assert.equal(prepared.rejectedCount, 1)
}

function assertStrictFinanceVerification() {
  const { isVerifiedFinanceRow, prepareFinanceRows } = loadFinanceContracts()
  const mutations = [
    (row) => { row.dataMode = 'unknown' },
    (row) => { row.source = null },
    (row) => { row.source.sourceName = '' },
    (row) => { row.source.sourceType = '' },
    (row) => { row.source.sourceType = 'unverified_vendor' },
    (row) => { row.source.scopeVerified = false },
    (row) => { delete row.source.scopeVerified },
    (row) => { row.source.sourceTime = '' },
    (row) => { row.source.fetchTime = '' },
    (row) => { row.period = '' },
    (row) => { row.reportDate = '' },
    (row) => { row.currency = '' },
    (row) => { row.unit = '' }
  ]

  for (const mutate of mutations) {
    const row = makeVerifiedRealRow()
    mutate(row)
    assert.equal(isVerifiedFinanceRow(row), false)
  }

  const invalidRows = mutations.map((mutate) => {
    const row = makeVerifiedRealRow()
    mutate(row)
    return row
  })
  const prepared = prepareFinanceRows({ annual: invalidRows }, 'annual')
  assert.equal(prepared.rows.length, 0)
  assert.equal(prepared.rejectedCount, invalidRows.length)
}

function assertMockAndRealVerificationAreDistinct() {
  const { isVerifiedFinanceRow, prepareFinanceRows } = loadFinanceContracts()
  const verifiedMock = makeVerifiedMockRow()
  assert.equal(isVerifiedFinanceRow(verifiedMock), true)

  const mockWithoutContract = makeVerifiedMockRow()
  delete mockWithoutContract.source.mockContractVerified
  assert.equal(isVerifiedFinanceRow(mockWithoutContract), false)

  const mockPosingAsReal = makeVerifiedMockRow({
    source: {
      sourceName: 'iFinD company 指标',
      sourceType: 'mock_fixture'
    }
  })
  assert.equal(isVerifiedFinanceRow(mockPosingAsReal), false)

  const realWithoutScope = makeVerifiedRealRow()
  delete realWithoutScope.source.scopeVerified
  const disguisedIfind = makeVerifiedRealRow({
    source: { sourceName: '伪装 iFinD', sourceType: 'ifind_indicator', scopeVerified: false }
  })
  const prepared = prepareFinanceRows({
    annual: [verifiedMock, realWithoutScope, disguisedIfind]
  }, 'annual')
  assert.deepEqual(prepared.rows, [verifiedMock])
  assert.equal(prepared.rejectedCount, 2)
}

function assertDefaultAnomaliesRemainDeterministic() {
  const app = read(appPath)
  assert.doesNotMatch(app, /含投资提示/)
  assert.doesNotMatch(app, /it\.note/)
  assert.doesNotMatch(app, /待验证来源（Mock）/)
  assert.match(app, /prepareFinanceRows/)
  assert.match(app, /该报告期来源口径未验证，未展示数据/)
  assert.match(app, /Mock（非真实）/)
  assert.match(app, /r\.source\.sourceName/)
}

function assertFaviconAndMobileTableScrolling() {
  const html = read(htmlPath)
  const css = read(cssPath)

  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/)
  assert.match(html, /id="finance-table-wrap" class="table-scroll finance-table-scroll"/)
  assert.match(html, /id="breakdown-table" class="table-scroll breakdown-table-scroll"/)
  assert.match(html, /id="finance-table-wrap"[^>]*aria-label="[^"]+"/)
  assert.match(html, /id="breakdown-table"[^>]*aria-label="[^"]+"/)
  assert.match(html, /id="finance-table-wrap"[^>]*tabindex="0"[^>]*aria-describedby="finance-scroll-hint"/)
  assert.match(html, /id="breakdown-table"[^>]*tabindex="0"[^>]*aria-describedby="breakdown-scroll-hint"/)
  assert.match(css, /\.table-scroll\s*\{[^}]*overflow-x:\s*auto;/s)
  assert.match(css, /\.finance-table-scroll table\s*\{[^}]*min-width:/s)
  assert.match(css, /\.breakdown-table-scroll table\s*\{[^}]*min-width:/s)
}

async function run() {
  assertFinanceModeMappingAndFixtureBehavior()
  assertStrictFinanceVerification()
  assertMockAndRealVerificationAreDistinct()
  assertDefaultAnomaliesRemainDeterministic()
  assertFaviconAndMobileTableScrolling()
}

module.exports = { run }
