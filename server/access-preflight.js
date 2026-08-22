const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync, backup } = require('node:sqlite')
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
  'ACCESS_PREFLIGHT_DATABASE_SNAPSHOT_INVALID',
  'ACCESS_PREFLIGHT_CLEANUP_FAILED',
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

function sameIdentity(leftStat, rightStat) {
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
}

function sameFileState(leftStat, rightStat) {
  return sameIdentity(leftStat, rightStat) &&
    leftStat.size === rightStat.size &&
    leftStat.mtimeMs === rightStat.mtimeMs &&
    leftStat.ctimeMs === rightStat.ctimeMs
}

function linuxSourceDescriptorPath(descriptor) {
  if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
    throw preflightError('ACCESS_PREFLIGHT_DATABASE_PATH_INVALID')
  }
  return `/proc/self/fd/${descriptor}`
}

function defaultSourceDescriptorPath(descriptor) {
  if (process.platform === 'linux') {
    return linuxSourceDescriptorPath(descriptor)
  }
  if (process.platform === 'darwin') return `/dev/fd/${descriptor}`
  throw preflightError('ACCESS_PREFLIGHT_DATABASE_PATH_INVALID')
}

function defaultOpenSourceDatabase(descriptorPath, options) {
  return new DatabaseSync(descriptorPath, options)
}

function defaultRemovePrivateDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true })
}

function assertSidecarFree(databasePath) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      fs.lstatSync(databasePath + suffix)
    } catch (error) {
      if (error && typeof error === 'object' &&
        'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    throw preflightError('ACCESS_PREFLIGHT_DATABASE_SNAPSHOT_INVALID')
  }
}

async function snapshotDatabaseToPrivateDirectory(
  sourceDescriptor,
  sourcePath,
  anchoredStat,
  backupDatabase,
  sourceDescriptorPath,
  openSourceDatabase,
  removePrivateDirectory
) {
  const directory = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    'kinvest-access-preflight-db-'
  ))
  fs.chmodSync(directory, 0o700)
  const databasePath = path.join(directory, 'candidate.sqlite')
  let sourceDatabase
  try {
    sourceDatabase = openSourceDatabase(
      sourceDescriptorPath(sourceDescriptor),
      { readOnly: true }
    )
    sourceDatabase.exec('PRAGMA query_only = ON')
    const reboundStat = fs.lstatSync(sourcePath)
    if (!reboundStat.isFile() || reboundStat.isSymbolicLink() ||
      !sameIdentity(anchoredStat, reboundStat) ||
      !sameIdentity(anchoredStat, fs.fstatSync(sourceDescriptor))) {
      throw preflightError('ACCESS_PREFLIGHT_DATABASE_PATH_INVALID')
    }
    await backupDatabase(sourceDatabase, databasePath)
    sourceDatabase.close()
    sourceDatabase = undefined
    const finalSourceStat = fs.lstatSync(sourcePath)
    if (!sameFileState(anchoredStat, finalSourceStat) ||
      !sameIdentity(anchoredStat, fs.fstatSync(sourceDescriptor))) {
      throw preflightError('ACCESS_PREFLIGHT_DATABASE_PATH_INVALID')
    }
    assertSidecarFree(sourcePath)
    const destinationStat = fs.lstatSync(databasePath)
    if (!destinationStat.isFile() || destinationStat.isSymbolicLink() ||
      destinationStat.nlink !== 1) {
      throw preflightError('ACCESS_PREFLIGHT_DATABASE_SNAPSHOT_INVALID')
    }
    fs.chmodSync(databasePath, 0o600)
    assertSidecarFree(databasePath)
    return { databasePath, directory }
  } catch (error) {
    if (sourceDatabase) {
      try { sourceDatabase.close() } catch {
        // The private directory is still removed below.
      }
    }
    try { removePrivateDirectory(directory) } catch {
      // Preserve the stable snapshot or path error.
    }
    if (error && typeof error === 'object' && 'code' in error && (
      error.code === 'ACCESS_PREFLIGHT_DATABASE_PATH_INVALID' ||
      error.code === 'ACCESS_PREFLIGHT_DATABASE_SNAPSHOT_INVALID'
    )) throw error
    throw preflightError('ACCESS_PREFLIGHT_DATABASE_SNAPSHOT_INVALID')
  }
}

async function bindCandidateDatabase(databasePath, productionDatabasePath, {
  backupDatabase = backup,
  sourceDescriptorPath = defaultSourceDescriptorPath,
  openSourceDatabase = defaultOpenSourceDatabase,
  removePrivateDirectory = defaultRemovePrivateDirectory
} = {}) {
  if (typeof databasePath !== 'string' || databasePath.length === 0) {
    throw preflightError('ACCESS_PREFLIGHT_DATABASE_PATH_REQUIRED')
  }
  if (!path.isAbsolute(databasePath) || databasePath !== path.normalize(databasePath)) {
    throw preflightError('ACCESS_PREFLIGHT_DATABASE_PATH_INVALID')
  }
  const candidate = path.resolve(databasePath)
  const production = path.resolve(productionDatabasePath)
  let sourceDescriptor
  let privateCopy
  try {
    const parent = path.dirname(candidate)
    const parentStat = fs.lstatSync(parent)
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
      fs.realpathSync(parent) !== parent) {
      throw preflightError('ACCESS_PREFLIGHT_DATABASE_PATH_INVALID')
    }
    assertSidecarFree(candidate)
    const pathStat = fs.lstatSync(candidate)
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1 ||
      candidate === production) {
      throw preflightError('ACCESS_PREFLIGHT_DATABASE_PATH_INVALID')
    }
    sourceDescriptor = fs.openSync(
      candidate,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    )
    const openedStat = fs.fstatSync(sourceDescriptor)
    if (!openedStat.isFile() || openedStat.nlink !== 1 ||
      !sameIdentity(pathStat, openedStat)) {
      throw preflightError('ACCESS_PREFLIGHT_DATABASE_PATH_INVALID')
    }
    if (fs.existsSync(production) &&
      sameIdentity(openedStat, fs.statSync(production))) {
      throw preflightError('ACCESS_PREFLIGHT_DATABASE_PATH_INVALID')
    }
    privateCopy = await snapshotDatabaseToPrivateDirectory(
      sourceDescriptor,
      candidate,
      openedStat,
      backupDatabase,
      sourceDescriptorPath,
      openSourceDatabase,
      removePrivateDirectory
    )
    assertSidecarFree(candidate)
    let cleared = false
    return Object.freeze({
      databasePath: privateCopy.databasePath,
      clear() {
        if (cleared) return
        cleared = true
        try { fs.closeSync(sourceDescriptor) } catch {
          // The descriptor is no longer reachable after cleanup.
        }
        removePrivateDirectory(privateCopy.directory)
      }
    })
  } catch (error) {
    if (sourceDescriptor !== undefined) {
      try { fs.closeSync(sourceDescriptor) } catch {
        // Preserve the stable path validation failure.
      }
    }
    if (privateCopy) {
      try { removePrivateDirectory(privateCopy.directory) } catch {
        // Preserve the stable validation error from the failed binding.
      }
    }
    if (error && typeof error === 'object' &&
      'code' in error && (
        error.code === 'ACCESS_PREFLIGHT_DATABASE_PATH_REQUIRED' ||
        error.code === 'ACCESS_PREFLIGHT_DATABASE_PATH_INVALID' ||
        error.code === 'ACCESS_PREFLIGHT_DATABASE_SNAPSHOT_INVALID'
      )) {
      throw error
    }
    throw preflightError('ACCESS_PREFLIGHT_DATABASE_PATH_INVALID')
  }
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
  loadSecrets,
  createAccessRuntime,
  createHandler,
  backupDatabase = backup,
  sourceDescriptorPath = defaultSourceDescriptorPath,
  openSourceDatabase = defaultOpenSourceDatabase,
  removePrivateDirectory = defaultRemovePrivateDirectory,
  stdout = process.stdout,
  stderr = process.stderr,
  processRef = process
} = {}) {
  let prepared
  let candidateDatabase
  let interrupted = false
  let cleanupFailure
  const abortController = new AbortController()
  const handleSignal = () => {
    interrupted = true
    abortController.abort(preflightError('ACCESS_PREFLIGHT_INTERRUPTED'))
    if (prepared) {
      try { prepared.clear() } catch {
        cleanupFailure = preflightError('ACCESS_PREFLIGHT_CLEANUP_FAILED')
      }
    }
  }
  processRef.once('SIGTERM', handleSignal)
  processRef.once('SIGINT', handleSignal)
  let resultLine
  let failure
  try {
    candidateDatabase = await bindCandidateDatabase(
      databasePath,
      productionDatabasePath,
      {
        backupDatabase,
        sourceDescriptorPath,
        openSourceDatabase,
        removePrivateDirectory
      }
    )
    prepared = await prepare({
      env,
      ...(bootstrap ? { bootstrap } : {}),
      ...(loadSecrets ? { loadSecrets } : {}),
      ...(createAccessRuntime ? { createAccessRuntime } : {}),
      ...(createHandler ? { createHandler } : {}),
      signal: abortController.signal,
      openDatabase: () => openDbAtPath(candidateDatabase.databasePath),
      closeDatabase
    })
    if (interrupted) throw preflightError('ACCESS_PREFLIGHT_INTERRUPTED')
    resultLine = successLine(prepared.status)
  } catch (error) {
    failure = error
  } finally {
    if (prepared) {
      try { prepared.clear() } catch {
        cleanupFailure = preflightError('ACCESS_PREFLIGHT_CLEANUP_FAILED')
      }
    }
    if (candidateDatabase) {
      try { candidateDatabase.clear() } catch {
        cleanupFailure = preflightError('ACCESS_PREFLIGHT_CLEANUP_FAILED')
      }
    }
    processRef.removeListener('SIGTERM', handleSignal)
    processRef.removeListener('SIGINT', handleSignal)
  }
  if (!failure && cleanupFailure) failure = cleanupFailure
  if (failure) {
    stderr.write(`${stableAccessPreflightErrorCode(failure)}\n`)
    return 1
  }
  stdout.write(resultLine)
  return 0
}

if (require.main === module) {
  runAccessPreflight({ databasePath: process.argv[2] }).then((exitCode) => {
    process.exitCode = exitCode
  }).catch(() => {
    try { process.stderr.write('ACCESS_PREFLIGHT_FAILED\n') } catch {
      // The process still exits unsuccessfully if stderr itself is unavailable.
    }
    process.exitCode = 1
  })
}

module.exports = {
  linuxSourceDescriptorPath,
  runAccessPreflight,
  stableAccessPreflightErrorCode,
  successLine,
  bindCandidateDatabase
}
