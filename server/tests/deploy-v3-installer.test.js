const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const assetNames = [
  'deploy-kinvest-v2.sh',
  'secret-version-config.py',
  'offline-image-attestation.py',
  'deploy-kinvest-v3.sh',
  'kinvest-ssh-command-v3',
  'deploy-v3-contract.py',
  'docker-compose-v3.yml',
  'kinvest-deploy-v4.sudoers.in'
]
const targetNames = ['v2-deployer', 'validator', 'attestation', 'deployer', 'wrapper', 'helper', 'compose', 'sudoers']

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
  const fsyncTrace = path.join(fixture, 'fsync.trace')
  fs.mkdirSync(source)
  fs.mkdirSync(target)
  fs.mkdirSync(runRoot)
  fs.mkdirSync(bin)
  write(path.join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n')
  write(path.join(bin, 'visudo'), '#!/usr/bin/env bash\nexit 0\n')
  write(path.join(bin, 'sudo'), '#!/usr/bin/env bash\n[[ -z "${SUDO_LOG:-}" ]] || printf \'%s\\n\' "$*" >>"$SUDO_LOG"\nexit 0\n')
  write(path.join(bin, 'getent'), `#!/usr/bin/env bash
if [[ "$1" == passwd && "$2" == lighthouse ]]; then printf 'lighthouse:x:%s:%s:Deploy:/nonexistent:/usr/sbin/nologin\\n' '${Math.max(process.getuid(), 1)}' '${process.getgid()}'; exit 0; fi
if [[ "$1" == group && "$2" == lighthouse ]]; then printf 'lighthouse:x:%s:\\n' '${process.getgid()}'; exit 0; fi
exit 2
`)
  write(path.join(bin, 'id'), `#!/usr/bin/env bash
if [[ "$1" == -G && "$2" == lighthouse ]]; then printf '%s\\n' '${process.getgid()}'; exit 0; fi
exec /usr/bin/id "$@"
`)
  write(
    path.join(bin, 'mv'),
    '#!/usr/bin/env bash\nset -euo pipefail\nargs=()\nfor value in "$@"; do\n  [[ "$value" == "-fT" || "$value" == "--" ]] || args+=("$value")\ndone\ncount="${#args[@]}"\nsource="${args[$((count - 2))]}"\ntarget="${args[$((count - 1))]}"\n[[ -z "${FSYNC_TRACE:-}" ]] || printf \'rename:%s:%s\\n\' "$source" "$target" >>"$FSYNC_TRACE"\nexec /bin/mv -f "${args[@]}"\n'
  )
  write(path.join(source, assetNames[0]), '#!/usr/bin/env bash\nexit 0\n')
  write(path.join(source, assetNames[1]), '#!/usr/bin/env python3\nimport sys\nprint("{}")\n')
  write(path.join(source, assetNames[2]), '#!/usr/bin/env python3\nimport sys\nprint("KINVEST_OFFLINE_ATTESTATION_SELF_CHECK_OK")\n')
  write(path.join(source, assetNames[3]), '#!/usr/bin/env bash\nexit 0\n')
  write(path.join(source, assetNames[4]), fs.readFileSync(path.join(rootDir, 'deploy/server/kinvest-ssh-command-v3'), 'utf8'))
  write(path.join(source, assetNames[5]), '#!/usr/bin/env python3\nprint("ok")\n')
  write(path.join(source, assetNames[6]), 'services: {}\n', 0o644)
  write(path.join(source, assetNames[7]), '@KINVEST_DEPLOY_GATE_USER@ ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest ""\n@KINVEST_DEPLOY_GATE_USER@ ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest-v3 ""\n@KINVEST_DEPLOY_GATE_USER@ ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest-v4 ""\n', 0o440)
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
    .replace("GATE_STATE_DIR='/var/lib/kinvest-deploy-gate'", `GATE_STATE_DIR='${path.join(fixture, 'gate-state')}'`)
    .replace("GATE_ROOT_OWNER='0:0'", `GATE_ROOT_OWNER='${process.getuid()}:${process.getgid()}'`)
    .replaceAll('-o root -g "$GATE_GROUP"', `-o ${process.getuid()} -g ${process.getgid()}`)
    .replaceAll('chown root:"$GATE_GROUP"', `chown ${process.getuid()}:${process.getgid()}`)
    .replace('fsync_file() {', `fsync_file() {
  printf 'file:%s\\n' "$1" >>'${fsyncTrace}'`)
    .replace('fsync_directory() {', `fsync_directory() {
  printf 'dir:%s\\n' "$1" >>'${fsyncTrace}'`)
    .replace('clear_install_journal() {', `clear_install_journal() {
  printf 'journal-clear\\n' >>'${fsyncTrace}'`)
    .replace('clear_gate_marker() {', `clear_gate_marker() {
  printf 'marker-clear\\n' >>'${fsyncTrace}'`)
    .replace("INSTALL_OWNER='root'", `INSTALL_OWNER='${process.getuid()}'`)
    .replace("INSTALL_GROUP='root'", `INSTALL_GROUP='${process.getgid()}'`)
    .replace('V2_DEPLOY_TARGET="$LOCAL_SBIN/deploy-kinvest"', `V2_DEPLOY_TARGET='${path.join(target, 'v2-deployer')}'`)
    .replace('V2_VALIDATOR_TARGET="$LOCAL_LIBEXEC/kinvest-secret-version-config"', `V2_VALIDATOR_TARGET='${path.join(target, 'validator')}'`)
    .replace('V2_ATTESTATION_TARGET="$LOCAL_LIBEXEC/kinvest-offline-image-attestation"', `V2_ATTESTATION_TARGET='${path.join(target, 'attestation')}'`)
    .replace('DEPLOY_TARGET="$LOCAL_SBIN/deploy-kinvest-v3"', `DEPLOY_TARGET='${path.join(target, 'deployer')}'`)
    .replace('WRAPPER_TARGET="$LOCAL_SBIN/kinvest-ssh-command"', `WRAPPER_TARGET='${path.join(target, 'wrapper')}'`)
    .replace('HELPER_TARGET="$LOCAL_LIBEXEC/kinvest-deploy-v3-contract"', `HELPER_TARGET='${path.join(target, 'helper')}'`)
    .replace('COMPOSE_TARGET="$SERVER_ROOT/docker-compose-v3.yml"', `COMPOSE_TARGET='${path.join(target, 'compose')}'`)
    .replace('SUDOERS_TARGET="$SUDOERS_DIR/kinvest-deploy-v3"', `SUDOERS_TARGET='${path.join(target, 'sudoers')}'`)
    .replace(
      /EXPECTED_ASSET_HASHES=\(\n(?: {2}'(?:[0-9a-f]{64}|__[A-Z_]+__)'\n){8}\)/,
      `EXPECTED_ASSET_HASHES=(\n${expectedHashes.map((hash) => `  '${hash}'`).join('\n')}\n)`
    )
  const script = path.join(fixture, 'install.sh')
  write(script, instrumented)
  return { fixture, source, target, runRoot, bin, script, fsyncTrace }
}

function runInstaller(context, source = context.source, script = context.script, overrides = {}) {
  return spawnSync('bash', [script, source], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KINVEST_INSTALL_V3_TEST_ROOT: '1',
      KINVEST_DEPLOY_GATE_USER: 'lighthouse',
      KINVEST_DEPLOY_GATE_GROUP: 'lighthouse',
      SUDO_LOG: path.join(context.fixture, 'sudo.log'),
      FSYNC_TRACE: context.fsyncTrace,
      PATH: `${context.bin}:${process.env.PATH}`,
      ...overrides
    }
  })
}

function assertOldTargets(context) {
  for (const name of targetNames) {
    assert.equal(fs.readFileSync(path.join(context.target, name), 'utf8'), `old-${name}\n`)
    assert.equal(fs.statSync(path.join(context.target, name)).mode & 0o777, 0o700)
  }
}

function assertNewTargets(context) {
  for (let index = 0; index < targetNames.length; index += 1) {
    const source = fs.readFileSync(path.join(context.source, assetNames[index]), 'utf8')
    const expected = index === 7
      ? source.replaceAll('@KINVEST_DEPLOY_GATE_USER@', 'lighthouse')
      : source
    assert.equal(fs.readFileSync(path.join(context.target, targetNames[index]), 'utf8'), expected)
  }
}

function runGate(context, command = 'deploy-v3') {
  const gateHarness = path.join(context.fixture, 'gate-harness')
  const source = fs.readFileSync(path.join(context.source, 'kinvest-ssh-command-v3'), 'utf8')
    .replace("GATE_STATE_DIR='/var/lib/kinvest-deploy-gate'", `GATE_STATE_DIR='${path.join(context.fixture, 'gate-state')}'`)
    .replace('/usr/bin/flock', path.join(context.bin, 'flock'))
    .replaceAll('/usr/bin/sudo', path.join(context.bin, 'sudo'))
    .replaceAll('directory_info.st_uid != 0', `directory_info.st_uid != ${process.getuid()}`)
    .replaceAll('marker_info.st_uid != 0', `marker_info.st_uid != ${process.getuid()}`)
  write(gateHarness, source)
  return spawnSync(gateHarness, [], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${context.bin}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: command }
  })
}

function backupDirectories(context) {
  const backupRoot = path.join(context.target, 'install-backups/deploy-v3')
  if (!fs.existsSync(backupRoot)) return []
  return fs.readdirSync(backupRoot).filter((name) => name.startsWith('kinvest-deploy-v3-backup.'))
}

function installJournal(context) {
  return path.join(context.target, 'state/install-v3.journal')
}

function assertDurableTargetRenames(context) {
  const trace = fs.readFileSync(context.fsyncTrace, 'utf8').trimEnd().split('\n')
  for (const targetName of targetNames) {
    const target = path.join(context.target, targetName)
    const renameIndex = trace.findIndex((entry) => entry.startsWith('rename:') && entry.endsWith(`:${target}`))
    assert.ok(renameIndex >= 0, `missing rename: ${targetName}`)
    const temporary = trace[renameIndex].slice('rename:'.length, -(target.length + 1))
    assert.ok(trace.lastIndexOf(`file:${temporary}`, renameIndex) >= 0, `missing temp fsync: ${targetName}`)
    assert.ok(trace.slice(renameIndex + 1).includes(`dir:${path.dirname(target)}`), `missing parent fsync: ${targetName}`)
  }
  const journal = installJournal(context)
  const firstJournalRename = trace.findIndex((entry) => entry.startsWith('rename:') && entry.endsWith(`:${journal}`))
  assert.ok(firstJournalRename > 0)
  assert.ok(trace.slice(0, firstJournalRename).some((entry) => /file:.*manifest\.txt$/.test(entry)))
  assert.ok(trace.slice(0, firstJournalRename).some((entry) => /dir:.*kinvest-deploy-v3-backup\./.test(entry)))
  assert.ok(trace.slice(0, firstJournalRename).includes(`dir:${path.join(context.target, 'install-backups/deploy-v3')}`))
  const journalClear = trace.lastIndexOf('journal-clear')
  const markerClear = trace.lastIndexOf('marker-clear')
  assert.ok(journalClear > firstJournalRename && markerClear > journalClear)
  assert.ok(trace.lastIndexOf(`dir:${path.join(context.target, 'state')}`, markerClear) > journalClear)
  assert.ok(trace.slice(markerClear + 1).includes(`dir:${path.join(context.fixture, 'gate-state')}`))
}

function waitFor(check, timeoutMs = 3000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for v3 installer'))
      setTimeout(poll, 10)
    }
    poll()
  })
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('v3 installer did not exit')) }, timeoutMs)
    child.once('exit', (status, signal) => { clearTimeout(timeout); resolve({ status, signal }) })
  })
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
  assert.match(installer, /ASSET_MODES=\('0755' '0755' '0755' '0755' '0755' '0755' '0644' '0440'\)/)
  assert.doesNotMatch(installer, /^DEPLOY_USER='kinvest-deploy'$/m)
  assert.match(installer, /KINVEST_DEPLOY_GATE_USER:-/)
  assert.match(installer, /KINVEST_DEPLOY_GATE_GROUP:-/)
  assert.match(installer, /visudo -cf/)
  assert.match(installer, /^DEPLOY_TARGET="\$LOCAL_SBIN\/deploy-kinvest-v3"$/m)
  for (const command of ['deploy-kinvest', 'deploy-kinvest-v3', 'deploy-kinvest-v4']) {
    assert.match(installer, new RegExp(`sudo -n -U "\\$GATE_USER" -l "\\$LOCAL_SBIN/${command}"`))
  }
  assert.doesNotMatch(installer, /\/usr\/local\/sbin\/deploy-kinvest-v2|\$LOCAL_SBIN\/deploy-kinvest-v2/)
  assert.match(installer, /INSTALL_BACKUP_ROOT="\$SERVER_ROOT\/install-backups\/deploy-v3"/)
  const sudoers = fs.readFileSync(path.join(rootDir, 'deploy/server/kinvest-deploy-v4.sudoers.in'), 'utf8')
  assert.equal(
    sudoers,
    '@KINVEST_DEPLOY_GATE_USER@ ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest ""\n' +
      '@KINVEST_DEPLOY_GATE_USER@ ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest-v3 ""\n' +
      '@KINVEST_DEPLOY_GATE_USER@ ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest-v4 ""\n'
  )
  assert.doesNotMatch(sudoers, /\*/)
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

  const missingIdentity = createFixture(installer)
  try {
    const result = spawnSync('bash', [missingIdentity.script, missingIdentity.source], {
      encoding: 'utf8',
      env: { ...process.env, KINVEST_INSTALL_V3_TEST_ROOT: '1', PATH: `${missingIdentity.bin}:${process.env.PATH}` }
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /DEPLOY_V3_GATE_IDENTITY_REQUIRED/)
  } finally {
    fs.rmSync(missingIdentity.fixture, { recursive: true, force: true })
  }

  const injectedIdentity = createFixture(installer)
  try {
    const result = runInstaller(injectedIdentity, injectedIdentity.source, injectedIdentity.script, {
      KINVEST_DEPLOY_GATE_USER: 'lighthouse ALL=(ALL) NOPASSWD: ALL'
    })
    assert.notEqual(result.status, 0)
  } finally {
    fs.rmSync(injectedIdentity.fixture, { recursive: true, force: true })
  }

  const success = createFixture(installer)
  try {
    const result = runInstaller(success)
    assert.equal(result.status, 0, result.stderr)
    const expectedModes = [0o755, 0o755, 0o755, 0o755, 0o755, 0o755, 0o644, 0o440]
    for (let index = 0; index < targetNames.length; index += 1) {
      const targetPath = path.join(success.target, targetNames[index])
      if (index !== 7) assert.equal(fs.readFileSync(targetPath, 'utf8'), fs.readFileSync(path.join(success.source, assetNames[index]), 'utf8'))
      assert.equal(fs.statSync(targetPath).mode & 0o777, expectedModes[index])
    }
    assert.equal(backupDirectories(success).length, 1)
    assert.equal(fs.readFileSync(path.join(success.target, 'sudoers'), 'utf8'),
      'lighthouse ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest ""\n' +
      'lighthouse ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest-v3 ""\n' +
      'lighthouse ALL=(root) NOPASSWD: /usr/local/sbin/deploy-kinvest-v4 ""\n')
    const gateState = path.join(success.fixture, 'gate-state')
    assert.equal(fs.statSync(gateState).mode & 0o777, 0o750)
    assert.equal(fs.readFileSync(path.join(gateState, 'identity'), 'utf8'), `user=lighthouse\ngroup=lighthouse\ngid=${process.getgid()}\n`)
    assertDurableTargetRenames(success)
    const sudoCalls = fs.readFileSync(path.join(success.fixture, 'sudo.log'), 'utf8').trimEnd().split('\n')
    assert.deepEqual(sudoCalls, [
      `-n -U lighthouse -l ${path.join(success.target, 'deploy-kinvest')}`,
      `-n -U lighthouse -l ${path.join(success.target, 'deploy-kinvest-v3')}`,
      `-n -U lighthouse -l ${path.join(success.target, 'deploy-kinvest-v4')}`
    ])
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

  const clean = createFixture(installer, { existingTargets: false })
  try {
    const result = runInstaller(clean)
    assert.equal(result.status, 0, result.stderr)
    const gateHarness = path.join(clean.fixture, 'gate-harness')
    const gateState = path.join(clean.fixture, 'gate-state')
    const gateSource = fs.readFileSync(path.join(clean.target, 'wrapper'), 'utf8')
      .replace("GATE_STATE_DIR='/var/lib/kinvest-deploy-gate'", `GATE_STATE_DIR='${gateState}'`)
      .replace('/usr/bin/flock', path.join(clean.bin, 'flock'))
      .replaceAll('/usr/bin/sudo', path.join(clean.bin, 'sudo'))
      .replaceAll('directory_info.st_uid != 0', `directory_info.st_uid != ${process.getuid()}`)
      .replaceAll('marker_info.st_uid != 0', `marker_info.st_uid != ${process.getuid()}`)
      .replace('/usr/local/sbin/deploy-kinvest-v3', path.join(clean.target, 'deployer'))
      .replace('/usr/local/sbin/deploy-kinvest', path.join(clean.target, 'v2-deployer'))
    write(gateHarness, gateSource)
    const gateBin = path.join(clean.fixture, 'gate-bin')
    fs.mkdirSync(gateBin)
    write(path.join(gateBin, 'sudo'), '#!/usr/bin/env bash\n[[ "$1" == -n ]] && shift\n[[ -x "$1" ]]\n')
    for (const command of ['deploy-v2', 'deploy-v3']) {
      const delegated = spawnSync(gateHarness, [], {
        encoding: 'utf8', env: { ...process.env, PATH: `${gateBin}:${clean.bin}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: command }
      })
      assert.equal(delegated.status, 0, `${command}: ${delegated.stderr}`)
    }
  } finally {
    fs.rmSync(clean.fixture, { recursive: true, force: true })
  }

  const activeInstall = createFixture(installer)
  try {
    const ready = path.join(activeInstall.fixture, 'marker-ready')
    const release = path.join(activeInstall.fixture, 'marker-release')
    const pausedScript = path.join(activeInstall.fixture, 'paused-install.sh')
    write(pausedScript, fs.readFileSync(activeInstall.script, 'utf8').replace(
      "publish_gate_marker || fail 'DEPLOY_V3_GATE_MARKER_FAILED'",
      `publish_gate_marker || fail 'DEPLOY_V3_GATE_MARKER_FAILED'\n: >'${ready}'\nwhile [[ ! -e '${release}' ]]; do sleep 0.01; done`
    ))
    const child = spawn('bash', [pausedScript, activeInstall.source], {
      stdio: 'ignore',
      env: {
        ...process.env, KINVEST_INSTALL_V3_TEST_ROOT: '1',
        KINVEST_DEPLOY_GATE_USER: 'lighthouse', KINVEST_DEPLOY_GATE_GROUP: 'lighthouse',
        PATH: `${activeInstall.bin}:${process.env.PATH}`
      }
    })
    await waitFor(() => fs.existsSync(ready))
    const gateHarness = path.join(activeInstall.fixture, 'active-gate')
    const source = fs.readFileSync(path.join(activeInstall.source, 'kinvest-ssh-command-v3'), 'utf8')
      .replace("GATE_STATE_DIR='/var/lib/kinvest-deploy-gate'", `GATE_STATE_DIR='${path.join(activeInstall.fixture, 'gate-state')}'`)
      .replace('/usr/bin/flock', path.join(activeInstall.bin, 'flock'))
      .replaceAll('/usr/bin/sudo', path.join(activeInstall.bin, 'sudo'))
      .replaceAll('directory_info.st_uid != 0', `directory_info.st_uid != ${process.getuid()}`)
      .replaceAll('marker_info.st_uid != 0', `marker_info.st_uid != ${process.getuid()}`)
    write(gateHarness, source)
    const blocked = spawnSync(gateHarness, [], {
      encoding: 'utf8', env: { ...process.env, PATH: `${activeInstall.bin}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: 'deploy-v3' }
    })
    assert.equal(blocked.status, 76)
    assert.equal(blocked.stderr, 'DEPLOY_INSTALL_INCOMPLETE\n')
    fs.writeFileSync(release, '')
    assert.deepEqual(await waitForExit(child), { status: 0, signal: null })
  } finally {
    fs.rmSync(activeInstall.fixture, { recursive: true, force: true })
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
    'mv -fT -- "$v2_deploy_temporary" "$V2_DEPLOY_TARGET"',
    'mv -fT -- "$v2_validator_temporary" "$V2_VALIDATOR_TARGET"',
    'mv -fT -- "$v2_attestation_temporary" "$V2_ATTESTATION_TARGET"',
    'mv -fT -- "$deploy_temporary" "$DEPLOY_TARGET"',
    'mv -fT -- "$helper_temporary" "$HELPER_TARGET"',
    'mv -fT -- "$compose_temporary" "$COMPOSE_TARGET"',
    'mv -fT -- "$sudoers_temporary" "$SUDOERS_TARGET"',
    'mv -fT -- "$wrapper_temporary" "$WRAPPER_TARGET"'
  ]
  const postcheckFaultAnchor = '# test-fault-anchor: deploy-v3-postcheck-complete'
  assert.equal(installer.split(postcheckFaultAnchor).length - 1, 1)

  for (const markerWindow of ['before-journal', 'after-journal-clear']) {
    const interrupted = createFixture(installer)
    try {
      const killedScript = path.join(interrupted.fixture, `marker-only-${markerWindow}.sh`)
      const baseScript = fs.readFileSync(interrupted.script, 'utf8')
      const injectionPoint = markerWindow === 'before-journal'
        ? "publish_gate_marker || fail 'DEPLOY_V3_GATE_MARKER_FAILED'"
        : '  clear_gate_marker\n}'
      const injected = markerWindow === 'before-journal'
        ? `${injectionPoint}\nkill -KILL $$ # injected marker-only before journal`
        : '  kill -KILL $$ # injected marker-only after journal clear\n  clear_gate_marker\n}'
      const killedSource = baseScript.replace(injectionPoint, () => injected)
      assert.notEqual(killedSource, baseScript, markerWindow)
      write(killedScript, killedSource)

      const killed = runInstaller(interrupted, interrupted.source, killedScript)
      assert.equal(killed.signal, 'SIGKILL', markerWindow)
      assert.equal(fs.existsSync(installJournal(interrupted)), false, markerWindow)
      assert.equal(fs.readFileSync(path.join(interrupted.fixture, 'gate-state/install-incomplete'), 'utf8'), 'ACTIVE\n', markerWindow)
      if (markerWindow === 'before-journal') assertOldTargets(interrupted)
      else assertNewTargets(interrupted)

      const reconciled = runInstaller(interrupted)
      assert.equal(reconciled.status, 75, `${markerWindow}: ${reconciled.stderr}`)
      assert.match(reconciled.stderr, /DEPLOY_V3_INSTALL_RECONCILED_RETRY_REQUIRED/, markerWindow)
      assert.equal(fs.existsSync(path.join(interrupted.fixture, 'gate-state/install-incomplete')), false, markerWindow)
      assert.equal(runGate(interrupted).status, 0, markerWindow)

      const installed = runInstaller(interrupted)
      assert.equal(installed.status, 0, `${markerWindow}: ${installed.stderr}`)
      assertNewTargets(interrupted)
    } finally {
      fs.rmSync(interrupted.fixture, { recursive: true, force: true })
    }
  }

  for (const [stage, injectionLine] of [...replacementLines.map((line, index) => [`replace-${index}`, line]), ['postcheck', postcheckFaultAnchor]]) {
    const interrupted = createFixture(installer)
    try {
      const killedScript = path.join(interrupted.fixture, `kill-${stage}.sh`)
      const baseScript = fs.readFileSync(interrupted.script, 'utf8')
      const injectedScript = baseScript.replace(
        injectionLine,
        () => `${injectionLine}\nkill -KILL $$ # injected ${stage}`
      )
      assert.notEqual(injectedScript, baseScript, `missing injection point: ${stage}`)
      write(killedScript, injectedScript)
      const killed = runInstaller(interrupted, interrupted.source, killedScript)
      assert.equal(killed.signal, 'SIGKILL', `${stage}: status=${killed.status} stderr=${killed.stderr}`)
      assert.equal(fs.existsSync(installJournal(interrupted)), true, stage)
      assert.equal(fs.readFileSync(path.join(interrupted.fixture, 'gate-state/install-incomplete'), 'utf8'), 'ACTIVE\n', stage)
      if (stage === 'postcheck') assertNewTargets(interrupted)
      const journalText = fs.readFileSync(installJournal(interrupted), 'utf8')
      assert.match(journalText, /^version=1$/m, stage)
      assert.match(journalText, new RegExp(`^stage=${stage}$`, 'm'), stage)
      assert.match(journalText, /^backup=.*kinvest-deploy-v3-backup\.[A-Za-z0-9]{6}$/m, stage)
      assert.match(journalText, /^manifestHash=[0-9a-f]{64}$/m, stage)
      assert.match(journalText, /^gateUser=lighthouse$/m, stage)
      assert.match(journalText, /^gateGroup=lighthouse$/m, stage)
      assert.doesNotMatch(journalText, /password|token|secret/i, stage)

      const reconciled = runInstaller(interrupted)
      assert.notEqual(reconciled.status, 0, stage)
      assert.match(reconciled.stderr, /DEPLOY_V3_INSTALL_RECONCILED_RETRY_REQUIRED/, stage)
      assertOldTargets(interrupted)
      assert.equal(fs.existsSync(installJournal(interrupted)), false, stage)
      assert.equal(fs.existsSync(path.join(interrupted.fixture, 'gate-state/install-incomplete')), false, stage)

      const installed = runInstaller(interrupted)
      assert.equal(installed.status, 0, `${stage}: ${installed.stderr}`)
      for (let index = 0; index < targetNames.length; index += 1) {
        const expected = index === 7
          ? fs.readFileSync(path.join(interrupted.target, 'sudoers'), 'utf8')
          : fs.readFileSync(path.join(interrupted.source, assetNames[index]), 'utf8')
        assert.equal(fs.readFileSync(path.join(interrupted.target, targetNames[index]), 'utf8'), expected, `${stage}:${targetNames[index]}`)
      }
    } finally {
      fs.rmSync(interrupted.fixture, { recursive: true, force: true })
    }
  }

  for (const corruption of ['journal-mode', 'backup-path', 'manifest-hash']) {
    const invalidJournal = createFixture(installer)
    try {
      const killedScript = path.join(invalidJournal.fixture, `invalid-${corruption}.sh`)
      const baseScript = fs.readFileSync(invalidJournal.script, 'utf8')
      write(killedScript, baseScript.replace(replacementLines[0], () => `${replacementLines[0]}\nkill -KILL $$`))
      assert.equal(runInstaller(invalidJournal, invalidJournal.source, killedScript).signal, 'SIGKILL')
      const journal = installJournal(invalidJournal)
      if (corruption === 'journal-mode') fs.chmodSync(journal, 0o644)
      if (corruption === 'backup-path') {
        fs.writeFileSync(journal, fs.readFileSync(journal, 'utf8').replace(/^backup=.*$/m, `backup=${invalidJournal.fixture}/outside`), { mode: 0o600 })
      }
      if (corruption === 'manifest-hash') {
        const backup = fs.readFileSync(journal, 'utf8').match(/^backup=(.*)$/m)[1]
        fs.appendFileSync(path.join(backup, 'manifest.txt'), 'tampered\n')
      }
      const result = runInstaller(invalidJournal)
      assert.notEqual(result.status, 0, corruption)
      assert.match(result.stderr, /DEPLOY_V3_INSTALL_JOURNAL_INVALID/, corruption)
      assert.equal(fs.existsSync(journal), true, corruption)
      assert.equal(fs.existsSync(path.join(invalidJournal.fixture, 'gate-state/install-incomplete')), true, corruption)
    } finally {
      fs.rmSync(invalidJournal.fixture, { recursive: true, force: true })
    }
  }
  for (const replacementLine of replacementLines) {
    const failure = createFixture(installer)
    try {
      const failedScript = path.join(failure.fixture, 'install-fails.sh')
      write(failedScript, fs.readFileSync(failure.script, 'utf8').replace(replacementLine, 'false # injected installation failure'))
      const result = runInstaller(failure, failure.source, failedScript)
      assert.notEqual(result.status, 0, `expected failure at ${replacementLine}`)
      assertOldTargets(failure)
      assert.equal(fs.existsSync(installJournal(failure)), false)
      assert.equal(fs.existsSync(path.join(failure.fixture, 'gate-state/install-incomplete')), false)
      assert.equal(backupDirectories(failure).length, 1)
    } finally {
      fs.rmSync(failure.fixture, { recursive: true, force: true })
    }
  }

  const postcheckFailure = createFixture(installer)
  try {
    const failedScript = path.join(postcheckFailure.fixture, 'postcheck-fails.sh')
    const postcheckHit = path.join(postcheckFailure.fixture, 'postcheck-hit')
    write(failedScript, fs.readFileSync(postcheckFailure.script, 'utf8').replace(
      postcheckFaultAnchor,
      `: >'${postcheckHit}'\nfalse # injected final installed postcheck failure`
    ))
    assert.notEqual(runInstaller(postcheckFailure, postcheckFailure.source, failedScript).status, 0)
    assert.equal(fs.existsSync(postcheckHit), true)
    assertOldTargets(postcheckFailure)
    assert.equal(fs.existsSync(installJournal(postcheckFailure)), false)
    assert.equal(fs.existsSync(path.join(postcheckFailure.fixture, 'gate-state/install-incomplete')), false)
  } finally {
    fs.rmSync(postcheckFailure.fixture, { recursive: true, force: true })
  }

  const v4Journal = createFixture(installer)
  try {
    const journal = path.join(v4Journal.target, 'state/install-v4.journal')
    fs.mkdirSync(path.dirname(journal), { recursive: true })
    fs.writeFileSync(journal, 'private-v4\n', { mode: 0o600 })
    const result = runInstaller(v4Journal)
    assert.equal(result.status, 76)
    assert.match(result.stderr, /DEPLOY_INSTALL_INCOMPLETE/)
    assert.equal(fs.existsSync(journal), true)
    assertOldTargets(v4Journal)
  } finally {
    fs.rmSync(v4Journal.fixture, { recursive: true, force: true })
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
