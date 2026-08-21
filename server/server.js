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
const { bootstrapSecrets } = require('./security/secret-bootstrap')
const { createAccessControlRuntime } = require('./security/access-control-runtime')
const { closeDb, openDb } = require('./db/refresh-db')
const { createAuthHttpController } = require('./http/auth-http')
const { parseTrustedProxyAddresses } = require('./http/trusted-client')

const PORT = Number(process.env.PORT || 4173)
const ROOT = path.join(__dirname, '..')
const PUBLIC_DIR = path.join(ROOT, 'public')
const RUNTIME_FILE_CREATION_MASK = 0o077
const SECRET_BOOTSTRAP_ERROR_CODES = new Set([
  'ACCESS_CONTROL_CONFIG_INVALID',
  'SECRET_BOOTSTRAP_CONFIG_INVALID',
  'SECRET_MATERIAL_INVALID',
  'SECRET_MATERIAL_LOAD_FAILED',
  'SECRET_MATERIAL_PROVIDER_INVALID',
  'SECRET_VERSION_CONFIG_INVALID',
  'SSM_BOOTSTRAP_INVALID',
  'SSM_CLIENT_UNAVAILABLE',
  'SSM_SECRET_LOAD_FAILED',
  'TEMPORARY_CREDENTIALS_REQUIRED',
  'HTTP_SECURITY_CONFIG_INVALID'
])

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
      sourceMode: 'mock',
      modelStatus: {
        mode: 'safe_mock',
        called: false,
        reason: 'MODEL_CONFIGURATION_INCOMPLETE'
      },
      state: 'ready',
      sections: {
        thesis: '安全 Mock 演示：未调用模型。基于模拟快照展示研究结构，不构成真实分析或投资建议。',
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

async function routeApi(req, res, pathname, query, {
  accessRuntime,
  authHttp
}) {
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
  if (await authHttp.handle(req, res, segments)) return true
  if (accessRuntime.status.mode === 'device-approval' &&
    !authHttp.authorizeInvestment(req, res)) return true
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

function createRequestHandler({
  accessRuntime,
  now = Date.now,
  publicOrigin = 'https://dearmina.cn',
  trustedProxyAddresses = []
} = {}) {
  if (!accessRuntime || !accessRuntime.status ||
    (accessRuntime.status.mode !== 'disabled' &&
      accessRuntime.status.mode !== 'device-approval') ||
    (accessRuntime.status.mode === 'device-approval' &&
      (!accessRuntime.adminAuth || !accessRuntime.deviceApproval))) {
    throw Object.assign(new Error('ACCESS_CONTROL_RUNTIME_REQUIRED'), {
      code: 'ACCESS_CONTROL_RUNTIME_REQUIRED'
    })
  }
  const authHttp = createAuthHttpController({
    accessRuntime,
    now,
    publicOrigin,
    trustedProxyAddresses
  })
  return async (req, res) => {
    try {
      const urlObj = new URL(req.url, `http://localhost:${PORT}`)
      const pathname = urlObj.pathname
      if (await routeApi(req, res, pathname, urlObj.searchParams, {
        accessRuntime,
        authHttp
      })) return
      if (req.method !== 'GET') {
        formatJson(res, toApiError('方法不允许', 405), 405)
        return
      }
      serveStatic(req, res, pathname)
    } catch {
      if (!res.headersSent) {
        formatJson(res, { error: 'INTERNAL_ERROR' }, 500)
      } else {
        res.destroy()
      }
    }
  }
}

function applyRuntimeFileCreationMask() {
  return process.umask(RUNTIME_FILE_CREATION_MASK)
}

/** @param {unknown} error */
function stableStartupErrorCode(error) {
  const code = error && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined
  return typeof code === 'string' && SECRET_BOOTSTRAP_ERROR_CODES.has(code)
    ? code
    : 'SECRET_BOOTSTRAP_FAILED'
}

/** @param {any} [options] */
async function startServer({
  env = process.env,
  bootstrap = bootstrapSecrets,
  createAccessRuntime = createAccessControlRuntime,
  openDatabase = openDb,
  closeDatabase = closeDb,
  runtimeServer,
  port = PORT,
  processRef = process,
  logger = console
} = {}) {
  applyRuntimeFileCreationMask()
  const secretRuntime = await bootstrap({ env })
  let accessRuntime
  try {
    accessRuntime = createAccessRuntime({
      env,
      secretRuntime,
      openDatabase,
      closeDatabase
    })
  } catch (error) {
    secretRuntime.clear()
    throw error
  }
  if (!runtimeServer) {
    let trustedProxyAddresses
    try {
      trustedProxyAddresses = parseTrustedProxyAddresses(
        env.KINVEST_TRUSTED_PROXY_ADDRESSES,
        { required: accessRuntime.status.mode === 'device-approval' }
      )
      runtimeServer = http.createServer(createRequestHandler({
        accessRuntime,
        trustedProxyAddresses
      }))
    } catch {
      accessRuntime.clear()
      secretRuntime.clear()
      throw Object.assign(new Error('HTTP security configuration invalid'), {
        code: 'HTTP_SECURITY_CONFIG_INVALID'
      })
    }
  }
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    processRef.removeListener('SIGTERM', handleSignal)
    processRef.removeListener('SIGINT', handleSignal)
    runtimeServer.removeListener('close', cleanup)
    accessRuntime.clear()
    secretRuntime.clear()
  }
  const handleSignal = () => {
    cleanup()
    try {
      runtimeServer.close()
    } catch (error) {
      if (!error || typeof error !== 'object' ||
        !('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING') {
        throw Object.assign(new Error('Server close failed'), {
          code: 'SERVER_CLOSE_FAILED'
        })
      }
    }
  }
  processRef.once('SIGTERM', handleSignal)
  processRef.once('SIGINT', handleSignal)
  runtimeServer.once('close', cleanup)

  try {
    await new Promise((resolve, reject) => {
      const handleError = (error) => {
        runtimeServer.removeListener('error', handleError)
        reject(error)
      }
      runtimeServer.once('error', handleError)
      try {
        runtimeServer.listen(port, () => {
          runtimeServer.removeListener('error', handleError)
          resolve()
        })
      } catch (error) {
        runtimeServer.removeListener('error', handleError)
        reject(error)
      }
    })
  } catch (error) {
    cleanup()
    throw error
  }
  try {
    logger.log(`Kinvest mock server started at http://localhost:${port}`)
  } catch {
    // Logging is best-effort after the server is listening.
  }
  return runtimeServer
}

/** @param {any} [options] */
async function runServerExecutable(options = {}) {
  try {
    await startServer(options)
    return 0
  } catch (error) {
    const stderr = options.stderr || process.stderr
    stderr.write(`${stableStartupErrorCode(error)}\n`)
    return 1
  }
}

if (require.main === module) {
  runServerExecutable().then((exitCode) => {
    process.exitCode = exitCode
  })
}

module.exports = {
  apiCompany,
  apiRefresh,
  apiResearch,
  applyRuntimeFileCreationMask,
  createRequestHandler,
  runServerExecutable,
  stableStartupErrorCode,
  startServer,
  sanitizeCompanyData,
  toApiError,
  toSecurityNotConfiguredError
}
