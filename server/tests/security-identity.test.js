const assert = require('node:assert/strict')

function captureJsonResponse() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(payload) {
      this.body = JSON.parse(payload)
    }
  }
}

async function invokeApi(handler, code) {
  const response = captureJsonResponse()
  await handler({}, response, code)
  return response
}

function assertAlibabaIdentity(identity) {
  assert.equal(identity.companyId, 'company-alibaba-group')
  assert.equal(identity.listingId, 'listing-hkex-9988')
  assert.equal(identity.issuerLegalName, 'Alibaba Group Holding Limited')
  assert.equal(identity.nameZh, '阿里巴巴集团')
  assert.equal(identity.exchange, 'HKEX')
  assert.equal(identity.exchangeCode, '9988')
  assert.equal(identity.displayCode, '9988.HK')
  assert.deepEqual(identity.formatAliases, ['09988.HK'])
  assert.deepEqual(identity.vendorCodes.ifind, {
    code: null,
    status: 'unverified'
  })
  assert.deepEqual(identity.vendorCodes.isin, {
    code: null,
    status: 'unverified'
  })
  assert.equal(identity.configured, true)
}

function assertBaiduIdentity(identity) {
  assert.equal(identity.companyId, 'company-baidu')
  assert.equal(identity.listingId, 'listing-hkex-9888')
  assert.equal(identity.issuerLegalName, 'Baidu, Inc.')
  assert.equal(identity.nameZh, '百度集团股份有限公司')
  assert.equal(identity.exchange, 'HKEX')
  assert.equal(identity.exchangeCode, '9888')
  assert.equal(identity.displayCode, '9888.HK')
  assert.deepEqual(identity.formatAliases, ['09888.HK'])
  assert.equal(identity.configured, false)
}

async function run() {
  const {
    detectSecurityIdentityConflict,
    listSecurityIdentities,
    resolveSecurityIdentity,
    searchSecurityIdentities
  } = require('../domain/security-identity')
  const { createIfindClient } = require('../adapters/ifindAdapter')
  const { getCompany } = require('../data/mockData')
  const {
    apiCompany,
    apiRefresh,
    apiResearch
  } = require('../server')

  const identities = listSecurityIdentities()
  assert.equal(Object.isFrozen(identities), true)
  assert.equal(identities.length, 2)
  assert.throws(
    () => Reflect.apply(Array.prototype.push, identities, [{}]),
    TypeError
  )

  const alibaba = resolveSecurityIdentity('9988.HK')
  assertAlibabaIdentity(alibaba)
  assert.equal(Object.isFrozen(alibaba), true)
  assert.strictEqual(resolveSecurityIdentity('9988'), alibaba)
  assert.strictEqual(resolveSecurityIdentity('09988.HK'), alibaba)

  const baidu = resolveSecurityIdentity('9888.HK')
  assertBaiduIdentity(baidu)
  assert.strictEqual(resolveSecurityIdentity('9888'), baidu)
  assert.strictEqual(resolveSecurityIdentity('09888.HK'), baidu)
  assert.notStrictEqual(resolveSecurityIdentity('09888.HK'), alibaba)
  assert.equal(resolveSecurityIdentity('unknown.hk'), null)

  assert.deepEqual(searchSecurityIdentities('09988.HK'), [alibaba])
  assert.deepEqual(searchSecurityIdentities('9988'), [alibaba])
  assert.deepEqual(searchSecurityIdentities('阿里巴巴'), [alibaba])
  assert.deepEqual(searchSecurityIdentities('09888.HK'), [baidu])
  assert.deepEqual(searchSecurityIdentities('百度'), [baidu])

  const historicalConflict = detectSecurityIdentityConflict({
    securityCode: '09888.HK',
    issuerLegalName: 'Alibaba Group Holding Limited'
  })
  assert.equal(historicalConflict.errorCode, 'SECURITY_IDENTITY_CONFLICT')
  assert.equal(historicalConflict.requestedCode, '09888.HK')
  assert.equal(historicalConflict.codeIdentity.companyId, 'company-baidu')
  assert.equal(historicalConflict.issuerIdentity.companyId, 'company-alibaba-group')
  assert.equal(detectSecurityIdentityConflict({
    securityCode: '09888.HK',
    issuerLegalName: 'Baidu, Inc.'
  }), null)
  assert.equal(detectSecurityIdentityConflict({
    securityCode: 'UNKNOWN.HK',
    issuerLegalName: 'Alibaba Group Holding Limited'
  }), null)

  const canonicalCompany = getCompany('9988.HK')
  assert.ok(canonicalCompany)
  assert.equal(canonicalCompany.companyId, 'company-alibaba-group')
  assert.equal(canonicalCompany.listingId, 'listing-hkex-9988')
  assert.equal(canonicalCompany.securityCode, '9988.HK')
  assert.equal(canonicalCompany.isin, null)
  assert.strictEqual(getCompany('09988.HK'), canonicalCompany)
  assert.equal(getCompany('09888.HK'), null)

  const client = createIfindClient()
  const aliasSearch = await client.searchCompanies('09988.HK')
  assert.equal(aliasSearch.length, 1)
  assert.equal(aliasSearch[0].securityCode, '9988.HK')
  assert.equal(aliasSearch[0].configured, true)
  assert.deepEqual(aliasSearch[0].formatAliases, ['09988.HK'])
  assert.deepEqual(aliasSearch[0].vendorCodes.ifind, {
    code: null,
    status: 'unverified'
  })

  const baiduSearch = await client.searchCompanies('09888.HK')
  assert.equal(baiduSearch.length, 1)
  assert.equal(baiduSearch[0].companyId, 'company-baidu')
  assert.equal(baiduSearch[0].securityCode, '9888.HK')
  assert.equal(baiduSearch[0].issuerLegalName, 'Baidu, Inc.')
  assert.equal(baiduSearch[0].configured, false)
  assert.deepEqual(await client.searchCompanies('百度'), baiduSearch)

  for (const handler of [apiCompany, apiRefresh, apiResearch]) {
    const response = await invokeApi(handler, '09888.HK')
    assert.equal(response.status, 404)
    assert.equal(response.body.success, false)
    assert.equal(response.body.code, 404)
    assert.equal(response.body.errorCode, 'SECURITY_NOT_CONFIGURED')
    assert.equal(response.body.requestedCode, '09888.HK')
    assert.equal(response.body.displayCode, '9888.HK')
    assert.equal(response.body.issuerLegalName, 'Baidu, Inc.')
    assert.match(response.body.historyCorrection, /旧 Mock 曾将 09888\.HK 错链至阿里巴巴/)
    assert.doesNotMatch(JSON.stringify(response.body), /SECURITY_IDENTITY_CONFLICT/)
  }

  for (const handler of [apiCompany, apiRefresh, apiResearch]) {
    for (const code of ['UNKNOWN.HK', 'not-a-code']) {
      const response = await invokeApi(handler, code)
      assert.equal(response.status, 404)
      assert.equal(response.body.errorCode, 'SECURITY_NOT_CONFIGURED')
      assert.equal(response.body.requestedCode, code)
      assert.equal('displayCode' in response.body, false)
      assert.equal('issuerLegalName' in response.body, false)
      assert.equal('historyCorrection' in response.body, false)
    }
  }
}

if (require.main === module) {
  run()
    .then(() => console.log('security identity contract passed'))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}

module.exports = { run }
