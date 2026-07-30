const SECURITY_IDENTITY_CONFLICT = 'SECURITY_IDENTITY_CONFLICT'

function createVendorCode(code = null, status = 'unverified') {
  return Object.freeze({ code, status })
}

function createIdentity(fields) {
  return Object.freeze({
    ...fields,
    formatAliases: Object.freeze(fields.formatAliases.slice()),
    vendorCodes: Object.freeze({
      ifind: createVendorCode(),
      isin: createVendorCode()
    })
  })
}

const SECURITY_IDENTITIES = Object.freeze([
  createIdentity({
    companyId: 'company-alibaba-group',
    listingId: 'listing-hkex-9988',
    issuerLegalName: 'Alibaba Group Holding Limited',
    nameZh: '阿里巴巴集团',
    exchange: 'HKEX',
    exchangeCode: '9988',
    displayCode: '9988.HK',
    formatAliases: ['09988.HK'],
    configured: true
  }),
  createIdentity({
    companyId: 'company-baidu',
    listingId: 'listing-hkex-9888',
    issuerLegalName: 'Baidu, Inc.',
    nameZh: '百度集团股份有限公司',
    exchange: 'HKEX',
    exchangeCode: '9888',
    displayCode: '9888.HK',
    formatAliases: ['09888.HK'],
    configured: false
  })
])

const ISSUER_ALIASES = Object.freeze({
  'company-alibaba-group': Object.freeze([
    'Alibaba Group Holding Limited',
    '阿里巴巴集团',
    '阿里巴巴'
  ]),
  'company-baidu': Object.freeze([
    'Baidu, Inc.',
    '百度集团股份有限公司',
    '百度'
  ])
})

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase()
}

function normalizeText(value) {
  return String(value || '').trim().toLocaleLowerCase()
}

function normalizeIssuerName(value) {
  return normalizeText(value).replace(/[\s,.-]+/g, '')
}

function listSecurityIdentities() {
  return Object.freeze(SECURITY_IDENTITIES.slice())
}

function resolveSecurityIdentity(code) {
  const normalizedCode = normalizeCode(code)
  if (!normalizedCode) return null

  return SECURITY_IDENTITIES.find((identity) => {
    return identity.exchangeCode === normalizedCode
      || identity.displayCode === normalizedCode
      || identity.formatAliases.includes(normalizedCode)
  }) || null
}

function searchSecurityIdentities(query) {
  const normalizedQuery = normalizeText(query)
  if (!normalizedQuery) return Object.freeze([])

  return Object.freeze(SECURITY_IDENTITIES.filter((identity) => {
    const searchableValues = [
      identity.companyId,
      identity.listingId,
      identity.issuerLegalName,
      identity.nameZh,
      identity.exchange,
      identity.exchangeCode,
      identity.displayCode,
      ...identity.formatAliases
    ]
    return searchableValues.some((value) => normalizeText(value).includes(normalizedQuery))
  }))
}

function resolveIssuerIdentity(issuerName) {
  const normalizedIssuerName = normalizeIssuerName(issuerName)
  if (!normalizedIssuerName) return null

  return SECURITY_IDENTITIES.find((identity) => {
    return ISSUER_ALIASES[identity.companyId].some((alias) => {
      const normalizedAlias = normalizeIssuerName(alias)
      return normalizedIssuerName === normalizedAlias
        || normalizedIssuerName.includes(normalizedAlias)
        || normalizedAlias.includes(normalizedIssuerName)
    })
  }) || null
}

function detectSecurityIdentityConflict(record) {
  if (!record || typeof record !== 'object') return null

  const requestedCode = record.securityCode
    || record.code
    || record.displayCode
    || record.exchangeCode
  const issuerName = record.issuerLegalName
    || record.issuerName
    || record.companyName
    || record.nameZh
  const codeIdentity = resolveSecurityIdentity(requestedCode)
  const issuerIdentity = resolveIssuerIdentity(issuerName)

  if (!codeIdentity || !issuerIdentity || codeIdentity.companyId === issuerIdentity.companyId) {
    return null
  }

  return Object.freeze({
    errorCode: SECURITY_IDENTITY_CONFLICT,
    requestedCode: String(requestedCode),
    codeIdentity,
    issuerIdentity
  })
}

module.exports = {
  SECURITY_IDENTITY_CONFLICT,
  detectSecurityIdentityConflict,
  listSecurityIdentities,
  resolveSecurityIdentity,
  searchSecurityIdentities
}
