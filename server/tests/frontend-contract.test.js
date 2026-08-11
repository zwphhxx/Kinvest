const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '../..')
const appPath = path.join(projectRoot, 'public/app.js')
const cssPath = path.join(projectRoot, 'public/app.css')
const htmlPath = path.join(projectRoot, 'public/index.html')
const researchHtmlPath = path.join(projectRoot, 'public/research.html')
const researchJsPath = path.join(projectRoot, 'public/research.js')

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function extractCssBlock(css, selector) {
  const selectorIndex = css.indexOf(selector)
  assert.notEqual(selectorIndex, -1, `Missing CSS selector: ${selector}`)
  const openingBrace = css.indexOf('{', selectorIndex)
  assert.notEqual(openingBrace, -1, `Missing CSS block: ${selector}`)
  let depth = 1

  for (let index = openingBrace + 1; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    if (css[index] === '}') depth -= 1
    if (depth === 0) return css.slice(openingBrace + 1, index)
  }

  assert.fail(`Unclosed CSS block: ${selector}`)
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
      sourceMode: 'real',
      verification: {
        issuerIdentityStatus: 'verified',
        vendorCodeStatus: 'verified',
        entitlementStatus: 'verified',
        currencyStatus: 'verified',
        unitStatus: 'verified',
        reportPeriodStatus: 'verified',
        scopeStatus: 'verified'
      },
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
      sourceMode: 'mock',
      verification: {
        issuerIdentityStatus: 'not_applicable',
        vendorCodeStatus: 'not_applicable',
        entitlementStatus: 'not_applicable',
        currencyStatus: 'not_applicable',
        unitStatus: 'not_applicable',
        reportPeriodStatus: 'not_applicable',
        scopeStatus: 'not_applicable'
      },
      sourceTime: '2026-07-27T20:13:00.000Z',
      fetchTime: '2026-07-28T03:10:00.000Z',
      ...sourceOverrides
    }
  }
}

function assertFinanceModeMappingAndFixtureBehavior() {
  const { getFinanceRowsForMode, isVerifiedFinanceRow, prepareFinanceRows } = loadFinanceContracts()
  const { getCompany } = require('../data/mockData')

  const alibaba = getCompany('9988.HK')
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
    (row) => { row.source.sourceMode = 'mock' },
    (row) => { row.source.verification.issuerIdentityStatus = 'unverified' },
    (row) => { row.source.verification.vendorCodeStatus = 'failed' },
    (row) => { row.source.verification.entitlementStatus = 'not_applicable' },
    (row) => { delete row.source.verification.currencyStatus },
    (row) => { delete row.source.verification },
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

  const realWithoutVerification = makeVerifiedRealRow()
  delete realWithoutVerification.source.verification
  const disguisedIfind = makeVerifiedRealRow({
    source: { sourceName: '伪装 iFinD', sourceType: 'ifind_indicator' }
  })
  disguisedIfind.source.verification.scopeStatus = 'failed'
  const prepared = prepareFinanceRows({
    annual: [verifiedMock, realWithoutVerification, disguisedIfind]
  }, 'annual')
  assert.deepEqual(prepared.rows, [])
  assert.equal(prepared.rejectedCount, 3)
  assert.equal(prepared.errorCode, 'MIXED_SOURCE_MODE')
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

function assertValuationPositionContract() {
  const {
    markerPositions,
    prepareValuationPosition
  } = require('../../public/valuation-position')

  assert.deepEqual(markerPositions, Array.from({ length: 21 }, (_, index) => index * 5))
  assert.deepEqual(
    prepareValuationPosition({ lastPrice: 15, low3Y: 10, high3Y: 20 }),
    { available: true, ratio: 50, markerPosition: 50 }
  )
  assert.deepEqual(
    prepareValuationPosition({ lastPrice: 0, low3Y: 10, high3Y: 20 }),
    { available: true, ratio: 0, markerPosition: 0 }
  )
  assert.deepEqual(
    prepareValuationPosition({ lastPrice: 30, low3Y: 10, high3Y: 20 }),
    { available: true, ratio: 100, markerPosition: 100 }
  )

  const invalidQuotes = [
    { lastPrice: 10, low3Y: 10, high3Y: 10 },
    { lastPrice: 10, low3Y: 20, high3Y: 10 },
    { lastPrice: 10, low3Y: null, high3Y: 20 },
    { lastPrice: '10', low3Y: 0, high3Y: 20 },
    { lastPrice: Number.NaN, low3Y: 0, high3Y: 20 }
  ]
  for (const quote of invalidQuotes) {
    assert.deepEqual(
      prepareValuationPosition(quote),
      { available: false, ratio: null, markerPosition: null }
    )
  }

  for (let lastPrice = 0; lastPrice <= 100; lastPrice += 1) {
    const result = prepareValuationPosition({ lastPrice, low3Y: 0, high3Y: 100 })
    assert.equal(markerPositions.includes(result.markerPosition), true)
  }
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

  const mobileCss = extractCssBlock(css, '@media (max-width: 860px)')
  const mobileCompanyContent = extractCssBlock(mobileCss, '#company-content')
  assert.match(mobileCompanyContent, /overflow-x:\s*clip;/)
  assert.doesNotMatch(mobileCss, /body\s*\{[^}]*overflow-x:\s*hidden;/s)
}

function assertRenderingRespectsStrictCsp() {
  const app = read(appPath)
  const css = read(cssPath)
  const html = read(htmlPath)

  assert.doesNotMatch(`${app}\n${html}`, /<[^>]*\sstyle=/i)
  assert.doesNotMatch(app, /\.style(?:\.|\[|\s*=)/)
  assert.doesNotMatch(app, /setAttribute\(\s*['"]style['"]/i)
  assert.match(app, /el\.thermo\.dataset\.position = String\(valuationPosition\.markerPosition\)/)
  assert.match(app, /估值温度尺：区间不可用/)
  assert.match(html, /<script src="\/valuation-position\.js" defer><\/script>[\s\S]*<script src="\/app\.js" defer><\/script>/)
  assert.match(html, /<script src="\/data-source-contract\.js" defer><\/script>[\s\S]*<script src="\/finance-contract\.js" defer><\/script>/)
  assert.match(css, /\.company-title\s*\{[^}]*margin:\s*0;/s)
  assert.match(css, /\.thermometer\.unavailable::after\s*\{[^}]*display:\s*none;/s)
  for (let position = 0; position <= 100; position += 5) {
    assert.match(css, new RegExp(`\\.thermometer\\[data-position="${position}"\\]\\s*\\{`))
  }
}

function assertResearchPageRespectsStrictCsp() {
  const html = read(researchHtmlPath)
  const script = read(researchJsPath)

  assert.doesNotMatch(html, /<style(?:\s|>)/i)
  assert.doesNotMatch(html, /<[^>]*\sstyle=/i)
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i)
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i)
  assert.match(html, /id="research-body" class="card hidden"/)
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/)
  assert.match(html, /<link rel="stylesheet" href="\/research\.css" \/>/)
  assert.match(html, /<script src="\/research-contract\.js" defer><\/script>[\s\S]*<script src="\/research\.js" defer><\/script>/)
  assert.doesNotMatch(script, /\.(?:innerHTML|outerHTML)/)
  assert.doesNotMatch(script, /insertAdjacentHTML|document\.write/)
  assert.doesNotMatch(script, /\.on[a-z]+\s*=/i)
  assert.doesNotMatch(script, /javascript:/i)
  assert.doesNotMatch(script, /\.style(?:\.|\[|\s*=)/)
  assert.doesNotMatch(script, /setAttribute\(\s*['"]style['"]/i)
  assert.match(script, /textContent/)
  assert.match(script, /replaceChildren/)
}

async function assertResearchResponseContract() {
  const {
    normalizeResearchResponse,
    normalizeSecurityCode,
    parseJsonResponse
  } = require('../../public/research-contract')
  const validPayload = {
    success: true,
    data: {
      nameZh: '测试公司',
      version: 1,
      snapshotTime: '2026-07-29T00:00:00.000Z',
      generatedAt: '2026-07-29T00:01:00.000Z',
      citedAnnouncementsCount: 1,
      citedNewsCount: 2,
      tags: ['<img src=x onerror=alert(1)>'],
      sourceMode: 'mock',
      modelStatus: {
        mode: 'safe_mock',
        called: false,
        reason: 'MODEL_CONFIGURATION_INCOMPLETE'
      },
      sections: {
        thesis: '<script>alert(1)</script>',
        bulls: ['<b>多头</b>'],
        bears: ['javascript:alert(1)'],
        catalysts: ['催化剂'],
        invalidation: ['证伪条件']
      }
    }
  }

  assert.equal(normalizeSecurityCode('aapl.us'), 'AAPL.US')
  assert.equal(normalizeSecurityCode('9988.HK'), '9988.HK')
  for (const invalid of ['', '../api/health', 'AAPL.US?x=1', 'AAPL/US', null]) {
    assert.equal(normalizeSecurityCode(invalid), null)
  }

  const normalized = normalizeResearchResponse(validPayload)
  assert.equal(normalized.ok, true)
  assert.equal(normalized.data.sections.thesis, '<script>alert(1)</script>')

  const malformedPayloads = [
    null,
    {},
    { success: true, data: null },
    { success: true, data: { ...validPayload.data, tags: 'not-an-array' } },
    {
      success: true,
      data: {
        ...validPayload.data,
        sourceMode: 'real',
        modelStatus: { mode: 'safe_mock', called: false, reason: 'MODEL_CONFIGURATION_INCOMPLETE' }
      }
    },
    {
      success: true,
      data: {
        ...validPayload.data,
        sections: { ...validPayload.data.sections, bulls: null }
      }
    },
    { success: true, data: { ...validPayload.data, generatedAt: 'invalid-date' } }
  ]
  for (const payload of malformedPayloads) {
    assert.equal(normalizeResearchResponse(payload).ok, false)
  }
  assert.deepEqual(
    normalizeResearchResponse({ success: false, data: { message: '安全 Mock 不可用' } }),
    { ok: false, message: '安全 Mock 不可用' }
  )

  assert.deepEqual(
    await parseJsonResponse({ ok: true, json: async () => validPayload }),
    validPayload
  )
  await assert.rejects(
    parseJsonResponse({ ok: true, json: async () => { throw new Error('HTML response') } }),
    /研究接口返回格式不可用/
  )
  for (const body of [null, [], { error: { message: '对象错误' } }, { message: '字段漂移' }]) {
    await assert.rejects(
      parseJsonResponse({ ok: false, json: async () => body }),
      /研究接口请求失败/
    )
  }
  await assert.rejects(
    parseJsonResponse({ ok: false, json: async () => ({ error: '已验证错误' }) }),
    /已验证错误/
  )
  await assert.rejects(parseJsonResponse(null), /研究接口响应不可用/)
}

function assertSecurityIdentityUiContract() {
  const app = read(appPath)
  const html = read(htmlPath)
  const researchScript = read(researchJsPath)

  assert.match(app, /item\.configured === false/)
  assert.match(app, /未收录/)
  assert.match(app, /if \(item\.configured !== false\) \{[\s\S]*row\.addEventListener\('click'/)
  assert.match(html, /research\.html\?code=9988\.HK/)
  assert.match(html, /9988\.HK/)
  assert.match(html, /09988\.HK/)
  assert.doesNotMatch(html, /09888\.HK/)
  assert.match(researchScript, /'9988\.HK'/)
  assert.doesNotMatch(researchScript, /09888\.HK/)
}

async function run() {
  assertFinanceModeMappingAndFixtureBehavior()
  assertStrictFinanceVerification()
  assertMockAndRealVerificationAreDistinct()
  assertDefaultAnomaliesRemainDeterministic()
  assertValuationPositionContract()
  assertFaviconAndMobileTableScrolling()
  assertRenderingRespectsStrictCsp()
  assertResearchPageRespectsStrictCsp()
  assertSecurityIdentityUiContract()
  await assertResearchResponseContract()
}

module.exports = { run }
