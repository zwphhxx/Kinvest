const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const helperPath = path.join(rootDir, 'deploy/server/deploy-v3-contract.py')

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8')
}

function fakeMaterials() {
  const digest = Buffer.alloc(32, 1).toString('base64url')
  const salt = Buffer.alloc(16, 2).toString('base64url')
  const adminJson = JSON.stringify({
    digest,
    format: 'kinvest-admin-scrypt-v1',
    n: 65536,
    p: 1,
    r: 8,
    salt
  })
  return {
    admin: Buffer.from(adminJson).toString('base64url'),
    hmac: Buffer.alloc(32, 3).toString('base64url')
  }
}

function payload(overrides = {}) {
  const material = fakeMaterials()
  const values = {
    magic: 'KINVEST_DEPLOY_V3',
    intent: 'FORWARD',
    digest: `ghcr.io/zwphhxx/kinvest@sha256:${'a'.repeat(64)}`,
    commit: 'b'.repeat(40),
    provenance: '{"artifactSource":"ghcr-public","releaseRecordSchemaVersion":2,"verificationRunId":"123"}',
    registry: '{"host":"ghcr.io","mode":"ghcr-public","repository":"ghcr.io/zwphhxx/kinvest"}',
    provider: 'github-tmpfs-v1',
    adminVersion: 'v20260813-001',
    hmacVersion: 'v20260813-002',
    admin: material.admin,
    hmac: material.hmac,
    end: 'EOF',
    ...overrides
  }
  return [
    values.magic,
    values.intent,
    values.digest,
    values.commit,
    values.provenance,
    values.registry,
    values.provider,
    values.adminVersion,
    values.hmacVersion,
    values.admin,
    values.hmac,
    values.end
  ].join('\n') + '\n'
}

function validate(input) {
  return spawnSync('python3', [helperPath, 'validate-payload'], {
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024
  })
}

function assertStableFailure(result, materials = fakeMaterials()) {
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /^DEPLOY_V3_[A-Z0-9_]+\n$/)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.includes(materials.admin), false)
  assert.equal(result.stderr.includes(materials.hmac), false)
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 })
}

function stateText(overrides = {}) {
  const values = {
    protocolVersion: 4,
    imageDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'1'.repeat(64)}`,
    runtimeImageId: `sha256:${'2'.repeat(64)}`,
    commit: '3'.repeat(40),
    schemaVersion: 0,
    imageSchemaMin: 0,
    imageSchemaMax: 0,
    secretProviderMode: 'disabled',
    secretVersionIds: '{}',
    secretBundleId: 'none',
    secretMaterialFingerprints: '{}',
    releaseRecordSchemaVersion: 2,
    verificationRunId: '100',
    artifactSource: 'ghcr-public',
    databaseBackupPath: 'none',
    databaseBackupChecksum: 'none',
    deployedAt: '2026-08-13T00:00:00Z',
    ...overrides
  }
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n'
}

function legacyStateText(overrides = {}) {
  const values = {
    protocolVersion: 3,
    imageDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'1'.repeat(64)}`,
    runtimeImageId: `sha256:${'2'.repeat(64)}`,
    commit: '3'.repeat(40),
    schemaVersion: 0,
    imageSchemaMin: 0,
    imageSchemaMax: 0,
    secretVersionIds: '{}',
    releaseRecordSchemaVersion: 2,
    verificationRunId: '100',
    artifactSource: 'ghcr-public',
    databaseBackupPath: 'none',
    databaseBackupChecksum: 'none',
    deployedAt: '2026-08-13T00:00:00Z',
    ...overrides
  }
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n'
}

function materialMetadata() {
  const material = fakeMaterials()
  return {
    fingerprints: {
      adminPasswordVerifier: require('node:crypto').createHash('sha256').update(Buffer.from(material.admin, 'base64url')).digest('hex'),
      deviceTokenHmac: require('node:crypto').createHash('sha256').update(material.hmac).digest('hex')
    },
    versions: '{"adminPasswordVerifier":"v20260813-001","deviceTokenHmac":{"accepted":["v20260813-002"],"active":"v20260813-002"}}'
  }
}

function runExecutor(deployer, options = {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-v3-root-'))
  const root = path.join(fixture, 'root')
  const runRoot = path.join(fixture, 'run')
  const stateDir = path.join(root, 'state')
  const dataDir = path.join(root, 'data')
  const backupDir = path.join(root, 'backups')
  const fakeBin = path.join(fixture, 'bin')
  const log = path.join(fixture, 'operations.log')
  const activeImage = path.join(fixture, 'active-image')
  const healthMarker = path.join(fixture, 'health-marker')
  const atomicFailureMarker = path.join(fixture, 'atomic-failure.marker')
  const contract = path.join(fixture, 'deploy-v3-contract.py')
  const compose = path.join(root, 'docker-compose-v3.yml')
  const candidateId = `sha256:${'a'.repeat(64)}`
  const previousId = options.currentState?.runtimeImageId ?? `sha256:${'2'.repeat(64)}`
  const candidateDigest = `ghcr.io/zwphhxx/kinvest@sha256:${'a'.repeat(64)}`
  fs.mkdirSync(stateDir, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(backupDir, { recursive: true })
  fs.mkdirSync(runRoot)
  fs.mkdirSync(fakeBin)
  const contractSource = fs.readFileSync(helperPath, 'utf8')
    .replace('BUNDLE_ROOT = Path("/run/kinvest-secrets")', `BUNDLE_ROOT = Path("${path.join(runRoot, 'kinvest-secrets')}")`)
    .replace('bundle_root.parent != Path("/run")', `bundle_root.parent != Path("${runRoot}")`)
    .replace('BUNDLE_UID = 0', `BUNDLE_UID = ${process.getuid()}`)
    .replace('BUNDLE_GID = 10001', `BUNDLE_GID = ${process.getgid()}`)
    .replace('info.st_uid != 0', `info.st_uid != ${process.getuid()}`)
    .replace('or info.st_gid != BUNDLE_GID', 'or info.st_gid != BUNDLE_GID')
    .replace('not backup_path.startswith("/root/docker/kinvest/backups/")', `not backup_path.startswith("${backupDir}/")`)
  fs.writeFileSync(contract, contractSource)
  fs.chmodSync(contract, 0o755)
  fs.writeFileSync(compose, read('deploy/server/docker-compose-v3.yml'))
  const createDatabase = spawnSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA user_version=0"); c.close()', path.join(dataDir, 'kinvest.sqlite')], { encoding: 'utf8' })
  assert.equal(createDatabase.status, 0, createDatabase.stderr)
  const normalizedCurrentState = { ...(options.currentState ?? {}) }
  if (typeof normalizedCurrentState.databaseBackupPath === 'string') {
    normalizedCurrentState.databaseBackupPath = normalizedCurrentState.databaseBackupPath.replace('__BACKUP__', backupDir)
  }
  fs.writeFileSync(
    path.join(stateDir, 'current.state'),
    options.currentStateText ?? stateText(normalizedCurrentState),
    { mode: 0o600 }
  )
  fs.writeFileSync(activeImage, previousId)
  if (options.previousState) fs.writeFileSync(path.join(stateDir, 'previous.state'), stateText(options.previousState), { mode: 0o600 })
  if (options.existingAttempt) {
    const attemptState = {
      ...(options.existingAttempt === true ? normalizedCurrentState : options.existingAttempt)
    }
    if (typeof attemptState.databaseBackupPath === 'string') {
      attemptState.databaseBackupPath = attemptState.databaseBackupPath.replace('__BACKUP__', backupDir)
    }
    fs.writeFileSync(
      path.join(stateDir, 'attempt.state'),
      stateText(attemptState),
      { mode: 0o600 }
    )
  }
  if (options.ledger) {
    fs.writeFileSync(
      path.join(stateDir, 'secret-version-ledger.json'),
      JSON.stringify(options.ledger) + '\n',
      { mode: 0o600 }
    )
  }
  if ((options.oldBundles ?? []).length > 0) {
    fs.mkdirSync(path.join(runRoot, 'kinvest-secrets'), { mode: 0o700 })
  }
  for (const bundleId of options.oldBundles ?? []) {
    const bundle = path.join(runRoot, 'kinvest-secrets', bundleId)
    fs.mkdirSync(bundle, { mode: 0o700 })
    for (const name of ['manifest.json', 'admin-password-verifier', 'device-token-hmac-key']) {
      fs.writeFileSync(path.join(bundle, name), 'fixture', { mode: 0o440 })
    }
    fs.chmodSync(bundle, 0o550)
  }
  if (options.malformedOldBundle) {
    const bundleRoot = path.join(runRoot, 'kinvest-secrets')
    fs.mkdirSync(bundleRoot, { recursive: true, mode: 0o700 })
    const malformed = path.join(bundleRoot, '7'.repeat(32))
    fs.mkdirSync(malformed, { mode: 0o700 })
    fs.writeFileSync(path.join(malformed, 'manifest.json'), 'incomplete', { mode: 0o440 })
    fs.chmodSync(malformed, 0o550)
  }

  let source = deployer
    .replace("ROOT='/root/docker/kinvest'", `ROOT='${root}'`)
    .replace("RUN_ROOT='/run'", `RUN_ROOT='${runRoot}'`)
    .replace("BUNDLE_UID='0'", `BUNDLE_UID='${process.getuid()}'`)
    .replace("BUNDLE_GID='10001'", `BUNDLE_GID='${process.getgid()}'`)
    .replace("CONTRACT='/usr/local/libexec/kinvest-deploy-v3-contract'", `CONTRACT='${contract}'`)
    .replace("OFFLINE_IMAGE_ATTESTATION='/usr/local/libexec/kinvest-offline-image-attestation'", `OFFLINE_IMAGE_ATTESTATION='${path.join(fakeBin, 'kinvest-offline-image-attestation')}'`)
    .replace("PUBLIC_HEALTH_URL='https://dearmina.cn/api/health'", "PUBLIC_HEALTH_URL='https://fixture.invalid/api/health'")
  if (options.backupFailure) {
    source = source.replace(
      'if ! python3 - "$DATABASE" "$temporary" <<\'PY\'',
      'if ! false <<\'PY\''
    )
  }
  if (options.finalBackupVerifyFailure) {
    source = source.replace(
      'if ! python3 - "$database_backup_path" <<\'PY\'',
      'if ! false <<\'PY\''
    )
  }
  const script = path.join(fixture, 'deployer')
  writeExecutable(script, source)

  writeExecutable(path.join(fakeBin, 'id'), '#!/bin/sh\necho 0\n')
  writeExecutable(path.join(fakeBin, 'flock'), `#!/bin/sh\nprintf '%s\\n' flock >> '${log}'\nexit ${options.lockFailure ? 1 : 0}\n`)
  writeExecutable(path.join(fakeBin, 'findmnt'), `#!/bin/sh\nprintf '%s\\n' findmnt >> '${log}'\nprintf '%s\\n' '${options.runFs ?? 'tmpfs'}'\n`)
  writeExecutable(path.join(fakeBin, 'kinvest-offline-image-attestation'), `#!/bin/sh\nprintf 'attestation:%s\\n' "$*" >> '${log}'\n${options.attestationFailure ? "printf '%s\\n' OFFLINE_ATTESTATION_NOT_FOUND >&2; exit 4" : `printf '%s\\n' '${candidateId}'`}\n`)
  writeExecutable(path.join(fakeBin, 'curl'), `#!/bin/sh\nprintf '%s\\n' curl >> '${log}'\nprintf '%s\\n' '{"status":"ok","service":"kinvest"}'\n`)
  writeExecutable(path.join(fakeBin, 'docker'), `#!/usr/bin/env bash
set -eu
ulimit -f unlimited 2>/dev/null || true
printf 'docker:%s\\n' "$*" >> '${log}'
case "$*" in
  *"image inspect ${candidateDigest} --format {{.Id}}"*) ${options.digestMissing ? 'exit 1' : `printf '%s\\n' '${candidateId}'`} ;;
  *"image inspect ${candidateId} --format {{.Id}}"*) printf '%s\\n' '${candidateId}' ;;
  *"image inspect ${candidateId} --format {{json .RepoDigests}}"*) printf '%s\\n' '["${candidateDigest}"]' ;;
  *"${previousId}"*"io.kinvest.schema.min"*) printf '%s\\n' '${options.recoverySchemaMin ?? 0}' ;;
  *"${previousId}"*"io.kinvest.schema.max"*) printf '%s\\n' '${options.recoverySchemaMax ?? 0}' ;;
  *"io.kinvest.schema.min"*) printf '%s\\n' '0' ;;
  *"io.kinvest.schema.max"*) printf '%s\\n' '0' ;;
  *"io.kinvest.secret-bootstrap"*) printf '%s\\n' '${options.missingCapability ? '' : '1'}' ;;
  *"image inspect sha256:"*" --format {{.Id}}"*) printf '%s\\n' "$3" ;;
  *"run --rm"*)
    ${options.preflightFailure ? 'exit 17' : options.realDisabledPreflight
      ? `KINVEST_SECRET_PROVIDER_MODE=disabled KINVEST_SECRET_VERSION_IDS='{}' node '${path.join(rootDir, 'server/secret-preflight.js')}'`
      : options.preflightOversized
        ? "printf '%0130d' 0"
        : options.preflightStderr
          ? "printf '%s\\n' PREFLIGHT_ERROR >&2"
          : `printf '%s\\n' '${options.preflightOutput ?? 'KINVEST_SECRET_PREFLIGHT_OK mode=github-tmpfs-v1 references=2'}'`} ;;
  *"compose"*"up -d"*)
    ${options.migratedSchema === undefined ? ':' : `if [ "\${KINVEST_IMAGE:-}" = '${candidateId}' ]; then /usr/bin/python3 -c 'import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute("PRAGMA user_version=${options.migratedSchema}");c.close()' '${path.join(dataDir, 'kinvest.sqlite')}'; fi`}
    ${options.composeFailure ? `if [ "\${KINVEST_IMAGE:-}" = '${candidateId}' ]; then exit 18; fi` : ':'}
    ${options.recoveryFailure ? `if [ "\${KINVEST_IMAGE:-}" = '${previousId}' ]; then exit 20; fi` : ':'}
    printf 'compose-env:%s|%s|%s\n' "\${KINVEST_IMAGE:-}" "\${KINVEST_SECRET_VERSION_IDS:-}" "\${KINVEST_SECRET_BUNDLE_HOST_PATH:-}" >> '${log}'
    printf '%s' "\${KINVEST_IMAGE:-}" > '${activeImage}' ;;
  *"inspect --format {{.State.Health.Status}} kinvest"*)
    ${options.healthFailure ? `if [ ! -e '${healthMarker}' ] && [ "$(cat '${activeImage}')" = '${candidateId}' ]; then touch '${healthMarker}'; printf '%s\\n' unhealthy; exit 0; fi` : ':'}
    printf '%s\\n' healthy ;;
  *"inspect --format {{.Config.Image}} kinvest"*) cat '${activeImage}' ;;
  *"inspect --format {{.Image}} kinvest"*) cat '${activeImage}' ;;
  *"pull "*) ${options.pullFailure ? 'exit 19' : ':'} ;;
esac
`)
  writeExecutable(path.join(fakeBin, 'timeout'), '#!/bin/sh\nwhile [ "$1" != "" ]; do case "$1" in --signal=*|--kill-after=*) shift;; *s) shift; break;; *) break;; esac; done\nexec "$@"\n')

  const inputOverrides = {
    intent: options.intent ?? 'FORWARD',
    provider: options.provider ?? 'github-tmpfs-v1',
    digest: options.digest ?? candidateDigest,
    commit: options.commit ?? 'b'.repeat(40)
  }
  if (options.provider === 'disabled') Object.assign(inputOverrides, {
    adminVersion: '',
    hmacVersion: '',
    admin: '',
    hmac: ''
  })
  const input = payload(inputOverrides)
  const result = spawnSync(script, [], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      ...(options.stateCommitFailure ? {
        KINVEST_V3_TEST_FAIL_AFTER_REPLACE: path.join(stateDir, 'current.state'),
        KINVEST_V3_TEST_FAIL_MARKER: atomicFailureMarker
      } : {})
    },
    maxBuffer: 1024 * 1024
  })
  return {
    activeImage,
    backupDir,
    candidateDigest,
    candidateId,
    cleanup: () => {
      spawnSync('chmod', ['-R', 'u+w', fixture])
      fs.rmSync(fixture, { recursive: true, force: true })
    },
    input,
    log,
    result,
    runRoot,
    stateDir,
    fixture
  }
}

async function run() {
  const wrapper = read('deploy/server/kinvest-ssh-command-v3')
  const deployer = read('deploy/server/deploy-kinvest-v3.sh')
  const compose = read('deploy/server/docker-compose-v3.yml')

  assert.match(wrapper, /deploy-v2\)/)
  assert.match(wrapper, /deploy-v3\)/)
  assert.match(wrapper, /exec sudo -n \/usr\/local\/sbin\/deploy-kinvest-v2/)
  assert.match(wrapper, /exec sudo -n \/usr\/local\/sbin\/deploy-kinvest-v3/)
  assert.doesNotMatch(wrapper, /digest|material|docker|eval/)

  const valid = validate(payload())
  assert.equal(valid.status, 0)
  const validated = JSON.parse(valid.stdout)
  assert.equal(validated.intent, 'FORWARD')
  assert.equal(validated.secretProviderMode, 'github-tmpfs-v1')
  assert.equal(Object.hasOwn(validated, 'adminMaterial'), false)
  assert.equal(Object.hasOwn(validated, 'hmacMaterial'), false)

  const invalidPayloads = [
    payload().split('\n').slice(0, 8).join('\n') + '\n',
    payload() + 'EXTRA\n',
    payload().replace('\nFORWARD\n', '\r\nFORWARD\n'),
    payload({ intent: 'DEPLOY' }),
    payload({ digest: 'kinvest:latest' }),
    payload({ commit: 'A'.repeat(40) }),
    payload({ provenance: '{"verificationRunId":"123","releaseRecordSchemaVersion":2,"artifactSource":"ghcr-public"}' }),
    payload({ registry: '{"mode":"ghcr-public","host":"ghcr.io","repository":"ghcr.io/zwphhxx/kinvest"}' }),
    payload({ admin: 'abc=' }),
    payload({ hmac: 'A'.repeat(44) }),
    payload({ admin: 'A'.repeat(5000) })
  ]
  for (const input of invalidPayloads) assertStableFailure(validate(input))

  const disabled = validate(payload({
    provider: 'disabled',
    adminVersion: '',
    hmacVersion: '',
    admin: '',
    hmac: ''
  }))
  assert.equal(disabled.status, 0)
  assert.deepEqual(JSON.parse(disabled.stdout).secretVersionIds, {})
  for (const invalidDisabled of [
    payload({ provider: 'disabled', adminVersion: '', hmacVersion: '', admin: 'A', hmac: '' }),
    payload({ provider: 'github-tmpfs-v1', adminVersion: '', hmacVersion: '', admin: '', hmac: '' })
  ]) assertStableFailure(validate(invalidDisabled))

  assert.ok(deployer.indexOf('flock -n') < deployer.indexOf('findmnt'))
  assert.match(deployer, /exec 9>"\$STATE\/deploy\.lock"/)
  assert.ok(deployer.indexOf('findmnt') < deployer.indexOf('prepare'))
  assert.match(deployer, /KINVEST_SECRET_BUNDLE_HOST_PATH/)
  assert.match(deployer, /--user 10001:10001/)
  assert.match(deployer, /--read-only/)
  assert.match(deployer, /--cap-drop ALL/)
  assert.match(deployer, /--network none/)
  assert.match(deployer, /\/run\/secrets\/kinvest:ro/)
  assert.ok(deployer.indexOf('run_secret_preflight') < deployer.indexOf('create_database_backup'))
  assert.doesNotMatch(deployer, /set -x|KINVEST_ADMIN_PASSWORD_VERIFIER_B64URL|KINVEST_DEVICE_TOKEN_HMAC_KEY/)
  const helperSource = read('deploy/server/deploy-v3-contract.py')
  assert.match(helperSource, /^BUNDLE_UID = 0$/m)
  assert.match(helperSource, /^BUNDLE_GID = 10001$/m)
  assert.match(helperSource, /^BUNDLE_MODE = 0o550$/m)
  assert.match(helperSource, /^BUNDLE_FILE_MODE = 0o440$/m)

  assert.match(compose, /KINVEST_SECRET_PROVIDER_MODE/)
  assert.match(compose, /KINVEST_SECRET_VERSION_IDS/)
  assert.match(compose, /KINVEST_SECRET_BUNDLE_PATH: \/run\/secrets\/kinvest/)
  assert.match(compose, /source: \$\{KINVEST_SECRET_BUNDLE_HOST_PATH:\?[^}]+\}/)
  assert.match(compose, /target: \/run\/secrets\/kinvest/)
  assert.match(compose, /read_only: true/)
  assert.doesNotMatch(compose, /PASSWORD|HMAC_KEY|SecretString|SECRET_MATERIAL/)

  const syntax = spawnSync('bash', ['-n'], { encoding: 'utf8', input: deployer })
  assert.equal(syntax.status, 0, syntax.stderr)

  const preflightFailure = runExecutor(deployer, { preflightFailure: true })
  try {
    assert.notEqual(preflightFailure.result.status, 0)
    assert.match(preflightFailure.result.stderr, /DEPLOY_V3_PREFLIGHT_FAILED/)
    const operations = fs.readFileSync(preflightFailure.log, 'utf8')
    assert.match(operations, /^flock\nfindmnt\n/)
    assert.match(operations, /docker:run --rm/)
    assert.doesNotMatch(operations, /compose/)
    assert.equal(fs.readdirSync(preflightFailure.backupDir).length, 0)
    assert.equal(fs.existsSync(path.join(preflightFailure.stateDir, 'attempt.state')), false)
    assert.equal(fs.readFileSync(path.join(preflightFailure.stateDir, 'current.state'), 'utf8'), stateText())
    assert.equal(fs.readdirSync(preflightFailure.runRoot).length, 0)
  } finally {
    preflightFailure.cleanup()
  }

  const disabledExecutor = runExecutor(deployer, {
    provider: 'disabled',
    realDisabledPreflight: true
  })
  try {
    assert.equal(disabledExecutor.result.status, 0, disabledExecutor.result.stderr)
    assert.match(fs.readFileSync(disabledExecutor.log, 'utf8'), /docker:run --rm/)
  } finally {
    disabledExecutor.cleanup()
  }

  const disabledFailure = runExecutor(deployer, {
    provider: 'disabled',
    preflightFailure: true
  })
  try {
    assert.notEqual(disabledFailure.result.status, 0)
    assert.equal(fs.existsSync(path.join(disabledFailure.runRoot, 'kinvest-secrets', 'disabled')), true)
  } finally {
    disabledFailure.cleanup()
  }

  for (const backupFailureMode of [
    { backupFailure: true },
    { finalBackupVerifyFailure: true }
  ]) {
    const backupFailure = runExecutor(deployer, backupFailureMode)
    try {
      assert.notEqual(backupFailure.result.status, 0)
      assert.match(backupFailure.result.stderr, /DEPLOY_V3_DATABASE_BACKUP_FAILED/)
      assert.doesNotMatch(fs.readFileSync(backupFailure.log, 'utf8'), /compose/)
      assert.equal(fs.readdirSync(backupFailure.backupDir).length, 0)
      assert.equal(fs.existsSync(path.join(backupFailure.stateDir, 'attempt.state')), false)
    } finally {
      backupFailure.cleanup()
    }
  }

  for (const invalidPreflight of [
    { preflightOutput: 'anything' },
    { preflightOutput: '' },
    { preflightOutput: 'KINVEST_SECRET_PREFLIGHT_OK mode=github-tmpfs-v1 references=3' },
    { preflightOversized: true },
    { preflightStderr: true }
  ]) {
    const rejectedPreflight = runExecutor(deployer, invalidPreflight)
    try {
      assert.notEqual(rejectedPreflight.result.status, 0)
      assert.match(rejectedPreflight.result.stderr, /DEPLOY_V3_PREFLIGHT_FAILED/)
      assert.doesNotMatch(fs.readFileSync(rejectedPreflight.log, 'utf8'), /compose/)
    } finally {
      rejectedPreflight.cleanup()
    }
  }

  const forward = runExecutor(deployer)
  try {
    assert.equal(forward.result.status, 0, forward.result.stderr)
    const operations = fs.readFileSync(forward.log, 'utf8')
    assert.ok(operations.indexOf('docker:run --rm') < operations.indexOf('compose'))
    assert.equal(fs.readdirSync(forward.backupDir).length, 1)
    assert.doesNotMatch(`${forward.result.stdout}${forward.result.stderr}${operations}`, new RegExp(fakeMaterials().admin))
    const current = fs.readFileSync(path.join(forward.stateDir, 'current.state'), 'utf8')
    assert.match(current, /^protocolVersion=4$/m)
    assert.match(current, new RegExp(`^runtimeImageId=${forward.candidateId}$`, 'm'))
    assert.match(current, /^secretBundleId=[0-9a-f]{32}$/m)
    assert.equal(current.includes(fakeMaterials().admin), false)
    assert.equal(fs.existsSync(path.join(forward.stateDir, 'attempt.state')), false)
  } finally {
    forward.cleanup()
  }

  const wrongFs = runExecutor(deployer, { runFs: 'ext4' })
  try {
    assert.notEqual(wrongFs.result.status, 0)
    assert.equal(fs.readFileSync(wrongFs.log, 'utf8'), 'flock\nfindmnt\n')
  } finally {
    wrongFs.cleanup()
  }

  const offline = runExecutor(deployer, { digestMissing: true })
  try {
    assert.equal(offline.result.status, 0, offline.result.stderr)
    const operations = fs.readFileSync(offline.log, 'utf8')
    assert.match(operations, /attestation:resolve .* [0-9a-f]{40} 123/)
    assert.doesNotMatch(operations, /docker:pull /)
  } finally {
    offline.cleanup()
  }

  const metadata = materialMetadata()
  const activeState = {
    imageDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'a'.repeat(64)}`,
    runtimeImageId: `sha256:${'a'.repeat(64)}`,
    commit: 'b'.repeat(40),
    secretProviderMode: 'github-tmpfs-v1',
    secretVersionIds: metadata.versions,
    secretBundleId: '4'.repeat(32),
    secretMaterialFingerprints: JSON.stringify(metadata.fingerprints),
    databaseBackupPath: '__BACKUP__/original.sqlite',
    databaseBackupChecksum: '7'.repeat(64),
    deployedAt: '2026-08-13T00:00:00Z'
  }
  const restore = runExecutor(deployer, { intent: 'RESTORE', currentState: activeState })
  try {
    assert.equal(restore.result.status, 0, restore.result.stderr)
    const operations = fs.readFileSync(restore.log, 'utf8')
    assert.doesNotMatch(operations, /docker:pull |attestation:|docker:stop /)
    assert.equal(fs.readdirSync(restore.backupDir).length, 0)
    const restoredState = fs.readFileSync(path.join(restore.stateDir, 'current.state'), 'utf8')
    assert.match(restoredState, /^secretBundleId=(?!444444)[0-9a-f]{32}$/m)
    for (const [field, expected] of [
      ['imageDigest', activeState.imageDigest],
      ['runtimeImageId', activeState.runtimeImageId],
      ['commit', activeState.commit],
      ['schemaVersion', '0'],
      ['databaseBackupPath', path.join(restore.backupDir, 'original.sqlite')],
      ['databaseBackupChecksum', '7'.repeat(64)],
      ['deployedAt', activeState.deployedAt]
    ]) {
      const actual = restoredState.split('\n').find((line) => line.startsWith(`${field}=`))
      assert.equal(actual, `${field}=${expected}`)
    }
  } finally {
    restore.cleanup()
  }

  const rollback = runExecutor(deployer, {
    intent: 'ROLLBACK',
    currentState: { imageDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'5'.repeat(64)}` },
    previousState: {
      imageDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'a'.repeat(64)}`,
      runtimeImageId: `sha256:${'a'.repeat(64)}`,
      commit: 'b'.repeat(40)
    }
  })
  try {
    assert.equal(rollback.result.status, 0, rollback.result.stderr)
    const operations = fs.readFileSync(rollback.log, 'utf8')
    assert.doesNotMatch(operations, /docker:pull |attestation:/)
    assert.equal(fs.readdirSync(rollback.backupDir).length, 1)
  } finally {
    rollback.cleanup()
  }

  const reuseConflict = runExecutor(deployer, {
    currentState: {
      secretProviderMode: 'github-tmpfs-v1',
      secretVersionIds: metadata.versions,
      secretBundleId: '6'.repeat(32),
      secretMaterialFingerprints: JSON.stringify({
        ...metadata.fingerprints,
        deviceTokenHmac: '0'.repeat(64)
      })
    }
  })
  try {
    assert.notEqual(reuseConflict.result.status, 0)
    assert.match(reuseConflict.result.stderr, /SECRET_VERSION_REUSE_CONFLICT/)
    assert.doesNotMatch(fs.readFileSync(reuseConflict.log, 'utf8'), /docker:run --rm|compose/)
    assert.equal(fs.readdirSync(reuseConflict.runRoot).length, 0)
  } finally {
    reuseConflict.cleanup()
  }

  const historicalConflict = runExecutor(deployer, {
    ledger: {
      adminPasswordVerifier: { 'v20260813-001': '0'.repeat(64) },
      deviceTokenHmac: {}
    }
  })
  try {
    assert.notEqual(historicalConflict.result.status, 0)
    assert.match(historicalConflict.result.stderr, /SECRET_VERSION_REUSE_CONFLICT/)
    assert.doesNotMatch(fs.readFileSync(historicalConflict.log, 'utf8'), /docker:run --rm|compose/)
  } finally {
    historicalConflict.cleanup()
  }

  const pendingForward = runExecutor(deployer, { existingAttempt: true })
  try {
    assert.notEqual(pendingForward.result.status, 0)
    assert.match(pendingForward.result.stderr, /DEPLOY_V3_ATTEMPT_PENDING/)
    assert.doesNotMatch(fs.readFileSync(pendingForward.log, 'utf8'), /docker:run --rm|compose/)
    assert.equal(fs.existsSync(path.join(pendingForward.stateDir, 'attempt.state')), true)
  } finally {
    pendingForward.cleanup()
  }

  const pendingRestore = runExecutor(deployer, {
    intent: 'RESTORE',
    currentState: { ...activeState, imageSchemaMax: 1 },
    existingAttempt: {
      ...activeState,
      databaseBackupPath: '__BACKUP__/pending.sqlite',
      databaseBackupChecksum: '6'.repeat(64),
      imageSchemaMax: 1,
      schemaVersion: 1
    },
    migratedSchema: 1,
    recoverySchemaMax: 1
  })
  try {
    assert.equal(pendingRestore.result.status, 0, pendingRestore.result.stderr)
    assert.equal(fs.existsSync(path.join(pendingRestore.stateDir, 'attempt.state')), false)
    assert.doesNotMatch(fs.readFileSync(pendingRestore.log, 'utf8'), /docker:pull |attestation:/)
    const restored = fs.readFileSync(path.join(pendingRestore.stateDir, 'current.state'), 'utf8')
    assert.match(restored, /^schemaVersion=1$/m)
    assert.match(restored, /\/pending\.sqlite$/m)
    assert.match(restored, /^databaseBackupChecksum=6{64}$/m)
  } finally {
    pendingRestore.cleanup()
  }

  const incompatibleRecovery = runExecutor(deployer, { recoverySchemaMin: 1, recoverySchemaMax: 1 })
  try {
    assert.notEqual(incompatibleRecovery.result.status, 0)
    assert.match(incompatibleRecovery.result.stderr, /ROLLBACK_REQUIRES_DB_RESTORE/)
    assert.doesNotMatch(fs.readFileSync(incompatibleRecovery.log, 'utf8'), /docker:run --rm|compose/)
    assert.equal(fs.existsSync(path.join(incompatibleRecovery.stateDir, 'attempt.state')), false)
  } finally {
    incompatibleRecovery.cleanup()
  }

  const stateCommitFailure = runExecutor(deployer, { stateCommitFailure: true })
  try {
    assert.notEqual(stateCommitFailure.result.status, 0)
    assert.equal(fs.existsSync(path.join(stateCommitFailure.stateDir, 'attempt.state')), false)
    const recovered = fs.readFileSync(path.join(stateCommitFailure.stateDir, 'current.state'), 'utf8')
    assert.match(recovered, new RegExp(`^runtimeImageId=sha256:${'2'.repeat(64)}$`, 'm'))
    assert.match(recovered, /^secretProviderMode=github-tmpfs-v1$/m)
    assert.equal(fs.readFileSync(stateCommitFailure.activeImage, 'utf8'), `sha256:${'2'.repeat(64)}`)
  } finally {
    stateCommitFailure.cleanup()
  }

  const recoveryFailure = runExecutor(deployer, { healthFailure: true, recoveryFailure: true })
  try {
    assert.equal(recoveryFailure.result.status, 70)
    assert.match(recoveryFailure.result.stderr, /DEPLOY_V3_RECOVERY_FAILED/)
    assert.equal(fs.existsSync(path.join(recoveryFailure.stateDir, 'attempt.state')), true)
    const bundles = fs.readdirSync(path.join(recoveryFailure.runRoot, 'kinvest-secrets'))
    assert.equal(bundles.length, 1)
    assert.match(bundles[0], /^[0-9a-f]{32}$/)
  } finally {
    recoveryFailure.cleanup()
  }

  const incompatibleAfterMigration = runExecutor(deployer, {
    healthFailure: true,
    migratedSchema: 1,
    recoverySchemaMax: 0
  })
  try {
    assert.equal(incompatibleAfterMigration.result.status, 75)
    assert.match(incompatibleAfterMigration.result.stderr, /ROLLBACK_REQUIRES_DB_RESTORE/)
    const operations = fs.readFileSync(incompatibleAfterMigration.log, 'utf8')
    assert.match(operations, /compose.*down/)
    assert.doesNotMatch(operations, new RegExp(`compose-env:sha256:${'2'.repeat(64)}`))
    assert.equal(fs.existsSync(path.join(incompatibleAfterMigration.stateDir, 'attempt.state')), true)
  } finally {
    incompatibleAfterMigration.cleanup()
  }

  const compatibleAfterMigration = runExecutor(deployer, {
    currentState: { imageSchemaMax: 1 },
    healthFailure: true,
    migratedSchema: 1,
    recoverySchemaMax: 1
  })
  try {
    assert.notEqual(compatibleAfterMigration.result.status, 0)
    const recovered = fs.readFileSync(path.join(compatibleAfterMigration.stateDir, 'current.state'), 'utf8')
    assert.match(recovered, /^schemaVersion=1$/m)
    assert.match(recovered, /^databaseBackupPath=\/.+\.sqlite$/m)
    assert.match(recovered, /^databaseBackupChecksum=[0-9a-f]{64}$/m)
    assert.equal(fs.existsSync(path.join(compatibleAfterMigration.stateDir, 'attempt.state')), false)
  } finally {
    compatibleAfterMigration.cleanup()
  }

  const legacy = legacyStateText()
  const legacyFailure = runExecutor(deployer, {
    composeFailure: true,
    currentStateText: legacy,
    provider: 'disabled',
    realDisabledPreflight: true
  })
  try {
    assert.notEqual(legacyFailure.result.status, 0)
    assert.equal(fs.readFileSync(path.join(legacyFailure.stateDir, 'current.state'), 'utf8'), legacy)
  } finally {
    legacyFailure.cleanup()
  }

  const legacyMigrationFailure = runExecutor(deployer, {
    currentStateText: legacy,
    healthFailure: true,
    migratedSchema: 1,
    provider: 'disabled',
    realDisabledPreflight: true,
    recoverySchemaMax: 1
  })
  try {
    assert.equal(legacyMigrationFailure.result.status, 75)
    assert.match(legacyMigrationFailure.result.stderr, /ROLLBACK_REQUIRES_DB_RESTORE/)
    assert.equal(fs.readFileSync(path.join(legacyMigrationFailure.stateDir, 'current.state'), 'utf8'), legacy)
    assert.equal(fs.existsSync(path.join(legacyMigrationFailure.stateDir, 'attempt.state')), true)
  } finally {
    legacyMigrationFailure.cleanup()
  }

  const staleBundleA = '8'.repeat(32)
  const staleBundleB = '9'.repeat(32)
  const pruned = runExecutor(deployer, { oldBundles: [staleBundleA, staleBundleB] })
  try {
    assert.equal(pruned.result.status, 0, pruned.result.stderr)
    const current = fs.readFileSync(path.join(pruned.stateDir, 'current.state'), 'utf8')
    const activeBundle = current.match(/^secretBundleId=([0-9a-f]{32})$/m)[1]
    assert.deepEqual(fs.readdirSync(path.join(pruned.runRoot, 'kinvest-secrets')), [activeBundle])
  } finally {
    pruned.cleanup()
  }

  const malformedPrune = runExecutor(deployer, { malformedOldBundle: true })
  try {
    assert.equal(malformedPrune.result.status, 71)
    assert.match(malformedPrune.result.stderr, /DEPLOY_V3_CLEANUP_PENDING/)
    assert.equal(fs.existsSync(path.join(malformedPrune.stateDir, 'attempt.state')), false)
    assert.match(fs.readFileSync(path.join(malformedPrune.stateDir, 'current.state'), 'utf8'), /^protocolVersion=4$/m)
  } finally {
    malformedPrune.cleanup()
  }

  for (const failureMode of [{ composeFailure: true }, { healthFailure: true }]) {
    const failedSwitch = runExecutor(deployer, failureMode)
    try {
      assert.notEqual(failedSwitch.result.status, 0)
      const recoveredState = fs.readFileSync(path.join(failedSwitch.stateDir, 'current.state'), 'utf8')
      assert.match(recoveredState, new RegExp(`^runtimeImageId=sha256:${'2'.repeat(64)}$`, 'm'))
      assert.match(recoveredState, /^secretProviderMode=github-tmpfs-v1$/m)
      assert.match(recoveredState, new RegExp(`^secretVersionIds=${metadata.versions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
      assert.match(recoveredState, /^secretBundleId=[0-9a-f]{32}$/m)
      assert.match(recoveredState, /^schemaVersion=0$/m)
      assert.match(recoveredState, /^releaseRecordSchemaVersion=2$/m)
      assert.match(recoveredState, /^databaseBackupPath=\/.+\.sqlite$/m)
      assert.match(recoveredState, /^databaseBackupChecksum=[0-9a-f]{64}$/m)
      assert.equal(fs.existsSync(path.join(failedSwitch.stateDir, 'attempt.state')), false)
      if (failureMode.healthFailure) {
        assert.equal(
          fs.readFileSync(failedSwitch.activeImage, 'utf8'),
          `sha256:${'2'.repeat(64)}`
        )
      }
      assert.deepEqual(fs.readdirSync(failedSwitch.runRoot), ['kinvest-secrets'])
      const retainedBundles = fs.readdirSync(path.join(failedSwitch.runRoot, 'kinvest-secrets'))
      assert.equal(retainedBundles.length, 1)
      assert.match(retainedBundles[0], /^[0-9a-f]{32}$/)
      assert.match(recoveredState, new RegExp(`^secretBundleId=${retainedBundles[0]}$`, 'm'))
    } finally {
      failedSwitch.cleanup()
    }
  }

  const sshFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-v3-ssh-'))
  try {
    const fakeBin = path.join(sshFixture, 'bin')
    const capture = path.join(sshFixture, 'capture')
    fs.mkdirSync(fakeBin)
    writeExecutable(path.join(fakeBin, 'sudo'), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n')
    writeExecutable(capture, `#!/bin/sh\ncat > '${path.join(sshFixture, 'stdin')}'\n`)
    const wrapperPath = path.join(sshFixture, 'wrapper')
    writeExecutable(
      wrapperPath,
      wrapper
        .replace('/usr/local/sbin/deploy-kinvest-v3', capture)
        .replace('/usr/local/sbin/deploy-kinvest-v2', capture)
    )
    const forwarded = spawnSync(wrapperPath, [], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: 'deploy-v3' },
      input: payload()
    })
    assert.equal(forwarded.status, 0, forwarded.stderr)
    assert.equal(fs.readFileSync(path.join(sshFixture, 'stdin'), 'utf8'), payload())
    assert.equal(`${forwarded.stdout}${forwarded.stderr}`.includes(fakeMaterials().admin), false)
    fs.rmSync(path.join(sshFixture, 'stdin'))
    const forwardedV2 = spawnSync(wrapperPath, [], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: 'deploy-v2' },
      input: 'KINVEST_DEPLOY_V2\n'
    })
    assert.equal(forwardedV2.status, 0, forwardedV2.stderr)
    assert.equal(fs.readFileSync(path.join(sshFixture, 'stdin'), 'utf8'), 'KINVEST_DEPLOY_V2\n')
    const rejected = spawnSync(wrapperPath, [], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: 'deploy-v3 extra' },
      input: payload()
    })
    assert.equal(rejected.status, 2)
  } finally {
    fs.rmSync(sshFixture, { recursive: true, force: true })
  }
}

module.exports = { payload, run, runExecutor, stateText }
