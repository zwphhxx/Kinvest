(function exposeAuthUi(root) {
  const contracts = (/** @type {any} */ (root)).KinvestAuth
  const lifecycleContracts = (/** @type {any} */ (root)).KinvestAuthLifecycle
  const pollIntervalMs = 2500
  let requestId = null
  let requestStatus = null
  let pollTimer = null
  let pollController = null
  let pollGeneration = 0
  let networkFailures = 0
  let redeemController = null
  let alreadyUsedConfirmationAttempted = false
  let stopped = false
  let submitBusy = false
  let bound = false
  const redeemRetry = lifecycleContracts.createSingleFlightRetry({
    baseDelayMs: pollIntervalMs,
    maxDelayMs: 15000,
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (timer) => window.clearTimeout(timer)
  })

  const byId = (id) => document.getElementById(id)

  async function api(path, options = {}) {
    let response
    try {
      response = await fetch(path, {
        credentials: 'same-origin',
        ...options,
        headers: {
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.headers || {})
        }
      })
    } catch (error) {
      if (error.name === 'AbortError') throw error
      const failure = contracts.classifyApiFailure(0, {})
      throw Object.assign(new Error('AUTH_REQUEST_FAILED'), { ...failure, status: 0 })
    }
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const failure = contracts.classifyApiFailure(response.status, payload)
      throw Object.assign(new Error('AUTH_REQUEST_FAILED'), {
        ...failure,
        status: response.status
      })
    }
    return payload
  }

  function setLive(message, tone = '') {
    const live = byId('auth-live')
    live.textContent = message
    live.dataset.tone = tone
    live.setAttribute('role', tone === 'error' ? 'alert' : 'status')
    if (tone === 'error' || tone === 'success') live.focus()
  }

  function pausePolling() {
    if (pollTimer !== null) window.clearTimeout(pollTimer)
    pollTimer = null
    if (pollController) pollController.abort()
    pollController = null
  }

  function stopPolling() {
    pausePolling()
    pollGeneration += 1
  }

  function stopRedeem() {
    if (redeemController) redeemController.abort()
    redeemController = null
    redeemRetry.cancel()
  }

  function schedulePoll(generation = pollGeneration, delay = pollIntervalMs) {
    pausePolling()
    if (!requestId || stopped || document.hidden || requestStatus !== 'pending') return
    pollTimer = window.setTimeout(() => pollStatus(generation), delay)
  }

  function showRequest(created) {
    byId('device-request-form').classList.add('hidden')
    byId('request-ticket').classList.remove('hidden')
    byId('request-code').textContent = contracts.formatRequestCode(created.requestCode)
    byId('request-expiry').textContent = contracts.formatExpiry(created.expiresAt)
    setLive('申请已送达管理员审批台，正在等待批准。', 'pending')
  }

  function terminalMessage(status) {
    return {
      expired: '申请已过期，请重新申请。',
      locked: '申请已锁定，请重新申请并把新号码告诉管理员。',
      consumed: '申请已兑换，请刷新页面检查登录状态。'
    }[status] || '这份申请已结束，请重新申请。'
  }

  function terminateWithReapply(message) {
    stopPolling()
    stopRedeem()
    requestStatus = 'consumed'
    setLive(message, 'error')
    byId('request-again').classList.remove('hidden')
  }

  async function handlePollingFailure(error, generation) {
    if (generation !== pollGeneration) return
    const decision = contracts.pollErrorDecision(error)
    if (decision.confirmAuthorization) {
      if (alreadyUsedConfirmationAttempted) {
        terminateWithReapply('这份申请已经结束，请重新申请。')
        return
      }
      alreadyUsedConfirmationAttempted = true
      try {
        const authStatus = contracts.normalizeAuthStatus(await api('/api/auth/status'))
        if (authStatus.authorized) {
          window.location.reload()
          return
        }
      } catch {
        // Confirmation failure is terminal and must never start another poll.
      }
      terminateWithReapply('未能确认这台设备已登录，请重新申请。')
      return
    }
    if (decision.terminal) {
      terminateWithReapply(contracts.authErrorMessage(error.code))
      return
    }
    if (decision.retry) {
      networkFailures += 1
      const delay = Math.min(pollIntervalMs * (2 ** networkFailures), 15000)
      setLive('网络暂时不可用，稍后会自动重试。', 'error')
      schedulePoll(generation, delay)
    }
  }

  async function handleRedeemOutcome(outcome, error, decision, generation) {
    if (generation !== pollGeneration || outcome.kind === 'stale') return
    if (outcome.kind === 'success') {
      window.location.reload()
      return
    }
    if (outcome.kind === 'retry') {
      setLive('设备已批准，网络恢复后会自动重试兑换。', 'error')
      return
    }
    if (decision && decision.confirmAuthorization) {
      if (alreadyUsedConfirmationAttempted) {
        terminateWithReapply('这份申请已经结束，请重新申请。')
        return
      }
      alreadyUsedConfirmationAttempted = true
      try {
        const authStatus = contracts.normalizeAuthStatus(await api('/api/auth/status'))
        if (authStatus.authorized) {
          window.location.reload()
          return
        }
      } catch {
        // A failed one-time confirmation is terminal.
      }
      terminateWithReapply('未能确认这台设备已登录，请重新申请。')
      return
    }
    terminateWithReapply(contracts.authErrorMessage(error && error.code))
  }

  function redeem(generation) {
    return redeemRetry.run(
      generation,
      async () => {
        if (!requestId || generation !== pollGeneration) throw new Error('AUTH_REQUEST_STALE')
        const controller = new AbortController()
        redeemController = controller
        try {
          const payload = await api(`/api/auth/device-requests/${encodeURIComponent(requestId)}/redeem`, {
            method: 'POST',
            body: '{}',
            signal: controller.signal
          })
          if (payload.authorized !== true) {
            throw Object.assign(new Error('AUTH_RESPONSE_INVALID'), {
              code: 'AUTH_RESPONSE_INVALID', status: 400
            })
          }
          return payload
        } finally {
          if (redeemController === controller) redeemController = null
        }
      },
      (error) => contracts.pollErrorDecision(error),
      (outcome, error, decision) => handleRedeemOutcome(outcome, error, decision, generation)
    )
  }

  async function pollStatus(generation = pollGeneration) {
    if (!requestId || stopped || document.hidden || generation !== pollGeneration) return
    const controller = new AbortController()
    pollController = controller
    try {
      const payload = await api(`/api/auth/device-requests/${encodeURIComponent(requestId)}/status`, {
        signal: controller.signal
      })
      if (generation !== pollGeneration) return
      networkFailures = 0
      // Server status is the only authority for pending and terminal transitions.
      requestStatus = contracts.normalizeRequestStatus(payload).status
      if (requestStatus === 'approved') {
        pausePolling()
        redeemRetry.activate(generation)
        setLive('已批准，正在为这台设备建立家庭访问许可。', 'success')
        await redeem(generation)
        return
      }
      const decision = contracts.pollDecision(requestStatus, document.hidden)
      if (decision.terminal) {
        stopPolling()
        setLive(terminalMessage(requestStatus), 'error')
        byId('request-again').classList.remove('hidden')
        return
      }
      setLive('仍在等待管理员批准，可以暂时切换到其他页面。', 'pending')
      if (decision.poll) schedulePoll(generation)
    } catch (error) {
      if (error.name === 'AbortError' || generation !== pollGeneration) return
      await handlePollingFailure(error, generation)
    } finally {
      if (pollController === controller) pollController = null
    }
  }

  async function submitRequest(event) {
    event.preventDefault()
    if (submitBusy) return
    const input = /** @type {HTMLInputElement} */ (byId('device-name'))
    const button = /** @type {HTMLButtonElement} */ (byId('device-request-submit'))
    let deviceName
    try {
      deviceName = contracts.normalizeDeviceName(input.value)
    } catch (error) {
      setLive(contracts.authErrorMessage(error.code), 'error')
      input.focus()
      return
    }

    submitBusy = true
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    input.disabled = true
    setLive('正在创建这台设备的访问申请。', 'pending')
    try {
      const created = await api('/api/auth/device-requests', {
        method: 'POST',
        body: JSON.stringify({ deviceName })
      })
      if (typeof created.requestId !== 'string' || !/^\d{6}$/.test(created.requestCode) ||
        !Number.isSafeInteger(created.expiresAt)) throw new Error('AUTH_RESPONSE_INVALID')
      requestId = created.requestId
      requestStatus = 'pending'
      stopRedeem()
      alreadyUsedConfirmationAttempted = false
      networkFailures = 0
      pollGeneration += 1
      showRequest(created)
      schedulePoll(pollGeneration)
    } catch (error) {
      setLive(contracts.authErrorMessage(error.code), 'error')
      button.disabled = false
      input.disabled = false
    } finally {
      submitBusy = false
      button.setAttribute('aria-busy', 'false')
    }
  }

  function resetRequest() {
    stopPolling()
    stopRedeem()
    requestId = null
    requestStatus = null
    alreadyUsedConfirmationAttempted = false
    byId('request-code').replaceChildren()
    byId('request-ticket').classList.add('hidden')
    byId('request-again').classList.add('hidden')
    byId('device-request-form').classList.remove('hidden')
    const input = /** @type {HTMLInputElement} */ (byId('device-name'))
    const button = /** @type {HTMLButtonElement} */ (byId('device-request-submit'))
    input.disabled = false
    button.disabled = false
    input.focus()
    setLive('请给这台设备起一个家人容易识别的名称。')
  }

  function copyCode() {
    const value = byId('request-code').textContent.replace(/\s/g, '')
    if (!/^\d{6}$/.test(value) || !navigator.clipboard) {
      setLive('请手动记下这 6 位申请码。')
      return
    }
    navigator.clipboard.writeText(value)
      .then(() => setLive('申请码已复制。', 'success'))
      .catch(() => setLive('复制失败，请手动记下申请码。', 'error'))
  }

  function bind() {
    if (bound) return
    bound = true
    byId('device-request-form').addEventListener('submit', submitRequest)
    byId('request-again').addEventListener('click', resetRequest)
    byId('copy-request-code').addEventListener('click', copyCode)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) pausePolling()
      else if (requestStatus === 'pending') pollStatus(pollGeneration)
    })
    window.addEventListener('beforeunload', () => {
      stopped = true
      stopPolling()
      stopRedeem()
    })
  }

  function applyTopLevelState(mode) {
    const visibility = contracts.topLevelVisibility(mode)
    byId('auth-checking').classList.toggle('hidden', !visibility.checking)
    byId('auth-gate').classList.toggle('hidden', !visibility.gate)
    byId('dashboard-shell').classList.toggle('hidden', !visibility.dashboard)
  }

  function showGate() {
    stopped = false
    applyTopLevelState('gate')
    bind()
    byId('device-name').focus()
  }

  function showDashboard() {
    stopped = true
    stopPolling()
    stopRedeem()
    applyTopLevelState('dashboard')
  }

  function showUnavailable() {
    stopped = true
    stopPolling()
    stopRedeem()
    applyTopLevelState('checking')
    byId('auth-checking-text').textContent = '暂时无法确认设备状态。为了保护家庭数据，页面没有继续加载。'
    const retry = byId('auth-retry')
    retry.classList.remove('hidden')
    retry.addEventListener('click', () => window.location.reload(), { once: true })
    retry.focus()
  }

  (/** @type {any} */ (root)).KinvestAuthUi = Object.freeze({
    showDashboard,
    showGate,
    showUnavailable
  })
})(window)
