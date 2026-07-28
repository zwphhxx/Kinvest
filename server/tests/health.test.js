const fs = require('fs')
const assert = require('assert')
const { setDbPath, resetDbForTests } = require('../db/refresh-db')
const { getHealthState } = require('../services/health')

function loadHealthWithOpenDb(openDb) {
  const dbModulePath = require.resolve('../db/refresh-db')
  const healthModulePath = require.resolve('../services/health')
  const dbModule = require.cache[dbModulePath]
  const originalOpenDb = dbModule.exports.openDb

  dbModule.exports.openDb = openDb
  delete require.cache[healthModulePath]

  try {
    return require('../services/health').getHealthState
  } finally {
    dbModule.exports.openDb = originalOpenDb
    delete require.cache[healthModulePath]
  }
}

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

    const getHealthWithFailedProbe = loadHealthWithOpenDb(() => ({
      prepare() {
        return {
          get() {
            return { ready: 0 }
          }
        }
      }
    }))

    assert.throws(
      () => getHealthWithFailedProbe(new Date('2026-07-28T10:00:00.000Z')),
      { message: 'SQLite health query failed' }
    )

    const getHealthWithStringProbe = loadHealthWithOpenDb(() => ({
      prepare() {
        return {
          get() {
            return { ready: '1' }
          }
        }
      }
    }))

    assert.throws(
      () => getHealthWithStringProbe(new Date('2026-07-28T10:00:00.000Z')),
      { message: 'SQLite health query failed' }
    )
  } finally {
    resetDbForTests(dbFile)
  }
}

module.exports = { run }
