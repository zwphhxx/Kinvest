const fs = require('fs')
const assert = require('assert')
const { setDbPath, resetDbForTests } = require('../db/refresh-db')
const { getHealthState } = require('../services/health')

function run() {
  const dbFile = `/tmp/kinvest-health-${Date.now()}.sqlite`
  setDbPath(dbFile)

  try {
    const health = getHealthState(new Date('2026-07-28T10:00:00.000Z'))

    assert.deepStrictEqual(health, {
      status: 'ok',
      service: 'kinvest',
      dataMode: 'mock',
      database: 'ready',
      timestamp: '2026-07-28T10:00:00.000Z'
    })
    assert.strictEqual(fs.existsSync(dbFile), true)

    const failedProbeDb = {
      prepare() {
        return {
          get() {
            return { ready: 0 }
          }
        }
      }
    }

    assert.throws(
      () => getHealthState(new Date('2026-07-28T10:00:00.000Z'), failedProbeDb),
      { message: 'SQLite health query failed' }
    )
  } finally {
    resetDbForTests(dbFile)
  }
}

module.exports = { run }
