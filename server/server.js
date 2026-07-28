const fs = require('fs')
const path = require('path')
const http = require('http')
const { getWatchlist, listCompanies, getCompany, applyManualRefresh } = require('./data/mockData')
const { buildRefreshState } = require('./utils/refresh-policy')
const { evaluateRefreshState, allowManualRefresh, recordManualRefreshAttempt } = require('./services/refresh-rules')
const { createIfindClient } = require('./adapters/ifindAdapter')

const PORT = Number(process.env.PORT || 4173)
const ROOT = path.join(__dirname, '..')
const PUBLIC_DIR = path.join(ROOT, 'public')

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

function toApiError(message, code = 400) {
  return {
    success: false,
    error: message,
    code
  }
}

function safeJson(item) {
  if (item === undefined || item === null) {
    return null
  }
  return item
}

async function withMeta(company) {
  if (!company) return null
  const refresh = evaluateRefreshState(company)

  return {
    ...company,
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
    formatJson(res, toApiError(`未找到公司：${code}`, 404), 404)
    return
  }
  const data = await withMeta(company)
  formatJson(res, { success: true, data })
}

async function apiRefresh(req, res, code) {
  const company = getCompany(code)
  if (!company) {
    formatJson(res, toApiError(`未找到公司：${code}`, 404), 404)
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
    formatJson(res, toApiError(`未找到研究目标：${code}`, 404), 404)
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
      code,
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

server.listen(PORT, () => {
  console.log(`Kinvest mock server started at http://localhost:${PORT}`)
})
