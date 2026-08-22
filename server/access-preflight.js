const fs = require('node:fs')
const os = require('node:os')
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

function copyDescriptorToPrivateDatabase(
  sourceDescriptor,
  removePrivateDirectory
) {
  const directory = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    'kinvest-access-preflight-db-'
  ))
  fs.chmodSync(directory, 0o700)
  const databasePath = path.join(directory, 'candidate.sqlite')
  let destinationDescriptor
  const scratch = Buffer.alloc(64 * 1024)
  try {
    destinationDescriptor = fs.openSync(
      databasePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600
    )
    let position = 0
    while (true) {
      const bytesRead = fs.readSync(
        sourceDescriptor,
        scratch,
        0,
        scratch.length,
        position
      )
      if (bytesRead === 0) break
      let written = 0
      while (written < bytesRead) {
        written += fs.writeSync(
          destinationDescriptor,
          scratch,
          written,
          bytesRead - written
        )
      }
      position += bytesRead
    }
    fs.fsyncSync(destinationDescriptor)
    fs.closeSync(destinationDescriptor)
    destinationDescriptor = undefined
    return { databasePath, directory }
  } catch (error) {
    if (destinationDescriptor !== undefined) {
      try { fs.closeSync(destinationDescriptor) } catch {
        // The private directory is removed below even if descriptor close fails.
      }
    }
    removePrivateDirectory(directory)
    throw error
  } finally {
    scratch.fill(0)
  }
}

function bindCandidateDatabase(databasePath, productionDatabasePath, {
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
    privateCopy = copyDescriptorToPrivateDatabase(
      sourceDescriptor,
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
    candidateDatabase = bindCandidateDatabase(
      databasePath,
      productionDatabasePath,
      { removePrivateDirectory }
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
  runAccessPreflight,
  stableAccessPreflightErrorCode,
  successLine,
  bindCandidateDatabase
}
