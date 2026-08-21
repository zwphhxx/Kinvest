(function exposeAuthUi(root) {
  const contracts = (/** @type {any} */ (root)).KinvestAuth
  const pollIntervalMs = 2500
  let requestId = null
  let requestStatus = null
  let pollTimer = null
  let pollController = null
  let pollGeneration = 0
  let networkFailures = 0
  let redeemPromise = null
  let stopped = false
  let submitBusy = false
  let bound = false

  const byId = (id) => document.getElementById(id)

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers || {})
      }
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw Object.assign(new Error('AUTH_REQUEST_FAILED'), {
        code: typeof payload.error === 'string' ? payload.error : 'UNKNOWN'
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

  async function redeemOnce(generation) {
    if (!requestId || generation !== pollGeneration) return
    pausePolling()
    setLive('已批准，正在为这台设备建立家庭访问许可。', 'success')
    try {
      const payload = await api(`/api/auth/device-requests/${encodeURIComponent(requestId)}/redeem`, {
        method: 'POST',
        body: '{}'
      })
      if (payload.authorized !== true) throw new Error('AUTH_REQUEST_FAILED')
      window.location.reload()
    } catch (error) {
      if (error.code === 'REQUEST_ALREADY_USED') {
        const authStatus = contracts.normalizeAuthStatus(await api('/api/auth/status'))
        if (authStatus.authorized) {
          window.location.reload()
          return
        }
      }
      setLive(contracts.authErrorMessage(error.code), 'error')
      byId('request-again').classList.remove('hidden')
    }
  }

  function redeem(generation) {
    if (!redeemPromise) redeemPromise = redeemOnce(generation)
    return redeemPromise
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
      setLive(contracts.authErrorMessage(error.code), 'error')
      networkFailures += 1
      const delay = Math.min(pollIntervalMs * (2 ** networkFailures), 15000)
      schedulePoll(generation, delay)
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
      redeemPromise = null
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
    requestId = null
    requestStatus = null
    redeemPromise = null
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
    })
  }

  function showGate() {
    stopped = false
    byId('auth-checking').classList.add('hidden')
    byId('dashboard-shell').classList.add('hidden')
    byId('auth-gate').classList.remove('hidden')
    bind()
    byId('device-name').focus()
  }

  function showDashboard() {
    stopped = true
    stopPolling()
    byId('auth-checking').classList.add('hidden')
    byId('auth-gate').classList.add('hidden')
    byId('dashboard-shell').classList.remove('hidden')
  }

  function showUnavailable() {
    stopped = true
    stopPolling()
    byId('auth-gate').classList.add('hidden')
    byId('dashboard-shell').classList.add('hidden')
    byId('auth-checking').classList.remove('hidden')
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
