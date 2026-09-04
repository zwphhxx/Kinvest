/* global module */
(function exposeAdminMarketProbe(root, factory) {
  const api = Object.freeze(factory())
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) (/** @type {any} */ (root)).KinvestAdminMarketProbe = api
})(typeof window !== 'undefined' ? window : null, function adminMarketProbeContract() {
  const PROPOSAL_ID = 'HK_ALIBABA_9988_V1'
  const CASE_ID = 'HK_ALIBABA_9988'
  const DISPLAY_CODE = '9988.HK'
  const STATUS_PATH = `/api/admin/ifind/market-probes/${PROPOSAL_ID}`
  const RUN_PATH = `${STATUS_PATH}/run`
  const INVALID = 'IFIND_MARKET_PROBE_RESULT_INVALID'
  const RESULT_KEYS = ['proposalId', 'caseId', 'displayCode', 'status', 'verification',
    'observations', 'requestCount', 'businessRequestCount', 'dataVol', 'attemptedAt',
    'errorCode', 'failureStage']
  const VERIFICATION_KEYS = ['issuerIdentityStatus', 'vendorCodeStatus', 'entitlementStatus',
    'currencyStatus', 'unitStatus', 'reportPeriodStatus', 'scopeStatus']
  const STAGES = ['identity', 'quote', 'financial']
  const FAILURE_STAGES = new Set(['provider', 'auth', 'identity', 'quote', 'financial', 'lease'])
  const IDLE = new Set(['ready', 'busy', 'cooldown', 'daily-limit'])
  const FIELD_KEYS = {
    identity: ['ths_stock_short_name_stock'],
    quote: ['latest', 'preClose', 'open', 'high', 'low', 'amount', 'volume', 'tradeDate', 'tradeTime'],
    financial: ['revenue_oas']
  }
  const STATUS_LABELS = {
    ready: '可以手工运行', busy: '正在运行', cooldown: '冷却中',
    'daily-limit': '今日额度已达上限', 'observed-unverified': '已观察，均未验证',
    failed: '执行失败', unavailable: '暂不可用'
  }
  const ERROR_MESSAGES = {
    ADMIN_AUTH_REQUIRED: '管理员会话已结束，请重新登录。',
    ADMIN_CSRF_INVALID: '操作凭证已失效，请重新登录；本次操作不会自动重试。',
    ORIGIN_INVALID: '当前页面来源无法执行此操作。',
    TRUSTED_CLIENT_REQUIRED: '请求来源未通过验证。',
    CLIENT_IDENTITY_INVALID: '请求来源未通过验证。',
    IFIND_MARKET_PROBE_FAILED: '固定港股探针未完成，不会自动重试。',
    IFIND_MARKET_PROBE_UNAVAILABLE: '固定港股探针暂时不可用，不会自动重试。',
    IFIND_MARKET_PROBE_RESULT_INVALID: '固定港股探针结果未通过安全校验，已清除显示。'
  }
  const PUBLIC_FAILURES = new Set(Object.keys(ERROR_MESSAGES))
  const CONFIRMATION = '确认仅为管理员运行阿里巴巴 9988.HK 固定探针？\n' +
    '本次最多 1 次认证 + 3 次业务请求，0 次重试，可能消耗额度。\n' +
    '所有结果仍为未验证，不进入家庭页面。'

  function invalid() {
    throw Object.assign(new Error('Invalid fixed market probe result'), { code: INVALID })
  }

  function record(value, keys) {
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
      const prototype = Reflect.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) invalid()
      const actual = Reflect.ownKeys(value)
      if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) invalid()
      const result = Object.create(null)
      for (const key of keys) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
        result[key] = descriptor.value
      }
      return result
    } catch {
      invalid()
    }
  }

  function utf8Length(value) {
    try {
      return encodeURIComponent(value).replace(/%[0-9A-F]{2}/gi, 'x').length
    } catch {
      invalid()
    }
  }

  function primitiveArray(value) {
    try {
      if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) invalid()
      const length = Reflect.getOwnPropertyDescriptor(value, 'length')
      if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) ||
          length.value < 0 || length.value > 64 || Reflect.ownKeys(value).length !== length.value + 1) invalid()
      const result = []
      for (let index = 0; index < length.value; index += 1) {
        const item = Reflect.getOwnPropertyDescriptor(value, String(index))
        if (!item || !item.enumerable || !Object.hasOwn(item, 'value')) invalid()
        const entry = item.value
        if (entry === null || typeof entry === 'boolean') result.push(entry)
        else if (typeof entry === 'number' && Number.isFinite(entry)) result.push(entry)
        else if (typeof entry === 'string' && utf8Length(entry) <= 256 && !/[\p{Cc}\p{Cf}]/u.test(entry)) result.push(entry)
        else invalid()
      }
      return result
    } catch {
      invalid()
    }
  }

  function timestamp(value) {
    if (typeof value !== 'string' || value.length !== 24 ||
        !/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)) return false
    const time = Date.parse(value)
    return Number.isFinite(time) && new Date(time).toISOString() === value
  }

  function copySummary(value, stage) {
    const summary = record(value, ['returnedCode', 'fields'])
    if (summary.returnedCode !== DISPLAY_CODE) invalid()
    const fields = record(summary.fields, FIELD_KEYS[stage])
    return {
      returnedCode: DISPLAY_CODE,
      fields: Object.fromEntries(FIELD_KEYS[stage].map((key) => [key, primitiveArray(fields[key])]))
    }
  }

  function copyResult(value) {
    try {
      const input = record(value, RESULT_KEYS)
      if (input.proposalId !== PROPOSAL_ID || input.caseId !== CASE_ID || input.displayCode !== DISPLAY_CODE) invalid()
      const verification = record(input.verification, VERIFICATION_KEYS)
      for (const key of VERIFICATION_KEYS) if (verification[key] !== 'unverified') invalid()
      const sourceObservations = record(input.observations, STAGES)
      const observations = Object.fromEntries(STAGES.map((stage) => [stage,
        sourceObservations[stage] === null ? null : copySummary(sourceObservations[stage], stage)]))
      if (!Number.isSafeInteger(input.requestCount) || input.requestCount < 0 || input.requestCount > 4 ||
          !Number.isSafeInteger(input.businessRequestCount) ||
          input.businessRequestCount !== Math.max(0, input.requestCount - 1) ||
          (input.dataVol !== null && (!Number.isSafeInteger(input.dataVol) || input.dataVol < 0)) ||
          (input.businessRequestCount === 0 && input.dataVol !== null) ||
          (input.attemptedAt !== null && !timestamp(input.attemptedAt))) invalid()
      if (IDLE.has(input.status)) {
        if (STAGES.some((stage) => observations[stage] !== null) || input.requestCount !== 0 ||
            input.dataVol !== null || input.attemptedAt !== null || input.errorCode !== null ||
            input.failureStage !== null) invalid()
      } else if (input.status === 'observed-unverified') {
        if (STAGES.some((stage) => observations[stage] === null) || input.requestCount !== 4 ||
            input.businessRequestCount !== 3 || input.attemptedAt === null ||
            input.errorCode !== 'IFIND_MARKET_PROBE_OBSERVED_UNVERIFIED' || input.failureStage !== null) invalid()
      } else if (input.status === 'failed' || input.status === 'unavailable') {
        const expected = input.status === 'failed' ? 'IFIND_MARKET_PROBE_FAILED' : 'IFIND_MARKET_PROBE_UNAVAILABLE'
        if (input.errorCode !== expected || !FAILURE_STAGES.has(input.failureStage) ||
            (input.requestCount > 0 && input.attemptedAt === null)) invalid()
        let missing = false
        for (let index = 0; index < STAGES.length; index += 1) {
          const present = observations[STAGES[index]] !== null
          if (present && (missing || input.businessRequestCount < index + 1)) invalid()
          if (!present) missing = true
        }
      } else invalid()
      return {
        proposalId: PROPOSAL_ID, caseId: CASE_ID, displayCode: DISPLAY_CODE,
        status: input.status,
        verification: Object.fromEntries(VERIFICATION_KEYS.map((key) => [key, 'unverified'])),
        observations, requestCount: input.requestCount,
        businessRequestCount: input.businessRequestCount, dataVol: input.dataVol,
        attemptedAt: input.attemptedAt, errorCode: input.errorCode, failureStage: input.failureStage
      }
    } catch {
      invalid()
    }
  }

  function apiFailure(status, payload) {
    try {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { code: 'UNKNOWN' }
      const descriptor = Reflect.getOwnPropertyDescriptor(payload, 'error')
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') return { code: 'UNKNOWN' }
      const code = descriptor.value
      if (!PUBLIC_FAILURES.has(code)) return { code: status === 401 ? 'ADMIN_AUTH_REQUIRED' : 'UNKNOWN' }
      return { code }
    } catch {
      return { code: 'UNKNOWN' }
    }
  }

  function errorMessage(code) {
    return ERROR_MESSAGES[code] || '固定港股探针暂时不可用，不会自动重试。'
  }

  function createController(options) {
    const { document, sessionLifecycle, request, dateText, confirm, setLive, onError } = options
    const byId = (id) => document.getElementById(id)
    let generation = 0
    let running = false
    let bound = false
    let currentStatus = null

    function put(id, value) { byId(id).textContent = value }

    function observationText(observation) {
      if (observation === null) return '—'
      return Object.entries(observation.fields).map(([key, values]) =>
        `${key}: ${values.length ? values.map((value) => value === null ? '空值' : String(value)).join(' · ') : '空数组'}`
      ).join('；')
    }

    function quotaText(status) {
      if (status === 'ready') return 'ready · 可手工运行'
      if (status === 'cooldown') return 'cooldown · 冷却中'
      if (status === 'daily-limit') return 'limit · 今日上限'
      if (status === 'busy') return 'cooldown · 已有任务运行'
      return 'ready/cooldown/limit · 以最新状态为准'
    }

    function buttonState() {
      const button = byId('ifind-market-probe-run')
      const available = currentStatus === 'ready' && !running
      button.disabled = !available
      button.setAttribute('aria-busy', String(running))
      button.textContent = running ? '正在运行固定探针'
        : available ? '运行固定探针'
          : currentStatus === 'cooldown' ? '探针冷却中'
            : currentStatus === 'daily-limit' ? '今日额度已达上限'
              : currentStatus === 'busy' ? '已有探针运行中' : '探针暂不可运行'
    }

    function render(value) {
      currentStatus = value.status
      put('ifind-market-probe-status', STATUS_LABELS[value.status])
      put('ifind-market-probe-proposal', value.proposalId)
      put('ifind-market-probe-code', value.displayCode)
      put('ifind-market-probe-attempted-at', value.attemptedAt === null
        ? '尚未执行' : dateText(Date.parse(value.attemptedAt)))
      put('ifind-market-probe-request-count', `${value.requestCount} 次`)
      put('ifind-market-probe-business-request-count', `${value.businessRequestCount} 次`)
      put('ifind-market-probe-data-vol', value.dataVol === null ? '未提供' : String(value.dataVol))
      put('ifind-market-probe-quota', quotaText(value.status))
      put('ifind-market-probe-identity', observationText(value.observations.identity))
      put('ifind-market-probe-quote', observationText(value.observations.quote))
      put('ifind-market-probe-financial', observationText(value.observations.financial))
      put('ifind-market-probe-error', value.errorCode === null ? '无'
        : value.errorCode === 'IFIND_MARKET_PROBE_OBSERVED_UNVERIFIED'
          ? '已取得观察值，但七项证据仍未验证。' : errorMessage(value.errorCode))
      for (const [key, suffix] of [
        ['issuerIdentityStatus', 'issuer-identity'], ['vendorCodeStatus', 'vendor-code'],
        ['entitlementStatus', 'entitlement'], ['currencyStatus', 'currency'],
        ['unitStatus', 'unit'], ['reportPeriodStatus', 'report-period'], ['scopeStatus', 'scope']
      ]) {
        const node = byId(`ifind-market-probe-${suffix}`)
        node.textContent = value.verification[key] === 'unverified' ? '未验证' : '未验证'
        node.dataset.evidenceStatus = 'unverified'
      }
      buttonState()
    }

    function reset() {
      generation += 1
      running = false
      currentStatus = null
      put('ifind-market-probe-status', '尚未读取状态')
      put('ifind-market-probe-proposal', PROPOSAL_ID)
      put('ifind-market-probe-code', DISPLAY_CODE)
      put('ifind-market-probe-attempted-at', '尚未执行')
      put('ifind-market-probe-request-count', '0 次')
      put('ifind-market-probe-business-request-count', '0 次')
      put('ifind-market-probe-data-vol', '未提供')
      put('ifind-market-probe-quota', 'ready/cooldown/limit · 尚未读取')
      put('ifind-market-probe-identity', '—')
      put('ifind-market-probe-quote', '—')
      put('ifind-market-probe-financial', '—')
      put('ifind-market-probe-error', '无')
      for (const suffix of ['issuer-identity', 'vendor-code', 'entitlement', 'currency', 'unit', 'report-period', 'scope']) {
        const node = byId(`ifind-market-probe-${suffix}`)
        node.textContent = '未验证'
        node.dataset.evidenceStatus = 'unverified'
      }
      buttonState()
    }

    async function guardedRequest(path, requestOptions) {
      const localGeneration = generation
      const ticket = sessionLifecycle.beginRequest()
      try {
        const response = await request(path, { ...requestOptions, signal: ticket.signal })
        const data = copyResult(record(response, ['data']).data)
        return sessionLifecycle.commit(ticket, () => {
          if (localGeneration !== generation) throw new Error('ADMIN_EPOCH_STALE')
          render(data)
          return data
        })
      } catch (error) {
        if (error && (error.name === 'AbortError' || error.message === 'ADMIN_EPOCH_STALE')) return undefined
        reset()
        await onError(error && typeof error.code === 'string' ? error : Object.assign(new Error(INVALID), { code: INVALID }))
        return undefined
      } finally {
        sessionLifecycle.finishRequest(ticket)
      }
    }

    async function refresh() {
      return guardedRequest(STATUS_PATH, {})
    }

    async function run() {
      if (running || currentStatus !== 'ready' || !confirm(CONFIRMATION)) return undefined
      running = true
      buttonState()
      try {
        const result = await guardedRequest(RUN_PATH, { method: 'POST', body: {}, csrf: true })
        if (result) {
          setLive('固定港股探针已完成；所有观察仍为未验证。', 'success')
          return refresh()
        }
        return undefined
      } finally {
        running = false
        buttonState()
      }
    }

    function bind() {
      if (bound) return
      bound = true
      byId('ifind-market-probe-run').addEventListener('click', run)
      reset()
    }

    return Object.freeze({ bind, refresh, reset })
  }

  return { createController, apiFailure, errorMessage }
})
