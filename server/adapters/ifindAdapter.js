const { getCompany: getMockCompany, listCompanies } = require('../data/mockData')

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
      const all = listCompanies()
      return Promise.resolve(all.filter((item) => {
        return item.nameZh.toLowerCase().includes(query)
          || item.securityCode.toLowerCase().includes(query)
          || (item.symbol || '').toLowerCase().includes(query)
      }))
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
