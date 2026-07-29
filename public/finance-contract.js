/* global module */

const FINANCE_MODE_KEYS = Object.freeze({
  annual: 'annual',
  quarter: 'quarterly'
})

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

  return isNonEmptyString(source.sourceName) &&
    isNonEmptyString(source.sourceType) &&
    source.scopeVerified === true &&
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
  const rows = selectedRows.filter(isVerifiedFinanceRow)
  return {
    rows,
    totalCount: selectedRows.length,
    rejectedCount: selectedRows.length - rows.length
  }
}

const financeContractApi = {
  FINANCE_MODE_KEYS,
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
