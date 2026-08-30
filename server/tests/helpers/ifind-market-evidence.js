'use strict'

// Synthetic evidence only. Never imported by a production catalog or transport.
const { getIfindMarketCase } = require('../../domain/ifind-market-cases')
const {
  createVerifiedMarketEvidenceBundle
} = require('../../domain/ifind-market-manifest-validator')

const QUOTE_SUFFIXES = Object.freeze({
  latestPrice: 'LATEST_PRICE', previousClose: 'PREVIOUS_CLOSE', open: 'OPEN',
  high: 'HIGH', low: 'LOW', volume: 'VOLUME', turnover: 'TURNOVER',
  quoteTime: 'QUOTE_TIME', tradingStatus: 'TRADING_STATUS', currency: 'CURRENCY'
})
const FINANCIAL_SUFFIXES = Object.freeze({
  revenue: 'REVENUE', grossProfit: 'GROSS_PROFIT', attributableNetProfit: 'NET_PROFIT',
  operatingCashFlow: 'OPERATING_CASH_FLOW', receivables: 'RECEIVABLES',
  inventory: 'INVENTORY', interestBearingDebt: 'INTEREST_BEARING_DEBT'
})
const METADATA_SUFFIXES = Object.freeze({
  currency: 'CURRENCY', unit: 'UNIT', reportPeriod: 'REPORT_PERIOD',
  reportDate: 'REPORT_DATE', periodType: 'PERIOD_TYPE',
  disclosureScope: 'DISCLOSURE_SCOPE', sourceTime: 'SOURCE_TIME',
  fetchTime: 'FETCH_TIME', sourceMode: 'SOURCE_MODE'
})

function fixtureEvidence(caseId) {
  const catalog = getIfindMarketCase(caseId)
  const verification = () => ({
    issuerIdentityStatus: 'verified', vendorCodeStatus: 'verified',
    entitlementStatus: 'verified', currencyStatus: 'verified', unitStatus: 'verified',
    reportPeriodStatus: 'verified', scopeStatus: 'verified', sourceMode: 'real'
  })
  return {
    quoteVerification: verification(),
    financialVerification: verification(),
    financialReportingCurrencyEvidence: {
      caseId, listingId: catalog.listingId,
      currency: caseId.startsWith('US_') ? 'USD' : 'CNY',
      evidenceStatus: 'verified', sourceIdentity: 'kinvest-synthetic-evidence',
      sourceReference: 'fixture://ifind/' + caseId,
      verifiedAt: '2025-11-20T08:00:00.000Z'
    }
  }
}

function fixtureCatalog(caseId, prefix = 'TEST_ONLY_') {
  const catalog = JSON.parse(JSON.stringify(getIfindMarketCase(caseId)))
  const id = (suffix) => prefix + caseId.slice(0, 2) + '_' + suffix
  const indicators = (suffixes) => Object.entries(suffixes).map(([metric, suffix]) => ({
    metric, vendorIndicatorId: id(suffix), evidenceStatus: 'verified'
  }))
  catalog.vendorCodes.ifind = { code: id('CODE'), evidenceStatus: 'verified' }
  catalog.indicators.quote = indicators(QUOTE_SUFFIXES)
  catalog.indicators.financial = indicators(FINANCIAL_SUFFIXES)
  catalog.indicators.financialMetadata = Object.fromEntries(
    Object.entries(METADATA_SUFFIXES).map(([field, suffix]) => [field, {
      vendorIndicatorId: id(suffix), evidenceStatus: 'verified',
      sourceReference: 'fixture://ifind/metadata/' + field
    }])
  )
  catalog.requestTemplates.quote.fields = catalog.indicators.quote.map((entry) => entry.vendorIndicatorId)
  catalog.requestTemplates.quote.evidenceStatus = 'verified'
  catalog.requestTemplates.financial.indicatorIds = [
    ...catalog.indicators.financial.map((entry) => entry.vendorIndicatorId),
    ...Object.values(catalog.indicators.financialMetadata).map((entry) => entry.vendorIndicatorId)
  ]
  catalog.requestTemplates.financial.evidenceStatus = 'verified'
  catalog.periodRules = {
    fullFiscalYears: 2, includeLatestDisclosedInterim: true, evidenceStatus: 'verified',
    vendorParameters: {
      fullFiscalYears: { count: 2, requestParameters: { count: 2, periodType: 'annual' } },
      latestDisclosedInterim: { enabled: true, requestParameters: { latest: true, periodType: 'interim' } }
    }
  }
  catalog.liveReady = true
  return catalog
}

function fixtureBundle(caseId) {
  return createVerifiedMarketEvidenceBundle(fixtureCatalog(caseId), fixtureEvidence(caseId))
}

module.exports = { fixtureBundle, fixtureCatalog, fixtureEvidence }
