const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { setDbPath, resetDbForTests } = require('../db/refresh-db')
const { evaluateRefreshState, allowManualRefresh, recordManualRefreshAttempt } = require('../services/refresh-rules')

function fixtureCompany() {
  return {
    securityCode: 'TEST.CODE',
    marketSnapshot: {
      isOpen: true,
      nextAutoRefreshAt: new Date('2026-07-28T16:00:00.000Z'),
      sourceTime: new Date('2026-07-28T15:40:00.000Z'),
      fetchedAt: new Date('2026-07-28T15:40:00.000Z'),
      lastManualRefreshAt: new Date('2026-07-28T15:58:30.000Z'),
      dailyManualCount: 0,
      dailyManualLimit: 2,
      fromCache: true,
      lastSuccessAt: new Date('2026-07-28T15:40:00.000Z')
    }
  }
}

function bootstrapDb() {
  const file = path.join('/tmp', `kinvest-test-${Date.now()}.sqlite`)
  setDbPath(file)
  if (fs.existsSync(file)) {
    fs.rmSync(file)
  }
  return file
}

function run() {
  const dbFile = bootstrapDb()
  const company = fixtureCompany()
  const now = new Date('2026-07-28T15:59:00.000Z')

  const first = evaluateRefreshState(company, now, { dailyManualLimit: 2, manualCooldownMs: 120000 })
  assert.strictEqual(first.dailyManualUsed, 0)
  assert.strictEqual(first.canManualRefresh, false)

  let firstAllow = allowManualRefresh('TEST.CODE', company, now, { dailyManualLimit: 2 })
  assert.strictEqual(firstAllow.allow, false)
  assert.strictEqual(firstAllow.reason, 'cooldown')

  recordManualRefreshAttempt('TEST.CODE', { allow: true }, company, now)
  recordManualRefreshAttempt('TEST.CODE', { allow: true }, company, now)

  const second = evaluateRefreshState(company, now, { dailyManualLimit: 2, manualCooldownMs: 120000 })
  assert.strictEqual(second.dailyManualUsed, 2)

  const blocked = allowManualRefresh('TEST.CODE', company, now, { dailyManualLimit: 2 })
  assert.strictEqual(blocked.allow, false)
  assert.strictEqual(blocked.refreshState.manualLimitReached, true)

  resetDbForTests(dbFile)
}

module.exports = { run }
