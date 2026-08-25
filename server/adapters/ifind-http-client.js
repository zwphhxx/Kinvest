const https = require('node:https')
const { TextDecoder } = require('node:util')

const ORIGIN = 'https://quantapi.51ifind.com'
const AUTH_ERROR_CODES = new Set([-401])
const PERMISSION_ERROR_CODES = new Set([-403])
const QUOTA_ERROR_CODES = new Set([-429])

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHeaderSafeToken(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 4096 &&
    /^[\x21-\x7e]+$/.test(value)
}

function safeError(code, errorClass, message, dataVol) {
  const error = new Error(message)
  error.code = code
  error.class = errorClass
  if (Number.isSafeInteger(dataVol) && dataVol >= 0) error.dataVol = dataVol
  return error
}

function shanghaiDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return `${values.year}-${values.month}-${values.day}`
}

function requestJson(request, path, headers, body, setTimer, clearTimer) {
  return new Promise((resolve, reject) => {
    let outgoing = null
    let incoming = null
    let connectionSocket = null
    let connectionTimer
    let totalTimer
    let settled = false
    let connected = false

    const removeListener = (emitter, event, handler) => {
      try {
        if (emitter && typeof emitter.removeListener === 'function' && handler) {
          emitter.removeListener(event, handler)
        }
      } catch {}
    }
    const destroy = (stream) => {
      try {
        if (stream && typeof stream.destroy === 'function') stream.destroy()
      } catch {}
    }
    let onRequestError
    let onRequestTimeout
    let onRequestSocket
    let onTransportConnected
    let onSecureConnect
    let onResponseData
    let onResponseEnd
    let onResponseError
    let onResponseAborted

    function clearOwnedTimer(timer) {
      if (timer === undefined) return
      try {
        clearTimer(timer)
      } catch {}
    }

    function clearConnectionLifecycle() {
      clearOwnedTimer(connectionTimer)
      connectionTimer = undefined
      removeListener(outgoing, 'socket', onRequestSocket)
      removeListener(outgoing, 'connected', onTransportConnected)
      removeListener(connectionSocket, 'secureConnect', onSecureConnect)
    }

    function disableRequestInactivityTimeout() {
      removeListener(outgoing, 'timeout', onRequestTimeout)
      try {
        if (outgoing && typeof outgoing.setTimeout === 'function') outgoing.setTimeout(0)
      } catch {}
    }

    function connectionEstablished() {
      connected = true
      clearConnectionLifecycle()
      disableRequestInactivityTimeout()
    }

    function cleanup() {
      clearConnectionLifecycle()
      clearOwnedTimer(totalTimer)
      totalTimer = undefined
      removeListener(outgoing, 'error', onRequestError)
      disableRequestInactivityTimeout()
      removeListener(incoming, 'data', onResponseData)
      removeListener(incoming, 'end', onResponseEnd)
      removeListener(incoming, 'error', onResponseError)
      removeListener(incoming, 'aborted', onResponseAborted)
    }

    function settle(action, value, destroyStreams) {
      if (settled) return
      settled = true
      cleanup()
      if (destroyStreams) {
        destroy(incoming)
        destroy(outgoing)
      }
      action(value)
    }
    const succeed = (value) => settle(resolve, value, false)
    const fail = (error) => settle(reject, error, true)

    try {
      outgoing = request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers
        }
      }, (response) => {
        try {
          if (settled) {
            destroy(response)
            return
          }
          if (incoming !== null) {
            destroy(response)
            fail(safeError(
              'IFIND_DUPLICATE_RESPONSE',
              'NETWORK',
              'iFinD returned duplicate responses'
            ))
            return
          }
          const responseType = typeof response
          if ((responseType !== 'object' && responseType !== 'function') ||
              response === null ||
              typeof response.on !== 'function' ||
              typeof response.removeListener !== 'function' ||
              typeof response.destroy !== 'function') {
            throw new Error('invalid response')
          }
          incoming = response
          connectionEstablished()
          if (settled) {
            destroy(response)
            return
          }
          const statusCode = incoming.statusCode
          const successfulStatus = Number.isInteger(statusCode) &&
            statusCode >= 200 && statusCode <= 299
          const chunks = []
          let responseBytes = 0
          onResponseData = (chunk) => {
            if (settled) return
            let buffer
            try {
              buffer = Buffer.from(chunk)
            } catch {
              fail(safeError('IFIND_RESPONSE_FAILED', 'NETWORK', 'iFinD response failed'))
              return
            }
            responseBytes += buffer.length
            if (responseBytes > 256 * 1024) {
              fail(safeError(
                'IFIND_RESPONSE_TOO_LARGE',
                'API',
                'iFinD response exceeded the size limit'
              ))
              return
            }
            chunks.push(buffer)
          }
          onResponseEnd = () => {
            if (settled) return
            if (!successfulStatus) {
              fail(safeError('IFIND_HTTP_STATUS', 'API', 'iFinD HTTP request failed'))
              return
            }
            let text
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
            } catch {
              fail(safeError(
                'IFIND_RESPONSE_ENCODING',
                'API',
                'iFinD response encoding was invalid'
              ))
              return
            }
            try {
              succeed(JSON.parse(text))
            } catch {
              fail(safeError('IFIND_RESPONSE_JSON', 'API', 'iFinD response JSON was invalid'))
            }
          }
          onResponseError = () => {
            fail(safeError('IFIND_RESPONSE_FAILED', 'NETWORK', 'iFinD response failed'))
          }
          onResponseAborted = () => {
            fail(safeError('IFIND_RESPONSE_ABORTED', 'NETWORK', 'iFinD response was aborted'))
          }
          incoming.on('data', onResponseData)
          if (settled) return
          incoming.on('end', onResponseEnd)
          if (settled) return
          incoming.on('error', onResponseError)
          if (settled) return
          incoming.on('aborted', onResponseAborted)
        } catch {
          if (response !== incoming) destroy(response)
          fail(safeError(
            'IFIND_RESPONSE_INVALID',
            'NETWORK',
            'iFinD response metadata was invalid'
          ))
        }
      })
    } catch {
      fail(safeError('IFIND_NETWORK_FAILED', 'NETWORK', 'iFinD request failed'))
      return
    }

    if (settled) {
      destroy(outgoing)
      return
    }

    try {
      onRequestError = () => {
        fail(safeError('IFIND_NETWORK_FAILED', 'NETWORK', 'iFinD request failed'))
      }
      onRequestTimeout = () => {
        fail(safeError('IFIND_TIMEOUT', 'NETWORK', 'iFinD request timed out'))
      }
      onSecureConnect = () => connectionEstablished()
      onTransportConnected = () => connectionEstablished()
      onRequestSocket = (socket) => {
        try {
          connectionSocket = socket
          if (socket && socket.encrypted === true &&
              socket.connecting === false && socket.secureConnecting === false) {
            connectionEstablished()
            return
          }
          if (socket && typeof socket.on === 'function') {
            socket.on('secureConnect', onSecureConnect)
          }
        } catch {
          fail(safeError('IFIND_NETWORK_FAILED', 'NETWORK', 'iFinD request failed'))
        }
      }
      outgoing.on('error', onRequestError)
      if (settled) return
      outgoing.on('socket', onRequestSocket)
      if (settled) return
      outgoing.on('connected', onTransportConnected)
      if (settled) return
      if (!connected) {
        let connectionTimerStarting = true
        let connectionTimerFired = false
        connectionTimer = setTimer(() => {
          connectionTimerFired = true
          if (!connectionTimerStarting) {
            fail(safeError(
              'IFIND_CONNECTION_TIMEOUT',
              'NETWORK',
              'iFinD connection timed out'
            ))
          }
        }, 2000)
        connectionTimerStarting = false
        if (connected) {
          clearConnectionLifecycle()
        } else if (connectionTimerFired) {
          fail(safeError(
            'IFIND_CONNECTION_TIMEOUT',
            'NETWORK',
            'iFinD connection timed out'
          ))
        }
      }
      if (settled) return
      if (!connected && typeof outgoing.setTimeout === 'function') {
        outgoing.on('timeout', onRequestTimeout)
        if (settled) return
        outgoing.setTimeout(2000)
        if (settled) return
      }
      let totalTimerStarting = true
      let totalTimerFired = false
      totalTimer = setTimer(() => {
        totalTimerFired = true
        if (!totalTimerStarting) {
          fail(safeError('IFIND_TIMEOUT', 'NETWORK', 'iFinD request timed out'))
        }
      }, 5000)
      totalTimerStarting = false
      if (totalTimerFired) {
        fail(safeError('IFIND_TIMEOUT', 'NETWORK', 'iFinD request timed out'))
      }
      if (settled) return
      if (body !== undefined) {
        outgoing.write(JSON.stringify(body))
        if (settled) return
      }
      outgoing.end()
    } catch {
      fail(safeError('IFIND_NETWORK_FAILED', 'NETWORK', 'iFinD request failed'))
    }
  })
}

function classifyProbeFailure(response) {
  if (PERMISSION_ERROR_CODES.has(response.errorcode)) return 'PERMISSION'
  if (QUOTA_ERROR_CODES.has(response.errorcode)) return 'QUOTA'
  if (AUTH_ERROR_CODES.has(response.errorcode)) return 'AUTH'
  return 'API'
}

function createIfindHttpClient({
  request = https.request,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let accessToken = null
  let generation = 0

  function discardAccessToken() {
    if (Buffer.isBuffer(accessToken)) accessToken.fill(0)
    accessToken = null
  }

  function clear() {
    generation += 1
    discardAccessToken()
  }

  function requireCurrentGeneration(expectedGeneration) {
    if (generation !== expectedGeneration) {
      throw safeError('IFIND_CLIENT_CLEARED', 'CONFIG', 'iFinD client was cleared')
    }
  }

  function readNow() {
    try {
      const value = now()
      const milliseconds = Date.prototype.getTime.call(value)
      if (!Number.isFinite(milliseconds)) throw new Error('invalid')
      return new Date(milliseconds)
    } catch {
      throw safeError('IFIND_CONFIG_INVALID', 'CONFIG', 'iFinD client configuration was invalid')
    }
  }

  async function diagnose(input) {
    let refreshToken
    try {
      const keys = isRecord(input) ? Object.keys(input) : []
      if (keys.length !== 1 || keys[0] !== 'refreshToken') {
        throw new Error('invalid')
      }
      if (Buffer.isBuffer(input.refreshToken)) {
        refreshToken = new TextDecoder('utf-8', { fatal: true }).decode(input.refreshToken)
      } else {
        refreshToken = input.refreshToken
      }
      if (!isHeaderSafeToken(refreshToken)) {
        throw new Error('invalid')
      }
    } catch {
      throw safeError('IFIND_CONFIG_INVALID', 'CONFIG', 'iFinD client configuration was invalid')
    }
    const operationGeneration = generation
    const startedAt = readNow()
    let requestCount = 0

    async function authenticate() {
      requireCurrentGeneration(operationGeneration)
      requestCount += 1
      const tokenResponse = await requestJson(
        request,
        '/api/v1/get_access_token',
        { refresh_token: refreshToken },
        undefined,
        setTimer,
        clearTimer
      )
      requireCurrentGeneration(operationGeneration)
      if (!isRecord(tokenResponse) || typeof tokenResponse.errorcode !== 'number') {
        throw safeError('IFIND_RESPONSE_SHAPE', 'API', 'iFinD response shape was invalid')
      }
      if (tokenResponse.errorcode !== 0) {
        throw safeError('IFIND_AUTH_REJECTED', 'AUTH', 'iFinD access-token request failed')
      }
      if (!isRecord(tokenResponse.data) ||
          !isHeaderSafeToken(tokenResponse.data.access_token)) {
        throw safeError('IFIND_RESPONSE_SHAPE', 'API', 'iFinD response shape was invalid')
      }
      discardAccessToken()
      accessToken = Buffer.from(tokenResponse.data.access_token, 'utf8')
      requireCurrentGeneration(operationGeneration)
    }

    if (accessToken === null) await authenticate()

    let probeResponse
    for (let attempt = 0; attempt < 2; attempt += 1) {
      requireCurrentGeneration(operationGeneration)
      requestCount += 1
      probeResponse = await requestJson(
        request,
        '/api/v1/get_trade_dates',
        {
          access_token: accessToken.toString('utf8'),
          ifindlang: 'cn'
        },
        {
          marketcode: '212001',
          functionpara: {
            dateType: '0',
            period: 'D',
            offset: '-10',
            dateFormat: '0',
            output: 'sequencedate'
          },
          startdate: shanghaiDate(startedAt)
        },
        setTimer,
        clearTimer
      )
      requireCurrentGeneration(operationGeneration)
      if (!isRecord(probeResponse) || typeof probeResponse.errorcode !== 'number') {
        throw safeError('IFIND_RESPONSE_SHAPE', 'API', 'iFinD response shape was invalid')
      }
      if (probeResponse.errorcode === 0) break
      const failureClass = classifyProbeFailure(probeResponse)
      if (failureClass === 'AUTH' && attempt === 1) {
        discardAccessToken()
        throw safeError('IFIND_AUTH_REJECTED', 'AUTH', 'iFinD authentication failed')
      }
      if (failureClass === 'PERMISSION') {
        throw safeError(
          'IFIND_PERMISSION_REJECTED',
          'PERMISSION',
          'iFinD permission denied',
          probeResponse.dataVol
        )
      }
      if (failureClass === 'QUOTA') {
        throw safeError(
          'IFIND_QUOTA_REJECTED',
          'QUOTA',
          'iFinD quota unavailable',
          probeResponse.dataVol
        )
      }
      if (failureClass !== 'AUTH') {
        throw safeError(
          'IFIND_PROBE_REJECTED',
          'API',
          'iFinD trade-date probe failed',
          probeResponse.dataVol
        )
      }
      discardAccessToken()
      await authenticate()
    }

    if (!isRecord(probeResponse.tables) ||
        !Array.isArray(probeResponse.tables.time) ||
        !isRecord(probeResponse.tables.table) ||
        !Array.isArray(probeResponse.tables.table.sequencedate) ||
        (Object.hasOwn(probeResponse, 'dataVol') &&
          (!Number.isFinite(probeResponse.dataVol) || probeResponse.dataVol < 0))) {
      throw safeError('IFIND_RESPONSE_SHAPE', 'API', 'iFinD response shape was invalid')
    }

    const retrievedAt = readNow()
    requireCurrentGeneration(operationGeneration)
    const hasDataVol = Object.hasOwn(probeResponse, 'dataVol')
    return {
      route: '/api/v1/get_trade_dates',
      scope: 'market-trade-dates:212001:D:-10',
      retrievedAt: retrievedAt.toISOString(),
      timezone: 'Asia/Shanghai',
      elapsedMs: Math.max(0, retrievedAt.getTime() - startedAt.getTime()),
      requestCount,
      dataVol: hasDataVol ? probeResponse.dataVol : 'unavailable',
      officialQuotaStatus: 'unavailable',
      completeness: hasDataVol ? 'complete' : 'partial'
    }
  }

  const client = { diagnose }
  Object.defineProperty(client, 'clear', { value: clear })
  return client
}

module.exports = { createIfindHttpClient }
