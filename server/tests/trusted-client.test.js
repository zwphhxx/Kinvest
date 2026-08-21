const assert = require('node:assert/strict')

const {
  TrustedClientError,
  resolveClientIdentity
} = require('../http/trusted-client')

function request(remoteAddress, headers = {}) {
  return { headers, socket: { remoteAddress } }
}

function expectRejected(req) {
  assert.throws(() => resolveClientIdentity(req), (error) => {
    assert.ok(error instanceof TrustedClientError)
    assert.equal(error.code, 'CLIENT_IDENTITY_INVALID')
    return true
  })
}

function run() {
  const trusted = { trustedProxyAddresses: ['127.0.0.1', '172.31.252.3'] }
  assert.equal(resolveClientIdentity(request('203.0.113.9'), trusted), '203.0.113.9')
  assert.equal(resolveClientIdentity(request('::ffff:192.0.2.8'), trusted), '192.0.2.8')

  assert.equal(resolveClientIdentity(request('172.31.252.3', {
    'x-real-ip': '::ffff:198.51.100.7',
    'x-forwarded-for': '::ffff:198.51.100.7'
  }), trusted), '198.51.100.7')

  assert.equal(resolveClientIdentity(request('172.31.252.4', {
    'x-real-ip': '198.51.100.9',
    'x-forwarded-for': '198.51.100.9'
  }), trusted), '172.31.252.4')

  assert.throws(
    () => resolveClientIdentity(request('172.31.252.3'), trusted),
    /CLIENT_IDENTITY_INVALID/
  )

  assert.throws(() => resolveClientIdentity(request('172.31.252.3', {
    'x-real-ip': '198.51.100.9',
    'x-forwarded-for': '198.51.100.10'
  }), trusted), /CLIENT_IDENTITY_INVALID/)
  assert.throws(() => resolveClientIdentity(request('127.0.0.1', {
    'x-real-ip': '198.51.100.9',
    'x-forwarded-for': '198.51.100.9, 203.0.113.5'
  }), trusted), /CLIENT_IDENTITY_INVALID/)
  assert.throws(() => resolveClientIdentity(request('127.0.0.1', {
    'x-real-ip': '198.51.100.9'
  }), trusted), /CLIENT_IDENTITY_INVALID/)
  assert.throws(() => resolveClientIdentity(request('127.0.0.1', {
    'x-real-ip': ['198.51.100.9'],
    'x-forwarded-for': '198.51.100.9'
  }), trusted), /CLIENT_IDENTITY_INVALID/)
  expectRejected(request('not-an-ip'))
}

module.exports = { run }
