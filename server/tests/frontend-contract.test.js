const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '../..')
const appPath = path.join(projectRoot, 'public/app.js')
const cssPath = path.join(projectRoot, 'public/app.css')
const htmlPath = path.join(projectRoot, 'public/index.html')

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function assertFinancialSourcesAreExplicit() {
  const { getCompany } = require('../data/mockData')
  for (const code of ['09888.HK', 'AAPL.US']) {
    const company = getCompany(code)
    for (const rows of Object.values(company.financials)) {
      for (const row of rows) {
        assert.equal(typeof row.source?.sourceName, 'string')
        assert.ok(row.source.sourceName.trim(), `${code} financial source must be explicit`)
      }
    }
  }

  const app = read(appPath)
  assert.doesNotMatch(app, /\$\{row\.sourceName\}/)
  assert.match(app, /待验证来源（Mock）/)
  assert.match(app, /row\.source\?\.sourceName/)
}

function assertDefaultAnomaliesRemainDeterministic() {
  const app = read(appPath)
  assert.doesNotMatch(app, /含投资提示/)
  assert.doesNotMatch(app, /it\.note/)
}

function assertFaviconAndMobileTableScrolling() {
  const html = read(htmlPath)
  const css = read(cssPath)

  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/)
  assert.match(html, /id="finance-table-wrap" class="table-scroll finance-table-scroll"/)
  assert.match(html, /id="breakdown-table" class="table-scroll breakdown-table-scroll"/)
  assert.match(css, /\.table-scroll\s*\{[^}]*overflow-x:\s*auto;/s)
  assert.match(css, /\.finance-table-scroll table\s*\{[^}]*min-width:/s)
  assert.match(css, /\.breakdown-table-scroll table\s*\{[^}]*min-width:/s)
}

async function run() {
  assertFinancialSourcesAreExplicit()
  assertDefaultAnomaliesRemainDeterministic()
  assertFaviconAndMobileTableScrolling()
}

module.exports = { run }
