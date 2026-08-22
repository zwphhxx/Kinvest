const fs = require('node:fs')
const path = require('node:path')
const {
  closeDatabase,
  getDbPath,
  openDbAtPath
} = require('./db/refresh-db')
const { prepareApplication } = require('./pre-listen-preparation')

const ACCESS_PREFLIGHT_ERROR_CODES = new Set([
  'ACCESS_CONTROL_CONFIG_INVALID',
  'ACCESS_PREFLIGHT_DATABASE_PATH_INVALID',
  'ACCESS_PREFLIGHT_DATABASE_PATH_REQUIRED',
  'ACCESS_PREFLIGHT_INTERRUPTED',
  'GITHUB_TMPFS_BUNDLE_INVALID',
  'GITHUB_TMPFS_CONFIG_INVALID',
  'HTTP_SECURITY_CONFIG_INVALID',
  'SECRET_BOOTSTRAP_CONFIG_INVALID',
  'SECRET_MATERIAL_INVALID',
  'SECRET_MATERIAL_LOAD_FAILED',
  'SECRET_MATERIAL_PROVIDER_INVALID',
  'SECRET_VERSION_CONFIG_INVALID',
  'SSM_BOOTSTRAP_INVALID',
  'SSM_CLIENT_UNAVAILABLE',
  'SSM_SECRET_LOAD_FAILED',
  'TEMPORARY_CREDENTIALS_REQUIRED'
])

function preflightError(code) {
  return Object.assign(new Error('Access preflight failed'), { code })
}

/** @param {unknown} error */
function stableAccessPreflightErrorCode(error) {
  const code = error && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined
  return typeof code === 'string' && ACCESS_PREFLIGHT_ERROR_CODES.has(code)
    ? code
    : 'ACCESS_PREFLIGHT_FAILED'
}

function sameExistingFile(left, right) {
  if (!fs.existsSync(left) || !fs.existsSync(right)) return false
  const leftStat = fs.statSync(left)
  const rightStat = fs.statSync(right)
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
}

function validateDatabasePath(databasePath, productionDatabasePath) {
  if (typeof databasePath !== 'string' || databasePath.length === 0) {
    throw preflightError('ACCESS_PREFLIGHT_DATABASE_PATH_REQUIRED')
  }
  if (!path.isAbsolute(databasePath) || databasePath !== path.normalize(databasePath)) {
    throw preflightError('ACCESS_PREFLIGHT_DATABASE_PATH_INVALID')
  }
  const candidate = path.resolve(databasePath)
  const production = path.resolve(productionDatabasePath)
  if (candidate === production || sameExistingFile(candidate, production)) {
    throw preflightError('ACCESS_PREFLIGHT_DATABASE_PATH_INVALID')
  }
  return candidate
}

function successLine(status) {
  if (!status || status.mode !== 'device-approval' || status.references !== 2 ||
    status.database !== 'ready' || status.proxy !== 'ready') {
    throw preflightError('ACCESS_CONTROL_CONFIG_INVALID')
  }
  return 'KINVEST_ACCESS_PREFLIGHT_OK mode=device-approval references=2 database=ready proxy=ready\n'
}

/** @param {any} [options] */
async function runAccessPreflight({
  env = process.env,
  databasePath,
  productionDatabasePath = env.KINVEST_DB_PATH || getDbPath(),
  prepare = prepareApplication,
  bootstrap,
  createAccessRuntime,
  createHandler,
  stdout = process.stdout,
  stderr = process.stderr,
  processRef = process
} = {}) {
  let prepared
  let interrupted = false
  const handleSignal = () => {
    interrupted = true
    if (prepared) prepared.clear()
  }
  processRef.once('SIGTERM', handleSignal)
  processRef.once('SIGINT', handleSignal)
  try {
    const isolatedDatabasePath = validateDatabasePath(
      databasePath,
      productionDatabasePath
    )
    prepared = await prepare({
      env,
      ...(bootstrap ? { bootstrap } : {}),
      ...(createAccessRuntime ? { createAccessRuntime } : {}),
      ...(createHandler ? { createHandler } : {}),
      openDatabase: () => openDbAtPath(isolatedDatabasePath),
      closeDatabase
    })
    if (interrupted) throw preflightError('ACCESS_PREFLIGHT_INTERRUPTED')
    stdout.write(successLine(prepared.status))
    return 0
  } catch (error) {
    stderr.write(`${stableAccessPreflightErrorCode(error)}\n`)
    return 1
  } finally {
    if (prepared) prepared.clear()
    processRef.removeListener('SIGTERM', handleSignal)
    processRef.removeListener('SIGINT', handleSignal)
  }
}

if (require.main === module) {
  runAccessPreflight({ databasePath: process.argv[2] }).then((exitCode) => {
    process.exitCode = exitCode
  })
}

module.exports = {
  runAccessPreflight,
  stableAccessPreflightErrorCode,
  successLine,
  validateDatabasePath
}
