const assert = require('node:assert/strict')
const http = require('node:http')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')

const { createRequestHandler, startServer } = require('../server')
const { parseStrictJsonBody } = require('../http/auth-http')

const ORIGIN = 'https://dearmina.cn'
const NOW = Date.UTC(2026, 7, 21, 9, 0, 0)
const VALID_DEVICE = 'V'.repeat(43)
const REVOKED_DEVICE = 'R'.repeat(43)
const EXPIRED_DEVICE = 'E'.repeat(43)
const ADMIN_TOKEN = 'A'.repeat(43)
const BROWSER_CREDENTIAL = 'B'.repeat(43)

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

function createRuntime() {
  const terminal = new Map([
    ['E'.repeat(22), 'REQUEST_EXPIRED'],
    ['L'.repeat(22), 'REQUEST_LOCKED'],
    ['U'.repeat(22), 'REQUEST_ALREADY_USED'],
    ['N'.repeat(22), 'REQUEST_NOT_FOUND']
  ])
  return {
    status: { mode: 'device-approval' },
    adminAuth: {},
    deviceApproval: {
      authenticate(token) {
        if (token === EXPIRED_DEVICE) throw codedError('TOKEN_EXPIRED')
        if (token !== VALID_DEVICE) throw codedError('TOKEN_INVALID')
        return {
          authenticated: true,
          idleExpiresAt: NOW + 86400000,
          absoluteExpiresAt: NOW + 172800000,
          rotated: false
        }
      },
      redeemRequest({ requestId }) {
        throw codedError(terminal.get(requestId) || 'REQUEST_NOT_FOUND')
      }
    }
  }
}

/**
 * @param {{
 *   status: {mode: string},
 *   adminAuth?: any,
 *   deviceApproval?: any
 * }} [runtime]
 * @param {string} [publicOrigin]
 * @param {any} [ifindDiagnosticRuntime]
 */
async function start(
  runtime = createRuntime(),
  publicOrigin = ORIGIN,
  ifindDiagnosticRuntime
) {
  const server = http.createServer(createRequestHandler({
    accessRuntime: runtime,
    ifindDiagnosticRuntime,
    now: () => NOW,
    publicOrigin,
    trustedProxyAddresses: ['127.0.0.1']
  }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: options.headers,
    body: options.body,
    signal: AbortSignal.timeout(3000)
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    setCookie: response.headers.get('set-cookie') || ''
  }
}

function validMutationHeaders(cookie = VALID_DEVICE) {
  return {
    origin: ORIGIN,
    'content-type': 'application/json',
    cookie: `__Host-kinvest-device=${cookie}`
  }
}

async function testDefaultDenyInvestmentRouteMatrix() {
  const running = await start()
  const routes = [
    ['GET', '/api/watchlist', undefined],
    ['GET', '/api/search?q=ali', undefined],
    ['GET', '/api/company/9988.HK', undefined],
    ['POST', '/api/company/9988.HK/refresh', '{}'],
    ['GET', '/api/research/9988.HK', undefined],
    ['GET', '/api/deep-research/9988.HK', undefined]
  ]
  const cookieCases = [
    null,
    '__Host-kinvest-device=invalid',
    `__Host-kinvest-device=${REVOKED_DEVICE}`,
    `__Host-kinvest-device=${EXPIRED_DEVICE}`,
    `__Host-kinvest-admin=${ADMIN_TOKEN}`
  ]
  try {
    for (const [method, pathname, body] of routes) {
      for (const cookie of cookieCases) {
        const headers = body === undefined
          ? (cookie ? { cookie } : {})
          : {
              origin: ORIGIN,
              'content-type': 'application/json',
              ...(cookie ? { cookie } : {})
            }
        const response = await request(running.baseUrl, pathname, {
          method,
          headers,
          body
        })
        assert.equal(response.status, 401, `${method} ${pathname} ${cookie}`)
        assert.deepEqual(response.body, { error: 'AUTH_REQUIRED' })
      }
    }
  } finally {
    await running.close()
  }
}

async function testDefaultDenyMarketDiagnosticRouteMatrix() {
  const running = await start()
  const routes = [
    ['GET', '/api/admin/ifind/market-cases', undefined],
    ['GET', '/api/admin/ifind/market-cases/HK_ALIBABA_9988', undefined],
    ['POST', '/api/admin/ifind/market-cases/HK_ALIBABA_9988/run', '{}']
  ]
  try {
    for (const [method, pathname, body] of routes) {
      for (const cookie of [
        null,
        `__Host-kinvest-device=${VALID_DEVICE}`,
        `__Host-kinvest-admin=${ADMIN_TOKEN}`
      ]) {
        const headers = body === undefined
          ? (cookie ? { cookie } : {})
          : {
              origin: ORIGIN,
              'content-type': 'application/json',
              'x-kinvest-csrf': 'C'.repeat(43),
              ...(cookie ? { cookie } : {})
            }
        const response = await request(running.baseUrl, pathname, {
          method,
          headers,
          body
        })
        assert.equal(response.status, 401, `${method} ${pathname} ${cookie}`)
        assert.deepEqual(response.body, { error: 'ADMIN_AUTH_REQUIRED' })
      }
    }
  } finally {
    await running.close()
  }
}

async function testApprovedFamilyInvestmentRouteMatrixUsesMockData() {
  const diagnosticCalls = []
  const unexpectedDiagnosticCall = (name) => () => {
    diagnosticCalls.push(name)
    throw new Error(`unexpected diagnostic call: ${name}`)
  }
  const ifindDiagnosticRuntime = {
    status: {
      mode: 'admin-diagnostic',
      configured: true,
      versionId: 'ifind-secrets-v1-20260830'
    },
    service: {
      diagnose: unexpectedDiagnosticCall('legacy-diagnose')
    },
    marketService: {
      latest: unexpectedDiagnosticCall('market-latest'),
      history: unexpectedDiagnosticCall('market-history'),
      quotaStatus: unexpectedDiagnosticCall('market-quota-status'),
      run: unexpectedDiagnosticCall('market-run')
    }
  }
  const running = await start(createRuntime(), ORIGIN, ifindDiagnosticRuntime)
  const routes = [
    ['GET', '/api/watchlist', undefined],
    ['GET', '/api/search?q=ali', undefined],
    ['GET', '/api/company/9988.HK', undefined],
    ['POST', '/api/company/9988.HK/refresh', '{}'],
    ['GET', '/api/research/9988.HK', undefined]
  ]
  try {
    const responses = new Map()
    for (const [method, pathname, body] of routes) {
      const headers = body === undefined
        ? { cookie: `__Host-kinvest-device=${VALID_DEVICE}` }
        : validMutationHeaders()
      const response = await request(running.baseUrl, pathname, {
        method,
        headers,
        body
      })
      assert.equal(response.status, 200, `${method} ${pathname}`)
      assert.equal(response.body.success, true, `${method} ${pathname}`)
      responses.set(`${method} ${pathname}`, response.body)
    }

    const watchlist = responses.get('GET /api/watchlist').data
    assert.deepEqual(watchlist.map((company) => ({
      securityCode: company.securityCode,
      lastPrice: company.quote.lastPrice,
      currency: company.quote.currency
    })), [
      { securityCode: '9988.HK', lastPrice: 91.6, currency: 'HKD' },
      { securityCode: 'AAPL.US', lastPrice: 198.2, currency: 'USD' }
    ])

    const search = responses.get('GET /api/search?q=ali').data
    assert.equal(search.length, 1)
    assert.deepEqual({
      companyId: search[0].companyId,
      listingId: search[0].listingId,
      issuerLegalName: search[0].issuerLegalName,
      securityCode: search[0].securityCode,
      configured: search[0].configured,
      ifindVendorCode: search[0].vendorCodes.ifind
    }, {
      companyId: 'company-alibaba-group',
      listingId: 'listing-hkex-9988',
      issuerLegalName: 'Alibaba Group Holding Limited',
      securityCode: '9988.HK',
      configured: true,
      ifindVendorCode: { code: null, status: 'unverified' }
    })

    const company = responses.get('GET /api/company/9988.HK').data
    assert.equal(company.dataMode, 'mock')
    assert.equal(company.refreshState.snapshotVersion, 'mock-2026-07-28')
    assert.equal(company.companyId, 'company-alibaba-group')
    assert.equal(company.listingId, 'listing-hkex-9988')
    assert.deepEqual(company.quote, {
      lastPrice: 91.6,
      currency: 'HKD',
      changePct: -1.72,
      volume: 1531200,
      high3Y: 124.4,
      low3Y: 56.3,
      latestHighDate: '2026-06-01T00:00:00.000Z',
      latestLowDate: '2026-01-20T00:00:00.000Z'
    })
    assert.equal(company.financials.validation.annual.sourceMode, 'mock')
    assert.equal(company.financials.annual[0].dataMode, 'mock')
    assert.deepEqual({
      sourceMode: company.financials.annual[0].source.sourceMode,
      sourceType: company.financials.annual[0].source.sourceType,
      mockContractVerified:
        company.financials.annual[0].source.mockContractVerified
    }, {
      sourceMode: 'mock',
      sourceType: 'mock_fixture',
      mockContractVerified: true
    })
    assert.deepEqual(company.businessBreakdown.validation, {
      status: 'verified',
      sourceMode: 'mock',
      errorCode: null
    })

    const refresh = responses.get('POST /api/company/9988.HK/refresh')
    assert.equal(refresh.data.dataMode, 'mock')
    assert.equal(refresh.data.refreshState.snapshotVersion, 'mock-2026-07-28')
    assert.equal(refresh.data.quote.lastPrice, 91.6)
    assert.equal(refresh.data.marketSnapshot.fromCache, false)
    assert.equal(
      refresh.data.marketSnapshot.sourceTime,
      '2026-07-28T15:42:00.000Z'
    )
    assert.equal(
      refresh.warning,
      '演示环境仅刷新快照时间与缓存标记，不调用外部接口。'
    )

    const research = responses.get('GET /api/research/9988.HK').data
    assert.equal(research.code, '9988.HK')
    assert.equal(research.nameZh, '阿里巴巴')
    assert.equal(research.sourceMode, 'mock')
    assert.equal(research.state, 'ready')
    assert.deepEqual(research.modelStatus, {
      mode: 'safe_mock',
      called: false,
      reason: 'MODEL_CONFIGURATION_INCOMPLETE'
    })
    assert.deepEqual(research.tags, ['安全 Mock', '未调用模型', '快照绑定'])
    assert.deepEqual(research.sections.dataSnapshotSummary, {
      financeRows: 2,
      newsRows: 2,
      announcementRows: 2
    })
    assert.deepEqual(diagnosticCalls, [])
  } finally {
    await running.close()
  }
}

async function testRefreshUsesInjectedOriginAndDisabledCompatibility() {
  const customOrigin = 'https://family.example.test'
  const enabled = await start(createRuntime(), customOrigin)
  try {
    const accepted = await request(enabled.baseUrl, '/api/company/9988.HK/refresh', {
      method: 'POST',
      headers: {
        origin: customOrigin,
        'content-type': 'application/json',
        cookie: `__Host-kinvest-device=${VALID_DEVICE}`
      },
      body: '{}'
    })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.success, true)

    const rejected = await request(enabled.baseUrl, '/api/company/9988.HK/refresh', {
      method: 'POST',
      headers: validMutationHeaders(),
      body: '{}'
    })
    assert.equal(rejected.status, 403)
    assert.deepEqual(rejected.body, { error: 'ORIGIN_INVALID' })
  } finally {
    await enabled.close()
  }

  const disabled = await start({ status: { mode: 'disabled' } }, customOrigin)
  try {
    const compatible = await request(disabled.baseUrl, '/api/company/9988.HK/refresh', {
      method: 'POST',
      headers: {
        origin: customOrigin,
        'content-type': 'application/json'
      },
      body: '{}'
    })
    assert.equal(compatible.status, 200)
    assert.equal(compatible.body.success, true)
  } finally {
    await disabled.close()
  }
}

async function testRefreshStrictMutationAndExactRoutes() {
  const running = await start()
  const endpoint = '/api/company/9988.HK/refresh'
  const deviceCookie = `__Host-kinvest-device=${VALID_DEVICE}`
  try {
    for (const pathname of [
      `${endpoint}/anything`,
      `${endpoint}/`,
      '/api//company/9988.HK/refresh',
      '/api/company/9988.HK%2Frefresh'
    ]) {
      const response = await request(running.baseUrl, pathname, {
        method: 'POST',
        headers: validMutationHeaders(),
        body: '{}'
      })
      assert.equal(response.status, 404, pathname)
    }

    for (const [headers, body, expectedStatus, expectedError] of [
      [{ 'content-type': 'application/json', cookie: deviceCookie }, '{}', 403, 'ORIGIN_INVALID'],
      [{ origin: 'https://evil.example', 'content-type': 'application/json', cookie: deviceCookie }, '{}', 403, 'ORIGIN_INVALID'],
      [{ origin: ORIGIN, 'content-type': 'text/plain', cookie: deviceCookie }, '{}', 415, 'JSON_REQUIRED'],
      [validMutationHeaders(), '{', 400, 'JSON_INVALID'],
      [validMutationHeaders(), '{"a":1,"a":2}', 400, 'JSON_INVALID'],
      [validMutationHeaders(), JSON.stringify({ value: 'x'.repeat(5000) }), 413, 'BODY_TOO_LARGE']
    ]) {
      const response = await request(running.baseUrl, endpoint, {
        method: 'POST',
        headers,
        body
      })
      assert.equal(response.status, expectedStatus)
      assert.deepEqual(response.body, { error: expectedError })
    }

    const valid = await request(running.baseUrl, endpoint, {
      method: 'POST',
      headers: validMutationHeaders(),
      body: '{}'
    })
    assert.equal(valid.status, 200)
    assert.equal(valid.body.success, true)
  } finally {
    await running.close()
  }
}

async function parseBuffer(buffer) {
  const req = /** @type {PassThrough & {headers: Record<string, string>}} */ (
    new PassThrough()
  )
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(buffer.length)
  }
  const parsed = parseStrictJsonBody(req)
  req.end(buffer)
  return parsed
}

async function testStrictJsonRejectsMalformedUtf8DuplicatesAndAbort() {
  await assert.rejects(parseBuffer(Buffer.from('{"name":"a","name":"b"}')), {
    code: 'JSON_INVALID'
  })
  await assert.rejects(parseBuffer(Buffer.from([
    0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d
  ])), { code: 'JSON_INVALID' })

  const aborted = /** @type {PassThrough & {headers: Record<string, string>}} */ (
    new PassThrough()
  )
  aborted.headers = { 'content-type': 'application/json' }
  const pending = parseStrictJsonBody(aborted)
  aborted.emit('aborted')
  await assert.rejects(pending, { code: 'JSON_INVALID' })
}

async function testRedeemTerminalErrorsClearRequestCookie() {
  const running = await start()
  const cases = [
    ['E'.repeat(22), 410, 'REQUEST_EXPIRED'],
    ['L'.repeat(22), 423, 'REQUEST_LOCKED'],
    ['U'.repeat(22), 409, 'REQUEST_ALREADY_USED'],
    ['N'.repeat(22), 404, 'REQUEST_NOT_FOUND']
  ]
  try {
    for (const [requestId, status, error] of cases) {
      const response = await request(
        running.baseUrl,
        `/api/auth/device-requests/${requestId}/redeem`,
        {
          method: 'POST',
          headers: {
            origin: ORIGIN,
            'content-type': 'application/json',
            cookie: `__Host-kinvest-request=${requestId}.${BROWSER_CREDENTIAL}`
          },
          body: '{}'
        }
      )
      assert.equal(response.status, status)
      assert.deepEqual(response.body, { error })
      assert.match(
        response.setCookie,
        /__Host-kinvest-request=;[^,]*Max-Age=0/
      )
    }
  } finally {
    await running.close()
  }
}

class FakeServer extends EventEmitter {
  constructor() {
    super()
    this.listenCalls = 0
  }

  listen(_port, callback) {
    this.listenCalls += 1
    callback()
  }

  close() {
    this.emit('close')
  }
}

async function testEnabledStartupCannotBypassTrustedProxyConfig() {
  const originalUmask = process.umask()
  try {
    const invalid = [undefined, '', '[]', 'not-json', '["::ffff:127.0.0.1"]']
    for (const serialized of invalid) {
      const runtimeServer = new FakeServer()
      const env = { KINVEST_ACCESS_CONTROL_MODE: 'device-approval' }
      if (serialized !== undefined) {
        env.KINVEST_TRUSTED_PROXY_ADDRESSES = serialized
      }
      await assert.rejects(startServer({
        env,
        runtimeServer,
        bootstrap: async () => ({ clear() {} }),
        createAccessRuntime: () => ({
          status: { mode: 'device-approval' },
          adminAuth: {},
          deviceApproval: {},
          clear() {}
        }),
        processRef: new EventEmitter(),
        logger: { log() {} }
      }), { code: 'HTTP_SECURITY_CONFIG_INVALID' })
      assert.equal(runtimeServer.listenCalls, 0)
    }
  } finally {
    process.umask(originalUmask)
  }
}

async function testStartupConfigurationDoesNotLeakProcessUmask() {
  const originalUmask = process.umask()
  try {
    await testEnabledStartupCannotBypassTrustedProxyConfig()
    assert.equal(process.umask(), originalUmask)
  } finally {
    process.umask(originalUmask)
  }
}

async function run() {
  await testDefaultDenyInvestmentRouteMatrix()
  await testDefaultDenyMarketDiagnosticRouteMatrix()
  await testApprovedFamilyInvestmentRouteMatrixUsesMockData()
  await testRefreshStrictMutationAndExactRoutes()
  await testRefreshUsesInjectedOriginAndDisabledCompatibility()
  await testStrictJsonRejectsMalformedUtf8DuplicatesAndAbort()
  await testRedeemTerminalErrorsClearRequestCookie()
  await testStartupConfigurationDoesNotLeakProcessUmask()
}

module.exports = { run }
