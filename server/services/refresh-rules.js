const { buildRefreshState } = require('../utils/refresh-policy')
const {
  getManualRefreshCount,
  incrementManualRefreshCount,
  addManualRefreshEvent,
  todayKey
} = require('../db/refresh-db')

function evaluateRefreshState(company, now = new Date(), options = {}) {
  const dateKey = options.date || todayKey(now)
  const manualCount = getManualRefreshCount(company.securityCode, dateKey)
  const state = buildRefreshState(
    {
      market: {
        isOpen: company.marketSnapshot.isOpen,
        nextAutoRefreshAt: company.marketSnapshot.nextAutoRefreshAt
      },
      pricing: {
        sourceTime: company.marketSnapshot.sourceTime,
        fetchedAt: company.marketSnapshot.fetchedAt,
        lastManualRefreshAt: company.marketSnapshot.lastManualRefreshAt,
        dailyManualCount: manualCount,
        dailyManualLimit: options.dailyManualLimit || company.marketSnapshot.dailyManualLimit || 100,
        fromCache: company.marketSnapshot.fromCache,
        lastSuccessAt: company.marketSnapshot.lastSuccessAt
      }
    },
    now,
    {
      manualCooldownMs: options.manualCooldownMs || 2 * 60 * 1000
    }
  )

  return {
    ...state,
    dailyManualUsed: manualCount,
    dailyManualLimit: options.dailyManualLimit || state.dailyManualLimit
  }
}

function allowManualRefresh(code, company, now = new Date(), options = {}) {
  const state = evaluateRefreshState(company, now, options)
  return {
    allow: state.canManualRefresh,
    reason: state.canManualRefresh ? 'ok' : state.manualLimitReached ? 'daily_limit' : 'cooldown',
    refreshState: state
  }
}

function recordManualRefreshAttempt(code, state, company, now = new Date()) {
  const dateKey = todayKey(now)
  const used = incrementManualRefreshCount(code, dateKey)
  company.marketSnapshot.dailyManualCount = used
  addManualRefreshEvent({
    code,
    status: state.allow ? 'success' : 'blocked',
    message: state.reason
  })
  return used
}

module.exports = {
  evaluateRefreshState,
  allowManualRefresh,
  recordManualRefreshAttempt
}
