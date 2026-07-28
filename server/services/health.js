const { openDb } = require('../db/refresh-db')

function getHealthState(now = new Date()) {
  try {
    openDb().prepare('SELECT 1 AS ready').get()
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
