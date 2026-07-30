const { getCompany: getMockCompany, listCompanies } = require('../data/mockData')
const {
  resolveSecurityIdentity,
  searchSecurityIdentities
} = require('../domain/security-identity')

const VERIFIED_METRICS = new Set([
  'realtime',
  'history',
  'company',
  'series',
  'data-pool',
  'announcements'
])

function createIfindClient() {
  return {
    getCompany(code) {
      return Promise.resolve(getMockCompany(code))
    },
    searchCompanies(q) {
      const query = String(q || '').toLowerCase()
      const results = new Map()

      for (const identity of searchSecurityIdentities(query)) {
        results.set(identity.listingId, {
          ...identity,
          securityCode: identity.displayCode,
          market: identity.exchange === 'HKEX' ? 'HK' : identity.exchange,
          symbol: identity.exchangeCode,
          industry: identity.configured ? '' : '未收录'
        })
      }

      for (const item of listCompanies()) {
        const identity = resolveSecurityIdentity(item.securityCode)
        const searchableValues = [
          item.securityCode,
          item.displayCode,
          item.exchangeCode,
          item.nameZh,
          item.symbol,
          ...(item.formatAliases || [])
        ]
        if (!searchableValues.some((value) => String(value || '').toLowerCase().includes(query))) {
          continue
        }

        const result = identity
          ? {
              ...item,
              ...identity,
              securityCode: identity.displayCode
            }
          : item
        results.set(result.listingId || result.securityCode, result)
      }

      return Promise.resolve(Array.from(results.values()))
    },
    getFinancial(metricId) {
      return Promise.resolve({
        metricId,
        verified: VERIFIED_METRICS.has(metricId),
        source: VERIFIED_METRICS.has(metricId) ? 'iFinD mock fixture' : 'unverified',
        value: null
      })
    }
  }
}

function getVerifiedMetrics() {
  return Array.from(VERIFIED_METRICS)
}

module.exports = {
  createIfindClient,
  getVerifiedMetrics
}
