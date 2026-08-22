const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const DEFAULT_DB = path.join(__dirname, '../data/kinvest.sqlite')
let currentDbPath = process.env.KINVEST_DB_PATH || DEFAULT_DB
let db = null

function initializeRefreshDatabase(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS refresh_counters (
      code TEXT NOT NULL,
      date TEXT NOT NULL,
      manual_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (code, date)
    );

    CREATE TABLE IF NOT EXISTS manual_refresh_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT
    );
  `)
  return database
}

function openDbAtPath(databasePath) {
  const dir = path.dirname(databasePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return new DatabaseSync(databasePath)
}

function openTrackedDbAtPath(databasePath) {
  if (db) return db
  db = openDbAtPath(databasePath)
  return db
}

function openTrackedDb() {
  return openTrackedDbAtPath(currentDbPath)
}

function closeDatabase(database) {
  database.close()
}

function closeTrackedDatabase(database) {
  if (db === database) db = null
  closeDatabase(database)
}

function getDbPath() {
  return currentDbPath
}

function setDbPath(nextPath) {
  currentDbPath = nextPath
  db = null
}

function openDb() {
  if (db) return db
  const database = openTrackedDb()
  try {
    initializeRefreshDatabase(database)
    return db
  } catch (error) {
    closeTrackedDatabase(database)
    throw error
  }
}

function closeDb() {
  if (!db) return
  closeTrackedDatabase(db)
}

function todayKey(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10)
}

function getManualRefreshCount(code, date = todayKey()) {
  const stmt = openDb().prepare('SELECT manual_count FROM refresh_counters WHERE code=? AND date=?')
  const row = stmt.get(code, date)
  return row ? Number(row.manual_count) : 0
}

function upsertManualRefreshCount(code, date, count) {
  const now = new Date().toISOString()
  const dbConn = openDb()
  const existing = dbConn.prepare('SELECT 1 FROM refresh_counters WHERE code=? AND date=?').get(code, date)
  if (existing) {
    dbConn.prepare('UPDATE refresh_counters SET manual_count=?, updated_at=? WHERE code=? AND date=?')
      .run(count, now, code, date)
  } else {
    dbConn.prepare('INSERT INTO refresh_counters (code, date, manual_count, updated_at) VALUES (?, ?, ?, ?)')
      .run(code, date, count, now)
  }
}

function incrementManualRefreshCount(code, date = todayKey()) {
  const next = getManualRefreshCount(code, date) + 1
  upsertManualRefreshCount(code, date, next)
  return next
}

function resetAllRefreshCounters() {
  openDb().exec('DELETE FROM refresh_counters')
}

function addManualRefreshEvent({ code, status, message = null, at = new Date() }) {
  openDb().prepare('INSERT INTO manual_refresh_events (code, triggered_at, status, message) VALUES (?, ?, ?, ?)')
    .run(code, at.toISOString(), status, message)
}

function getManualRefreshSummary(code) {
  const dbConn = openDb()
  const events = dbConn.prepare('SELECT status, triggered_at FROM manual_refresh_events WHERE code=? ORDER BY triggered_at DESC LIMIT 3').all(code)
  return events
}

function resetDbForTests(dbFile) {
  if (db) {
    db.close()
    db = null
  }
  if (fs.existsSync(dbFile)) {
    fs.rmSync(dbFile)
  }
}

module.exports = {
  getDbPath,
  setDbPath,
  openDb,
  openDbAtPath,
  openTrackedDb,
  openTrackedDbAtPath,
  initializeRefreshDatabase,
  closeDb,
  closeDatabase,
  closeTrackedDatabase,
  todayKey,
  getManualRefreshCount,
  incrementManualRefreshCount,
  resetAllRefreshCounters,
  addManualRefreshEvent,
  getManualRefreshSummary,
  resetDbForTests
}
