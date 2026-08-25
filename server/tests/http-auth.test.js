const assert = require('node:assert/strict')
const http = require('node:http')

const { createRequestHandler } = require('../server')

const ORIGIN = 'https://dearmina.cn'
const NOW = Date.UTC(2026, 7, 21, 8, 0, 0)
const REQUEST_ID = 'R'.repeat(22)
const TERMINAL_REQUEST_ID = 'T'.repeat(22)
const REQUEST_CREDENTIAL = 'Q'.repeat(43)
const DEVICE_TOKEN = 'D'.repeat(43)
const ROTATED_DEVICE_TOKEN = 'E'.repeat(43)
const ADMIN_TOKEN = 'A'.repeat(43)
const CSRF_TOKEN = 'C'.repeat(43)
const NEW_CSRF_TOKEN = 'N'.repeat(43)

function codedError(code) {
  return Object.assign(new Error(code), { code })
}

function createRuntime(mode = 'device-approval') {
  const calls = []
  const deviceApproval = {
    createRequest(input) {
      calls.push(['createRequest', input])
      return {
        requestId: REQUEST_ID,
        browserCredential: REQUEST_CREDENTIAL,
        requestCode: '123456',
        expiresAt: NOW + 600000
      }
    },
    getRequestStatus(input) {
      calls.push(['getRequestStatus', input])
      if (input.browserCredential !== REQUEST_CREDENTIAL) {
        throw codedError('REQUEST_BROWSER_MISMATCH')
      }
      return input.requestId === TERMINAL_REQUEST_ID
        ? { requestId: TERMINAL_REQUEST_ID, status: 'expired', expiresAt: NOW - 1 }
        : { requestId: REQUEST_ID, status: 'approved', expiresAt: NOW + 600000 }
    },
    redeemRequest(input) {
      calls.push(['redeemRequest', input])
      return {
        token: DEVICE_TOKEN,
        idleExpiresAt: NOW + 86400000,
        absoluteExpiresAt: NOW + 172800000
      }
    },
    authenticate(token) {
      calls.push(['authenticateDevice', token])
      if (token === DEVICE_TOKEN) {
        return {
          authenticated: true,
          idleExpiresAt: NOW + 86400000,
          absoluteExpiresAt: NOW + 172800000,
          rotated: false
        }
      }
      if (token === ROTATED_DEVICE_TOKEN) {
        return {
          authenticated: true,
          token: DEVICE_TOKEN,
          idleExpiresAt: NOW + 86400000,
          absoluteExpiresAt: NOW + 172800000,
          rotated: true
        }
      }
      throw codedError('TOKEN_INVALID')
    },
    approveRequest(input) {
      calls.push(['approveRequest', input])
      return { approved: true, requestId: input.requestId }
    },
    listPendingRequests() {
      calls.push(['listPendingRequests'])
      return [{ requestId: REQUEST_ID, deviceName: 'Family iPad' }]
    },
    listDevices() {
      calls.push(['listDevices'])
      return [{ credentialId: 'credential-1', deviceName: 'Family iPad' }]
    },
    revokeCredential(id) {
      calls.push(['revokeCredential', id])
      return { devicesRevoked: 1, credentialsRevoked: 1 }
    },
    revokeAllCredentials() {
      calls.push(['revokeAllCredentials'])
      return 1
    },
    listAuditEvents() {
      calls.push(['listDeviceAudit'])
      return [{ eventType: 'device_request_created', occurredAt: NOW }]
    }
  }
  const adminAuth = {
    async login(password, identity) {
      calls.push(['login', password, identity])
      if (password !== 'correct-password') throw codedError('ADMIN_AUTH_INVALID')
      return {
        sessionToken: ADMIN_TOKEN,
        csrfToken: CSRF_TOKEN,
        idleExpiresAt: NOW + 1800000,
        absoluteExpiresAt: NOW + 28800000
      }
    },
    authenticate(token) {
      calls.push(['authenticateAdmin', token])
      if (token !== ADMIN_TOKEN) throw codedError('ADMIN_SESSION_INVALID')
      return { idleExpiresAt: NOW + 1800000, absoluteExpiresAt: NOW + 28800000 }
    },
    refreshCsrf(token) {
      calls.push(['refreshCsrf', token])
      if (token !== ADMIN_TOKEN) throw codedError('ADMIN_SESSION_INVALID')
      return {
        csrfToken: NEW_CSRF_TOKEN,
        idleExpiresAt: NOW + 1800000,
        absoluteExpiresAt: NOW + 28800000
      }
    },
    verifyCsrf(token, csrf) {
      calls.push(['verifyCsrf', token, csrf])
      if (token !== ADMIN_TOKEN) throw codedError('ADMIN_SESSION_INVALID')
      if (csrf !== CSRF_TOKEN && csrf !== NEW_CSRF_TOKEN) {
        throw codedError('ADMIN_CSRF_INVALID')
      }
      return { idleExpiresAt: NOW + 1800000, absoluteExpiresAt: NOW + 28800000 }
    },
    async reauthenticate(password, identity) {
      calls.push(['reauthenticate', password, identity])
      if (password !== 'correct-password') throw codedError('ADMIN_AUTH_INVALID')
      return { authenticated: true }
    },
    logout(token, csrf) {
      calls.push(['logout', token, csrf])
      return { revoked: true }
    },
    listAuditEvents() {
      calls.push(['listAdminAudit'])
      return [{ eventType: 'admin_session_created', occurredAt: NOW }]
    }
  }
  return {
    calls,
    status: { mode },
    adminAuth: mode === 'disabled' ? null : adminAuth,
    deviceApproval: mode === 'disabled' ? null : deviceApproval
  }
}

async function start(runtime) {
  const server = http.createServer(createRequestHandler({
    accessRuntime: runtime,
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

async function request(baseUrl, pathname, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json'
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.json === undefined ? options.body : JSON.stringify(options.json),
    signal: AbortSignal.timeout(3000)
  })
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null
  }
}

function cookieHeader(response, name) {
  const value = response.headers.get('set-cookie') || ''
  assert.match(value, new RegExp(`${name}=`))
  assert.match(value, /Path=\//)
  assert.match(value, /Secure/)
  assert.match(value, /HttpOnly/)
  assert.match(value, /SameSite=Strict/)
  assert.doesNotMatch(value, /Domain=/)
  return value
}

function proxyHeaders(extra = {}) {
  return {
    origin: ORIGIN,
    'x-real-ip': '198.51.100.25',
    'x-forwarded-for': '198.51.100.25',
    ...extra
  }
}

async function testDisabledCompatibility() {
  const runtime = createRuntime('disabled')
  const running = await start(runtime)
  try {
    const response = await request(running.baseUrl, '/api/watchlist')
    assert.equal(response.status, 200)
    assert.equal(response.body.success, true)
    const status = await request(running.baseUrl, '/api/auth/status')
    assert.equal(status.status, 200)
    assert.deepEqual(status.body, { authorized: true })
  } finally {
    await running.close()
  }
}

async function testInvestmentProtectionAndDeviceRefresh() {
  const runtime = createRuntime()
  const running = await start(runtime)
  try {
    for (const pathname of [
      '/api/watchlist',
      '/api/search?q=ali',
      '/api/company/9988.HK',
      '/api/company/9988.HK/refresh',
      '/api/research/9988.HK',
      '/api/deep-research/9988.HK'
    ]) {
      const response = await request(running.baseUrl, pathname, {
        method: pathname.includes('/refresh') ? 'POST' : 'GET',
        headers: pathname.includes('/refresh') ? proxyHeaders() : {}
      })
      assert.equal(response.status, 401, pathname)
      assert.deepEqual(response.body, { error: 'AUTH_REQUIRED' })
    }

    const adminOnly = await request(running.baseUrl, '/api/watchlist', {
      headers: { cookie: `__Host-kinvest-admin=${ADMIN_TOKEN}` }
    })
    assert.equal(adminOnly.status, 401)

    const authorized = await request(running.baseUrl, '/api/watchlist', {
      headers: { cookie: `__Host-kinvest-device=${DEVICE_TOKEN}` }
    })
    assert.equal(authorized.status, 200)
    cookieHeader(authorized, '__Host-kinvest-device')

    const rotated = await request(running.baseUrl, '/api/watchlist', {
      headers: { cookie: `__Host-kinvest-device=${ROTATED_DEVICE_TOKEN}` }
    })
    assert.equal(rotated.status, 200)
    assert.match(cookieHeader(rotated, '__Host-kinvest-device'), new RegExp(DEVICE_TOKEN))

    const duplicate = await request(running.baseUrl, '/api/watchlist', {
      headers: { cookie: `__Host-kinvest-device=${DEVICE_TOKEN}; __Host-kinvest-device=${DEVICE_TOKEN}` }
    })
    assert.equal(duplicate.status, 401)
    assert.match(cookieHeader(duplicate, '__Host-kinvest-device'), /Max-Age=0/)
  } finally {
    await running.close()
  }
}

async function testDeviceRequestFlowAndStrictInput() {
  const runtime = createRuntime()
  const running = await start(runtime)
  try {
    const created = await request(running.baseUrl, '/api/auth/device-requests', {
      method: 'POST',
      headers: proxyHeaders(),
      json: { deviceName: 'Family iPad' }
    })
    assert.equal(created.status, 201)
    assert.deepEqual(created.body, {
      requestId: REQUEST_ID,
      requestCode: '123456',
      expiresAt: NOW + 600000
    })
    const requestCookie = cookieHeader(created, '__Host-kinvest-request')
    assert.doesNotMatch(JSON.stringify(created.body), new RegExp(REQUEST_CREDENTIAL))
    assert.deepEqual(runtime.calls[0], [
      'createRequest',
      { deviceName: 'Family iPad', rateLimitIdentity: '198.51.100.25' }
    ])

    const cookiePair = requestCookie.split(';')[0]
    const status = await request(
      running.baseUrl,
      `/api/auth/device-requests/${REQUEST_ID}/status`,
      { headers: { cookie: cookiePair } }
    )
    assert.equal(status.status, 200)
    assert.equal(status.body.status, 'approved')
    assert.equal(Object.hasOwn(status.body, 'requestCode'), false)

    const terminalCookie = `__Host-kinvest-request=${TERMINAL_REQUEST_ID}.${REQUEST_CREDENTIAL}`
    const terminal = await request(
      running.baseUrl,
      `/api/auth/device-requests/${TERMINAL_REQUEST_ID}/status`,
      { headers: { cookie: terminalCookie } }
    )
    assert.equal(terminal.status, 200)
    assert.equal(terminal.body.status, 'expired')
    assert.match(cookieHeader(terminal, '__Host-kinvest-request'), /Max-Age=0/)

    const redeemed = await request(
      running.baseUrl,
      `/api/auth/device-requests/${REQUEST_ID}/redeem`,
      { method: 'POST', headers: proxyHeaders({ cookie: cookiePair }), json: {} }
    )
    assert.equal(redeemed.status, 200)
    const cookies = redeemed.headers.get('set-cookie') || ''
    assert.match(cookies, /__Host-kinvest-request=;/)
    assert.match(cookies, new RegExp(`__Host-kinvest-device=${DEVICE_TOKEN}`))

    const mismatchedProxy = await request(
      running.baseUrl,
      '/api/auth/device-requests',
      {
        method: 'POST',
        headers: proxyHeaders({ 'x-forwarded-for': '198.51.100.26' }),
        json: { deviceName: 'Nope' }
      }
    )
    assert.equal(mismatchedProxy.status, 400)
    assert.deepEqual(mismatchedProxy.body, { error: 'CLIENT_IDENTITY_INVALID' })

    const wrongOrigin = await request(running.baseUrl, '/api/auth/device-requests', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      json: { deviceName: 'Nope' }
    })
    assert.equal(wrongOrigin.status, 403)
    assert.deepEqual(wrongOrigin.body, { error: 'ORIGIN_INVALID' })

    const wrongType = await request(running.baseUrl, '/api/auth/device-requests', {
      method: 'POST', headers: proxyHeaders({ 'content-type': 'text/plain' }), body: '{}'
    })
    assert.equal(wrongType.status, 415)

    const oversized = await request(running.baseUrl, '/api/auth/device-requests', {
      method: 'POST', headers: proxyHeaders(), json: { deviceName: 'x'.repeat(5000) }
    })
    assert.equal(oversized.status, 413)
    assert.equal(oversized.headers.has('access-control-allow-origin'), false)
  } finally {
    await running.close()
  }
}

async function testAdminFlowAndCsrf() {
  const runtime = createRuntime()
  const running = await start(runtime)
  const adminCookie = `__Host-kinvest-admin=${ADMIN_TOKEN}`
  try {
    const anonymousMalformedApproval = await request(
      running.baseUrl,
      `/api/admin/device-requests/${REQUEST_ID}/approve`,
      {
        method: 'POST',
        headers: proxyHeaders({ 'content-type': 'application/json' }),
        body: '{'
      }
    )
    assert.equal(anonymousMalformedApproval.status, 401)
    assert.deepEqual(anonymousMalformedApproval.body, { error: 'ADMIN_AUTH_REQUIRED' })

    const anonymousInvalidApproval = await request(
      running.baseUrl,
      `/api/admin/device-requests/${REQUEST_ID}/approve`,
      { method: 'POST', headers: proxyHeaders(), json: {} }
    )
    assert.equal(anonymousInvalidApproval.status, 401)
    assert.deepEqual(anonymousInvalidApproval.body, { error: 'ADMIN_AUTH_REQUIRED' })

    const anonymousMalformedRevokeAll = await request(
      running.baseUrl,
      '/api/admin/devices/revoke-all',
      {
        method: 'POST',
        headers: proxyHeaders({ 'content-type': 'application/json' }),
        body: '{'
      }
    )
    assert.equal(anonymousMalformedRevokeAll.status, 401)
    assert.deepEqual(anonymousMalformedRevokeAll.body, { error: 'ADMIN_AUTH_REQUIRED' })

    const anonymousInvalidRevokeAll = await request(
      running.baseUrl,
      '/api/admin/devices/revoke-all',
      { method: 'POST', headers: proxyHeaders(), json: {} }
    )
    assert.equal(anonymousInvalidRevokeAll.status, 401)
    assert.deepEqual(anonymousInvalidRevokeAll.body, { error: 'ADMIN_AUTH_REQUIRED' })

    const anonymousInvalidRevoke = await request(
      running.baseUrl,
      '/api/admin/devices/credential-1/revoke',
      { method: 'POST', headers: proxyHeaders(), json: { unexpected: true } }
    )
    assert.equal(anonymousInvalidRevoke.status, 401)
    assert.deepEqual(anonymousInvalidRevoke.body, { error: 'ADMIN_AUTH_REQUIRED' })

    const crossOriginMalformedApproval = await request(
      running.baseUrl,
      `/api/admin/device-requests/${REQUEST_ID}/approve`,
      {
        method: 'POST',
        headers: proxyHeaders({
          origin: 'https://evil.example',
          'content-type': 'application/json'
        }),
        body: '{'
      }
    )
    assert.equal(crossOriginMalformedApproval.status, 403)
    assert.deepEqual(crossOriginMalformedApproval.body, { error: 'ORIGIN_INVALID' })

    for (const pathname of [
      '/api/admin/devices/revoke-all',
      '/api/admin/devices/credential-1/revoke'
    ]) {
      const crossOrigin = await request(running.baseUrl, pathname, {
        method: 'POST',
        headers: proxyHeaders({
          origin: 'https://evil.example',
          cookie: adminCookie,
          'x-kinvest-csrf': CSRF_TOKEN,
          'content-type': 'application/json'
        }),
        body: '{'
      })
      assert.equal(crossOrigin.status, 403)
      assert.deepEqual(crossOrigin.body, { error: 'ORIGIN_INVALID' })
    }

    const login = await request(running.baseUrl, '/api/admin/login', {
      method: 'POST', headers: proxyHeaders(), json: { password: 'correct-password' }
    })
    assert.equal(login.status, 200)
    assert.equal(login.body.csrfToken, CSRF_TOKEN)
    cookieHeader(login, '__Host-kinvest-admin')

    const refreshed = await request(running.baseUrl, '/api/admin/csrf', {
      method: 'POST', headers: proxyHeaders({ cookie: adminCookie }), json: {}
    })
    assert.equal(refreshed.status, 200)
    assert.equal(refreshed.body.csrfToken, NEW_CSRF_TOKEN)

    const pending = await request(running.baseUrl, '/api/admin/device-requests', {
      headers: { cookie: adminCookie }
    })
    assert.equal(pending.status, 200)
    assert.equal(pending.body.data[0].deviceName, 'Family iPad')
    cookieHeader(pending, '__Host-kinvest-admin')

    const missingCsrf = await request(
      running.baseUrl,
      `/api/admin/device-requests/${REQUEST_ID}/approve`,
      {
        method: 'POST',
        headers: proxyHeaders({
          cookie: adminCookie,
          'content-type': 'application/json'
        }),
        body: '{'
      }
    )
    assert.equal(missingCsrf.status, 403)
    assert.deepEqual(missingCsrf.body, { error: 'ADMIN_CSRF_INVALID' })

    for (const pathname of [
      '/api/admin/devices/revoke-all',
      '/api/admin/devices/credential-1/revoke'
    ]) {
      const missingMutationCsrf = await request(running.baseUrl, pathname, {
        method: 'POST',
        headers: proxyHeaders({
          cookie: adminCookie,
          'content-type': 'application/json'
        }),
        body: '{'
      })
      assert.equal(missingMutationCsrf.status, 403)
      assert.deepEqual(missingMutationCsrf.body, { error: 'ADMIN_CSRF_INVALID' })
    }

    for (const pathname of [
      `/api/admin/device-requests/${REQUEST_ID}/approve`,
      '/api/admin/devices/revoke-all',
      '/api/admin/devices/credential-1/revoke'
    ]) {
      const authenticatedMalformed = await request(running.baseUrl, pathname, {
        method: 'POST',
        headers: proxyHeaders({
          cookie: adminCookie,
          'x-kinvest-csrf': CSRF_TOKEN,
          'content-type': 'application/json'
        }),
        body: '{'
      })
      assert.equal(authenticatedMalformed.status, 400)
      assert.deepEqual(authenticatedMalformed.body, { error: 'JSON_INVALID' })
    }

    const approved = await request(
      running.baseUrl,
      `/api/admin/device-requests/${REQUEST_ID}/approve`,
      {
        method: 'POST',
        headers: proxyHeaders({ cookie: adminCookie, 'x-kinvest-csrf': CSRF_TOKEN }),
        json: { requestCode: '123456' }
      }
    )
    assert.equal(approved.status, 200)

    const devices = await request(running.baseUrl, '/api/admin/devices', {
      headers: { cookie: adminCookie }
    })
    assert.equal(devices.status, 200)

    const revoked = await request(running.baseUrl, '/api/admin/devices/credential-1/revoke', {
      method: 'POST',
      headers: proxyHeaders({ cookie: adminCookie, 'x-kinvest-csrf': CSRF_TOKEN }),
      json: {}
    })
    assert.equal(revoked.status, 200)

    const revokeAll = await request(running.baseUrl, '/api/admin/devices/revoke-all', {
      method: 'POST',
      headers: proxyHeaders({ cookie: adminCookie, 'x-kinvest-csrf': CSRF_TOKEN }),
      json: { password: 'correct-password' }
    })
    assert.equal(revokeAll.status, 200)

    const audit = await request(running.baseUrl, '/api/admin/audit', {
      headers: { cookie: adminCookie }
    })
    assert.equal(audit.status, 200)
    assert.deepEqual(Object.keys(audit.body.data).sort(), ['admin', 'device'])

    const logout = await request(running.baseUrl, '/api/admin/logout', {
      method: 'POST',
      headers: proxyHeaders({ cookie: adminCookie, 'x-kinvest-csrf': CSRF_TOKEN }),
      json: {}
    })
    assert.equal(logout.status, 200)
    assert.match(cookieHeader(logout, '__Host-kinvest-admin'), /Max-Age=0/)
  } finally {
    await running.close()
  }
}

async function run() {
  assert.throws(
    () => createRequestHandler({ accessRuntime: null }),
    /ACCESS_CONTROL_RUNTIME_REQUIRED/
  )
  await testDisabledCompatibility()
  await testInvestmentProtectionAndDeviceRefresh()
  await testDeviceRequestFlowAndStrictInput()
  await testAdminFlowAndCsrf()
}

module.exports = { run }
