const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8')
}

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { mode: 0o755 })
}

function createSqlite(databasePath, userVersion = 0) {
  const result = spawnSync(
    'python3',
    ['-c', `import sqlite3; c=sqlite3.connect(${JSON.stringify(databasePath)}); c.execute('pragma user_version=${userVersion}'); c.close()`],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
}

function runRootFixture(deploySource, { mode = 'success' } = {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-deploy-v2-root-'))
  const root = path.join(fixture, 'root', 'docker', 'kinvest')
  const runRoot = path.join(fixture, 'run')
  const fakeBin = path.join(fixture, 'bin')
  const fakeState = path.join(fixture, 'fake-state')
  const dataDir = path.join(root, 'data')
  const stateDir = path.join(root, 'state')
  const database = path.join(dataDir, 'kinvest.sqlite')
  const previousDigest = `ghcr.io/zwphhxx/kinvest@sha256:${'1'.repeat(64)}`
  const candidateDigest = `ghcr.io/zwphhxx/kinvest@sha256:${'2'.repeat(64)}`
  const previousCommit = '3'.repeat(40)
  const candidateCommit = '4'.repeat(40)

  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(stateDir)
  fs.mkdirSync(runRoot)
  fs.mkdirSync(fakeBin)
  fs.mkdirSync(fakeState)
  fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'services: {}\n')
  writeExecutable(path.join(root, 'prepare-data-dir.sh'), '#!/bin/sh\nexit 0\n')
  createSqlite(database)
  fs.writeFileSync(path.join(stateDir, 'current.state'), `digest_ref=${previousDigest}\ncommit=${previousCommit}\n`)
  fs.writeFileSync(path.join(fakeState, 'running.ref'), `${previousDigest}\n`)
  fs.writeFileSync(path.join(fakeState, 'running.health'), 'healthy\n')

  writeExecutable(
    path.join(fakeBin, 'id'),
    `#!/bin/sh
if [ "$1" = '-u' ]; then printf '0\n'; else exec /usr/bin/id "$@"; fi
`
  )
  writeExecutable(
    path.join(fakeBin, 'timeout'),
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in --signal=*|--kill-after=*) shift ;; *) break ;; esac
done
shift
exec "$@"
`
  )
  writeExecutable(
    path.join(fakeBin, 'flock'),
    `#!/bin/sh
exit 0
`
  )
  writeExecutable(
    path.join(fakeBin, 'curl'),
    `#!/bin/sh
if [ "$KINVEST_FAKE_MODE" = public-health-failure ]; then exit 22; fi
printf '%s\n' '{"status":"ok","service":"kinvest"}'
`
  )
  writeExecutable(
    path.join(fakeBin, 'docker'),
    `#!/bin/sh
printf '%s\n' "$*" >> "$KINVEST_FAKE_STATE/docker.log"
if [ "$1" = network ]; then exit 0; fi
if [ "$1" = pull ]; then
  if [ "$KINVEST_FAKE_MODE" = signal ]; then kill -TERM "$PPID"; sleep 1; exit 143; fi
  exit 0
fi
if [ "$1" = login ]; then cat >/dev/null; exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  format="$4"
  ref="$5"
  case "$format" in
    *RepoDigests*)
      if [ "$KINVEST_FAKE_MODE" = wrong-digest ] && [ "$ref" = "$KINVEST_CANDIDATE" ]; then
        printf '["ghcr.io/zwphhxx/kinvest@sha256:%064d"]\n' 0
      else
        printf '["%s"]\n' "$ref"
      fi
      ;;
    *schema.min*|*schema.max*) printf '0\n' ;;
    *Id*) printf 'sha256:fixture-image-id\n' ;;
  esac
  exit 0
fi
if [ "$1" = inspect ]; then
  format="$3"
  case "$format" in
    *Health.Status*) cat "$KINVEST_FAKE_STATE/running.health" ;;
    *Config.Image*) cat "$KINVEST_FAKE_STATE/running.ref" ;;
    *Image*) printf 'sha256:fixture-image-id\n' ;;
  esac
  exit 0
fi
if [ "$1" = compose ]; then
  printf '%s\n' "$KINVEST_IMAGE" > "$KINVEST_FAKE_STATE/running.ref"
  if [ "$KINVEST_FAKE_MODE" = incompatible ]; then
    python3 -c "import sqlite3; c=sqlite3.connect('$KINVEST_FAKE_DB'); c.execute('pragma user_version=1'); c.close()"
    printf 'unhealthy\n' > "$KINVEST_FAKE_STATE/running.health"
  elif [ "$KINVEST_FAKE_MODE" = schema-read-failure ]; then
    printf 'not-a-sqlite-database\n' > "$KINVEST_FAKE_DB"
    printf 'unhealthy\n' > "$KINVEST_FAKE_STATE/running.health"
  else
    printf 'healthy\n' > "$KINVEST_FAKE_STATE/running.health"
  fi
  exit 0
fi
if [ "$1" = stop ]; then
  : > "$KINVEST_FAKE_STATE/stopped"
  exit 0
fi
if [ "$1" = rm ]; then exit 0; fi
exit 90
`
  )

  const instrumented = deploySource
    .replace("ROOT='/root/docker/kinvest'", `ROOT='${root}'`)
    .replace("RUN_ROOT='/run'", `RUN_ROOT='${runRoot}'`)
  const scriptPath = path.join(fixture, 'deploy-v2')
  writeExecutable(scriptPath, instrumented)
  const payload = [
    'KINVEST_DEPLOY_V2',
    candidateDigest,
    candidateCommit,
    'ghcr-public',
    'ghcr.io',
    '',
    '',
    '2',
    '987654',
    'ghcr-public',
    '{}',
    'EOF'
  ].join('\n') + '\n'
  const result = spawnSync(scriptPath, [], {
    encoding: 'utf8',
    input: payload,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      KINVEST_CANDIDATE: candidateDigest,
      KINVEST_FAKE_DB: database,
      KINVEST_FAKE_MODE: mode,
      KINVEST_FAKE_STATE: fakeState
    }
  })

  return {
    candidateDigest,
    cleanup() { fs.rmSync(fixture, { recursive: true, force: true }) },
    fakeState,
    result,
    runRoot,
    stateDir
  }
}

async function run() {
  const wrapper = read('deploy/server/kinvest-ssh-command-v2')
  const deploy = read('deploy/server/deploy-kinvest-v2.sh')
  const installer = read('deploy/server/install-deploy-v2.sh')
  const workflow = read('.github/workflows/deploy-production-v2-manual.yml')
  const publishWorkflow = read('.github/workflows/deploy.yml')
  const dockerfile = read('Dockerfile')

  assert.match(wrapper, /SSH_ORIGINAL_COMMAND:-.*!= 'deploy-v2'/)
  assert.match(wrapper, /exec sudo -n \/usr\/local\/sbin\/deploy-kinvest/)
  assert.doesNotMatch(wrapper, /digest_ref|registry_password|docker|eval/)

  assert.match(deploy, /KINVEST_DEPLOY_V2/)
  assert.match(deploy, /payload_end.*'EOF'/s)
  assert.match(deploy, /mktemp -d "\$RUN_ROOT\/kinvest-docker-config\.XXXXXX"/)
  assert.match(deploy, /chmod 0700 "\$docker_config"/)
  assert.match(deploy, /docker login "\$registry_host" --username "\$registry_username" --password-stdin/)
  assert.match(deploy, /rm -f -- "\$DOCKER_CONFIG\/config\.json"/)
  assert.match(deploy, /\.RepoDigests/)
  assert.match(deploy, /ROLLBACK_REQUIRES_DB_RESTORE/)
  assert.match(deploy, /TCR_POLICY_FILE/)
  assert.match(deploy, /atomic_write_attempt_state/)
  assert.match(deploy, /run_docker stop kinvest/)
  assert.match(deploy, /verify_public_health/)
  assert.match(deploy, /protocolVersion=2/)
  for (const field of [
    'imageDigest',
    'commit',
    'schemaVersion',
    'imageSchemaMin',
    'imageSchemaMax',
    'secretVersionIds',
    'releaseRecordSchemaVersion',
    'verificationRunId',
    'artifactSource',
    'databaseBackupPath',
    'databaseBackupChecksum',
    'deployedAt'
  ]) {
    assert.match(deploy, new RegExp(`^${field}=`, 'm'))
  }
  assert.doesNotMatch(deploy, /set -x|docker login[^\n]*--password(?:\s|=)/)
  assert.doesNotMatch(deploy, /echo[^\n]*registry_password/)

  assert.match(installer, /deploy-kinvest-v2\.sh/)
  assert.match(installer, /kinvest-ssh-command-v2/)
  assert.match(installer, /no container was restarted/)

  assert.match(workflow, /DEPLOY_V2_ENABLED/)
  assert.match(workflow, /FORWARD/)
  assert.match(workflow, /ROLLBACK_V2/)
  assert.match(workflow, /KINVEST_DEPLOY_V2/)
  assert.match(workflow, /'deploy-v2'/)
  assert.match(workflow, /'ghcr-public'/)
  assert.doesNotMatch(workflow, /TCR_(?:USERNAME|PASSWORD)|registry-password/)
  assert.doesNotMatch(workflow, /ssh[\s\S]{0,500}"deploy \$IMAGE_DIGEST_REF/)
  assert.match(publishWorkflow, /kinvest-release-record-v2-/)
  assert.match(publishWorkflow, /schema_version: \$schema_version/)
  assert.match(dockerfile, /io\.kinvest\.schema\.min="0"/)
  assert.match(dockerfile, /io\.kinvest\.schema\.max="0"/)

  const gateIndex = workflow.indexOf('Check Production v2 gate after approval')
  const environmentIndex = workflow.indexOf('environment: Production')
  assert.ok(gateIndex > environmentIndex)

  for (const script of [wrapper, deploy, installer]) {
    const syntax = spawnSync('bash', ['-n'], { encoding: 'utf8', input: script })
    assert.equal(syntax.status, 0, syntax.stderr)
  }

  const secretFixture = 'registry-password-fixture-never-log'
  const validPayload = [
    'KINVEST_DEPLOY_V2',
    `ccr.ccs.tencentyun.com/website-dev/kinvest@sha256:${'a'.repeat(64)}`,
    'b'.repeat(40),
    'tcr-basic',
    'ccr.ccs.tencentyun.com',
    'pull-only-user',
    secretFixture,
    '2',
    '123456',
    'tcr-private',
    '{}',
    'EOF'
  ].join('\n') + '\n'
  const nonRoot = spawnSync('bash', [path.join(rootDir, 'deploy/server/deploy-kinvest-v2.sh')], {
    encoding: 'utf8',
    input: validPayload
  })
  assert.notEqual(nonRoot.status, 0)
  assert.match(nonRoot.stderr, /must run as root/)
  assert.doesNotMatch(`${nonRoot.stdout}${nonRoot.stderr}`, new RegExp(secretFixture))

  const truncated = spawnSync('bash', [path.join(rootDir, 'deploy/server/deploy-kinvest-v2.sh')], {
    encoding: 'utf8',
    input: 'KINVEST_DEPLOY_V2\n'
  })
  assert.equal(truncated.status, 2)
  assert.match(truncated.stderr, /complete deploy-v2 payload/)

  const successfulRoot = runRootFixture(deploy)
  try {
    assert.equal(successfulRoot.result.status, 0, successfulRoot.result.stderr)
    const currentState = fs.readFileSync(path.join(successfulRoot.stateDir, 'current.state'), 'utf8')
    assert.match(currentState, /^protocolVersion=2$/m)
    assert.match(currentState, new RegExp(`^imageDigest=${successfulRoot.candidateDigest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    assert.match(currentState, /^verificationRunId=987654$/m)
    assert.match(currentState, /^databaseBackupChecksum=[0-9a-f]{64}$/m)
    assert.equal(fs.existsSync(path.join(successfulRoot.stateDir, 'attempt.state')), false)
    assert.equal(fs.readdirSync(successfulRoot.runRoot).length, 0)
  } finally {
    successfulRoot.cleanup()
  }

  const wrongDigest = runRootFixture(deploy, { mode: 'wrong-digest' })
  try {
    assert.notEqual(wrongDigest.result.status, 0)
    assert.match(wrongDigest.result.stderr, /RepoDigests/)
    assert.equal(fs.readdirSync(wrongDigest.runRoot).length, 0)
  } finally {
    wrongDigest.cleanup()
  }

  const incompatible = runRootFixture(deploy, { mode: 'incompatible' })
  try {
    assert.notEqual(incompatible.result.status, 0)
    assert.match(incompatible.result.stderr, /ROLLBACK_REQUIRES_DB_RESTORE/)
    assert.equal(fs.existsSync(path.join(incompatible.fakeState, 'stopped')), true)
    assert.equal(fs.existsSync(path.join(incompatible.stateDir, 'attempt.state')), true)
    const attempt = fs.readFileSync(path.join(incompatible.stateDir, 'attempt.state'), 'utf8')
    assert.match(attempt, /^schemaBefore=0$/m)
    assert.match(attempt, /^databaseBackupChecksum=[0-9a-f]{64}$/m)
    const backupPath = attempt.match(/^databaseBackupPath=(.+)$/m)[1]
    const recordedChecksum = attempt.match(/^databaseBackupChecksum=([0-9a-f]{64})$/m)[1]
    assert.equal(fs.existsSync(backupPath), true)
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex'), recordedChecksum)
  } finally {
    incompatible.cleanup()
  }

  const schemaReadFailure = runRootFixture(deploy, { mode: 'schema-read-failure' })
  try {
    assert.notEqual(schemaReadFailure.result.status, 0)
    assert.match(schemaReadFailure.result.stderr, /ROLLBACK_REQUIRES_DB_RESTORE/)
    assert.equal(fs.existsSync(path.join(schemaReadFailure.fakeState, 'stopped')), true)
    assert.equal(fs.existsSync(path.join(schemaReadFailure.stateDir, 'attempt.state')), true)
  } finally {
    schemaReadFailure.cleanup()
  }

  const publicHealthFailure = runRootFixture(deploy, { mode: 'public-health-failure' })
  try {
    assert.notEqual(publicHealthFailure.result.status, 0)
    assert.match(publicHealthFailure.result.stderr, /evaluating verified rollback/)
    assert.equal(fs.existsSync(path.join(publicHealthFailure.stateDir, 'attempt.state')), false)
  } finally {
    publicHealthFailure.cleanup()
  }

  const signal = runRootFixture(deploy, { mode: 'signal' })
  try {
    assert.equal(signal.result.status, 143)
    assert.equal(fs.readdirSync(signal.runRoot).length, 0)
  } finally {
    signal.cleanup()
  }

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-wrapper-v2-'))
  try {
    const fakeBin = path.join(fixture, 'bin')
    const capture = path.join(fixture, 'capture')
    fs.mkdirSync(fakeBin)
    writeExecutable(
      path.join(fakeBin, 'sudo'),
      `#!/bin/sh
if [ "$1" = '-n' ]; then shift; fi
exec "$@"
`
    )
    const instrumentedWrapper = wrapper.replace('/usr/local/sbin/deploy-kinvest', capture)
    const wrapperPath = path.join(fixture, 'wrapper')
    writeExecutable(wrapperPath, instrumentedWrapper)
    writeExecutable(
      capture,
      `#!/bin/sh
cat > "${path.join(fixture, 'stdin')}"
`
    )
    const forwarded = spawnSync(wrapperPath, [], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: 'deploy-v2' },
      input: validPayload
    })
    assert.equal(forwarded.status, 0, forwarded.stderr)
    assert.equal(fs.readFileSync(path.join(fixture, 'stdin'), 'utf8'), validPayload)
    assert.doesNotMatch(`${forwarded.stdout}${forwarded.stderr}`, new RegExp(secretFixture))

    const rejected = spawnSync(wrapperPath, [], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: 'deploy-v2 extra' },
      input: validPayload
    })
    assert.equal(rejected.status, 2)
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}

module.exports = { run }
