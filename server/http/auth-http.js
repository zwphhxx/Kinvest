const crypto = require('node:crypto')

const { resolveClientIdentity } = require('./trusted-client')

const JSON_BODY_LIMIT = 4096
const COOKIE_HEADER_LIMIT = 4096
const REQUEST_COOKIE = '__Host-kinvest-request'
const DEVICE_COOKIE = '__Host-kinvest-device'
const ADMIN_COOKIE = '__Host-kinvest-admin'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/
const TERMINAL_REQUEST_STATES = new Set(['expired', 'locked', 'consumed'])

class HttpBoundaryError extends Error {
  constructor(code, status) {
    super(code)
    this.name = 'HttpBoundaryError'
    this.code = code
    this.status = status
  }
}

function boundaryError(code, status) {
  throw new HttpBoundaryError(code, status)
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(body))
}

function appendCookie(res, value) {
  const existing = res.getHeader('Set-Cookie')
  const values = existing === undefined
    ? []
    : Array.isArray(existing) ? existing : [existing]
  res.setHeader('Set-Cookie', [...values, value])
}

function setHostCookie(res, name, value, maxAge) {
  if (typeof value !== 'string' || value.length > 128 ||
    /[^A-Za-z0-9_.-]/.test(value)) {
    boundaryError('INTERNAL_ERROR', 500)
  }
  const seconds = Math.max(1, Math.floor(maxAge / 1000))
  appendCookie(
    res,
    `${name}=${value}; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Strict`
  )
}

function clearHostCookie(res, name) {
  appendCookie(
    res,
    `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Strict`
  )
}

function parseCookies(req) {
  const header = req.headers.cookie
  if (header === undefined) return new Map()
  if (typeof header !== 'string' ||
    Buffer.byteLength(header, 'utf8') > COOKIE_HEADER_LIMIT) {
    boundaryError('COOKIE_INVALID', 400)
  }
  const cookies = new Map()
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const separator = trimmed.indexOf('=')
    if (separator < 1) boundaryError('COOKIE_INVALID', 400)
    const name = trimmed.slice(0, separator)
    const value = trimmed.slice(separator + 1)
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      value.length > 256 || cookies.has(name)) {
      boundaryError('COOKIE_INVALID', 400)
    }
    cookies.set(name, value)
  }
  return cookies
}

function tokenCookie(req, name) {
  const value = parseCookies(req).get(name)
  if (value === undefined) return null
  if (!TOKEN_PATTERN.test(value)) boundaryError('COOKIE_INVALID', 400)
  return value
}

function constantEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function requestCookie(req, expectedRequestId) {
  const value = parseCookies(req).get(REQUEST_COOKIE)
  if (typeof value !== 'string') boundaryError('REQUEST_AUTH_REQUIRED', 401)
  const match = value.match(/^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/)
  if (!match || !constantEqual(match[1], expectedRequestId)) {
    boundaryError('REQUEST_AUTH_REQUIRED', 401)
  }
  return { requestId: match[1], browserCredential: match[2] }
}

function exactObject(value, allowed, required = allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    boundaryError('JSON_INVALID', 400)
  }
  const keys = Object.keys(value)
  if (keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    boundaryError('JSON_INVALID', 400)
  }
  return value
}

function readJson(req) {
  const type = req.headers['content-type']
  if (typeof type !== 'string' ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) {
    boundaryError('JSON_REQUIRED', 415)
  }
  const declared = req.headers['content-length']
  if (declared !== undefined &&
    (!/^\d+$/.test(declared) || Number(declared) > JSON_BODY_LIMIT)) {
    boundaryError('BODY_TOO_LARGE', 413)
  }
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= JSON_BODY_LIMIT) chunks.push(chunk)
    })
    req.once('error', () =>
      reject(new HttpBoundaryError('JSON_INVALID', 400)))
    req.once('end', () => {
      if (size > JSON_BODY_LIMIT) {
        reject(new HttpBoundaryError('BODY_TOO_LARGE', 413))
        return
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        const parsed = raw.length === 0 ? {} : JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          boundaryError('JSON_INVALID', 400)
        }
        resolve(parsed)
      } catch (error) {
        reject(error instanceof HttpBoundaryError
          ? error
          : new HttpBoundaryError('JSON_INVALID', 400))
      }
    })
  })
}

function requireOrigin(req, expectedOrigin) {
  if (req.headers.origin !== expectedOrigin) boundaryError('ORIGIN_INVALID', 403)
}

function maxAgeUntil(now, ...expiresAt) {
  const valid = expiresAt.filter(Number.isSafeInteger)
  if (valid.length === 0) boundaryError('INTERNAL_ERROR', 500)
  return Math.max(1000, Math.min(...valid) - now)
}

function safeError(error) {
  if (error instanceof HttpBoundaryError) return error
  const code = error && typeof error === 'object' &&
    typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR'
  const mapping = {
    ADMIN_AUTH_INVALID: [401, 'ADMIN_AUTH_INVALID'],
    ADMIN_AUTH_RATE_LIMITED: [429, 'ADMIN_AUTH_RATE_LIMITED'],
    ADMIN_CSRF_INVALID: [403, 'ADMIN_CSRF_INVALID'],
    ADMIN_SESSION_EXPIRED: [401, 'ADMIN_AUTH_REQUIRED'],
    ADMIN_SESSION_INVALID: [401, 'ADMIN_AUTH_REQUIRED'],
    CLIENT_IDENTITY_INVALID: [400, 'CLIENT_IDENTITY_INVALID'],
    DEVICE_NAME_INVALID: [400, 'DEVICE_NAME_INVALID'],
    IP_DIGEST_INVALID: [400, 'CLIENT_IDENTITY_INVALID'],
    REQUEST_ACTIVE_LIMIT: [409, 'REQUEST_ACTIVE_LIMIT'],
    REQUEST_RATE_LIMITED: [429, 'REQUEST_RATE_LIMITED'],
    REQUEST_BROWSER_MISMATCH: [401, 'REQUEST_AUTH_REQUIRED'],
    REQUEST_NOT_FOUND: [404, 'REQUEST_NOT_FOUND'],
    REQUEST_NOT_APPROVED: [409, 'REQUEST_NOT_APPROVED'],
    REQUEST_ALREADY_USED: [409, 'REQUEST_ALREADY_USED'],
    REQUEST_EXPIRED: [410, 'REQUEST_EXPIRED'],
    REQUEST_LOCKED: [423, 'REQUEST_LOCKED'],
    REQUEST_CODE_INVALID: [400, 'REQUEST_CODE_INVALID']
  }
  const resolved = mapping[code] || [500, 'INTERNAL_ERROR']
  return new HttpBoundaryError(resolved[1], resolved[0])
}

function createAuthHttpController({
  accessRuntime,
  now = Date.now,
  publicOrigin = 'https://dearmina.cn',
  trustedProxyAddresses = []
}) {
  const enabled = accessRuntime.status.mode === 'device-approval'
  const device = accessRuntime.deviceApproval
  const admin = accessRuntime.adminAuth

  function requireEnabled() {
    if (!enabled || !device || !admin) {
      boundaryError('ACCESS_CONTROL_DISABLED', 503)
    }
  }

  function clientIdentity(req) {
    return resolveClientIdentity(req, { trustedProxyAddresses })
  }

  function refreshDeviceCookie(res, rawToken, authenticated) {
    const token = authenticated.rotated && authenticated.token
      ? authenticated.token
      : rawToken
    setHostCookie(
      res,
      DEVICE_COOKIE,
      token,
      maxAgeUntil(now(), authenticated.idleExpiresAt, authenticated.absoluteExpiresAt)
    )
  }

  function authenticateDevice(req, res) {
    if (!enabled) return true
    try {
      const token = tokenCookie(req, DEVICE_COOKIE)
      if (!token) return false
      const authenticated = device.authenticate(token)
      refreshDeviceCookie(res, token, authenticated)
      return true
    } catch {
      clearHostCookie(res, DEVICE_COOKIE)
      return false
    }
  }

  function rawAdminToken(req) {
    const token = tokenCookie(req, ADMIN_COOKIE)
    if (!token) boundaryError('ADMIN_AUTH_REQUIRED', 401)
    return token
  }

  function refreshAdminCookie(res, token, authenticated) {
    setHostCookie(
      res,
      ADMIN_COOKIE,
      token,
      maxAgeUntil(now(), authenticated.idleExpiresAt, authenticated.absoluteExpiresAt)
    )
  }

  function authenticateAdmin(req, res) {
    const token = rawAdminToken(req)
    const authenticated = admin.authenticate(token)
    refreshAdminCookie(res, token, authenticated)
    return token
  }

  function csrfHeader(req) {
    const value = req.headers['x-kinvest-csrf']
    if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
      boundaryError('ADMIN_CSRF_INVALID', 403)
    }
    return value
  }

  function authenticateMutation(req, res) {
    const token = rawAdminToken(req)
    admin.verifyCsrf(token, csrfHeader(req))
    refreshAdminCookie(res, token, admin.authenticate(token))
    return token
  }

  async function jsonMutation(req) {
    requireOrigin(req, publicOrigin)
    return readJson(req)
  }

  async function route(req, res, segments) {
    if (segments[1] === 'auth' && segments[2] === 'status' &&
      segments.length === 3 && req.method === 'GET') {
      sendJson(res, { authorized: authenticateDevice(req, res) })
      return true
    }

    if (segments[1] === 'auth' && segments[2] === 'device-requests' &&
      segments.length === 3 && req.method === 'POST') {
      requireEnabled()
      const body = exactObject(await jsonMutation(req), ['deviceName'])
      const created = device.createRequest({
        deviceName: body.deviceName,
        rateLimitIdentity: clientIdentity(req)
      })
      setHostCookie(
        res,
        REQUEST_COOKIE,
        `${created.requestId}.${created.browserCredential}`,
        maxAgeUntil(now(), created.expiresAt)
      )
      sendJson(res, {
        requestId: created.requestId,
        requestCode: created.requestCode,
        expiresAt: created.expiresAt
      }, 201)
      return true
    }

    if (segments[1] === 'auth' && segments[2] === 'device-requests' &&
      REQUEST_ID_PATTERN.test(segments[3] || '') && segments[4] === 'status' &&
      segments.length === 5 && req.method === 'GET') {
      requireEnabled()
      const binding = requestCookie(req, segments[3])
      const status = device.getRequestStatus(binding)
      if (TERMINAL_REQUEST_STATES.has(status.status)) {
        clearHostCookie(res, REQUEST_COOKIE)
      }
      sendJson(res, status)
      return true
    }

    if (segments[1] === 'auth' && segments[2] === 'device-requests' &&
      REQUEST_ID_PATTERN.test(segments[3] || '') && segments[4] === 'redeem' &&
      segments.length === 5 && req.method === 'POST') {
      requireEnabled()
      exactObject(await jsonMutation(req), [], [])
      const binding = requestCookie(req, segments[3])
      const issued = device.redeemRequest(binding)
      clearHostCookie(res, REQUEST_COOKIE)
      setHostCookie(
        res,
        DEVICE_COOKIE,
        issued.token,
        maxAgeUntil(now(), issued.idleExpiresAt, issued.absoluteExpiresAt)
      )
      sendJson(res, { authorized: true })
      return true
    }

    if (segments[1] === 'admin' && segments[2] === 'login' &&
      segments.length === 3 && req.method === 'POST') {
      requireEnabled()
      const body = exactObject(await jsonMutation(req), ['password'])
      const loggedIn = await admin.login(body.password, clientIdentity(req))
      refreshAdminCookie(res, loggedIn.sessionToken, loggedIn)
      sendJson(res, {
        csrfToken: loggedIn.csrfToken,
        idleExpiresAt: loggedIn.idleExpiresAt,
        absoluteExpiresAt: loggedIn.absoluteExpiresAt
      })
      return true
    }

    if (segments[1] === 'admin' && segments[2] === 'csrf' &&
      segments.length === 3 && req.method === 'POST') {
      requireEnabled()
      exactObject(await jsonMutation(req), [], [])
      const token = rawAdminToken(req)
      const refreshed = admin.refreshCsrf(token)
      refreshAdminCookie(res, token, refreshed)
      sendJson(res, { csrfToken: refreshed.csrfToken })
      return true
    }

    if (segments[1] === 'admin' && segments[2] === 'logout' &&
      segments.length === 3 && req.method === 'POST') {
      requireEnabled()
      exactObject(await jsonMutation(req), [], [])
      const token = rawAdminToken(req)
      const result = admin.logout(token, csrfHeader(req))
      clearHostCookie(res, ADMIN_COOKIE)
      sendJson(res, result)
      return true
    }

    if (segments[1] === 'admin' && segments[2] === 'device-requests' &&
      segments.length === 3 && req.method === 'GET') {
      requireEnabled()
      authenticateAdmin(req, res)
      sendJson(res, { data: device.listPendingRequests() })
      return true
    }

    if (segments[1] === 'admin' && segments[2] === 'device-requests' &&
      REQUEST_ID_PATTERN.test(segments[3] || '') && segments[4] === 'approve' &&
      segments.length === 5 && req.method === 'POST') {
      requireEnabled()
      const body = exactObject(await jsonMutation(req), ['requestCode'])
      authenticateMutation(req, res)
      sendJson(res, device.approveRequest({
        requestId: segments[3],
        requestCode: body.requestCode,
        adminAuthenticated: true
      }))
      return true
    }

    if (segments[1] === 'admin' && segments[2] === 'devices' &&
      segments.length === 3 && req.method === 'GET') {
      requireEnabled()
      authenticateAdmin(req, res)
      sendJson(res, { data: device.listDevices() })
      return true
    }

    if (segments[1] === 'admin' && segments[2] === 'devices' &&
      segments[3] === 'revoke-all' && segments.length === 4 &&
      req.method === 'POST') {
      requireEnabled()
      const body = exactObject(await jsonMutation(req), ['password'])
      authenticateMutation(req, res)
      await admin.reauthenticate(body.password, clientIdentity(req))
      sendJson(res, { credentialsRevoked: device.revokeAllCredentials() })
      return true
    }

    if (segments[1] === 'admin' && segments[2] === 'devices' &&
      segments[3] && segments[4] === 'revoke' && segments.length === 5 &&
      req.method === 'POST') {
      requireEnabled()
      exactObject(await jsonMutation(req), [], [])
      authenticateMutation(req, res)
      sendJson(res, device.revokeCredential(segments[3]))
      return true
    }

    if (segments[1] === 'admin' && segments[2] === 'audit' &&
      segments.length === 3 && req.method === 'GET') {
      requireEnabled()
      authenticateAdmin(req, res)
      sendJson(res, {
        data: {
          admin: admin.listAuditEvents(),
          device: device.listAuditEvents()
        }
      })
      return true
    }

    if (segments[1] === 'auth' || segments[1] === 'admin') {
      sendJson(res, { error: 'NOT_FOUND' }, 404)
      return true
    }
    return false
  }

  return Object.freeze({
    async handle(req, res, segments) {
      try {
        return await route(req, res, segments)
      } catch (error) {
        const safe = safeError(error)
        if (safe.code === 'COOKIE_INVALID') {
          clearHostCookie(res, REQUEST_COOKIE)
          clearHostCookie(res, DEVICE_COOKIE)
          clearHostCookie(res, ADMIN_COOKIE)
        } else if (safe.code === 'REQUEST_AUTH_REQUIRED') {
          clearHostCookie(res, REQUEST_COOKIE)
        } else if (safe.code === 'ADMIN_AUTH_REQUIRED') {
          clearHostCookie(res, ADMIN_COOKIE)
        }
        sendJson(res, { error: safe.code }, safe.status)
        return true
      }
    },
    authorizeInvestment(req, res) {
      if (authenticateDevice(req, res)) return true
      sendJson(res, { error: 'AUTH_REQUIRED' }, 401)
      return false
    }
  })
}

module.exports = {
  HttpBoundaryError,
  createAuthHttpController
}
