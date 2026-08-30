const https = require('node:https')
const { TextDecoder, types } = require('node:util')
const { isIfindIndicatorId } = require('../domain/ifind-indicator-id')
const { CALIBRATION_REQUEST } = require('../domain/ifind-calibration')
const {
  isClientFailureBase,
  isClientFailureMetadata
} = require('../contracts/ifind-diagnostic-errors')

const ORIGIN = 'https://quantapi.51ifind.com'
const ENDPOINTS = Object.freeze({
  auth: '/api/v1/get_access_token',
  probe: '/api/v1/get_trade_dates',
  quote: '/api/v1/real_time_quotation',
  financial: '/api/v1/basic_data_service'
})
const ALLOWED_ENDPOINTS = new Set(Object.values(ENDPOINTS))
const AUTH_ERROR_CODES = new Set([-401])
const PERMISSION_ERROR_CODES = new Set([-403])
const QUOTA_ERROR_CODES = new Set([-429])
const SAFE_ERRORS = new WeakSet()
// Fixed baseline from the official iFinD HTTP example, not a dynamic market date.
const DIAGNOSTIC_REFERENCE_DATE = '2022-07-05'

/**
 * @typedef {Error & {
 *   code: string,
 *   class: string,
 *   failureCode: string,
 *   vendorErrorCode: number | null,
 *   dataVol?: number,
 *   requestCount?: number,
 *   stage?: 'auth' | 'probe' | 'quote' | 'financial'
 * }} IfindClientError
 */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHeaderSafeToken(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 4096 &&
    /^[\x21-\x7e]+$/.test(value)
}

/** @returns {IfindClientError} */
function safeError(code, errorClass, message, dataVol, vendorErrorCode = null) {
  if (!isClientFailureBase({
    failureCode: code,
    errorClass,
    vendorErrorCode
  })) {
    code = 'IFIND_CLIENT_FAILED'
    errorClass = 'API'
    message = 'iFinD diagnostic failed'
    vendorErrorCode = null
  }
  const error = /** @type {IfindClientError} */ (new Error(message))
  error.code = code
  error.class = errorClass
  error.failureCode = code
  error.vendorErrorCode = Number.isSafeInteger(vendorErrorCode) && vendorErrorCode !== 0
    ? vendorErrorCode
    : null
  if (Number.isSafeInteger(dataVol) && dataVol >= 0) error.dataVol = dataVol
  SAFE_ERRORS.add(error)
  return error
}

function withRequestCount(error, requestCount) {
  const safeCount = Number.isSafeInteger(requestCount) && requestCount >= 0
    ? requestCount
    : 0
  const sanitized = SAFE_ERRORS.has(error)
    ? error
    : safeError('IFIND_CLIENT_FAILED', 'API', 'iFinD diagnostic failed')
  Object.defineProperty(sanitized, 'requestCount', {
    value: safeCount,
    enumerable: true,
    configurable: false,
    writable: false
  })
  return sanitized
}

function withStage(error, stage) {
  let sanitized = SAFE_ERRORS.has(error)
    ? error
    : safeError('IFIND_CLIENT_FAILED', 'API', 'iFinD diagnostic failed')
  if (!isClientFailureMetadata({
    failureCode: sanitized.failureCode,
    errorClass: sanitized.class,
    stage,
    vendorErrorCode: sanitized.vendorErrorCode
  })) {
    sanitized = safeError('IFIND_CLIENT_FAILED', 'API', 'iFinD diagnostic failed')
  }
  const existing = Object.getOwnPropertyDescriptor(sanitized, 'stage')
  if (existing && ['auth', 'probe', 'quote', 'financial'].includes(existing.value)) {
    return sanitized
  }
  Object.defineProperty(sanitized, 'stage', {
    value: stage,
    enumerable: true,
    configurable: false,
    writable: false
  })
  return sanitized
}

function plainJsonSnapshot(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid JSON number')
    return value
  }
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const snapshot = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[index]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        throw new Error('invalid JSON array')
      }
      snapshot.push(plainJsonSnapshot(descriptor.value))
    }
    return Object.freeze(snapshot)
  }
  if (!isRecord(value)) throw new Error('invalid JSON value')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const snapshot = {}
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error('invalid JSON object')
    }
    Object.defineProperty(snapshot, key, {
      value: plainJsonSnapshot(descriptor.value),
      enumerable: true,
      configurable: false,
      writable: false
    })
  }
  return Object.freeze(snapshot)
}

function requestJson(request, path, headers, body, setTimer, clearTimer) {
  if (!ALLOWED_ENDPOINTS.has(path)) {
    return Promise.reject(safeError(
      'IFIND_CONFIG_INVALID',
      'CONFIG',
      'iFinD client configuration was invalid'
    ))
  }
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
      } catch {
        // Best-effort defensive cleanup must not replace the stable result.
      }
    }
    const destroy = (stream) => {
      try {
        if (stream && typeof stream.destroy === 'function') stream.destroy()
      } catch {
        // Best-effort defensive cleanup must not replace the stable result.
      }
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
      } catch {
        // Best-effort defensive cleanup must not replace the stable result.
      }
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
      } catch {
        // Best-effort defensive cleanup must not replace the stable result.
      }
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
              succeed(plainJsonSnapshot(JSON.parse(text)))
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

function classifyProbeFailure(errorCode) {
  if (PERMISSION_ERROR_CODES.has(errorCode)) return 'PERMISSION'
  if (QUOTA_ERROR_CODES.has(errorCode)) return 'QUOTA'
  if (AUTH_ERROR_CODES.has(errorCode)) return 'AUTH'
  return 'API'
}

function isCanonicalCalendarDate(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) {
    return false
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function plainDataDescriptors(value, exactKeys, frozen) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    throw new Error('invalid request')
  }
  if (Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      (frozen && !Object.isFrozen(value))) {
    throw new Error('invalid request')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors)
  if (keys.length !== exactKeys.length ||
      exactKeys.some((key) => !Object.hasOwn(descriptors, key))) {
    throw new Error('invalid request')
  }
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error('invalid request')
    }
  }
  return descriptors
}

function descriptorValue(descriptors, key) {
  const descriptor = descriptors[key]
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('invalid request')
  return descriptor.value
}

function providerIdentifier(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 ||
      value.trim() !== value || Array.from(value).some((character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('invalid request')
  }
  return value
}

function frozenIdentifierArray(value) {
  if (!Array.isArray(value) || types.isProxy(value) || !Object.isFrozen(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error('invalid request')
  }
  const descriptors = Object.getOwnPropertyDescriptors(/** @type {object} */ (value))
  const lengthDescriptor = descriptors.length
  const length = lengthDescriptor && lengthDescriptor.value
  if (!Number.isSafeInteger(length) || length < 1 || length > 64 ||
      Object.keys(descriptors).length !== length + 1) {
    throw new Error('invalid request')
  }
  const identifiers = []
  const unique = new Set()
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index]
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error('invalid request')
    }
    const identifier = providerIdentifier(descriptor.value)
    if (unique.has(identifier)) throw new Error('invalid request')
    unique.add(identifier)
    identifiers.push(identifier)
  }
  return Object.freeze(identifiers)
}

const PARAMETER_VALIDATION_BUDGET = 24

function consumeParameterBudget(state, amount = 1) {
  state.work += amount
  if (state.work > PARAMETER_VALIDATION_BUDGET) throw new Error('invalid request')
}

function frozenProviderParameters(value, state, depth = 0) {
  if (typeof value === 'string') {
    consumeParameterBudget(state)
    return providerIdentifier(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid request')
    consumeParameterBudget(state)
    return value
  }
  if (typeof value === 'boolean') {
    consumeParameterBudget(state)
    return value
  }
  if (depth >= 8 || !value || typeof value !== 'object' || types.isProxy(value) ||
      !Object.isFrozen(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error('invalid request')
  }
  if (state.active.has(value)) throw new Error('invalid request')
  if (state.snapshots.has(value)) return state.snapshots.get(value)
  state.active.add(value)
  consumeParameterBudget(state)
  try {
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 64) {
      throw new Error('invalid request')
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.keys(descriptors).length !== value.length + 1) throw new Error('invalid request')
    consumeParameterBudget(state, value.length)
    const snapshot = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[index]
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
        throw new Error('invalid request')
      }
      snapshot.push(frozenProviderParameters(descriptor.value, state, depth + 1))
    }
    const frozenSnapshot = Object.freeze(snapshot)
    state.snapshots.set(value, frozenSnapshot)
    return frozenSnapshot
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('invalid request')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors)
  if (keys.length < 1 || keys.length > 64) throw new Error('invalid request')
  consumeParameterBudget(state, keys.length)
  const snapshot = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ||
        !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error('invalid request')
    }
    Object.defineProperty(snapshot, key, {
      value: frozenProviderParameters(descriptor.value, state, depth + 1),
      enumerable: true,
      configurable: false,
      writable: false
    })
  }
  const frozenSnapshot = Object.freeze(snapshot)
  state.snapshots.set(value, frozenSnapshot)
  return frozenSnapshot
  } finally {
    state.active.delete(value)
  }
}

function readOperationRequest(request, operation) {
  if (operation === 'quote') {
    const descriptors = plainDataDescriptors(request, ['vendorCode', 'fields'], true)
    const vendorCode = providerIdentifier(descriptorValue(descriptors, 'vendorCode'))
    const fieldIds = frozenIdentifierArray(descriptorValue(descriptors, 'fields'))
    if (!fieldIds.every(isIfindIndicatorId)) throw new Error('invalid request')
    return Object.freeze({
      vendorCode,
      fieldIds,
      body: Object.freeze({
        codes: vendorCode,
        indicators: fieldIds.join(',')
      })
    })
  }

  const descriptors = plainDataDescriptors(
    request,
    ['vendorCode', 'indicatorIds', 'periodParameters'],
    true
  )
  const periodDescriptors = plainDataDescriptors(
    descriptorValue(descriptors, 'periodParameters'),
    ['fullFiscalYears', 'latestDisclosedInterim'],
    true
  )
  const periodParameters = {}
  const parameterValidationState = {
    work: 0,
    active: new Set(),
    snapshots: new WeakMap()
  }
  for (const key of ['fullFiscalYears', 'latestDisclosedInterim']) {
    Object.defineProperty(periodParameters, key, {
      value: frozenProviderParameters(
        descriptorValue(periodDescriptors, key),
        parameterValidationState
      ),
      enumerable: true,
      configurable: false,
      writable: false
    })
  }
  const vendorCode = providerIdentifier(descriptorValue(descriptors, 'vendorCode'))
  const fieldIds = frozenIdentifierArray(descriptorValue(descriptors, 'indicatorIds'))
  if (!fieldIds.every(isIfindIndicatorId)) throw new Error('invalid request')
  return Object.freeze({
    vendorCode,
    fieldIds,
    body: Object.freeze({
      codes: vendorCode,
      indicators: fieldIds,
      parameters: Object.freeze(periodParameters)
    })
  })
}

function ownDataValue(record, key) {
  if (!isRecord(record) || Object.getPrototypeOf(record) !== Object.prototype) {
    throw new Error('invalid response')
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
    throw new Error('invalid response')
  }
  return descriptor.value
}

function optionalOwnDataValue(record, key) {
  if (!isRecord(record) || Object.getPrototypeOf(record) !== Object.prototype) {
    throw new Error('invalid response')
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined) return { present: false, value: undefined }
  if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
    throw new Error('invalid response')
  }
  return { present: true, value: descriptor.value }
}

function protocolDataValue(record, key) {
  try {
    return ownDataValue(record, key)
  } catch {
    throw safeError('IFIND_RESPONSE_SHAPE', 'API', 'iFinD response shape was invalid')
  }
}

function protocolErrorCode(record) {
  const errorCode = protocolDataValue(record, 'errorcode')
  if (!Number.isSafeInteger(errorCode)) {
    throw safeError('IFIND_RESPONSE_SHAPE', 'API', 'iFinD response shape was invalid')
  }
  return errorCode
}

function protocolDataVol(record) {
  let field
  try {
    field = optionalOwnDataValue(record, 'dataVol')
  } catch {
    throw safeError('IFIND_RESPONSE_SHAPE', 'API', 'iFinD response shape was invalid')
  }
  if (!field.present) return field
  if (!Number.isSafeInteger(field.value) || field.value < 0) {
    throw safeError('IFIND_RESPONSE_SHAPE', 'API', 'iFinD response shape was invalid')
  }
  return field
}

function parserDataArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error('invalid response')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const snapshot = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index]
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error('invalid response')
    }
    const item = descriptor.value
    if (item === null || typeof item === 'string' || typeof item === 'boolean') {
      snapshot.push(item)
      continue
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      snapshot.push(item)
      continue
    }
    throw new Error('invalid response')
  }
  return Object.freeze(snapshot)
}

function sanitizeMarketSuccess(response, requestContract) {
  const tables = ownDataValue(response, 'tables')
  if (!Array.isArray(tables) || tables.length !== 1) throw new Error('invalid response')
  const providerTable = tables[0]
  const providerCode = ownDataValue(providerTable, 'thscode')
  if (providerCode !== requestContract.vendorCode) throw new Error('invalid response')
  const providerFields = ownDataValue(providerTable, 'table')
  const fields = {}
  for (const fieldId of requestContract.fieldIds) {
    Object.defineProperty(fields, fieldId, {
      value: parserDataArray(ownDataValue(providerFields, fieldId)),
      enumerable: true,
      configurable: false,
      writable: false
    })
  }
  const sanitizedTable = Object.freeze({
    thscode: providerCode,
    table: Object.freeze(fields)
  })
  const sanitized = {
    errorcode: ownDataValue(response, 'errorcode'),
    tables: Object.freeze([sanitizedTable])
  }
  const dataVol = optionalOwnDataValue(response, 'dataVol')
  if (dataVol.present) sanitized.dataVol = dataVol.value
  return Object.freeze(sanitized)
}

function sanitizeQuoteSuccess(response, requestContract) {
  return sanitizeMarketSuccess(response, requestContract)
}

function sanitizeFinancialSuccess(response, requestContract) {
  return sanitizeMarketSuccess(response, requestContract)
}

/**
 * @param {{
 *   request?: (url: string, options: any, callback: (response: any) => void) => any,
 *   now?: () => Date,
 *   setTimer?: (handler: () => void, milliseconds: number) => any,
 *   clearTimer?: (timer: any) => void,
 *   logger?: any
 * }} [options]
 */
function createIfindHttpClient({
  request = https.request,
  now = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let generation = 0
  const activeAccessTokens = new Set()

  function clear() {
    generation += 1
    for (const token of activeAccessTokens) Buffer.prototype.fill.call(token, 0)
    activeAccessTokens.clear()
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
    let requestCount = 0
    let accessToken = null
    function discardAccessToken() {
      if (Buffer.isBuffer(accessToken)) {
        activeAccessTokens.delete(accessToken)
        Buffer.prototype.fill.call(accessToken, 0)
      }
      accessToken = null
    }
    try {
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

    async function authenticate() {
      try {
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
        const tokenErrorCode = protocolErrorCode(tokenResponse)
        if (tokenErrorCode !== 0) {
          throw safeError(
            'IFIND_AUTH_REJECTED',
            'AUTH',
            'iFinD access-token request failed',
            undefined,
            tokenErrorCode
          )
        }
        const tokenData = protocolDataValue(tokenResponse, 'data')
        const providerAccessToken = protocolDataValue(tokenData, 'access_token')
        if (!isHeaderSafeToken(providerAccessToken)) {
          throw safeError('IFIND_RESPONSE_SHAPE', 'API', 'iFinD response shape was invalid')
        }
        discardAccessToken()
        accessToken = Buffer.from(providerAccessToken, 'utf8')
        activeAccessTokens.add(accessToken)
        requireCurrentGeneration(operationGeneration)
      } catch (error) {
        throw withStage(error, 'auth')
      }
    }

    await authenticate()

    let probeResponse
    let probeDataVol = { present: false, value: undefined }
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        requireCurrentGeneration(operationGeneration)
        const tokenForProbe = accessToken
        if (!Buffer.isBuffer(tokenForProbe)) {
          throw safeError('IFIND_CONFIG_INVALID', 'CONFIG', 'iFinD client configuration was invalid')
        }
        requestCount += 1
        probeResponse = await requestJson(
          request,
          '/api/v1/get_trade_dates',
          {
            access_token: tokenForProbe.toString('utf8'),
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
            startdate: DIAGNOSTIC_REFERENCE_DATE
          },
          setTimer,
          clearTimer
        )
        requireCurrentGeneration(operationGeneration)
        const probeErrorCode = protocolErrorCode(probeResponse)
        if (probeErrorCode === 0) break
        const failureClass = classifyProbeFailure(probeErrorCode)
        if (failureClass === 'AUTH' && attempt === 1) {
          discardAccessToken()
          throw safeError(
            'IFIND_AUTH_REJECTED',
            'AUTH',
            'iFinD authentication failed',
            undefined,
            probeErrorCode
          )
        }
        const failureDataVol = protocolDataVol(probeResponse)
        const safeFailureDataVol = failureDataVol.present ? failureDataVol.value : undefined
        if (failureClass === 'PERMISSION') {
          throw safeError(
            'IFIND_PERMISSION_REJECTED',
            'PERMISSION',
            'iFinD permission denied',
            safeFailureDataVol,
            probeErrorCode
          )
        }
        if (failureClass === 'QUOTA') {
          throw safeError(
            'IFIND_QUOTA_REJECTED',
            'QUOTA',
            'iFinD quota unavailable',
            safeFailureDataVol,
            probeErrorCode
          )
        }
        if (failureClass !== 'AUTH') {
          throw safeError(
            'IFIND_PROBE_REJECTED',
            'API',
            'iFinD trade-date probe failed',
            safeFailureDataVol,
            probeErrorCode
          )
        }
        discardAccessToken()
        await authenticate()
      }

      const probeTables = protocolDataValue(probeResponse, 'tables')
      const probeTimes = protocolDataValue(probeTables, 'time')
      probeDataVol = protocolDataVol(probeResponse)
      if (!Array.isArray(probeTimes) ||
          probeTimes.length === 0 ||
          !probeTimes.every(isCanonicalCalendarDate)) {
        throw safeError('IFIND_RESPONSE_SHAPE', 'API', 'iFinD response shape was invalid')
      }
    } catch (error) {
      throw withStage(error, 'probe')
    }

    const retrievedAt = readNow()
    requireCurrentGeneration(operationGeneration)
    const hasDataVol = probeDataVol.present
    return {
      route: '/api/v1/get_trade_dates',
      scope: 'market-trade-dates:212001:D:-10',
      retrievedAt: retrievedAt.toISOString(),
      timezone: 'Asia/Shanghai',
      elapsedMs: Math.max(0, retrievedAt.getTime() - startedAt.getTime()),
      requestCount,
      dataVol: hasDataVol ? probeDataVol.value : 'unavailable',
      officialQuotaStatus: 'unavailable',
      completeness: hasDataVol ? 'complete' : 'partial'
    }
    } catch (error) {
      throw withRequestCount(error, requestCount)
    } finally {
      discardAccessToken()
    }
  }

  async function authenticateMarket(refreshTokenInput) {
    let requestCount = 0
    let accessToken = null
    let transferred = false
    function discardAccessToken() {
      if (Buffer.isBuffer(accessToken)) {
        activeAccessTokens.delete(accessToken)
        Buffer.prototype.fill.call(accessToken, 0)
      }
      accessToken = null
    }
    try {
      let refreshToken
      try {
        if (types.isProxy(refreshTokenInput)) throw new Error('invalid request')
        refreshToken = Buffer.isBuffer(refreshTokenInput)
          ? new TextDecoder('utf-8', { fatal: true }).decode(refreshTokenInput)
          : refreshTokenInput
        if (!isHeaderSafeToken(refreshToken)) throw new Error('invalid request')
      } catch {
        throw withStage(
          safeError('IFIND_CONFIG_INVALID', 'CONFIG', 'iFinD client configuration was invalid'),
          'auth'
        )
      }
      const operationGeneration = generation
      try {
        requireCurrentGeneration(operationGeneration)
        requestCount += 1
        const tokenResponse = await requestJson(
          request,
          ENDPOINTS.auth,
          { refresh_token: refreshToken },
          undefined,
          setTimer,
          clearTimer
        )
        requireCurrentGeneration(operationGeneration)
        const tokenErrorCode = protocolErrorCode(tokenResponse)
        if (tokenErrorCode !== 0) {
          throw safeError(
            'IFIND_AUTH_REJECTED',
            'AUTH',
            'iFinD access-token request failed',
            undefined,
            tokenErrorCode
          )
        }
        const tokenData = protocolDataValue(tokenResponse, 'data')
        const providerAccessToken = protocolDataValue(tokenData, 'access_token')
        if (!isHeaderSafeToken(providerAccessToken)) {
          throw safeError('IFIND_RESPONSE_SHAPE', 'API', 'iFinD response shape was invalid')
        }
        accessToken = Buffer.from(providerAccessToken, 'utf8')
        activeAccessTokens.add(accessToken)
        requireCurrentGeneration(operationGeneration)
        transferred = true
        return Object.freeze({ accessToken, requestCount: 1 })
      } catch (error) {
        throw withStage(error, 'auth')
      }
    } catch (error) {
      throw withRequestCount(error, requestCount)
    } finally {
      if (!transferred) discardAccessToken()
    }
  }

  async function executeMarketOperation(operation, accessTokenInput, requestInput, calibration = false) {
    let requestCount = 0
    try {
      let operationInput
      let accessToken
      try {
        if (types.isProxy(accessTokenInput) || !Buffer.isBuffer(accessTokenInput)) {
          throw new Error('invalid request')
        }
        accessToken = new TextDecoder('utf-8', { fatal: true }).decode(accessTokenInput)
        if (!isHeaderSafeToken(accessToken)) throw new Error('invalid request')
        operationInput = calibration
          ? Object.freeze({
              vendorCode: '9988.HK',
              fieldIds: Object.freeze(['revenue_oas']),
              body: CALIBRATION_REQUEST
            })
          : readOperationRequest(requestInput, operation)
      } catch {
        throw withStage(
          safeError('IFIND_CONFIG_INVALID', 'CONFIG', 'iFinD client configuration was invalid'),
          operation
        )
      }
      const operationGeneration = generation
      try {
        requireCurrentGeneration(operationGeneration)
        requestCount += 1
        const response = await requestJson(
          request,
          ENDPOINTS[operation],
          {
            access_token: accessToken,
            ifindlang: 'cn'
          },
          operationInput.body,
          setTimer,
          clearTimer
        )
        requireCurrentGeneration(operationGeneration)
        const responseErrorCode = protocolErrorCode(response)
        if (responseErrorCode === 0) {
          let calibrationDataVol
          try {
            const dataVol = protocolDataVol(response)
            if (calibration && dataVol.present) calibrationDataVol = dataVol.value
            const payload = operation === 'quote'
              ? sanitizeQuoteSuccess(response, operationInput)
              : sanitizeFinancialSuccess(response, operationInput)
            return Object.freeze({
              payload,
              requestCount: 1,
              dataVol: dataVol.present ? dataVol.value : null
            })
          } catch {
            throw safeError(
              'IFIND_RESPONSE_SHAPE', 'API', 'iFinD response shape was invalid',
              calibrationDataVol
            )
          }
        }

        const failureClass = classifyProbeFailure(responseErrorCode)
        if (failureClass === 'AUTH') {
          throw safeError(
            'IFIND_AUTH_REJECTED',
            'AUTH',
            'iFinD authentication failed',
            undefined,
            responseErrorCode
          )
        }
        const failureDataVol = protocolDataVol(response)
        const safeFailureDataVol = failureDataVol.present ? failureDataVol.value : undefined
        if (failureClass === 'PERMISSION') {
          throw safeError(
            'IFIND_PERMISSION_REJECTED',
            'PERMISSION',
            'iFinD permission denied',
            safeFailureDataVol,
            responseErrorCode
          )
        }
        if (failureClass === 'QUOTA') {
          throw safeError(
            'IFIND_QUOTA_REJECTED',
            'QUOTA',
            'iFinD quota unavailable',
            safeFailureDataVol,
            responseErrorCode
          )
        }
        throw safeError(
          operation === 'quote' ? 'IFIND_QUOTE_REJECTED' : 'IFIND_FINANCIAL_REJECTED',
          'API',
          operation === 'quote'
            ? 'iFinD quote request failed'
            : 'iFinD financial request failed',
          safeFailureDataVol,
          responseErrorCode
        )
      } catch (error) {
        throw withStage(error, operation)
      }
    } catch (error) {
      throw withRequestCount(error, requestCount)
    }
  }

  function quote(accessToken, fixedRequest) {
    return executeMarketOperation('quote', accessToken, fixedRequest)
  }

  function financial(accessToken, fixedRequest) {
    return executeMarketOperation('financial', accessToken, fixedRequest)
  }

  function calibrateFinancial(accessToken) {
    return executeMarketOperation('financial', accessToken, undefined, true)
  }

  const client = { diagnose, authenticate: authenticateMarket, quote, financial, calibrateFinancial }
  Object.defineProperty(client, 'clear', { value: clear })
  return client
}

module.exports = { createIfindHttpClient }
