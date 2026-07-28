const { openDb } = require('../db/refresh-db')

function getHealthState(now = new Date(), database) {
  try {
    const db = database === undefined ? openDb() : database
    const result = db.prepare('SELECT 1 AS ready').get()
    if (!result || Number(result.ready) !== 1) throw new Error('SQLite health query failed')
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
