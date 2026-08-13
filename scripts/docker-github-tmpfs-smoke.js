const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  parseSecretVersionConfig,
  validateLoadedSecretMaterial
} = require('../server/security/secret-bootstrap-contract')
const {
  BUNDLE_DIRECTORY_MODE,
  BUNDLE_FILE_MODE,
  BUNDLE_GROUP_GID,
  BUNDLE_OWNER_UID,
  BUNDLE_PATH,
  loadGithubTmpfsSecrets
} = require('../server/security/github-tmpfs-secret-provider')

const VERSION_ID = 'v20000101-001'
const SUCCESS_MARKER = '/tmp/kinvest-github-tmpfs-smoke-ok'
const BUNDLE_PARENT_PATH = path.dirname(BUNDLE_PATH)
const BUNDLE_PARENT_MODE = 0o711

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function preparePublicFixture() {
  const adminMaterial = Buffer.from(JSON.stringify({
    digest: Buffer.alloc(32, 1).toString('base64url'),
    format: 'kinvest-admin-scrypt-v1',
    n: 65536,
    p: 1,
    r: 8,
    salt: Buffer.alloc(16, 2).toString('base64url')
  }))
  const hmacMaterial = Buffer.from(Buffer.alloc(32, 3).toString('base64url'))
  const manifest = Buffer.from(JSON.stringify({
    format: 'kinvest-github-tmpfs-v1',
    adminPasswordVerifier: {
      file: 'admin-password-verifier',
      versionId: VERSION_ID,
      sha256: sha256(adminMaterial)
    },
    deviceTokenHmac: {
      file: 'device-token-hmac-key',
      versionId: VERSION_ID,
      sha256: sha256(hmacMaterial)
    }
  }))
  const files = new Map([
    ['manifest.json', manifest],
    ['admin-password-verifier', adminMaterial],
    ['device-token-hmac-key', hmacMaterial]
  ])
  try {
    fs.mkdirSync(BUNDLE_PARENT_PATH, { recursive: true, mode: BUNDLE_PARENT_MODE })
    fs.chownSync(BUNDLE_PARENT_PATH, 0, 0)
    fs.chmodSync(BUNDLE_PARENT_PATH, BUNDLE_PARENT_MODE)
    fs.mkdirSync(BUNDLE_PATH, { mode: BUNDLE_DIRECTORY_MODE })
    for (const [name, value] of files) {
      const filePath = path.join(BUNDLE_PATH, name)
      fs.writeFileSync(filePath, value, { mode: BUNDLE_FILE_MODE })
      fs.chownSync(filePath, BUNDLE_OWNER_UID, BUNDLE_GROUP_GID)
      fs.chmodSync(filePath, BUNDLE_FILE_MODE)
    }
    fs.chownSync(BUNDLE_PATH, BUNDLE_OWNER_UID, BUNDLE_GROUP_GID)
    fs.chmodSync(BUNDLE_PATH, BUNDLE_DIRECTORY_MODE)
  } finally {
    for (const value of files.values()) value.fill(0)
  }
}

async function verifyPublicFixture() {
  const rawConfig = JSON.stringify({
    adminPasswordVerifier: VERSION_ID,
    deviceTokenHmac: {
      accepted: [VERSION_ID],
      active: VERSION_ID
    }
  })
  const config = parseSecretVersionConfig(rawConfig)
  let provider
  try {
    provider = await loadGithubTmpfsSecrets({ references: config.references })
    const status = await validateLoadedSecretMaterial(provider, config)
    if (status.referenceCount !== 2) throw new Error('SMOKE_FAILED')
    fs.writeFileSync(SUCCESS_MARKER, 'ok\n', { mode: 0o444 })
    process.stdout.write('KINVEST_GITHUB_TMPFS_SMOKE_OK\n')
  } finally {
    if (provider) provider.clear()
  }
}

async function main() {
  const mode = process.argv[2]
  if (process.argv.length !== 3 || (mode !== 'prepare' && mode !== 'verify')) {
    throw new Error('SMOKE_USAGE_INVALID')
  }
  if (mode === 'prepare') preparePublicFixture()
  else await verifyPublicFixture()
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('KINVEST_GITHUB_TMPFS_SMOKE_FAILED\n')
    process.exitCode = 1
  })
}
