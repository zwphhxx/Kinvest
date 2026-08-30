const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repositoryRoot = path.resolve(__dirname, '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8')
}

async function run() {
  const runbookPath = path.join(
    repositoryRoot,
    'docs/operations/ifind-three-market-admin-diagnostics.md'
  )

  assert.equal(fs.existsSync(runbookPath), true, 'three-market administrator runbook must exist')

  const runbook = fs.readFileSync(runbookPath, 'utf8')
  const wireContract = read('docs/operations/ifind-admin-diagnostic-contract.md')
  const readme = read('README.md')

  for (const [caseId, issuer, displayCode] of [
    ['HK_ALIBABA_9988', 'Alibaba', '9988.HK'],
    ['US_APPLE_AAPL', 'Apple', 'AAPL.US'],
    ['CN_MOUTAI_600519', 'Kweichow Moutai', '600519.SH']
  ]) {
    assert.match(runbook, new RegExp(`${caseId}[\\s\\S]{0,180}${issuer}[\\s\\S]{0,180}${displayCode}`, 'i'))
  }

  assert.match(runbook, /administrator-only|仅管理员/i)
  assert.match(runbook, /no arbitrary quer|不提供任意查询/i)
  assert.match(runbook, /no run-all|不得批量|不提供批量/i)
  assert.match(runbook, /authenticated indicator evidence|认证指标证据/i)
  assert.match(runbook, /manifest verification|manifest 验证/i)
  assert.match(runbook, /separately approved real invocation|单独批准[\s\S]{0,100}真实调用/i)
  assert.match(runbook, /production manifest[\s\S]{0,120}(?:fail-closed|失败关闭)[\s\S]{0,120}unverified|生产 manifest[\s\S]{0,120}未验证[\s\S]{0,120}失败关闭/i)

  for (const [market, currency, fiscalRule] of [
    ['港股', 'HKD', '3 月 31 日'],
    ['美股', 'USD', '52/53 周'],
    ['A 股', 'CNY', '12 月 31 日']
  ]) {
    assert.match(runbook, new RegExp(`${market}[\\s\\S]{0,260}${currency}[\\s\\S]{0,260}${fiscalRule}`))
  }

  assert.match(runbook, /最近两个年度[\s\S]{0,120}最新已披露中期/)
  assert.match(runbook, /reporting currency evidence|报告币种证据/i)
  assert.match(runbook, /不得推断|no inference/i)
  assert.match(runbook, /缺失字段[\s\S]{0,80}保持缺失/)
  assert.match(runbook, /real[\s\S]{0,100}Mock[\s\S]{0,100}(?:不得混合|cannot mix)|Mock[\s\S]{0,100}real[\s\S]{0,100}(?:不得混合|cannot mix)/i)

  assert.match(runbook, /global in-flight[\s\S]{0,80}`?1`?|全局并发[\s\S]{0,80}`?1`?/i)
  assert.match(runbook, /cooldown[\s\S]{0,80}5 min|冷却[\s\S]{0,80}5 分钟/i)
  assert.match(runbook, /case daily[\s\S]{0,80}`?5`?|单案例[\s\S]{0,80}每日[\s\S]{0,80}`?5`?/i)
  assert.match(runbook, /global daily[\s\S]{0,80}`?12`?|全局[\s\S]{0,80}每日[\s\S]{0,80}`?12`?/i)
  assert.match(runbook, /Asia\/Shanghai/)

  for (const endpoint of [
    'GET /api/admin/ifind/market-cases',
    'GET /api/admin/ifind/market-cases/:caseId',
    'POST /api/admin/ifind/market-cases/:caseId/run'
  ]) {
    assert.ok(runbook.includes(endpoint), `runbook must document ${endpoint}`)
  }
  assert.match(runbook, /safe status|安全状态/i)
  assert.match(runbook, /safe error|安全错误/i)
  assert.match(runbook, /family dashboard[\s\S]{0,120}Mock[\s\S]{0,120}unchanged|家庭看板[\s\S]{0,120}Mock[\s\S]{0,120}不变/i)

  assert.match(runbook, /fixture[\s\S]{0,180}(?:now|当前)[\s\S]{0,180}(?:offline|离线)/i)
  assert.match(runbook, /per-call user approval|每次真实调用[\s\S]{0,120}用户明确批准/i)
  assert.match(runbook, /evidence|证据/i)
  assert.match(runbook, /provenance|来源链/i)
  assert.match(runbook, /redact|脱敏/i)
  assert.match(runbook, /no production action|不执行生产操作/i)
  assert.doesNotMatch(runbook, /(?:refresh[_ -]?token|access[_ -]?token|api[_ -]?key|password)\s*[:=]\s*[A-Za-z0-9_+./=-]{16,}/i)

  for (const document of [wireContract, readme]) {
    assert.match(document, /ifind-three-market-admin-diagnostics\.md/)
    assert.match(document, /9988\.HK/)
    assert.match(document, /AAPL\.US/)
    assert.match(document, /600519\.SH/)
    assert.match(document, /Mock/)
  }

  assert.match(wireContract, /current production manifest|当前生产 manifest/i)
  assert.match(wireContract, /fail-closed|失败关闭/i)
  assert.match(readme, /administrator|管理员/i)
  assert.match(readme, /fixed|固定/i)

  console.log('ifind-three-market-admin-docs: PASS')
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { run }
