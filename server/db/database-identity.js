const KINVEST_SQLITE_APPLICATION_ID = 0x4B494E56

const TABLE_INFO_QUERIES = Object.freeze({
  deviceAuthRequests: 'PRAGMA table_info(device_auth_requests)',
  deviceCredentials: 'PRAGMA table_info(device_credentials)',
  deviceAuthAudit: 'PRAGMA table_info(device_auth_audit)'
})

const LEGACY_CORE_COLUMNS = Object.freeze({
  deviceAuthRequests: Object.freeze([
    'request_id',
    'request_code_digest',
    'browser_credential_digest',
    'created_at',
    'expires_at',
    'failed_attempts',
    'approved_at',
    'consumed_at',
    'locked_at'
  ]),
  deviceCredentials: Object.freeze([
    'credential_id',
    'device_id',
    'token_digest',
    'hmac_version_id',
    'approved_at',
    'rotated_at',
    'last_used_at',
    'idle_expires_at',
    'absolute_expires_at',
    'revoked_at',
    'replacement_credential_id',
    'replacement_grace_expires_at'
  ]),
  deviceAuthAudit: Object.freeze([
    'event_id',
    'event_type',
    'occurred_at',
    'subject_id',
    'metadata_json'
  ])
})

class DeviceAuthDatabaseIdentityError extends Error {
  constructor() {
    super('The device authentication database identity is invalid')
    this.name = 'DeviceAuthDatabaseIdentityError'
    this.code = 'DEVICE_AUTH_DATABASE_IDENTITY_INVALID'
  }
}

function readApplicationId(database) {
  const row = database.prepare('PRAGMA application_id').get()
  return Number(row.application_id)
}

function readFixedTableColumns(database, tableKey) {
  const query = TABLE_INFO_QUERIES[tableKey]
  if (!query) return Object.freeze([])
  return Object.freeze(database.prepare(query).all().map((column) =>
    String(column.name)))
}

function hasStrictLegacyDeviceSchema(database) {
  for (const tableKey of Object.keys(LEGACY_CORE_COLUMNS)) {
    const columns = new Set(readFixedTableColumns(database, tableKey))
    if (LEGACY_CORE_COLUMNS[tableKey].some((column) => !columns.has(column))) {
      return false
    }
  }
  return true
}

function setKinvestApplicationId(database) {
  database.exec('PRAGMA application_id = 1263095382')
}

module.exports = {
  DeviceAuthDatabaseIdentityError,
  KINVEST_SQLITE_APPLICATION_ID,
  hasStrictLegacyDeviceSchema,
  readApplicationId,
  readFixedTableColumns,
  setKinvestApplicationId
}
