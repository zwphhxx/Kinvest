const fs = require('fs')
const path = require('path')
const http = require('http')
const { getWatchlist, listCompanies, getCompany, applyManualRefresh } = require('./data/mockData')
const { evaluateRefreshState, allowManualRefresh, recordManualRefreshAttempt } = require('./services/refresh-rules')
const { getHealthState } = require('./services/health')
const { createIfindClient } = require('./adapters/ifindAdapter')
const { resolveSecurityIdentity } = require('./domain/security-identity')
const { prepareFinanceRows } = require('../public/finance-contract')
const { isVerifiedDataBlock } = require('../public/data-source-contract')

const PORT = Number(process.env.PORT || 4173)
const ROOT = path.join(__dirname, '..')
const PUBLIC_DIR = path.join(ROOT, 'public')
const RUNTIME_FILE_CREATION_MASK = 0o077

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
}

function formatJson(res, body, status = 200) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      resolve(raw ? JSON.parse(raw) : {})
    })
    req.on('error', () => resolve({}))
  })
}

function parseSegments(pathname) {
  return String(pathname || '/').split('/').filter(Boolean)
}

function toApiError(message, code = 400, details = {}) {
  return {
    success: false,
    error: message,
    code,
    ...details
  }
}

function toSecurityNotConfiguredError(requestedCode, targetLabel = '证券') {
  const code = String(requestedCode || '')
  const identity = resolveSecurityIdentity(code)
  const details = {
    errorCode: 'SECURITY_NOT_CONFIGURED',
    requestedCode: code
  }

  if (identity) {
    details.displayCode = identity.displayCode
    details.issuerLegalName = identity.issuerLegalName
    details.nameZh = identity.nameZh
    details.configured = identity.configured
  }

  if (identity && identity.companyId === 'company-baidu') {
    details.historyCorrection = '历史纠错：旧 Mock 曾将 09888.HK 错链至阿里巴巴；该代码实际属于百度，当前未收录。'
  }

  const message = identity
    ? `${targetLabel}未收录：${identity.nameZh}（${identity.displayCode}）`
    : `${targetLabel}未收录：${code}`
  return toApiError(message, 404, details)
}

const VERIFIED_BREAKDOWN_SOURCE_TYPES = Object.freeze([
  'ifind_indicator',
  'ifind_topic_report',
  'official_announcement'
])

function summarizePreparedRows(prepared) {
  return {
    totalCount: prepared.totalCount,
    acceptedCount: prepared.rows.length,
    rejectedCount: prepared.rejectedCount,
    sourceMode: prepared.sourceMode,
    errorCode: prepared.errorCode
  }
}

function sanitizeCompanyData(company) {
  if (!company) return null
  const annual = prepareFinanceRows(company.financials, 'annual')
  const quarterly = prepareFinanceRows(company.financials, 'quarter')
  const breakdownVerified = isVerifiedDataBlock(
    company.businessBreakdown,
    VERIFIED_BREAKDOWN_SOURCE_TYPES
  )

  return {
    ...company,
    financials: {
      annual: annual.rows,
      quarterly: quarterly.rows,
      validation: {
        annual: summarizePreparedRows(annual),
        quarterly: summarizePreparedRows(quarterly)
      }
    },
    businessBreakdown: breakdownVerified
      ? {
          ...company.businessBreakdown,
          validation: {
            status: 'verified',
            sourceMode: company.businessBreakdown.dataMode,
            errorCode: null
          }
        }
      : {
          dataMode: company.businessBreakdown && company.businessBreakdown.dataMode,
          rows: [],
          validation: {
            status: 'rejected',
            sourceMode: null,
            errorCode: 'SOURCE_CONTRACT_REJECTED'
          }
        }
  }
}

async function withMeta(company) {
  if (!company) return null
  const refresh = evaluateRefreshState(company)
  const sanitizedCompany = sanitizeCompanyData(company)

  return {
    ...sanitizedCompany,
    refreshState: {
      ...refresh,
      dailyManualUsed: Math.max(0, refresh.dailyManualUsed || 0),
      snapshotVersion: 'mock-2026-07-28'
    },
    dataMode: 'mock'
  }
}

async function createCompanySummary(company) {
  const refresh = evaluateRefreshState(company)
  return {
    securityCode: company.securityCode,
    nameZh: company.nameZh,
    market: company.market,
    industry: company.industry,
    sector: company.sector,
    symbol: company.symbol,
    quote: company.quote,
    refreshState: refresh
  }
}

async function apiGetWatchlist(req, res) {
  const list = getWatchlist()
  const companies = listCompanies()
  const summaries = await Promise.all(companies.filter((c) => list.includes(c.securityCode)).map(async (c) => {
    const data = getCompany(c.securityCode)
    return createCompanySummary(data)
  }))
  formatJson(res, {
    success: true,
    data: summaries
  })
}

async function apiSearch(req, res, query) {
  const q = String(query.get('q') || '').trim().toLowerCase()
  if (!q) {
    formatJson(res, { success: true, data: [] })
    return
  }
  const client = createIfindClient()
  const result = await client.searchCompanies(q)
  formatJson(res, { success: true, data: result })
}

async function apiCompany(req, res, code) {
  const company = getCompany(code)
  if (!company) {
    formatJson(res, toSecurityNotConfiguredError(code, '公司'), 404)
    return
  }
  const data = await withMeta(company)
  formatJson(res, { success: true, data })
}

async function apiRefresh(req, res, code) {
  const company = getCompany(code)
  if (!company) {
    formatJson(res, toSecurityNotConfiguredError(code, '刷新目标'), 404)
    return
  }
  const state = evaluateRefreshState(company)
  const allow = allowManualRefresh(company.securityCode, company)
  if (!allow.allow) {
    formatJson(res, {
      success: false,
      error: allow.reason === 'daily_limit'
        ? '今日手动刷新额度已达上限'
        : state.manualCooldownStatus,
      state
    }, 409)
    return
  }
  company.marketSnapshot = applyManualRefresh(company)
  recordManualRefreshAttempt(company.securityCode, allow, company)
  formatJson(res, {
    success: true,
    data: await withMeta(company),
    warning: '演示环境仅刷新快照时间与缓存标记，不调用外部接口。'
  })
}

async function apiResearch(req, res, code) {
  const company = getCompany(code)
  if (!company) {
    formatJson(res, toSecurityNotConfiguredError(code, '研究目标'), 404)
    return
  }
  const researchState = company.research
  if (!researchState || researchState.state !== 'ready') {
    formatJson(res, { success: false, data: { state: 'not_ready', message: '该公司尚未生成深度研究。' } })
    return
  }
  formatJson(res, {
    success: true,
    data: {
      code: company.securityCode,
      nameZh: company.nameZh,
      version: researchState.version,
      generatedAt: researchState.generatedAt,
      snapshotTime: researchState.snapshotTime,
      citedAnnouncementsCount: researchState.citedAnnouncementsCount,
      citedNewsCount: researchState.citedNewsCount,
      tags: researchState.tags,
      state: 'ready',
      sections: {
        thesis: '基于已验证披露口径与公告元数据，当前可观察到现金流转化压力增加，但未观察到盈利质量持续恶化证据。',
        bulls: ['广告与云智能现金流改善可逐步对冲地产与本地生活波动。'],
        bears: ['研发与基础设施支出偏离短期利润弹性，需警惕资本支出结构变化。'],
        catalysts: ['中长期监管披露透明度改善、用户增长与服务转化率同步提升。'],
        invalidation: ['若经营现金流持续低于经营利润且库存周转继续恶化，需降级乐观看法。'],
        dataSnapshotSummary: {
          financeRows: company.financials.annual.length,
          newsRows: company.news.length,
          announcementRows: company.announcements.length
        }
      }
    }
  })
}

async function routeApi(req, res, pathname, query) {
  const segments = parseSegments(pathname)
  if (segments[0] !== 'api') {
    return false
  }
  if (segments.length === 2 && segments[1] === 'health' && req.method === 'GET') {
    try {
      formatJson(res, getHealthState())
    } catch {
      if (!res.headersSent) {
        formatJson(res, {
          success: false,
          error: 'Health check failed',
          code: 503
        }, 503)
      }
    }
    return true
  }
  if (segments[1] === 'watchlist' && req.method === 'GET') {
    await apiGetWatchlist(req, res)
    return true
  }
  if (segments[1] === 'search' && req.method === 'GET') {
    await apiSearch(req, res, query)
    return true
  }
  if (segments[1] === 'company' && segments[2] && req.method === 'GET') {
    await apiCompany(req, res, segments[2])
    return true
  }
  if (segments[1] === 'company' && segments[2] && req.method === 'POST' && segments[3] === 'refresh') {
    await parseBody(req)
    await apiRefresh(req, res, segments[2])
    return true
  }
  if (segments[1] === 'research' && segments[2] && req.method === 'GET') {
    await apiResearch(req, res, segments[2])
    return true
  }

  formatJson(res, toApiError('未知 API 路径', 404), 404)
  return true
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname
  const filePath = path.join(PUBLIC_DIR, safePath)
  if (!filePath.startsWith(PUBLIC_DIR)) {
    formatJson(res, toApiError('非法路径', 400), 400)
    return
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      formatJson(res, toApiError('Not Found', 404), 404)
      return
    }
    const ext = path.extname(filePath)
    const type = MIME[ext] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type })
    res.end(data)
  })
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`)
  const pathname = urlObj.pathname
  if (await routeApi(req, res, pathname, urlObj.searchParams)) {
    return
  }
  if (req.method !== 'GET') {
    formatJson(res, toApiError('方法不允许', 405), 405)
    return
  }
  serveStatic(req, res, pathname)
})

function applyRuntimeFileCreationMask() {
  return process.umask(RUNTIME_FILE_CREATION_MASK)
}

function startServer() {
  applyRuntimeFileCreationMask()
  server.listen(PORT, () => {
    console.log(`Kinvest mock server started at http://localhost:${PORT}`)
  })
  return server
}

if (require.main === module) {
  startServer()
}

module.exports = {
  apiCompany,
  apiRefresh,
  apiResearch,
  applyRuntimeFileCreationMask,
  startServer,
  sanitizeCompanyData,
  toApiError,
  toSecurityNotConfiguredError
}
