/* global module */

(function exposeAdminContract(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) (/** @type {any} */ (root)).KinvestAdmin = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function createModule() {
  const IFIND_VERSION_PATTERN = /^v[0-9]{8}-[0-9]{3}$/
  const IFIND_API_ERRORS = new Set([
    'IFIND_DIAGNOSTIC_DISABLED',
    'IFIND_DIAGNOSTIC_BUSY',
    'IFIND_DIAGNOSTIC_COOLDOWN',
    'IFIND_DIAGNOSTIC_DAILY_LIMIT',
    'ADMIN_AUTH_REQUIRED',
    'ADMIN_CSRF_INVALID'
  ])
  const IFIND_CONTROL_ERROR_MESSAGES = Object.freeze({
    IFIND_DIAGNOSTIC_DISABLED: '管理员诊断尚未启用。',
    IFIND_DIAGNOSTIC_BUSY: '已有一项诊断正在运行，请稍后再试。',
    IFIND_DIAGNOSTIC_COOLDOWN: '诊断正在冷却，请在允许时间后重试。',
    IFIND_DIAGNOSTIC_DAILY_LIMIT: '今日诊断次数已达本地上限。',
    ADMIN_AUTH_REQUIRED: '管理员会话已结束，请重新登录。',
    ADMIN_CSRF_INVALID: '操作凭证已失效，请刷新后重试。'
  })
  const IFIND_SAFE_ERROR_MESSAGES = Object.freeze({
    AUTH: '认证阶段未通过，请核对管理员维护的凭据配置。',
    PERMISSION: '交易日探针未获授权，请核对 iFinD 权限范围。',
    QUOTA: 'iFinD 侧额度不足，官方剩余额度仍不可用。',
    NETWORK: '无法连接 iFinD 服务，请稍后重试。',
    API: 'iFinD 接口未返回可用结果，请稍后重试。',
    CONFIG: '诊断配置未就绪，请检查管理员配置。',
    RATE_LIMITED: '诊断受到本地频率限制，请稍后重试。',
    BUSY: '已有一项诊断正在运行，请稍后再试。'
  })

  function ifindDiagnosticErrorMessage(code) {
    if (Object.hasOwn(IFIND_SAFE_ERROR_MESSAGES, code)) return IFIND_SAFE_ERROR_MESSAGES[code]
    if (Object.hasOwn(IFIND_CONTROL_ERROR_MESSAGES, code)) return IFIND_CONTROL_ERROR_MESSAGES[code]
    return '诊断未完成，请根据阶段状态检查配置后重试。'
  }

  function ifindDiagnosticSafeErrorClasses() {
    return Object.freeze(Object.keys(IFIND_SAFE_ERROR_MESSAGES))
  }

  function ifindDiagnosticApiFailure(status, payload) {
    const code = payload && IFIND_API_ERRORS.has(payload.error) ? payload.error : 'UNKNOWN'
    return Object.freeze({
      code,
      message: ifindDiagnosticErrorMessage(code),
      retryable: status >= 500 || code === 'IFIND_DIAGNOSTIC_BUSY' ||
        code === 'IFIND_DIAGNOSTIC_COOLDOWN'
    })
  }

  function diagnosticStage(stage, value) {
    const decisions = stage === 'auth'
      ? {
          success: ['认证通过', 'success'],
          failed: ['认证未通过', 'failed'],
          unknown: ['认证状态未知', 'unknown']
        }
      : {
          success: ['交易日探针通过', 'success'],
          failed: ['交易日探针未通过', 'failed'],
          not_run: ['交易日探针未运行', 'idle']
        }
    const decision = decisions[value] || (stage === 'auth'
      ? ['认证尚未运行', 'idle']
      : ['交易日探针尚未运行', 'idle'])
    return Object.freeze({ label: decision[0], tone: decision[1] })
  }

  function diagnosticRunDecision(status, running, now) {
    if (running) {
      return Object.freeze({ disabled: true, label: '正在运行双级诊断…', tone: 'running' })
    }
    if (status && status.mode === 'unavailable') {
      return Object.freeze({ disabled: true, label: '诊断状态不可用', tone: 'disabled' })
    }
    if (!status || status.mode !== 'admin-diagnostic' || status.configured !== true) {
      return Object.freeze({ disabled: true, label: '诊断未启用', tone: 'disabled' })
    }
    if (status.localAttemptCount >= 20) {
      return Object.freeze({ disabled: true, label: '今日本地诊断已达上限', tone: 'daily-limit' })
    }
    if (Number.isSafeInteger(status.cooldownUntil) && status.cooldownUntil > now) {
      return Object.freeze({ disabled: true, label: '冷却中，稍后再试', tone: 'cooldown' })
    }
    return Object.freeze({ disabled: false, label: '运行双级诊断', tone: 'ready' })
  }

  function createIfindDiagnosticView(status, options = {}) {
    const now = Number.isSafeInteger(options.now) ? options.now : Date.now()
    const running = options.running === true
    const unavailable = Boolean(status && status.mode === 'unavailable')
    const enabled = Boolean(status && status.mode === 'admin-diagnostic' && status.configured === true)
    const latest = enabled && status.latest && typeof status.latest === 'object'
      ? status.latest
      : null
    const versionId = enabled && typeof status.tokenVersionId === 'string' &&
      IFIND_VERSION_PATTERN.test(status.tokenVersionId)
      ? status.tokenVersionId
      : '未配置'
    const attempts = enabled && Number.isSafeInteger(status.localAttemptCount)
      ? Math.min(Math.max(status.localAttemptCount, 0), 20)
      : 0
    const completenessLabels = {
      complete: '完整',
      partial: '部分',
      unavailable: '不可用'
    }
    return Object.freeze({
      enabledLabel: unavailable ? '状态不可用' : (enabled ? '已启用' : '未启用'),
      versionId,
      lastRunAt: latest && Number.isSafeInteger(latest.completedAt) ? latest.completedAt : null,
      authStage: diagnosticStage('auth', latest && latest.authStatus),
      probeStage: diagnosticStage('probe', latest && latest.probeStatus),
      requestCount: latest && Number.isSafeInteger(latest.requestCount) ? `${latest.requestCount} 次` : '—',
      elapsed: latest && Number.isSafeInteger(latest.elapsedMs) ? `${latest.elapsedMs} ms` : '—',
      dataVol: latest ? (Number.isSafeInteger(latest.dataVol) ? `${latest.dataVol} 条` : '不可用') : '—',
      completeness: latest && Object.hasOwn(completenessLabels, latest.completeness)
        ? completenessLabels[latest.completeness]
        : '尚无结果',
      localAttempt: `${attempts} / 20`,
      cooldownUntil: enabled && Number.isSafeInteger(status.cooldownUntil)
        ? status.cooldownUntil
        : null,
      officialQuota: '官方剩余额度不可用',
      errorMessage: unavailable
        ? '暂时无法读取诊断状态，设备审批功能不受影响。'
        : (latest && typeof latest.safeErrorClass === 'string'
            ? ifindDiagnosticErrorMessage(latest.safeErrorClass)
            : ''),
      run: diagnosticRunDecision(status, running, now)
    })
  }

  function createIfindDiagnosticController(options) {
    const documentRef = options.document
    const sessionLifecycle = options.sessionLifecycle
    const request = options.request
    const dateText = options.dateText
    const now = options.now
    const setLive = options.setLive
    const onError = options.onError
    let status = null
    let running = false
    let bound = false
    const byId = (id) => documentRef.getElementById(id)

    function render(nextStatus = status) {
      status = nextStatus
      const view = createIfindDiagnosticView(status, { running, now: now() })
      byId('ifind-enabled').textContent = view.enabledLabel
      byId('ifind-version-id').textContent = view.versionId
      byId('ifind-last-run').textContent = view.lastRunAt === null
        ? '尚未执行'
        : dateText(view.lastRunAt)
      byId('ifind-request-count').textContent = view.requestCount
      byId('ifind-elapsed').textContent = view.elapsed
      byId('ifind-data-vol').textContent = view.dataVol
      byId('ifind-completeness').textContent = view.completeness
      byId('ifind-local-attempt').textContent = view.localAttempt
      byId('ifind-cooldown').textContent = view.cooldownUntil && view.cooldownUntil > now()
        ? `至 ${dateText(view.cooldownUntil)}`
        : '未冷却'
      byId('ifind-official-quota').textContent = view.officialQuota
      byId('ifind-diagnostic-note').textContent = view.errorMessage ||
        '只执行固定的认证与交易日探针，不查询证券或财务数据。'
      function renderStage(id, stage) {
        const node = byId(id)
        node.textContent = stage.label
        node.parentElement.dataset.tone = stage.tone
      }
      renderStage('ifind-auth-stage', view.authStage)
      renderStage('ifind-probe-stage', view.probeStage)
      const button = byId('ifind-run')
      button.textContent = view.run.label
      button.disabled = view.run.disabled
      button.dataset.tone = view.run.tone
      button.setAttribute('aria-busy', String(running))
    }

    function commit(ticket, callback) {
      return sessionLifecycle.commit(ticket, callback)
    }

    function isStale(error) {
      return error && (error.name === 'AbortError' || error.message === 'ADMIN_EPOCH_STALE')
    }

    async function refresh() {
      const ticket = sessionLifecycle.beginRequest()
      try {
        const payload = await request('/api/admin/ifind/diagnostics', { signal: ticket.signal })
        commit(ticket, () => render(payload.data))
      } catch (error) {
        if (isStale(error)) return
        if (error.code === 'ADMIN_AUTH_REQUIRED') {
          await onError(error)
          return
        }
        commit(ticket, () => render(
          error.code === 'IFIND_DIAGNOSTIC_DISABLED' ? null : { mode: 'unavailable' }
        ))
      } finally {
        sessionLifecycle.finishRequest(ticket)
      }
    }

    async function run() {
      const button = byId('ifind-run')
      if (running || button.disabled) return
      const ticket = sessionLifecycle.beginRequest()
      commit(ticket, () => {
        running = true
        render()
      })
      let pendingError = null
      try {
        try {
          const outcome = await request('/api/admin/ifind/diagnostics/run', {
            method: 'POST', body: {}, csrf: true, signal: ticket.signal
          })
          const payload = await request('/api/admin/ifind/diagnostics', { signal: ticket.signal })
          commit(ticket, () => {
            status = payload.data
            const completed = outcome.data && outcome.data.status === 'completed'
            const message = completed
              ? 'iFinD 双级诊断已完成。'
              : ifindDiagnosticErrorMessage(outcome.data && outcome.data.safeErrorClass)
            setLive(message, completed ? 'success' : 'error')
          })
        } catch (error) {
          if (!isStale(error)) {
            if (error.code === 'ADMIN_AUTH_REQUIRED' || error.code === 'ADMIN_CSRF_INVALID') {
              await onError(error)
            } else if (typeof error.code === 'string' && error.code.startsWith('IFIND_DIAGNOSTIC_')) {
              commit(ticket, () => setLive(ifindDiagnosticErrorMessage(error.code), 'error'))
            } else {
              commit(ticket, () => {
                status = { mode: 'unavailable' }
                setLive(ifindDiagnosticErrorMessage('UNKNOWN'), 'error')
              })
            }
          }
        }
      } catch (error) {
        pendingError = error
      }
      let finalizationError = null
      try {
        commit(ticket, () => {
          running = false
          render()
        })
      } catch (error) {
        if (!isStale(error)) finalizationError = error
      }
      sessionLifecycle.finishRequest(ticket)
      if (pendingError) throw pendingError
      if (finalizationError) throw finalizationError
    }

    function bind() {
      if (bound) return
      bound = true
      byId('ifind-run').addEventListener('click', run)
    }

    function reset() {
      status = null
      running = false
      render()
    }

    return Object.freeze({ bind, refresh, render, reset, run })
  }

  function approvedRequestDecision(request) {
    return request && Number.isSafeInteger(request.approvedAt)
      ? Object.freeze({ approvable: false, label: '已批准，等待设备兑换' })
      : Object.freeze({ approvable: true, label: '等待管理员批准' })
  }

  function mutationFailureDecision(code) {
    if (code === 'ADMIN_CSRF_INVALID') {
      return Object.freeze({ clear: true, restore: true, refresh: true, replay: false })
    }
    if (code === 'ADMIN_AUTH_REQUIRED') {
      return Object.freeze({ clear: true, restore: false, refresh: false, replay: false })
    }
    return Object.freeze({ clear: false, restore: false, refresh: false, replay: false })
  }

  function logoutFailureDecision(code) {
    return code === 'ADMIN_AUTH_REQUIRED'
      ? Object.freeze({ revalidate: false, showLogin: true })
      : Object.freeze({ revalidate: true, showLogin: false })
  }

  function createAdminBootstrapGate() {
    let pending = true
    let generation = 0

    function begin() {
      if (!pending) throw new Error('ADMIN_BOOTSTRAP_COMPLETE')
      return Object.freeze({ generation })
    }

    function settle(ticket) {
      if (!pending || !ticket || ticket.generation !== generation) return false
      pending = false
      generation += 1
      return true
    }

    return Object.freeze({
      begin,
      canLogin: () => !pending,
      settle
    })
  }

  function createAdminSecurityState() {
    let csrfToken = null
    let restorePromise = null
    let generation = 0

    function setCsrf(value) {
      generation += 1
      csrfToken = typeof value === 'string' && value.length > 0 ? value : null
      restorePromise = null
    }

    function clear() {
      generation += 1
      csrfToken = null
      restorePromise = null
    }

    function restore(loader) {
      if (restorePromise) return restorePromise
      const restoreGeneration = generation
      let loaded
      try {
        loaded = loader()
      } catch (error) {
        loaded = Promise.reject(error)
      }
      restorePromise = Promise.resolve(loaded)
        .then((result) => {
          if (generation !== restoreGeneration) throw new Error('ADMIN_CSRF_STALE')
          if (!result || typeof result.csrfToken !== 'string' || result.csrfToken.length === 0) {
            throw new Error('ADMIN_CSRF_INVALID')
          }
          csrfToken = result.csrfToken
          return result
        })
        .finally(() => {
          if (restorePromise === currentPromise) restorePromise = null
        })
      const currentPromise = restorePromise
      return restorePromise
    }

    return Object.freeze({ clear, getCsrf: () => csrfToken, restore, setCsrf })
  }

  function createAdminSessionLifecycle() {
    let active = false
    let currentEpoch = 0
    const controllers = new Set()

    function invalidate() {
      active = false
      currentEpoch += 1
      for (const controller of controllers) controller.abort()
      controllers.clear()
    }

    function activate() {
      invalidate()
      active = true
    }

    function suspend() {
      invalidate()
      return Object.freeze({ epoch: currentEpoch })
    }

    function resume(suspension) {
      if (active || !suspension || suspension.epoch !== currentEpoch) return false
      active = true
      return true
    }

    function beginRequest() {
      if (!active) throw new Error('ADMIN_EPOCH_INACTIVE')
      const controller = new AbortController()
      controllers.add(controller)
      return Object.freeze({ controller, epoch: currentEpoch, signal: controller.signal })
    }

    function canCommit(ticket) {
      return active && ticket && ticket.epoch === currentEpoch &&
        ticket.signal.aborted === false && controllers.has(ticket.controller)
    }

    function commit(ticket, callback) {
      if (!canCommit(ticket)) throw new Error('ADMIN_EPOCH_STALE')
      return callback()
    }

    function finishRequest(ticket) {
      if (ticket && ticket.controller) controllers.delete(ticket.controller)
    }

    return Object.freeze({
      activate,
      beginRequest,
      commit,
      finishRequest,
      invalidate,
      resume,
      suspend
    })
  }

  return Object.freeze({
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
  })
})
