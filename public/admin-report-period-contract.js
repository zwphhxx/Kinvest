/* global module */
(function exposeReportPeriod(root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) (/** @type {any} */ (root)).KinvestReportPeriod = api
})(typeof window !== 'undefined' ? window : null, function reportPeriodContract() {
  const PREFIX = 'IFIND_REPORT_PERIOD_DIAGNOSTIC_'
  const GET = '/api/admin/ifind/report-period-diagnostic'
  const VERIFICATION = ['issuerIdentityStatus', 'vendorCodeStatus', 'entitlementStatus',
    'currencyStatus', 'unitStatus', 'reportPeriodStatus', 'scopeStatus']
  const RESULT_KEYS = ['diagnosticId', 'caseId', 'displayCode', 'requestedSelector',
    'indicators', 'status', 'verification', 'observation', 'requestCount',
    'businessRequestCount', 'dataVol', 'attemptedAt', 'errorCode', 'failureEvidence']
  const FIXED = [
    { indicator: 'revenue_oas', parameters: ['20260331', '1', 'BB'] },
    { indicator: 'report_sd', parameters: ['20260331', '1'] },
    { indicator: 'report_ed', parameters: ['20260331', '1'] }
  ]
  const IDLE = new Set(['ready', 'busy', 'cooldown', 'daily-limit'])
  // Narrow mirror of server/contracts/ifind-diagnostic-errors.js: only these two stages.
  const FAILURE_RULES = {
    IFIND_AUTH_REJECTED: failureRule('AUTH', ['auth', 'financial'], true),
    IFIND_CLIENT_CLEARED: failureRule('CONFIG', ['auth', 'financial']),
    IFIND_CLIENT_FAILED: failureRule('API', ['auth', 'financial']),
    IFIND_CONFIG_INVALID: failureRule('CONFIG', ['auth', 'financial']),
    IFIND_CONNECTION_TIMEOUT: failureRule('NETWORK', ['auth', 'financial']),
    IFIND_DUPLICATE_RESPONSE: failureRule('NETWORK', ['auth', 'financial']),
    IFIND_FINANCIAL_REJECTED: failureRule('API', ['financial'], true),
    IFIND_HTTP_STATUS: failureRule('API', ['auth', 'financial']),
    IFIND_NETWORK_FAILED: failureRule('NETWORK', ['auth', 'financial']),
    IFIND_PERMISSION_REJECTED: failureRule('PERMISSION', ['financial'], true),
    IFIND_QUOTA_REJECTED: failureRule('QUOTA', ['financial'], true),
    IFIND_RESPONSE_ABORTED: failureRule('NETWORK', ['auth', 'financial']),
    IFIND_RESPONSE_ENCODING: failureRule('API', ['auth', 'financial']),
    IFIND_RESPONSE_FAILED: failureRule('NETWORK', ['auth', 'financial']),
    IFIND_RESPONSE_INVALID: failureRule('NETWORK', ['auth', 'financial']),
    IFIND_RESPONSE_JSON: failureRule('API', ['auth', 'financial']),
    IFIND_RESPONSE_SHAPE: failureRule('API', ['auth', 'financial']),
    IFIND_RESPONSE_TOO_LARGE: failureRule('API', ['auth', 'financial']),
    IFIND_TIMEOUT: failureRule('NETWORK', ['auth', 'financial'])
  }
  const CLASS_LABELS = { AUTH: '认证', CONFIG: '配置', API: '接口', NETWORK: '网络', PERMISSION: '权限', QUOTA: '额度' }
  const VALUE_SHAPES = {
    unavailable: '无法观察', missing: '缺失', invalid: '结构无效', 'empty-array': '空数组',
    'multiple-values': '多个值', null: '空值', number: '数值', 'decimal-string': '十进制数字文本',
    'iso-date': 'ISO 日期文本', 'compact-date': '紧凑日期文本', datetime: '日期时间文本',
    'other-string': '其他文本', object: '对象', array: '数组', boolean: '布尔值', unsupported: '不支持的类型'
  }
  const SHAPE_KEYS = ['tablesShape', 'rowShape', 'identityShape', 'columnShape',
    'revenueShape', 'reportStartShape', 'reportEndShape']
  const SHAPE_LABELS = {
    tablesShape: { missing: '缺失', invalid: '结构无效', empty: '空表集合', single: '单表', multiple: '多表' },
    rowShape: { unavailable: '无法观察', invalid: '结构无效', exact: '固定字段', 'extra-fields': '含额外字段' },
    identityShape: { unavailable: '无法观察', missing: '缺失', match: '匹配', mismatch: '不匹配', invalid: '结构无效' },
    columnShape: { unavailable: '无法观察', invalid: '结构无效', 'known-only': '仅已知字段', 'extra-fields': '含额外字段' },
    revenueShape: VALUE_SHAPES, reportStartShape: VALUE_SHAPES, reportEndShape: VALUE_SHAPES
  }
  const SHAPE_TITLES = ['表', '行', '标识', '列', '收入', '起始日期', '截止日期']
  const MESSAGES = {
    ADMIN_AUTH_REQUIRED: '管理员会话已结束，请重新登录。',
    ADMIN_CSRF_INVALID: '操作凭证已失效，请重新登录；本次操作不会自动重试。',
    ORIGIN_INVALID: '当前页面来源无法执行此操作。',
    TRUSTED_CLIENT_REQUIRED: '请求来源未通过验证。',
    CLIENT_IDENTITY_INVALID: '请求来源未通过验证。',
    [`${PREFIX}UNAVAILABLE`]: '报告期间诊断不可用，请检查本地状态后手工重试。',
    [`${PREFIX}FAILED`]: '本次诊断未完成，不会自动重试。',
    [`${PREFIX}RESULT_INVALID`]: '诊断结果未通过校验，已清除观察值，不会自动重试。',
    UNKNOWN: '诊断未完成或不可用，不会自动重试。'
  }
  const CONFIRM = '确认仅为管理员执行 9988.HK 报告期间诊断？\n' +
    '固定 revenue_oas(20260331,1,BB)、report_sd(20260331,1)、report_ed(20260331,1)。\n' +
    '至多 1 次认证 + 1 次业务请求（3 个指标），0 次重试，可能消耗额度。\n' +
    '日期仅作旁证，不证明收入报告期；家庭页面保持 Mock。'

  function invalid() {
    throw Object.assign(new Error('Invalid report-period diagnostic result'), { code: `${PREFIX}RESULT_INVALID` })
  }

  function failureRule(errorClass, stages, allowsVendorErrorCode = false) {
    return { errorClass, stages, allowsVendorErrorCode }
  }

  function record(value, keys) {
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
  }

  function array(value, length) {
    if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) invalid()
    const indices = Array.from({ length }, (_, index) => String(index))
    const keys = [...indices, 'length']
    if (Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))) invalid()
    const size = Reflect.getOwnPropertyDescriptor(value, 'length')
    if (!size || !Object.hasOwn(size, 'value') || size.value !== length) invalid()
    return indices.map((key) => {
      const item = Reflect.getOwnPropertyDescriptor(value, key)
      if (!item || !item.enumerable || !Object.hasOwn(item, 'value')) invalid()
      return item.value
    })
  }

  function date(value) {
    if (typeof value !== 'string' || value.length !== 10 || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false
    const time = Date.parse(`${value}T00:00:00.000Z`)
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  }

  function timestamp(value) {
    if (typeof value !== 'string' || value.length !== 24 || !/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)) return false
    const time = Date.parse(value)
    return Number.isFinite(time) && new Date(time).toISOString() === value
  }

  function copyResponseShape(value) {
    if (value === null) return null
    const shape = record(value, SHAPE_KEYS)
    for (const key of SHAPE_KEYS) {
      if (typeof shape[key] !== 'string' || !Object.hasOwn(SHAPE_LABELS[key], shape[key])) invalid()
    }
    if (shape.tablesShape !== 'single' && SHAPE_KEYS.slice(1).some((key) => shape[key] !== 'unavailable')) invalid()
    if (shape.rowShape === 'invalid' && SHAPE_KEYS.slice(2).some((key) => shape[key] !== 'unavailable')) invalid()
    if (['unavailable', 'invalid'].includes(shape.columnShape) &&
        SHAPE_KEYS.slice(4).some((key) => shape[key] !== 'unavailable')) invalid()
    return Object.fromEntries(SHAPE_KEYS.map((key) => [key, shape[key]]))
  }

  function copyFailureEvidence(dto) {
    if (dto.failureEvidence === null) return null
    const evidence = record(dto.failureEvidence, ['stage', 'failureCode', 'errorClass', 'vendorErrorCode', 'responseShape'])
    if (dto.status !== 'failed' || !['auth', 'financial'].includes(evidence.stage)) invalid()
    if (dto.requestCount !== (evidence.stage === 'auth' ? 1 : 2) ||
        dto.businessRequestCount !== (evidence.stage === 'auth' ? 0 : 1)) invalid()
    if (typeof evidence.failureCode !== 'string' || !Object.hasOwn(FAILURE_RULES, evidence.failureCode)) invalid()
    const rule = FAILURE_RULES[evidence.failureCode]
    if (evidence.errorClass !== rule.errorClass || !rule.stages.includes(evidence.stage)) invalid()
    if (evidence.vendorErrorCode !== null && (!rule.allowsVendorErrorCode ||
        !Number.isSafeInteger(evidence.vendorErrorCode) || evidence.vendorErrorCode === 0)) invalid()
    const responseShape = copyResponseShape(evidence.responseShape)
    if (evidence.stage === 'auth' && responseShape !== null) invalid()
    return { stage: evidence.stage, failureCode: evidence.failureCode, errorClass: evidence.errorClass,
      vendorErrorCode: evidence.vendorErrorCode, responseShape }
  }

  function validate(value) {
    const dto = record(value, RESULT_KEYS)
    if (dto.diagnosticId !== 'HK_ALIBABA_REPORT_PERIOD_20260331_SINGLE_QUARTER_V1' ||
        dto.caseId !== 'HK_ALIBABA_9988' || dto.displayCode !== '9988.HK' || dto.requestedSelector !== '20260331') invalid()
    const indicators = array(dto.indicators, 3).map((item, index) => {
      const entry = record(item, ['indicator', 'parameters'])
      const expected = FIXED[index]
      if (entry.indicator !== expected.indicator) invalid()
      const parameters = array(entry.parameters, expected.parameters.length)
      if (parameters.some((value, index) => value !== expected.parameters[index])) invalid()
      return { indicator: expected.indicator, parameters: [...expected.parameters] }
    })
    const verification = record(dto.verification, VERIFICATION)
    for (const key of VERIFICATION) if (verification[key] !== 'unverified') invalid()
    if (!Number.isSafeInteger(dto.requestCount) || dto.requestCount < 0 || dto.requestCount > 2 ||
        dto.businessRequestCount !== (dto.requestCount === 2 ? 1 : 0)) invalid()
    if (dto.dataVol !== null && (!Number.isSafeInteger(dto.dataVol) || dto.dataVol < 0 || dto.businessRequestCount !== 1)) invalid()
    if (dto.attemptedAt !== null && !timestamp(dto.attemptedAt)) invalid()
    if (dto.requestCount > 0 && dto.attemptedAt === null) invalid()
    let observation = null
    if (dto.observation !== null) {
      const seen = record(dto.observation, ['returnedCode', 'revenue', 'dateEvidence'])
      const revenue = record(seen.revenue, ['value', 'availability'])
      const dates = record(seen.dateEvidence, ['requestedDataType', 'start', 'end', 'availability', 'revenuePeriodLink'])
      if (seen.returnedCode !== '9988.HK' || dates.requestedDataType !== 'single-quarter' || dates.revenuePeriodLink !== 'unverified') invalid()
      if (revenue.value === null) {
        if (revenue.availability !== 'missing') invalid()
      } else if (typeof revenue.value !== 'number' || !Number.isFinite(revenue.value) || revenue.availability !== 'present') invalid()
      if ((dates.start !== null && !date(dates.start)) || (dates.end !== null && !date(dates.end)) ||
          (dates.start !== null && dates.end !== null && dates.start > dates.end)) invalid()
      const availability = dates.start !== null && dates.end !== null ? 'present'
        : (dates.start !== null || dates.end !== null ? 'partial' : 'missing')
      if (dates.availability !== availability) invalid()
      observation = {
        returnedCode: '9988.HK', revenue: { value: revenue.value, availability: revenue.availability },
        dateEvidence: { requestedDataType: 'single-quarter', start: dates.start, end: dates.end,
          availability, revenuePeriodLink: 'unverified' }
      }
    }
    if (IDLE.has(dto.status)) {
      if (observation !== null || dto.requestCount !== 0 || dto.dataVol !== null || dto.attemptedAt !== null || dto.errorCode !== null) invalid()
    } else if (dto.status === 'observed-unverified') {
      if (observation === null || dto.requestCount !== 2 || dto.errorCode !== `${PREFIX}OBSERVED_UNVERIFIED`) invalid()
    } else if (dto.status === 'failed' || dto.status === 'unavailable') {
      if (observation !== null || dto.errorCode !== `${PREFIX}${dto.status === 'failed' ? 'FAILED' : 'UNAVAILABLE'}`) invalid()
    } else invalid()
    const failureEvidence = copyFailureEvidence(dto)
    return {
      diagnosticId: 'HK_ALIBABA_REPORT_PERIOD_20260331_SINGLE_QUARTER_V1',
      caseId: 'HK_ALIBABA_9988', displayCode: '9988.HK', requestedSelector: '20260331', indicators,
      status: dto.status, verification: Object.fromEntries(VERIFICATION.map((key) => [key, 'unverified'])),
      observation, requestCount: dto.requestCount, businessRequestCount: dto.businessRequestCount,
      dataVol: dto.dataVol, attemptedAt: dto.attemptedAt, errorCode: dto.errorCode, failureEvidence
    }
  }

  function copyResult(value) {
    try { return validate(value) } catch { invalid() }
  }

  function knownCode(value) {
    return typeof value === 'string' && Object.hasOwn(MESSAGES, value) ? value : 'UNKNOWN'
  }

  function errorMessage(code) { return MESSAGES[knownCode(code)] }

  function apiFailure(status, payload) {
    let code = status === 401 ? 'ADMIN_AUTH_REQUIRED' : 'UNKNOWN'
    if (status !== 401) {
      try { code = knownCode(record(payload, ['error']).error) } catch { /* Never expose raw transport details. */ }
    }
    return { code, retryable: false, message: errorMessage(code) }
  }

  function codeOf(error) {
    try {
      const descriptor = Reflect.getOwnPropertyDescriptor(error, 'code')
      return descriptor && Object.hasOwn(descriptor, 'value') ? knownCode(descriptor.value) : 'UNKNOWN'
    } catch { return 'UNKNOWN' }
  }

  /** @param {any} options */
  function createController(options) {
    const { document, sessionLifecycle, request, dateText, confirm, setLive, onError } = options
    const byId = (suffix) => document.getElementById(`ifind-report-period-${suffix}`)
    const put = (suffix, value) => { const node = byId(suffix); if (node) node.textContent = value }
    let revision = 0
    let activeRun = null
    let enabled = false
    let bound = false

    function buttonState() {
      const button = byId('run')
      if (!button) return
      button.disabled = activeRun !== null || !enabled
      button.setAttribute('aria-busy', String(activeRun !== null))
      button.textContent = activeRun !== null ? '诊断执行中' : (enabled ? '运行报告期间诊断' : '诊断状态不可用')
    }

    function render(dto) {
      const labels = { ready: '尚未执行', busy: '已有诊断执行中', cooldown: '冷却中',
        'daily-limit': '本地当日次数已用完', 'observed-unverified': '已取得观察值 / 未验证',
        failed: '本次诊断未完成', unavailable: '诊断不可用' }
      enabled = dto !== null && ['ready', 'observed-unverified', 'failed'].includes(dto.status)
      const seen = dto && dto.observation
      put('status', dto === null ? '尚未读取状态' : labels[dto.status])
      put('value', !seen || seen.revenue.value === null ? '—' : String(seen.revenue.value))
      put('start', !seen || seen.dateEvidence.start === null ? '未提供' : seen.dateEvidence.start)
      put('end', !seen || seen.dateEvidence.end === null ? '未提供' : seen.dateEvidence.end)
      put('availability', !seen ? '尚无观察值' :
        `收入${seen.revenue.availability === 'present' ? '有值' : '缺失'}；日期${({ present: '齐全', partial: '部分缺失', missing: '缺失' })[seen.dateEvidence.availability]}`)
      put('link', '未验证：日期指标仅作旁证，不能认定为收入报告期。')
      put('verification', '发行人、代码、权限、币种、单位、报告期与披露口径：均未验证。')
      put('attempted-at', dto && dto.attemptedAt !== null ? dateText(Date.parse(dto.attemptedAt)) : '尚未执行')
      put('request-count', dto ? `${dto.requestCount} 次` : '—')
      put('business-request-count', dto ? `${dto.businessRequestCount} 次` : '—')
      put('data-vol', dto && dto.dataVol !== null ? String(dto.dataVol) : '未提供')
      put('error', dto && (dto.status === 'failed' || dto.status === 'unavailable') ? errorMessage(dto.errorCode) : '')
      const failure = dto && dto.failureEvidence
      put('failure', failure ?
        `失败代码：${failure.failureCode}；类别：${CLASS_LABELS[failure.errorClass]}（${failure.errorClass}）；阶段：${failure.stage === 'auth' ? '认证' : '业务'}。` +
        (failure.vendorErrorCode === null ? '' : `供应商错误码：${failure.vendorErrorCode}。`) : '')
      const shape = failure && failure.responseShape
      put('response-shape', failure ? '返回结构摘要：' + (shape ?
        SHAPE_KEYS.map((key, index) => `${SHAPE_TITLES[index]}：${SHAPE_LABELS[key][shape[key]]}`).join('；') : '未提供') +
        '。仅反映类型与结构，不代表失败原因，也不能证实收入报告期。' : '')
      buttonState()
    }

    function reset() {
      revision += 1
      activeRun = null
      render(null)
    }

    async function showError(error) {
      const code = codeOf(error)
      render(null)
      put('error', errorMessage(code))
      if (code === 'ADMIN_AUTH_REQUIRED' || code === 'ADMIN_CSRF_INVALID') await onError({ code })
      else setLive(errorMessage(code), 'error')
    }

    function copyEnvelope(payload) {
      try { return copyResult(record(payload, ['data']).data) } catch { invalid() }
    }

    async function refresh() {
      if (activeRun !== null) return
      let ticket
      try { ticket = sessionLifecycle.beginRequest() } catch { reset(); return }
      const ownRevision = ++revision
      try {
        const payload = await request(GET, { signal: ticket.signal })
        if (ownRevision !== revision || ticket.signal?.aborted) return
        const dto = copyEnvelope(payload)
        await sessionLifecycle.commit(ticket, () => {
          if (ownRevision === revision && activeRun === null) render(dto)
        })
      } catch (error) {
        if (ownRevision !== revision || ticket.signal?.aborted) return
        await sessionLifecycle.commit(ticket, async () => {
          if (ownRevision === revision) await showError(error)
        })
      } finally { sessionLifecycle.finishRequest(ticket) }
    }

    async function run() {
      if (!enabled || activeRun !== null || confirm(CONFIRM) !== true) return
      let ticket
      try { ticket = sessionLifecycle.beginRequest() } catch { reset(); return }
      const ownRevision = ++revision
      const owner = {}
      activeRun = owner
      buttonState()
      try {
        const payload = await request(`${GET}/run`, { method: 'POST', body: {}, csrf: true, signal: ticket.signal })
        if (ownRevision !== revision || ticket.signal?.aborted) return
        const dto = copyEnvelope(payload)
        await sessionLifecycle.commit(ticket, () => {
          if (ownRevision !== revision) return
          render(dto)
          setLive(dto.status === 'observed-unverified' ? '已取得诊断旁证，收入报告期仍未验证。' : '诊断状态已更新；未自动重试。', '')
        })
      } catch (error) {
        if (ownRevision !== revision || ticket.signal?.aborted) return
        await sessionLifecycle.commit(ticket, async () => {
          if (ownRevision === revision) await showError(error)
        })
      } finally {
        sessionLifecycle.finishRequest(ticket)
        if (activeRun === owner) {
          activeRun = null
          if (ownRevision === revision) buttonState()
        }
      }
    }

    function bind() {
      if (bound) return
      bound = true
      const button = byId('run')
      if (button) button.addEventListener('click', run)
    }

    sessionLifecycle.onInvalidate(reset)
    reset()
    return Object.freeze({ bind, refresh, reset, run })
  }

  return Object.freeze({ copyResult, apiFailure, errorMessage, createController })
})
