const assert = require('assert')
const { buildRefreshState } = require('../utils/refresh-policy')

function testRefreshStateWhileCoolDown() {
  const now = new Date('2026-07-28T15:50:00.000Z')
  const snapshot = {
    market: {
      isOpen: true,
      nextAutoRefreshAt: new Date('2026-07-28T15:58:00.000Z')
    },
    pricing: {
      sourceTime: new Date('2026-07-28T15:40:00.000Z'),
      fetchedAt: new Date('2026-07-28T15:48:00.000Z'),
      lastManualRefreshAt: new Date('2026-07-28T15:48:30.000Z'),
      dailyManualCount: 2,
      dailyManualLimit: 100,
      fromCache: true
    }
  }

  const state = buildRefreshState(snapshot, now, { manualCooldownMs: 120000, autoIntervalMinutes: 10 })
  assert.strictEqual(state.marketState, 'trading')
  assert.strictEqual(state.canManualRefresh, false)
  assert.strictEqual(state.manualCooldownRemainingSeconds, 30)
  assert.strictEqual(state.refreshBadge.includes('交易中'), true)
}

function testRefreshStateWhenClosed() {
  const now = new Date('2026-07-28T09:00:00.000Z')
  const snapshot = {
    market: {
      isOpen: false,
      nextAutoRefreshAt: new Date('2026-07-28T09:30:00.000Z')
    },
    pricing: {
      sourceTime: new Date('2026-07-27T15:40:00.000Z'),
      fetchedAt: new Date('2026-07-27T15:42:00.000Z'),
      lastManualRefreshAt: new Date('2026-07-27T15:42:00.000Z'),
      dailyManualCount: 100,
      dailyManualLimit: 100,
      fromCache: true,
      lastSuccessAt: new Date('2026-07-27T15:42:00.000Z')
    }
  }

  const state = buildRefreshState(snapshot, now, { manualCooldownMs: 120000, autoIntervalMinutes: 10 })
  assert.strictEqual(state.marketState, 'closed')
  assert.strictEqual(state.canManualRefresh, false)
  assert.strictEqual(state.manualLimitReached, true)
  assert.strictEqual(state.manualCooldownStatus.includes('已达上限'), true)
}

function run() {
  const tests = [
    testRefreshStateWhileCoolDown,
    testRefreshStateWhenClosed
  ]
  for (const t of tests) {
    t()
  }
  return true
}

module.exports = { run }
