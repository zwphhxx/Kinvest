/* global module, require */

const FINANCE_MODE_KEYS = Object.freeze({
  annual: 'annual',
  quarter: 'quarterly'
})

const VERIFIED_REAL_SOURCE_TYPES = Object.freeze([
  'ifind_indicator',
  'ifind_topic_report',
  'official_announcement'
])

function getDataSourceContracts() {
  if (typeof module !== 'undefined' && module.exports) {
    return require('./data-source-contract')
  }
  return /** @type {any} */ (window).KinvestDataSource
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isValidTimestamp(value) {
  if (value instanceof Date) return !Number.isNaN(value.getTime())
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value))
}

function hasNumericValues(values) {
  return values !== null &&
    typeof values === 'object' &&
    Object.values(values).some((value) => typeof value === 'number' && Number.isFinite(value))
}

function getFinanceRowsForMode(financials, mode) {
  const key = FINANCE_MODE_KEYS[mode]
  if (!key || !financials || typeof financials !== 'object') return []
  return Array.isArray(financials[key]) ? financials[key] : []
}

function isVerifiedFinanceRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false
  const source = row.source
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false
  const dataSourceContracts = getDataSourceContracts()
  if (!dataSourceContracts || typeof dataSourceContracts.isVerifiedDataBlock !== 'function') return false

  return dataSourceContracts.isVerifiedDataBlock(row, VERIFIED_REAL_SOURCE_TYPES) &&
    isNonEmptyString(source.sourceName) &&
    isValidTimestamp(source.sourceTime) &&
    isValidTimestamp(source.fetchTime) &&
    isNonEmptyString(row.period) &&
    isValidTimestamp(row.reportDate) &&
    isNonEmptyString(row.currency) &&
    isNonEmptyString(row.unit) &&
    hasNumericValues(row.values)
}

function prepareFinanceRows(financials, mode) {
  const selectedRows = getFinanceRowsForMode(financials, mode)
  const declaredModes = new Set(
    selectedRows
      .map((row) => row && row.dataMode)
      .filter((dataMode) => dataMode === 'mock' || dataMode === 'real')
  )
  if (declaredModes.size > 1) {
    return {
      rows: [],
      totalCount: selectedRows.length,
      rejectedCount: selectedRows.length,
      sourceMode: null,
      errorCode: 'MIXED_SOURCE_MODE'
    }
  }

  const rows = selectedRows.filter(isVerifiedFinanceRow)
  return {
    rows,
    totalCount: selectedRows.length,
    rejectedCount: selectedRows.length - rows.length,
    sourceMode: rows.length > 0 ? rows[0].dataMode : null,
    errorCode: null
  }
}

const financeContractApi = {
  FINANCE_MODE_KEYS,
  VERIFIED_REAL_SOURCE_TYPES,
  getFinanceRowsForMode,
  isVerifiedFinanceRow,
  prepareFinanceRows
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = financeContractApi
}

if (typeof window !== 'undefined') {
  /** @type {any} */ (window).KinvestFinance = financeContractApi
}
