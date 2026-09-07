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
      'vendorErrorCode', 'stage', 'requestCount', 'dataVol', 'rejectionStage']
    assert.ok(Object.getOwnPropertyNames(error).every((key) => allowed.includes(key)))
    if (code !== 'IFIND_RESPONSE_SHAPE') assert.equal(Object.hasOwn(error, 'rejectionStage'), false)
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


function rejectionFailure(rejectionStage, dataVol = undefined) {
  return (error) => {
    safeFailure('IFIND_RESPONSE_SHAPE', 'API', null, dataVol)(error)
    assert.deepEqual(Object.getOwnPropertyDescriptor(error, 'rejectionStage'), {
      value: rejectionStage, enumerable: true, configurable: false, writable: false
    })
    assert.equal(error.message, 'iFinD response shape was invalid')
    assert.equal(Object.getOwnPropertySymbols(error).length, 0)
    return true
  }
}

// Isolated test-only seam: HTTP JSON cannot contain proxies/accessors. Inject after
// the JSON boundary to exercise the real fixed-probe validators without changing
// production exports or invoking hostile serialization hooks.
let injectedClientFactory
function injectedClient(response, failure = undefined) {
  if (!injectedClientFactory) {
    const Module = require('node:module')
    const filename = require.resolve('../adapters/ifind-http-client')
    const source = require('node:fs').readFileSync(filename, 'utf8')
    // Node's public typings omit these loader internals used only by this seam.
    const isolated = /** @type {InstanceType<typeof Module> & {
      paths: string[], _compile: (source: string, filename: string) => void
    }} */ (new Module(filename))
    isolated.filename = filename
    isolated.paths = (/** @type {{ paths: string[] }} */ (/** @type {unknown} */ (module))).paths
    isolated._compile(source + '\nmodule.exports = (response, failure) => {\n' +
      '  requestJson = async () => { if (failure !== undefined) throw failure; return response }\n' +
      '  return createIfindHttpClient({ request() { throw new Error("Offline only") } })\n' +
      '}\n', filename)
    injectedClientFactory = isolated.exports
  }
  return injectedClientFactory(response, failure)
}

async function injectedProbe(response, failure = undefined) {
  const client = injectedClient(response, failure)
  try {
    return await client.probeFixed(Buffer.from('synthetic-access'), PROPOSAL_ID, 1)
  } finally { client.clear() }
}

tests.push(
  ['reports envelope validator rejection without raw names or values', async () => {
    for (const body of [
      null, [], { ...payload(), [MARKER]: MARKER },
      { ...payload(), errmsg: MARKER.repeat(1000) },
      { ...payload(), errorcode: MARKER },
      { ...payload(), dataVol: MARKER },
      { ...payload(), errorcode: -403, tables: null, dataVol: -1 },
      { tables: [] }, { errorcode: 0 }
    ]) {
      await assert.rejects(probe(body), rejectionFailure('envelope'))
    }
  }],
  ['reports tables validator rejection for array and row structure', async () => {
    for (const tables of [null, [], {}, [null], [payload().tables[0], payload().tables[0]],
      [{ ...payload().tables[0], [MARKER]: MARKER }], [{ table: {} }],
      [{ thscode: '9988.HK' }]]) {
      await assert.rejects(probe({ errorcode: 0, tables }), rejectionFailure('tables'))
    }
  }],
  ['reports returned-code validator rejection without normalizing HK identity', async () => {
    for (const thscode of ['09988.HK', '9988.hk', '9988.HK ', MARKER, null, 9988, {}]) {
      await assert.rejects(probe({ errorcode: 0,
        tables: [{ ...payload().tables[0], thscode }] }), rejectionFailure('returned-code'))
    }
  }],
  ['reports exact indicator-field record rejection', async () => {
    for (const table of [null, [], {}, { [MARKER]: [MARKER] },
      { ...payload().tables[0].table, [MARKER]: [MARKER] }]) {
      await assert.rejects(probe({ errorcode: 0, tables: [{ thscode: '9988.HK', table }] }),
        rejectionFailure('indicator-fields'))
    }
  }],
  ['reports bounded field-value rejection', async () => {
    for (const values of [null, 1, {}, MARKER, [MARKER.repeat(100)], [{}],
      [[1]], Array(65).fill(1), ['bad\u0000value'], ['bad\u202evalue']]) {
      await assert.rejects(probe({ errorcode: 0, tables: [{ thscode: '9988.HK',
        table: { ths_stock_short_name_stock: values } }] }), rejectionFailure('field-values'))
    }
  }],
  ['keeps validation order and usage metadata on success and vendor-error paths', async () => {
    for (const errorcode of [0, -403]) {
      const malformed = payload()
      malformed.errorcode = errorcode
      malformed.tables[0].table.extra = [MARKER]
      await assert.rejects(probe(malformed),
        rejectionFailure('indicator-fields', errorcode === 0 ? 1 : undefined))
      await assert.rejects(probe({ ...malformed, dataVol: -1 }), rejectionFailure('envelope'))
    }
    const malformed = payload()
    malformed.tables[0].thscode = MARKER
    malformed.tables[0].table = {}
    await assert.rejects(probe(malformed), rejectionFailure('returned-code', 1))
  }],
  ['rejects proxies, accessors and sparse arrays at their actual boundary without traps', async () => {
    let traps = 0
    const trap = () => { traps += 1; throw new Error(MARKER) }
    const hostile = (value) => new Proxy(value, {
      // Promise assimilation precedes validation; let this fixture reach it.
      get(_target, key) { return key === 'then' ? undefined : trap() },
      ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap
    })
    const accessor = (value, key) => Object.defineProperty(value, key, {
      enumerable: true, configurable: true, get: trap
    })
    /** @type {Array<[string, unknown]>} */
    const cases = [
      ['envelope', hostile(payload())],
      ['envelope', accessor(payload(), 'dataVol')],
      ['envelope', { ...payload(), inputParams: hostile({}) }],
      ['envelope', { ...payload(), inputParams: accessor({}, 'secret') }],
      ['tables', { errorcode: 0, tables: hostile([]) }],
      ['tables', { errorcode: 0, tables: [hostile({})] }],
      ['tables', { errorcode: 0, tables: [accessor(payload().tables[0], 'thscode')] }],
      ['tables', { errorcode: 0, tables: Array(1) }],
      ['returned-code', { errorcode: 0,
        tables: [{ ...payload().tables[0], thscode: hostile({}) }] }],
      ['indicator-fields', { errorcode: 0,
        tables: [{ thscode: '9988.HK', table: hostile({}) }] }],
      ['indicator-fields', { errorcode: 0, tables: [{ thscode: '9988.HK',
        table: accessor({}, 'ths_stock_short_name_stock') }] }]
    ]
    for (const values of [hostile([]), accessor([1], '0'), Array(1), [NaN], [Infinity]]) {
      cases.push(['field-values', { errorcode: 0, tables: [{ thscode: '9988.HK',
        table: { ths_stock_short_name_stock: values } }] }])
    }
    for (const [stage, body] of cases) {
      await assert.rejects(injectedProbe(body), rejectionFailure(stage))
    }
    assert.equal(traps, 0)
  }],
  ['unknown origins cannot forge rejectionStage or leak hostile error properties', async () => {
    let traps = 0
    const failure = Object.defineProperties(new Error(MARKER), {
      rejectionStage: { get() { traps += 1; throw new Error(MARKER) } },
      code: { get() { traps += 1; throw new Error(MARKER) } }
    })
    await assert.rejects(injectedProbe(undefined, failure), (error) => {
      assert.ok(error instanceof Error)
      safeFailure('IFIND_RESPONSE_SHAPE')(error)
      assert.equal(Object.hasOwn(error, 'rejectionStage'), false)
      return true
    })
    // A revoked root proxy cannot pass Promise assimilation. Its origin is
    // unknown to the fixed validators, so it must not claim an envelope stage.
    const revoked = Proxy.revocable({}, {}); revoked.revoke()
    await assert.rejects(injectedProbe(revoked.proxy), (error) => {
      assert.ok(error instanceof Error)
      safeFailure('IFIND_RESPONSE_SHAPE')(error)
      assert.equal(Object.hasOwn(error, 'rejectionStage'), false)
      return true
    })
    assert.equal(traps, 0)
  }],
  ['does not add rejectionStage to other adapter shape failures', async () => {
    const client = injectedClient({ errorcode: MARKER })
    try {
      await assert.rejects(client.authenticate(Buffer.from('synthetic-refresh')), (error) => {
        assert.ok(error instanceof Error && 'code' in error && 'stage' in error)
        assert.equal(error.code, 'IFIND_RESPONSE_SHAPE')
        assert.equal(error.stage, 'auth')
        assert.equal(Object.hasOwn(error, 'rejectionStage'), false)
        assert.doesNotMatch(JSON.stringify(Object.getOwnPropertyDescriptors(error)), /SYNTHETIC_PRIVATE/)
        return true
      })
      const quoteRequest = Object.freeze({ vendorCode: '9988.HK',
        fields: Object.freeze(['latest']) })
      await assert.rejects(client.quote(Buffer.from('synthetic-access'), quoteRequest), (error) => {
        assert.ok(error instanceof Error && 'code' in error && 'stage' in error)
        assert.equal(error.code, 'IFIND_RESPONSE_SHAPE')
        assert.equal(error.stage, 'quote')
        assert.equal(Object.hasOwn(error, 'rejectionStage'), false)
        return true
      })
    } finally { client.clear() }
  }]
)

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
