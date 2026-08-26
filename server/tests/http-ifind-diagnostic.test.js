const assert = require('node:assert/strict')
const http = require('node:http')
const { EventEmitter } = require('node:events')

const { createRequestHandler } = require('../server')
const { parseStrictJsonBody } = require('../http/auth-http')

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

/** @param {any} [diagnosticRuntime] */
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

function createBodyStream() {
  const stream = /** @type {EventEmitter & {
   *   headers: Record<string, string>,
   *   complete: boolean,
   *   resumeCalls: number,
   *   resume: () => void
   * }} */ (new EventEmitter())
  stream.headers = { 'content-type': 'application/json' }
  stream.complete = false
  stream.resumeCalls = 0
  stream.resume = () => { stream.resumeCalls += 1 }
  return stream
}

async function observePromptSettlement(promise, fallback) {
  const observed = promise.then(
    (value) => ({ type: 'resolved', value }),
    (error) => ({ type: 'rejected', error })
  )
  const first = await Promise.race([
    observed,
    new Promise((resolve) => setTimeout(() => resolve({ type: 'timeout' }), 25))
  ])
  if (first.type === 'timeout') {
    fallback()
    await observed
  }
  return first
}

function assertParserListenersRemoved(stream) {
  for (const event of ['data', 'error', 'aborted', 'end', 'close']) {
    assert.equal(stream.listenerCount(event), 0, event)
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

async function testJsonStreamTerminalEvents() {
  const closeOnly = createBodyStream()
  const closePromise = parseStrictJsonBody(
    /** @type {any} */ (closeOnly),
    { allowEmpty: false }
  )
  closeOnly.emit('data', Buffer.from('{'))
  closeOnly.emit('close')
  const closed = await observePromptSettlement(closePromise, () => closeOnly.emit('aborted'))
  assert.equal(closed.type, 'rejected')
  assert.equal(closed.error.code, 'JSON_INVALID')
  assertParserListenersRemoved(closeOnly)

  const oversized = createBodyStream()
  const oversizedPromise = parseStrictJsonBody(
    /** @type {any} */ (oversized),
    { allowEmpty: false }
  )
  oversized.emit('data', Buffer.alloc(4097))
  const rejected = await observePromptSettlement(oversizedPromise, () => oversized.emit('end'))
  assert.equal(rejected.type, 'rejected')
  assert.equal(rejected.error.code, 'BODY_TOO_LARGE')
  assert.equal(oversized.resumeCalls, 1)
  assertParserListenersRemoved(oversized)
  oversized.emit('end')
  oversized.emit('aborted')
  oversized.emit('close')

  const completed = createBodyStream()
  let settlements = 0
  const completedPromise = parseStrictJsonBody(
    /** @type {any} */ (completed),
    { allowEmpty: false }
  ).then(
    (value) => { settlements += 1; return value },
    (error) => { settlements += 1; throw error }
  )
  completed.emit('data', Buffer.from('{}'))
  completed.complete = true
  completed.emit('end')
  assert.deepEqual(await completedPromise, {})
  completed.emit('close')
  completed.emit('aborted')
  completed.emit('data', Buffer.from('raw-late-data'))
  completed.emit('end')
  await Promise.resolve()
  assert.equal(settlements, 1)
  assertParserListenersRemoved(completed)
}

async function testRuntimeAvailabilityAndServiceFailures() {
  let disabledServiceCalls = 0
  const disabledRuntime = Object.freeze({
    status: Object.freeze({ mode: 'disabled', configured: false, versionId: null }),
    service: Object.freeze({
      status() { disabledServiceCalls += 1; return createDiagnosticRuntime().service.status() },
      async run() { disabledServiceCalls += 1; return createDiagnosticRuntime().service.run() }
    })
  })
  for (const diagnosticRuntime of [null, disabledRuntime]) {
    const running = await start(diagnosticRuntime)
    try {
      const getResponse = await request(running.baseUrl, '/api/admin/ifind/diagnostics', {
        headers: { cookie: adminCookie() }
      })
      assert.deepEqual(getResponse, {
        status: 503,
        body: { error: 'IFIND_DIAGNOSTIC_DISABLED' }
      })
      const postResponse = await request(running.baseUrl, '/api/admin/ifind/diagnostics/run', {
        method: 'POST', headers: postHeaders(), body: '{}'
      })
      assert.deepEqual(postResponse, {
        status: 503,
        body: { error: 'IFIND_DIAGNOSTIC_DISABLED' }
      })
    } finally {
      await running.close()
    }
  }
  assert.equal(disabledServiceCalls, 0)

  for (const method of ['status', 'run']) {
    const rawMarker = `raw-${method}-provider-error`
    const service = {
      status() {
        if (method === 'status') throw new Error(rawMarker)
        return createDiagnosticRuntime().service.status()
      },
      async run() {
        if (method === 'run') throw new Error(rawMarker)
        return createDiagnosticRuntime().service.run()
      }
    }
    const runtime = {
      status: { mode: 'admin-diagnostic', configured: true, versionId: VERSION_ID },
      service
    }
    const running = await start(runtime)
    try {
      const response = method === 'status'
        ? await request(running.baseUrl, '/api/admin/ifind/diagnostics', {
            headers: { cookie: adminCookie() }
          })
        : await request(running.baseUrl, '/api/admin/ifind/diagnostics/run', {
            method: 'POST', headers: postHeaders(), body: '{}'
          })
      assert.deepEqual(response, { status: 500, body: { error: 'INTERNAL_ERROR' } })
      assert.equal(JSON.stringify(response.body).includes(rawMarker), false)
    } finally {
      await running.close()
    }
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

  const previousVersion = 'v20260825-001'
  const rotatedRuntime = createDiagnosticRuntime({
    status: {
      mode: 'admin-diagnostic',
      configured: true,
      tokenVersionId: VERSION_ID,
      officialQuotaStatus: 'unavailable',
      cooldownUntil: null,
      localAttemptCount: 2,
      inFlight: false,
      latest: latest({ tokenVersionId: previousVersion })
    }
  })
  const rotatedServer = await start(rotatedRuntime)
  try {
    const response = await request(rotatedServer.baseUrl, '/api/admin/ifind/diagnostics', {
      headers: { cookie: adminCookie() }
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.data.tokenVersionId, VERSION_ID)
    assert.equal(response.body.data.latest.tokenVersionId, previousVersion)
  } finally {
    await rotatedServer.close()
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
    { outcome: { status: 'disabled', safeErrorClass: 'BUSY' } },
    { outcome: { status: 'busy', safeErrorClass: 'BUSY', retryAt: NOW - 1, localAttemptCount: 1 } },
    { outcome: { status: 'cooldown', safeErrorClass: 'RATE_LIMITED', retryAt: NOW + 1, localAttemptCount: 0 } },
    { outcome: { status: 'daily-limit', safeErrorClass: 'RATE_LIMITED', retryAt: NOW + 1, localAttemptCount: 19 } },
    { status: { mode: 'admin-diagnostic', configured: true, tokenVersionId: 'current', officialQuotaStatus: 'unavailable', cooldownUntil: null, localAttemptCount: 1, inFlight: false, latest: null } },
    { status: { mode: 'admin-diagnostic', configured: true, tokenVersionId: VERSION_ID, officialQuotaStatus: 'unavailable', cooldownUntil: null, localAttemptCount: 1, inFlight: false, latest: latest({ route: 'raw-provider-route' }) } },
    { outcome: { status: 'failed', safeErrorClass: 'AUTH', diagnostic: latest({ authStatus: 'success', probeStatus: 'failed', safeErrorClass: 'AUTH', completeness: 'unavailable', dataVol: null }), cooldownUntil: NOW, localAttemptCount: 1 } },
    { outcome: { status: 'failed', safeErrorClass: 'AUTH', diagnostic: latest({ authStatus: 'failed', probeStatus: 'not_run', safeErrorClass: 'AUTH', completeness: 'unavailable', dataVol: null }), cooldownUntil: NOW - 1, localAttemptCount: 1 } },
    { outcome: { status: 'failed', safeErrorClass: 'PERMISSION', diagnostic: latest({ authStatus: 'success', probeStatus: 'failed', safeErrorClass: 'PERMISSION', completeness: 'complete', dataVol: 1 }), cooldownUntil: NOW, localAttemptCount: 1 } },
    { outcome: { status: 'completed', safeErrorClass: null, diagnostic: latest({ requestCount: 1 }), cooldownUntil: NOW, localAttemptCount: 1 } },
    { outcome: { status: 'completed', safeErrorClass: null, diagnostic: latest(), cooldownUntil: NOW, localAttemptCount: 0 } },
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
  await testJsonStreamTerminalEvents()
  await testRuntimeAvailabilityAndServiceFailures()
  await testSafeStatusAndOutcomeMappings()
  await testAdminCookieDoesNotAuthorizeInvestmentData()
}

module.exports = { run }
