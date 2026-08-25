const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const accessTokenSuccess = require('./fixtures/ifind/access-token-success.json')
const tradeDatesSuccess = require('./fixtures/ifind/trade-dates-success.json')
const providerErrors = require('./fixtures/ifind/provider-errors.json')

const REFRESH_TOKEN = 'fake-refresh-token-for-contract-tests'
const ACCESS_TOKEN = accessTokenSuccess.data.access_token
const ORIGIN = 'https://quantapi.51ifind.com'

function createRequestStub(responseBodies) {
  const pending = [...responseBodies]
  const calls = []

  function request(url, options, callback) {
    const call = {
      url: String(url),
      options,
      body: ''
    }
    calls.push(call)

    const outgoing = new EventEmitter()
    outgoing.write = (chunk) => {
      call.body += String(chunk)
    }
    outgoing.end = () => {
      const body = pending.shift()
      queueMicrotask(() => {
        const incoming = new EventEmitter()
        incoming.statusCode = 200
        callback(incoming)
        incoming.emit('data', Buffer.from(JSON.stringify(body)))
        incoming.emit('end')
      })
    }
    return outgoing
  }

  return { calls, request }
}

function assertNoProviderLeak(value, ...rawProviderMarkers) {
  const serialized = `${value instanceof Error ? value.message : ''}\n${JSON.stringify(value)}`
  for (const sentinel of [REFRESH_TOKEN, ACCESS_TOKEN, ...rawProviderMarkers]) {
    if (!sentinel) continue
    assert.equal(serialized.includes(sentinel), false)
  }
  assert.equal(serialized.includes('RequestId'), false)
}

async function run() {
  const { createIfindHttpClient } = require('../adapters/ifind-http-client')

  const successTransport = createRequestStub([
    accessTokenSuccess,
    tradeDatesSuccess
  ])
  const client = createIfindHttpClient({
    request: successTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z')
  })

  assert.deepEqual(Object.keys(client), ['diagnose'])
  const result = await client.diagnose({ refreshToken: REFRESH_TOKEN })

  assert.deepEqual(successTransport.calls, [
    {
      url: `${ORIGIN}/api/v1/get_access_token`,
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          refresh_token: REFRESH_TOKEN
        }
      },
      body: ''
    },
    {
      url: `${ORIGIN}/api/v1/get_trade_dates`,
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          access_token: ACCESS_TOKEN,
          ifindlang: 'cn'
        }
      },
      body: JSON.stringify({
        marketcode: '212001',
        functionpara: {
          dateType: '0',
          period: 'D',
          offset: '-10',
          dateFormat: '0',
          output: 'sequencedate'
        },
        startdate: '2026-08-26'
      })
    }
  ])
  assert.deepEqual(result, { ok: true, dataVol: 11 })
  assertNoProviderLeak(result)

  const authFailureTransport = createRequestStub([providerErrors.accessToken])
  const authFailureClient = createIfindHttpClient({
    request: authFailureTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z')
  })
  await assert.rejects(
    authFailureClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => {
      assert.equal(error.code, 'IFIND_AUTH_REJECTED')
      assert.equal(error.message, 'iFinD access-token request failed')
      assert.equal('cause' in error, false)
      assertNoProviderLeak(error, providerErrors.accessToken.errmsg)
      return true
    }
  )
  assert.equal(authFailureTransport.calls.length, 1)

  const probeFailureTransport = createRequestStub([
    accessTokenSuccess,
    providerErrors.tradeDates
  ])
  const probeFailureClient = createIfindHttpClient({
    request: probeFailureTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z')
  })
  await assert.rejects(
    probeFailureClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => {
      assert.equal(error.code, 'IFIND_PROBE_REJECTED')
      assert.equal(error.message, 'iFinD trade-date probe failed')
      assert.equal(error.dataVol, 3)
      assert.equal('cause' in error, false)
      assertNoProviderLeak(error, providerErrors.tradeDates.errmsg)
      return true
    }
  )
}

module.exports = { run }
