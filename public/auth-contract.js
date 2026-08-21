/* global module */

(function exposeAuthContract(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) (/** @type {any} */ (root)).KinvestAuth = api
})(typeof window === 'undefined' ? null : window, function createAuthContract() {
  const requestStates = new Set(['pending', 'approved', 'expired', 'locked', 'consumed'])
  const terminalStates = new Set(['expired', 'locked', 'consumed'])
  const errorMessages = Object.freeze({
    ADMIN_AUTH_INVALID: '密码不正确，请重新输入。',
    ADMIN_AUTH_RATE_LIMITED: '尝试次数较多，请稍后再试。',
    ADMIN_AUTH_REQUIRED: '管理员会话已结束，请重新登录。',
    ADMIN_CSRF_INVALID: '操作凭证已更新，请刷新后重试。',
    DEVICE_NAME_INVALID: '请输入 1 至 40 个字符的设备名称。',
    REQUEST_ACTIVE_LIMIT: '当前已有 3 个等待中的申请，请先完成或等待其过期。',
    REQUEST_RATE_LIMITED: '申请有点频繁，请稍后再试。',
    REQUEST_AUTH_REQUIRED: '这份申请不属于当前浏览器，请重新申请。',
    REQUEST_NOT_FOUND: '没有找到这份申请，请重新申请。',
    REQUEST_NOT_APPROVED: '申请仍在等待管理员批准。',
    REQUEST_ALREADY_USED: '这份申请已经兑换，请刷新页面检查登录状态。',
    REQUEST_EXPIRED: '申请已过期，请重新申请。',
    REQUEST_LOCKED: '申请码尝试次数过多，这份申请已锁定。',
    REQUEST_CODE_INVALID: '申请码不正确，请核对后再试。',
    AUTH_REQUIRED: '这台设备尚未获得家庭访问许可。',
    ORIGIN_INVALID: '当前页面来源无法执行此操作。',
    JSON_INVALID: '提交内容格式不正确。',
    BODY_TOO_LARGE: '提交内容过长。',
    SEARCH_QUERY_INVALID: '请输入有效的公司名称或证券代码。',
    SECURITY_NOT_CONFIGURED: '这家公司尚未收录。',
    SECURITY_IDENTITY_CONFLICT: '证券身份存在冲突，暂时不能展示。',
    REFRESH_COOLDOWN: '手动刷新仍在冷却，请稍后再试。',
    REFRESH_DAILY_LIMIT: '今天的手动刷新额度已经用完。',
    REFRESH_NOT_ALLOWED: '当前状态不允许手动刷新。',
    NOT_FOUND: '没有找到请求的内容。'
  })
  const stableCodes = new Set(Object.keys(errorMessages))
  const terminalPollErrors = new Set([
    'REQUEST_EXPIRED',
    'REQUEST_LOCKED',
    'REQUEST_NOT_FOUND',
    'REQUEST_AUTH_REQUIRED'
  ])

  function fail(code) {
    throw Object.assign(new Error(code), { code })
  }

  function normalizeAuthStatus(payload) {
    if (!payload || typeof payload !== 'object' || typeof payload.authorized !== 'boolean') {
      fail('AUTH_STATUS_INVALID')
    }
    return Object.freeze({ authorized: payload.authorized })
  }

  function normalizeDeviceName(value) {
    if (typeof value !== 'string') fail('DEVICE_NAME_INVALID')
    const normalized = value.normalize('NFC').trim()
    const hasControl = Array.from(normalized).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
    if (normalized.length < 1 || normalized.length > 40 || hasControl) {
      fail('DEVICE_NAME_INVALID')
    }
    return normalized
  }

  function normalizeRequestStatus(payload) {
    if (!payload || typeof payload !== 'object' || !requestStates.has(payload.status)) {
      fail('REQUEST_STATUS_INVALID')
    }
    return Object.freeze({ status: payload.status })
  }

  function pollDecision(status, hidden) {
    if (!requestStates.has(status)) fail('REQUEST_STATUS_INVALID')
    return Object.freeze({
      poll: status === 'pending' && hidden !== true,
      terminal: terminalStates.has(status)
    })
  }

  function authErrorMessage(code) {
    return errorMessages[code] || '暂时无法完成，请稍后重试。'
  }

  function classifyApiFailure(status, payload) {
    const supplied = payload && typeof payload === 'object' && typeof payload.error === 'string'
      ? payload.error
      : 'UNKNOWN'
    const code = stableCodes.has(supplied) ? supplied : 'UNKNOWN'
    return Object.freeze({
      code,
      message: authErrorMessage(code),
      retryable: status === 0 || status >= 500
    })
  }

  function pollErrorDecision(error) {
    if (terminalPollErrors.has(error && error.code)) {
      return Object.freeze({ terminal: true, confirmAuthorization: false, retry: false })
    }
    if (error && error.code === 'REQUEST_ALREADY_USED') {
      return Object.freeze({ terminal: false, confirmAuthorization: true, retry: false })
    }
    if (error && (error.status === 0 || error.status >= 500)) {
      return Object.freeze({ terminal: false, confirmAuthorization: false, retry: true })
    }
    return Object.freeze({ terminal: true, confirmAuthorization: false, retry: false })
  }

  function formatRequestCode(code) {
    return typeof code === 'string' && /^\d{6}$/.test(code)
      ? `${code.slice(0, 3)} ${code.slice(3)}`
      : ''
  }

  function formatExpiry(expiresAt, now = Date.now()) {
    if (!Number.isSafeInteger(expiresAt)) return '有效期未知'
    const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000))
    return seconds > 0 ? `约 ${Math.ceil(seconds / 60)} 分钟内有效` : '已过期'
  }

  return Object.freeze({
    authErrorMessage,
    classifyApiFailure,
    formatExpiry,
    formatRequestCode,
    normalizeAuthStatus,
    normalizeDeviceName,
    normalizeRequestStatus,
    pollDecision,
    pollErrorDecision
  })
})
