const assert = require('node:assert/strict')

async function run() {
  const auth = require('../../public/auth-contract')
  const { createAuthorizedRequestLifecycle } = require('../../public/auth-lifecycle')
  const {
    approvedRequestDecision,
    createAdminSecurityState,
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
}

module.exports = { run }
