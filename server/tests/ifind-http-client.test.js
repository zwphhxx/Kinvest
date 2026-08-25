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

function createRawRequestStub(scenarios) {
  const pending = [...scenarios]
  const calls = []

  function request(url, options, callback) {
    const scenario = pending.shift() || {}
    const call = {
      url: String(url),
      options,
      connectionTimeoutMs: null,
      requestTimeoutCleared: false,
      requestDestroyCount: 0,
      responseDestroyCount: 0,
      outgoing: null,
      incoming: null
    }
    calls.push(call)
    const outgoing = new EventEmitter()
    outgoing.write = () => {}
    outgoing.setTimeout = (milliseconds, handler) => {
      if (milliseconds > 0) call.connectionTimeoutMs = milliseconds
      if (milliseconds === 0) call.requestTimeoutCleared = true
      if (typeof handler === 'function') outgoing.on('timeout', handler)
      if (scenario.connectionTimeout && milliseconds > 0) {
        queueMicrotask(() => outgoing.emit('timeout'))
      }
    }
    call.outgoing = outgoing
    outgoing.destroy = () => { call.requestDestroyCount += 1 }
    outgoing.end = () => {
      if (scenario.connected) {
        outgoing.emit('connected')
        if (scenario.afterConnected) scenario.afterConnected()
      }
      if (scenario.emitRequestTimeout) {
        outgoing.emit('timeout')
        if (scenario.afterRequestTimeout) scenario.afterRequestTimeout()
      }
      if (scenario.preConnectStall) return
      if (scenario.connectionTimeout) {
        if (call.connectionTimeoutMs === null) {
          queueMicrotask(() => outgoing.emit('error', new Error('raw timeout sentinel')))
        }
        return
      }
      if (scenario.noResponse) {
        setImmediate(() => {
          if (call.requestDestroyCount === 0) {
            outgoing.emit('error', new Error('raw stalled response sentinel'))
          }
        })
        return
      }
      queueMicrotask(() => {
        if (scenario.networkError) {
          outgoing.emit('error', new Error(scenario.networkError))
          return
        }
        const incoming = new EventEmitter()
        call.incoming = incoming
        incoming.statusCode = scenario.statusCode === undefined ? 200 : scenario.statusCode
        incoming.destroy = () => { call.responseDestroyCount += 1 }
        incoming.on('error', () => {})
        try {
          callback(incoming)
          if (scenario.beforeChunks) scenario.beforeChunks()
          for (const chunk of scenario.chunks || []) incoming.emit('data', Buffer.from(chunk))
          if (scenario.responseError) {
            incoming.emit('error', new Error(scenario.responseError))
            if (scenario.afterEvents) scenario.afterEvents()
            return
          }
          if (scenario.responseAborted) {
            incoming.emit('aborted')
            if (scenario.afterEvents) scenario.afterEvents()
            return
          }
          incoming.emit('end')
        } catch (error) {
          if (!scenario.swallowResponseErrors) throw error
        }
      })
    }
    return outgoing
  }

  return { calls, request }
}

function createManualRequestTransport() {
  const calls = []

  function request(url, options, callback) {
    const call = {
      url: String(url),
      options,
      callback,
      writeCount: 0,
      endCount: 0,
      destroyCount: 0
    }
    const outgoing = new EventEmitter()
    call.outgoing = outgoing
    outgoing.write = () => { call.writeCount += 1 }
    outgoing.end = () => { call.endCount += 1 }
    outgoing.destroy = () => { call.destroyCount += 1 }
    outgoing.setTimeout = () => {}
    call.respond = ({ statusCode = 200, chunks = [], event = 'end' }) => {
      const incoming = new EventEmitter()
      incoming.statusCode = statusCode
      incoming.destroyCount = 0
      incoming.destroy = () => { incoming.destroyCount += 1 }
      incoming.on('error', () => {})
      callback(incoming)
      for (const chunk of chunks) incoming.emit('data', Buffer.from(chunk))
      incoming.emit(event)
      return incoming
    }
    calls.push(call)
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
    tradeDatesSuccess,
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
  assert.deepEqual(result, {
    route: '/api/v1/get_trade_dates',
    scope: 'market-trade-dates:212001:D:-10',
    retrievedAt: '2026-08-25T16:30:00.000Z',
    timezone: 'Asia/Shanghai',
    elapsedMs: 0,
    requestCount: 2,
    dataVol: 11,
    officialQuotaStatus: 'unavailable',
    completeness: 'complete'
  })
  assertNoProviderLeak({
    scenario: 'successful diagnostic',
    value: result,
    logEntries: successLogger.entries,
    globalOutputEntries: successExecution.entries
  })

  const cachedResult = await client.diagnose({ refreshToken: REFRESH_TOKEN })
  assert.equal(successTransport.calls.length, 3)
  assert.equal(successTransport.calls[2].url, `${ORIGIN}/api/v1/get_trade_dates`)
  assert.equal(cachedResult.requestCount, 1)

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
  assert.equal(authError.class, 'AUTH')
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
  assert.equal(probeError.class, 'API')
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
  assert.equal(probeFailureTransport.calls.length, 2)

  const retryTransport = createRequestStub([
    accessTokenSuccess,
    {
      errorcode: -401,
      errmsg: `Synthetic access token invalid: ${ACCESS_TOKEN}; ${SYNTHETIC_REQUEST_ID}`
    },
    accessTokenSuccess,
    tradeDatesSuccess
  ])
  const retryClient = createIfindHttpClient({
    request: retryTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z')
  })
  const retryResult = await retryClient.diagnose({ refreshToken: REFRESH_TOKEN })
  assert.equal(retryResult.requestCount, 4)
  assert.deepEqual(
    retryTransport.calls.map((call) => new URL(call.url).pathname),
    [
      '/api/v1/get_access_token',
      '/api/v1/get_trade_dates',
      '/api/v1/get_access_token',
      '/api/v1/get_trade_dates'
    ]
  )

  const exhaustedRetryTransport = createRequestStub([
    accessTokenSuccess,
    { errorcode: -401, errmsg: `Invalid token ${SYNTHETIC_REQUEST_ID}` },
    accessTokenSuccess,
    { errorcode: -401, errmsg: `Invalid token again ${SYNTHETIC_REQUEST_ID}` }
  ])
  const exhaustedRetryClient = createIfindHttpClient({
    request: exhaustedRetryTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z')
  })
  await assert.rejects(
    () => exhaustedRetryClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => {
      assert.equal(error.code, 'IFIND_AUTH_REJECTED')
      assert.equal(error.class, 'AUTH')
      assert.equal(error.message, 'iFinD authentication failed')
      assert.deepEqual(Object.keys(error).sort(), ['class', 'code'])
      return true
    }
  )
  assert.equal(exhaustedRetryTransport.calls.length, 4)

  const permissionMarker = `Synthetic permission denied ${SYNTHETIC_REQUEST_ID}`
  const permissionTransport = createRequestStub([
    accessTokenSuccess,
    { errorcode: -403, errmsg: permissionMarker }
  ])
  const permissionLogger = createCapturingLogger()
  const permissionClient = createIfindHttpClient({
    request: permissionTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z'),
    logger: permissionLogger.logger
  })
  const permissionExecution = await captureGlobalOutput(
    () => permissionClient.diagnose({ refreshToken: REFRESH_TOKEN })
  )
  assert.equal(permissionExecution.status, 'rejected')
  assert.equal(permissionExecution.reason.code, 'IFIND_PERMISSION_REJECTED')
  assert.equal(permissionExecution.reason.class, 'PERMISSION')
  assert.equal(permissionTransport.calls.length, 2)
  assertNoProviderLeak({
    scenario: 'permission rejection',
    value: permissionExecution.reason,
    logEntries: permissionLogger.entries,
    globalOutputEntries: permissionExecution.entries,
    rawProviderMarkers: [permissionMarker]
  })

  const quotaTransport = createRequestStub([
    accessTokenSuccess,
    { errorcode: -429, errmsg: `Synthetic quota exceeded ${SYNTHETIC_REQUEST_ID}` }
  ])
  const quotaClient = createIfindHttpClient({
    request: quotaTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z')
  })
  await assert.rejects(
    () => quotaClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => error.code === 'IFIND_QUOTA_REJECTED' && error.class === 'QUOTA'
  )
  assert.equal(quotaTransport.calls.length, 2)

  const nonSuccessMarker = `Synthetic non-success ${SYNTHETIC_REQUEST_ID}`
  const nonSuccessTransport = createRawRequestStub([{
    statusCode: 503,
    chunks: [JSON.stringify({ errorcode: 0, errmsg: nonSuccessMarker, data: { access_token: ACCESS_TOKEN } })]
  }])
  const nonSuccessClient = createIfindHttpClient({ request: nonSuccessTransport.request })
  await assert.rejects(
    () => nonSuccessClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => {
      assert.equal(error.code, 'IFIND_HTTP_STATUS')
      assert.equal(error.class, 'API')
      assert.equal(containsSentinel(error, nonSuccessMarker), false)
      assert.equal(containsSentinel(error, ORIGIN), false)
      return true
    }
  )
  assert.equal(nonSuccessTransport.calls.length, 1)

  const timeoutTransport = createRawRequestStub([{ connectionTimeout: true }])
  const timeoutClient = createIfindHttpClient({ request: timeoutTransport.request })
  await assert.rejects(
    () => timeoutClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => error.code === 'IFIND_TIMEOUT' && error.class === 'NETWORK'
  )
  assert.ok(timeoutTransport.calls[0].connectionTimeoutMs > 0)
  assert.ok(timeoutTransport.calls[0].connectionTimeoutMs <= 5000)

  let totalTimeoutMs = null
  let clearedTotalTimer = false
  const totalTimeoutTransport = createRawRequestStub([{ noResponse: true, connected: true }])
  const totalTimeoutClient = createIfindHttpClient({
    request: totalTimeoutTransport.request,
    setTimer(handler, milliseconds) {
      totalTimeoutMs = Math.max(totalTimeoutMs || 0, milliseconds)
      const timer = { handler, milliseconds, cleared: false }
      if (milliseconds === 5000) {
        queueMicrotask(() => {
          if (!timer.cleared) handler()
        })
      }
      return timer
    },
    clearTimer(timer) {
      timer.cleared = true
      clearedTotalTimer = true
    }
  })
  await assert.rejects(
    () => totalTimeoutClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => error.code === 'IFIND_TIMEOUT' && error.class === 'NETWORK'
  )
  assert.ok(totalTimeoutMs > timeoutTransport.calls[0].connectionTimeoutMs)
  assert.ok(totalTimeoutMs <= 10000)
  assert.equal(clearedTotalTimer, true)

  const oversizedTransport = createRawRequestStub([{
    chunks: [Buffer.alloc((256 * 1024) + 1, 0x61)]
  }])
  const oversizedClient = createIfindHttpClient({ request: oversizedTransport.request })
  await assert.rejects(
    () => oversizedClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => error.code === 'IFIND_RESPONSE_TOO_LARGE' && error.class === 'API'
  )
  assert.equal(oversizedTransport.calls.length, 1)

  const invalidUtf8Transport = createRawRequestStub([{
    chunks: [Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d])]
  }])
  const invalidUtf8Client = createIfindHttpClient({ request: invalidUtf8Transport.request })
  await assert.rejects(
    () => invalidUtf8Client.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => error.code === 'IFIND_RESPONSE_ENCODING' && error.class === 'API'
  )

  const invalidJsonTransport = createRawRequestStub([{ chunks: ['{"errorcode":'] }])
  const invalidJsonClient = createIfindHttpClient({ request: invalidJsonTransport.request })
  await assert.rejects(
    () => invalidJsonClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => error.code === 'IFIND_RESPONSE_JSON' && error.class === 'API'
  )

  const malformedTokenTransport = createRequestStub([{
    errorcode: 0,
    errmsg: 'success',
    data: {}
  }])
  const malformedTokenClient = createIfindHttpClient({ request: malformedTokenTransport.request })
  await assert.rejects(
    () => malformedTokenClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => error.code === 'IFIND_RESPONSE_SHAPE' && error.class === 'API'
  )
  assert.equal(malformedTokenTransport.calls.length, 1)

  const unsupportedShapeTransport = createRequestStub([
    accessTokenSuccess,
    { errorcode: 0, errmsg: 'success', tables: 'unsupported', dataVol: 11 }
  ])
  const unsupportedShapeClient = createIfindHttpClient({ request: unsupportedShapeTransport.request })
  await assert.rejects(
    () => unsupportedShapeClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => error.code === 'IFIND_RESPONSE_SHAPE' && error.class === 'API'
  )
  assert.equal(unsupportedShapeTransport.calls.length, 2)

  const missingVolumeResponse = JSON.parse(JSON.stringify(tradeDatesSuccess))
  delete missingVolumeResponse.dataVol
  const missingVolumeTransport = createRequestStub([
    accessTokenSuccess,
    missingVolumeResponse
  ])
  const missingVolumeClient = createIfindHttpClient({
    request: missingVolumeTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z')
  })
  const missingVolumeResult = await missingVolumeClient.diagnose({ refreshToken: REFRESH_TOKEN })
  assert.equal(missingVolumeResult.dataVol, 'unavailable')
  assert.equal(missingVolumeResult.completeness, 'partial')

  const parameterTransport = createRequestStub([])
  const parameterClient = createIfindHttpClient({ request: parameterTransport.request })
  await assert.rejects(
    () => parameterClient.diagnose({
      refreshToken: REFRESH_TOKEN,
      marketcode: 'browser-controlled-market'
    }),
    (error) => error.code === 'IFIND_CONFIG_INVALID' && error.class === 'CONFIG'
  )
  assert.equal(parameterTransport.calls.length, 0)

  const networkTransport = createRawRequestStub([
    { chunks: [JSON.stringify(accessTokenSuccess)] },
    { networkError: `Synthetic network failure ${SYNTHETIC_REQUEST_ID}` }
  ])
  const networkClient = createIfindHttpClient({ request: networkTransport.request })
  await assert.rejects(
    () => networkClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => error.code === 'IFIND_NETWORK_FAILED' && error.class === 'NETWORK'
  )
  assert.equal(networkTransport.calls.length, 2)

  const hostileMarker = `${REFRESH_TOKEN} ${ACCESS_TOKEN} ${SYNTHETIC_REQUEST_ID}`
  const hostileLogger = new Proxy({}, {
    get() {
      throw new Error(`logger must remain untouched ${hostileMarker}`)
    }
  })
  const hostileClient = createIfindHttpClient({
    request() {
      return new Proxy({}, {
        get() {
          throw new Error(`hostile transport ${hostileMarker}`)
        }
      })
    },
    logger: hostileLogger,
    now: () => new Date('2026-08-25T16:30:00.000Z')
  })
  const hostileExecution = await captureGlobalOutput(
    () => hostileClient.diagnose({ refreshToken: REFRESH_TOKEN })
  )
  assert.equal(hostileExecution.status, 'rejected')
  assert.equal(hostileExecution.reason.code, 'IFIND_NETWORK_FAILED')
  assert.equal(hostileExecution.reason.class, 'NETWORK')
  assertNoProviderLeak({
    scenario: 'hostile dependencies',
    value: hostileExecution.reason,
    logEntries: [],
    globalOutputEntries: hostileExecution.entries,
    rawProviderMarkers: [hostileMarker]
  })

  const clearTransport = createRequestStub([
    accessTokenSuccess,
    tradeDatesSuccess,
    accessTokenSuccess,
    tradeDatesSuccess
  ])
  const clearClient = createIfindHttpClient({
    request: clearTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z')
  })
  await clearClient.diagnose({ refreshToken: REFRESH_TOKEN })
  const originalBufferFill = Buffer.prototype.fill
  let clearedTokenBuffer = null
  Buffer.prototype.fill = function captureTokenClear(value, ...args) {
    if (this.toString('utf8') === ACCESS_TOKEN) clearedTokenBuffer = this
    return originalBufferFill.call(this, value, ...args)
  }
  try {
    clearClient.clear()
    clearClient.clear()
  } finally {
    Buffer.prototype.fill = originalBufferFill
  }
  assert.ok(Buffer.isBuffer(clearedTokenBuffer))
  assert.equal(clearedTokenBuffer.every((byte) => byte === 0), true)
  assert.deepEqual(Object.keys(clearClient), ['diagnose'])
  assert.equal(Object.getOwnPropertyDescriptor(clearClient, 'clear').enumerable, false)
  await clearClient.diagnose({ refreshToken: REFRESH_TOKEN })
  assert.equal(clearTransport.calls.length, 4)

  const refreshTokenBuffer = Buffer.from(REFRESH_TOKEN, 'utf8')
  const environmentBefore = { ...process.env }
  const bufferTransport = createRequestStub([accessTokenSuccess, tradeDatesSuccess])
  const bufferClient = createIfindHttpClient({
    request: bufferTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z')
  })
  await bufferClient.diagnose({ refreshToken: refreshTokenBuffer })
  assert.equal(refreshTokenBuffer.toString('utf8'), REFRESH_TOKEN)
  assert.equal(bufferTransport.calls[0].headers.refresh_token, REFRESH_TOKEN)
  assert.deepEqual({ ...process.env }, environmentBefore)

  const hostileClockTransport = createRequestStub([])
  const hostileClockClient = createIfindHttpClient({
    request: hostileClockTransport.request,
    now() {
      throw new Error(`hostile clock ${REFRESH_TOKEN} ${SYNTHETIC_REQUEST_ID}`)
    }
  })
  const hostileClockExecution = await captureGlobalOutput(
    () => hostileClockClient.diagnose({ refreshToken: REFRESH_TOKEN })
  )
  assert.equal(hostileClockExecution.status, 'rejected')
  assert.equal(hostileClockExecution.reason.code, 'IFIND_CONFIG_INVALID')
  assert.equal(hostileClockExecution.reason.class, 'CONFIG')
  assert.equal(hostileClockTransport.calls.length, 0)
  assertNoProviderLeak({
    scenario: 'hostile clock',
    value: hostileClockExecution.reason,
    logEntries: [],
    globalOutputEntries: hostileClockExecution.entries
  })

  const hostileDataVolMarker = `hostile dataVol ${ACCESS_TOKEN} ${SYNTHETIC_REQUEST_ID}`
  const hostileDataVolTransport = createRequestStub([
    accessTokenSuccess,
    { errorcode: -500, errmsg: 'Synthetic API rejection', dataVol: hostileDataVolMarker }
  ])
  const hostileDataVolClient = createIfindHttpClient({ request: hostileDataVolTransport.request })
  const hostileDataVolExecution = await captureGlobalOutput(
    () => hostileDataVolClient.diagnose({ refreshToken: REFRESH_TOKEN })
  )
  assert.equal(hostileDataVolExecution.status, 'rejected')
  assert.equal('dataVol' in hostileDataVolExecution.reason, false)
  assertNoProviderLeak({
    scenario: 'hostile failure metadata',
    value: hostileDataVolExecution.reason,
    logEntries: [],
    globalOutputEntries: hostileDataVolExecution.entries,
    rawProviderMarkers: [hostileDataVolMarker]
  })

  const hostileTimerTransport = createRawRequestStub([
    { chunks: [JSON.stringify(accessTokenSuccess)], swallowResponseErrors: true },
    { chunks: [JSON.stringify(tradeDatesSuccess)], swallowResponseErrors: true }
  ])
  const hostileTimerClient = createIfindHttpClient({
    request: hostileTimerTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z'),
    setTimer: () => 'hostile-timer',
    clearTimer() {
      throw new Error(`hostile timer cleanup ${SYNTHETIC_REQUEST_ID}`)
    }
  })
  const hostileTimerOutcome = await Promise.race([
    hostileTimerClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    new Promise((resolve) => setImmediate(() => resolve('stalled')))
  ])
  assert.notEqual(hostileTimerOutcome, 'stalled')
  assert.equal(hostileTimerOutcome.dataVol, 11)

  const responseErrorMarker = `raw response error ${ACCESS_TOKEN} ${SYNTHETIC_REQUEST_ID}`
  const responseErrorTimers = []
  const responseErrorScenario = {
    responseError: responseErrorMarker,
    chunks: ['{"partial":'],
    afterEvents() {
      for (const timer of responseErrorTimers) {
        if (!timer.cleared) timer.handler()
      }
    }
  }
  const responseErrorTransport = createRawRequestStub([responseErrorScenario])
  const responseErrorClient = createIfindHttpClient({
    request: responseErrorTransport.request,
    setTimer(handler, milliseconds) {
      const timer = { handler, milliseconds, cleared: false }
      responseErrorTimers.push(timer)
      return timer
    },
    clearTimer(timer) {
      timer.cleared = true
    }
  })
  let responseErrorRejections = 0
  const responseErrorExecution = await captureGlobalOutput(
    () => responseErrorClient.diagnose({ refreshToken: REFRESH_TOKEN }).catch((error) => {
      responseErrorRejections += 1
      throw error
    })
  )
  assert.equal(responseErrorExecution.status, 'rejected')
  assert.equal(responseErrorExecution.reason.code, 'IFIND_RESPONSE_FAILED')
  assert.equal(responseErrorExecution.reason.class, 'NETWORK')
  assert.equal(responseErrorRejections, 1)
  assert.equal(responseErrorTransport.calls[0].requestDestroyCount, 1)
  assert.equal(responseErrorTransport.calls[0].responseDestroyCount, 1)
  assert.equal(responseErrorTimers.every((timer) => timer.cleared), true)
  assert.equal(responseErrorTransport.calls[0].outgoing.listenerCount('error'), 0)
  assert.equal(responseErrorTransport.calls[0].incoming.listenerCount('data'), 0)
  assert.equal(responseErrorTransport.calls[0].incoming.listenerCount('end'), 0)
  assert.equal(responseErrorTransport.calls[0].incoming.listenerCount('aborted'), 0)
  assert.equal(responseErrorTransport.calls[0].incoming.listenerCount('error'), 1)
  assertNoProviderLeak({
    scenario: 'response error',
    value: responseErrorExecution.reason,
    logEntries: [],
    globalOutputEntries: responseErrorExecution.entries,
    rawProviderMarkers: [responseErrorMarker]
  })

  const abortedTimers = []
  const abortedScenario = {
    responseAborted: true,
    chunks: ['{"partial":'],
    afterEvents() {
      for (const timer of abortedTimers) {
        if (!timer.cleared) timer.handler()
      }
    }
  }
  const abortedTransport = createRawRequestStub([abortedScenario])
  const abortedClient = createIfindHttpClient({
    request: abortedTransport.request,
    setTimer(handler, milliseconds) {
      const timer = { handler, milliseconds, cleared: false }
      abortedTimers.push(timer)
      return timer
    },
    clearTimer(timer) {
      timer.cleared = true
    }
  })
  let abortedRejections = 0
  const abortedExecution = await captureGlobalOutput(
    () => abortedClient.diagnose({ refreshToken: REFRESH_TOKEN }).catch((error) => {
      abortedRejections += 1
      throw error
    })
  )
  assert.equal(abortedExecution.status, 'rejected')
  assert.equal(abortedExecution.reason.code, 'IFIND_RESPONSE_ABORTED')
  assert.equal(abortedExecution.reason.class, 'NETWORK')
  assert.equal(abortedRejections, 1)
  assert.deepEqual(abortedExecution.entries, [])
  assert.equal(abortedTransport.calls[0].requestDestroyCount, 1)
  assert.equal(abortedTransport.calls[0].responseDestroyCount, 1)
  assert.equal(abortedTimers.every((timer) => timer.cleared), true)
  assert.equal(abortedTransport.calls[0].outgoing.listenerCount('error'), 0)
  assert.equal(abortedTransport.calls[0].incoming.listenerCount('data'), 0)
  assert.equal(abortedTransport.calls[0].incoming.listenerCount('end'), 0)
  assert.equal(abortedTransport.calls[0].incoming.listenerCount('aborted'), 0)
  assert.equal(abortedTransport.calls[0].incoming.listenerCount('error'), 1)

  const oversizedStatusTimers = []
  let statusTimerActiveDuringBody = false
  const oversizedStatusScenario = {
    statusCode: 503,
    chunks: [Buffer.alloc(128 * 1024), Buffer.alloc(128 * 1024), Buffer.alloc(1)],
    beforeChunks() {
      statusTimerActiveDuringBody = oversizedStatusTimers.some((timer) => !timer.cleared)
    }
  }
  const oversizedStatusTransport = createRawRequestStub([oversizedStatusScenario])
  const oversizedStatusClient = createIfindHttpClient({
    request: oversizedStatusTransport.request,
    setTimer(handler, milliseconds) {
      const timer = { handler, milliseconds, cleared: false }
      oversizedStatusTimers.push(timer)
      return timer
    },
    clearTimer(timer) {
      timer.cleared = true
    }
  })
  await assert.rejects(
    () => oversizedStatusClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => error.code === 'IFIND_RESPONSE_TOO_LARGE' && error.class === 'API'
  )
  assert.equal(statusTimerActiveDuringBody, true)
  assert.equal(oversizedStatusTransport.calls[0].requestDestroyCount, 1)
  assert.equal(oversizedStatusTransport.calls[0].responseDestroyCount, 1)
  assert.equal(oversizedStatusTimers.every((timer) => timer.cleared), true)
  assert.equal(oversizedStatusTransport.calls[0].outgoing.listenerCount('error'), 0)
  assert.equal(oversizedStatusTransport.calls[0].incoming.listenerCount('data'), 0)
  assert.equal(oversizedStatusTransport.calls[0].incoming.listenerCount('end'), 0)

  const preConnectTimers = []
  const preConnectTransport = createRawRequestStub([{ preConnectStall: true }])
  const preConnectClient = createIfindHttpClient({
    request: preConnectTransport.request,
    setTimer(handler, milliseconds) {
      const timer = { handler, milliseconds, cleared: false }
      preConnectTimers.push(timer)
      return timer
    },
    clearTimer(timer) {
      timer.cleared = true
    }
  })
  const preConnectExecution = await captureGlobalOutput(async () => {
    const pendingDiagnosis = preConnectClient.diagnose({ refreshToken: REFRESH_TOKEN })
    await Promise.resolve()
    const activeTimers = preConnectTimers
      .filter((timer) => !timer.cleared)
      .sort((left, right) => left.milliseconds - right.milliseconds)
    assert.deepEqual(activeTimers.map((timer) => timer.milliseconds), [2000, 5000])
    activeTimers[0].handler()
    return pendingDiagnosis
  })
  assert.equal(preConnectExecution.status, 'rejected')
  assert.equal(preConnectExecution.reason.code, 'IFIND_CONNECTION_TIMEOUT')
  assert.equal(preConnectExecution.reason.class, 'NETWORK')
  assert.equal(preConnectTransport.calls[0].requestDestroyCount, 1)
  assert.equal(preConnectTimers.every((timer) => timer.cleared), true)
  assert.equal(preConnectTransport.calls[0].outgoing.listenerCount('socket'), 0)
  assert.equal(preConnectTransport.calls[0].outgoing.listenerCount('connected'), 0)
  assert.equal(preConnectTransport.calls[0].outgoing.listenerCount('error'), 0)
  assert.equal(preConnectTransport.calls[0].outgoing.listenerCount('timeout'), 0)

  const lateResponseTimers = []
  const lateResponseTransport = createManualRequestTransport()
  const lateResponseClient = createIfindHttpClient({
    request: lateResponseTransport.request,
    setTimer(handler, milliseconds) {
      const timer = { handler, milliseconds, cleared: false }
      lateResponseTimers.push(timer)
      return timer
    },
    clearTimer(timer) {
      timer.cleared = true
    }
  })
  const lateDiagnosis = lateResponseClient.diagnose({ refreshToken: REFRESH_TOKEN })
  lateResponseTimers.find((timer) => timer.milliseconds === 2000).handler()
  await assert.rejects(
    () => lateDiagnosis,
    (error) => error.code === 'IFIND_CONNECTION_TIMEOUT' && error.class === 'NETWORK'
  )
  const lateIncoming = lateResponseTransport.calls[0].respond({
    chunks: [JSON.stringify(accessTokenSuccess)]
  })
  assert.equal(lateIncoming.destroyCount, 1)
  assert.equal(lateIncoming.listenerCount('data'), 0)
  assert.equal(lateIncoming.listenerCount('end'), 0)
  assert.equal(lateIncoming.listenerCount('aborted'), 0)
  assert.equal(lateIncoming.listenerCount('error'), 1)

  const duplicateResponseTransport = createManualRequestTransport()
  const duplicateResponseClient = createIfindHttpClient({
    request: duplicateResponseTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z')
  })
  const duplicateDiagnosis = duplicateResponseClient.diagnose({ refreshToken: REFRESH_TOKEN })
  duplicateResponseTransport.calls[0].respond({
    chunks: [JSON.stringify(accessTokenSuccess)]
  })
  const duplicateIncoming = duplicateResponseTransport.calls[0].respond({
    chunks: [JSON.stringify(accessTokenSuccess)]
  })
  await new Promise((resolve) => setImmediate(resolve))
  duplicateResponseTransport.calls[1].respond({
    chunks: [JSON.stringify(tradeDatesSuccess)]
  })
  const duplicateResult = await duplicateDiagnosis
  assert.equal(duplicateResult.dataVol, 11)
  assert.equal(duplicateIncoming.destroyCount, 1)
  assert.equal(duplicateIncoming.listenerCount('data'), 0)
  assert.equal(duplicateIncoming.listenerCount('end'), 0)
  assert.equal(duplicateIncoming.listenerCount('aborted'), 0)
  assert.equal(duplicateIncoming.listenerCount('error'), 1)

  const synchronousTimerTransport = createManualRequestTransport()
  const synchronousTimers = []
  const synchronousTimerClient = createIfindHttpClient({
    request: synchronousTimerTransport.request,
    setTimer(handler, milliseconds) {
      const timer = { milliseconds, cleared: false }
      synchronousTimers.push(timer)
      handler()
      return timer
    },
    clearTimer(timer) {
      timer.cleared = true
    }
  })
  await assert.rejects(
    () => synchronousTimerClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => error.code === 'IFIND_CONNECTION_TIMEOUT' && error.class === 'NETWORK'
  )
  assert.equal(synchronousTimerTransport.calls[0].writeCount, 0)
  assert.equal(synchronousTimerTransport.calls[0].endCount, 0)
  assert.equal(synchronousTimerTransport.calls[0].destroyCount, 1)
  assert.equal(synchronousTimers.every((timer) => timer.cleared), true)
  assert.equal(synchronousTimerTransport.calls[0].outgoing.listenerCount('socket'), 0)
  assert.equal(synchronousTimerTransport.calls[0].outgoing.listenerCount('connected'), 0)
  assert.equal(synchronousTimerTransport.calls[0].outgoing.listenerCount('timeout'), 0)
  assert.equal(synchronousTimerTransport.calls[0].outgoing.listenerCount('error'), 0)

  const connectedSlowTimers = []
  let inactivityDisabledAtConnection = false
  const connectedSlowScenario = {
    connected: true,
    noResponse: true,
    emitRequestTimeout: true,
    afterConnected() {
      inactivityDisabledAtConnection = connectedSlowTransport.calls[0].requestTimeoutCleared
    },
    afterRequestTimeout() {
      const totalTimer = connectedSlowTimers.find((timer) => timer.milliseconds === 5000)
      if (!totalTimer.cleared) totalTimer.handler()
    }
  }
  const connectedSlowTransport = createRawRequestStub([connectedSlowScenario])
  const connectedSlowClient = createIfindHttpClient({
    request: connectedSlowTransport.request,
    setTimer(handler, milliseconds) {
      const timer = { handler, milliseconds, cleared: false }
      connectedSlowTimers.push(timer)
      return timer
    },
    clearTimer(timer) {
      timer.cleared = true
    }
  })
  await assert.rejects(
    () => connectedSlowClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => error.code === 'IFIND_TIMEOUT' && error.class === 'NETWORK'
  )
  assert.equal(inactivityDisabledAtConnection, true)
  assert.equal(connectedSlowTimers.every((timer) => timer.cleared), true)
  assert.equal(connectedSlowTransport.calls[0].outgoing.listenerCount('timeout'), 0)

  const pendingClearTransport = createManualRequestTransport()
  const pendingClearClient = createIfindHttpClient({
    request: pendingClearTransport.request,
    now: () => new Date('2026-08-25T16:30:00.000Z')
  })
  const primingDiagnosis = pendingClearClient.diagnose({ refreshToken: REFRESH_TOKEN })
  pendingClearTransport.calls[0].respond({ chunks: [JSON.stringify(accessTokenSuccess)] })
  await new Promise((resolve) => setImmediate(resolve))
  pendingClearTransport.calls[1].respond({ chunks: [JSON.stringify(tradeDatesSuccess)] })
  await primingDiagnosis

  const originalPendingClearFill = Buffer.prototype.fill
  let zeroedPendingClearToken = null
  Buffer.prototype.fill = function capturePendingClear(value, ...args) {
    if (this.toString('utf8') === ACCESS_TOKEN) zeroedPendingClearToken = this
    return originalPendingClearFill.call(this, value, ...args)
  }
  try {
    const pendingClearDiagnosis = pendingClearClient.diagnose({ refreshToken: REFRESH_TOKEN })
    const pendingClearRejection = assert.rejects(
      () => pendingClearDiagnosis,
      (error) => error.code === 'IFIND_CLIENT_CLEARED' && error.class === 'CONFIG'
    )
    pendingClearTransport.calls[2].respond({
      chunks: [JSON.stringify({ errorcode: -401, errmsg: 'documented auth rejection' })]
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(pendingClearTransport.calls.length, 4)
    pendingClearClient.clear()
    pendingClearTransport.calls[3].respond({ chunks: [JSON.stringify(accessTokenSuccess)] })
    await new Promise((resolve) => setImmediate(resolve))
    if (pendingClearTransport.calls[4]) {
      pendingClearTransport.calls[4].respond({ chunks: [JSON.stringify(tradeDatesSuccess)] })
    }
    await pendingClearRejection
  } finally {
    Buffer.prototype.fill = originalPendingClearFill
  }
  assert.ok(Buffer.isBuffer(zeroedPendingClearToken))
  assert.equal(zeroedPendingClearToken.every((byte) => byte === 0), true)
  assert.equal(pendingClearTransport.calls.length, 4)

  const conflictingPermissionTransport = createRequestStub([
    accessTokenSuccess,
    { errorcode: -403, errmsg: 'invalid token but documented permission code' }
  ])
  const conflictingPermissionClient = createIfindHttpClient({
    request: conflictingPermissionTransport.request
  })
  await assert.rejects(
    () => conflictingPermissionClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => error.class === 'PERMISSION' && error.code === 'IFIND_PERMISSION_REJECTED'
  )
  assert.equal(conflictingPermissionTransport.calls.length, 2)

  const conflictingQuotaTransport = createRequestStub([
    accessTokenSuccess,
    { errorcode: -429, errmsg: 'authentication token expired but documented quota code' }
  ])
  const conflictingQuotaClient = createIfindHttpClient({ request: conflictingQuotaTransport.request })
  await assert.rejects(
    () => conflictingQuotaClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => error.class === 'QUOTA' && error.code === 'IFIND_QUOTA_REJECTED'
  )
  assert.equal(conflictingQuotaTransport.calls.length, 2)

  const conflictingAuthTransport = createRequestStub([
    accessTokenSuccess,
    { errorcode: -401, errmsg: 'permission denied but documented auth code' },
    accessTokenSuccess,
    tradeDatesSuccess
  ])
  const conflictingAuthClient = createIfindHttpClient({ request: conflictingAuthTransport.request })
  const conflictingAuthResult = await conflictingAuthClient.diagnose({ refreshToken: REFRESH_TOKEN })
  assert.equal(conflictingAuthResult.requestCount, 4)

  const unknownCodeTransport = createRequestStub([
    accessTokenSuccess,
    { errorcode: -999, errmsg: 'invalid access token expired authentication' }
  ])
  const unknownCodeClient = createIfindHttpClient({ request: unknownCodeTransport.request })
  await assert.rejects(
    () => unknownCodeClient.diagnose({ refreshToken: REFRESH_TOKEN }),
    (error) => error.class === 'API' && error.code === 'IFIND_PROBE_REJECTED'
  )
  assert.equal(unknownCodeTransport.calls.length, 2)

  const invalidRefreshTokens = [
    '',
    'refresh\r\ntoken',
    '刷新令牌',
    ' refresh-token',
    'r'.repeat(4097)
  ]
  for (const invalidRefreshToken of invalidRefreshTokens) {
    const invalidRefreshTransport = createRequestStub([])
    const invalidRefreshClient = createIfindHttpClient({ request: invalidRefreshTransport.request })
    await assert.rejects(
      () => invalidRefreshClient.diagnose({ refreshToken: invalidRefreshToken }),
      (error) => error.code === 'IFIND_CONFIG_INVALID' && error.class === 'CONFIG'
    )
    assert.equal(invalidRefreshTransport.calls.length, 0)
  }

  const invalidAccessTokens = [
    'access\r\ntoken',
    '访问令牌',
    '',
    'a'.repeat(4097)
  ]
  for (const invalidAccessToken of invalidAccessTokens) {
    const invalidAccessTransport = createRequestStub([{
      errorcode: 0,
      errmsg: 'success',
      data: { access_token: invalidAccessToken }
    }])
    const invalidAccessClient = createIfindHttpClient({ request: invalidAccessTransport.request })
    await assert.rejects(
      () => invalidAccessClient.diagnose({ refreshToken: REFRESH_TOKEN }),
      (error) => error.code === 'IFIND_RESPONSE_SHAPE' && error.class === 'API'
    )
    assert.equal(invalidAccessTransport.calls.length, 1)
    assert.equal(
      new URL(invalidAccessTransport.calls[0].url).pathname,
      '/api/v1/get_access_token'
    )
  }
}

module.exports = { run }
