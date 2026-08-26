const assert = require('node:assert/strict')

function deferred() {
  /** @type {(value: unknown) => void} */
  let resolve = () => {}
  /** @type {(reason?: unknown) => void} */
  let reject = () => {}
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function run() {
  const auth = require('../../public/auth-contract')
  const {
    createAuthorizedRequestLifecycle,
    createSingleFlightRetry
  } = require('../../public/auth-lifecycle')
  const {
    approvedRequestDecision,
    createAdminBootstrapGate,
    createAdminSessionLifecycle,
    createAdminSecurityState,
    createIfindDiagnosticController,
    createIfindDiagnosticView,
    ifindDiagnosticApiFailure,
    ifindDiagnosticErrorMessage,
    ifindDiagnosticSafeErrorClasses,
    logoutFailureDecision,
    mutationFailureDecision
  } = require('../../public/admin-contract')

  const lifecycle = createAuthorizedRequestLifecycle()
  assert.equal(lifecycle.isAuthorized(), false)
  assert.throws(() => lifecycle.beginRequest(), /AUTH_EPOCH_INACTIVE/)
  lifecycle.authorize()
  const first = lifecycle.beginRequest()
  assert.equal(first.signal.aborted, false)
  assert.equal(lifecycle.canCommit(first), true)
  const firstEpoch = first.epoch
  lifecycle.invalidate()
  assert.equal(first.signal.aborted, true)
  assert.equal(lifecycle.canCommit(first), false)
  assert.ok(lifecycle.epoch() > firstEpoch)
  lifecycle.authorize()
  const second = lifecycle.beginRequest()
  assert.equal(lifecycle.canCommit(second), true)
  lifecycle.finishRequest(second)

  lifecycle.authorize()
  const lateInvestment = deferred()
  const lateInvestmentTicket = lifecycle.beginRequest()
  let lateInvestmentRendered = false
  const lateInvestmentRender = lateInvestment.promise.then(() =>
    lifecycle.commit(lateInvestmentTicket, () => {
      lateInvestmentRendered = true
    })
  )
  lifecycle.invalidate()
  lateInvestment.resolve({ status: 200 })
  await assert.rejects(lateInvestmentRender, /AUTH_EPOCH_STALE/)
  assert.equal(lateInvestmentRendered, false)

  assert.deepEqual(
    auth.classifyApiFailure(401, { error: 'AUTH_REQUIRED' }),
    { code: 'AUTH_REQUIRED', message: '这台设备尚未获得家庭访问许可。', retryable: false }
  )
  assert.deepEqual(
    auth.classifyApiFailure(418, { error: 'private backend details' }),
    { code: 'UNKNOWN', message: '暂时无法完成，请稍后重试。', retryable: false }
  )
  assert.equal(auth.classifyApiFailure(503, {}).retryable, true)
  assert.equal(auth.classifyApiFailure(0, {}).retryable, true)

  for (const code of [
    'REQUEST_EXPIRED',
    'REQUEST_LOCKED',
    'REQUEST_NOT_FOUND',
    'REQUEST_AUTH_REQUIRED'
  ]) {
    assert.deepEqual(auth.pollErrorDecision({ code, status: 400 }), {
      terminal: true,
      confirmAuthorization: false,
      retry: false
    })
  }
  assert.deepEqual(auth.pollErrorDecision({ code: 'REQUEST_ALREADY_USED', status: 409 }), {
    terminal: false,
    confirmAuthorization: true,
    retry: false
  })
  assert.equal(auth.pollErrorDecision({ code: 'UNKNOWN', status: 503 }).retry, true)
  assert.equal(auth.pollErrorDecision({ code: 'UNKNOWN', status: 400 }).terminal, true)

  const expectedTopLevelStates = {
    checking: { checking: true, gate: false, dashboard: false },
    gate: { checking: false, gate: true, dashboard: false },
    dashboard: { checking: false, gate: false, dashboard: true }
  }
  for (const [mode, expected] of Object.entries(expectedTopLevelStates)) {
    const visibility = auth.topLevelVisibility(mode)
    assert.deepEqual(visibility, expected)
    assert.equal(Object.values(visibility).filter(Boolean).length, 1)
  }
  assert.throws(() => auth.topLevelVisibility('unknown'), /AUTH_VIEW_STATE_INVALID/)

  assert.deepEqual(approvedRequestDecision({ approvedAt: 123 }), {
    approvable: false,
    label: '已批准，等待设备兑换'
  })
  assert.deepEqual(approvedRequestDecision({ approvedAt: null }), {
    approvable: true,
    label: '等待管理员批准'
  })

  const adminState = createAdminSecurityState()
  adminState.setCsrf('csrf-one')
  assert.equal(adminState.getCsrf(), 'csrf-one')
  let restoreCalls = 0
  /** @type {(value: { csrfToken: string }) => void} */
  let resolveRestore = () => {}
  const loader = () => {
    restoreCalls += 1
    return new Promise((resolve) => { resolveRestore = resolve })
  }
  const restoreOne = adminState.restore(loader)
  const restoreTwo = adminState.restore(loader)
  assert.strictEqual(restoreOne, restoreTwo)
  assert.equal(restoreCalls, 1)
  resolveRestore({ csrfToken: 'csrf-two' })
  await restoreOne
  assert.equal(adminState.getCsrf(), 'csrf-two')
  adminState.clear()
  assert.equal(adminState.getCsrf(), null)

  const staleCsrf = deferred()
  const staleRestore = adminState.restore(() => staleCsrf.promise)
  adminState.clear()
  staleCsrf.resolve({ csrfToken: 'must-not-survive' })
  await assert.rejects(staleRestore, /ADMIN_CSRF_STALE/)
  assert.equal(adminState.getCsrf(), null)

  const adminLifecycle = createAdminSessionLifecycle()
  adminLifecycle.activate()
  const listTicket = adminLifecycle.beginRequest()
  const lateList = deferred()
  let lateAdminRendered = false
  const lateListRender = lateList.promise.then(() =>
    adminLifecycle.commit(listTicket, () => {
      lateAdminRendered = true
    })
  )
  adminLifecycle.invalidate()
  lateList.resolve({ requests: [] })
  await assert.rejects(lateListRender, /ADMIN_EPOCH_STALE/)
  assert.equal(listTicket.signal.aborted, true)
  assert.equal(lateAdminRendered, false)

  const bootstrapGate = createAdminBootstrapGate()
  const bootstrapTicket = bootstrapGate.begin()
  const bootstrapResponse = deferred()
  let adminView = 'checking'
  const bootstrapRun = bootstrapResponse.promise.then(() => {
    if (bootstrapGate.settle(bootstrapTicket)) adminView = 'login'
  })
  assert.equal(bootstrapGate.canLogin(), false)
  bootstrapResponse.resolve({ csrfToken: 'bootstrap-csrf' })
  await bootstrapRun
  assert.equal(bootstrapGate.canLogin(), true)
  assert.equal(adminView, 'login')
  adminView = 'desk'
  assert.equal(bootstrapGate.settle(bootstrapTicket), false)
  assert.equal(adminView, 'desk')

  const settledBootstrapGate = createAdminBootstrapGate()
  const settledBootstrapTicket = settledBootstrapGate.begin()
  assert.equal(settledBootstrapGate.settle(settledBootstrapTicket), true)
  const bootstrapListFailure = deferred()
  let bootstrapListFailureHandled = false
  const bootstrapListRun = bootstrapListFailure.promise.catch(() => {
    bootstrapListFailureHandled = true
  })
  bootstrapListFailure.reject(new Error('list failed after bootstrap settled'))
  await bootstrapListRun
  assert.equal(bootstrapListFailureHandled, true)

  adminLifecycle.activate()
  const writeTicket = adminLifecycle.beginRequest()
  const lateWrite = deferred()
  let writeCommitted = false
  const lateWriteCommit = lateWrite.promise.then(() =>
    adminLifecycle.commit(writeTicket, () => {
      writeCommitted = true
    })
  )
  const logoutSuspension = adminLifecycle.suspend()
  lateWrite.resolve({ success: true })
  await assert.rejects(lateWriteCommit, /ADMIN_EPOCH_STALE/)
  assert.equal(writeTicket.signal.aborted, true)
  assert.equal(writeCommitted, false)

  assert.deepEqual(logoutFailureDecision('UNKNOWN'), {
    revalidate: true,
    showLogin: false
  })
  const logoutRevalidation = deferred()
  let logoutRevalidationCleared = false
  const transientRecovery = logoutRevalidation.promise.then(
    () => adminLifecycle.resume(logoutSuspension),
    () => { logoutRevalidationCleared = true }
  )
  assert.throws(() => adminLifecycle.beginRequest(), /ADMIN_EPOCH_INACTIVE/)
  logoutRevalidation.resolve({ csrfToken: 'revalidated-csrf' })
  assert.equal(await transientRecovery, true)
  assert.equal(logoutRevalidationCleared, false)
  const recoveredTicket = adminLifecycle.beginRequest()
  assert.equal(recoveredTicket.signal.aborted, false)
  adminLifecycle.finishRequest(recoveredTicket)

  adminLifecycle.suspend()
  assert.deepEqual(logoutFailureDecision('ADMIN_AUTH_REQUIRED'), {
    revalidate: false,
    showLogin: true
  })
  assert.throws(() => adminLifecycle.beginRequest(), /ADMIN_EPOCH_INACTIVE/)

  adminLifecycle.activate()
  const failedRevalidationSuspension = adminLifecycle.suspend()
  const failedRevalidation = deferred()
  let failedRevalidationRequiresClear = false
  const failedRevalidationRun = failedRevalidation.promise.catch(() => {
    failedRevalidationRequiresClear = true
  })
  failedRevalidation.reject({ code: 'ADMIN_AUTH_REQUIRED' })
  await failedRevalidationRun
  assert.equal(failedRevalidationRequiresClear, true)
  assert.equal(adminLifecycle.resume({ epoch: failedRevalidationSuspension.epoch - 1 }), false)
  assert.throws(() => adminLifecycle.beginRequest(), /ADMIN_EPOCH_INACTIVE/)

  const scheduled = []
  const redeemRetry = createSingleFlightRetry({
    baseDelayMs: 100,
    maxDelayMs: 400,
    setTimer(callback, delay) {
      scheduled.push({ callback, delay })
      return scheduled.length
    },
    clearTimer() {}
  })
  redeemRetry.activate(9)
  const firstRedeem = deferred()
  const secondRedeem = deferred()
  let redeemCalls = 0
  const redeemOperation = () => {
    redeemCalls += 1
    return redeemCalls === 1 ? firstRedeem.promise : secondRedeem.promise
  }
  const firstRedeemRun = redeemRetry.run(
    9,
    redeemOperation,
    () => ({ retry: true, terminal: false })
  )
  assert.equal(
    redeemRetry.run(9, redeemOperation, () => ({ retry: true, terminal: false })),
    firstRedeemRun
  )
  firstRedeem.reject(new Error('network'))
  assert.deepEqual(await firstRedeemRun, { kind: 'retry', delayMs: 100 })
  assert.equal(scheduled.length, 1)
  assert.equal(scheduled[0].delay, 100)
  const secondRedeemRun = scheduled[0].callback()
  secondRedeem.resolve({ redeemed: true })
  assert.deepEqual(await secondRedeemRun, {
    kind: 'success',
    value: { redeemed: true }
  })
  assert.equal(redeemCalls, 2)

  assert.deepEqual(mutationFailureDecision('ADMIN_CSRF_INVALID'), {
    clear: true,
    restore: true,
    refresh: true,
    replay: false
  })
  assert.deepEqual(mutationFailureDecision('ADMIN_AUTH_REQUIRED'), {
    clear: true,
    restore: false,
    refresh: false,
    replay: false
  })

  const now = Date.UTC(2026, 7, 26, 4, 0, 0)
  const latest = {
    startedAt: now - 220,
    completedAt: now - 100,
    authStatus: 'success',
    probeStatus: 'success',
    safeErrorClass: null,
    route: '/api/v1/get_trade_dates',
    scope: 'market-trade-dates:212001:D:-10',
    requestCount: 2,
    dataVol: 7,
    elapsedMs: 120,
    completeness: 'complete',
    tokenVersionId: 'v20260826-001',
    officialQuotaStatus: 'unavailable'
  }
  const readyDiagnostic = createIfindDiagnosticView({
    mode: 'admin-diagnostic',
    configured: true,
    tokenVersionId: 'v20260826-001',
    officialQuotaStatus: 'unavailable',
    cooldownUntil: null,
    localAttemptCount: 3,
    latest
  }, { running: false, now })
  assert.deepEqual(readyDiagnostic.authStage, { label: '认证通过', tone: 'success' })
  assert.deepEqual(readyDiagnostic.probeStage, { label: '交易日探针通过', tone: 'success' })
  assert.equal(readyDiagnostic.enabledLabel, '已启用')
  assert.equal(readyDiagnostic.versionId, 'v20260826-001')
  assert.equal(readyDiagnostic.requestCount, '2 次')
  assert.equal(readyDiagnostic.elapsed, '120 ms')
  assert.equal(readyDiagnostic.dataVol, '7 条')
  assert.equal(readyDiagnostic.completeness, '完整')
  assert.equal(readyDiagnostic.localAttempt, '3 / 20')
  assert.equal(readyDiagnostic.officialQuota, '官方剩余额度不可用')
  assert.deepEqual(readyDiagnostic.run, {
    disabled: false,
    label: '运行双级诊断',
    tone: 'ready'
  })

  assert.deepEqual(createIfindDiagnosticView(null, { running: false, now }).run, {
    disabled: true,
    label: '诊断未启用',
    tone: 'disabled'
  })
  assert.deepEqual(createIfindDiagnosticView({
    mode: 'admin-diagnostic', configured: true, tokenVersionId: 'v20260826-001',
    officialQuotaStatus: 'unavailable', cooldownUntil: null, localAttemptCount: 1, latest: null
  }, { running: true, now }).run, {
    disabled: true,
    label: '正在运行双级诊断…',
    tone: 'running'
  })
  assert.deepEqual(createIfindDiagnosticView({
    mode: 'admin-diagnostic', configured: true, tokenVersionId: 'v20260826-001',
    officialQuotaStatus: 'unavailable', cooldownUntil: now + 60_000, localAttemptCount: 4, latest
  }, { running: false, now }).run, {
    disabled: true,
    label: '冷却中，稍后再试',
    tone: 'cooldown'
  })
  assert.deepEqual(createIfindDiagnosticView({
    mode: 'admin-diagnostic', configured: true, tokenVersionId: 'v20260826-001',
    officialQuotaStatus: 'unavailable', cooldownUntil: null, localAttemptCount: 20, latest
  }, { running: false, now }).run, {
    disabled: true,
    label: '今日本地诊断已达上限',
    tone: 'daily-limit'
  })

  const failedDiagnostic = createIfindDiagnosticView({
    mode: 'admin-diagnostic', configured: true, tokenVersionId: 'v20260826-002',
    officialQuotaStatus: 'unavailable', cooldownUntil: now + 60_000, localAttemptCount: 5,
    latest: {
      ...latest,
      authStatus: 'failed', probeStatus: 'not_run', safeErrorClass: 'AUTH',
      requestCount: 1, dataVol: null, completeness: 'unavailable'
    }
  }, { running: false, now })
  assert.deepEqual(failedDiagnostic.authStage, { label: '认证未通过', tone: 'failed' })
  assert.deepEqual(failedDiagnostic.probeStage, { label: '交易日探针未运行', tone: 'idle' })
  assert.equal(failedDiagnostic.errorMessage, '认证阶段未通过，请核对管理员维护的凭据配置。')
  assert.equal(ifindDiagnosticErrorMessage('PERMISSION'), '交易日探针未获授权，请核对 iFinD 权限范围。')
  assert.equal(ifindDiagnosticErrorMessage('raw provider text'), '诊断未完成，请根据阶段状态检查配置后重试。')
  const diagnosticErrorMessages = {
    AUTH: '认证阶段未通过，请核对管理员维护的凭据配置。',
    PERMISSION: '交易日探针未获授权，请核对 iFinD 权限范围。',
    QUOTA: 'iFinD 侧额度不足，官方剩余额度仍不可用。',
    NETWORK: '无法连接 iFinD 服务，请稍后重试。',
    API: 'iFinD 接口未返回可用结果，请稍后重试。',
    CONFIG: '诊断配置未就绪，请检查管理员配置。',
    BUSY: '已有一项诊断正在运行，请稍后再试。',
    RATE_LIMITED: '诊断受到本地频率限制，请稍后重试。'
  }
  assert.deepEqual(
    [...ifindDiagnosticSafeErrorClasses()].sort(),
    Object.keys(diagnosticErrorMessages).sort()
  )
  for (const [code, message] of Object.entries(diagnosticErrorMessages)) {
    assert.equal(ifindDiagnosticErrorMessage(code), message)
  }
  for (const impossibleCode of ['TIMEOUT', 'RESPONSE_FORMAT', 'INTERNAL']) {
    assert.equal(
      ifindDiagnosticErrorMessage(impossibleCode),
      '诊断未完成，请根据阶段状态检查配置后重试。'
    )
  }
  assert.equal(
    ifindDiagnosticApiFailure(401, { error: 'ADMIN_AUTH_REQUIRED' }).code,
    'ADMIN_AUTH_REQUIRED'
  )
  assert.equal(
    ifindDiagnosticApiFailure(403, { error: 'ADMIN_CSRF_INVALID' }).code,
    'ADMIN_CSRF_INVALID'
  )
  const unavailableDiagnostic = createIfindDiagnosticView(
    { mode: 'unavailable' },
    { running: false, now }
  )
  assert.equal(unavailableDiagnostic.enabledLabel, '状态不可用')
  assert.equal(unavailableDiagnostic.errorMessage, '暂时无法读取诊断状态，设备审批功能不受影响。')
  assert.deepEqual(unavailableDiagnostic.run, {
    disabled: true,
    label: '诊断状态不可用',
    tone: 'disabled'
  })

  class FakeElement {
    constructor(id) {
      this.id = id
      this._textContent = ''
      this.disabled = false
      this.dataset = {}
      this.attributes = new Map()
      this.listeners = new Map()
      this.parentElement = { dataset: {} }
      this.tabIndex = 0
      this.innerHtmlWrites = 0
    }

    get textContent() { return this._textContent }
    set textContent(value) { this._textContent = String(value) }
    set innerHTML(_value) { this.innerHtmlWrites += 1 }
    setAttribute(name, value) { this.attributes.set(name, String(value)) }
    addEventListener(name, handler) { this.listeners.set(name, handler) }
    click() {
      const handler = this.listeners.get('click')
      return handler ? handler({ preventDefault() {} }) : undefined
    }
  }

  function diagnosticDom() {
    const ids = [
      'ifind-enabled', 'ifind-version-id', 'ifind-last-run', 'ifind-request-count',
      'ifind-elapsed', 'ifind-data-vol', 'ifind-completeness', 'ifind-local-attempt',
      'ifind-cooldown', 'ifind-official-quota', 'ifind-diagnostic-note',
      'ifind-auth-stage', 'ifind-probe-stage', 'ifind-run',
      'pending-requests', 'approved-devices', 'auth-audit'
    ]
    const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement(id)]))
    return {
      elements,
      document: { getElementById: (id) => elements[id] || null }
    }
  }

  function abortableDeferredRequest() {
    const pending = deferred()
    return {
      pending,
      request(_path, options) {
        return new Promise((resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (options.signal.aborted) return abort()
          options.signal.addEventListener('abort', abort, { once: true })
          pending.promise.then(resolve, reject)
        })
      }
    }
  }

  const maliciousDom = diagnosticDom()
  const maliciousLifecycle = createAdminSessionLifecycle()
  maliciousLifecycle.activate()
  const maliciousController = createIfindDiagnosticController({
    document: maliciousDom.document,
    sessionLifecycle: maliciousLifecycle,
    request: async () => ({ data: null }),
    dateText: (value) => String(value),
    now: () => now,
    setLive() {},
    onError: async () => {}
  })
  maliciousController.render({
    mode: 'admin-diagnostic', configured: true,
    tokenVersionId: '<img src=x onerror=alert(1)>',
    officialQuotaStatus: 'unavailable', cooldownUntil: null, localAttemptCount: 1,
    latest: { ...latest, safeErrorClass: '<svg onload=alert(1)>' }
  })
  assert.equal(maliciousDom.elements['ifind-version-id'].textContent, '未配置')
  assert.equal(maliciousDom.elements['ifind-diagnostic-note'].textContent.includes('<svg'), false)
  assert.equal(
    Object.values(maliciousDom.elements).every((element) => element.innerHtmlWrites === 0),
    true
  )

  const isolatedDom = diagnosticDom()
  isolatedDom.elements['pending-requests'].textContent = '等待审批内容'
  isolatedDom.elements['approved-devices'].textContent = '设备内容'
  isolatedDom.elements['auth-audit'].textContent = '审计内容'
  const isolatedLifecycle = createAdminSessionLifecycle()
  isolatedLifecycle.activate()
  const isolatedController = createIfindDiagnosticController({
    document: isolatedDom.document,
    sessionLifecycle: isolatedLifecycle,
    request: async () => { throw Object.assign(new Error('network'), { code: 'UNKNOWN' }) },
    dateText: (value) => String(value),
    now: () => now,
    setLive() {},
    onError: async () => {}
  })
  await isolatedController.refresh()
  assert.equal(isolatedDom.elements['pending-requests'].textContent, '等待审批内容')
  assert.equal(isolatedDom.elements['approved-devices'].textContent, '设备内容')
  assert.equal(isolatedDom.elements['auth-audit'].textContent, '审计内容')
  assert.equal(isolatedDom.elements['ifind-enabled'].textContent, '状态不可用')

  const abortDom = diagnosticDom()
  const abortLifecycle = createAdminSessionLifecycle()
  abortLifecycle.activate()
  const abortRequest = abortableDeferredRequest()
  const abortCalls = []
  const abortController = createIfindDiagnosticController({
    document: abortDom.document,
    sessionLifecycle: abortLifecycle,
    request(path, options) {
      abortCalls.push({ path, options })
      return abortRequest.request(path, options)
    },
    dateText: (value) => String(value),
    now: () => now,
    setLive() {},
    onError: async () => {}
  })
  abortController.render({
    mode: 'admin-diagnostic', configured: true, tokenVersionId: 'v20260826-001',
    officialQuotaStatus: 'unavailable', cooldownUntil: null, localAttemptCount: 1, latest
  })
  abortController.bind()
  const abortedRun = abortDom.elements['ifind-run'].click()
  assert.equal(abortCalls.length, 1)
  assert.equal(abortCalls[0].path, '/api/admin/ifind/diagnostics/run')
  assert.equal(abortCalls[0].options.signal.aborted, false)
  assert.equal(abortDom.elements['ifind-run'].disabled, true)
  assert.equal(abortDom.elements['ifind-run'].attributes.get('aria-busy'), 'true')
  const textAtLogout = abortDom.elements['ifind-diagnostic-note'].textContent
  abortLifecycle.invalidate()
  abortController.reset()
  const textAfterReset = abortDom.elements['ifind-diagnostic-note'].textContent
  await abortedRun
  assert.equal(abortCalls.length, 1, 'logout must prevent the follow-up status request')
  assert.equal(abortDom.elements['ifind-diagnostic-note'].textContent, textAfterReset)
  assert.notEqual(textAtLogout, undefined)

  const csrfDom = diagnosticDom()
  const csrfLifecycle = createAdminSessionLifecycle()
  csrfLifecycle.activate()
  const csrfCalls = []
  let csrfErrors = 0
  const csrfController = createIfindDiagnosticController({
    document: csrfDom.document,
    sessionLifecycle: csrfLifecycle,
    request: async (path) => {
      csrfCalls.push(path)
      throw Object.assign(new Error('csrf'), { code: 'ADMIN_CSRF_INVALID' })
    },
    dateText: (value) => String(value),
    now: () => now,
    setLive() {},
    onError: async () => { csrfErrors += 1 }
  })
  csrfController.render({
    mode: 'admin-diagnostic', configured: true, tokenVersionId: 'v20260826-001',
    officialQuotaStatus: 'unavailable', cooldownUntil: null, localAttemptCount: 1, latest
  })
  csrfController.bind()
  await csrfDom.elements['ifind-run'].click()
  assert.deepEqual(csrfCalls, ['/api/admin/ifind/diagnostics/run'])
  assert.equal(csrfErrors, 1)

  const runningDom = diagnosticDom()
  const runningLifecycle = createAdminSessionLifecycle()
  runningLifecycle.activate()
  const runningRequest = abortableDeferredRequest()
  const runningController = createIfindDiagnosticController({
    document: runningDom.document,
    sessionLifecycle: runningLifecycle,
    request: runningRequest.request,
    dateText: (value) => String(value),
    now: () => now,
    setLive() {},
    onError: async () => {}
  })
  runningController.render({
    mode: 'admin-diagnostic', configured: true, tokenVersionId: 'v20260826-001',
    officialQuotaStatus: 'unavailable', cooldownUntil: null, localAttemptCount: 1, latest
  })
  runningController.bind()
  assert.equal(runningDom.elements['ifind-run'].disabled, false)
  assert.equal(runningDom.elements['ifind-run'].tabIndex, 0)
  const runningPromise = runningDom.elements['ifind-run'].click()
  assert.equal(runningDom.elements['ifind-run'].disabled, true)
  assert.equal(runningDom.elements['ifind-run'].textContent, '正在运行双级诊断…')
  runningLifecycle.invalidate()
  await runningPromise
}

module.exports = { run }
