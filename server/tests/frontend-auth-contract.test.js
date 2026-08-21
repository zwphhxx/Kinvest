const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

function assertPureAuthContract() {
  const auth = require('../../public/auth-contract')

  assert.deepEqual(auth.normalizeAuthStatus({ authorized: true }), { authorized: true })
  assert.deepEqual(auth.normalizeAuthStatus({ authorized: false }), { authorized: false })
  assert.throws(() => auth.normalizeAuthStatus({}), /AUTH_STATUS_INVALID/)

  assert.equal(auth.normalizeDeviceName('  家庭 iPad  '), '家庭 iPad')
  assert.equal(auth.normalizeDeviceName('Cafe\u0301'), 'Café')
  assert.throws(() => auth.normalizeDeviceName(''), /DEVICE_NAME_INVALID/)
  assert.throws(() => auth.normalizeDeviceName('x'.repeat(41)), /DEVICE_NAME_INVALID/)
  assert.throws(() => auth.normalizeDeviceName('书房\n电脑'), /DEVICE_NAME_INVALID/)

  assert.equal(auth.normalizeRequestStatus({ status: 'pending' }).status, 'pending')
  assert.equal(auth.normalizeRequestStatus({ status: 'approved' }).status, 'approved')
  assert.throws(() => auth.normalizeRequestStatus({ status: 'mystery' }), /REQUEST_STATUS_INVALID/)
  assert.deepEqual(auth.pollDecision('pending', false), { poll: true, terminal: false })
  assert.deepEqual(auth.pollDecision('pending', true), { poll: false, terminal: false })
  assert.deepEqual(auth.pollDecision('expired', false), { poll: false, terminal: true })

  assert.equal(auth.authErrorMessage('REQUEST_RATE_LIMITED'), '申请有点频繁，请稍后再试。')
  assert.equal(auth.authErrorMessage('UNKNOWN_INTERNAL_TEXT'), '暂时无法完成，请稍后重试。')
  assert.equal(auth.formatRequestCode('123456'), '123 456')
  assert.equal(auth.formatRequestCode('123'), '')
}

function assertMainGateContract() {
  const html = read('public/index.html')
  const app = read('public/app.js')
  const gate = read('public/auth-ui.js')

  assert.match(html, /id="auth-checking"[^>]*role="status"/)
  assert.match(html, /id="auth-gate"[^>]*class="auth-shell hidden"/)
  assert.match(html, /id="dashboard-shell"[^>]*class="shell hidden"/)
  assert.match(html, /aria-live="polite"/)
  assert.match(html, /<script src="\/auth-contract\.js" defer><\/script>/)
  assert.match(html, /<script src="\/auth-ui\.js" defer><\/script>/)

  assert.match(app, /async function bootstrap\(\) \{[\s\S]*getJson\('\/api\/auth\/status'[\s\S]*if \(!authStatus\.authorized\) \{[\s\S]*return[\s\S]*await loadWatchlist\(\)/)
  assert.match(app, /if \(!authStatus\.authorized\) \{[\s\S]*return[\s\S]*\}/)
  assert.match(app, /credentials:\s*'same-origin'/)
  assert.match(app, /function clearInvestmentState\(/)
  assert.match(app, /if \(res\.status === 401[\s\S]*clearInvestmentState\(\)[\s\S]*showGate\(\)/)
  assert.match(app, /el\.marketStatus[\s\S]*el\.thermo/)

  for (const endpoint of [
    '/api/auth/device-requests',
    '/status',
    '/redeem'
  ]) assert.match(gate, new RegExp(endpoint.replaceAll('/', '\\/')))

  assert.doesNotMatch(gate, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
  assert.doesNotMatch(`${app}\n${gate}`, /localStorage|sessionStorage/)
  assert.match(gate, /textContent/)
  assert.match(gate, /replaceChildren/)
  assert.match(gate, /visibilitychange/)
  assert.match(gate, /beforeunload/)
  assert.match(gate, /disabled\s*=/)
  assert.match(gate, /AbortController/)
  assert.match(gate, /pollGeneration/)
  assert.match(gate, /redeemPromise/)
  assert.match(gate, /pollController === controller/)
  assert.match(gate, /Math\.min\([^\n]*15000/)
  assert.match(gate, /REQUEST_ALREADY_USED[\s\S]*\/api\/auth\/status/)
  assert.match(gate, /server status/i)
  assert.match(gate, /setAttribute\('aria-busy'/)
}

function assertResearchGateContract() {
  const html = read('public/research.html')
  const script = read('public/research.js')
  assert.match(html, /id="research-checking"[^>]*role="status"/)
  assert.match(html, /id="research-content"[^>]*class="research-wrap hidden"/)
  const authIndex = script.indexOf("safeGet('/api/auth/status'")
  const researchIndex = script.indexOf('`/api/research/')
  assert.ok(authIndex >= 0 && researchIndex > authIndex)
  assert.match(script, /if \(!authStatus\.authorized\)/)
  assert.match(script, /window\.location\.replace\('\/'\)/)
  assert.match(script, /research-checking/)
  assert.match(script, /research-retry/)
}

function assertAdminDeskContract() {
  const html = read('public/admin.html')
  const script = read('public/admin.js')

  assert.match(html, /<title>Kinvest 家庭设备管理<\/title>/)
  assert.match(html, /id="admin-login"/)
  assert.match(html, /id="admin-desk"/)
  assert.match(html, /aria-live="polite"/)
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i)
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i)
  assert.doesNotMatch(html, /投资数据|关注清单|公司数据/)

  for (const endpoint of [
    '/api/admin/login',
    '/api/admin/csrf',
    '/api/admin/logout',
    '/api/admin/device-requests',
    '/approve',
    '/api/admin/devices',
    '/revoke',
    '/revoke-all',
    '/api/admin/audit'
  ]) assert.match(script, new RegExp(endpoint.replaceAll('/', '\\/')))

  assert.match(script, /'x-kinvest-csrf'/)
  assert.match(script, /credentials:\s*'same-origin'/)
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
  assert.doesNotMatch(script, /localStorage|sessionStorage/)
  assert.match(script, /textContent/)
  assert.match(script, /replaceChildren/)
  assert.match(script, /password:\s*passwordInput\.value/)
  assert.doesNotMatch(script, /passwordInput\.value\.trim\(/)
  assert.match(script, /csrfRestorePromise/)
  assert.match(script, /ADMIN_CSRF_INVALID[\s\S]*refreshLists/)
  assert.match(script, /beforeunload[\s\S]*csrfToken = null/)
  assert.match(script, /ADMIN_AUTH_REQUIRED[\s\S]*csrfToken = null/)
  assert.doesNotMatch(script, /retryMutation|replayMutation/)
}

function assertVisualAndBuildContract() {
  const css = read('public/auth.css')
  const build = read('scripts/build.js')

  assert.match(css, /\.family-pass/)
  assert.match(css, /font-family:[^;]*(?:Songti SC|Iowan Old Style)/)
  assert.match(css, /@media \(max-width:\s*760px\)/)
  assert.match(css, /@media \(max-width:\s*375px\)/)
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/)
  assert.match(css, /:focus-visible/)
  assert.match(css, /@keyframes auth-entry/)
  assert.match(css, /min-height:\s*44px/)
  assert.match(css, /overflow-wrap:\s*anywhere/)

  const combinedMarkup = `${read('public/index.html')}\n${read('public/admin.html')}\n${read('public/research.html')}`
  assert.doesNotMatch(combinedMarkup, /<style(?:\s|>)/i)
  assert.doesNotMatch(combinedMarkup, /<script(?![^>]*\bsrc=)[^>]*>/i)
  assert.doesNotMatch(combinedMarkup, /\son[a-z]+\s*=/i)
  const authSources = `${read('public/auth-ui.js')}\n${read('public/admin.js')}\n${read('public/auth-contract.js')}`
  assert.doesNotMatch(authSources, /eval\(|new Function|https?:\/\/|localStorage|sessionStorage/)

  for (const file of [
    'public/auth-contract.js',
    'public/auth-ui.js',
    'public/auth.css',
    'public/admin.html',
    'public/admin.js'
  ]) assert.match(build, new RegExp(file.replace('.', '\\.')))
}

async function run() {
  assertPureAuthContract()
  assertMainGateContract()
  assertResearchGateContract()
  assertAdminDeskContract()
  assertVisualAndBuildContract()
}

module.exports = { run }
