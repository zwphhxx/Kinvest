'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { DatabaseSync } = require('node:sqlite')
const { createIfindHttpClient } = require('../adapters/ifind-http-client')
const { createIfindDiagnosticRuntime } = require('../ifind-diagnostic-runtime')
const { createRequestHandler } = require('../server')
const { expectedEvidence } = require('./ifind-report-period-evidence.test')

const NOW = Date.UTC(2026, 7, 30, 8)
const ORIGIN = 'https://dearmina.cn'
const PATH = '/api/admin/ifind/calibration'
const ADMIN = 'A'.repeat(43)
const CSRF = 'C'.repeat(43)
const FIXED_BODY = {
  codes: '9988.HK',
  indipara: [{ indicator: 'revenue_oas', indiparams: ['20260331', '1', 'BB'] }]
}

function success(value = 123.45) {
  return {
    errorcode: 0,
    errmsg: 'UNTRUSTED_PROVIDER_MESSAGE',
    RequestId: 'UNTRUSTED_REQUEST_ID',
    periodEvidence: {
      actualPeriod: { type: 'quarter', start: '2026-01-01', end: '2026-03-31' },
      decision: 'verified', references: [{ url: 'https://UNTRUSTED.invalid/' }]
    },
    dataVol: 7,
    tables: [{ thscode: '9988.HK', table: {
      revenue_oas: [value], unrelated: ['UNTRUSTED_PROVIDER_FIELD']
    } }]
  }
}

function transport(responses) {
  const calls = []
  const queue = [...responses]
  return {
    calls,
    request(url, options, callback) {
      const call = { url, options, body: '' }
      calls.push(call)
      return Object.assign(new EventEmitter(), {
        write(text) { call.body += text },
        destroy() {},
        end() {
          const response = queue.shift()
          queueMicrotask(() => {
            const incoming = Object.assign(new EventEmitter(), {
              statusCode: 200,
              destroy() {}
            })
            callback(incoming)
            incoming.emit('data', Buffer.from(JSON.stringify(response)))
            incoming.emit('end')
          })
        }
      })
    }
  }
}

function accessRuntime() {
  const session = {
    sessionId: 'admin-calibration-test',
    idleExpiresAt: NOW + 1_800_000,
    absoluteExpiresAt: NOW + 28_800_000
  }
  return {
    status: { mode: 'device-approval' },
    deviceApproval: { authenticate() { throw new Error('TOKEN_INVALID') } },
    adminAuth: {
      authenticate(token) {
        if (token !== ADMIN) throw new Error('ADMIN_SESSION_INVALID')
        return session
      },
      authenticateMutation(token, csrf) {
        if (token !== ADMIN) return { status: 'session-invalid' }
        if (csrf !== CSRF) return { status: 'csrf-invalid' }
        return { status: 'authenticated', ...session }
      }
    }
  }
}

async function invoke(handler, { method = 'GET', url = PATH,
  headers = {}, body = '', address = '127.0.0.1' } = {}) {
  const req = Object.assign(new PassThrough(), {
    method, url, socket: { remoteAddress: address },
    headers: {
      cookie: `__Host-kinvest-admin=${ADMIN}`,
      origin: ORIGIN,
      'x-real-ip': '203.0.113.24',
      'x-forwarded-for': '203.0.113.24',
      'x-kinvest-csrf': CSRF,
      'content-type': 'application/json',
      ...headers
    },
    rawHeaders: []
  })
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) delete req.headers[name]
  }
  req.rawHeaders = Object.entries(req.headers).flat()
  const responseHeaders = {}
  const res = {
    statusCode: 200, headersSent: false, body: '',
    setHeader(name, value) { responseHeaders[name.toLowerCase()] = value },
    getHeader(name) { return responseHeaders[name.toLowerCase()] },
    writeHead(status, values) {
      this.statusCode = status
      this.headersSent = true
      Object.assign(responseHeaders, values)
    },
    end(value) { this.body = value || '' },
    destroy() { throw new Error('UNEXPECTED_RESPONSE_DESTROY') }
  }
  const pending = handler(req, res)
  req.end(body)
  await pending
  return { status: res.statusCode, body: JSON.parse(res.body), headers: responseHeaders }
}

async function clientContract() {
  const network = transport([success()])
  const client = createIfindHttpClient({ request: network.request })
  assert.equal(typeof client.calibrateFinancial, 'function')
  const result = await client.calibrateFinancial(Buffer.from('fixture-access'))
  assert.equal(network.calls.length, 1)
  assert.equal(network.calls[0].url,
    'https://quantapi.51ifind.com/api/v1/basic_data_service')
  assert.deepEqual(JSON.parse(network.calls[0].body), FIXED_BODY)
  assert.equal(result.requestCount, 1)
  assert.equal(result.dataVol, 7)
  assert.deepEqual(result.payload.tables[0].table, { revenue_oas: [123.45] })
  assert.doesNotMatch(JSON.stringify(result), /UNTRUSTED/)
  client.clear()

  for (const response of [
    { errorcode: -401, errmsg: 'UNTRUSTED_PROVIDER_MESSAGE' },
    { ...success(), tables: [{ thscode: '09888.HK', table: { revenue_oas: [4] } }] }
  ]) {
    const failedNetwork = transport([response])
    const failedClient = createIfindHttpClient({ request: failedNetwork.request })
    await assert.rejects(failedClient.calibrateFinancial(Buffer.from('fixture-access')),
      (error) => error instanceof Error && 'requestCount' in error &&
        error.requestCount === 1 && 'stage' in error && error.stage === 'financial' &&
        !JSON.stringify(error).includes('UNTRUSTED'))
    assert.equal(failedNetwork.calls.length, 1, 'No retry or authentication fallback')
    failedClient.clear()
  }
}

async function runtimeAndHttpContract() {
  const database = new DatabaseSync(':memory:')
  const network = transport([
    { errorcode: 0, data: { access_token: 'fixture-access' } }, success(247652000000)
  ])
  let secretReads = 0
  const runtime = await createIfindDiagnosticRuntime({
    env: {
      KINVEST_IFIND_DIAGNOSTIC_MODE: 'admin-diagnostic',
      KINVEST_IFIND_SECRET_BUNDLE_PATH: '/run/secrets/kinvest-ifind',
      KINVEST_IFIND_REFRESH_TOKEN_VERSION_ID: 'v20260830-001'
    },
    accessRuntime: accessRuntime(),
    openDatabase: () => database,
    loadSecrets: async () => ({
      readRefreshToken() { secretReads += 1; return Buffer.from('fixture-refresh') },
      clear() {}
    }),
    createClient: () => createIfindHttpClient({ request: network.request }),
    clock: () => NOW
  })
  try {
    assert.ok('calibrationService' in runtime && runtime.calibrationService,
      'Production runtime must wire calibration')
    const handler = createRequestHandler({
      accessRuntime: accessRuntime(), ifindDiagnosticRuntime: runtime,
      now: () => NOW, publicOrigin: ORIGIN, trustedProxyAddresses: ['127.0.0.1']
    })
    const initial = await invoke(handler)
    assert.equal(initial.status, 200)
    assert.equal(initial.body.data.status, 'ready')
    assert.deepEqual(initial.body.data.periodEvidence, expectedEvidence())
    assert.equal(network.calls.length, 0, 'GET must not authenticate or query iFinD')
    const blocked = [
      { options: { headers: { cookie: undefined } }, status: 401 },
      { options: { headers: { cookie: '' } }, status: 400 },
      { options: { headers: { cookie: `__Host-kinvest-device=${ADMIN}` } }, status: 401 },
      { options: { headers: { origin: 'https://attacker.invalid' } }, status: 403 },
      { options: { headers: { 'x-kinvest-csrf': 'invalid' } }, status: 403 },
      { options: { headers: { 'content-type': 'text/plain' } }, status: 415 },
      { options: { body: '{"codes":"AAPL.US"}' }, status: 400 },
      { options: { body: '{"indicator":"other"}' }, status: 400 },
      { options: { body: '[]' }, status: 400 },
      { options: { body: '' }, status: 400 },
      { options: { url: `${PATH}/run?codes=AAPL.US` }, status: 404 },
      { options: { address: '203.0.113.99' }, status: 403 }
    ]
    for (const item of blocked) {
      const response = await invoke(handler, {
        method: 'POST', url: `${PATH}/run`, body: '{}', ...item.options
      })
      assert.equal(response.status, item.status, JSON.stringify(item.options))
      assert.equal(network.calls.length, 0)
      assert.equal(secretReads, 0)
    }
    const complete = await invoke(handler, {
      method: 'POST', url: `${PATH}/run`, body: '{}'
    })
    assert.equal(complete.status, 200)
    assert.equal(complete.body.data.status, 'observed-unverified')
    assert.equal(complete.body.data.observation.value, 247652000000)
    assert.deepEqual(complete.body.data.periodEvidence, expectedEvidence(247652000000))
    assert.equal(complete.body.data.observation.reportPeriod, null)
    assert.equal(complete.body.data.observation.periodType, null)
    assert.equal(complete.body.data.observation.currency, null)
    assert.equal(complete.body.data.observation.unit, null)
    assert.equal(complete.body.data.observation.disclosureScope, null)
    assert.equal(complete.body.data.dataVol, 7)
    assert.equal(complete.body.data.requestCount, 2)
    assert.equal(complete.body.data.businessRequestCount, 1)
    assert.equal(Object.keys(complete.body.data.verification).length, 7)
    assert.ok(Object.values(complete.body.data.verification)
      .every((value) => value === 'unverified'))
    assert.equal(network.calls.length, 2)
    assert.equal(secretReads, 1)
    assert.deepEqual(JSON.parse(network.calls[1].body), FIXED_BODY)
    assert.doesNotMatch(JSON.stringify(complete), /fixture-access|fixture-refresh|UNTRUSTED/)
    const described = await invoke(handler)
    assert.deepEqual(described.body.data.periodEvidence, expectedEvidence(247652000000))
    const runs = database.prepare('SELECT * FROM ifind_market_case_runs').all()
    assert.equal(runs.length, 1)
    assert.equal(runs[0].request_count, 2)
    assert.equal(runs[0].failure_code, 'IFIND_CALIBRATION_OBSERVED_UNVERIFIED')
    assert.doesNotMatch(JSON.stringify(runs), /247652|hkexnews|alibabagroup|periodEvidence/)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM ifind_market_quote_snapshots')
      .get().n, 0)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM ifind_market_financial_points')
      .get().n, 0)
    const again = await invoke(handler, { method: 'POST', url: `${PATH}/run`, body: '{}' })
    assert.equal(again.body.data.status, 'cooldown')
    assert.deepEqual(again.body.data.periodEvidence, expectedEvidence())
    assert.equal(network.calls.length, 2)
    const catalog = await invoke(handler, { url: '/api/admin/ifind/market-cases' })
    assert.equal(catalog.status, 200)
    assert.ok(catalog.body.data.cases.every((entry) => entry.case.liveReady === false))
  } finally {
    runtime.clear()
    database.close()
  }
}

async function run() {
  await clientContract()
  await runtimeAndHttpContract()
  console.log('ifind-calibration-integration: PASS')
}

module.exports = { run }
