const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const assetNames = [
  'deploy-kinvest-v3.sh',
  'kinvest-ssh-command-v3',
  'deploy-v3-contract.py',
  'docker-compose-v3.yml',
  'kinvest-deploy-v3.sudoers'
]
const targetNames = ['deployer', 'wrapper', 'helper', 'compose', 'sudoers']

function write(filePath, contents, mode = 0o755) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents, { mode })
}

function createFixture(installer, { existingTargets = true } = {}) {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-v3-install-')))
  const source = path.join(fixture, 'source')
  const target = path.join(fixture, 'target')
  const runRoot = path.join(fixture, 'run')
  const bin = path.join(fixture, 'bin')
  fs.mkdirSync(source)
  fs.mkdirSync(target)
  fs.mkdirSync(runRoot)
  fs.mkdirSync(bin)
  write(path.join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n')
  write(path.join(bin, 'visudo'), '#!/usr/bin/env bash\nexit 0\n')
  write(path.join(bin, 'sudo'), '#!/usr/bin/env bash\nexit 0\n')
  write(
    path.join(bin, 'mv'),
    '#!/usr/bin/env bash\nset -euo pipefail\nargs=()\nfor value in "$@"; do\n  [[ "$value" == "-fT" || "$value" == "--" ]] || args+=("$value")\ndone\nexec /bin/mv -f "${args[@]}"\n'
  )
  write(path.join(source, assetNames[0]), '#!/usr/bin/env bash\nexit 0\n')
  write(path.join(source, assetNames[1]), '#!/usr/bin/env bash\nexit 0\n')
  write(path.join(source, assetNames[2]), '#!/usr/bin/env python3\nprint("ok")\n')
  write(path.join(source, assetNames[3]), 'services: {}\n', 0o644)
  write(path.join(source, assetNames[4]), 'lighthouse ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest-v2 ""\nlighthouse ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest-v3 ""\n', 0o440)
  if (existingTargets) {
    for (const name of targetNames) write(path.join(target, name), `old-${name}\n`, 0o700)
  }

  const expectedHashes = assetNames.map((name) =>
    crypto.createHash('sha256').update(fs.readFileSync(path.join(source, name))).digest('hex')
  )
  const instrumented = installer
    .replace("LOCAL_SBIN='/usr/local/sbin'", `LOCAL_SBIN='${target}'`)
    .replace("LOCAL_LIBEXEC='/usr/local/libexec'", `LOCAL_LIBEXEC='${target}'`)
    .replace("SERVER_ROOT='/root/docker/kinvest'", `SERVER_ROOT='${target}'`)
    .replace("RUN_ROOT='/run'", `RUN_ROOT='${runRoot}'`)
    .replace("SUDOERS_DIR='/etc/sudoers.d'", `SUDOERS_DIR='${target}'`)
    .replace("INSTALL_OWNER='root'", `INSTALL_OWNER='${process.getuid()}'`)
    .replace("INSTALL_GROUP='root'", `INSTALL_GROUP='${process.getgid()}'`)
    .replace('DEPLOY_TARGET="$LOCAL_SBIN/deploy-kinvest-v3"', `DEPLOY_TARGET='${path.join(target, 'deployer')}'`)
    .replace('WRAPPER_TARGET="$LOCAL_SBIN/kinvest-ssh-command"', `WRAPPER_TARGET='${path.join(target, 'wrapper')}'`)
    .replace('HELPER_TARGET="$LOCAL_LIBEXEC/kinvest-deploy-v3-contract"', `HELPER_TARGET='${path.join(target, 'helper')}'`)
    .replace('COMPOSE_TARGET="$SERVER_ROOT/docker-compose-v3.yml"', `COMPOSE_TARGET='${path.join(target, 'compose')}'`)
    .replace('SUDOERS_TARGET="$SUDOERS_DIR/kinvest-deploy-v3"', `SUDOERS_TARGET='${path.join(target, 'sudoers')}'`)
    .replace(
      /EXPECTED_ASSET_HASHES=\(\n(?: {2}'(?:[0-9a-f]{64}|__[A-Z_]+__)'\n){5}\)/,
      `EXPECTED_ASSET_HASHES=(\n${expectedHashes.map((hash) => `  '${hash}'`).join('\n')}\n)`
    )
  const script = path.join(fixture, 'install.sh')
  write(script, instrumented)
  return { fixture, source, target, runRoot, bin, script }
}

function runInstaller(context, source = context.source, script = context.script) {
  return spawnSync('bash', [script, source], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KINVEST_INSTALL_V3_TEST_ROOT: '1',
      PATH: `${context.bin}:${process.env.PATH}`
    }
  })
}

function assertOldTargets(context) {
  for (const name of targetNames) {
    assert.equal(fs.readFileSync(path.join(context.target, name), 'utf8'), `old-${name}\n`)
    assert.equal(fs.statSync(path.join(context.target, name)).mode & 0o777, 0o700)
  }
}

function backupDirectories(context) {
  const backupRoot = path.join(context.target, 'install-backups/deploy-v3')
  if (!fs.existsSync(backupRoot)) return []
  return fs.readdirSync(backupRoot).filter((name) => name.startsWith('kinvest-deploy-v3-backup.'))
}

async function run() {
  const installerPath = path.join(rootDir, 'deploy/server/install-deploy-v3.sh')
  const installer = fs.readFileSync(installerPath, 'utf8')
  assert.notEqual(fs.statSync(installerPath).mode & 0o111, 0)
  for (const asset of assetNames) assert.match(installer, new RegExp(asset.replaceAll('.', '\\.')))
  assert.match(installer, /flock/)
  assert.match(installer, /sha256sum/)
  assert.match(installer, /rollback/i)
  assert.match(installer, /mv -fT/)
  assert.match(installer, /INSTALL_OWNER='root'/)
  assert.match(installer, /INSTALL_GROUP='root'/)
  assert.match(installer, /ASSET_MODES=\('0755' '0755' '0755' '0644' '0440'\)/)
  assert.match(installer, /visudo -cf/)
  assert.match(installer, /sudo -n -U "\$DEPLOY_USER" -l/)
  assert.match(installer, /INSTALL_BACKUP_ROOT="\$SERVER_ROOT\/install-backups\/deploy-v3"/)
  const sudoers = fs.readFileSync(path.join(rootDir, 'deploy/server/kinvest-deploy-v3.sudoers'), 'utf8')
  assert.match(sudoers, /deploy-kinvest-v2 ""/)
  assert.match(sudoers, /deploy-kinvest-v3 ""/)
  assert.match(installer, /WRAPPER_TARGET="\$LOCAL_SBIN\/kinvest-ssh-command"/)
  assert.match(installer, /kinvest-deploy-v3-stage/)
  assert.match(installer, /DEPLOY_LOCK="\$SERVER_ROOT\/state\/deploy.lock"/)
  assert.doesNotMatch(installer, /systemctl restart|docker compose up|DEPLOY_V3_ENABLED/)

  const declaredHashes = [...installer.matchAll(/^ {2}'([0-9a-f]{64})'$/gm)].map((match) => match[1])
  const actualHashes = assetNames.map((name) =>
    crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(rootDir, 'deploy/server', name)))
      .digest('hex')
  )
  assert.deepEqual(declaredHashes.slice(0, assetNames.length), actualHashes)

  const syntax = spawnSync('bash', ['-n'], { encoding: 'utf8', input: installer })
  assert.equal(syntax.status, 0, syntax.stderr)

  const success = createFixture(installer)
  try {
    const result = runInstaller(success)
    assert.equal(result.status, 0, result.stderr)
    for (let index = 0; index < targetNames.length; index += 1) {
      const targetPath = path.join(success.target, targetNames[index])
      assert.equal(fs.readFileSync(targetPath, 'utf8'), fs.readFileSync(path.join(success.source, assetNames[index]), 'utf8'))
      assert.equal(fs.statSync(targetPath).mode & 0o777, [0o755, 0o755, 0o755, 0o644, 0o440][index])
    }
    assert.equal(backupDirectories(success).length, 1)
    const manifest = path.join(success.target, 'install-backups/deploy-v3', backupDirectories(success)[0], 'manifest.txt')
    const manifestLines = fs.readFileSync(manifest, 'utf8').trimEnd().split('\n')
    assert.equal(manifestLines[0], 'kinvest-deploy-v3-install-backup-v1')
    assert.equal(manifestLines.length, targetNames.length + 1)
    for (let index = 0; index < targetNames.length; index += 1) {
      const fields = manifestLines[index + 1].split('|')
      assert.equal(fields.length, 4)
      assert.equal(fields[0], targetNames[index])
      assert.equal(fields[1], 'true')
      assert.match(fields[2], /^[0-9a-f]{64}$/)
      assert.match(fields[3], /^[0-9]+:[0-9]+:700$/)
    }
  } finally {
    fs.rmSync(success.fixture, { recursive: true, force: true })
  }

  const invalidSource = createFixture(installer)
  try {
    const alias = path.join(invalidSource.fixture, 'source-alias')
    fs.symlinkSync(invalidSource.source, alias)
    assert.notEqual(runInstaller(invalidSource, alias).status, 0)
    fs.rmSync(path.join(invalidSource.source, assetNames[2]))
    fs.symlinkSync(path.join(invalidSource.source, assetNames[0]), path.join(invalidSource.source, assetNames[2]))
    assert.notEqual(runInstaller(invalidSource).status, 0)
    assertOldTargets(invalidSource)
  } finally {
    fs.rmSync(invalidSource.fixture, { recursive: true, force: true })
  }

  const invalidHelper = createFixture(installer)
  try {
    write(path.join(invalidHelper.source, assetNames[2]), 'this is not valid Python !!!\n')
    assert.notEqual(runInstaller(invalidHelper).status, 0)
    assertOldTargets(invalidHelper)
    assert.deepEqual(
      fs.readdirSync(invalidHelper.runRoot).filter((name) => name.startsWith('kinvest-deploy-v3-pycache.')),
      []
    )
  } finally {
    fs.rmSync(invalidHelper.fixture, { recursive: true, force: true })
  }

  const replacementLines = [
    'mv -fT -- "$deploy_temporary" "$DEPLOY_TARGET"',
    'mv -fT -- "$helper_temporary" "$HELPER_TARGET"',
    'mv -fT -- "$compose_temporary" "$COMPOSE_TARGET"',
    'mv -fT -- "$sudoers_temporary" "$SUDOERS_TARGET"',
    'mv -fT -- "$wrapper_temporary" "$WRAPPER_TARGET"'
  ]
  for (const replacementLine of replacementLines) {
    const failure = createFixture(installer)
    try {
      const failedScript = path.join(failure.fixture, 'install-fails.sh')
      write(failedScript, fs.readFileSync(failure.script, 'utf8').replace(replacementLine, 'false # injected installation failure'))
      const result = runInstaller(failure, failure.source, failedScript)
      assert.notEqual(result.status, 0, `expected failure at ${replacementLine}`)
      assertOldTargets(failure)
      assert.equal(backupDirectories(failure).length, 1)
    } finally {
      fs.rmSync(failure.fixture, { recursive: true, force: true })
    }
  }

  const absent = createFixture(installer, { existingTargets: false })
  try {
    const failedScript = path.join(absent.fixture, 'install-fails.sh')
    write(failedScript, fs.readFileSync(absent.script, 'utf8').replace(replacementLines[3], 'false # injected installation failure'))
    assert.notEqual(runInstaller(absent, absent.source, failedScript).status, 0)
    for (const name of targetNames) assert.equal(fs.existsSync(path.join(absent.target, name)), false)
    assert.equal(backupDirectories(absent).length, 1)
  } finally {
    fs.rmSync(absent.fixture, { recursive: true, force: true })
  }

  const rollbackFailure = createFixture(installer)
  try {
    const failedScript = path.join(rollbackFailure.fixture, 'rollback-fails.sh')
    const failedInstaller = fs.readFileSync(rollbackFailure.script, 'utf8')
      .replace(replacementLines[3], 'false # injected installation failure')
      .replace(
        'elif ! mv -fT -- "$restore_temporary" "$target"; then',
        'elif ! false; then # injected rollback failure'
      )
    write(failedScript, failedInstaller)
    const result = runInstaller(rollbackFailure, rollbackFailure.source, failedScript)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /recovery backup preserved at /)
    assert.equal(backupDirectories(rollbackFailure).length, 1)
  } finally {
    fs.rmSync(rollbackFailure.fixture, { recursive: true, force: true })
  }
}

module.exports = { run }
