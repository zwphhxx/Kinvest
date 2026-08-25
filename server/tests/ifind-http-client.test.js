const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { inspect } = require('node:util')

const accessTokenSuccess = require('./fixtures/ifind/access-token-success.json')
const tradeDatesSuccess = require('./fixtures/ifind/trade-dates-success.json')
const providerErrors = require('./fixtures/ifind/provider-errors.json')

const REFRESH_TOKEN = 'fake-refresh-token-for-contract-tests'
const ACCESS_TOKEN = accessTokenSuccess.data.access_token
const SYNTHETIC_REQUEST_ID = 'synthetic-request-id-for-contract-tests'
const ORIGIN = 'https://quantapi.51ifind.com'

function normalizeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name.toLowerCase(),
    value
  ]))
}

function createCapturingLogger() {
  const entries = []
  const logger = {}
  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level] = (...args) => entries.push({ level, args })
  }
  return { entries, logger }
}

function createRequestStub(responseBodies) {
  const pending = [...responseBodies]
  const calls = []

  function request(url, options, callback) {
    let rawBody = ''
    const call = {
      url: String(url),
      method: options.method,
      headers: normalizeHeaders(options.headers),
      body: null
    }
    calls.push(call)

    const outgoing = new EventEmitter()
    outgoing.write = (chunk) => {
      rawBody += String(chunk)
    }
    outgoing.end = () => {
      call.body = rawBody ? JSON.parse(rawBody) : null
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

function assertNoProviderLeak({ scenario, value, logEntries, rawProviderMarkers = [] }) {
  const serialized = `${value instanceof Error ? value.message : ''}\n${inspect(value, { depth: 10 })}`
  const serializedLogs = inspect(logEntries, { depth: 10 })
  const markers = [
    ['refresh token', REFRESH_TOKEN],
    ['access token', ACCESS_TOKEN],
    ['synthetic request-id value', SYNTHETIC_REQUEST_ID],
    ...rawProviderMarkers.map((marker) => ['raw provider error marker', marker])
  ]

  for (const [category, marker] of markers) {
    if (!marker) continue
    assert.equal(
      serialized.includes(marker),
      false,
      `${scenario}: returned result or error leaked ${category}`
    )
    assert.equal(
      serializedLogs.includes(marker),
      false,
      `${scenario}: captured logs leaked ${category}`
    )
  }
  assert.equal(
    serialized.includes('RequestId'),
    false,
    `${scenario}: returned result or error leaked RequestId label`
  )
  assert.equal(
    serializedLogs.includes('RequestId'),
    false,
    `${scenario}: captured logs leaked RequestId label`
  )
}

async function run() {
  const { createIfindHttpClient } = require('../adapters/ifind-http-client')

  const successTransport = createRequestStub([
    accessTokenSuccess,
    tradeDatesSuccess
  ])
  const successLogger = createCapturingLogger()
  const client = createIfindHttpClient({
    request: successTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z'),
    logger: successLogger.logger
  })

  assert.deepEqual(Object.keys(client), ['diagnose'])
  const result = await client.diagnose({ refreshToken: REFRESH_TOKEN })

  assert.deepEqual(successTransport.calls, [
    {
      url: `${ORIGIN}/api/v1/get_access_token`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        refresh_token: REFRESH_TOKEN
      },
      body: null
    },
    {
      url: `${ORIGIN}/api/v1/get_trade_dates`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        access_token: ACCESS_TOKEN,
        ifindlang: 'cn'
      },
      body: {
        marketcode: '212001',
        functionpara: {
          dateType: '0',
          period: 'D',
          offset: '-10',
          dateFormat: '0',
          output: 'sequencedate'
        },
        startdate: '2026-08-26'
      }
    }
  ])
  assert.deepEqual(result, { ok: true, dataVol: 11 })
  assertNoProviderLeak({
    scenario: 'successful diagnostic',
    value: result,
    logEntries: successLogger.entries
  })

  const authFailureTransport = createRequestStub([providerErrors.accessToken])
  const authFailureLogger = createCapturingLogger()
  const authFailureClient = createIfindHttpClient({
    request: authFailureTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z'),
    logger: authFailureLogger.logger
  })
  await assert.rejects(
    authFailureClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => {
      assert.equal(error.code, 'IFIND_AUTH_REJECTED')
      assert.equal(error.message, 'iFinD access-token request failed')
      assert.equal('cause' in error, false)
      assertNoProviderLeak({
        scenario: 'access-token rejection',
        value: error,
        logEntries: authFailureLogger.entries,
        rawProviderMarkers: [providerErrors.accessToken.errmsg]
      })
      return true
    }
  )
  assert.equal(authFailureTransport.calls.length, 1)

  const probeFailureTransport = createRequestStub([
    accessTokenSuccess,
    providerErrors.tradeDates
  ])
  const probeFailureLogger = createCapturingLogger()
  const probeFailureClient = createIfindHttpClient({
    request: probeFailureTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z'),
    logger: probeFailureLogger.logger
  })
  await assert.rejects(
    probeFailureClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => {
      assert.equal(error.code, 'IFIND_PROBE_REJECTED')
      assert.equal(error.message, 'iFinD trade-date probe failed')
      assert.equal(error.dataVol, 3)
      assert.equal('cause' in error, false)
      assertNoProviderLeak({
        scenario: 'trade-date rejection',
        value: error,
        logEntries: probeFailureLogger.entries,
        rawProviderMarkers: [providerErrors.tradeDates.errmsg]
      })
      return true
    }
  )
}

module.exports = { run }
