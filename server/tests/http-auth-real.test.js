const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const { createRequestHandler } = require('../server')
const { AdminAuthRepository } = require('../db/admin-auth-repository')
const { DeviceAuthRepository } = require('../db/device-auth-repository')
const { AdminAuthService } = require('../security/admin-auth')
const { DeviceApprovalService } = require('../security/device-approval')
const {
  generateAdminPasswordVerifier
} = require('../security/secret-bootstrap-contract')

const ORIGIN = 'https://dearmina.cn'
const PASSWORD = 'Family-Admin-Password-2026'
const VERSION = 'v20260821-001'
const SECRET_NAME = 'kinvest-prod-device-token-hmac-key'

async function startServer(runtime) {
  const server = http.createServer(createRequestHandler({
    accessRuntime: runtime,
    publicOrigin: ORIGIN,
    trustedProxyAddresses: ['127.0.0.1']
  }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

async function request(baseUrl, pathname, {
  method = 'GET',
  cookie,
  csrf,
  body,
  proxy = false
} = {}) {
  const headers = {}
  if (body !== undefined) {
    headers.origin = ORIGIN
    headers['content-type'] = 'application/json'
  }
  if (cookie) headers.cookie = cookie
  if (csrf) headers['x-kinvest-csrf'] = csrf
  if (proxy) {
    headers['x-real-ip'] = '198.51.100.91'
    headers['x-forwarded-for'] = '198.51.100.91'
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000)
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    setCookie: response.headers.get('set-cookie') || ''
  }
}

function cookieValue(setCookie, name) {
  const match = setCookie.match(new RegExp(`${name}=([A-Za-z0-9_-]{43})`))
  assert.ok(match, `missing ${name}`)
  return match[1]
}

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-real-http-'))
  const database = new DatabaseSync(path.join(directory, 'auth.sqlite'))
  const adminRepository = new AdminAuthRepository(database)
  const deviceRepository = new DeviceAuthRepository(database)
  adminRepository.initialize()
  deviceRepository.initialize()
  const adminAuth = new AdminAuthService({
    repository: adminRepository,
    adminVerifierMaterial: await generateAdminPasswordVerifier(PASSWORD),
    rateLimitKey: Buffer.alloc(32, 31)
  })
  const deviceApproval = new DeviceApprovalService({
    repository: deviceRepository,
    secretProvider: {
      readSecret() {
        return Buffer.alloc(32, 32)
      }
    },
    hmacSecretName: SECRET_NAME,
    activeHmacVersionId: VERSION,
    requestIpDigestKey: Buffer.alloc(32, 33),
    requestCodeDigestKey: Buffer.alloc(32, 34),
    requireRequestRateLimitIdentity: true
  })
  const runtime = {
    status: { mode: 'device-approval' },
    adminAuth,
    deviceApproval
  }
  const running = await startServer(runtime)

  try {
    const created = await request(running.baseUrl, '/api/auth/device-requests', {
      method: 'POST',
      body: { deviceName: 'Family Browser' },
      proxy: true
    })
    assert.equal(created.status, 201)
    assert.match(created.body.requestCode, /^\d{6}$/)
    const requestCookieMatch = created.setCookie.match(
      /__Host-kinvest-request=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})/
    )
    assert.ok(requestCookieMatch)
    assert.equal(
      JSON.stringify(created.body).split(created.body.requestCode).length - 1,
      1
    )
    const requestCookie =
      `__Host-kinvest-request=${requestCookieMatch[1]}.${requestCookieMatch[2]}`

    const login = await request(running.baseUrl, '/api/admin/login', {
      method: 'POST',
      body: { password: PASSWORD },
      proxy: true
    })
    assert.equal(login.status, 200)
    const adminToken = cookieValue(login.setCookie, '__Host-kinvest-admin')
    const adminCookie = `__Host-kinvest-admin=${adminToken}`
    const oldCsrf = login.body.csrfToken

    const refreshed = await request(running.baseUrl, '/api/admin/csrf', {
      method: 'POST',
      cookie: adminCookie,
      body: {}
    })
    assert.equal(refreshed.status, 200)
    assert.notEqual(refreshed.body.csrfToken, oldCsrf)

    const staleApproval = await request(
      running.baseUrl,
      `/api/admin/device-requests/${created.body.requestId}/approve`,
      {
        method: 'POST',
        cookie: adminCookie,
        csrf: oldCsrf,
        body: { requestCode: created.body.requestCode }
      }
    )
    assert.equal(staleApproval.status, 403)
    assert.deepEqual(staleApproval.body, { error: 'ADMIN_CSRF_INVALID' })

    const approved = await request(
      running.baseUrl,
      `/api/admin/device-requests/${created.body.requestId}/approve`,
      {
        method: 'POST',
        cookie: adminCookie,
        csrf: refreshed.body.csrfToken,
        body: { requestCode: created.body.requestCode }
      }
    )
    assert.equal(approved.status, 200)

    const redeemed = await request(
      running.baseUrl,
      `/api/auth/device-requests/${created.body.requestId}/redeem`,
      {
        method: 'POST',
        cookie: requestCookie,
        body: {}
      }
    )
    assert.equal(redeemed.status, 200)
    const deviceToken = cookieValue(redeemed.setCookie, '__Host-kinvest-device')
    assert.match(deviceToken, /^[A-Za-z0-9_-]{43}$/)
    const deviceCookie = `__Host-kinvest-device=${deviceToken}`

    const beforeRevoke = await request(running.baseUrl, '/api/watchlist', {
      cookie: deviceCookie
    })
    assert.equal(beforeRevoke.status, 200)

    const devices = await request(running.baseUrl, '/api/admin/devices', {
      cookie: adminCookie
    })
    assert.equal(devices.status, 200)
    assert.equal(devices.body.data.length, 1)
    const revoked = await request(
      running.baseUrl,
      `/api/admin/devices/${devices.body.data[0].credentialId}/revoke`,
      {
        method: 'POST',
        cookie: adminCookie,
        csrf: refreshed.body.csrfToken,
        body: {}
      }
    )
    assert.equal(revoked.status, 200)

    const afterRevoke = await request(running.baseUrl, '/api/watchlist', {
      cookie: deviceCookie
    })
    assert.equal(afterRevoke.status, 401)
    assert.deepEqual(afterRevoke.body, { error: 'AUTH_REQUIRED' })
  } finally {
    await running.close()
    adminAuth.clear()
    deviceApproval.clear()
    database.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

module.exports = { run }
