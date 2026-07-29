const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')

function readRootFile(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8')
}

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { mode: 0o755 })
}

function stageBody(dockerfile, stageName) {
  const stages = dockerfile.split(/(?=^FROM\s)/m)
  const stage = stages.find((candidate) => new RegExp(`\\sAS\\s+${stageName}\\s*$`, 'mi').test(candidate.split('\n')[0]))

  assert.ok(stage, `Dockerfile stage "${stageName}" must exist`)
  return stage
}

function topLevelBlock(source, key) {
  const match = source.match(
    new RegExp(`^${key}:\\n([\\s\\S]*?)(?=^[A-Za-z][^\\n]*:\\s*$|(?![\\s\\S]))`, 'm')
  )

  assert.ok(match, `top-level Compose block "${key}" must exist`)
  return match[0]
}

function serviceBlock(compose, serviceName) {
  const services = topLevelBlock(compose, 'services')
  const match = services.match(
    new RegExp(`^  ${serviceName}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\s*$|(?![\\s\\S]))`, 'm')
  )

  assert.ok(match, `Compose service "${serviceName}" must exist`)
  return match[0]
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
      if (source[cursor] === '{') {
        depth += 1
      } else if (source[cursor] === '}') {
        depth -= 1
      }
      cursor += 1
    }

    assert.equal(depth, 0, `Nginx block "${headerPattern}" must close`)
    blocks.push(source.slice(bodyStart, cursor - 1))
    opening.lastIndex = cursor
  }

  return blocks
}

function nginxBlock(source, headerPattern) {
  const blocks = nginxBlocks(source, headerPattern)

  assert.equal(blocks.length, 1, `Nginx block "${headerPattern}" must exist exactly once`)
  return blocks[0]
}

function assertProxyContract(block, { websocket = false } = {}) {
  assert.match(block, /^\s*proxy_pass \$kinvest_upstream;$/m)
  assert.doesNotMatch(block, /^\s*proxy_pass \$kinvest_upstream\//m)
  assert.match(block, /^\s*proxy_http_version 1\.1;$/m)
  assert.match(block, /^\s*proxy_set_header Host dearmina\.cn;$/m)
  assert.match(block, /^\s*proxy_set_header X-Forwarded-Host dearmina\.cn;$/m)
  assert.match(block, /^\s*proxy_set_header X-Real-IP \$remote_addr;$/m)
  assert.match(block, /^\s*proxy_set_header X-Forwarded-For \$remote_addr;$/m)
  assert.match(block, /^\s*proxy_set_header X-Forwarded-Proto \$scheme;$/m)
  assert.match(block, /^\s*proxy_connect_timeout 5s;$/m)
  assert.match(block, /^\s*proxy_read_timeout 30s;$/m)
  assert.doesNotMatch(block, /\$proxy_add_x_forwarded_for/)
  assert.doesNotMatch(block, /proxy_set_header Host \$host/)

  if (websocket) {
    assert.match(block, /^\s*proxy_set_header Upgrade \$http_upgrade;$/m)
    assert.match(block, /^\s*proxy_set_header Connection \$connection_upgrade;$/m)
  }
}

function assertRelativeProbeWorksInsideRestrictedParent() {
  if (typeof process.getuid !== 'function' || process.getuid() === 0) {
    return
  }

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-restricted-parent-'))
  const restrictedParent = path.join(fixtureRoot, 'root-mode-directory')
  const dataDir = path.join(restrictedParent, 'data')

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })

  try {
    const result = spawnSync(
      '/bin/sh',
      [
        '-c',
        [
          'set -eu',
          'cd -- "$1/data"',
          'chmod 000 "$1"',
          ': > .relative-probe.sqlite',
          'if (: > "$1/data/.absolute-probe.sqlite") 2>/dev/null; then exit 42; fi',
          'test -f .relative-probe.sqlite'
        ].join('\n'),
        'sh',
        restrictedParent
      ],
      { encoding: 'utf8' }
    )

    assert.equal(
      result.status,
      0,
      `relative probe must work after entering data dir while absolute traversal fails: ${result.stderr}`
    )
  } finally {
    fs.chmodSync(restrictedParent, 0o700)
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

function runPrepareFixture(prepareSource, { files, running = false }) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-data-migration-'))
  const fixtureDataDir = path.join(fixtureRoot, 'data')
  const fakeBin = path.join(fixtureRoot, 'bin')
  const fakeState = path.join(fixtureRoot, 'state')
  const chownLog = path.join(fakeState, 'chown.log')

  fs.mkdirSync(fixtureDataDir)
  fs.mkdirSync(fakeBin)
  fs.mkdirSync(fakeState)
  const dataDir = fs.realpathSync(fixtureDataDir)
  const unrelatedPath = path.join(dataDir, 'family-notes.txt')
  fs.writeFileSync(unrelatedPath, 'must remain untouched', { mode: 0o640 })

  for (const file of files) {
    const filePath = path.join(dataDir, file.name)

    if (file.kind === 'symlink') {
      const targetPath = path.join(fixtureRoot, `${file.name}.target`)
      fs.writeFileSync(targetPath, file.content || 'target')
      fs.symlinkSync(targetPath, filePath)
      continue
    }

    fs.writeFileSync(filePath, file.content || file.name, { mode: 0o640 })
    fs.writeFileSync(path.join(fakeState, `${file.name}.owner`), `${file.owner || '1000:1000'}\n`)
    fs.writeFileSync(path.join(fakeState, `${file.name}.links`), `${file.kind === 'hardlink' ? 2 : 1}\n`)

    if (file.kind === 'hardlink') {
      fs.linkSync(filePath, path.join(dataDir, `${file.name}.unrelated-hardlink`))
    }
  }

  writeExecutable(
    path.join(fakeBin, 'id'),
    `#!/bin/sh
if [ "\${1:-}" = '-u' ]; then
  printf '%s\\n' '0'
  exit 0
fi
exec /usr/bin/id "$@"
`
  )

  writeExecutable(
    path.join(fakeBin, 'install'),
    `#!/bin/sh
exit 0
`
  )

  writeExecutable(
    path.join(fakeBin, 'chown'),
    `#!/bin/sh
target=''
for argument in "$@"; do
  target="$argument"
done
printf '%s\\n' "$target" >> "$PREPARE_FAKE_STATE/chown.log"
if [ "$target" != '.' ]; then
  base="\${target##*/}"
  : > "$PREPARE_FAKE_STATE/$base.migrated"
fi
`
  )

  writeExecutable(
    path.join(fakeBin, 'chmod'),
    `#!/bin/sh
mode="$1"
shift
if [ "\${1:-}" = '--' ]; then
  shift
fi
exec /bin/chmod "$mode" "$@"
`
  )

  writeExecutable(
    path.join(fakeBin, 'stat'),
    `#!/bin/sh
format=''
target=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-c' ]; then
    shift
    format="$1"
  elif [ "$1" != '--' ]; then
    target="$1"
  fi
  shift
done
base="\${target##*/}"
case "$format" in
  '%u:%g')
    if [ -f "$PREPARE_FAKE_STATE/$base.migrated" ]; then
      printf '%s\\n' '10001:10001'
    else
      cat "$PREPARE_FAKE_STATE/$base.owner"
    fi
    ;;
  '%h')
    cat "$PREPARE_FAKE_STATE/$base.links"
    ;;
  *)
    exit 91
    ;;
esac
`
  )

  writeExecutable(
    path.join(fakeBin, 'setpriv'),
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --reuid=*|--regid=*|--clear-groups) shift ;;
    *) exec "$@" ;;
  esac
done
exit 92
`
  )

  writeExecutable(
    path.join(fakeBin, 'docker'),
    `#!/bin/sh
if [ "$PREPARE_RUNNING" = 'true' ]; then
  printf '%s\\n' 'kinvest'
fi
`
  )

  const instrumentedSource = prepareSource.replace(
    "DATA_DIR='/root/docker/kinvest/data'",
    `DATA_DIR='${dataDir}'`
  )
  const scriptPath = path.join(fixtureRoot, 'prepare-data-dir.sh')
  writeExecutable(scriptPath, instrumentedSource)

  const unrelatedBefore = fs.statSync(unrelatedPath)
  const result = spawnSync(scriptPath, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      PREPARE_FAKE_STATE: fakeState,
      PREPARE_RUNNING: String(running)
    }
  })

  return {
    chownTargets() {
      return fs.existsSync(chownLog)
        ? fs.readFileSync(chownLog, 'utf8').trim().split('\n').filter(Boolean)
        : []
    },
    cleanup() {
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    },
    dataDir,
    result,
    unrelatedBefore,
    unrelatedPath
  }
}

async function run() {
  const dockerfile = readRootFile('Dockerfile')
  const compose = readRootFile('deploy/server/docker-compose.yml')
  const dockerignore = readRootFile('.dockerignore')
  const prepareScriptPath = path.join(rootDir, 'deploy/server/prepare-data-dir.sh')
  const prepareScript = readRootFile('deploy/server/prepare-data-dir.sh')
  const nginx = readRootFile('deploy/server/nginx.conf')
  const explicitNginxCompose = readRootFile('deploy/server/docker-compose.nginx.yml')
  const logrotate = readRootFile('deploy/server/logrotate-nginx')
  const buildStage = stageBody(dockerfile, 'build')
  const runtimeStage = stageBody(dockerfile, 'runtime')
  const runtimeCopyCommands = runtimeStage.match(/^COPY\b.*$/gm) || []
  const kinvestService = serviceBlock(compose, 'kinvest')
  const networks = topLevelBlock(compose, 'networks')
  const http = nginxBlock(nginx, 'http')
  const httpServers = nginxBlocks(http, 'server')
  const httpDefaultServer = httpServers.find((block) => /^\s*listen 80 default_server;$/m.test(block))
  const httpRedirectServer = httpServers.find(
    (block) => /^\s*listen 80;$/m.test(block) && !/default_server/.test(block)
  )
  const httpsDefaultServer = httpServers.find(
    (block) => /^\s*listen 443 ssl default_server;$/m.test(block)
  )
  const httpsServer = httpServers.find(
    (block) => /^\s*listen 443 ssl;$/m.test(block) && !/default_server/.test(block)
  )

  assert.equal(httpServers.length, 4, 'Nginx must define default and canonical HTTP/HTTPS virtual hosts')
  assert.ok(httpDefaultServer, 'Nginx must reject unknown HTTP hosts')
  assert.ok(httpRedirectServer, 'Nginx must define the HTTP redirect virtual host')
  assert.ok(httpsDefaultServer, 'Nginx must reject unknown HTTPS hosts after TLS negotiation')
  assert.ok(httpsServer, 'Nginx must define the HTTPS application virtual host')

  assert.deepEqual(
    dockerfile.match(/^FROM\b.*$/gm),
    ['FROM node:22-alpine AS build', 'FROM node:22-alpine AS runtime']
  )
  assert.match(buildStage, /^RUN npm ci$/m)
  assert.match(buildStage, /^RUN npm run build$/m)
  assert.deepEqual(
    runtimeCopyCommands,
    ['COPY --from=build --chown=10001:10001 /app/dist ./'],
    'runtime stage must copy only the built dist directory'
  )
  assert.match(
    runtimeStage,
    /^RUN addgroup -g 10001 -S kinvest && \\\n {4}adduser -S -D -H -u 10001 -G kinvest -s \/sbin\/nologin kinvest$/m
  )
  assert.match(runtimeStage, /^USER 10001:10001$/m)
  assert.match(runtimeStage, /^CMD \["node", "server\/server\.js"\]$/m)
  assert.match(
    runtimeStage,
    /CMD wget --no-verbose --tries=1 --spider http:\/\/127\.0\.0\.1:4173\/api\/health \|\| exit 1/
  )

  assert.match(kinvestService, /^ {4}image: \$\{KINVEST_IMAGE:-kinvest:local\}$/m)
  assert.match(kinvestService, /^ {4}user: "10001:10001"$/m)
  assert.match(kinvestService, /^ {6}KINVEST_DB_PATH: \/data\/kinvest\.sqlite$/m)
  assert.match(kinvestService, /^ {4}expose:\n {6}- "4173"$/m)
  assert.match(
    kinvestService,
    /^ {4}volumes:\n {6}- type: bind\n {8}source: \/root\/docker\/kinvest\/data\n {8}target: \/data\n {8}bind:\n {10}create_host_path: false$/m
  )
  assert.match(kinvestService, /^ {4}networks:\n {6}- web$/m)
  assert.match(
    kinvestService,
    /^ {6}test: \["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http:\/\/127\.0\.0\.1:4173\/api\/health"\]$/m
  )
  assert.match(kinvestService, /^ {4}security_opt:\n {6}- no-new-privileges:true$/m)
  assert.match(kinvestService, /^ {4}cap_drop:\n {6}- ALL$/m)
  assert.doesNotMatch(compose, /^\s*ports\s*:/m)
  assert.match(networks, /^ {2}web:\n {4}external: true$/m)

  assert.equal(fs.statSync(prepareScriptPath).mode & 0o111, 0o111, 'data directory preparation script must be executable')
  assert.match(prepareScript, /^#!\/usr\/bin\/env sh\nset -eu$/m)
  assert.match(prepareScript, /^DATA_DIR='\/root\/docker\/kinvest\/data'$/m)
  assert.match(prepareScript, /^APP_UID='10001'$/m)
  assert.match(prepareScript, /^APP_GID='10001'$/m)
  assert.match(
    prepareScript,
    /^ {2}for PATH_COMPONENT in '\/root' '\/root\/docker' '\/root\/docker\/kinvest' "\$DATA_DIR"; do$/m
  )
  assert.match(prepareScript, /\[ -L "\$PATH_COMPONENT" \]/)
  assert.match(prepareScript, /install -d -m 0750 -- "\$DATA_DIR"/)
  assert.equal(
    prepareScript.match(/^assert_no_symlink_components$/gm)?.length,
    2,
    'path chain must be checked before and after directory creation'
  )
  assert.match(prepareScript, /^cd -P -- "\$DATA_DIR"$/m)
  assert.match(prepareScript, /^\s*if \[ "\$\(pwd -P\)" != "\$DATA_DIR" \]; then$/m)
  assert.match(prepareScript, /chown "\$APP_UID:\$APP_GID" -- \./)
  assert.match(prepareScript, /chmod 0750 -- \./)
  assert.match(prepareScript, /^PROBE_BASE="\.kinvest-write-probe-\$\$"$/m)
  assert.match(prepareScript, /setpriv --reuid="\$APP_UID" --regid="\$APP_GID" --clear-groups/)
  assert.match(prepareScript, /' sh "\$PROBE_BASE"/)
  assert.match(prepareScript, /\.sqlite/)
  assert.match(prepareScript, /\.sqlite-wal/)
  assert.match(prepareScript, /\.sqlite-shm/)
  assert.doesNotMatch(prepareScript, /\b(?:find|rm\s+-rf|chown\s+-R|chmod\s+-R)\b/)
  assert.doesNotMatch(prepareScript, /\b(?:MYSQL|mysql|\.env)\b/)
  assert.doesNotMatch(prepareScript, /\$\{?KINVEST_DATA_DIR\b/)
  assert.doesNotMatch(runtimeStage, /\b1000(?::1000)?\b/)
  assert.doesNotMatch(kinvestService, /\b1000(?::1000)?\b/)
  assert.match(
    prepareScript,
    /^SQLITE_FILES='kinvest\.sqlite kinvest\.sqlite-wal kinvest\.sqlite-shm kinvest\.sqlite-journal'$/m
  )
  assert.match(prepareScript, /stat -c '%u:%g'/)
  assert.match(prepareScript, /stat -c '%h'/)
  assert.match(prepareScript, /docker ps/)
  assert.doesNotMatch(prepareScript, /kinvest\.sqlite\*/)
  assert.doesNotMatch(prepareScript, /\b(?:find|xargs)\b/)

  const installIndex = prepareScript.indexOf('install -d -m 0750 -- "$DATA_DIR"')
  const cdIndex = prepareScript.indexOf('cd -P -- "$DATA_DIR"')
  const chownIndex = prepareScript.indexOf('chown "$APP_UID:$APP_GID" -- .')
  const setprivIndex = prepareScript.indexOf('setpriv --reuid="$APP_UID"')
  const loweredProbeInvocation = prepareScript.slice(setprivIndex)

  assert.ok(installIndex >= 0 && cdIndex > installIndex, 'root must enter data directory after safely creating it')
  assert.ok(chownIndex > cdIndex, 'ownership changes must target the verified physical data directory')
  assert.ok(setprivIndex > cdIndex, 'root must enter data directory before lowering privileges')
  assert.doesNotMatch(loweredProbeInvocation, /\/root|"\$DATA_DIR"/)

  assertRelativeProbeWorksInsideRestrictedParent()

  const migration = runPrepareFixture(prepareScript, {
    files: [
      { name: 'kinvest.sqlite', owner: '1000:1000', content: 'main database content' },
      { name: 'kinvest.sqlite-wal', owner: '1000:1000', content: 'wal content' },
      { name: 'kinvest.sqlite-shm', owner: '1000:1000', content: 'shm content' }
    ]
  })
  try {
    assert.equal(migration.result.status, 0, migration.result.stderr)
    assert.deepEqual(
      migration.chownTargets().filter((target) => target !== '.'),
      ['kinvest.sqlite', 'kinvest.sqlite-wal', 'kinvest.sqlite-shm']
    )
    assert.equal(fs.readFileSync(path.join(migration.dataDir, 'kinvest.sqlite'), 'utf8'), 'main database content')
    assert.equal(fs.readFileSync(path.join(migration.dataDir, 'kinvest.sqlite-wal'), 'utf8'), 'wal content')
    assert.equal(fs.readFileSync(path.join(migration.dataDir, 'kinvest.sqlite-shm'), 'utf8'), 'shm content')
    for (const name of ['kinvest.sqlite', 'kinvest.sqlite-wal', 'kinvest.sqlite-shm']) {
      assert.equal(fs.statSync(path.join(migration.dataDir, name)).mode & 0o777, 0o600)
    }
    const unrelatedAfter = fs.statSync(migration.unrelatedPath)
    assert.equal(unrelatedAfter.uid, migration.unrelatedBefore.uid)
    assert.equal(unrelatedAfter.gid, migration.unrelatedBefore.gid)
    assert.equal(unrelatedAfter.mode & 0o777, migration.unrelatedBefore.mode & 0o777)
    assert.equal(fs.readFileSync(migration.unrelatedPath, 'utf8'), 'must remain untouched')
    assert.equal(migration.chownTargets().includes('family-notes.txt'), false)
  } finally {
    migration.cleanup()
  }

  const unknownOwner = runPrepareFixture(prepareScript, {
    files: [{ name: 'kinvest.sqlite', owner: '2000:2000' }]
  })
  try {
    assert.equal(unknownOwner.result.status, 1)
    assert.match(unknownOwner.result.stderr, /unexpected owner 2000:2000/)
    assert.equal(unknownOwner.chownTargets().includes('kinvest.sqlite'), false)
  } finally {
    unknownOwner.cleanup()
  }

  const symlink = runPrepareFixture(prepareScript, {
    files: [{ name: 'kinvest.sqlite', kind: 'symlink' }]
  })
  try {
    assert.equal(symlink.result.status, 1)
    assert.match(symlink.result.stderr, /symlinked SQLite file/)
    assert.equal(symlink.chownTargets().includes('kinvest.sqlite'), false)
  } finally {
    symlink.cleanup()
  }

  const hardlink = runPrepareFixture(prepareScript, {
    files: [{ name: 'kinvest.sqlite', kind: 'hardlink', owner: '1000:1000' }]
  })
  try {
    assert.equal(hardlink.result.status, 1)
    assert.match(hardlink.result.stderr, /multiple hard links/)
    assert.equal(hardlink.chownTargets().includes('kinvest.sqlite'), false)
  } finally {
    hardlink.cleanup()
  }

  const runningLegacy = runPrepareFixture(prepareScript, {
    files: [{ name: 'kinvest.sqlite', owner: '1000:1000' }],
    running: true
  })
  try {
    assert.equal(runningLegacy.result.status, 1)
    assert.match(runningLegacy.result.stderr, /Kinvest container is running.*stop it first/i)
    assert.equal(runningLegacy.chownTargets().includes('kinvest.sqlite'), false)
  } finally {
    runningLegacy.cleanup()
  }

  assert.match(dockerignore, /^\.env$/m)
  assert.match(dockerignore, /^\*\.sqlite$/m)
  assert.match(dockerignore, /^\*\.log$/m)

  const cacheMap = nginxBlock(http, 'map\\s+\\$uri\\s+\\$kinvest_cache_control')
  const connectionMap = nginxBlock(http, 'map\\s+\\$http_upgrade\\s+\\$connection_upgrade')
  const acmeLocation = nginxBlock(httpRedirectServer, 'location\\s+/\\.well-known/acme-challenge/')
  const redirectLocation = nginxBlock(httpRedirectServer, 'location\\s+/')
  const refreshLocation = nginxBlock(
    httpsServer,
    'location\\s+~\\s+\\^/api/company/\\[\\^/\\]\\+/refresh\\$'
  )
  const apiLocation = nginxBlock(httpsServer, 'location\\s+/api/')
  const assetsLocation = nginxBlock(httpsServer, 'location\\s+/assets/')
  const applicationLocation = nginxBlock(httpsServer, 'location\\s+/')
  const httpsLocations = nginxBlocks(httpsServer, 'location[^\\n{]*')

  assert.match(http, /^\s*resolver 127\.0\.0\.11 valid=10s ipv6=off;$/m)
  assert.doesNotMatch(http, /upstream\s+kinvest_app\s*\{/)
  assert.match(httpsServer, /^\s*set \$kinvest_upstream http:\/\/kinvest:4173;$/m)
  assert.doesNotMatch(httpsServer, /set \$kinvest_upstream http:\/\/kinvest:4173\//)
  assert.match(cacheMap, /^\s*default "no-store";$/m)
  assert.match(cacheMap, /^\s*~\^\/assets\/ "public, max-age=31536000, immutable";$/m)
  assert.match(cacheMap, /^\s*~\*\\\.\(\?:css\|js\|svg\|png\|jpg\|jpeg\|webp\|ico\)\$ "public, max-age=3600";$/m)
  assert.match(connectionMap, /^\s*default upgrade;$/m)
  assert.match(connectionMap, /^\s*'' close;$/m)
  assert.match(http, /^\s*limit_req_zone \$binary_remote_addr zone=kinvest_api:10m rate=10r\/s;$/m)
  assert.match(http, /^\s*limit_req_zone \$binary_remote_addr zone=kinvest_refresh:10m rate=2r\/m;$/m)
  assert.match(http, /^\s*limit_req_status 429;$/m)

  assert.match(httpDefaultServer, /^\s*listen \[::\]:80 default_server;$/m)
  assert.match(httpDefaultServer, /^\s*server_name _;$/m)
  assert.match(httpDefaultServer, /^\s*return 444;$/m)
  assert.match(httpRedirectServer, /^\s*server_name dearmina\.cn www\.dearmina\.cn;$/m)
  assert.match(acmeLocation, /^\s*root \/var\/www\/certbot;$/m)
  assert.match(acmeLocation, /^\s*try_files \$uri =404;$/m)
  assert.match(redirectLocation, /^\s*return 301 https:\/\/dearmina\.cn\$request_uri;$/m)
  assert.doesNotMatch(httpRedirectServer, /https:\/\/\$host/)

  assert.match(httpsDefaultServer, /^\s*listen \[::\]:443 ssl default_server;$/m)
  assert.match(httpsDefaultServer, /^\s*server_name _;$/m)
  assert.match(httpsDefaultServer, /^\s*ssl_certificate \/etc\/letsencrypt\/live\/dearmina\.cn\/fullchain\.pem;$/m)
  assert.match(httpsDefaultServer, /^\s*ssl_certificate_key \/etc\/letsencrypt\/live\/dearmina\.cn\/privkey\.pem;$/m)
  assert.match(httpsDefaultServer, /^\s*return 444;$/m)
  assert.match(httpsServer, /^\s*listen \[::\]:443 ssl;$/m)
  assert.match(httpsServer, /^\s*server_name dearmina\.cn www\.dearmina\.cn;$/m)
  assert.match(httpsServer, /^\s*ssl_certificate \/etc\/letsencrypt\/live\/dearmina\.cn\/fullchain\.pem;$/m)
  assert.match(httpsServer, /^\s*ssl_certificate_key \/etc\/letsencrypt\/live\/dearmina\.cn\/privkey\.pem;$/m)
  assert.match(httpsServer, /^\s*ssl_protocols TLSv1\.2 TLSv1\.3;$/m)
  assert.match(httpsServer, /^\s*client_max_body_size 1m;$/m)
  assert.match(httpsServer, /^\s*proxy_hide_header Cache-Control;$/m)
  assert.match(httpsServer, /^\s*access_log \/var\/log\/nginx\/access\.log;$/m)
  assert.match(httpsServer, /^\s*error_log \/var\/log\/nginx\/error\.log warn;$/m)

  for (const header of [
    'X-Content-Type-Options "nosniff"',
    'X-Frame-Options "DENY"',
    'Referrer-Policy "strict-origin-when-cross-origin"',
    'Permissions-Policy "camera=\\(\\), microphone=\\(\\), geolocation=\\(\\)"',
    'Content-Security-Policy "[^"]+"',
    'Strict-Transport-Security "max-age=86400"',
    'Cache-Control \\$kinvest_cache_control'
  ]) {
    assert.match(httpsServer, new RegExp(`^\\s*add_header ${header} always;$`, 'm'))
  }

  assert.ok(httpsLocations.length >= 4, 'HTTPS virtual host must contain all application locations')
  for (const location of httpsLocations) {
    assert.doesNotMatch(location, /^\s*add_header\b/m, 'locations must not override inherited security headers')
    assert.doesNotMatch(location, /^\s*expires\b/m, 'locations must use the shared cache policy map')
  }

  assert.match(refreshLocation, /^\s*limit_req zone=kinvest_refresh burst=2 nodelay;$/m)
  assert.match(apiLocation, /^\s*limit_req zone=kinvest_api burst=20 nodelay;$/m)
  assertProxyContract(refreshLocation)
  assertProxyContract(apiLocation)
  assertProxyContract(assetsLocation)
  assertProxyContract(applicationLocation, { websocket: true })

  assert.equal(
    explicitNginxCompose.trim(),
    [
      'services:',
      '  nginx:',
      '    networks:',
      '      - default',
      '      - web',
      '',
      'networks:',
      '  web:',
      '    external: true'
    ].join('\n'),
    'Explicit Nginx Compose file must only attach the existing service to the private web network'
  )
  assert.equal(
    fs.existsSync(path.join(rootDir, 'deploy/server/docker-compose.override.yml')),
    false,
    'repository-local Compose must not auto-load an incomplete Nginx override'
  )
  assert.doesNotMatch(explicitNginxCompose, /^\s*(?:ports|volumes|image|container_name):/m)

  assert.equal(
    logrotate.trim(),
    [
      '/root/docker/nginx/log/*.log {',
      '  daily',
      '  rotate 14',
      '  compress',
      '  delaycompress',
      '  missingok',
      '  notifempty',
      '  copytruncate',
      '}'
    ].join('\n'),
    'Nginx logs must rotate daily with fourteen bounded compressed copies'
  )
}

module.exports = { run }
