const assert = require('node:assert/strict')
const http = require('node:http')

const { createRequestHandler } = require('../server')

const ORIGIN = 'https://dearmina.cn'
const NOW = Date.UTC(2026, 7, 26, 8, 0, 0)
const ADMIN_TOKEN = 'A'.repeat(43)
const EXPIRED_ADMIN_TOKEN = 'X'.repeat(43)
const DEVICE_TOKEN = 'D'.repeat(43)
const CSRF_TOKEN = 'C'.repeat(43)
const VERSION_ID = 'v20260826-001'

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

function createAccessRuntime() {
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
        if (token === EXPIRED_ADMIN_TOKEN) throw codedError('ADMIN_SESSION_EXPIRED')
        if (token !== ADMIN_TOKEN) throw codedError('ADMIN_SESSION_INVALID')
        return {
          idleExpiresAt: NOW + 1_800_000,
          absoluteExpiresAt: NOW + 28_800_000
        }
      },
      verifyCsrf(token, csrf) {
        if (token === EXPIRED_ADMIN_TOKEN) throw codedError('ADMIN_SESSION_EXPIRED')
        if (token !== ADMIN_TOKEN) throw codedError('ADMIN_SESSION_INVALID')
        if (csrf !== CSRF_TOKEN) throw codedError('ADMIN_CSRF_INVALID')
        return {
          idleExpiresAt: NOW + 1_800_000,
          absoluteExpiresAt: NOW + 28_800_000
        }
      }
    }
  }
}

function latest(overrides = {}) {
  return {
    diagnosticId: 'diag_0123456789abcdef0123456789abcdef',
    startedAt: NOW - 50,
    completedAt: NOW,
    authStatus: 'success',
    probeStatus: 'success',
    safeErrorClass: null,
    route: '/api/v1/get_trade_dates',
    scope: 'market-trade-dates:212001:D:-10',
    requestCount: 2,
    dataVol: 7,
    elapsedMs: 50,
    completeness: 'complete',
    tokenVersionId: VERSION_ID,
    officialQuotaStatus: 'unavailable',
    ...overrides
  }
}

/**
 * @param {{status?: any, outcome?: any}} [options]
 */
function createDiagnosticRuntime({ status, outcome } = {}) {
  const calls = []
  const service = {
    status() {
      calls.push('status')
      return status || {
        mode: 'admin-diagnostic',
        configured: true,
        tokenVersionId: VERSION_ID,
        officialQuotaStatus: 'unavailable',
        cooldownUntil: null,
        localAttemptCount: 1,
        inFlight: false,
        latest: latest()
      }
    },
    async run() {
      calls.push('run')
      return outcome || {
        status: 'completed',
        safeErrorClass: null,
        diagnostic: latest(),
        cooldownUntil: NOW + 60_000,
        localAttemptCount: 2
      }
    }
  }
  return {
    status: { mode: 'admin-diagnostic', configured: true, versionId: VERSION_ID },
    service,
    calls
  }
}

async function start(diagnosticRuntime = createDiagnosticRuntime()) {
  const server = http.createServer(createRequestHandler({
    accessRuntime: createAccessRuntime(),
    ifindDiagnosticRuntime: diagnosticRuntime,
    now: () => NOW,
    publicOrigin: ORIGIN,
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

/**
 * @param {string} baseUrl
 * @param {string} pathname
 * @param {{method?: string, headers?: Record<string, string>, body?: string}} [options]
 */
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
    body: text ? JSON.parse(text) : null
  }
}

async function abortPartialRequest(baseUrl) {
  const observed = []
  const onUnhandled = (error) => observed.push(error)
  process.on('unhandledRejection', onUnhandled)
  process.on('uncaughtExceptionMonitor', onUnhandled)
  try {
    await new Promise((resolve) => {
      const req = http.request(`${baseUrl}/api/admin/ifind/diagnostics/run`, {
        method: 'POST',
        headers: {
          ...postHeaders(),
          'content-length': '2'
        }
      })
      req.once('response', (response) => {
        response.resume()
        response.once('end', resolve)
      })
      req.once('error', () => resolve())
      req.write('{')
      req.flushHeaders()
      setTimeout(() => req.destroy(), 20)
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
    process.removeListener('uncaughtExceptionMonitor', onUnhandled)
  }
  assert.deepEqual(observed, [])
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
    ...overrides
  }
}

async function testAdministratorBoundaryAndOrdering() {
  const runtime = createDiagnosticRuntime()
  const running = await start(runtime)
  try {
    for (const headers of [
      {},
      { cookie: `__Host-kinvest-device=${DEVICE_TOKEN}` },
      { cookie: adminCookie(EXPIRED_ADMIN_TOKEN) },
      { cookie: '__Host-kinvest-admin=bad' }
    ]) {
      const response = await request(running.baseUrl, '/api/admin/ifind/diagnostics', { headers })
      assert.ok([400, 401].includes(response.status))
    }
    assert.deepEqual(runtime.calls, [])

    const crossOriginRead = await request(running.baseUrl, '/api/admin/ifind/diagnostics', {
      headers: { origin: 'https://attacker.example', cookie: adminCookie() }
    })
    assert.deepEqual(crossOriginRead, { status: 403, body: { error: 'ORIGIN_INVALID' } })

    const crossOrigin = await request(running.baseUrl, '/api/admin/ifind/diagnostics/run', {
      method: 'POST',
      headers: { ...postHeaders(), origin: 'https://attacker.example', cookie: '' },
      body: '{'
    })
    assert.deepEqual(crossOrigin, { status: 403, body: { error: 'ORIGIN_INVALID' } })

    const anonymousMalformed = await request(running.baseUrl, '/api/admin/ifind/diagnostics/run', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: '{'
    })
    assert.deepEqual(anonymousMalformed, { status: 401, body: { error: 'ADMIN_AUTH_REQUIRED' } })

    for (const cookie of [
      `__Host-kinvest-device=${DEVICE_TOKEN}`,
      adminCookie(EXPIRED_ADMIN_TOKEN),
      '__Host-kinvest-admin=bad'
    ]) {
      const rejected = await request(running.baseUrl, '/api/admin/ifind/diagnostics/run', {
        method: 'POST',
        headers: postHeaders({ cookie }),
        body: '{}'
      })
      assert.ok([400, 401].includes(rejected.status))
    }

    const badCsrfMalformed = await request(running.baseUrl, '/api/admin/ifind/diagnostics/run', {
      method: 'POST',
      headers: postHeaders({ 'x-kinvest-csrf': 'B'.repeat(43) }),
      body: '{'
    })
    assert.deepEqual(badCsrfMalformed, { status: 403, body: { error: 'ADMIN_CSRF_INVALID' } })
    assert.deepEqual(runtime.calls, [])
  } finally {
    await running.close()
  }
}

async function testStrictEmptyJsonBody() {
  const runtime = createDiagnosticRuntime()
  const running = await start(runtime)
  try {
    /** @type {Array<[Record<string, string>, string, number, string]>} */
    const cases = [
      [postHeaders(), '', 400, 'JSON_INVALID'],
      [{ ...postHeaders(), 'content-type': 'text/plain' }, '{}', 415, 'JSON_REQUIRED'],
      [postHeaders(), '{"extra":true}', 400, 'JSON_INVALID'],
      [postHeaders(), '{', 400, 'JSON_INVALID'],
      [postHeaders(), ' '.repeat(4097), 413, 'BODY_TOO_LARGE']
    ]
    for (const [headers, body, status, error] of cases) {
      const response = await request(running.baseUrl, '/api/admin/ifind/diagnostics/run', {
        method: 'POST', headers, body
      })
      assert.deepEqual(response, { status, body: { error } })
    }
    assert.deepEqual(runtime.calls, [])

    await abortPartialRequest(running.baseUrl)
    assert.deepEqual(runtime.calls, [])

    const accepted = await request(running.baseUrl, '/api/admin/ifind/diagnostics/run', {
      method: 'POST', headers: postHeaders(), body: '{}'
    })
    assert.equal(accepted.status, 200)
    assert.deepEqual(runtime.calls, ['run'])
  } finally {
    await running.close()
  }
}

async function testSafeStatusAndOutcomeMappings() {
  const runtime = createDiagnosticRuntime()
  const running = await start(runtime)
  try {
    const response = await request(running.baseUrl, '/api/admin/ifind/diagnostics', {
      headers: { cookie: adminCookie() }
    })
    assert.equal(response.status, 200)
    assert.deepEqual(Object.keys(response.body.data).sort(), [
      'configured', 'cooldownUntil', 'latest', 'localAttemptCount',
      'mode', 'officialQuotaStatus', 'tokenVersionId'
    ])
    assert.deepEqual(Object.keys(response.body.data.latest).sort(), [
      'authStatus', 'completedAt', 'completeness', 'dataVol',
      'elapsedMs', 'officialQuotaStatus', 'probeStatus', 'requestCount', 'route',
      'safeErrorClass', 'scope', 'startedAt', 'tokenVersionId'
    ])
    const expectedLatest = latest()
    delete expectedLatest.diagnosticId
    assert.deepEqual(response.body, {
      data: {
        mode: 'admin-diagnostic',
        configured: true,
        tokenVersionId: VERSION_ID,
        officialQuotaStatus: 'unavailable',
        cooldownUntil: null,
        localAttemptCount: 1,
        latest: expectedLatest
      }
    })
    assert.equal(JSON.stringify(response.body).includes('refresh_token'), false)
    assert.deepEqual(runtime.calls, ['status'])
  } finally {
    await running.close()
  }

  const outcomeCases = [
    {
      outcome: { status: 'disabled', safeErrorClass: 'CONFIG' },
      expected: { status: 503, body: { error: 'IFIND_DIAGNOSTIC_DISABLED' } }
    },
    {
      outcome: { status: 'busy', safeErrorClass: 'BUSY', retryAt: NOW + 1000, localAttemptCount: 1 },
      expected: { status: 409, body: { error: 'IFIND_DIAGNOSTIC_BUSY', retryAt: NOW + 1000, localAttemptCount: 1 } }
    },
    {
      outcome: { status: 'cooldown', safeErrorClass: 'RATE_LIMITED', retryAt: NOW + 2000, localAttemptCount: 2 },
      expected: { status: 429, body: { error: 'IFIND_DIAGNOSTIC_COOLDOWN', retryAt: NOW + 2000, localAttemptCount: 2 } }
    },
    {
      outcome: { status: 'daily-limit', safeErrorClass: 'RATE_LIMITED', retryAt: NOW + 3000, localAttemptCount: 20 },
      expected: { status: 429, body: { error: 'IFIND_DIAGNOSTIC_DAILY_LIMIT', retryAt: NOW + 3000, localAttemptCount: 20 } }
    },
    {
      outcome: { status: 'failed', safeErrorClass: 'AUTH', diagnostic: latest({ authStatus: 'failed', probeStatus: 'not_run', safeErrorClass: 'AUTH', dataVol: null, completeness: 'unavailable' }), cooldownUntil: NOW + 4000, localAttemptCount: 3 },
      expected: { status: 200, body: { data: { status: 'failed', safeErrorClass: 'AUTH', diagnostic: null, cooldownUntil: NOW + 4000, localAttemptCount: 3 } } }
    },
    {
      outcome: { status: 'failed', safeErrorClass: 'PERMISSION', diagnostic: latest({ authStatus: 'success', probeStatus: 'failed', safeErrorClass: 'PERMISSION', dataVol: null, completeness: 'unavailable' }), cooldownUntil: NOW + 5000, localAttemptCount: 4 },
      expected: { status: 200, body: { data: { status: 'failed', safeErrorClass: 'PERMISSION', diagnostic: null, cooldownUntil: NOW + 5000, localAttemptCount: 4 } } }
    },
    {
      outcome: { status: 'completed', safeErrorClass: null, diagnostic: latest(), cooldownUntil: NOW + 6000, localAttemptCount: 5 },
      expected: { status: 200, body: { data: { status: 'completed', safeErrorClass: null, diagnostic: null, cooldownUntil: NOW + 6000, localAttemptCount: 5 } } }
    }
  ]
  for (const scenario of outcomeCases) {
    const expectedDiagnostic = scenario.outcome.diagnostic
      ? { ...scenario.outcome.diagnostic }
      : null
    if (expectedDiagnostic) delete expectedDiagnostic.diagnosticId
    if (scenario.expected.body.data) {
      scenario.expected.body.data.diagnostic = expectedDiagnostic
    }
    const scenarioRuntime = createDiagnosticRuntime({ outcome: scenario.outcome })
    const scenarioServer = await start(scenarioRuntime)
    try {
      const response = await request(scenarioServer.baseUrl, '/api/admin/ifind/diagnostics/run', {
        method: 'POST', headers: postHeaders(), body: '{}'
      })
      assert.deepEqual(response, scenario.expected)
      const serialized = JSON.stringify(response.body)
      for (const marker of ['provider secret', 'raw-request-id', 'raw-token', 'RequestId']) {
        assert.equal(serialized.includes(marker), false)
      }
    } finally {
      await scenarioServer.close()
    }
  }

  const hostileValues = [
    { status: { mode: 'admin-diagnostic', configured: true, tokenVersionId: 'current', officialQuotaStatus: 'unavailable', cooldownUntil: null, localAttemptCount: 1, inFlight: false, latest: null } },
    { status: { mode: 'admin-diagnostic', configured: true, tokenVersionId: VERSION_ID, officialQuotaStatus: 'unavailable', cooldownUntil: null, localAttemptCount: 1, inFlight: false, latest: latest({ route: 'raw-provider-route' }) } },
    { outcome: { status: 'failed', safeErrorClass: 'AUTH', diagnostic: latest({ authStatus: 'success', probeStatus: 'failed', safeErrorClass: 'AUTH', completeness: 'unavailable', dataVol: null }), cooldownUntil: NOW, localAttemptCount: 1 } },
    { outcome: { status: 'completed', safeErrorClass: null, diagnostic: latest({ requestCount: 99 }), cooldownUntil: NOW, localAttemptCount: 1 } },
    { outcome: { status: 'busy', safeErrorClass: 'raw-provider-error', retryAt: NOW, localAttemptCount: 1 } }
  ]
  for (const hostile of hostileValues) {
    const hostileRuntime = createDiagnosticRuntime(hostile)
    const hostileServer = await start(hostileRuntime)
    try {
      const isStatus = Boolean(hostile.status)
      const response = await request(
        hostileServer.baseUrl,
        isStatus ? '/api/admin/ifind/diagnostics' : '/api/admin/ifind/diagnostics/run',
        isStatus
          ? { headers: { cookie: adminCookie() } }
          : { method: 'POST', headers: postHeaders(), body: '{}' }
      )
      assert.deepEqual(response, { status: 500, body: { error: 'INTERNAL_ERROR' } })
      assert.equal(JSON.stringify(response.body).includes('raw-provider'), false)
    } finally {
      await hostileServer.close()
    }
  }
}

async function testAdminCookieDoesNotAuthorizeInvestmentData() {
  const running = await start()
  try {
    const response = await request(running.baseUrl, '/api/watchlist', {
      headers: { cookie: adminCookie() }
    })
    assert.deepEqual(response, { status: 401, body: { error: 'AUTH_REQUIRED' } })
  } finally {
    await running.close()
  }
}

async function run() {
  await testAdministratorBoundaryAndOrdering()
  await testStrictEmptyJsonBody()
  await testSafeStatusAndOutcomeMappings()
  await testAdminCookieDoesNotAuthorizeInvestmentData()
}

module.exports = { run }
