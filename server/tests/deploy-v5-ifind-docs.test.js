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
    'docs/operations/deploy-v5-ifind-diagnostics-runbook.md'
  )

  assert.equal(
    fs.existsSync(runbookPath),
    true,
    'deploy-v5 iFinD operations runbook must exist'
  )

  const runbook = fs.readFileSync(runbookPath, 'utf8')
  const productionRunbook = read('docs/operations/production-runbook.md')
  const familyDesign = read('docs/specs/2026-07-28-family-investment-dashboard-design.md')

  for (const required of [
    'H4',
    'KINVEST_IFIND_REFRESH_TOKEN',
    'TMPFS_IFIND_REFRESH_TOKEN_VERSION_ID',
    'deploy-production-v5-manual.yml',
    'disabled',
    'diagnostic',
    'L1',
    'L2',
    'ROLLBACK',
    'RESTORE',
    'Docker',
    'CVM',
    'tmpfs',
    'fingerprint',
    'real',
    'Mock'
  ]) {
    assert.match(runbook, new RegExp(required, 'i'), `runbook must document ${required}`)
  }

  assert.match(runbook, /H4[\s\S]{0,160}(?:code|代码)[\s\S]{0,160}(?:not enabled|尚未启用|未启用)/i)
  assert.match(runbook, /CVM[\s\S]{0,240}tmpfs[\s\S]{0,240}(?:fail closed|失败关闭)[\s\S]{0,240}RESTORE/i)
  assert.match(runbook, /Agent[\s\S]{0,500}(?:user|用户)[\s\S]{0,500}(?:approval|批准)/i)
  assert.match(runbook, /administrator|管理员/i)
  assert.match(runbook, /family display|家庭展示/i)
  assert.match(runbook, /real[\s\S]{0,100}Mock|Mock[\s\S]{0,100}real/i)
  assert.doesNotMatch(runbook, /(?:refresh[_ -]?token|password|private key)\s*[:=]\s*[A-Za-z0-9_+.-]{16,}/i)

  for (const document of [productionRunbook, familyDesign]) {
    assert.match(document, /deploy-v5/i)
    assert.match(document, /KINVEST_IFIND_REFRESH_TOKEN/)
    assert.match(document, /TMPFS_IFIND_REFRESH_TOKEN_VERSION_ID/)
    assert.match(document, /GitHub\s+`?Production`?/i)
    assert.match(document, /independent|独立/i)
    assert.match(document, /tmpfs/i)
    assert.match(document, /not enabled|尚未(?:生产)?启用|未(?:生产)?启用/i)
  }

  assert.match(familyDesign, /historical|历史/i)
  assert.match(familyDesign, /SSM|Secrets Manager/)
  assert.match(familyDesign, /replaced|替代|取代/i)

  for (const document of [productionRunbook, familyDesign]) {
    assert.doesNotMatch(document, /网站只提醒管理员 token 即将到期或已经失效/)
    assert.doesNotMatch(document, /网站每天检查令牌声明或接口返回的可用期限/)
    assert.match(document, /当前只提供 VersionId、模式、冷却、调用次数和最近诊断状态/)
    assert.match(document, /到期日期[\s\S]{0,120}管理员[\s\S]{0,120}人工记录[\s\S]{0,120}检查/)
    assert.match(document, /自动提醒[\s\S]{0,120}T10-H[\s\S]{0,120}后续[\s\S]{0,120}未实现/)
  }

  console.log('deploy-v5-ifind-docs: PASS')
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = { run }
