'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { DatabaseSync } = require('node:sqlite')
const { createIfindHttpClient } = require('../adapters/ifind-http-client')
const { createIfindDiagnosticRuntime } = require('../ifind-diagnostic-runtime')
const { createRequestHandler } = require('../server')

const NOW = Date.parse('2026-08-31T04:00:00.000Z')
const ORIGIN = 'https://dearmina.cn'
const PATH = '/api/admin/ifind/report-period-diagnostic'
const ADMIN = 'A'.repeat(43)
const CSRF = 'C'.repeat(43)
const BODY = { codes: '9988.HK', indipara: [
  { indicator: 'revenue_oas', indiparams: ['20260331', '1', 'BB'] },
  { indicator: 'report_sd', indiparams: ['20260331', '1'] },
  { indicator: 'report_ed', indiparams: ['20260331', '1'] }
] }
/** @param {any} [table] Includes intentionally malformed provider columns. */
const response = (table = { revenue_oas: ['247652000000'], report_sd: ['2026-01-01'],
  report_ed: ['2026-03-31'] }) => ({ errorcode: 0, dataVol: 3,
  tables: [{ thscode: '9988.HK', table }] })

function transport(responses) {
  const calls = []; const queue = [...responses]
  return { calls, request(url, options, callback) {
    const call = { url, options, body: '' }; calls.push(call)
    return Object.assign(new EventEmitter(), {
      write(text) { call.body += text }, destroy() {}, end() {
        assert.ok(queue.length > 0, 'no retry or unexpected network call')
        const next = queue.shift()
        queueMicrotask(() => {
          const incoming = Object.assign(new EventEmitter(), { statusCode: 200, destroy() {} })
          callback(incoming)
          incoming.emit('data', Buffer.from(typeof next === 'string' ? next : JSON.stringify(next)))
          incoming.emit('end')
        })
      }
    })
  } }
}

function accessRuntime() {
  const session = { sessionId: 'report-period-test', idleExpiresAt: NOW + 1_800_000,
    absoluteExpiresAt: NOW + 28_800_000 }
  return { status: { mode: 'device-approval' },
    deviceApproval: { authenticate() { throw new Error('INVALID_DEVICE') } },
    adminAuth: {
      authenticate(token) { if (token !== ADMIN) throw new Error('INVALID_ADMIN'); return session },
      authenticateMutation(token, csrf) {
        if (token !== ADMIN) return { status: 'session-invalid' }
        if (csrf !== CSRF) return { status: 'csrf-invalid' }
        return { status: 'authenticated', ...session }
      }
    }
  }
}

async function invoke(handler, { method = 'GET', url = PATH, headers = {}, body = '',
  address = '127.0.0.1', duplicate = null } = {}) {
  const req = Object.assign(new PassThrough(), { method, url, socket: { remoteAddress: address },
    headers: { cookie: `__Host-kinvest-admin=${ADMIN}`, origin: ORIGIN,
      'x-real-ip': '203.0.113.24', 'x-forwarded-for': '203.0.113.24',
      'x-kinvest-csrf': CSRF, 'content-type': 'application/json', ...headers }, rawHeaders: [] })
  for (const key of Object.keys(req.headers)) if (req.headers[key] === undefined) delete req.headers[key]
  req.rawHeaders = Object.entries(req.headers).flat()
  if (duplicate) req.rawHeaders.push(duplicate, req.headers[duplicate] || '1', duplicate, '1')
  const responseHeaders = {}
  const res = { statusCode: 200, headersSent: false, body: '',
    setHeader(name, value) { responseHeaders[name.toLowerCase()] = value },
    getHeader(name) { return responseHeaders[name.toLowerCase()] },
    writeHead(status, values) { this.statusCode = status; this.headersSent = true; Object.assign(responseHeaders, values) },
    end(value) { this.body = value || '' }, destroy() { throw new Error('UNEXPECTED_DESTROY') } }
  const running = handler(req, res); req.end(body); await running
  return { status: res.statusCode, body: JSON.parse(res.body), headers: responseHeaders }
}

async function transportContract() {
  const network = transport([response()]); const client = createIfindHttpClient({ request: network.request })
  assert.equal(typeof client.diagnoseReportPeriod, 'function', 'fixed report-period transport method missing')
  const output = await client.diagnoseReportPeriod(Buffer.from('synthetic-access'))
  assert.equal(output.requestCount, 1); assert.equal(output.dataVol, 3)
  assert.equal(network.calls.length, 1)
  assert.equal(network.calls[0].url, 'https://quantapi.51ifind.com/api/v1/basic_data_service')
  assert.equal(network.calls[0].options.method, 'POST')
  assert.equal(network.calls[0].options.headers.access_token, 'synthetic-access')
  assert.equal(network.calls[0].body, JSON.stringify(BODY)); client.clear()

  const legacyPayload = { ...response({ revenue_oas: [123], unrelated: ['UNTRUSTED'] }), errmsg: 'UNTRUSTED' }
  const legacyNetwork = transport([legacyPayload])
  const legacy = createIfindHttpClient({ request: legacyNetwork.request })
  const old = await legacy.calibrateFinancial(Buffer.from('synthetic-access'))
  assert.deepEqual(JSON.parse(legacyNetwork.calls[0].body), { codes: '9988.HK', indipara: [BODY.indipara[0]] })
  assert.deepEqual(old.payload.tables[0].table, { revenue_oas: [123] })
  assert.doesNotMatch(JSON.stringify(old), /UNTRUSTED/); legacy.clear()

  for (const table of [{ revenue_oas: [null] }, { revenue_oas: [1], report_sd: ['2026-01-01'] }]) {
    const net = transport([response(table)]); const c = createIfindHttpClient({ request: net.request })
    const value = await c.diagnoseReportPeriod(Buffer.from('synthetic-access'))
    assert.deepEqual(value.payload.tables[0].table, table); assert.equal(net.calls.length, 1); c.clear()
  }
  for (const value of [{ errorcode: -401 }, { ...response(), dataVol: -1 },
    response({ revenue_oas: [1], unknown: [1] }), response({ revenue_oas: [1], report_sd: ['2026-02-30'] }),
    { ...response(), tables: [...response().tables, ...response().tables] }]) {
    const net = transport([value]); const c = createIfindHttpClient({ request: net.request })
    await assert.rejects(c.diagnoseReportPeriod(Buffer.from('synthetic-access')),
      /** @param {any} error */ (error) => error.requestCount === 1 && error.stage === 'financial')
    assert.equal(net.calls.length, 1); c.clear()
  }
}

async function rawJsonContract() {
  const base = JSON.stringify(response())
  const duplicateWires = [
    base.replace('"revenue_oas":["247652000000"]', '"revenue_oas":[1],"revenue_oas":["247652000000"]'),
    base.replace('"revenue_oas":["247652000000"]', String.raw`"revenue_oas":[1],"\u0072evenue_oas":["247652000000"]`),
    base.replace('"report_sd":["2026-01-01"]', String.raw`"report_sd":["2025-01-01"],"report_\u0073d":["2026-01-01"]`),
    base.replace('"report_ed":["2026-03-31"]', '"report_ed":[null],"report_ed":["2026-03-31"]'),
    base.replace('"thscode":"9988.HK"', '"thscode":"wrong","thscode":"9988.HK"'),
    base.replace('"errorcode":0', String.raw`"errorcode":-401,"\u0065rrorcode":0`),
    base.replace('"dataVol":3', '"dataVol":0,"dataVol":3'),
    base.replace('{"errorcode":0', String.raw`{"metadata":{"nested":{"same":1,"s\u0061me":2}},"errorcode":0`),
    base.replace('{"errorcode":0', String.raw`{"metadata":[{"":1,"":2}],"errorcode":0`),
    base.replace('{"errorcode":0', String.raw`{"metadata":{"a\\b":1,"a\u005cb":2},"errorcode":0`)
  ]
  const { IfindMarketDiagnosticRepository } = require('../db/ifind-market-diagnostic-repository')
  const { createIfindReportPeriodDiagnosticService } = require('../services/ifind-report-period-diagnostic-service')
  for (const raw of duplicateWires) {
    const network = transport([raw])
    const client = createIfindHttpClient({ request: network.request })
    await assert.rejects(client.diagnoseReportPeriod(Buffer.from('synthetic-access')),
      /** @param {any} error */ (error) => error.code === 'IFIND_RESPONSE_JSON' &&
        error.requestCount === 1 && error.stage === 'financial' && !JSON.stringify(error).includes('247652'))
    assert.equal(network.calls.length, 1, 'duplicate wire keys cannot retry')
    client.clear()

    const db = new DatabaseSync(':memory:')
    const repository = new IfindMarketDiagnosticRepository(db)
    repository.initialize()
    const serviceNetwork = transport([{ errorcode: 0, data: { access_token: 'synthetic-access' } }, raw])
    const serviceClient = createIfindHttpClient({ request: serviceNetwork.request })
    const refresh = Buffer.from('synthetic-refresh')
    let reads = 0
    const service = createIfindReportPeriodDiagnosticService({ repository, client: serviceClient,
      tokenVersionId: 'v20260831-001', clock: () => NOW,
      secretProvider: { readRefreshToken() { reads += 1; return refresh } } })
    try {
      const result = await service.run()
      assert.equal(result.status, 'failed')
      assert.equal(result.errorCode, 'IFIND_REPORT_PERIOD_DIAGNOSTIC_FAILED')
      assert.equal(result.observation, null)
      assert.equal(result.requestCount, 2)
      assert.equal(result.businessRequestCount, 1)
      assert.equal(result.dataVol, null, 'ambiguous wire volume cannot enter bookkeeping')
      assert.equal(serviceNetwork.calls.length, 2)
      assert.equal(reads, 1)
      assert.ok(refresh.every((byte) => byte === 0))
      const ledger = db.prepare('SELECT * FROM ifind_market_case_runs').get()
      assert.equal(ledger.status, 'failed')
      assert.equal(ledger.request_count, 2)
      assert.equal(ledger.failure_code, 'IFIND_REPORT_PERIOD_DIAGNOSTIC_FAILED')
      assert.equal(ledger.data_vol, null)
      for (const table of ['ifind_market_quote_snapshots', 'ifind_market_financial_points']) {
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0)
      }
      assert.equal((await service.run()).status, 'cooldown')
      assert.equal(serviceNetwork.calls.length, 2)
      assert.equal(reads, 1)
    } finally { service.clear(); serviceClient.clear(); db.close() }
  }

  // Old calibration intentionally retains its original last-key JSON behavior.
  const oldNetwork = transport([duplicateWires[0]])
  const oldClient = createIfindHttpClient({ request: oldNetwork.request })
  const oldResult = await oldClient.calibrateFinancial(Buffer.from('synthetic-access'))
  assert.deepEqual(oldResult.payload.tables[0].table, { revenue_oas: ['247652000000'] })
  assert.equal(oldNetwork.calls.length, 1)
  oldClient.clear()

  const { assertReportPeriodDiagnosticJson } = require('../adapters/ifind-report-period-json')
  const valid = [base, 'null', '[true,false,null,-1.25e+2,0,1E-2]',
    String.raw`{"a":1,"nested":{"a":2},"text":"braces {}, comma, colon: quote\" slash\/ backslash\\ \u0072"}`,
    '['.repeat(32) + '0' + ']'.repeat(32), JSON.stringify('x'.repeat(16_384))]
  const invalid = [...duplicateWires, '[1,]', '{"a":1,}', '{"a" 1}', '[01]', '[1.]', '[1e+]',
    '[+1]', '[.1]', 'tru', 'null false', '"unterminated', '"line\nfeed"', String.raw`"\x41"`,
    String.raw`"\u00xz"`, '['.repeat(33) + '0' + ']'.repeat(33), JSON.stringify('x'.repeat(16_385))]
  const originalParse = JSON.parse
  let parseCalls = 0
  JSON.parse = () => { parseCalls += 1; throw new Error('JSON.parse must not precede duplicate validation') }
  try {
    for (const raw of valid) assert.doesNotThrow(() => assertReportPeriodDiagnosticJson(raw))
    for (const raw of invalid) assert.throws(() => assertReportPeriodDiagnosticJson(raw))
    assert.equal(parseCalls, 0)
  } finally { JSON.parse = originalParse }

  for (const [metadata, code] of [
    ['['.repeat(33) + '0' + ']'.repeat(33), 'IFIND_RESPONSE_JSON'],
    [JSON.stringify('x'.repeat(16_385)), 'IFIND_RESPONSE_JSON'],
    [JSON.stringify('x'.repeat(256 * 1024)), 'IFIND_RESPONSE_TOO_LARGE']
  ]) {
    const raw = base.replace('{"errorcode":0', '{"metadata":' + metadata + ',"errorcode":0')
    const network = transport([raw]); const client = createIfindHttpClient({ request: network.request })
    await assert.rejects(client.diagnoseReportPeriod(Buffer.from('synthetic-access')),
      /** @param {any} error */ (error) => error.code === code && error.requestCount === 1)
    assert.equal(network.calls.length, 1); client.clear()
  }
  // Repeated names in separate objects and JSON punctuation inside strings are not duplicates.
  const safeMetadata = String.raw`{"metadata":{"same":1,"child":{"same":2},"text":"\"revenue_oas\":{}\\\u0072"},"errorcode":0`
  const validNetwork = transport([base.replace('{"errorcode":0', safeMetadata)])
  const validClient = createIfindHttpClient({ request: validNetwork.request })
  assert.equal((await validClient.diagnoseReportPeriod(Buffer.from('synthetic-access'))).requestCount, 1)
  validClient.clear()
}

async function runtimeHttpContract() {
  const db = new DatabaseSync(':memory:')
  const network = transport([{ errorcode: 0, data: { access_token: 'synthetic-access' } }, response()])
  let reads = 0; const buffers = []; const clients = []; const clears = []
  const runtime = await createIfindDiagnosticRuntime({
    env: { KINVEST_IFIND_DIAGNOSTIC_MODE: 'admin-diagnostic',
      KINVEST_IFIND_SECRET_BUNDLE_PATH: '/run/secrets/kinvest-ifind',
      KINVEST_IFIND_REFRESH_TOKEN_VERSION_ID: 'v20260831-001' },
    accessRuntime: accessRuntime(), openDatabase: () => db, clock: () => NOW,
    loadSecrets: async () => ({ readRefreshToken() {
      reads += 1; const buffer = Buffer.from('synthetic-refresh'); buffers.push(buffer); return buffer
    }, clear() {} }),
    createClient() {
      const real = createIfindHttpClient({ request: network.request }); const index = clients.length
      const client = { ...real, clear() { clears[index] = (clears[index] || 0) + 1; real.clear() } }
      clients.push(client); return client
    }
  })
  try {
    assert.ok(runtime.reportPeriodService)
    assert.equal(clients.length, 3, 'report-period diagnostic has its own client')
    const makeHandler = /** @param {any} [value] */ (value = runtime) => createRequestHandler({ accessRuntime: accessRuntime(),
      ifindDiagnosticRuntime: value, now: () => NOW, publicOrigin: ORIGIN, trustedProxyAddresses: ['127.0.0.1'] })
    const handler = makeHandler()
    const initial = await invoke(handler)
    assert.equal(initial.status, 200); assert.equal(initial.body.data.status, 'ready')
    assert.equal(network.calls.length, 0); assert.equal(reads, 0)
    assert.equal(initial.headers['Cache-Control'], 'no-store')
    /** @type {Array<[any, number]>} */
    const blocked = [
      [{ headers: { cookie: undefined } }, 401], [{ headers: { cookie: '' } }, 400],
      [{ headers: { cookie: `__Host-kinvest-device=${ADMIN}` } }, 401],
      [{ headers: { cookie: `__Host-kinvest-admin=${'B'.repeat(43)}` } }, 401],
      [{ headers: { origin: undefined } }, 403], [{ headers: { origin: 'https://attacker.invalid' } }, 403],
      [{ headers: { 'x-kinvest-csrf': undefined } }, 403],
      [{ headers: { 'x-kinvest-csrf': 'B'.repeat(43) } }, 403],
      [{ headers: { 'content-type': 'text/plain' } }, 415],
      [{ headers: { 'content-length': '4097' } }, 413],
      [{ body: '{"codes":"AAPL.US"}' }, 400], [{ body: '{"selector":"20260331"}' }, 400],
      [{ body: '{"a":1,"a":2}' }, 400], [{ body: '[]' }, 400], [{ body: 'null' }, 400],
      [{ body: '' }, 400], [{ body: '{' }, 400], [{ body: '{"x":"' + 'a'.repeat(4200) + '"}' }, 413],
      [{ url: `${PATH}/run?x=1` }, 404], [{ url: `${PATH}/run/` }, 404],
      [{ url: `${PATH}/%72un` }, 404], [{ method: 'PUT' }, 404],
      [{ address: '203.0.113.99' }, 403],
      [{ headers: { 'x-real-ip': 'invalid' } }, 400]
    ]
    for (const header of ['cookie', 'origin', 'x-kinvest-csrf', 'content-type', 'content-length',
      'transfer-encoding', 'x-real-ip', 'x-forwarded-for']) blocked.push([{ duplicate: header }, 400])
    for (const [options, expected] of blocked) {
      const result = await invoke(handler, { method: 'POST', url: `${PATH}/run`, body: '{}', ...options })
      assert.equal(result.status, expected, JSON.stringify(options))
      assert.equal(network.calls.length, 0); assert.equal(reads, 0)
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ifind_market_case_runs').get().n, 0)
    }
    for (const options of [{ url: PATH + '?x=1' }, { url: PATH + '/' },
      { headers: { origin: 'https://attacker.invalid' } }, { headers: { cookie: undefined } }]) {
      const result = await invoke(handler, options); assert.ok(result.status >= 400)
      assert.equal(reads, 0); assert.equal(network.calls.length, 0)
    }
    const observed = await invoke(handler, { method: 'POST', url: `${PATH}/run`, body: '{}' })
    assert.equal(observed.status, 200); assert.equal(observed.body.data.status, 'observed-unverified')
    assert.equal(observed.body.data.observation.revenue.value, 247652000000)
    assert.equal(observed.body.data.observation.dateEvidence.revenuePeriodLink, 'unverified')
    assert.equal(observed.body.data.requestCount, 2); assert.equal(observed.body.data.businessRequestCount, 1)
    assert.ok(Object.values(observed.body.data.verification).every((value) => value === 'unverified'))
    assert.equal(reads, 1); assert.equal(network.calls.length, 2)
    assert.equal(network.calls[1].body, JSON.stringify(BODY))
    assert.equal(clears[1] || 0, 0, 'report diagnostic cannot clear calibration/market client')
    assert.equal(clears[2], 1); assert.ok(buffers.every((buffer) => buffer.every((byte) => byte === 0)))
    const row = db.prepare('SELECT * FROM ifind_market_case_runs').get()
    assert.equal(row.status, 'failed')
    assert.equal(row.failure_code, 'IFIND_REPORT_PERIOD_DIAGNOSTIC_OBSERVED_UNVERIFIED')
    assert.doesNotMatch(JSON.stringify(row), /247652|2026-01-01|synthetic/)
    for (const table of ['ifind_market_quote_snapshots', 'ifind_market_financial_points']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0)
    }
    assert.deepEqual((await invoke(handler)).body, observed.body)
    const blockedCalibration = await invoke(handler, { method: 'POST',
      url: '/api/admin/ifind/calibration/run', body: '{}' })
    assert.equal(blockedCalibration.body.data.status, 'cooldown')
    assert.equal(clears[1] || 0, 0)

    const hostile = structuredClone(observed.body.data)
    hostile.observation.dateEvidence.revenuePeriodLink = 'verified'
    const badHandler = makeHandler({ ...runtime, reportPeriodService: { describe: () => hostile, run: async () => hostile } })
    const rejected = await invoke(badHandler)
    assert.deepEqual(rejected.body, { error: 'INTERNAL_ERROR' }); assert.equal(rejected.status, 500)
    let traps = 0
    const getter = structuredClone(observed.body.data)
    Object.defineProperty(getter.observation, 'dateEvidence', { enumerable: true,
      get() { traps += 1; throw new Error('UNTRUSTED') } })
    const getterHandler = makeHandler({ ...runtime, reportPeriodService: { describe: () => getter, run: async () => getter } })
    assert.equal((await invoke(getterHandler)).status, 500); assert.equal(traps, 0)
    const unavailable = await invoke(makeHandler({ ...runtime, reportPeriodService: null }))
    assert.equal(unavailable.status, 503)
    assert.deepEqual(unavailable.body, { error: 'IFIND_REPORT_PERIOD_DIAGNOSTIC_UNAVAILABLE' })
    assert.equal(network.calls.length, 2)
    runtime.clear()
    assert.equal(runtime.reportPeriodService.describe().observation, null)
  } finally { runtime.clear(); db.close() }
}

module.exports = { run: async function () {
  await rawJsonContract(); console.log('PASS report-period integration: raw duplicate JSON, parsing limits and failed settlement')
  await transportContract(); console.log('PASS report-period integration: fake HTTPS and calibration preservation')
  await runtimeHttpContract(); console.log('PASS report-period integration: runtime, HTTP gates, SQLite and isolation')
  console.log('ifind-report-period-diagnostic-integration: 3 tests passed')
} }
