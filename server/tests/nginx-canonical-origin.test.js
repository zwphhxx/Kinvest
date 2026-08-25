const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const nginxConfigPath = path.resolve(__dirname, '../../deploy/server/nginx.conf')

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function nginxBlocks(source, headerPattern) {
  const blocks = []
  const opening = new RegExp(`(?:^|\\n)\\s*${headerPattern}\\s*\\{`, 'g')
  let match

  while ((match = opening.exec(source)) !== null) {
    const bodyStart = match.index + match[0].length
    let depth = 1
    let cursor = bodyStart

    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1
      if (source[cursor] === '}') depth -= 1
      cursor += 1
    }

    assert.equal(depth, 0, 'Nginx server block must close')
    blocks.push(source.slice(bodyStart, cursor - 1))
    opening.lastIndex = cursor
  }

  return blocks
}

function run() {
  const source = fs.readFileSync(nginxConfigPath, 'utf8')
  const tlsServers = nginxBlocks(source, 'server')
    .filter((block) => /^\s*listen 443 ssl(?: default_server)?;$/m.test(block))
  const canonicalServers = tlsServers
    .filter((block) => /^\s*server_name dearmina\.cn;$/m.test(block))
  const aliasServers = tlsServers
    .filter((block) => /^\s*server_name www\.dearmina\.cn;$/m.test(block))

  assert.equal(canonicalServers.length, 1,
    'HTTPS must have exactly one canonical dearmina.cn application server')
  assert.match(canonicalServers[0], /^\s*proxy_pass \$kinvest_upstream;$/m)
  assert.doesNotMatch(canonicalServers[0], /server_name[^;]*www\.dearmina\.cn/)

  assert.equal(aliasServers.length, 1,
    'HTTPS must have exactly one www.dearmina.cn redirect server')
  assert.match(aliasServers[0], /^\s*return 301 https:\/\/dearmina\.cn\$request_uri;$/m)
  assert.doesNotMatch(aliasServers[0], /proxy_pass/)

  for (const directive of [
    'ssl_session_timeout 5m;',
    'ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:HIGH:!aNULL:!MD5:!RC4:!DHE;',
    'ssl_prefer_server_ciphers on;',
    'add_header X-Content-Type-Options "nosniff" always;',
    'add_header X-Frame-Options "DENY" always;',
    'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
    'add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;',
    'add_header Content-Security-Policy "default-src \'self\'; script-src \'self\'; style-src \'self\'; img-src \'self\' data:; connect-src \'self\'; font-src \'self\'; object-src \'none\'; frame-ancestors \'none\'; base-uri \'self\'; form-action \'self\'" always;',
    'add_header Strict-Transport-Security "max-age=86400" always;',
    'add_header Cache-Control "no-store" always;'
  ]) {
    assert.match(aliasServers[0], new RegExp(`^\\s*${escapeRegExp(directive)}$`, 'm'),
      `www redirect must preserve security directive: ${directive}`)
  }
}

module.exports = { run }
