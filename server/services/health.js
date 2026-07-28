const { openDb } = require('../db/refresh-db')

function getHealthState(now = new Date()) {
  try {
    const result = openDb().prepare('SELECT 1 AS ready').get()
    if (!result || result.ready !== 1) throw new Error('SQLite health query failed')
  } catch (err) {
    throw new Error('SQLite health query failed')
  }

  return {
    status: 'ok',
    service: 'kinvest',
    dataMode: 'mock',
    database: 'ready',
    timestamp: now.toISOString()
  }
}

module.exports = { getHealthState }
