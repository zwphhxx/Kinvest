const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { DeviceAuthRepository } = require('../db/device-auth-repository')

const DEFAULT_DATABASE_PATH = path.join(__dirname, '../data/kinvest.sqlite')

class DeviceRevokeError extends Error {
  constructor(code) {
    const messages = {
      DEVICE_REVOKE_FAILED: 'Device revocation failed',
      DEVICE_REVOKE_ROOT_REQUIRED: 'Root privileges are required'
    }
    super(messages[code] || messages.DEVICE_REVOKE_FAILED)
    this.name = 'DeviceRevokeError'
    this.code = code
  }
}

function run({
  databasePath,
  now = Date.now,
  getuid = process.getuid,
  stdout = process.stdout
} = {}) {
  if (typeof getuid === 'function' && getuid() !== 0) {
    throw new DeviceRevokeError('DEVICE_REVOKE_ROOT_REQUIRED')
  }

  let database
  try {
    if (typeof databasePath !== 'string' || databasePath.length === 0 ||
      typeof now !== 'function' || !stdout || typeof stdout.write !== 'function') {
      throw new DeviceRevokeError('DEVICE_REVOKE_FAILED')
    }
    database = new DatabaseSync(databasePath)
    const repository = new DeviceAuthRepository(database)
    repository.initialize()
    const revokedAt = now()
    if (!Number.isSafeInteger(revokedAt)) {
      throw new DeviceRevokeError('DEVICE_REVOKE_FAILED')
    }
    const count = repository.runInImmediateTransaction(() => {
      const revoked = repository.revokeAllCredentials(revokedAt)
      repository.addAuditEvent(
        'device_credentials_revoked_all',
        revokedAt,
        null,
        { count: revoked }
      )
      return revoked
    })
    stdout.write(`KINVEST_DEVICE_REVOKE_ALL_OK credentials=${count}\n`)
    return count
  } catch (error) {
    if (error instanceof DeviceRevokeError) throw error
    throw new DeviceRevokeError('DEVICE_REVOKE_FAILED')
  } finally {
    if (database) database.close()
  }
}

if (require.main === module) {
  try {
    run({
      databasePath: process.env.KINVEST_DB_PATH || DEFAULT_DATABASE_PATH
    })
  } catch (error) {
    const code = error instanceof DeviceRevokeError
      ? error.code
      : 'DEVICE_REVOKE_FAILED'
    process.stderr.write(`${code}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  DeviceRevokeError,
  run
}
