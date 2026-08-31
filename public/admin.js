(function startAdminDesk() {
  const contracts = /** @type {any} */ (window).KinvestAuth
  const adminContracts = /** @type {any} */ (window).KinvestAdmin
  const reportPeriodContracts = /** @type {any} */ (window).KinvestReportPeriod
  const securityState = adminContracts.createAdminSecurityState()
  const sessionLifecycle = adminContracts.createAdminSessionLifecycle()
  const bootstrapGate = adminContracts.createAdminBootstrapGate()
  const busy = new Set()
  const byId = (id) => document.getElementById(id)

  function setLive(message, tone = '') {
    const live = byId('admin-live')
    live.textContent = message
    live.dataset.tone = tone
    live.setAttribute('role', tone === 'error' ? 'alert' : 'status')
    if (tone === 'error' || tone === 'success') live.focus()
  }

  function setBusy(key, button, value) {
    if (value) busy.add(key)
    else busy.delete(key)
    button.disabled = value
    button.setAttribute('aria-busy', String(value))
  }

  function setBootstrapPending(value) {
    const form = byId('admin-login-form')
    const password = /** @type {HTMLInputElement} */ (byId('admin-password'))
    const button = /** @type {HTMLButtonElement} */ (byId('admin-login-submit'))
    form.setAttribute('aria-busy', String(value))
    password.disabled = value
    button.disabled = value || busy.has('login')
    const checkingMessage = '正在检查管理员会话，请稍候。'
    if (value) setLive(checkingMessage)
    else if (byId('admin-live').textContent === checkingMessage) setLive('')
  }

  /**
   * @param {string} path
   * @param {{ method?: string, body?: object, csrf?: boolean, signal?: AbortSignal }} [options]
   */
  async function api(path, options = {}) {
    const { method = 'GET', body, csrf = false, signal } = options
    const headers = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (csrf) {
      const csrfToken = securityState.getCsrf()
      if (!csrfToken) throw Object.assign(new Error('ADMIN_AUTH_REQUIRED'), { code: 'ADMIN_AUTH_REQUIRED' })
      headers['x-kinvest-csrf'] = csrfToken
    }
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers,
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const failure = path.startsWith('/api/admin/ifind/report-period-diagnostic') && reportPeriodContracts
        ? reportPeriodContracts.apiFailure(response.status, payload)
        : path.startsWith('/api/admin/ifind/calibration')
        ? adminContracts.ifindCalibrationApiFailure(response.status, payload)
        : (path.startsWith('/api/admin/ifind/market-cases')
            ? adminContracts.ifindMarketDiagnosticApiFailure(response.status, payload)
            : (path.startsWith('/api/admin/ifind/diagnostics')
                ? adminContracts.ifindDiagnosticApiFailure(response.status, payload)
                : contracts.classifyApiFailure(response.status, payload)))
      throw Object.assign(new Error('ADMIN_REQUEST_FAILED'), {
        ...failure,
        status: response.status
      })
    }
    return payload
  }

  async function runAdminWrite(operation, onCommit) {
    const ticket = sessionLifecycle.beginRequest()
    try {
      const result = await operation(ticket.signal)
      return await sessionLifecycle.commit(ticket, () => onCommit(result))
    } catch (error) {
      if (error.name === 'AbortError' || error.message === 'ADMIN_EPOCH_STALE') return undefined
      throw error
    } finally {
      sessionLifecycle.finishRequest(ticket)
    }
  }

  function dateText(value) {
    return Number.isSafeInteger(value)
      ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
      : '未知时间'
  }

  function text(tag, value, className = '') {
    const node = document.createElement(tag)
    node.textContent = value
    if (className) node.className = className
    return node
  }

  function clearAdminSensitiveState() {
    sessionLifecycle.invalidate()
    securityState.clear()
    for (const id of ['admin-password', 'revoke-all-password', 'revoke-all-phrase']) {
      const input = /** @type {HTMLInputElement} */ (byId(id))
      if (input) input.value = ''
    }
    for (const input of document.querySelectorAll('.approval-code-input')) {
      (/** @type {HTMLInputElement} */ (input)).value = ''
    }
    byId('pending-requests').replaceChildren()
    byId('approved-devices').replaceChildren()
    byId('auth-audit').replaceChildren()
    ifindController.reset()
    ifindMarketController.reset()
    ifindCalibrationController.reset()
    ifindReportPeriodController.reset()
  }

  function showLogin(message = '') {
    clearAdminSensitiveState()
    byId('admin-desk').classList.add('hidden')
    byId('admin-login').classList.remove('hidden')
    if (message) setLive(message, 'error')
    byId('admin-password').focus()
  }

  function showDesk() {
    byId('admin-login').classList.add('hidden')
    byId('admin-desk').classList.remove('hidden')
  }

  async function restoreCsrf() {
    return securityState.restore(() => api('/api/admin/csrf', { method: 'POST', body: {} }))
  }

  async function handleError(error) {
    const decision = adminContracts.mutationFailureDecision(error.code)
    if (decision.clear) clearAdminSensitiveState()
    if (error.code === 'ADMIN_AUTH_REQUIRED') {
      showLogin(contracts.authErrorMessage(error.code))
      return
    }
    if (error.code === 'ADMIN_CSRF_INVALID') {
      try {
        await restoreCsrf()
        sessionLifecycle.activate()
        await refreshLists()
        setLive('操作凭证已更新，请重新执行刚才的操作。', 'error')
      } catch {
        showLogin('管理员会话已结束，请重新登录。')
      }
      return
    }
    setLive(contracts.authErrorMessage(error.code), 'error')
  }

  function emptyState(message) {
    return text('p', message, 'admin-empty')
  }

  function renderPending(items) {
    const list = byId('pending-requests')
    list.replaceChildren()
    if (!Array.isArray(items) || items.length === 0) {
      list.appendChild(emptyState('现在没有等待审批的设备。'))
      return
    }
    for (const item of items) {
      const row = document.createElement('article')
      row.className = 'admin-row'
      const heading = document.createElement('div')
      heading.className = 'admin-row-head'
      heading.append(text('strong', item.deviceName || '未命名设备'))
      heading.append(text('span', `到期 ${dateText(item.expiresAt)}`, 'admin-meta'))
      const form = document.createElement('form')
      const decision = adminContracts.approvedRequestDecision(item)
      if (!decision.approvable) {
        row.append(heading, text('p', decision.label, 'admin-meta'))
        list.appendChild(row)
        continue
      }
      const label = text('label', '输入家人屏幕上的 6 位申请码', 'auth-field')
      const input = document.createElement('input')
      input.className = 'approval-code-input'
      input.inputMode = 'numeric'
      input.autocomplete = 'one-time-code'
      input.maxLength = 6
      input.pattern = '[0-9]{6}'
      input.required = true
      const button = text('button', '批准这台设备', 'auth-primary')
      button.type = 'submit'
      label.appendChild(input)
      form.append(label, button)
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        const key = `approve:${item.requestId}`
        if (busy.has(key)) return
        setBusy(key, button, true)
        try {
          await runAdminWrite(
            (signal) => api(`/api/admin/device-requests/${encodeURIComponent(item.requestId)}/approve`, {
              method: 'POST', body: { requestCode: input.value }, csrf: true, signal
            }),
            () => {
              setLive('设备申请已批准。', 'success')
              return refreshLists()
            }
          )
        } catch (error) {
          await handleError(error)
        } finally {
          setBusy(key, button, false)
        }
      })
      row.append(heading, text('p', `已失败尝试 ${item.failedAttempts || 0} 次`, 'admin-meta'), form)
      list.appendChild(row)
    }
  }

  function renderDevices(items) {
    const list = byId('approved-devices')
    list.replaceChildren()
    if (!Array.isArray(items) || items.length === 0) {
      list.appendChild(emptyState('还没有已授权设备。'))
      return
    }
    for (const item of items) {
      const row = document.createElement('article')
      row.className = 'admin-row'
      const heading = document.createElement('div')
      heading.className = 'admin-row-head'
      heading.append(text('strong', item.deviceName || `设备 ${String(item.deviceId || '').slice(0, 8)}`))
      const button = text('button', '撤销', 'auth-danger')
      button.type = 'button'
      button.addEventListener('click', async () => {
        const key = `revoke:${item.credentialId}`
        if (busy.has(key) || !window.confirm('确认立即撤销这台设备吗？')) return
        setBusy(key, button, true)
        try {
          await runAdminWrite(
            (signal) => api(`/api/admin/devices/${encodeURIComponent(item.credentialId)}/revoke`, {
              method: 'POST', body: {}, csrf: true, signal
            }),
            () => {
              setLive('设备访问已撤销。', 'success')
              return refreshLists()
            }
          )
        } catch (error) {
          await handleError(error)
        } finally {
          setBusy(key, button, false)
        }
      })
      heading.appendChild(button)
      row.append(
        heading,
        text('p', `最近使用 ${dateText(item.lastUsedAt)} · 最晚到期 ${dateText(item.absoluteExpiresAt)}`, 'admin-meta')
      )
      list.appendChild(row)
    }
  }

  function renderAudit(payload) {
    const list = byId('auth-audit')
    list.replaceChildren()
    const entries = [
      ...(Array.isArray(payload.admin) ? payload.admin : []),
      ...(Array.isArray(payload.device) ? payload.device : [])
    ].sort((a, b) => Number(b.occurredAt) - Number(a.occurredAt)).slice(0, 60)
    if (entries.length === 0) {
      list.appendChild(emptyState('暂无安全记录。'))
      return
    }
    for (const item of entries) {
      const row = document.createElement('article')
      row.className = 'admin-row'
      row.append(
        text('strong', item.eventType || '安全事件'),
        text('p', `${dateText(item.occurredAt)} · ${item.subjectId ? String(item.subjectId).slice(0, 12) : '系统'}`, 'admin-meta')
      )
      list.appendChild(row)
    }
  }

  async function refreshLists() {
    const ticket = sessionLifecycle.beginRequest()
    try {
      const requestOptions = { signal: ticket.signal }
      const [pending, devices, audit] = await Promise.all([
        api('/api/admin/device-requests', requestOptions),
        api('/api/admin/devices', requestOptions),
        api('/api/admin/audit', requestOptions)
      ])
      sessionLifecycle.commit(ticket, () => {
        renderPending(pending.data)
        renderDevices(devices.data)
        renderAudit(audit.data || {})
      })
    } catch (error) {
      if (error.name === 'AbortError' || error.message === 'ADMIN_EPOCH_STALE') return
      throw error
    } finally {
      sessionLifecycle.finishRequest(ticket)
    }
    await Promise.all([
      ifindController.refresh(), ifindMarketController.refresh(), ifindCalibrationController.refresh(),
      ifindReportPeriodController.refresh()
    ])
  }

  const ifindController = adminContracts.createIfindDiagnosticController({
    document,
    sessionLifecycle,
    request: api,
    dateText,
    now: () => Date.now(),
    setLive,
    onError: handleError
  })
  ifindController.bind()

  const ifindMarketController = adminContracts.createIfindMarketDiagnosticController({
    document,
    sessionLifecycle,
    request: api,
    dateText,
    now: () => Date.now(),
    setLive,
    onError: handleError
  })
  ifindMarketController.bind()

  const ifindCalibrationController = adminContracts.createIfindCalibrationController({
    document,
    sessionLifecycle,
    request: api,
    dateText,
    confirm: (message) => window.confirm(message),
    setLive,
    onError: async (error) => {
      // Calibration never restores credentials or replays a business request automatically.
      showLogin(adminContracts.ifindCalibrationErrorMessage(error.code))
    }
  })
  ifindCalibrationController.bind()

  // A missing script keeps this independent panel disabled; it cannot run a query.
  const ifindReportPeriodController = reportPeriodContracts
    ? reportPeriodContracts.createController({
        document, sessionLifecycle, request: api, dateText,
        confirm: (message) => window.confirm(message), setLive,
        onError: async (error) => showLogin(reportPeriodContracts.errorMessage(error.code))
      })
    : { bind() {}, refresh() {}, reset() {} }
  ifindReportPeriodController.bind()

  byId('admin-login-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const button = /** @type {HTMLButtonElement} */ (byId('admin-login-submit'))
    const passwordInput = /** @type {HTMLInputElement} */ (byId('admin-password'))
    if (!bootstrapGate.canLogin()) {
      setLive('正在检查管理员会话，请稍候。')
      return
    }
    if (busy.has('login')) return
    setBusy('login', button, true)
    try {
      const result = await api('/api/admin/login', {
        method: 'POST', body: { password: passwordInput.value }
      })
      securityState.setCsrf(result.csrfToken)
      sessionLifecycle.activate()
      passwordInput.value = ''
      showDesk()
      setLive('管理员会话已建立。', 'success')
      await refreshLists()
    } catch (error) {
      passwordInput.value = ''
      await handleError(error)
    } finally {
      setBusy('login', button, false)
    }
  })

  byId('revoke-all-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const button = /** @type {HTMLButtonElement} */ (byId('revoke-all-submit'))
    const phraseInput = /** @type {HTMLInputElement} */ (byId('revoke-all-phrase'))
    const passwordInput = /** @type {HTMLInputElement} */ (byId('revoke-all-password'))
    if (busy.has('revoke-all')) return
    if (phraseInput.value !== '撤销全部设备') {
      setLive('请完整输入“撤销全部设备”后再继续。', 'error')
      phraseInput.focus()
      return
    }
    setBusy('revoke-all', button, true)
    try {
      await runAdminWrite(
        (signal) => api('/api/admin/devices/revoke-all', {
          method: 'POST', body: { password: passwordInput.value }, csrf: true, signal
        }),
        () => {
          passwordInput.value = ''
          phraseInput.value = ''
          setLive('所有设备访问已撤销。', 'success')
          return refreshLists()
        }
      )
    } catch (error) {
      passwordInput.value = ''
      await handleError(error)
    } finally {
      setBusy('revoke-all', button, false)
    }
  })

  byId('admin-logout').addEventListener('click', async () => {
    const button = /** @type {HTMLButtonElement} */ (byId('admin-logout'))
    if (busy.has('logout')) return
    const suspension = sessionLifecycle.suspend()
    setBusy('logout', button, true)
    try {
      await api('/api/admin/logout', { method: 'POST', body: {}, csrf: true })
      clearAdminSensitiveState()
      showLogin()
      setLive('管理员已退出。', 'success')
    } catch (error) {
      const decision = adminContracts.logoutFailureDecision(error.code)
      if (decision.showLogin) {
        clearAdminSensitiveState()
        showLogin(contracts.authErrorMessage(error.code))
      } else if (decision.revalidate) {
        try {
          await restoreCsrf()
          if (!sessionLifecycle.resume(suspension)) {
            clearAdminSensitiveState()
            showLogin('无法确认管理员会话状态，请重新登录。')
            return
          }
          await refreshLists()
          setLive('退出未完成，会话仍有效，请重试。', 'error')
        } catch {
          clearAdminSensitiveState()
          showLogin('无法确认管理员会话状态，请重新登录。')
        }
      }
    } finally {
      setBusy('logout', button, false)
    }
  })

  async function bootstrap() {
    const bootstrapTicket = bootstrapGate.begin()
    setBootstrapPending(true)
    try {
      await restoreCsrf()
    } catch {
      if (!bootstrapGate.settle(bootstrapTicket)) return
      setBootstrapPending(false)
      showLogin()
      return
    }
    if (!bootstrapGate.settle(bootstrapTicket)) return
    setBootstrapPending(false)
    sessionLifecycle.activate()
    showDesk()
    try {
      await refreshLists()
    } catch (error) {
      await handleError(error)
    }
  }

  window.addEventListener('beforeunload', () => {
    clearAdminSensitiveState()
  })

  bootstrap()
})()
