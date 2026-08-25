const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  IFIND_BUNDLE_PATH,
  IFIND_DIAGNOSTIC_MODE_DISABLED,
  createIfindSecretContract
} = require('./ifind-secret-contract')

const BUNDLE_PATH = IFIND_BUNDLE_PATH
const BUNDLE_OWNER_UID = 0
const BUNDLE_GROUP_GID = 10001
const BUNDLE_DIRECTORY_MODE = 0o550
const BUNDLE_FILE_MODE = 0o440
const DIRECTORY_FD_ROOT = '/proc/self/fd/'
const MANIFEST_FILE = 'manifest.json'
const TOKEN_FILE = 'refresh-token'
const REQUIRED_FILES = Object.freeze([MANIFEST_FILE, TOKEN_FILE].sort())
const MAX_FILE_BYTES = Object.freeze({
  [MANIFEST_FILE]: 4096,
  [TOKEN_FILE]: 4096
})
const VERSION_ID_PATTERN = /^v[0-9]{8}-[0-9]{3}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

class IfindTmpfsSecretProviderError extends Error {
  constructor(code) {
    const messages = {
      IFIND_TMPFS_BUNDLE_INVALID: 'The iFinD tmpfs secret bundle is invalid',
      IFIND_REFRESH_TOKEN_UNAVAILABLE: 'The iFinD refresh token is unavailable'
    }
    super(messages[code] || 'The iFinD tmpfs secret provider failed')
    this.name = 'IfindTmpfsSecretProviderError'
    this.code = code
  }
}

function failBundle() {
  throw new IfindTmpfsSecretProviderError('IFIND_TMPFS_BUNDLE_INVALID')
}

function hasExactKeys(value, expected) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
}

function hasExactMetadata(stat, { expectedUid, expectedGid, mode, type }) {
  return stat.uid === expectedUid &&
    stat.gid === expectedGid &&
    (stat.mode & 0o7777) === mode &&
    (type === 'directory' ? stat.isDirectory() : stat.isFile())
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function validateFileStat(stat, initialStat, expectedUid, expectedGid, maxBytes) {
  if (!hasExactMetadata(stat, {
    expectedUid,
    expectedGid,
    mode: BUNDLE_FILE_MODE,
    type: 'file'
  }) ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > maxBytes ||
    !sameIdentity(stat, initialStat)) {
    failBundle()
  }
}

function readBoundedFile(
  bundlePath,
  fileName,
  expectedUid,
  expectedGid,
  initialStat,
  fsApi
) {
  const filePath = path.join(bundlePath, fileName)
  let descriptor
  let scratch
  let value
  let transferred = false
  try {
    validateFileStat(
      initialStat,
      initialStat,
      expectedUid,
      expectedGid,
      MAX_FILE_BYTES[fileName]
    )
    descriptor = fsApi.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    )
    const openedStat = fsApi.fstatSync(descriptor)
    validateFileStat(
      openedStat,
      initialStat,
      expectedUid,
      expectedGid,
      MAX_FILE_BYTES[fileName]
    )

    const maxBytes = MAX_FILE_BYTES[fileName]
    scratch = Buffer.alloc(maxBytes + 1)
    let bytesRead = 0
    while (bytesRead < scratch.length) {
      const count = fsApi.readSync(
        descriptor,
        scratch,
        bytesRead,
        scratch.length - bytesRead,
        null
      )
      if (count === 0) break
      bytesRead += count
    }
    if (bytesRead > maxBytes) failBundle()

    const finalStat = fsApi.fstatSync(descriptor)
    validateFileStat(
      finalStat,
      initialStat,
      expectedUid,
      expectedGid,
      MAX_FILE_BYTES[fileName]
    )
    if (bytesRead !== finalStat.size) failBundle()

    const finalPathStat = fsApi.lstatSync(filePath)
    validateFileStat(
      finalPathStat,
      initialStat,
      expectedUid,
      expectedGid,
      MAX_FILE_BYTES[fileName]
    )

    value = Buffer.alloc(bytesRead)
    scratch.copy(value, 0, 0, bytesRead)
    transferred = true
    return value
  } catch (error) {
    if (error instanceof IfindTmpfsSecretProviderError) throw error
    failBundle()
  } finally {
    if (scratch) scratch.fill(0)
    if (value && !transferred) value.fill(0)
    if (descriptor !== undefined) {
      try { fsApi.closeSync(descriptor) } catch {}
    }
  }
}

function parseManifest(raw, versionId) {
  try {
    const text = raw.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(raw)) failBundle()
    const value = JSON.parse(text)
    if (!hasExactKeys(value, ['format', 'refreshToken']) ||
      value.format !== 'kinvest-ifind-tmpfs-v1' ||
      !hasExactKeys(value.refreshToken, ['file', 'versionId', 'sha256']) ||
      value.refreshToken.file !== TOKEN_FILE ||
      value.refreshToken.versionId !== versionId ||
      !SHA256_PATTERN.test(value.refreshToken.sha256)) {
      failBundle()
    }
    const normalized = {
      format: 'kinvest-ifind-tmpfs-v1',
      refreshToken: {
        file: TOKEN_FILE,
        versionId,
        sha256: value.refreshToken.sha256
      }
    }
    if (text !== JSON.stringify(normalized)) failBundle()
    return normalized
  } catch (error) {
    if (error instanceof IfindTmpfsSecretProviderError) throw error
    failBundle()
  }
}

function validateToken(raw) {
  const text = raw.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(raw) ||
    text.length === 0 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
    failBundle()
  }
}

function verifyDigest(value, expected) {
  const actual = crypto.createHash('sha256').update(value).digest()
  const declared = Buffer.from(expected, 'hex')
  try {
    if (declared.length !== actual.length || !crypto.timingSafeEqual(actual, declared)) {
      failBundle()
    }
  } finally {
    actual.fill(0)
    declared.fill(0)
  }
}

class LoadedIfindTmpfsSecretProvider {
  #refreshToken
  #cleared

  constructor(refreshToken) {
    this.#refreshToken = refreshToken
    this.#cleared = false
  }

  readRefreshToken() {
    if (this.#cleared) {
      throw new IfindTmpfsSecretProviderError('IFIND_REFRESH_TOKEN_UNAVAILABLE')
    }
    return Buffer.from(this.#refreshToken)
  }

  clear() {
    if (this.#cleared) return
    this.#cleared = true
    this.#refreshToken.fill(0)
  }
}

async function loadIfindTmpfsSecretsFromBundle({
  versionId,
  bundlePath,
  expectedUid,
  expectedGid,
  fsApi = fs
} = {}) {
  if (typeof versionId !== 'string' ||
    !VERSION_ID_PATTERN.test(versionId) ||
    typeof bundlePath !== 'string' ||
    !path.isAbsolute(bundlePath) ||
    !Number.isSafeInteger(expectedUid) || expectedUid < 0 ||
    !Number.isSafeInteger(expectedGid) || expectedGid < 0 ||
    !fsApi || typeof fsApi !== 'object') {
    failBundle()
  }

  const loaded = []
  let directoryDescriptor
  try {
    directoryDescriptor = fsApi.openSync(
      bundlePath,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW
    )
    const directoryStat = fsApi.fstatSync(directoryDescriptor)
    const directoryPathStat = fsApi.lstatSync(bundlePath)
    if (!hasExactMetadata(directoryStat, {
      expectedUid,
      expectedGid,
      mode: BUNDLE_DIRECTORY_MODE,
      type: 'directory'
    }) ||
      !hasExactMetadata(directoryPathStat, {
        expectedUid,
        expectedGid,
        mode: BUNDLE_DIRECTORY_MODE,
        type: 'directory'
      }) ||
      !sameIdentity(directoryStat, directoryPathStat)) {
      failBundle()
    }

    const anchoredBundlePath = DIRECTORY_FD_ROOT + directoryDescriptor
    if (fsApi.readdirSync(anchoredBundlePath).sort().join('\0') !==
      REQUIRED_FILES.join('\0')) {
      failBundle()
    }

    const fileSnapshots = new Map()
    for (const fileName of REQUIRED_FILES) {
      const stat = fsApi.lstatSync(path.join(anchoredBundlePath, fileName))
      validateFileStat(
        stat,
        stat,
        expectedUid,
        expectedGid,
        MAX_FILE_BYTES[fileName]
      )
      fileSnapshots.set(fileName, stat)
    }

    const manifestRaw = readBoundedFile(
      anchoredBundlePath,
      MANIFEST_FILE,
      expectedUid,
      expectedGid,
      fileSnapshots.get(MANIFEST_FILE),
      fsApi
    )
    loaded.push(manifestRaw)
    const manifest = parseManifest(manifestRaw, versionId)

    const refreshToken = readBoundedFile(
      anchoredBundlePath,
      TOKEN_FILE,
      expectedUid,
      expectedGid,
      fileSnapshots.get(TOKEN_FILE),
      fsApi
    )
    loaded.push(refreshToken)
    validateToken(refreshToken)
    verifyDigest(refreshToken, manifest.refreshToken.sha256)

    const finalDirectoryStat = fsApi.fstatSync(directoryDescriptor)
    const finalDirectoryPathStat = fsApi.lstatSync(bundlePath)
    if (!hasExactMetadata(finalDirectoryStat, {
      expectedUid,
      expectedGid,
      mode: BUNDLE_DIRECTORY_MODE,
      type: 'directory'
    }) ||
      !hasExactMetadata(finalDirectoryPathStat, {
        expectedUid,
        expectedGid,
        mode: BUNDLE_DIRECTORY_MODE,
        type: 'directory'
      }) ||
      !sameIdentity(directoryStat, finalDirectoryStat) ||
      !sameIdentity(directoryStat, finalDirectoryPathStat) ||
      fsApi.readdirSync(anchoredBundlePath).sort().join('\0') !== REQUIRED_FILES.join('\0')) {
      failBundle()
    }

    for (const fileName of REQUIRED_FILES) {
      const finalStat = fsApi.lstatSync(path.join(anchoredBundlePath, fileName))
      validateFileStat(
        finalStat,
        fileSnapshots.get(fileName),
        expectedUid,
        expectedGid,
        MAX_FILE_BYTES[fileName]
      )
    }

    return new LoadedIfindTmpfsSecretProvider(Buffer.from(refreshToken))
  } catch (error) {
    if (error instanceof IfindTmpfsSecretProviderError) throw error
    failBundle()
  } finally {
    for (const value of loaded) value.fill(0)
    if (directoryDescriptor !== undefined) {
      try { fsApi.closeSync(directoryDescriptor) } catch {}
    }
  }
}

async function loadIfindTmpfsSecrets(config) {
  const contract = createIfindSecretContract(config)
  if (contract.mode === IFIND_DIAGNOSTIC_MODE_DISABLED) return null
  return loadIfindTmpfsSecretsFromBundle({
    versionId: contract.versionId,
    bundlePath: BUNDLE_PATH,
    expectedUid: BUNDLE_OWNER_UID,
    expectedGid: BUNDLE_GROUP_GID
  })
}

module.exports = {
  BUNDLE_DIRECTORY_MODE,
  BUNDLE_FILE_MODE,
  BUNDLE_GROUP_GID,
  BUNDLE_OWNER_UID,
  BUNDLE_PATH,
  IfindTmpfsSecretProviderError,
  loadIfindTmpfsSecrets
}
