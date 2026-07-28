const MS_IN_SECOND = 1000
const MS_IN_MINUTE = 60 * MS_IN_SECOND

function toISO(value) {
  if (value instanceof Date) {
    return value.toISOString()
  }
  return value ? new Date(value).toISOString() : null
}

function clampNumber(value, fallback = 0) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback
  }
  return value
}

function calculateCooldownRemainingSeconds(lastManualRefreshAt, now, cooldownMs) {
  const last = new Date(lastManualRefreshAt || 0).getTime()
  if (!Number.isFinite(last) || last <= 0) {
    return 0
  }
  const waitUntil = last + cooldownMs
  const remaining = Math.ceil(Math.max(0, waitUntil - now.getTime()) / MS_IN_SECOND)
  return clampNumber(remaining, 0)
}

function isTradingSession(status) {
  if (!status || typeof status !== 'object') {
    return false
  }
  return !!status.isOpen
}

function buildRefreshState(snapshot, now = new Date(), options = {}) {
  const nowTime = now instanceof Date ? now : new Date(now)
  const cfg = {
    autoIntervalMinutes: 10,
    manualCooldownMs: 2 * MS_IN_MINUTE,
    ...options
  }
  const pricing = snapshot && snapshot.pricing ? snapshot.pricing : {}
  const market = snapshot && snapshot.market ? snapshot.market : {}

  const marketState = isTradingSession(market) ? 'trading' : 'closed'
  const nextAutoRefreshAt = market.nextAutoRefreshAt
    ? new Date(market.nextAutoRefreshAt)
    : null
  const nextAutoRefreshIso = nextAutoRefreshAt ? toISO(nextAutoRefreshAt) : null
  const manualCooldownRemainingSeconds = calculateCooldownRemainingSeconds(
    pricing.lastManualRefreshAt,
    nowTime,
    cfg.manualCooldownMs
  )
  const canRefreshByCooldown = manualCooldownRemainingSeconds <= 0
  const dailyManualCount = clampNumber(pricing.dailyManualCount, 0)
  const dailyManualLimit = clampNumber(pricing.dailyManualLimit, cfg.dailyManualLimit || 100)
  const manualLimitReached = dailyManualCount >= dailyManualLimit
  const canManualRefresh = canRefreshByCooldown && !manualLimitReached
  const dataFresh = Boolean(pricing.lastSuccessAt && ((nowTime - new Date(pricing.lastSuccessAt)) / MS_IN_MINUTE) < cfg.autoIntervalMinutes)

  return {
    marketState,
    isTrading: marketState === 'trading',
    marketLabel: isTradingSession(market) ? '交易中' : '已休市',
    dataSourceTime: pricing.sourceTime ? toISO(pricing.sourceTime) : null,
    fetchedAt: pricing.fetchedAt ? toISO(pricing.fetchedAt) : null,
    fromCache: pricing.fromCache !== false,
    nextAutoRefreshAt: nextAutoRefreshIso,
    autoRefreshCycleMinutes: cfg.autoIntervalMinutes,
    manualCooldownRemainingSeconds,
    canManualRefresh,
  dailyManualUsed: dailyManualCount,
    dailyManualLimit,
    manualLimitReached,
    dataFresh,
    refreshBadge: isTradingSession(market)
      ? `交易中｜自动每${cfg.autoIntervalMinutes}分钟刷新`
      : `已收市｜继续展示最近成功数据`,
    manualCooldownStatus:
      manualLimitReached
        ? '今日手动刷新已达上限'
        : canManualRefresh
          ? '可手动刷新'
          : `需等待 ${manualCooldownRemainingSeconds} 秒后可再次手动刷新`,
    errorPolicy: {
      failurePolicy: '接口异常时回退到最近成功数据与时间',
      fallbackEnabled: true
    },
    autoRefreshWarning: !isTradingSession(market)
      ? '非交易时段，不做行情推送；仅展示收盘后缓存'
      : '仅更新必要行情字段，不刷新财务与公告'
  }
}

module.exports = {
  buildRefreshState,
  calculateCooldownRemainingSeconds
}
