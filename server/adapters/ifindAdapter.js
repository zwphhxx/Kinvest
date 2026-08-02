const { getCompany: getMockCompany, listCompanies } = require('../data/mockData')
const {
  resolveSecurityIdentity,
  searchSecurityIdentities
} = require('../domain/security-identity')

const SUPPORTED_FIXTURE_METRICS = new Set([
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
      const contractVerified = SUPPORTED_FIXTURE_METRICS.has(metricId)
      return Promise.resolve({
        metricId,
        dataMode: 'mock',
        contractStatus: contractVerified ? 'verified_fixture' : 'unsupported',
        source: {
          sourceMode: 'mock',
          sourceName: 'Mock fixture（模拟 iFinD 指标结构，非真实返回）',
          sourceType: 'mock_fixture',
          mockContractVerified: contractVerified,
          verification: {
            issuerIdentityStatus: 'not_applicable',
            vendorCodeStatus: 'not_applicable',
            entitlementStatus: 'not_applicable',
            currencyStatus: 'not_applicable',
            unitStatus: 'not_applicable',
            reportPeriodStatus: 'not_applicable',
            scopeStatus: 'not_applicable'
          }
        },
        value: null
      })
    }
  }
}

function getFixtureContractMetrics() {
  return Array.from(SUPPORTED_FIXTURE_METRICS)
}

module.exports = {
  createIfindClient,
  getFixtureContractMetrics
}
