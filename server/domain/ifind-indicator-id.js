'use strict'

// Supported diagnostic indicator IDs, not security codes or a claim about all
// provider identifiers. Keep the existing SQLite limit and preserve case.
/** @param {unknown} value @returns {value is string} */
function isIfindIndicatorId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 80 &&
    !/[^A-Za-z0-9_]/.test(value)
}

module.exports = { isIfindIndicatorId }
