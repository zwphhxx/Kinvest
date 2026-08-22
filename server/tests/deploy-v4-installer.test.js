const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const rootDir = path.resolve(__dirname, '../..')
const sourceDir = path.join(rootDir, 'deploy/server')
const installerSource = fs.readFileSync(path.join(sourceDir, 'install-deploy-v4.sh'), 'utf8')

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function fixture({ existing = true, replaceFailure = null, postFailure = false, rollbackPause = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-v4-installer-'))
  const sbin = path.join(base, 'sbin')
  const libexec = path.join(base, 'libexec')
  const serverRoot = path.join(base, 'server')
  const sudoers = path.join(base, 'sudoers')
  const runRoot = path.join(base, 'run')
  const bin = path.join(base, 'bin')
  const eventLog = path.join(base, 'events.log')
  const lockDir = path.join(base, 'deploy.lock.held')
  const lockRelease = path.join(base, 'lock.release')
  const rollbackMarker = path.join(base, 'rollback.started')
  const rollbackRelease = path.join(base, 'rollback.release')
  for (const directory of [sbin, libexec, serverRoot, path.join(serverRoot, 'state'), sudoers, runRoot, bin]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  writeExecutable(path.join(bin, 'flock'), `#!/usr/bin/env bash
if [[ -z "\${INSTALL_LOCK_DIR:-}" ]]; then exit 0; fi
if mkdir "$INSTALL_LOCK_DIR" 2>/dev/null; then
  printf '%s:lock\\n' "$INSTALLER_ID" >>"$INSTALL_EVENTS"
  if [[ "\${HOLD_INSTALL_LOCK:-}" == 1 ]]; then
    while [[ ! -e "$INSTALL_LOCK_RELEASE" ]]; do sleep 0.01; done
  fi
  exit 0
fi
printf '%s:contended\\n' "$INSTALLER_ID" >>"$INSTALL_EVENTS"
exit 1
`)
  writeExecutable(path.join(bin, 'sha256sum'), `#!/usr/bin/env bash
for argument in "$@"; do
  if [[ -n "\${INSTALL_TARGET_ROOT:-}" && "$argument" == "$INSTALL_TARGET_ROOT"* ]]; then
    printf '%s:target-read\\n' "$INSTALLER_ID" >>"$INSTALL_EVENTS"
  fi
done
exec "$REAL_SHA256SUM" "$@"
`)
  writeExecutable(path.join(bin, 'sudo'), '#!/bin/sh\nexit 0\n')
  writeExecutable(path.join(bin, 'visudo'), '#!/bin/sh\nexit 0\n')
  writeExecutable(path.join(bin, 'realpath'), '#!/bin/sh\n[ "${1:-}" = -e ] && shift\nprintf \'%s\\n\' "$1"\n')
  writeExecutable(path.join(bin, 'mv'), '#!/usr/bin/env bash\nargs=()\nfor arg in "$@"; do [[ "$arg" == -fT ]] || args+=("$arg"); done\nexec /bin/mv -f "${args[@]}"\n')

  const targets = [
    path.join(sbin, 'deploy-kinvest-v4'),
    path.join(sbin, 'deploy-kinvest-v3'),
    path.join(sbin, 'kinvest-ssh-command'),
    path.join(libexec, 'kinvest-deploy-v4-contract'),
    path.join(serverRoot, 'docker-compose-v4.yml'),
    path.join(sudoers, 'kinvest-deploy-v4'),
    path.join(serverRoot, 'access-control-network.conf.example')
  ]
  if (existing) {
    for (let index = 0; index < targets.length; index += 1) {
      fs.writeFileSync(targets[index], `old-${index}\n`, { mode: 0o700 })
    }
  }

  let instrumented = installerSource
    .replace("LOCAL_SBIN='/usr/local/sbin'", `LOCAL_SBIN='${sbin}'`)
    .replace("LOCAL_LIBEXEC='/usr/local/libexec'", `LOCAL_LIBEXEC='${libexec}'`)
    .replace("SERVER_ROOT='/root/docker/kinvest'", `SERVER_ROOT='${serverRoot}'`)
    .replace("SUDOERS_DIR='/etc/sudoers.d'", `SUDOERS_DIR='${sudoers}'`)
    .replace("RUN_ROOT='/run'", `RUN_ROOT='${runRoot}'`)
    .replace('[[ "$(id -u)" -eq 0 ]]', '[[ "${KINVEST_INSTALL_V4_TEST_ROOT:-}" == 1 ]]')
    .replaceAll('-o root -g root', `-o ${process.getuid()} -g ${process.getgid()}`)
  if (replaceFailure !== null) {
    instrumented = instrumented.replace(
      '  mv -fT "$temporary" "${TARGETS[$index]}"',
      `  if [[ "$index" == '${replaceFailure}' ]]; then false; fi\n  mv -fT "$temporary" "\${TARGETS[$index]}"`
    )
  }
  if (postFailure) {
    instrumented = instrumented.replace(
      'visudo -cf "$SUDOERS_DIR/kinvest-deploy-v4" >/dev/null',
      'false # injected post-check failure'
    )
  }
  if (rollbackPause) {
    instrumented = instrumented.replace(
      'rollback_targets() {',
      `rollback_targets() {
  : >'${rollbackMarker}'
  while [[ ! -e '${rollbackRelease}' ]]; do sleep 0.01; done`
    )
  }
  const script = path.join(base, 'installer.sh')
  writeExecutable(script, instrumented)
  return { base, bin, eventLog, lockDir, lockRelease, rollbackMarker, rollbackRelease, script, serverRoot, targets }
}

function installerEnvironment(context, overrides = {}) {
  return {
    ...process.env,
    KINVEST_INSTALL_V4_TEST_ROOT: '1',
    PATH: `${context.bin}:${process.env.PATH}`,
    REAL_SHA256SUM: spawnSync('which', ['sha256sum'], { encoding: 'utf8' }).stdout.trim(),
    ...overrides
  }
}

function execute(context, overrides = {}) {
  return spawnSync('bash', [context.script, sourceDir], {
    encoding: 'utf8',
    env: installerEnvironment(context, overrides)
  })
}

function waitFor(check, timeoutMs = 2000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve()
      if (Date.now() - started >= timeoutMs) return reject(new Error('timed out waiting for installer event'))
      setTimeout(poll, 10)
    }
    poll()
  })
}

function waitForExit(child, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('installer child did not exit'))
    }, timeoutMs)
    child.once('exit', (status, signal) => {
      clearTimeout(timeout)
      resolve({ signal, status })
    })
  })
}

function assertOld(context, existing) {
  for (let index = 0; index < context.targets.length; index += 1) {
    if (existing) {
      assert.equal(fs.readFileSync(context.targets[index], 'utf8'), `old-${index}\n`)
      assert.equal(fs.statSync(context.targets[index]).mode & 0o777, 0o700)
    } else {
      assert.equal(fs.existsSync(context.targets[index]), false)
    }
  }
}

async function run() {
  assert.doesNotMatch(installerSource, /systemctl restart|docker compose|DEPLOY_V4_ENABLED/)

  const concurrent = fixture()
  try {
    const sharedEnvironment = {
      INSTALL_EVENTS: concurrent.eventLog,
      INSTALL_LOCK_DIR: concurrent.lockDir,
      INSTALL_LOCK_RELEASE: concurrent.lockRelease,
      INSTALL_TARGET_ROOT: concurrent.base
    }
    const first = spawn('bash', [concurrent.script, sourceDir], {
      env: installerEnvironment(concurrent, { ...sharedEnvironment, HOLD_INSTALL_LOCK: '1', INSTALLER_ID: 'first' }),
      stdio: 'ignore'
    })
    await waitFor(() => fs.existsSync(concurrent.eventLog) && fs.readFileSync(concurrent.eventLog, 'utf8').includes('first:lock'))
    const second = execute(concurrent, { ...sharedEnvironment, INSTALLER_ID: 'second' })
    assert.notEqual(second.status, 0)
    const whileLocked = fs.readFileSync(concurrent.eventLog, 'utf8').trim().split('\n')
    assert.equal(whileLocked.includes('second:target-read'), false)
    fs.writeFileSync(concurrent.lockRelease, '')
    const firstExit = await waitForExit(first)
    assert.equal(firstExit.status, 0)
    const events = fs.readFileSync(concurrent.eventLog, 'utf8').trim().split('\n')
    assert.ok(events.indexOf('first:lock') < events.indexOf('first:target-read'))
  } finally {
    fs.rmSync(concurrent.base, { recursive: true, force: true })
  }

  const signalled = fixture({ replaceFailure: 3, rollbackPause: true })
  try {
    const child = spawn('bash', [signalled.script, sourceDir], {
      env: installerEnvironment(signalled),
      stdio: 'ignore'
    })
    await waitFor(() => fs.existsSync(signalled.rollbackMarker))
    child.kill('SIGTERM')
    child.kill('SIGTERM')
    fs.writeFileSync(signalled.rollbackRelease, '')
    const childExit = await waitForExit(child)
    assert.notEqual(childExit.status, 0)
    assert.equal(childExit.signal, null)
    assertOld(signalled, true)
  } finally {
    fs.rmSync(signalled.base, { recursive: true, force: true })
  }

  for (let index = 0; index < 7; index += 1) {
    const context = fixture({ replaceFailure: index })
    try {
      const result = execute(context)
      assert.notEqual(result.status, 0, `replacement ${index} unexpectedly succeeded`)
      assertOld(context, true)
    } finally {
      fs.rmSync(context.base, { recursive: true, force: true })
    }
  }

  const post = fixture({ postFailure: true })
  try {
    assert.notEqual(execute(post).status, 0)
    assertOld(post, true)
  } finally {
    fs.rmSync(post.base, { recursive: true, force: true })
  }

  const absent = fixture({ existing: false, replaceFailure: 4 })
  try {
    assert.notEqual(execute(absent).status, 0)
    assertOld(absent, false)
  } finally {
    fs.rmSync(absent.base, { recursive: true, force: true })
  }

  const success = fixture()
  try {
    const result = execute(success)
    assert.equal(result.status, 0, result.stderr)
    for (const target of success.targets) assert.equal(fs.existsSync(target), true)
    assert.doesNotMatch(result.stdout + result.stderr, /systemctl|docker compose|compose up/i)
  } finally {
    fs.rmSync(success.base, { recursive: true, force: true })
  }
}

module.exports = { run }
