const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const rootDir = path.resolve(__dirname, '../..')
const sourceDir = path.join(rootDir, 'deploy/server')
const installerSource = fs.readFileSync(path.join(sourceDir, 'install-deploy-v4.sh'), 'utf8')

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function fixture({ existing = true, replaceFailure = null, postFailure = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-v4-installer-'))
  const sbin = path.join(base, 'sbin')
  const libexec = path.join(base, 'libexec')
  const serverRoot = path.join(base, 'server')
  const sudoers = path.join(base, 'sudoers')
  const runRoot = path.join(base, 'run')
  const bin = path.join(base, 'bin')
  for (const directory of [sbin, libexec, serverRoot, path.join(serverRoot, 'state'), sudoers, runRoot, bin]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  writeExecutable(path.join(bin, 'flock'), '#!/bin/sh\nexit 0\n')
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
  const script = path.join(base, 'installer.sh')
  writeExecutable(script, instrumented)
  return { base, bin, script, targets }
}

function execute(context) {
  return spawnSync('bash', [context.script, sourceDir], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KINVEST_INSTALL_V4_TEST_ROOT: '1',
      PATH: `${context.bin}:${process.env.PATH}`
    }
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
