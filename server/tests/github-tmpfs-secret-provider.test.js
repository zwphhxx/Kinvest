const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  createGithubTmpfsSecretLoaderForTest
} = require('./support/load-github-tmpfs-provider-for-test')
const {
  ADMIN_SECRET_NAME,
  DEVICE_HMAC_SECRET_NAME,
  generateAdminPasswordVerifier,
  generateDeviceHmacSecret
} = require('../security/secret-bootstrap-contract')

const VERSION = 'v20260813-001'
const ADMIN_FILE = 'admin-password-verifier'
const HMAC_FILE = 'device-token-hmac-key'
const MANIFEST_FILE = 'manifest.json'
const REFERENCES = [
  { secretName: ADMIN_SECRET_NAME, versionId: VERSION },
  { secretName: DEVICE_HMAC_SECRET_NAME, versionId: VERSION }
]

function deterministicBytes(length, label) {
  return Buffer.from(label.repeat(length), 'utf8').subarray(0, length)
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function canonicalManifest(adminMaterial, hmacMaterial, overrides = {}) {
  const value = {
    format: 'kinvest-github-tmpfs-v1',
    adminPasswordVerifier: {
      file: ADMIN_FILE,
      versionId: VERSION,
      sha256: sha256(adminMaterial)
    },
    deviceTokenHmac: {
      file: HMAC_FILE,
      versionId: VERSION,
      sha256: sha256(hmacMaterial)
    },
    ...overrides
  }
  return JSON.stringify(value)
}

/**
 * @param {string} root
 * @param {(bundle: {bundlePath: string, adminMaterial: Buffer, hmacMaterial: Buffer}) => void} [mutate]
 */
function createBundle(root, mutate = () => {}) {
  const bundlePath = path.join(root, 'bundle-sensitive-marker')
  const adminMaterial = Buffer.from(generateAdminPasswordVerifier(
    'correct horse battery staple',
    (length) => deterministicBytes(length, 'admin-salt')
  ))
  const hmacMaterial = Buffer.from(generateDeviceHmacSecret(
    (length) => deterministicBytes(length, 'device-hmac')
  ))
  fs.mkdirSync(bundlePath, { mode: 0o700 })
  fs.writeFileSync(path.join(bundlePath, ADMIN_FILE), adminMaterial, { mode: 0o600 })
  fs.writeFileSync(path.join(bundlePath, HMAC_FILE), hmacMaterial, { mode: 0o600 })
  fs.writeFileSync(
    path.join(bundlePath, MANIFEST_FILE),
    canonicalManifest(adminMaterial, hmacMaterial),
    { mode: 0o600 }
  )
  mutate({ bundlePath, adminMaterial, hmacMaterial })
  for (const name of fs.readdirSync(bundlePath)) {
    const filePath = path.join(bundlePath, name)
    if (fs.lstatSync(filePath).isFile()) fs.chmodSync(filePath, 0o440)
  }
  fs.chmodSync(bundlePath, 0o550)
  return { bundlePath, adminMaterial, hmacMaterial }
}

function hasCode(code) {
  return (error) => error instanceof Error && 'code' in error && error.code === code
}

async function withBundle(mutate, assertion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-github-tmpfs-test-'))
  try {
    await assertion(createBundle(root, mutate), root)
  } finally {
    try { fs.chmodSync(path.join(root, 'bundle-sensitive-marker'), 0o700) } catch {
      // The bundle may be intentionally malformed or absent in a failure case.
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function run() {
  const productionModule = require('../security/github-tmpfs-secret-provider')
  const providerSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'security', 'github-tmpfs-secret-provider.js'),
    'utf8'
  )
  assert.equal(providerSource.includes('fs.readFileSync'), false)
  assert.equal(providerSource.includes('fs.constants.O_DIRECTORY'), true)
  assert.equal(providerSource.includes("'/proc/self/fd/'"), true)
  assert.equal(
    JSON.stringify(Object.keys(productionModule).sort()) === JSON.stringify([
      'APPLICATION_GID',
      'APPLICATION_UID',
      'BUNDLE_DIRECTORY_MODE',
      'BUNDLE_FILE_MODE',
      'BUNDLE_GROUP_GID',
      'BUNDLE_OWNER_UID',
      'BUNDLE_PATH',
      'GithubTmpfsSecretProviderError',
      'loadGithubTmpfsSecrets'
    ]),
    true
  )
  const {
    APPLICATION_GID,
    APPLICATION_UID,
    BUNDLE_DIRECTORY_MODE,
    BUNDLE_FILE_MODE,
    BUNDLE_GROUP_GID,
    BUNDLE_OWNER_UID,
    BUNDLE_PATH,
    GithubTmpfsSecretProviderError,
    loadGithubTmpfsSecrets
  } = productionModule
  const productionLoader = loadGithubTmpfsSecrets
  const loadTestBundle = ({ references, bundlePath, expectedUid, expectedGid }) =>
    createGithubTmpfsSecretLoaderForTest({ bundlePath, expectedUid, expectedGid })({
      references
    })
  const testSource = fs.readFileSync(__filename, 'utf8')
  const unsafeSecretBufferAssertion = /assert\.deepEqual\(\s*(?:firstRead|secondRead|provider\.readSecret)[\s\S]{0,160}(?:adminMaterial|hmacMaterial)/
  assert.equal(unsafeSecretBufferAssertion.test(testSource), false)
  assert.equal(BUNDLE_PATH, '/run/secrets/kinvest')
  assert.equal(BUNDLE_OWNER_UID, 0)
  assert.equal(BUNDLE_GROUP_GID, 10001)
  assert.equal(BUNDLE_DIRECTORY_MODE, 0o550)
  assert.equal(BUNDLE_FILE_MODE, 0o440)
  assert.equal(APPLICATION_UID, 10001)
  assert.equal(APPLICATION_GID, 10001)
  assert.equal(typeof GithubTmpfsSecretProviderError, 'function')

  await withBundle(() => {}, async ({ bundlePath }) => {
    await assert.rejects(productionLoader({
      references: REFERENCES,
      bundlePath,
      expectedUid: process.getuid(),
      expectedGid: process.getgid()
    }), hasCode('GITHUB_TMPFS_CONFIG_INVALID'))
  })

  await withBundle(() => {}, async ({ bundlePath }) => {
    const originalBufferAlloc = Buffer.alloc
    const originalFstatSync = fs.fstatSync
    /** @type {Buffer | undefined} */
    let observedScratch
    let fstatCalls = 0
    Buffer.alloc = function alloc(...args) {
      const value = originalBufferAlloc.apply(Buffer, args)
      if (args[0] === 4097 && !observedScratch) observedScratch = value
      return value
    }
    fs.fstatSync = function fstatSync(...args) {
      const stat = originalFstatSync.apply(fs, args)
      fstatCalls += 1
      if (fstatCalls === 3) {
        Object.defineProperty(stat, 'nlink', { value: 2 })
      }
      return stat
    }
    try {
      await assert.rejects(loadTestBundle({
        references: REFERENCES,
        bundlePath,
        expectedUid: process.getuid(),
        expectedGid: process.getgid()
      }), hasCode('GITHUB_TMPFS_BUNDLE_INVALID'))
      assert.equal(Boolean(observedScratch), true)
      assert.equal(observedScratch.every((byte) => byte === 0), true)
    } finally {
      Buffer.alloc = originalBufferAlloc
      fs.fstatSync = originalFstatSync
    }
  })

  await withBundle(() => {}, async ({ bundlePath, adminMaterial, hmacMaterial }) => {
    const provider = await loadTestBundle({
      references: REFERENCES,
      bundlePath,
      expectedUid: process.getuid(),
      expectedGid: process.getgid()
    })
    assert.equal(Reflect.ownKeys(provider).length, 0)
    assert.equal(provider.entries === undefined && provider.cleared === undefined, true)
    const adminReference = REFERENCES[0]
    const firstRead = provider.readSecret(adminReference)
    const secondRead = provider.readSecret(adminReference)
    assert.notStrictEqual(firstRead, secondRead)
    assert.equal(firstRead.equals(adminMaterial), true)
    firstRead.fill(0)
    assert.equal(secondRead.equals(adminMaterial), true)
    assert.equal(provider.readSecret(REFERENCES[1]).equals(hmacMaterial), true)
    provider.clear()
    provider.clear()
    assert.throws(() => provider.readSecret(adminReference), hasCode('SECRET_NOT_FOUND'))
  })

  await withBundle(({ bundlePath, adminMaterial, hmacMaterial }) => {
    const manifest = JSON.parse(canonicalManifest(adminMaterial, hmacMaterial))
    manifest.adminPasswordVerifier.sha256 = '0'.repeat(64)
    fs.writeFileSync(path.join(bundlePath, MANIFEST_FILE), JSON.stringify(manifest))
  }, async ({ bundlePath, adminMaterial, hmacMaterial }) => {
    let failure
    try {
      await loadTestBundle({
        references: REFERENCES,
        bundlePath,
        expectedUid: process.getuid(),
        expectedGid: process.getgid()
      })
    } catch (error) {
      failure = error
    }
    assert.equal(
      failure instanceof Error &&
        'code' in failure &&
        failure.code === 'GITHUB_TMPFS_BUNDLE_INVALID',
      true
    )
    const serializedFailure = failure instanceof Error && 'code' in failure
      ? `${failure.name}:${failure.message}:${String(failure.code)}`
      : ''
    const sensitiveValues = [
      adminMaterial.toString('utf8'),
      hmacMaterial.toString('utf8'),
      sha256(adminMaterial),
      sha256(hmacMaterial)
    ]
    assert.equal(
      sensitiveValues.some((value) => serializedFailure.includes(value)),
      false
    )
  })

  const invalidMutations = [
    ({ bundlePath }) => fs.writeFileSync(path.join(bundlePath, 'extra'), 'extra'),
    ({ bundlePath }) => {
      fs.rmSync(path.join(bundlePath, HMAC_FILE))
      fs.symlinkSync(path.join(bundlePath, ADMIN_FILE), path.join(bundlePath, HMAC_FILE))
    },
    ({ bundlePath }) => fs.linkSync(
      path.join(bundlePath, ADMIN_FILE),
      path.join(path.dirname(bundlePath), 'hard-link-sensitive-marker')
    ),
    ({ bundlePath }) => {
      fs.rmSync(path.join(bundlePath, ADMIN_FILE))
      fs.mkdirSync(path.join(bundlePath, ADMIN_FILE))
    },
    ({ bundlePath, adminMaterial, hmacMaterial }) => fs.writeFileSync(
      path.join(bundlePath, MANIFEST_FILE),
      JSON.stringify(JSON.parse(canonicalManifest(adminMaterial, hmacMaterial)), null, 2)
    ),
    ({ bundlePath, adminMaterial, hmacMaterial }) => fs.writeFileSync(
      path.join(bundlePath, MANIFEST_FILE),
      canonicalManifest(adminMaterial, hmacMaterial, { extra: true })
    ),
    ({ bundlePath, adminMaterial, hmacMaterial }) => {
      const manifest = JSON.parse(canonicalManifest(adminMaterial, hmacMaterial))
      manifest.adminPasswordVerifier.versionId = 'v20260813-002'
      fs.writeFileSync(path.join(bundlePath, MANIFEST_FILE), JSON.stringify(manifest))
    },
    ({ bundlePath, adminMaterial, hmacMaterial }) => {
      const manifest = JSON.parse(canonicalManifest(adminMaterial, hmacMaterial))
      manifest.deviceTokenHmac.sha256 = '0'.repeat(64)
      fs.writeFileSync(path.join(bundlePath, MANIFEST_FILE), JSON.stringify(manifest))
    },
    ({ bundlePath, hmacMaterial }) => {
      const oversized = Buffer.alloc(4097, 65)
      fs.writeFileSync(path.join(bundlePath, ADMIN_FILE), oversized)
      fs.writeFileSync(
        path.join(bundlePath, MANIFEST_FILE),
        canonicalManifest(oversized, hmacMaterial)
      )
    }
  ]

  for (const mutate of invalidMutations) {
    await withBundle(mutate, async ({ bundlePath }) => {
      await assert.rejects(loadTestBundle({
        references: REFERENCES,
        bundlePath,
        expectedUid: process.getuid(),
        expectedGid: process.getgid()
      }), (error) => {
        if (!(error instanceof Error) || !('code' in error)) return false
        assert.equal(error.code, 'GITHUB_TMPFS_BUNDLE_INVALID')
        const serialized = `${error.name}:${error.message}:${String(error.code)}`
        assert.equal(serialized.includes(bundlePath), false)
        assert.equal(serialized.includes(VERSION), false)
        assert.equal(serialized.includes('sensitive-marker'), false)
        return true
      })
    })
  }

  await withBundle(() => {}, async ({ bundlePath }) => {
    fs.chmodSync(bundlePath, 0o700)
    await assert.rejects(loadTestBundle({
      references: REFERENCES,
      bundlePath,
      expectedUid: process.getuid(),
      expectedGid: process.getgid()
    }), hasCode('GITHUB_TMPFS_BUNDLE_INVALID'))
  })

  await withBundle(() => {}, async ({ bundlePath }) => {
    fs.chmodSync(path.join(bundlePath, ADMIN_FILE), 0o600)
    await assert.rejects(loadTestBundle({
      references: REFERENCES,
      bundlePath,
      expectedUid: process.getuid(),
      expectedGid: process.getgid()
    }), hasCode('GITHUB_TMPFS_BUNDLE_INVALID'))
  })

  await withBundle(() => {}, async ({ bundlePath }) => {
    await assert.rejects(loadTestBundle({
      references: REFERENCES,
      bundlePath,
      expectedUid: process.getuid() + 1,
      expectedGid: process.getgid()
    }), hasCode('GITHUB_TMPFS_BUNDLE_INVALID'))
    await assert.rejects(loadTestBundle({
      references: [
        REFERENCES[0],
        { secretName: DEVICE_HMAC_SECRET_NAME, versionId: 'v20260813-002' }
      ],
      bundlePath,
      expectedUid: process.getuid(),
      expectedGid: process.getgid()
    }), hasCode('GITHUB_TMPFS_BUNDLE_INVALID'))
  })
}

module.exports = { run }
