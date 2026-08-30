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
  const IFIND_MARKET_CASES = Object.freeze([
    Object.freeze({ caseId: 'HK_ALIBABA_9988', key: 'hk', marketLabel: '港股' }),
    Object.freeze({ caseId: 'US_APPLE_AAPL', key: 'us', marketLabel: '美股' }),
    Object.freeze({ caseId: 'CN_MOUTAI_600519', key: 'cn', marketLabel: 'A 股' })
  ])
  const IFIND_MARKET_API_ERRORS = new Set([
    'IFIND_MARKET_DIAGNOSTIC_DISABLED',
    'IFIND_MARKET_DIAGNOSTIC_UNAVAILABLE',
    'IFIND_MARKET_DIAGNOSTIC_BUSY',
    'IFIND_MARKET_DIAGNOSTIC_COOLDOWN',
    'IFIND_MARKET_CASE_DAILY_LIMIT',
    'IFIND_MARKET_GLOBAL_DAILY_LIMIT',
    'IFIND_MARKET_CASE_UNAVAILABLE',
    'ADMIN_AUTH_REQUIRED',
    'ADMIN_CSRF_INVALID'
  ])
  const IFIND_MARKET_CONTROL_MESSAGES = Object.freeze({
    IFIND_MARKET_DIAGNOSTIC_DISABLED: '三市场诊断尚未启用。',
    IFIND_MARKET_DIAGNOSTIC_UNAVAILABLE: '三市场诊断暂不可用。',
    IFIND_MARKET_DIAGNOSTIC_BUSY: '另一项市场诊断正在运行。',
    IFIND_MARKET_DIAGNOSTIC_COOLDOWN: '此案例正在冷却，请稍后重试。',
    IFIND_MARKET_CASE_DAILY_LIMIT: '此案例今日诊断次数已达上限。',
    IFIND_MARKET_GLOBAL_DAILY_LIMIT: '今日三市场诊断总次数已达上限。',
    IFIND_MARKET_CASE_UNAVAILABLE: '此固定案例尚未完成指标核验。',
    ADMIN_AUTH_REQUIRED: '管理员会话已结束，请重新登录。',
    ADMIN_CSRF_INVALID: '操作凭证已失效，请刷新后重试。'
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

  function ifindMarketDiagnosticErrorMessage(code) {
    if (Object.hasOwn(IFIND_SAFE_ERROR_MESSAGES, code)) return IFIND_SAFE_ERROR_MESSAGES[code]
    if (Object.hasOwn(IFIND_MARKET_CONTROL_MESSAGES, code)) {
      return IFIND_MARKET_CONTROL_MESSAGES[code]
    }
    return '市场诊断未完成，请检查安全状态后重试。'
  }

  function ifindMarketDiagnosticApiFailure(status, payload) {
    const code = payload && IFIND_MARKET_API_ERRORS.has(payload.error)
      ? payload.error
      : 'UNKNOWN'
    return Object.freeze({
      code,
      message: ifindMarketDiagnosticErrorMessage(code),
      retryable: code !== 'IFIND_MARKET_CASE_UNAVAILABLE' &&
        (status >= 500 || code === 'IFIND_MARKET_DIAGNOSTIC_BUSY' ||
          code === 'IFIND_MARKET_DIAGNOSTIC_COOLDOWN')
    })
  }

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value)
  }

  function safeString(value, fallback = '—') {
    return typeof value === 'string' && value.length > 0 ? value : fallback
  }

  function safeTimestamp(value, dateText, fallback = '尚未执行') {
    return Number.isSafeInteger(value) && value >= 0 ? dateText(value) : fallback
  }

  function marketStatusLabel(value) {
    const labels = {
      available: '已验证',
      unavailable: '不可用',
      not_run: '未运行'
    }
    return Object.hasOwn(labels, value) ? labels[value] : '尚未验证'
  }

  function tradingStatusLabel(value) {
    const labels = {
      trading: '交易中',
      closed: '已收市',
      halted: '停牌',
      pre_open: '盘前',
      post_close: '盘后'
    }
    return Object.hasOwn(labels, value) ? labels[value] : '状态不可用'
  }

  function uniqueSafeStrings(values) {
    const seen = new Set()
    const result = []
    for (const value of values) {
      if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
      seen.add(value)
      result.push(value)
    }
    return result
  }

  function marketOutcomePresentation(status) {
    const outcomes = {
      complete: {
        label: '完整完成', message: '固定市场案例诊断已完成。', tone: 'success'
      },
      partial: {
        label: '部分完成',
        message: '固定市场案例诊断部分完成，请查看缺失字段与安全错误。',
        tone: 'warning'
      },
      failed: {
        label: '执行失败',
        message: '固定市场案例诊断失败，请查看安全错误后重试。',
        tone: 'error'
      }
    }
    return Object.hasOwn(outcomes, status) ? outcomes[status] : {
      label: '结果状态不可用', message: '无法确认市场诊断结果，请刷新状态后重试。', tone: 'error'
    }
  }

  function marketRunDecision({ entry, runtimeStatus, runningCaseId, now }) {
    if (runningCaseId) {
      return Object.freeze({
        disabled: true,
        label: runningCaseId === entry.case.caseId ? '正在运行…' : '等待当前诊断',
        tone: 'running'
      })
    }
    if (runtimeStatus === 'disabled') {
      return Object.freeze({ disabled: true, label: '诊断未启用', tone: 'disabled' })
    }
    if (runtimeStatus !== 'available') {
      return Object.freeze({ disabled: true, label: '状态不可用', tone: 'disabled' })
    }
    if (entry.case.liveReady !== true) {
      return Object.freeze({ disabled: true, label: '指标尚未核验', tone: 'disabled' })
    }
    const quota = entry.quota
    if (!quota || quota.localStatus !== 'available') {
      return Object.freeze({ disabled: true, label: '配额状态不可用', tone: 'disabled' })
    }
    if (quota.inFlight === true) {
      return Object.freeze({ disabled: true, label: '诊断占用中', tone: 'running' })
    }
    if (Number.isSafeInteger(quota.cooldownUntil) && quota.cooldownUntil > now) {
      return Object.freeze({ disabled: true, label: '冷却中', tone: 'cooldown' })
    }
    if (quota.caseRemaining === 0 || quota.globalRemaining === 0) {
      return Object.freeze({ disabled: true, label: '今日已达上限', tone: 'daily-limit' })
    }
    return Object.freeze({ disabled: false, label: '运行此案例', tone: 'ready' })
  }

  function createIfindMarketCardView(config, entry, context) {
    const emptyCase = {
      caseId: config.caseId,
      companyName: '案例不可用',
      displayCode: '—',
      liveReady: false
    }
    const normalizedEntry = entry && entry.case && entry.case.caseId === config.caseId
      ? entry
      : { case: emptyCase, latest: null, quota: null }
    const presentation = normalizedEntry.case
    const latest = normalizedEntry.latest && typeof normalizedEntry.latest === 'object'
      ? normalizedEntry.latest
      : null
    const quote = latest && latest.quote && typeof latest.quote === 'object'
      ? latest.quote
      : null
    const financial = latest && Array.isArray(latest.financial) ? latest.financial : []
    const reportingCurrencies = uniqueSafeStrings(financial.map((point) =>
      safeString(point && point.currency, '未提供')
    ))
    const result = context.runningCaseId === config.caseId
      ? { label: '正在运行', tone: 'running' }
      : (latest ? marketOutcomePresentation(latest.status) : { label: '尚未执行', tone: 'idle' })
    const periods = uniqueSafeStrings(financial.map((point) => point && point.reportPeriod))
    const units = uniqueSafeStrings(financial.map((point) => point && point.unit))
    const missing = financial
      .filter((point) => point && point.availability === 'missing')
      .map((point) => `${safeString(point.metricKey)} / ${safeString(point.reportPeriod)}`)
    const quota = normalizedEntry.quota
    const cooldown = quota && Number.isSafeInteger(quota.cooldownUntil) &&
      quota.cooldownUntil > context.now
      ? `至 ${context.dateText(quota.cooldownUntil)}`
      : '可运行'
    const dailyAllowance = quota && quota.localStatus === 'available' &&
      Number.isSafeInteger(quota.caseRemaining) && Number.isSafeInteger(quota.globalRemaining)
      ? `个案 ${quota.caseRemaining} / 5 · 全局 ${quota.globalRemaining} / 12`
      : '本地额度不可用'
    const safeError = latest && typeof latest.safeErrorClass === 'string'
      ? ifindMarketDiagnosticErrorMessage(latest.safeErrorClass)
      : '无'
    return Object.freeze({
      caseId: config.caseId,
      key: config.key,
      marketLabel: config.marketLabel,
      companyName: safeString(presentation.companyName, '案例不可用'),
      displayCode: safeString(presentation.displayCode),
      lastRun: latest ? safeTimestamp(latest.completedAt, context.dateText) : '尚未执行',
      runStatus: result.label,
      runStatusTone: result.tone,
      cooldown,
      dailyAllowance,
      price: quote && finiteNumber(quote.latestPrice) ? String(quote.latestPrice) : '—',
      quoteTime: quote ? safeString(quote.quoteTime) : '—',
      tradingStatus: quote ? tradingStatusLabel(quote.tradingStatus) : '尚无行情',
      tradingCurrency: quote ? safeString(quote.currency) : '—',
      reportingCurrency: reportingCurrencies.length > 0 ? reportingCurrencies.join(' · ') : '—',
      units: units.length > 0 ? units.join(' · ') : '—',
      periods: periods.length > 0 ? periods.join(' · ') : '—',
      validation: latest
        ? `行情 ${marketStatusLabel(latest.quoteStatus)} · 财务 ${marketStatusLabel(latest.financeStatus)}`
        : '行情 尚未验证 · 财务 尚未验证',
      missingFields: missing.length > 0
        ? missing.join('；')
        : (latest && latest.financeStatus === 'unavailable' ? '财务数据不可用' : '无'),
      safeError,
      run: marketRunDecision({
        entry: normalizedEntry,
        runtimeStatus: context.runtimeStatus,
        runningCaseId: context.runningCaseId,
        now: context.now
      })
    })
  }

  function createIfindMarketDiagnosticView(status, options = {}) {
    const now = Number.isSafeInteger(options.now) ? options.now : Date.now()
    const dateText = typeof options.dateText === 'function'
      ? options.dateText
      : (value) => new Date(value).toLocaleString('zh-CN')
    const cases = status && Array.isArray(status.cases) ? status.cases : []
    const byCaseId = new Map()
    for (const entry of cases) {
      const caseId = entry && entry.case && typeof entry.case.caseId === 'string'
        ? entry.case.caseId
        : null
      if (IFIND_MARKET_CASES.some((item) => item.caseId === caseId) && !byCaseId.has(caseId)) {
        byCaseId.set(caseId, entry)
      }
    }
    const runtimeStatus = status && status.runtimeStatus === 'available'
      ? 'available'
      : (status && status.runtimeStatus === 'disabled' ? 'disabled' : 'unavailable')
    const runningCaseId = IFIND_MARKET_CASES.some((item) => item.caseId === options.runningCaseId)
      ? options.runningCaseId
      : null
    return Object.freeze({
      statusLabel: runtimeStatus === 'available'
        ? '固定案例已就绪'
        : (runtimeStatus === 'disabled' ? '三市场诊断未启用' : '三市场诊断状态不可用'),
      note: runtimeStatus === 'available'
        ? '管理员诊断专用；家庭看板继续使用 Mock 数据。'
        : (runtimeStatus === 'disabled'
            ? '管理员诊断后端未启用；家庭看板继续使用 Mock 数据。'
            : '无法确认三市场诊断状态；家庭看板继续使用 Mock 数据。'),
      cards: Object.freeze(IFIND_MARKET_CASES.map((config) =>
        createIfindMarketCardView(config, byCaseId.get(config.caseId), {
          dateText, now, runningCaseId, runtimeStatus
        })
      ))
    })
  }

  function createIfindMarketDiagnosticController(options) {
    const documentRef = options.document
    const sessionLifecycle = options.sessionLifecycle
    const request = options.request
    const dateText = options.dateText
    const now = options.now
    const setLive = options.setLive
    const onError = options.onError
    const scheduleTimeout = typeof options.setTimeout === 'function'
      ? options.setTimeout
      : globalThis.setTimeout.bind(globalThis)
    const cancelTimeout = typeof options.clearTimeout === 'function'
      ? options.clearTimeout
      : globalThis.clearTimeout.bind(globalThis)
    let status = null
    let runningCaseId = null
    let bound = false
    let cooldownTimer = null
    let refreshGeneration = 0
    const byId = (id) => documentRef.getElementById(id)

    function isStale(error) {
      return error && (error.name === 'AbortError' || error.message === 'ADMIN_EPOCH_STALE')
    }

    function clearCooldownTimer() {
      if (cooldownTimer === null) return
      cancelTimeout(cooldownTimer)
      cooldownTimer = null
    }

    function scheduleCooldownRefresh() {
      clearCooldownTimer()
      if (runningCaseId || !status || status.runtimeStatus !== 'available' ||
        !Array.isArray(status.cases)) return
      const currentTime = now()
      let nearest = null
      for (const entry of status.cases) {
        const cooldownUntil = entry && entry.quota && entry.quota.cooldownUntil
        if (!Number.isSafeInteger(cooldownUntil) || cooldownUntil <= currentTime) continue
        if (nearest === null || cooldownUntil < nearest) nearest = cooldownUntil
      }
      if (nearest === null) return
      cooldownTimer = scheduleTimeout(() => {
        cooldownTimer = null
        try {
          return Promise.resolve(refresh()).catch((error) => {
            if (!isStale(error)) clearCooldownTimer()
          })
        } catch {
          clearCooldownTimer()
          return undefined
        }
      }, nearest - currentTime)
    }

    function render(nextStatus = status) {
      status = nextStatus
      const view = createIfindMarketDiagnosticView(status, {
        dateText,
        now: now(),
        runningCaseId
      })
      byId('ifind-market-status').textContent = view.statusLabel
      byId('ifind-market-note').textContent = view.note
      for (const card of view.cards) {
        const prefix = `ifind-market-${card.key}`
        byId(`${prefix}-company`).textContent = card.companyName
        byId(`${prefix}-code`).textContent = card.displayCode
        byId(`${prefix}-last-run`).textContent = card.lastRun
        byId(`${prefix}-run-status`).textContent = card.runStatus
        byId(`${prefix}-run-status`).dataset.tone = card.runStatusTone
        byId(`${prefix}-cooldown`).textContent = card.cooldown
        byId(`${prefix}-daily`).textContent = card.dailyAllowance
        byId(`${prefix}-price`).textContent = card.price
        byId(`${prefix}-quote-time`).textContent = card.quoteTime
        byId(`${prefix}-trading-status`).textContent = card.tradingStatus
        byId(`${prefix}-trading-currency`).textContent = card.tradingCurrency
        byId(`${prefix}-reporting-currency`).textContent = card.reportingCurrency
        byId(`${prefix}-units`).textContent = card.units
        byId(`${prefix}-periods`).textContent = card.periods
        byId(`${prefix}-validation`).textContent = card.validation
        byId(`${prefix}-missing`).textContent = card.missingFields
        byId(`${prefix}-error`).textContent = card.safeError
        const button = byId(`${prefix}-run`)
        button.textContent = card.run.label
        button.disabled = card.run.disabled
        button.dataset.tone = card.run.tone
        button.setAttribute('aria-busy', String(runningCaseId === card.caseId))
      }
      scheduleCooldownRefresh()
    }

    async function refresh() {
      const generation = ++refreshGeneration
      let ticket
      try {
        ticket = sessionLifecycle.beginRequest()
      } catch (error) {
        clearCooldownTimer()
        if (error && error.message === 'ADMIN_EPOCH_INACTIVE') return
        throw error
      }
      try {
        const payload = await request('/api/admin/ifind/market-cases', { signal: ticket.signal })
        sessionLifecycle.commit(ticket, () => {
          if (generation === refreshGeneration) render(payload.data)
        })
      } catch (error) {
        if (isStale(error)) {
          clearCooldownTimer()
          return
        }
        if (generation !== refreshGeneration) return
        if (error.code === 'ADMIN_AUTH_REQUIRED') {
          clearCooldownTimer()
          await onError(error)
          return
        }
        sessionLifecycle.commit(ticket, () => render({ runtimeStatus: 'unavailable', cases: [] }))
      } finally {
        sessionLifecycle.finishRequest(ticket)
      }
    }

    async function run(caseId) {
      const config = IFIND_MARKET_CASES.find((item) => item.caseId === caseId)
      if (!config || runningCaseId) return
      const button = byId(`ifind-market-${config.key}-run`)
      if (button.disabled) return
      const generation = ++refreshGeneration
      const ticket = sessionLifecycle.beginRequest()
      sessionLifecycle.commit(ticket, () => {
        runningCaseId = caseId
        render()
      })
      let finalizationError = null
      try {
        let outcome = null
        try {
          outcome = await request(`/api/admin/ifind/market-cases/${caseId}/run`, {
            method: 'POST', body: {}, csrf: true, signal: ticket.signal
          })
        } catch (error) {
          if (isStale(error)) return
          if (error.code === 'ADMIN_AUTH_REQUIRED' || error.code === 'ADMIN_CSRF_INVALID') {
            await onError(error)
            return
          }
          sessionLifecycle.commit(ticket, () => {
            setLive(ifindMarketDiagnosticErrorMessage(error.code), 'error')
          })
        }
        const payload = await request('/api/admin/ifind/market-cases', { signal: ticket.signal })
        sessionLifecycle.commit(ticket, () => {
          if (generation !== refreshGeneration) return
          render(payload.data)
          if (outcome) {
            const presentation = marketOutcomePresentation(outcome.data && outcome.data.status)
            setLive(presentation.message, presentation.tone)
          }
        })
      } catch (error) {
        if (!isStale(error)) {
          if (error.code === 'ADMIN_AUTH_REQUIRED') await onError(error)
          else sessionLifecycle.commit(ticket, () => {
            setLive(ifindMarketDiagnosticErrorMessage(error.code), 'error')
          })
        }
      } finally {
        try {
          sessionLifecycle.commit(ticket, () => {
            runningCaseId = null
            render()
          })
        } catch (error) {
          if (!isStale(error)) finalizationError = error
        } finally {
          sessionLifecycle.finishRequest(ticket)
        }
      }
      if (finalizationError) throw finalizationError
    }

    function bind() {
      if (bound) return
      bound = true
      for (const config of IFIND_MARKET_CASES) {
        byId(`ifind-market-${config.key}-run`).addEventListener('click', () => run(config.caseId))
      }
    }

    function reset() {
      refreshGeneration += 1
      clearCooldownTimer()
      status = null
      runningCaseId = null
      render()
    }

    if (typeof sessionLifecycle.onInvalidate === 'function') {
      sessionLifecycle.onInvalidate(clearCooldownTimer)
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
    const invalidationListeners = new Set()

    function invalidate() {
      active = false
      currentEpoch += 1
      for (const controller of controllers) controller.abort()
      controllers.clear()
      for (const listener of invalidationListeners) {
        try {
          listener()
        } catch {
          // Session invalidation remains fail-closed if a UI listener fails.
        }
      }
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

    function onInvalidate(listener) {
      if (typeof listener !== 'function') throw new TypeError('ADMIN_INVALIDATION_LISTENER_INVALID')
      invalidationListeners.add(listener)
      return () => invalidationListeners.delete(listener)
    }

    return Object.freeze({
      activate,
      beginRequest,
      commit,
      finishRequest,
      invalidate,
      onInvalidate,
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
    createIfindMarketDiagnosticController,
    createIfindMarketDiagnosticView,
    ifindDiagnosticApiFailure,
    ifindDiagnosticErrorMessage,
    ifindDiagnosticSafeErrorClasses,
    ifindMarketDiagnosticApiFailure,
    ifindMarketDiagnosticErrorMessage,
    logoutFailureDecision,
    mutationFailureDecision
  })
})
