const https = require('node:https')
const { TextDecoder } = require('node:util')

const ORIGIN = 'https://quantapi.51ifind.com'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    let outgoing
    let totalTimer
    let settled = false
    function settle(action, value) {
      if (settled) return
      settled = true
      if (totalTimer !== undefined) {
        try {
          clearTimer(totalTimer)
        } catch {}
      }
      action(value)
    }
    const succeed = (value) => settle(resolve, value)
    const fail = (error) => settle(reject, error)
    try {
      outgoing = request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers
        }
      }, (incoming) => {
        if (!Number.isInteger(incoming.statusCode) ||
            incoming.statusCode < 200 || incoming.statusCode > 299) {
          incoming.on('data', () => {})
          incoming.on('end', () => {})
          fail(safeError('IFIND_HTTP_STATUS', 'API', 'iFinD HTTP request failed'))
          return
        }
        const chunks = []
        let responseBytes = 0
        incoming.on('data', (chunk) => {
          if (settled) return
          const buffer = Buffer.from(chunk)
          responseBytes += buffer.length
          if (responseBytes > 256 * 1024) {
            if (typeof incoming.destroy === 'function') incoming.destroy()
            fail(safeError(
              'IFIND_RESPONSE_TOO_LARGE',
              'API',
              'iFinD response exceeded the size limit'
            ))
            return
          }
          chunks.push(buffer)
        })
        incoming.on('end', () => {
          if (settled) return
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
        })
      })
    } catch {
      fail(safeError('IFIND_NETWORK_FAILED', 'NETWORK', 'iFinD request failed'))
      return
    }

    try {
      outgoing.on('error', () => {
        fail(safeError('IFIND_NETWORK_FAILED', 'NETWORK', 'iFinD request failed'))
      })
      if (typeof outgoing.setTimeout === 'function') {
        outgoing.setTimeout(2000, () => {
          try {
            if (typeof outgoing.destroy === 'function') outgoing.destroy()
          } catch {}
          fail(safeError('IFIND_TIMEOUT', 'NETWORK', 'iFinD request timed out'))
        })
      }
      totalTimer = setTimer(() => {
        try {
          if (typeof outgoing.destroy === 'function') outgoing.destroy()
        } catch {}
        fail(safeError('IFIND_TIMEOUT', 'NETWORK', 'iFinD request timed out'))
      }, 5000)
      if (body !== undefined) outgoing.write(JSON.stringify(body))
      outgoing.end()
    } catch {
      fail(safeError('IFIND_NETWORK_FAILED', 'NETWORK', 'iFinD request failed'))
    }
  })
}

function classifyProbeFailure(response) {
  const message = typeof response.errmsg === 'string' ? response.errmsg : ''
  if (response.errorcode === -401 ||
      /unauthori[sz]ed|authentication|invalid.{0,24}token|token.{0,24}invalid|expired.{0,24}token|token.{0,24}expired/i.test(message)) {
    return 'AUTH'
  }
  if (response.errorcode === -403 || /permission|forbidden|authority/i.test(message)) {
    return 'PERMISSION'
  }
  if (response.errorcode === -429 || /quota|rate.{0,12}limit|frequency|too many/i.test(message)) {
    return 'QUOTA'
  }
  return 'API'
}

function createIfindHttpClient({
  request = https.request,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let accessToken = null

  function discardAccessToken() {
    if (Buffer.isBuffer(accessToken)) accessToken.fill(0)
    accessToken = null
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
      if (typeof refreshToken !== 'string' || refreshToken.length === 0 ||
          Buffer.byteLength(refreshToken, 'utf8') > 4096 ||
          /[\u0000-\u001f\u007f]/.test(refreshToken)) {
        throw new Error('invalid')
      }
    } catch {
      throw safeError('IFIND_CONFIG_INVALID', 'CONFIG', 'iFinD client configuration was invalid')
    }
    const startedAt = readNow()
    let requestCount = 0

    async function authenticate() {
      requestCount += 1
      const tokenResponse = await requestJson(
        request,
        '/api/v1/get_access_token',
        { refresh_token: refreshToken },
        undefined,
        setTimer,
        clearTimer
      )
      if (!isRecord(tokenResponse) || typeof tokenResponse.errorcode !== 'number') {
        throw safeError('IFIND_RESPONSE_SHAPE', 'API', 'iFinD response shape was invalid')
      }
      if (tokenResponse.errorcode !== 0) {
        throw safeError('IFIND_AUTH_REJECTED', 'AUTH', 'iFinD access-token request failed')
      }
      if (!isRecord(tokenResponse.data) ||
          typeof tokenResponse.data.access_token !== 'string' ||
          tokenResponse.data.access_token.length === 0 ||
          /[\u0000-\u001f\u007f]/.test(tokenResponse.data.access_token)) {
        throw safeError('IFIND_RESPONSE_SHAPE', 'API', 'iFinD response shape was invalid')
      }
      discardAccessToken()
      accessToken = Buffer.from(tokenResponse.data.access_token, 'utf8')
    }

    if (accessToken === null) await authenticate()

    let probeResponse
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
  Object.defineProperty(client, 'clear', { value: discardAccessToken })
  return client
}

module.exports = { createIfindHttpClient }
