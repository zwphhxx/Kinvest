const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const rootDir = path.resolve(__dirname, '../..')
const gatePath = path.join(rootDir, 'deploy/server/kinvest-nginx-fixed-ip-gate')
const overlaySource = path.join(rootDir, 'deploy/server/docker-compose.nginx-fixed-ip.yml')
const contractSource = path.join(rootDir, 'deploy/server/deploy-v3-contract.py')

function write(file, contents, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents, { mode })
  fs.chmodSync(file, mode)
}

function withUmask(mode, callback) {
  const previous = process.umask(mode)
  try { return callback() } finally { process.umask(previous) }
}

function fixture({
  missingOverlay = false,
  tamperOverlay = false,
  missingIp = false,
  renderMismatch = false,
  oldCompose = false,
  nginxOverlayMode = 0o600,
  healthPayload = JSON.stringify({
    status: 'ok',
    service: 'kinvest',
    dataMode: 'mock',
    database: 'ready',
    timestamp: '2026-08-25T00:00:00.000Z'
  })
} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-nginx-fixed-ip-'))
  const project = path.join(base, 'docker')
  const kinvest = path.join(project, 'kinvest')
  const etc = path.join(base, 'etc')
  const bin = path.join(base, 'bin')
  const runRoot = path.join(base, 'run')
  const operations = path.join(base, 'operations')
  const baseCompose = path.join(project, 'docker-compose.yml')
  const nginxOverlay = path.join(project, 'docker-compose.kinvest-nginx.yml')
  const fixedOverlay = path.join(kinvest, 'docker-compose.nginx-fixed-ip.yml')
  const networkConfig = path.join(etc, 'access-control-network.conf')
  const contract = path.join(bin, 'contract')
  for (const directory of [kinvest, etc, bin, runRoot]) fs.mkdirSync(directory, { recursive: true })
  fs.chmodSync(project, 0o755)
  write(baseCompose, 'services:\n  nginx:\n    image: nginx\n')
  write(nginxOverlay, 'services:\n  nginx:\n    networks:\n      - web\n', nginxOverlayMode)
  if (!missingOverlay) {
    fs.copyFileSync(overlaySource, fixedOverlay)
    fs.chmodSync(fixedOverlay, 0o644)
    if (tamperOverlay) fs.appendFileSync(fixedOverlay, '# tampered\n')
  }
  write(networkConfig, missingIp
    ? 'KINVEST_WEB_NETWORK=web\nKINVEST_NGINX_CONTAINER=nginx\n'
    : 'KINVEST_WEB_NETWORK=web\nKINVEST_NGINX_CONTAINER=nginx\nKINVEST_NGINX_IPV4=172.19.0.9\n', 0o600)
  fs.copyFileSync(contractSource, contract)
  fs.chmodSync(contract, 0o755)
  write(path.join(bin, 'id'), '#!/bin/sh\n[ "${1:-}" = -u ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n', 0o755)
  write(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf 'docker:%s:ip=%s:protocol=%s\n' "$*" "\${KINVEST_NGINX_IPV4:-missing}" "\${KINVEST_DEPLOY_PROTOCOL:-unset}" >>'${operations}'
if [[ "$1 $2 $3" == 'compose version --short' ]]; then echo '${oldCompose ? '2.23.0' : '2.24.4'}'; exit 0; fi
if [[ "$1" == compose && "$*" == *' config --format json'* ]]; then
  printf '{"services":{"nginx":{"networks":{"web":{"ipv4_address":"%s"}}}}}\n' '${renderMismatch ? '172.19.0.10' : '172.19.0.9'}'
  exit 0
fi
if [[ "$1" == compose && "$*" == *' up -d --no-deps --force-recreate nginx'* ]]; then exit 0; fi
if [[ "$1" == inspect ]]; then
  [[ "$2" == '--format' ]]
  [[ "$3" == *State.Running* ]] && echo true || echo 172.19.0.9
  exit 0
fi
exit 1
`, 0o755)
  write(path.join(bin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
out=''
previous=''
for value in "$@"; do [[ "$previous" == -o ]] && out="$value"; previous="$value"; done
printf '%s' '${healthPayload}' >"$out"
printf '%s' '200 application/json'
`, 0o755)
  write(operations, '')
  const source = fs.readFileSync(gatePath, 'utf8')
    .replace("PROJECT_ROOT='/root/docker'", `PROJECT_ROOT='${project}'`)
    .replace("ACCESS_NETWORK_CONFIG='/etc/kinvest/access-control-network.conf'", `ACCESS_NETWORK_CONFIG='${networkConfig}'`)
    .replace("CONTRACT='/usr/local/libexec/kinvest-deploy-v4-contract'", `CONTRACT='${contract}'`)
    .replace("RUN_ROOT='/run'", `RUN_ROOT='${runRoot}'`)
    .replace("ROOT_UID='0'", `ROOT_UID='${process.getuid()}'`)
    .replace("ROOT_GID='0'", `ROOT_GID='${process.getgid()}'`)
  const gate = path.join(base, 'gate')
  write(gate, source, 0o755)
  return { base, bin, gate, operations }
}

function execute(context, mode, extraEnv = {}) {
  return spawnSync('bash', [context.gate, mode], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      KINVEST_DEPLOY_PROTOCOL: '3',
      KINVEST_V4_TEST_ROOT_UID: String(process.getuid()),
      PATH: `${context.bin}:${process.env.PATH}`
    }
  })
}

async function run() {
  assert.equal(fs.existsSync(gatePath), true, 'trusted fixed-IP gate asset is required')
  assert.notEqual(fs.statSync(gatePath).mode & 0o111, 0)
  assert.equal(spawnSync('bash', ['-n', gatePath], { encoding: 'utf8' }).status, 0)
  const expectedOverlayHash = crypto.createHash('sha256').update(fs.readFileSync(overlaySource)).digest('hex')
  assert.match(fs.readFileSync(gatePath, 'utf8'), new RegExp(expectedOverlayHash))

  withUmask(0o022, () => {
    const render = fixture()
    try {
      const result = execute(render, 'render', { KINVEST_NGINX_IPV4: '198.51.100.77' })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, 'KINVEST_NGINX_FIXED_IP_RENDER_OK ip=172.19.0.9\n')
      const operations = fs.readFileSync(render.operations, 'utf8')
      assert.match(operations, /compose version --short/)
      assert.match(operations, /docker-compose\.yml .*docker-compose\.kinvest-nginx\.yml .*docker-compose\.nginx-fixed-ip\.yml config --format json/)
      assert.match(operations, /ip=172\.19\.0\.9/)
      assert.match(operations, /protocol=3/)
      assert.doesNotMatch(operations, / up |198\.51\.100\.77|protocol=4/)
    } finally { fs.rmSync(render.base, { recursive: true, force: true }) }
  })

  withUmask(0o022, () => {
    const context = fixture({ missingIp: true })
    try {
      const result = execute(context, 'render')
      assert.notEqual(result.status, 0)
      assert.equal(result.stderr, 'KINVEST_NGINX_FIXED_IP_CONFIG_INVALID\n')
      assert.doesNotMatch(fs.readFileSync(context.operations, 'utf8'), / up /)
    } finally { fs.rmSync(context.base, { recursive: true, force: true }) }
  })

  withUmask(0o077, () => {
    const context = fixture()
    try {
      const result = execute(context, 'render')
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout, 'KINVEST_NGINX_FIXED_IP_RENDER_OK ip=172.19.0.9\n')
      const operations = fs.readFileSync(context.operations, 'utf8')
      assert.match(operations, /protocol=3/)
      assert.doesNotMatch(operations, /protocol=4/)
    } finally { fs.rmSync(context.base, { recursive: true, force: true }) }
  })

  withUmask(0o077, () => {
    const context = fixture({ missingIp: true })
    try {
      const result = execute(context, 'render')
      assert.notEqual(result.status, 0)
      assert.equal(result.stderr, 'KINVEST_NGINX_FIXED_IP_CONFIG_INVALID\n')
      assert.doesNotMatch(fs.readFileSync(context.operations, 'utf8'), / up /)
    } finally { fs.rmSync(context.base, { recursive: true, force: true }) }
  })

  const apply = fixture()
  try {
    const result = execute(apply, 'apply')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'KINVEST_NGINX_FIXED_IP_APPLY_OK ip=172.19.0.9 health=ready https=ready\n')
    const operations = fs.readFileSync(apply.operations, 'utf8')
    assert.match(operations, /up -d --no-deps --force-recreate nginx/)
    assert.match(operations, /inspect --format \{\{\.State\.Running\}\} nginx/)
    assert.match(operations, /NetworkSettings\.Networks "web"/)
  } finally { fs.rmSync(apply.base, { recursive: true, force: true }) }

  for (const invalid of [
    { name: 'health-status', payload: JSON.stringify({ status: 'degraded', service: 'kinvest' }) },
    { name: 'health-service', payload: JSON.stringify({ status: 'ok', service: 'other' }) },
    { name: 'health-shape', payload: JSON.stringify(['ok', 'kinvest']) }
  ]) {
    const context = fixture({ healthPayload: invalid.payload })
    try {
      const result = execute(context, 'apply')
      assert.notEqual(result.status, 0, invalid.name)
      assert.equal(result.stderr, 'KINVEST_NGINX_FIXED_IP_HEALTH_FAILED\n', invalid.name)
    } finally { fs.rmSync(context.base, { recursive: true, force: true }) }
  }

  for (const invalid of [
    { name: 'overlay-missing', options: { missingOverlay: true } },
    { name: 'overlay-hash', options: { tamperOverlay: true } },
    { name: 'nginx-overlay-mode', options: { nginxOverlayMode: 0o644 } },
    { name: 'config-mismatch', options: { renderMismatch: true } },
    { name: 'compose-version', options: { oldCompose: true } }
  ]) {
    const context = fixture(invalid.options)
    try {
      const result = execute(context, 'render')
      assert.notEqual(result.status, 0, invalid.name)
      assert.match(result.stderr, /^KINVEST_NGINX_FIXED_IP_[A-Z_]+\n$/, invalid.name)
      assert.doesNotMatch(fs.readFileSync(context.operations, 'utf8'), / up /, invalid.name)
    } finally { fs.rmSync(context.base, { recursive: true, force: true }) }
  }
}

module.exports = { run }
