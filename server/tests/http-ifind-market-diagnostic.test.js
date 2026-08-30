const assert = require('node:assert/strict')
const http = require('node:http')

const { createRequestHandler } = require('../server')
const { HttpBoundaryError } = require('../http/auth-http')

const ORIGIN = 'https://dearmina.cn'
const NOW = Date.UTC(2026, 7, 30, 8, 0, 0)
const ADMIN_TOKEN = 'A'.repeat(43)
const EXPIRED_ADMIN_TOKEN = 'X'.repeat(43)
const DEVICE_TOKEN = 'D'.repeat(43)
const CSRF_TOKEN = 'C'.repeat(43)
const VERSION_ID = 'v20260829-001'
const CLIENT_IP = '203.0.113.24'
const CASE_IDS = [
  'HK_ALIBABA_9988',
  'US_APPLE_AAPL',
  'CN_MOUTAI_600519'
]
const PRESENTATION = Object.freeze({
  HK_ALIBABA_9988: Object.freeze({
    caseId: 'HK_ALIBABA_9988',
    companyName: 'Alibaba',
    issuerLegalName: 'Alibaba Group Holding Limited',
    exchange: 'HKEX',
    displayCode: '9988.HK',
    expectedTradingCurrency: 'HKD',
    marketTimeZone: 'Asia/Hong_Kong',
    liveReady: false
  }),
  US_APPLE_AAPL: Object.freeze({
    caseId: 'US_APPLE_AAPL',
    companyName: 'Apple',
    issuerLegalName: 'Apple Inc.',
    exchange: 'NASDAQ',
    displayCode: 'AAPL.US',
    expectedTradingCurrency: 'USD',
    marketTimeZone: 'America/New_York',
    liveReady: false
  }),
  CN_MOUTAI_600519: Object.freeze({
    caseId: 'CN_MOUTAI_600519',
    companyName: 'Kweichow Moutai',
    issuerLegalName: 'Kweichow Moutai Co., Ltd.',
    exchange: 'SSE',
    displayCode: '600519.SH',
    expectedTradingCurrency: 'CNY',
    marketTimeZone: 'Asia/Shanghai',
    liveReady: false
  })
})

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

function createAccessRuntime() {
  const calls = []
  return {
    status: { mode: 'device-approval' },
    deviceApproval: {
      authenticate(token) {
        if (token !== DEVICE_TOKEN) throw codedError('TOKEN_INVALID')
        return {
          authenticated: true,
          idleExpiresAt: NOW + 86_400_000,
          absoluteExpiresAt: NOW + 172_800_000,
          rotated: false
        }
      }
    },
    adminAuth: {
      authenticate(token) {
        calls.push(['authenticate', token])
        if (token === EXPIRED_ADMIN_TOKEN) {
          throw codedError('ADMIN_SESSION_EXPIRED')
        }
        if (token !== ADMIN_TOKEN) throw codedError('ADMIN_SESSION_INVALID')
        return {
          sessionId: 'admin-session-test',
          idleExpiresAt: NOW + 1_800_000,
          absoluteExpiresAt: NOW + 28_800_000
        }
      },
      authenticateMutation(token, csrf) {
        calls.push(['authenticateMutation', token, csrf])
        if (token !== ADMIN_TOKEN) return { status: 'session-invalid' }
        if (csrf !== CSRF_TOKEN) return { status: 'csrf-invalid' }
        return {
          status: 'authenticated',
          sessionId: 'admin-session-test',
          idleExpiresAt: NOW + 1_800_000,
          absoluteExpiresAt: NOW + 28_800_000
        }
      },
      verifyCsrf(token, csrf) {
        calls.push(['verifyCsrf', token, csrf])
        if (token === EXPIRED_ADMIN_TOKEN) {
          throw codedError('ADMIN_SESSION_EXPIRED')
        }
        if (token !== ADMIN_TOKEN) throw codedError('ADMIN_SESSION_INVALID')
        if (csrf !== CSRF_TOKEN) throw codedError('ADMIN_CSRF_INVALID')
        return {
          sessionId: 'admin-session-test',
          idleExpiresAt: NOW + 1_800_000,
          absoluteExpiresAt: NOW + 28_800_000
        }
      }
    },
    calls
  }
}

function quoteSnapshot(caseId) {
  const presentation = PRESENTATION[caseId]
  const listingIds = {
    HK_ALIBABA_9988: 'listing-hkex-9988',
    US_APPLE_AAPL: 'listing-nasdaq-aapl',
    CN_MOUTAI_600519: 'listing-sse-600519'
  }
  return {
    listingId: listingIds[caseId],
    displayCode: presentation.displayCode,
    latestPrice: 100.25,
    previousClose: 99.5,
    open: 99.75,
    high: 101,
    low: 98.5,
    volume: 123456,
    turnover: 987654.5,
    quoteTime: '2026-08-30T15:59:00+08:00',
    tradingStatus: 'trading',
    currency: presentation.expectedTradingCurrency
  }
}

function financialPoint(caseId) {
  return {
    indicatorId: `${caseId}_REVENUE_VENDOR_ID`,
    metricKey: 'revenue',
    reportPeriod: '2025FY',
    periodEnd: '2025-12-31',
    periodType: 'annual',
    value: 1234.5,
    availability: 'available',
    currency: PRESENTATION[caseId].expectedTradingCurrency,
    unit: 'million',
    disclosureScope: 'consolidated',
    sourceTime: '2026-03-01T08:00:00+08:00',
    fetchTime: '2026-08-30T16:00:00+08:00'
  }
}

function completedRun(caseId, overrides = {}) {
  return {
    runId: `market_run_${'1'.repeat(32)}`,
    caseId,
    status: 'complete',
    quoteStatus: 'available',
    financeStatus: 'available',
    requestCount: 3,
    dataVol: 42,
    elapsedMs: 75,
    safeErrorClass: null,
    failureCode: null,
    vendorErrorCode: null,
    tokenVersionId: VERSION_ID,
    createdAt: NOW - 75,
    leaseExpiresAt: NOW + 30_000,
    completedAt: NOW,
    quoteSnapshot: quoteSnapshot(caseId),
    financialPoints: [financialPoint(caseId)],
    ...overrides
  }
}

function failedRun(caseId) {
  return completedRun(caseId, {
    runId: `market_run_${'2'.repeat(32)}`,
    status: 'failed',
    quoteStatus: 'not_run',
    financeStatus: 'not_run',
    requestCount: 1,
    dataVol: null,
    safeErrorClass: 'AUTH',
    failureCode: 'IFIND_CLIENT_FAILED',
    vendorErrorCode: 'RAW_VENDOR_401',
    quoteSnapshot: null,
    financialPoints: []
  })
}

function quotaStatus(caseId) {
  return {
    localDayKey: '2026-08-30',
    caseAttemptCount: caseId === CASE_IDS[0] ? 2 : 0,
    globalAttemptCount: 2,
    caseRemaining: caseId === CASE_IDS[0] ? 3 : 5,
    globalRemaining: 10,
    cooldownUntil: caseId === CASE_IDS[0] ? NOW + 300_000 : null,
    inFlight: false,
    inFlightCaseId: null,
    inFlightExpiresAt: null
  }
}

/** @param {{ outcome?: Record<string, unknown> }} [options] */
function createMarketRuntime({ outcome } = {}) {
  const calls = []
  const latestByCase = new Map(CASE_IDS.map((caseId) => [
    caseId,
    completedRun(caseId)
  ]))
  const marketService = {
    /** @returns {unknown} Opaque repository output must be projected by the HTTP boundary. */
    latest(input) {
      calls.push(['latest', input])
      return latestByCase.get(input.caseId) || null
    },
    history(input) {
      calls.push(['history', input])
      return [latestByCase.get(input.caseId), failedRun(input.caseId)]
    },
    quotaStatus(input) {
      calls.push(['quotaStatus', input])
      return quotaStatus(input.caseId)
    },
    async run(input) {
      calls.push(['run', input])
      return outcome || {
        status: 'complete',
        caseId: input.caseId,
        runId: `market_run_${'3'.repeat(32)}`,
        quoteStatus: 'available',
        financeStatus: 'available',
        requestCount: 3
      }
    }
  }
  return {
    status: {
      mode: 'admin-diagnostic',
      configured: true,
      versionId: VERSION_ID
    },
    marketService,
    calls
  }
}

/**
 * @param {{
 *   marketRuntime?: unknown,
 *   accessRuntime?: ReturnType<typeof createAccessRuntime>,
 *   trustedProxyAddresses?: string[]
 * }} [options]
 */
async function start({
  marketRuntime = createMarketRuntime(),
  accessRuntime = createAccessRuntime(),
  trustedProxyAddresses = ['127.0.0.1']
} = {}) {
  const server = http.createServer(createRequestHandler({
    accessRuntime,
    ifindDiagnosticRuntime: marketRuntime,
    now: () => NOW,
    publicOrigin: ORIGIN,
    trustedProxyAddresses
  }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
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

async function rawRequest(baseUrl, pathname, headers, body = '{}') {
  const target = new URL(pathname, baseUrl)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({
          status: response.statusCode,
          body: text ? JSON.parse(text) : null
        })
      })
    })
    req.once('error', reject)
    req.end(body)
  })
}

async function chunkedRequest(baseUrl, pathname, headers, chunks) {
  const target = new URL(pathname, baseUrl)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers
    }, (response) => {
      const responseChunks = []
      response.on('data', (chunk) => responseChunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(responseChunks).toString('utf8')
        resolve({
          status: response.statusCode,
          body: text ? JSON.parse(text) : null
        })
      })
    })
    req.once('error', reject)
    for (const chunk of chunks) req.write(chunk)
    req.end()
  })
}

function adminCookie(token = ADMIN_TOKEN) {
  return `__Host-kinvest-admin=${token}`
}

function postHeaders(overrides = {}) {
  return {
    origin: ORIGIN,
    cookie: adminCookie(),
    'x-kinvest-csrf': CSRF_TOKEN,
    'content-type': 'application/json',
    'x-real-ip': CLIENT_IP,
    'x-forwarded-for': CLIENT_IP,
    ...overrides
  }
}

function expectedQuote(caseId) {
  const value = { ...quoteSnapshot(caseId) }
  delete value.listingId
  return value
}

function expectedFinancial(caseId) {
  const value = { ...financialPoint(caseId) }
  delete value.indicatorId
  return value
}

function expectedLatest(caseId) {
  return {
    status: 'complete',
    quoteStatus: 'available',
    financeStatus: 'available',
    requestCount: 3,
    dataVol: 42,
    elapsedMs: 75,
    safeErrorClass: null,
    createdAt: NOW - 75,
    completedAt: NOW,
    quote: expectedQuote(caseId),
    financial: [expectedFinancial(caseId)]
  }
}

function expectedQuota(caseId) {
  const value = quotaStatus(caseId)
  return {
    officialStatus: 'unavailable',
    localStatus: 'available',
    localDayKey: value.localDayKey,
    caseAttemptCount: value.caseAttemptCount,
    globalAttemptCount: value.globalAttemptCount,
    caseRemaining: value.caseRemaining,
    globalRemaining: value.globalRemaining,
    cooldownUntil: value.cooldownUntil,
    inFlight: value.inFlight,
    inFlightExpiresAt: value.inFlightExpiresAt
  }
}

function assertNoSensitivePayload(value) {
  const serialized = JSON.stringify(value)
  for (const marker of [
    VERSION_ID,
    'listing-hkex-9988',
    'listing-nasdaq-aapl',
    'listing-sse-600519',
    '_REVENUE_VENDOR_ID',
    'RAW_VENDOR_401',
    'IFIND_CLIENT_FAILED',
    'RequestId',
    'refresh_token',
    'access_token',
    'raw provider body',
    'company-alibaba-group'
  ]) {
    assert.equal(serialized.includes(marker), false, marker)
  }
}

async function testListDetailAndRunSuccessProjection() {
  const marketRuntime = createMarketRuntime()
  const running = await start({ marketRuntime })
  try {
    const health = await request(running.baseUrl, '/api/health')
    assert.equal(health.status, 200)
    assert.equal(Object.hasOwn(health.body, 'marketCases'), false)

    const list = await request(running.baseUrl, '/api/admin/ifind/market-cases', {
      headers: { cookie: adminCookie() }
    })
    assert.equal(list.status, 200)
    assert.equal(list.body.data.runtimeStatus, 'available')
    assert.deepEqual(
      list.body.data.cases.map((entry) => entry.case),
      CASE_IDS.map((caseId) => PRESENTATION[caseId])
    )
    assert.deepEqual(list.body.data.cases[0].latest, expectedLatest(CASE_IDS[0]))
    assert.deepEqual(list.body.data.cases[0].quota, expectedQuota(CASE_IDS[0]))
    assertNoSensitivePayload(list.body)

    const caseId = CASE_IDS[0]
    const detail = await request(
      running.baseUrl,
      `/api/admin/ifind/market-cases/${caseId}`,
      { headers: { cookie: adminCookie() } }
    )
    assert.equal(detail.status, 200)
    assert.deepEqual(detail.body.data.case, PRESENTATION[caseId])
    assert.deepEqual(detail.body.data.latest, expectedLatest(caseId))
    assert.equal(detail.body.data.history.length, 2)
    assert.equal(detail.body.data.history[1].status, 'failed')
    assert.equal(detail.body.data.history[1].safeErrorClass, 'AUTH')
    assert.deepEqual(detail.body.data.quota, expectedQuota(caseId))
    assertNoSensitivePayload(detail.body)

    const run = await request(
      running.baseUrl,
      `/api/admin/ifind/market-cases/${caseId}/run`,
      { method: 'POST', headers: postHeaders(), body: '{}' }
    )
    assert.equal(run.status, 200)
    assert.equal(run.body.data.status, 'complete')
    assert.equal(run.body.data.safeErrorClass, null)
    assert.deepEqual(run.body.data.case.case, PRESENTATION[caseId])
    assert.deepEqual(run.body.data.case.latest, expectedLatest(caseId))
    assertNoSensitivePayload(run.body)

    const runCall = marketRuntime.calls.find(([name]) => name === 'run')
    assert.deepEqual(runCall, ['run', { caseId }])
    assert.deepEqual(Object.keys(runCall[1]), ['caseId'])
  } finally {
    await running.close()
  }
}

async function testAdministratorBoundaryAndExactRoutes() {
  const marketRuntime = createMarketRuntime()
  const running = await start({ marketRuntime })
  try {
    const listPath = '/api/admin/ifind/market-cases'
    for (const headers of [
      {},
      { cookie: `__Host-kinvest-device=${DEVICE_TOKEN}` },
      { cookie: adminCookie(EXPIRED_ADMIN_TOKEN) },
      { cookie: '__Host-kinvest-admin=bad' }
    ]) {
      const response = await request(running.baseUrl, listPath, { headers })
      assert.ok([400, 401].includes(response.status))
    }
    assert.deepEqual(marketRuntime.calls, [])

    const crossOriginRead = await request(running.baseUrl, listPath, {
      headers: { origin: 'https://attacker.example', cookie: adminCookie() }
    })
    assert.deepEqual(crossOriginRead.body, { error: 'ORIGIN_INVALID' })
    assert.equal(crossOriginRead.status, 403)

    for (const pathname of [
      '/api/admin/ifind/market-cases/US_TESLA_TSLA',
      '/api/admin/ifind/market-cases/HK_ALIBABA_9988/extra',
      '/api/admin/ifind/market-cases/HK_ALIBABA_9988/',
      '/api/admin/ifind/market-cases/HK_ALIBABA_9988%2Frun',
      '/api/admin/ifind/market-cases/%48K_ALIBABA_9988',
      '/api/admin/ifind//market-cases/HK_ALIBABA_9988'
    ]) {
      const response = await request(running.baseUrl, pathname, {
        headers: { cookie: adminCookie() }
      })
      assert.equal(response.status, 404, pathname)
    }

    const getRun = await request(
      running.baseUrl,
      '/api/admin/ifind/market-cases/HK_ALIBABA_9988/run',
      { headers: { cookie: adminCookie() } }
    )
    assert.equal(getRun.status, 404)
    const postList = await request(running.baseUrl, listPath, {
      method: 'POST', headers: postHeaders(), body: '{}'
    })
    assert.equal(postList.status, 404)

    const queryRead = await request(
      running.baseUrl,
      `${listPath}?securityCode=AAPL.US`,
      { headers: { cookie: adminCookie() } }
    )
    assert.equal(queryRead.status, 404)
    const queryRun = await request(
      running.baseUrl,
      '/api/admin/ifind/market-cases/HK_ALIBABA_9988/run?indicatorId=RAW',
      { method: 'POST', headers: postHeaders(), body: '{}' }
    )
    assert.equal(queryRun.status, 404)
    assert.equal(marketRuntime.calls.some(([name]) => name === 'run'), false)
  } finally {
    await running.close()
  }
}

async function testPrototypeAdministratorServiceComposition() {
  const accessRuntime = createAccessRuntime()
  const delegate = accessRuntime.adminAuth
  class PrototypeAdminAuth {
    authenticate(token) {
      return delegate.authenticate(token)
    }

    verifyCsrf(token, csrf) {
      return delegate.verifyCsrf(token, csrf)
    }

    authenticateMutation(token, csrf) {
      return delegate.authenticateMutation(token, csrf)
    }
  }
  accessRuntime.adminAuth = new PrototypeAdminAuth()
  const running = await start({ accessRuntime })
  try {
    const list = await request(running.baseUrl, '/api/admin/ifind/market-cases', {
      headers: { cookie: adminCookie() }
    })
    assert.equal(list.status, 200)

    const mutationCallStart = accessRuntime.calls.length
    const run = await request(
      running.baseUrl,
      '/api/admin/ifind/market-cases/HK_ALIBABA_9988/run',
      { method: 'POST', headers: postHeaders(), body: '{}' }
    )
    assert.equal(run.status, 200)
    assert.deepEqual(accessRuntime.calls.slice(mutationCallStart), [[
      'authenticateMutation', ADMIN_TOKEN, CSRF_TOKEN
    ]])
  } finally {
    await running.close()
  }
}

async function testStrictTrustedMutationBoundary() {
  const marketRuntime = createMarketRuntime()
  const running = await start({ marketRuntime })
  const endpoint = '/api/admin/ifind/market-cases/HK_ALIBABA_9988/run'
  try {
    const cases = [
      [{ ...postHeaders(), origin: 'https://attacker.example' }, '{}', 403, 'ORIGIN_INVALID'],
      [{ ...postHeaders(), cookie: `__Host-kinvest-device=${DEVICE_TOKEN}` }, '{}', 401, 'ADMIN_AUTH_REQUIRED'],
      [{ ...postHeaders(), cookie: adminCookie(EXPIRED_ADMIN_TOKEN) }, '{}', 401, 'ADMIN_AUTH_REQUIRED'],
      [{ ...postHeaders(), 'x-kinvest-csrf': 'B'.repeat(43) }, '{}', 403, 'ADMIN_CSRF_INVALID'],
      [{ ...postHeaders(), 'content-type': 'text/plain' }, '{}', 415, 'JSON_REQUIRED'],
      [postHeaders(), '', 400, 'JSON_INVALID'],
      [postHeaders(), '{', 400, 'JSON_INVALID'],
      [postHeaders(), '{} trailing', 400, 'JSON_INVALID'],
      [postHeaders(), '[]', 400, 'JSON_INVALID'],
      [postHeaders(), 'null', 400, 'JSON_INVALID'],
      [postHeaders(), '1', 400, 'JSON_INVALID'],
      [postHeaders(), 'true', 400, 'JSON_INVALID'],
      [postHeaders(), '"value"', 400, 'JSON_INVALID'],
      [postHeaders(), '{"caseId":"US_APPLE_AAPL"}', 400, 'JSON_INVALID'],
      [postHeaders(), JSON.stringify({ value: 'x'.repeat(4097) }), 413, 'BODY_TOO_LARGE'],
      [{ ...postHeaders(), 'x-forwarded-for': '198.51.100.9' }, '{}', 400, 'CLIENT_IDENTITY_INVALID'],
      [{ ...postHeaders(), 'x-forwarded-for': undefined }, '{}', 400, 'CLIENT_IDENTITY_INVALID']
    ]
    for (const [headers, body, status, error] of cases) {
      const response = await request(running.baseUrl, endpoint, {
        method: 'POST', headers, body
      })
      assert.equal(response.status, status, `${status} ${error}`)
      assert.deepEqual(response.body, { error })
    }
    assert.equal(marketRuntime.calls.some(([name]) => name === 'run'), false)

    const chunked = await chunkedRequest(
      running.baseUrl,
      endpoint,
      postHeaders(),
      [Buffer.alloc(3000, 0x20), Buffer.alloc(1500, 0x20)]
    )
    assert.equal(chunked.status, 413)
    assert.deepEqual(chunked.body, { error: 'BODY_TOO_LARGE' })
    assert.equal(marketRuntime.calls.some(([name]) => name === 'run'), false)

    const baseRawHeaders = [
      'Cookie', adminCookie(),
      'X-Kinvest-Csrf', CSRF_TOKEN,
      'Content-Type', 'application/json',
      'X-Real-Ip', CLIENT_IP,
      'X-Forwarded-For', CLIENT_IP
    ]
    for (const duplicate of [
      ['Origin', ORIGIN, 'Origin', ORIGIN, ...baseRawHeaders],
      ['Origin', ORIGIN, ...baseRawHeaders, 'X-Kinvest-Csrf', CSRF_TOKEN],
      ['Origin', ORIGIN, ...baseRawHeaders, 'X-Real-Ip', CLIENT_IP]
    ]) {
      const response = await rawRequest(running.baseUrl, endpoint, duplicate)
      assert.equal(response.status, 400)
      if (response.body !== null) {
        assert.deepEqual(response.body, { error: 'HEADER_INVALID' })
      }
    }
    assert.equal(marketRuntime.calls.some(([name]) => name === 'run'), false)
  } finally {
    await running.close()
  }
}

async function testUnavailableAndHostileRuntimeMappings() {
  let disabledRunCalls = 0
  const disabledRuntime = {
    status: { mode: 'disabled', configured: false, versionId: null },
    marketService: {
      async run() { disabledRunCalls += 1 }
    }
  }
  const disabledServer = await start({ marketRuntime: disabledRuntime })
  try {
    const list = await request(disabledServer.baseUrl, '/api/admin/ifind/market-cases', {
      headers: { cookie: adminCookie() }
    })
    assert.equal(list.status, 200)
    assert.equal(list.body.data.runtimeStatus, 'disabled')
    assert.equal(list.body.data.cases[0].latest, null)
    assert.equal(list.body.data.cases[0].quota.localStatus, 'unavailable')

    const run = await request(
      disabledServer.baseUrl,
      '/api/admin/ifind/market-cases/HK_ALIBABA_9988/run',
      { method: 'POST', headers: postHeaders(), body: '{}' }
    )
    assert.deepEqual(run.body, { error: 'IFIND_MARKET_DIAGNOSTIC_DISABLED' })
    assert.equal(run.status, 503)
    assert.equal(disabledRunCalls, 0)
  } finally {
    await disabledServer.close()
  }

  const partialRuntime = createMarketRuntime()
  delete partialRuntime.marketService.latest
  delete partialRuntime.marketService.history
  delete partialRuntime.marketService.quotaStatus
  const unavailableServer = await start({ marketRuntime: partialRuntime })
  try {
    const list = await request(unavailableServer.baseUrl, '/api/admin/ifind/market-cases', {
      headers: { cookie: adminCookie() }
    })
    assert.equal(list.body.data.runtimeStatus, 'unavailable')
    const run = await request(
      unavailableServer.baseUrl,
      '/api/admin/ifind/market-cases/HK_ALIBABA_9988/run',
      { method: 'POST', headers: postHeaders(), body: '{}' }
    )
    assert.equal(run.status, 503)
    assert.deepEqual(run.body, { error: 'IFIND_MARKET_DIAGNOSTIC_UNAVAILABLE' })
    assert.equal(partialRuntime.calls.some(([name]) => name === 'run'), false)
  } finally {
    await unavailableServer.close()
  }

  const unverifiedRuntime = createMarketRuntime()
  unverifiedRuntime.status.versionId = 'unverified'
  const unverifiedServer = await start({ marketRuntime: unverifiedRuntime })
  try {
    const run = await request(
      unverifiedServer.baseUrl,
      '/api/admin/ifind/market-cases/HK_ALIBABA_9988/run',
      { method: 'POST', headers: postHeaders(), body: '{}' }
    )
    assert.equal(run.status, 503)
    assert.deepEqual(run.body, { error: 'IFIND_MARKET_DIAGNOSTIC_UNAVAILABLE' })
    assert.equal(unverifiedRuntime.calls.some(([name]) => name === 'run'), false)
  } finally {
    await unverifiedServer.close()
  }

  for (const hostile of ['throw', 'extra', 'proxy', 'getter']) {
    const runtime = createMarketRuntime()
    if (hostile === 'throw') {
      runtime.marketService.latest = () => {
        throw new Error('raw provider body RequestId=secret')
      }
    } else if (hostile === 'extra') {
      runtime.marketService.latest = ({ caseId }) => ({
        ...completedRun(caseId),
        rawProviderBody: 'secret'
      })
    } else if (hostile === 'proxy') {
      runtime.marketService.latest = () => new Proxy({}, {
        get() { throw new Error('raw proxy secret') }
      })
    } else {
      runtime.marketService.latest = () => Object.defineProperty({}, 'runId', {
        enumerable: true,
        get() { throw new Error('raw getter secret') }
      })
    }
    const running = await start({ marketRuntime: runtime })
    try {
      const response = await request(
        running.baseUrl,
        '/api/admin/ifind/market-cases/HK_ALIBABA_9988',
        { headers: { cookie: adminCookie() } }
      )
      assert.equal(response.status, 500, hostile)
      assert.deepEqual(response.body, { error: 'INTERNAL_ERROR' })
      assertNoSensitivePayload(response.body)
    } finally {
      await running.close()
    }
  }
}

function assertGenericBoundaryResponse(response, status, error) {
  assert.equal(response.status, status)
  assert.deepEqual(response.body, { error })
  const serialized = JSON.stringify(response.body)
  for (const marker of ['RequestId', 'token', 'secret', '418']) {
    assert.equal(serialized.includes(marker), false, marker)
  }
}

async function testDependencyErrorsCannotForgeHttpBoundary() {
  const scenarios = [
    {
      name: 'same class',
      create() {
        return new HttpBoundaryError('RequestId_token_secret', 418)
      }
    },
    {
      name: 'same prototype with accessors',
      create(state) {
        const error = Object.create(HttpBoundaryError.prototype)
        for (const key of ['code', 'status', 'message', 'name']) {
          Object.defineProperty(error, key, {
            get() {
              state.reads += 1
              return key === 'status' ? 418 : `RequestId_token_secret_${key}`
            }
          })
        }
        return error
      }
    },
    {
      name: 'proxy',
      create(state) {
        return new Proxy(Object.create(null), {
          get() {
            state.reads += 1
            return 'RequestId_token_secret'
          },
          getPrototypeOf() {
            state.reads += 1
            return null
          }
        })
      }
    },
    {
      name: 'known dependency code',
      create() {
        return {
          code: 'ADMIN_SESSION_EXPIRED',
          message: 'RequestId token secret'
        }
      }
    }
  ]

  for (const scenario of scenarios) {
    for (const operation of ['latest', 'run']) {
      const state = { reads: 0 }
      const runtime = createMarketRuntime()
      if (operation === 'latest') {
        runtime.marketService.latest = () => { throw scenario.create(state) }
      } else {
        runtime.marketService.run = async () => { throw scenario.create(state) }
      }
      const running = await start({ marketRuntime: runtime })
      try {
        const response = operation === 'latest'
          ? await request(
              running.baseUrl,
              '/api/admin/ifind/market-cases/HK_ALIBABA_9988',
              { headers: { cookie: adminCookie() } }
            )
          : await request(
              running.baseUrl,
              '/api/admin/ifind/market-cases/HK_ALIBABA_9988/run',
              { method: 'POST', headers: postHeaders(), body: '{}' }
            )
        assertGenericBoundaryResponse(response, 500, 'INTERNAL_ERROR')
        assert.equal(state.reads, 0, `${scenario.name} ${operation}`)
      } finally {
        await running.close()
      }
    }
  }

  const authenticationRuntime = createAccessRuntime()
  authenticationRuntime.adminAuth.authenticate = () => {
    throw new HttpBoundaryError('RequestId_token_secret', 418)
  }
  const authenticationServer = await start({
    accessRuntime: authenticationRuntime
  })
  try {
    const response = await request(
      authenticationServer.baseUrl,
      '/api/admin/ifind/market-cases',
      { headers: { cookie: adminCookie() } }
    )
    assertGenericBoundaryResponse(response, 401, 'ADMIN_AUTH_REQUIRED')
  } finally {
    await authenticationServer.close()
  }

  const csrfRuntime = createAccessRuntime()
  csrfRuntime.adminAuth.authenticateMutation = () => {
    throw new HttpBoundaryError('RequestId_token_secret', 418)
  }
  const csrfServer = await start({ accessRuntime: csrfRuntime })
  try {
    const response = await request(
      csrfServer.baseUrl,
      '/api/admin/ifind/market-cases/HK_ALIBABA_9988/run',
      { method: 'POST', headers: postHeaders(), body: '{}' }
    )
    assertGenericBoundaryResponse(response, 401, 'ADMIN_AUTH_REQUIRED')
  } finally {
    await csrfServer.close()
  }
}

function coercionTrap(value, state) {
  return Object.freeze({
    [Symbol.toPrimitive]() {
      state.reads += 1
      return value
    },
    toString() {
      state.reads += 1
      return value
    },
    valueOf() {
      state.reads += 1
      return value
    }
  })
}

async function testHostileDtoPrimitivesAreNotCoerced() {
  const caseId = 'HK_ALIBABA_9988'
  const scenarios = [
    {
      name: 'latest run id',
      configure(runtime, trap) {
        runtime.marketService.latest = () => completedRun(caseId, { runId: trap })
      },
      method: 'GET'
    },
    {
      name: 'latest token version',
      configure(runtime, trap) {
        runtime.marketService.latest = () => completedRun(caseId, {
          tokenVersionId: trap
        })
      },
      method: 'GET'
    },
    {
      name: 'financial report period',
      configure(runtime, trap) {
        runtime.marketService.latest = () => completedRun(caseId, {
          financialPoints: [{ ...financialPoint(caseId), reportPeriod: trap }]
        })
      },
      method: 'GET'
    },
    {
      name: 'financial period end',
      configure(runtime, trap) {
        runtime.marketService.latest = () => completedRun(caseId, {
          financialPoints: [{ ...financialPoint(caseId), periodEnd: trap }]
        })
      },
      method: 'GET'
    },
    {
      name: 'quota local day',
      configure(runtime, trap) {
        runtime.marketService.quotaStatus = () => ({
          ...quotaStatus(caseId), localDayKey: trap
        })
      },
      method: 'GET'
    },
    {
      name: 'complete outcome run id',
      configure(runtime, trap) {
        runtime.marketService.run = async () => ({
          status: 'complete',
          caseId,
          runId: trap,
          quoteStatus: 'available',
          financeStatus: 'available',
          requestCount: 3
        })
      },
      method: 'POST'
    },
    {
      name: 'partial outcome failure code',
      configure(runtime, trap) {
        runtime.marketService.run = async () => ({
          status: 'partial',
          caseId,
          runId: `market_run_${'4'.repeat(32)}`,
          quoteStatus: 'available',
          financeStatus: 'unavailable',
          requestCount: 3,
          failureCode: trap,
          safeErrorClass: 'AUTH',
          stage: 'financial',
          vendorErrorCode: null
        })
      },
      method: 'POST'
    },
    {
      name: 'failed outcome failure code',
      configure(runtime, trap) {
        runtime.marketService.run = async () => ({
          status: 'failed',
          failureCode: trap,
          safeErrorClass: 'AUTH',
          stage: 'authentication',
          vendorErrorCode: null
        })
      },
      method: 'POST'
    }
  ]

  for (const scenario of scenarios) {
    const state = { reads: 0 }
    const runtime = createMarketRuntime()
    scenario.configure(runtime, coercionTrap('RequestId_token_secret', state))
    const running = await start({ marketRuntime: runtime })
    try {
      const response = scenario.method === 'POST'
        ? await request(
            running.baseUrl,
            `/api/admin/ifind/market-cases/${caseId}/run`,
            { method: 'POST', headers: postHeaders(), body: '{}' }
          )
        : await request(
            running.baseUrl,
            `/api/admin/ifind/market-cases/${caseId}`,
            { headers: { cookie: adminCookie() } }
          )
      assertGenericBoundaryResponse(response, 500, 'INTERNAL_ERROR')
      assert.equal(state.reads, 0, scenario.name)
    } finally {
      await running.close()
    }
  }
}

async function testRunOutcomeHttpMappings() {
  const caseId = 'HK_ALIBABA_9988'
  const block = (status, failureCode) => ({
    status,
    failureCode,
    safeErrorClass: 'AUTH',
    stage: 'reservation',
    vendorErrorCode: null
  })
  const scenarios = [
    {
      name: 'partial',
      outcome: {
        status: 'partial',
        caseId,
        runId: `market_run_${'4'.repeat(32)}`,
        quoteStatus: 'available',
        financeStatus: 'unavailable',
        requestCount: 3,
        failureCode: 'IFIND_CLIENT_FAILED',
        safeErrorClass: 'AUTH',
        stage: 'financial',
        vendorErrorCode: null
      },
      status: 200,
      bodyStatus: 'partial'
    },
    {
      name: 'failed',
      outcome: block('failed', 'IFIND_CLIENT_FAILED'),
      status: 200,
      bodyStatus: 'failed'
    },
    {
      name: 'busy',
      outcome: block('busy', 'IFIND_MARKET_BUSY'),
      status: 409,
      error: 'IFIND_MARKET_DIAGNOSTIC_BUSY'
    },
    {
      name: 'cooldown',
      outcome: block('cooldown', 'IFIND_MARKET_COOLDOWN'),
      status: 429,
      error: 'IFIND_MARKET_DIAGNOSTIC_COOLDOWN'
    },
    {
      name: 'case daily limit',
      outcome: block('case-daily-limit', 'IFIND_MARKET_CASE_DAILY_LIMIT'),
      status: 429,
      error: 'IFIND_MARKET_CASE_DAILY_LIMIT'
    },
    {
      name: 'global daily limit',
      outcome: block('global-daily-limit', 'IFIND_MARKET_GLOBAL_DAILY_LIMIT'),
      status: 429,
      error: 'IFIND_MARKET_GLOBAL_DAILY_LIMIT'
    },
    {
      name: 'rejected unverified',
      outcome: block('rejected', 'IFIND_MARKET_CASE_UNVERIFIED'),
      status: 503,
      error: 'IFIND_MARKET_CASE_UNAVAILABLE'
    },
    {
      name: 'rejected generic',
      outcome: block('rejected', 'IFIND_MARKET_UNAVAILABLE'),
      status: 503,
      error: 'IFIND_MARKET_DIAGNOSTIC_UNAVAILABLE'
    },
    {
      name: 'clock rollback',
      outcome: block('clock-rollback', 'IFIND_MARKET_CLOCK_ROLLBACK'),
      status: 409,
      error: 'IFIND_MARKET_DIAGNOSTIC_UNAVAILABLE'
    }
  ]

  for (const scenario of scenarios) {
    const running = await start({
      marketRuntime: createMarketRuntime({ outcome: scenario.outcome })
    })
    try {
      const response = await request(
        running.baseUrl,
        `/api/admin/ifind/market-cases/${caseId}/run`,
        { method: 'POST', headers: postHeaders(), body: '{}' }
      )
      assert.equal(response.status, scenario.status, scenario.name)
      if (scenario.error) {
        assert.deepEqual(response.body, { error: scenario.error }, scenario.name)
      } else {
        assert.equal(response.body.data.status, scenario.bodyStatus, scenario.name)
        assert.equal(response.body.data.safeErrorClass, 'AUTH', scenario.name)
      }
      assertNoSensitivePayload(response.body)
    } finally {
      await running.close()
    }
  }
}

async function testFamilyRoutesRemainDeviceOnlyMock() {
  const marketRuntime = createMarketRuntime()
  const running = await start({ marketRuntime })
  try {
    const adminOnly = await request(running.baseUrl, '/api/watchlist', {
      headers: { cookie: adminCookie() }
    })
    assert.equal(adminOnly.status, 401)
    assert.deepEqual(adminOnly.body, { error: 'AUTH_REQUIRED' })

    const device = await request(running.baseUrl, '/api/watchlist', {
      headers: { cookie: `__Host-kinvest-device=${DEVICE_TOKEN}` }
    })
    assert.equal(device.status, 200)
    assert.equal(device.body.success, true)
    assert.deepEqual(device.body.data.map((company) => ({
      securityCode: company.securityCode,
      lastPrice: company.quote.lastPrice
    })), [
      { securityCode: '9988.HK', lastPrice: 91.6 },
      { securityCode: 'AAPL.US', lastPrice: 198.2 }
    ])
    assert.deepEqual(marketRuntime.calls, [])
  } finally {
    await running.close()
  }
}

async function run() {
  await testListDetailAndRunSuccessProjection()
  await testAdministratorBoundaryAndExactRoutes()
  await testPrototypeAdministratorServiceComposition()
  await testStrictTrustedMutationBoundary()
  await testUnavailableAndHostileRuntimeMappings()
  await testDependencyErrorsCannotForgeHttpBoundary()
  await testHostileDtoPrimitivesAreNotCoerced()
  await testRunOutcomeHttpMappings()
  await testFamilyRoutesRemainDeviceOnlyMock()
}

module.exports = { run }
