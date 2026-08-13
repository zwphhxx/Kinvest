const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  ADMIN_SECRET_NAME,
  DEVICE_HMAC_SECRET_NAME
} = require('./secret-bootstrap-contract')

const BUNDLE_PATH = '/run/secrets/kinvest'
const BUNDLE_OWNER_UID = 0
const BUNDLE_GROUP_GID = 10001
const BUNDLE_DIRECTORY_MODE = 0o550
const BUNDLE_FILE_MODE = 0o440
const APPLICATION_UID = 10001
const APPLICATION_GID = 10001
const DIRECTORY_FD_ROOT = '/proc/self/fd/'
const MANIFEST_FILE = 'manifest.json'
const ADMIN_FILE = 'admin-password-verifier'
const HMAC_FILE = 'device-token-hmac-key'
const REQUIRED_FILES = Object.freeze([
  ADMIN_FILE,
  HMAC_FILE,
  MANIFEST_FILE
].sort())
const MAX_FILE_BYTES = Object.freeze({
  [MANIFEST_FILE]: 4096,
  [ADMIN_FILE]: 4096,
  [HMAC_FILE]: 128
})
const VERSION_ID_PATTERN = /^v[0-9]{8}-[0-9]{3}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

class GithubTmpfsSecretProviderError extends Error {
  constructor(code) {
    const messages = {
      GITHUB_TMPFS_CONFIG_INVALID: 'The GitHub tmpfs secret provider configuration is invalid',
      GITHUB_TMPFS_BUNDLE_INVALID: 'The GitHub tmpfs secret bundle is invalid',
      SECRET_NOT_FOUND: 'The requested secret is unavailable'
    }
    super(messages[code] || 'The GitHub tmpfs secret provider failed')
    this.name = 'GithubTmpfsSecretProviderError'
    this.code = code
  }
}

function failBundle() {
  throw new GithubTmpfsSecretProviderError('GITHUB_TMPFS_BUNDLE_INVALID')
}

function failConfig() {
  throw new GithubTmpfsSecretProviderError('GITHUB_TMPFS_CONFIG_INVALID')
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

function normalizeReferences(references) {
  if (!Array.isArray(references) || references.length !== 2) failBundle()
  const result = new Map()
  try {
    for (const reference of references) {
      if (!hasExactKeys(reference, ['secretName', 'versionId']) ||
        (reference.secretName !== ADMIN_SECRET_NAME &&
          reference.secretName !== DEVICE_HMAC_SECRET_NAME) ||
        !VERSION_ID_PATTERN.test(reference.versionId) ||
        result.has(reference.secretName)) {
        failBundle()
      }
      result.set(reference.secretName, reference.versionId)
    }
  } catch (error) {
    if (error instanceof GithubTmpfsSecretProviderError) throw error
    failBundle()
  }
  if (!result.has(ADMIN_SECRET_NAME) || !result.has(DEVICE_HMAC_SECRET_NAME)) {
    failBundle()
  }
  return result
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
    stat.dev !== initialStat.dev ||
    stat.ino !== initialStat.ino) {
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
    if (error instanceof GithubTmpfsSecretProviderError) throw error
    failBundle()
  } finally {
    if (scratch) scratch.fill(0)
    if (value && !transferred) value.fill(0)
    if (descriptor !== undefined) {
      try { fsApi.closeSync(descriptor) } catch {
        // A close failure does not expose details and the process owns no handle afterwards.
      }
    }
  }
}

function parseManifest(raw, references) {
  let text
  let value
  try {
    text = raw.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(raw)) failBundle()
    value = JSON.parse(text)
    if (!hasExactKeys(value, [
      'format',
      'adminPasswordVerifier',
      'deviceTokenHmac'
    ]) ||
      value.format !== 'kinvest-github-tmpfs-v1' ||
      !hasExactKeys(value.adminPasswordVerifier, ['file', 'versionId', 'sha256']) ||
      !hasExactKeys(value.deviceTokenHmac, ['file', 'versionId', 'sha256'])) {
      failBundle()
    }
    const normalized = {
      format: 'kinvest-github-tmpfs-v1',
      adminPasswordVerifier: {
        file: ADMIN_FILE,
        versionId: references.get(ADMIN_SECRET_NAME),
        sha256: value.adminPasswordVerifier.sha256
      },
      deviceTokenHmac: {
        file: HMAC_FILE,
        versionId: references.get(DEVICE_HMAC_SECRET_NAME),
        sha256: value.deviceTokenHmac.sha256
      }
    }
    if (value.adminPasswordVerifier.file !== ADMIN_FILE ||
      value.deviceTokenHmac.file !== HMAC_FILE ||
      value.adminPasswordVerifier.versionId !== references.get(ADMIN_SECRET_NAME) ||
      value.deviceTokenHmac.versionId !== references.get(DEVICE_HMAC_SECRET_NAME) ||
      !SHA256_PATTERN.test(value.adminPasswordVerifier.sha256) ||
      !SHA256_PATTERN.test(value.deviceTokenHmac.sha256) ||
      text !== JSON.stringify(normalized)) {
      failBundle()
    }
    return normalized
  } catch (error) {
    if (error instanceof GithubTmpfsSecretProviderError) throw error
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

class LoadedGithubTmpfsSecretProvider {
  #entries
  #cleared

  constructor(entries) {
    this.#entries = entries
    this.#cleared = false
  }

  readSecret(reference) {
    if (this.#cleared) {
      throw new GithubTmpfsSecretProviderError('SECRET_NOT_FOUND')
    }
    let key
    try {
      key = `${reference.secretName}:${reference.versionId}`
    } catch {
      throw new GithubTmpfsSecretProviderError('SECRET_NOT_FOUND')
    }
    const value = this.#entries.get(key)
    if (!value) throw new GithubTmpfsSecretProviderError('SECRET_NOT_FOUND')
    return Buffer.from(value)
  }

  clear() {
    if (this.#cleared) return
    this.#cleared = true
    for (const value of this.#entries.values()) value.fill(0)
    this.#entries.clear()
  }
}

/**
 * @param {object} [options]
 * @param {Array<{secretName: string, versionId: string}>} [options.references]
 * @param {string} [options.bundlePath]
 * @param {number} [options.expectedUid]
 * @param {number} [options.expectedGid]
 * @param {any} [options.fsApi]
 */
async function loadGithubTmpfsSecretsFromBundle({
  references,
  bundlePath,
  expectedUid,
  expectedGid,
  fsApi = fs
} = {}) {
  if (typeof bundlePath !== 'string' ||
    !path.isAbsolute(bundlePath) ||
    !Number.isSafeInteger(expectedUid) || expectedUid < 0 ||
    !Number.isSafeInteger(expectedGid) || expectedGid < 0 ||
    !fsApi || typeof fsApi !== 'object') {
    failBundle()
  }

  const normalizedReferences = normalizeReferences(references)
  /** @type {Buffer[]} */
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
    const files = fsApi.readdirSync(anchoredBundlePath).sort()
    if (files.join('\0') !== REQUIRED_FILES.join('\0')) failBundle()
    const fileSnapshots = new Map()
    for (const fileName of REQUIRED_FILES) {
      const fileStat = fsApi.lstatSync(path.join(anchoredBundlePath, fileName))
      validateFileStat(
        fileStat,
        fileStat,
        expectedUid,
        expectedGid,
        MAX_FILE_BYTES[fileName]
      )
      fileSnapshots.set(fileName, fileStat)
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
    const manifest = parseManifest(manifestRaw, normalizedReferences)
    const adminMaterial = readBoundedFile(
      anchoredBundlePath,
      ADMIN_FILE,
      expectedUid,
      expectedGid,
      fileSnapshots.get(ADMIN_FILE),
      fsApi
    )
    loaded.push(adminMaterial)
    const hmacMaterial = readBoundedFile(
      anchoredBundlePath,
      HMAC_FILE,
      expectedUid,
      expectedGid,
      fileSnapshots.get(HMAC_FILE),
      fsApi
    )
    loaded.push(hmacMaterial)
    verifyDigest(adminMaterial, manifest.adminPasswordVerifier.sha256)
    verifyDigest(hmacMaterial, manifest.deviceTokenHmac.sha256)

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
      const finalFileStat = fsApi.lstatSync(path.join(anchoredBundlePath, fileName))
      validateFileStat(
        finalFileStat,
        fileSnapshots.get(fileName),
        expectedUid,
        expectedGid,
        MAX_FILE_BYTES[fileName]
      )
    }

    const entries = new Map([
      [`${ADMIN_SECRET_NAME}:${normalizedReferences.get(ADMIN_SECRET_NAME)}`,
        Buffer.from(adminMaterial)],
      [`${DEVICE_HMAC_SECRET_NAME}:${normalizedReferences.get(DEVICE_HMAC_SECRET_NAME)}`,
        Buffer.from(hmacMaterial)]
    ])
    return new LoadedGithubTmpfsSecretProvider(entries)
  } catch (error) {
    if (error instanceof GithubTmpfsSecretProviderError) throw error
    failBundle()
  } finally {
    for (const value of loaded) value.fill(0)
    if (directoryDescriptor !== undefined) {
      try { fsApi.closeSync(directoryDescriptor) } catch {
        // The descriptor is no longer reachable from this provider operation.
      }
    }
  }
}

async function loadGithubTmpfsSecrets(options = {}) {
  if (!hasExactKeys(options, ['references'])) failConfig()
  return loadGithubTmpfsSecretsFromBundle({
    references: options.references,
    bundlePath: BUNDLE_PATH,
    expectedUid: BUNDLE_OWNER_UID,
    expectedGid: BUNDLE_GROUP_GID
  })
}

module.exports = {
  APPLICATION_GID,
  APPLICATION_UID,
  BUNDLE_DIRECTORY_MODE,
  BUNDLE_FILE_MODE,
  BUNDLE_GROUP_GID,
  BUNDLE_OWNER_UID,
  BUNDLE_PATH,
  GithubTmpfsSecretProviderError,
  loadGithubTmpfsSecrets
}
