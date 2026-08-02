/* global module */

const SOURCE_MODES = Object.freeze(['mock', 'real'])
const VALIDATION_STATUSES = Object.freeze([
  'unverified',
  'verified',
  'failed',
  'not_applicable'
])
const IFIND_VERIFICATION_FIELDS = Object.freeze([
  'issuerIdentityStatus',
  'vendorCodeStatus',
  'entitlementStatus',
  'currencyStatus',
  'unitStatus',
  'reportPeriodStatus',
  'scopeStatus'
])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasCompleteVerificationState(verification, expectedStatus) {
  if (!isRecord(verification) || !VALIDATION_STATUSES.includes(expectedStatus)) return false
  if (Object.keys(verification).some((key) => !IFIND_VERIFICATION_FIELDS.includes(key))) return false
  return IFIND_VERIFICATION_FIELDS.every((field) => verification[field] === expectedStatus)
}

function containsSourceModeConflict(value, expectedMode, visited = new Set()) {
  if (value === null || typeof value !== 'object') return false
  if (visited.has(value)) return false
  visited.add(value)

  if (Object.hasOwn(value, 'sourceMode') && value.sourceMode !== expectedMode) return true
  if (Object.hasOwn(value, 'dataMode') && value.dataMode !== expectedMode) return true

  return Object.values(value).some((item) => containsSourceModeConflict(item, expectedMode, visited))
}

function isPureSourceBlock(block) {
  if (!isRecord(block) || !SOURCE_MODES.includes(block.dataMode)) return false
  if (!isRecord(block.source) || block.source.sourceMode !== block.dataMode) return false
  return !containsSourceModeConflict(block.values, block.dataMode) &&
    !containsSourceModeConflict(block.rows, block.dataMode)
}

/**
 * @param {any} block
 * @param {readonly string[]} [allowedRealSourceTypes]
 */
function isVerifiedDataBlock(block, allowedRealSourceTypes = []) {
  if (!isPureSourceBlock(block)) return false

  const source = block.source
  if (block.dataMode === 'mock') {
    return source.sourceType === 'mock_fixture' &&
      source.mockContractVerified === true &&
      source.scopeVerified !== true &&
      hasCompleteVerificationState(source.verification, 'not_applicable') &&
      typeof source.sourceName === 'string' &&
      /mock/i.test(source.sourceName) &&
      source.sourceName.includes('非真实')
  }

  return allowedRealSourceTypes.includes(source.sourceType) &&
    source.mockContractVerified !== true &&
    source.scopeVerified === undefined &&
    hasCompleteVerificationState(source.verification, 'verified')
}

function createMockVerificationState() {
  return Object.fromEntries(IFIND_VERIFICATION_FIELDS.map((field) => [field, 'not_applicable']))
}

const dataSourceContractApi = {
  SOURCE_MODES,
  VALIDATION_STATUSES,
  IFIND_VERIFICATION_FIELDS,
  containsSourceModeConflict,
  createMockVerificationState,
  hasCompleteVerificationState,
  isPureSourceBlock,
  isVerifiedDataBlock
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = dataSourceContractApi
}

if (typeof window !== 'undefined') {
  /** @type {any} */ (window).KinvestDataSource = dataSourceContractApi
}
