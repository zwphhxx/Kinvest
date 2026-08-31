'use strict'

const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')

const body = (start = ['2026-01-01']) => ({ errorcode: 0, tables: [{ thscode: '9988.HK',
  table: { revenue_oas: ['247652000000'], report_sd: start, report_ed: ['2026-03-31'] } }] })
const safeError = (overrides = {}) => Object.assign(new Error('UNTRUSTED'), {
  code: 'IFIND_RESPONSE_SHAPE', failureCode: 'IFIND_RESPONSE_SHAPE', class: 'API',
  vendorErrorCode: null, stage: 'financial', ...overrides
})

async function run() {
  const { summarizeReportPeriodResponse: summarize, copyReportPeriodFailureEvidence: copy,
    createReportPeriodFailureEvidence: create } = require('../domain/ifind-report-period-failure')
  const summary = summarize(body())
  assert.deepEqual(summary, { tablesShape: 'single', rowShape: 'exact', identityShape: 'match',
    columnShape: 'known-only', revenueShape: 'decimal-string', reportStartShape: 'iso-date',
    reportEndShape: 'iso-date' })
  const evidence = create(safeError({ responseShape: summary }), 'financial')
  assert.deepEqual(evidence, { stage: 'financial', failureCode: 'IFIND_RESPONSE_SHAPE',
    errorClass: 'API', vendorErrorCode: null, responseShape: summary })
  assert.deepEqual(copy(evidence), evidence); assert.equal(copy(null), null)
  const clone = copy(evidence); clone.responseShape.rowShape = 'extra-fields'
  assert.equal(evidence.responseShape.rowShape, 'exact')

  for (const [value, expected] of /** @type {Array<[any, string]>} */ ([
    [undefined, 'missing'], [null, 'invalid'], [[], 'empty-array'], [[1, 2], 'multiple-values'],
    [[null], 'null'], [[5], 'number'], [['3.5'], 'decimal-string'], [['20260101'], 'compact-date'],
    [['2026-02-30'], 'iso-date'], [['2026-01-01T00:00:00Z'], 'datetime'],
    [['UNTRUSTED'], 'other-string'], [[{}], 'object'], [[[]], 'array'], [[true], 'boolean']
  ])) {
    const input = body(value)
    if (value === undefined) delete input.tables[0].table.report_sd
    assert.equal(summarize(input).reportStartShape, expected)
  }
  for (const [tables, expected] of [[null, 'invalid'], [[], 'empty'], [[{}, {}], 'multiple']]) {
    const output = summarize({ tables })
    assert.equal(output.tablesShape, expected)
    for (const key of Object.keys(output).slice(1)) assert.equal(output[key], 'unavailable')
  }
  const extra = body(); extra.tables[0]['UNTRUSTED'] = 'UNTRUSTED'
  extra.tables[0].table['UNTRUSTED'] = ['UNTRUSTED']
  assert.equal(summarize(extra).rowShape, 'extra-fields')
  assert.equal(summarize(extra).columnShape, 'extra-fields')
  assert.doesNotMatch(JSON.stringify(summarize(extra)), /UNTRUSTED|247652|2026-01-01/)

  let traps = 0
  const hostile = (value) => new Proxy(value, {
    get() { traps += 1; throw new Error('UNTRUSTED') },
    ownKeys() { traps += 1; throw new Error('UNTRUSTED') },
    getPrototypeOf() { traps += 1; throw new Error('UNTRUSTED') },
    getOwnPropertyDescriptor() { traps += 1; throw new Error('UNTRUSTED') }
  })
  const getter = body()
  Object.defineProperty(getter.tables[0].table, 'report_sd', { enumerable: true,
    get() { traps += 1; throw new Error('UNTRUSTED') } })
  assert.equal(summarize(getter).reportStartShape, 'invalid')
  assert.equal(summarize(hostile(body())).tablesShape, 'invalid')
  assert.equal(create(hostile({}), 'financial'), null)
  const getterError = safeError()
  Object.defineProperty(getterError, 'failureCode', { get() { traps += 1; throw new Error('UNTRUSTED') } })
  assert.equal(create(getterError, 'financial'), null)
  assert.equal(create(safeError({ code: 'IFIND_SECRET_UNTRUSTED', failureCode: 'IFIND_SECRET_UNTRUSTED' }), 'financial'), null)
  assert.equal(create(safeError({ class: 'NETWORK' }), 'financial'), null)
  assert.equal(create(safeError({ stage: 'auth' }), 'financial'), null)
  assert.equal(create(safeError({ vendorErrorCode: 123 }), 'financial'), null)
  const malformedSummary = { ...summary, raw: 'UNTRUSTED' }
  assert.equal(create(safeError({ responseShape: malformedSummary }), 'financial').responseShape, null)
  for (const invalid of [hostile(evidence), { ...evidence, extra: 'UNTRUSTED' },
    { ...evidence, responseShape: hostile(summary) }, { ...evidence, responseShape: malformedSummary },
    { ...evidence, errorClass: 'NETWORK' }, { ...evidence, stage: 'auth' },
    { ...evidence, responseShape: { ...summary, tablesShape: 'empty' } },
    { ...evidence, responseShape: { ...summary, revenueShape: 'UNTRUSTED' } }]) {
    assert.throws(() => copy(invalid), { code: 'IFIND_REPORT_PERIOD_FAILURE_INVALID' })
  }
  assert.equal(traps, 0)

  const { createInitialReportPeriodDiagnosticResult: initial, copyReportPeriodDiagnosticResult: copyResult } =
    require('../domain/ifind-report-period-diagnostic')
  const failed = { ...initial(), status: 'failed', requestCount: 2, businessRequestCount: 1,
    attemptedAt: '2026-08-31T04:00:00.000Z', errorCode: 'IFIND_REPORT_PERIOD_DIAGNOSTIC_FAILED',
    failureEvidence: evidence }
  assert.deepEqual(copyResult(failed), failed)
  assert.throws(() => copyResult({ ...initial(), failureEvidence: evidence }))
  assert.throws(() => copyResult({ ...failed, requestCount: 1, businessRequestCount: 0 }))

  const { IfindMarketDiagnosticRepository } = require('../db/ifind-market-diagnostic-repository')
  const { createIfindReportPeriodDiagnosticService: service } = require('../services/ifind-report-period-diagnostic-service')
  for (const failure of [new Error('UNTRUSTED'), hostile({}), safeError({
    code: 'IFIND_TIMEOUT', failureCode: 'IFIND_TIMEOUT', class: 'NETWORK' })]) {
    const db = new DatabaseSync(':memory:'); const repository = new IfindMarketDiagnosticRepository(db)
    repository.initialize()
    const runner = service({ repository, tokenVersionId: 'v20260831-001',
      clock: () => Date.parse('2026-08-31T04:00:00.000Z'),
      secretProvider: { readRefreshToken: () => Buffer.from('synthetic-refresh') },
      client: { authenticate: async () => ({ accessToken: Buffer.from('synthetic-access'), requestCount: 1 }),
        diagnoseReportPeriod: async () => { throw failure }, clear() {} } })
    try {
      const result = await runner.run()
      const row = db.prepare('SELECT * FROM ifind_market_case_runs').get()
      const known = result.failureEvidence !== null
      assert.equal(row.safe_error_class, known ? 'NETWORK' : 'API')
      assert.equal(row.failure_code, known ? 'IFIND_TIMEOUT' : 'IFIND_REPORT_PERIOD_DIAGNOSTIC_FAILED')
      assert.doesNotMatch(JSON.stringify([result, row]), /UNTRUSTED|synthetic-/)
    } finally { runner.clear(); db.close() }
  }
  assert.equal(traps, 0)
  console.log('ifind-report-period-failure: structural, safe-code, hostile-object and persistence contracts passed')
}

module.exports = { run }
