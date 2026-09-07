'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createIfindHttpClient } = require('../adapters/ifind-http-client')

const PROPOSAL_ID = 'HK_ALIBABA_9988_V1'
const MARKER = 'SYNTHETIC_PRIVATE_VENDOR_TEXT'
const FIELDS = [
  ['ths_stock_short_name_stock'],
  ['latest', 'preClose', 'open', 'high', 'low', 'amount', 'volume', 'tradeDate', 'tradeTime'],
  ['revenue_oas']
]
const STAGES = ['identity', 'quote', 'financial']

/** @returns {{errorcode: number, tables: Array<{thscode: string, table: Record<string, unknown[]>}>, dataVol?: number}} */
function payload(sequence = 1) {
  return { errorcode: 0, tables: [{ thscode: '9988.HK',
    table: Object.fromEntries(FIELDS[sequence - 1].map((field) => [field, [1]])) }],
  dataVol: 1 }
}

function metadata() {
  // Response keys documented in docs/operations/ifind-admin-diagnostic-contract.md.
  // Request indicators alone are not evidence for a response-envelope key.
  return { errmsg: MARKER, perf: 0.012, datatype: ['string'],
    inputParams: { codes: '9988.HK', indipara: [{ indicator: MARKER }] } }
}

function transport(body) {
  const calls = []
  const request = (url, options, callback) => {
    let written = ''
    const outgoing = /** @type {any} */ (new EventEmitter())
    outgoing.write = (chunk) => { written += chunk }
    outgoing.setTimeout = () => {}
    outgoing.destroy = () => {}
    outgoing.end = () => {
      calls.push({ url, options, body: JSON.parse(written) })
      queueMicrotask(() => {
        const incoming = /** @type {any} */ (new EventEmitter())
        incoming.statusCode = 200
        incoming.destroy = () => {}
        callback(incoming)
        incoming.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
        incoming.emit('end')
      })
    }
    return outgoing
  }
  return { calls, request }
}

async function probe(body, sequence = 1) {
  const network = transport(body)
  const logs = []
  const logger = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug']
    .map((level) => [level, (...args) => logs.push(args)]))
  const client = createIfindHttpClient({ request: network.request, logger })
  try {
    return await client.probeFixed(Buffer.from('synthetic-access'), PROPOSAL_ID, sequence)
  } finally {
    client.clear()
    assert.equal(network.calls.length, 1, 'fixed probes must never retry or authenticate')
    assert.equal(network.calls[0].options.method, 'POST')
    assert.equal(network.calls[0].body.codes, '9988.HK')
    assert.deepEqual(logs, [])
  }
}

function safeFailure(code, errorClass = 'API', vendorErrorCode = null, dataVol = undefined) {
  return (error) => {
    assert.equal(error.code, code)
    assert.equal(error.failureCode, code)
    assert.equal(error.class, errorClass)
    assert.equal(error.vendorErrorCode, vendorErrorCode)
    assert.equal(error.stage, 'probe')
    assert.equal(error.requestCount, 1)
    assert.equal(error.dataVol, dataVol)
    const allowed = ['stack', 'message', 'code', 'class', 'failureCode',
      'vendorErrorCode', 'stage', 'requestCount', 'dataVol']
    assert.ok(Object.getOwnPropertyNames(error).every((key) => allowed.includes(key)))
    assert.doesNotMatch(JSON.stringify(Object.getOwnPropertyDescriptors(error)),
      /SYNTHETIC_PRIVATE_VENDOR_TEXT|synthetic-access|RequestId|rawResponse|cause/)
    return true
  }
}

function frozenTree(value) {
  if (value === null || typeof value !== 'object') return
  assert.ok(Object.isFrozen(value))
  for (const item of Object.values(value)) frozenTree(item)
}

/** @type {Array<[string, () => Promise<void>]>} */
const tests = [
  ['projects documented envelope metadata into the exact frozen success payload', async () => {
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const expected = payload(sequence)
      const result = await probe({ ...expected, ...metadata() }, sequence)
      assert.deepEqual(result, { stage: STAGES[sequence - 1], payload: expected,
        requestCount: 1, dataVol: 1 })
      frozenTree(result)
      assert.doesNotMatch(JSON.stringify(result), /errmsg|perf|datatype|inputParams|SYNTHETIC_PRIVATE/)
    }
  }],
  ['accepts each supported metadata field independently and preserves absent usage', async () => {
    for (const [key, value] of Object.entries(metadata())) {
      const expected = payload()
      delete expected.dataVol
      assert.deepEqual(await probe({ ...expected, [key]: value }),
        { stage: 'identity', payload: expected, requestCount: 1, dataVol: null })
    }
    const boundary = { ...payload(), errmsg: 'x'.repeat(4096), datatype: Array(64).fill(null) }
    assert.deepEqual((await probe(boundary)).payload, payload())
  }],
  ['classifies null-table vendor failures before success sanitization', async () => {
    /** @type {Array<[number, string, string]>} */
    const cases = [
      [-401, 'AUTH', 'IFIND_AUTH_REJECTED'],
      [-403, 'PERMISSION', 'IFIND_PERMISSION_REJECTED'],
      [-429, 'QUOTA', 'IFIND_QUOTA_REJECTED'],
      [-777, 'API', 'IFIND_PROBE_REJECTED']
    ]
    for (const [vendor, errorClass, code] of cases) {
      for (const includeMetadata of [false, true]) {
        for (const includeVolume of [false, true]) {
          const body = { errorcode: vendor, tables: null,
            ...(includeMetadata ? metadata() : {}), ...(includeVolume ? { dataVol: 0 } : {}) }
          await assert.rejects(probe(body),
            safeFailure(code, errorClass, vendor, includeVolume ? 0 : undefined))
        }
      }
      await assert.rejects(probe({ errorcode: vendor, ...metadata() }),
        safeFailure(code, errorClass, vendor))
    }
  }],
  ['preserves strict validation of non-null failure tables', async () => {
    const malformed = payload()
    malformed.errorcode = -403
    malformed.tables[0].table.extra = [MARKER]
    await assert.rejects(probe({ ...malformed, ...metadata() }), safeFailure('IFIND_RESPONSE_SHAPE'))
    await assert.rejects(probe({ ...payload(), ...metadata(), errorcode: -403 }),
      safeFailure('IFIND_PERMISSION_REJECTED', 'PERMISSION', -403, 1))
  }],
  ['rejects unknown and dangerous envelope keys rather than broadening the DTO', async () => {
    for (const key of ['RequestId', 'providerExtra', 'indicators', 'data', 'token',
      'access_token', 'headers', '__proto__', 'constructor', 'prototype']) {
      const body = { ...payload(), ...metadata() }
      Object.defineProperty(body, key, { value: MARKER, enumerable: true })
      await assert.rejects(probe(body), safeFailure('IFIND_RESPONSE_SHAPE'))
    }
  }],
  ['bounds discarded metadata strings, collections, nesting and total work', async () => {
    /** @type {Record<string, unknown>} */
    let nested = { leaf: null }
    for (let index = 0; index < 5; index += 1) nested = { next: nested }
    const dangerous = JSON.parse('{"__proto__":{"secret":"SYNTHETIC_PRIVATE_VENDOR_TEXT"}}')
    const invalid = [
      { errmsg: 'x'.repeat(4097) },
      { errmsg: '\u00e9'.repeat(2049) },
      { datatype: Array(65).fill(null) },
      { inputParams: Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['k' + i, 0])) },
      { inputParams: nested },
      { inputParams: [Array(64).fill(null), Array(64).fill(null)] },
      { inputParams: dangerous },
      { inputParams: { ['x'.repeat(257)]: null } }
    ]
    for (const fields of invalid) {
      await assert.rejects(probe({ ...payload(), ...fields }), safeFailure('IFIND_RESPONSE_SHAPE'))
    }
  }],
  ['keeps errorcode and usage validation strict despite accepted metadata', async () => {
    for (const errorcode of ['0', null, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(probe({ ...payload(), ...metadata(), errorcode }),
        safeFailure('IFIND_RESPONSE_SHAPE'))
    }
    for (const errorcode of [0, -401, -403, -429]) {
      for (const dataVol of [-1, null, '1', 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(probe({ ...payload(), ...metadata(), errorcode,
          tables: errorcode === 0 ? payload().tables : null, dataVol }),
        safeFailure('IFIND_RESPONSE_SHAPE'))
      }
    }
    await assert.rejects(probe({ tables: null, ...metadata() }), safeFailure('IFIND_RESPONSE_SHAPE'))
  }],
  ['retains exact success rows, requested fields and bounded scalar validation', async () => {
    const invalid = [
      null, [], [payload().tables[0], payload().tables[0]],
      [{ ...payload().tables[0], thscode: '09988.HK' }],
      [{ ...payload().tables[0], extra: MARKER }],
      [{ thscode: '9988.HK', table: {} }],
      [{ thscode: '9988.HK', table: { ...payload().tables[0].table, extra: [1] } }]
    ]
    for (const value of [[{}], [Array(1)], ['x'.repeat(257)], ['bad\u0000value'],
      ['bad\u0085value'], ['bad\u202evalue'], Array(65).fill(1)]) {
      invalid.push([{ thscode: '9988.HK', table: { ths_stock_short_name_stock: value } }])
    }
    for (const tables of invalid) {
      await assert.rejects(probe({ ...metadata(), errorcode: 0, tables }),
        safeFailure('IFIND_RESPONSE_SHAPE'))
    }
    await assert.rejects(probe({ errorcode: 0, ...metadata() }), safeFailure('IFIND_RESPONSE_SHAPE'))
    const expected = payload()
    expected.tables[0].table.ths_stock_short_name_stock = Array(64).fill('x'.repeat(256))
    assert.deepEqual((await probe({ ...expected, ...metadata() })).payload, expected)
  }],
  ['keeps wire-size and JSON failures safe and single-request', async () => {
    await assert.rejects(probe({ ...payload(), errmsg: MARKER.repeat(20000) }),
      safeFailure('IFIND_RESPONSE_TOO_LARGE'))
    await assert.rejects(probe('{"errmsg":"SYNTHETIC_PRIVATE_VENDOR_TEXT",'),
      safeFailure('IFIND_RESPONSE_JSON'))
  }],
  ['invalid requests perform no transport calls', async () => {
    const network = transport(payload())
    const client = createIfindHttpClient({ request: network.request })
    try {
      for (const [id, sequence] of [[PROPOSAL_ID, 0], [PROPOSAL_ID, 4], ['OTHER', 1]]) {
        await assert.rejects(client.probeFixed(Buffer.from('synthetic-access'), id, sequence),
          { code: 'IFIND_CONFIG_INVALID', class: 'CONFIG', stage: 'probe', requestCount: 0 })
      }
      assert.equal(network.calls.length, 0)
    } finally { client.clear() }
  }]
]

module.exports = { run: async function () {
  let failures = 0
  for (const [name, operation] of tests) {
    try {
      await operation()
      console.log('PASS market-probe-envelope: ' + name)
    } catch (error) {
      failures += 1
      console.error('FAIL market-probe-envelope: ' + name + ': ' + error.message)
    }
  }
  assert.equal(failures, 0, 'market-probe-envelope failing groups')
  console.log('ifind-market-probe-envelope: ' + tests.length + ' tests passed')
} }
