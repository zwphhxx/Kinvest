const net = require('node:net')

class TrustedClientError extends Error {
  constructor(code = 'CLIENT_IDENTITY_INVALID') {
    super(code)
    this.name = 'TrustedClientError'
    this.code = code
  }
}

function fail() {
  throw new TrustedClientError()
}

function canonicalIp(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 ||
    value !== value.trim() || value.includes(',')) fail()
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (mapped && net.isIP(mapped[1]) === 4) return mapped[1]
  const version = net.isIP(value)
  if (version === 4) return value
  if (version !== 6) fail()
  try {
    const hostname = new URL(`http://[${value}]/`).hostname
    if (!hostname.startsWith('[') || !hostname.endsWith(']')) fail()
    return hostname.slice(1, -1).toLowerCase()
  } catch {
    fail()
  }
}

function normalizeTrustedProxyAddresses(values) {
  if (!Array.isArray(values) || values.length > 16) fail()
  const normalized = values.map(canonicalIp)
  if (new Set(normalized).size !== normalized.length) fail()
  return new Set(normalized)
}

function parseTrustedProxyAddresses(serialized, { required = false } = {}) {
  if (serialized === undefined) {
    if (required) fail()
    return []
  }
  if (typeof serialized !== 'string' || serialized.length > 1024) fail()
  let parsed
  try {
    parsed = JSON.parse(serialized)
  } catch {
    fail()
  }
  const normalized = [...normalizeTrustedProxyAddresses(parsed)]
  if (required && normalized.length === 0) fail()
  if (JSON.stringify(normalized) !== serialized) fail()
  return normalized
}

function singleHeader(headers, name) {
  const value = headers && headers[name]
  if (typeof value !== 'string') fail()
  return canonicalIp(value)
}

function resolveClientIdentity(req, { trustedProxyAddresses = [] } = {}) {
  const directAddress = canonicalIp(req && req.socket && req.socket.remoteAddress)
  const trusted = normalizeTrustedProxyAddresses(trustedProxyAddresses)
  if (!trusted.has(directAddress)) return directAddress

  const hasReal = req.headers &&
    Object.prototype.hasOwnProperty.call(req.headers, 'x-real-ip')
  const hasForwarded = req.headers &&
    Object.prototype.hasOwnProperty.call(req.headers, 'x-forwarded-for')
  if (!hasReal && !hasForwarded) fail()
  if (!hasReal || !hasForwarded) fail()
  const real = singleHeader(req.headers, 'x-real-ip')
  const forwarded = singleHeader(req.headers, 'x-forwarded-for')
  if (real !== forwarded) fail()
  return real
}

module.exports = {
  TrustedClientError,
  canonicalIp,
  parseTrustedProxyAddresses,
  resolveClientIdentity
}
