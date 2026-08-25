const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const accessTokenSuccess = require('./fixtures/ifind/access-token-success.json')
const tradeDatesSuccess = require('./fixtures/ifind/trade-dates-success.json')
const providerErrors = require('./fixtures/ifind/provider-errors.json')

const REFRESH_TOKEN = 'fake-refresh-token-for-contract-tests'
const ACCESS_TOKEN = accessTokenSuccess.data.access_token
const SYNTHETIC_REQUEST_ID = 'synthetic-request-id-for-contract-tests'
const ORIGIN = 'https://quantapi.51ifind.com'
const AUTH_PROVIDER_MARKER = 'Synthetic authentication rejection'
const PROBE_PROVIDER_MARKER = 'Synthetic probe rejection'

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

async function captureGlobalOutput(action) {
  const entries = []
  const consoleMethods = ['debug', 'info', 'log', 'warn', 'error']
  const originalConsoleMethods = Object.fromEntries(
    consoleMethods.map((method) => [method, console[method]])
  )
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write

  for (const method of consoleMethods) {
    console[method] = (...args) => entries.push({ channel: `console.${method}`, args })
  }

  function captureWrite(channel) {
    return function write(chunk, encoding, callback) {
      entries.push({
        channel,
        chunk: Buffer.isBuffer(chunk) ? Buffer.from(chunk) : String(chunk)
      })
      const done = typeof encoding === 'function' ? encoding : callback
      if (typeof done === 'function') queueMicrotask(done)
      return true
    }
  }

  process.stdout.write = captureWrite('process.stdout')
  process.stderr.write = captureWrite('process.stderr')

  try {
    return {
      status: 'fulfilled',
      value: await action(),
      entries
    }
  } catch (reason) {
    return {
      status: 'rejected',
      reason,
      entries
    }
  } finally {
    for (const method of consoleMethods) {
      console[method] = originalConsoleMethods[method]
    }
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
  }
}

function containsSentinel(root, sentinel) {
  if (!sentinel) return false

  const seen = new Set()
  const pending = [root]
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value === 'string') {
      if (value.includes(sentinel)) return true
      continue
    }
    if (typeof value === 'symbol') {
      if (String(value).includes(sentinel)) return true
      continue
    }
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
      continue
    }
    if (Buffer.isBuffer(value)) {
      if (value.toString('utf8').includes(sentinel)) return true
      continue
    }
    if (seen.has(value)) continue
    seen.add(value)

    let descriptors
    try {
      descriptors = Object.getOwnPropertyDescriptors(value)
    } catch {
      continue
    }
    for (const key of Reflect.ownKeys(descriptors)) {
      pending.push(key)
      const descriptor = descriptors[key]
      if (Object.hasOwn(descriptor, 'value')) pending.push(descriptor.value)
    }
  }
  return false
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
    outgoing.end = (chunk) => {
      if (chunk !== undefined) outgoing.write(chunk)
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

function assertNoProviderLeak({
  scenario,
  value,
  logEntries,
  globalOutputEntries,
  rawProviderMarkers = []
}) {
  const markers = [
    ['refresh token', REFRESH_TOKEN],
    ['access token', ACCESS_TOKEN],
    ['synthetic request-id value', SYNTHETIC_REQUEST_ID],
    ...rawProviderMarkers.map((marker) => ['raw provider error marker', marker])
  ]

  for (const [category, marker] of markers) {
    if (!marker) continue
    assert.equal(
      containsSentinel(value, marker),
      false,
      `${scenario}: returned result or error leaked ${category}`
    )
    assert.equal(
      containsSentinel(logEntries, marker),
      false,
      `${scenario}: captured logs leaked ${category}`
    )
    assert.equal(
      containsSentinel(globalOutputEntries, marker),
      false,
      `${scenario}: console or process output leaked ${category}`
    )
  }

  for (const [channel, candidate] of [
    ['returned result or error', value],
    ['captured logs', logEntries],
    ['console or process output', globalOutputEntries]
  ]) {
    assert.equal(
      containsSentinel(candidate, 'RequestId'),
      false,
      `${scenario}: ${channel} leaked RequestId label`
    )
  }
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
  const successExecution = await captureGlobalOutput(
    () => client.diagnose({ refreshToken: REFRESH_TOKEN })
  )
  assert.equal(successExecution.status, 'fulfilled', 'successful diagnostic: expected fulfillment')
  const result = successExecution.value

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
    logEntries: successLogger.entries,
    globalOutputEntries: successExecution.entries
  })

  const authFailureTransport = createRequestStub([providerErrors.accessToken])
  const authFailureLogger = createCapturingLogger()
  const authFailureClient = createIfindHttpClient({
    request: authFailureTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z'),
    logger: authFailureLogger.logger
  })
  const authFailureExecution = await captureGlobalOutput(
    () => authFailureClient.diagnose({ refreshToken: REFRESH_TOKEN })
  )
  assert.equal(authFailureExecution.status, 'rejected', 'access-token rejection: expected rejection')
  const authError = authFailureExecution.reason
  assert.equal(authError.code, 'IFIND_AUTH_REJECTED')
  assert.equal(authError.message, 'iFinD access-token request failed')
  assert.equal('cause' in authError, false)
  assertNoProviderLeak({
    scenario: 'access-token rejection',
    value: authError,
    logEntries: authFailureLogger.entries,
    globalOutputEntries: authFailureExecution.entries,
    rawProviderMarkers: [AUTH_PROVIDER_MARKER, providerErrors.accessToken.errmsg]
  })
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
  const probeFailureExecution = await captureGlobalOutput(
    () => probeFailureClient.diagnose({ refreshToken: REFRESH_TOKEN })
  )
  assert.equal(probeFailureExecution.status, 'rejected', 'trade-date rejection: expected rejection')
  const probeError = probeFailureExecution.reason
  assert.equal(probeError.code, 'IFIND_PROBE_REJECTED')
  assert.equal(probeError.message, 'iFinD trade-date probe failed')
  assert.equal(probeError.dataVol, 3)
  assert.equal('cause' in probeError, false)
  assertNoProviderLeak({
    scenario: 'trade-date rejection',
    value: probeError,
    logEntries: probeFailureLogger.entries,
    globalOutputEntries: probeFailureExecution.entries,
    rawProviderMarkers: [PROBE_PROVIDER_MARKER, providerErrors.tradeDates.errmsg]
  })
}

module.exports = { run }
