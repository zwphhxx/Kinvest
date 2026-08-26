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
    scope: 'fixed_trade_dates_probe',
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
      'configured', 'cooldownUntil', 'inFlight', 'latest', 'localAttemptCount',
      'mode', 'officialQuotaStatus', 'tokenVersionId'
    ])
    assert.deepEqual(Object.keys(response.body.data.latest).sort(), [
      'authStatus', 'completedAt', 'completeness', 'dataVol', 'diagnosticId',
      'elapsedMs', 'officialQuotaStatus', 'probeStatus', 'requestCount', 'route',
      'safeErrorClass', 'scope', 'startedAt', 'tokenVersionId'
    ])
    assert.equal(JSON.stringify(response.body).includes('refresh_token'), false)
    assert.deepEqual(runtime.calls, ['status'])
  } finally {
    await running.close()
  }

  const scenarios = [
    [{ status: 'disabled', safeErrorClass: 'CONFIG', raw: 'provider secret' }, 503, 'IFIND_DIAGNOSTIC_DISABLED'],
    [{ status: 'busy', safeErrorClass: 'BUSY', retryAt: NOW + 1000, localAttemptCount: 1 }, 409, 'IFIND_DIAGNOSTIC_BUSY'],
    [{ status: 'cooldown', safeErrorClass: 'RATE_LIMITED', retryAt: NOW + 1000, localAttemptCount: 2 }, 429, 'IFIND_DIAGNOSTIC_COOLDOWN'],
    [{ status: 'daily-limit', safeErrorClass: 'RATE_LIMITED', retryAt: NOW + 1000, localAttemptCount: 20 }, 429, 'IFIND_DIAGNOSTIC_DAILY_LIMIT'],
    [{ status: 'failed', safeErrorClass: 'AUTH', diagnostic: latest({ authStatus: 'failed', probeStatus: 'not_run', safeErrorClass: 'AUTH', dataVol: null, completeness: 'unavailable' }), cooldownUntil: NOW + 1000, localAttemptCount: 3, RequestId: 'raw-request-id' }, 200, null],
    [{ status: 'failed', safeErrorClass: 'PERMISSION', diagnostic: latest({ probeStatus: 'failed', safeErrorClass: 'PERMISSION', dataVol: null, completeness: 'unavailable' }), cooldownUntil: NOW + 1000, localAttemptCount: 4, token: 'raw-token' }, 200, null],
    [{ status: 'completed', safeErrorClass: null, diagnostic: latest(), cooldownUntil: NOW + 1000, localAttemptCount: 5 }, 200, null]
  ]
  for (const [outcome, expectedStatus, expectedError] of scenarios) {
    const scenarioRuntime = createDiagnosticRuntime({ outcome })
    const scenarioServer = await start(scenarioRuntime)
    try {
      const response = await request(scenarioServer.baseUrl, '/api/admin/ifind/diagnostics/run', {
        method: 'POST', headers: postHeaders(), body: '{}'
      })
      assert.equal(response.status, expectedStatus)
      if (expectedError) assert.equal(response.body.error, expectedError)
      else assert.deepEqual(Object.keys(response.body.data).sort(), [
        'cooldownUntil', 'diagnostic', 'localAttemptCount', 'safeErrorClass', 'status'
      ])
      const serialized = JSON.stringify(response.body)
      for (const marker of ['provider secret', 'raw-request-id', 'raw-token', 'RequestId']) {
        assert.equal(serialized.includes(marker), false)
      }
    } finally {
      await scenarioServer.close()
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
