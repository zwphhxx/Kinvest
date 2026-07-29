/* global module */

(function initValuationPosition(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) {
    module.exports = api
  }
  if (root) {
    (/** @type {any} */ (root)).KinvestValuation = api
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createValuationPosition() {
  const markerPositions = Object.freeze(
    Array.from({ length: 21 }, (_, index) => index * 5)
  )

  function prepareValuationPosition(quote) {
    const lastPrice = quote?.lastPrice
    const low3Y = quote?.low3Y
    const high3Y = quote?.high3Y
    const hasValidInputs = [lastPrice, low3Y, high3Y].every(Number.isFinite)

    if (!hasValidInputs || high3Y <= low3Y) {
      return {
        available: false,
        ratio: null,
        markerPosition: null
      }
    }

    const rawRatio = Math.round(((lastPrice - low3Y) / (high3Y - low3Y)) * 100)
    const ratio = Math.max(0, Math.min(100, rawRatio))
    const markerPosition = Math.round(ratio / 5) * 5

    return {
      available: true,
      ratio,
      markerPosition
    }
  }

  return {
    markerPositions,
    prepareValuationPosition
  }
})
