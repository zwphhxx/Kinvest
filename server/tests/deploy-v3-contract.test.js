const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const helperPath = path.join(rootDir, 'deploy/server/deploy-v3-contract.py')
const legacyRecoveryIdentity = Object.freeze({
  imageDigest: 'ghcr.io/zwphhxx/kinvest@sha256:25bc6f76846f1ad429aeb8c4bf1185f8db43bb71b7e5d293197ca48f4d74ad26',
  runtimeImageId: 'sha256:46fce58a9fac1c765a5f5beeafe53a9f63fb3f4e93d4628640a2583da68000b0',
  commit: 'a0d511f0818a2dd0cc00f619af24942802f3af0d'
})
const disabledPreflightSuccess = 'KINVEST_SECRET_PREFLIGHT_OK mode=disabled references=0'

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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
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
  const preflightLog = path.join(fixture, 'preflight.log')
  const dockerRunLog = path.join(fixture, 'docker-run.log')
  const activeImage = path.join(fixture, 'active-image')
  const healthMarker = path.join(fixture, 'health-marker')
  const atomicFailureMarker = path.join(fixture, 'atomic-failure.marker')
  const contract = path.join(fixture, 'deploy-v3-contract.py')
  const compose = path.join(root, 'docker-compose-v3.yml')
  const metadataNetworkConfig = path.join(fixture, 'metadata-network.conf')
  const candidateId = `sha256:${'a'.repeat(64)}`
  const previousId = options.currentState?.runtimeImageId ?? `sha256:${'2'.repeat(64)}`
  const candidateDigest = `ghcr.io/zwphhxx/kinvest@sha256:${'a'.repeat(64)}`
  const legacyFallbackOutput = options.legacyFallbackOutput ?? `${disabledPreflightSuccess}\n`
  const legacyFallbackStderr = options.legacyFallbackStderr ?? ''
  const legacyFallbackStatus = options.legacyFallbackStatus ?? 0
  const legacyNormalOutput = options.legacyNormalOutput ?? ''
  const legacyNormalStderr = options.legacyNormalStderr ?? 'SSM_PREFLIGHT_REQUIRES_CVM_SSM\n'
  const legacyNormalStatus = options.legacyNormalStatus ?? 1
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
  fs.writeFileSync(
    metadataNetworkConfig,
    options.metadataBundlePath ? 'KINVEST_SECRET_BUNDLE_PATH=/run/secrets/poisoned\n' : 'KINVEST_METADATA_NETWORK=fixture\n'
  )
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
    .replace("METADATA_NETWORK_CONFIG='/etc/kinvest/metadata-network.conf'", `METADATA_NETWORK_CONFIG='${metadataNetworkConfig}'`)
    .replace("PUBLIC_HEALTH_URL='https://dearmina.cn/api/health'", "PUBLIC_HEALTH_URL='https://fixture.invalid/api/health'")
    .replaceAll('ulimit -f 1', 'ulimit -S -f 1')
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
  for (const [assignment, value] of [
    ['request_versions', options.requestVersionsOverride],
    ['request_fingerprints', options.requestFingerprintsOverride],
    ['request_bundle_id', options.requestBundleOverride],
    ['current_provider', options.currentProviderOverride],
    ['current_versions', options.currentVersionsOverride],
    ['current_fingerprints', options.currentFingerprintsOverride],
    ['current_bundle_id', options.currentBundleOverride]
  ]) {
    if (value !== undefined) {
      source = source.replace(
        new RegExp(`^${assignment}=.*$`, 'm'),
        `${assignment}=${shellQuote(value)}`
      )
    }
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
if [[ "$*" == *"run --rm"* ]]; then
  harness_file_limit="$(ulimit -S -f)"
  ${options.requirePreflightFileLimit ? `[[ "$harness_file_limit" == 1 ]] || exit 151` : ':'}
  ${options.disableHarnessLogLimitLift ? ':' : 'ulimit -S -f unlimited'}
  ${options.enforceLinuxDiagnosticFileLimit ? `diagnostic_write_limit="$(ulimit -S -f)"
  if [[ "$diagnostic_write_limit" != unlimited ]]; then
    if [[ -f '${dockerRunLog}' ]]; then
      diagnostic_existing="$(wc -c < '${dockerRunLog}')"
    else
      diagnostic_existing=0
    fi
    diagnostic_append="$(printf '%s\\n' "$*" | wc -c)"
    if ((diagnostic_existing + diagnostic_append > harness_file_limit * 1024)); then
      exit 153
    fi
  fi` : ':'}
  printf '%s\\n' "$*" >> '${dockerRunLog}'
  if [[ "$*" == *"bootstrapSecrets"* ]]; then
    printf '%s\\n' legacy-fallback >> '${preflightLog}'
  else
    printf '%s\\n' preflight >> '${preflightLog}'
  fi
  ${options.disableHarnessLogLimitLift ? ':' : 'ulimit -S -f "$harness_file_limit"'}
  ${options.requirePreflightFileLimit ? `[[ "$(ulimit -S -f)" == 1 ]] || exit 152` : ':'}
else
  printf 'docker:%s\\n' "$*" >> '${log}'
fi
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
    if [[ "$*" == *"bootstrapSecrets"* ]]; then
      printf '%s' ${shellQuote(legacyFallbackOutput)}
      printf '%s' ${shellQuote(legacyFallbackStderr)} >&2
      exit ${legacyFallbackStatus}
    fi
    case "$*" in
      *KINVEST_SECRET_PROVIDER_MODE=github-tmpfs-v1*)
        case "$*" in
          *KINVEST_SECRET_BUNDLE_PATH=/run/secrets/kinvest*":/run/secrets/kinvest:ro"*) ;;
          *) exit 19 ;;
        esac ;;
    esac
    ${options.legacyRecoveryPreflight ? `if [[ "$*" == *"${previousId}"*"server/secret-preflight.js"* ]]; then
      printf '%s' ${shellQuote(legacyNormalOutput)}
      printf '%s' ${shellQuote(legacyNormalStderr)} >&2
      exit ${legacyNormalStatus}
    fi` : ':'}
    ${options.preflightFailure ? 'exit 17' : options.realDisabledPreflight
      ? `case "$*" in
          *KINVEST_SECRET_BUNDLE_PATH*) exit 18 ;;
        esac
        KINVEST_SECRET_PROVIDER_MODE=disabled KINVEST_SECRET_VERSION_IDS='{}' node '${path.join(rootDir, 'server/secret-preflight.js')}'`
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
    printf 'compose-bundle-env:%s\n' "\${KINVEST_SECRET_BUNDLE_PATH-unset}" >> '${log}'
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
    dockerRunLog,
    log,
    preflightLog,
    result,
    runRoot,
    stateDir,
    fixture
  }
}

function legacyRecoveryOptions(overrides = {}) {
  return {
    currentState: { runtimeImageId: legacyRecoveryIdentity.runtimeImageId },
    currentStateText: legacyStateText(legacyRecoveryIdentity),
    legacyRecoveryPreflight: true,
    preflightOutput: disabledPreflightSuccess,
    provider: 'disabled',
    ...overrides
  }
}

async function run() {
  const wrapper = read('deploy/server/kinvest-ssh-command-v3')
  const deployer = read('deploy/server/deploy-kinvest-v3.sh')
  const compose = read('deploy/server/docker-compose-v3.yml')

  assert.match(wrapper, /deploy-v2\)/)
  assert.match(wrapper, /deploy-v3\)/)
  assert.match(wrapper, /exec sudo -n \/usr\/local\/sbin\/deploy-kinvest/)
  assert.match(wrapper, /exec sudo -n \/usr\/local\/sbin\/deploy-kinvest-v3/)
  assert.doesNotMatch(wrapper.replace('/root/docker/kinvest/state/install-v4.journal', ''), /digest|material|docker|eval/)

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
  assert.match(deployer, /if \[\[ "\$provider" == github-tmpfs-v1 \]\]/)
  assert.ok(deployer.indexOf('run_secret_preflight') < deployer.indexOf('create_database_backup'))
  assert.doesNotMatch(deployer, /set -x|KINVEST_ADMIN_PASSWORD_VERIFIER_B64URL|KINVEST_DEVICE_TOKEN_HMAC_KEY/)
  const helperSource = read('deploy/server/deploy-v3-contract.py')
  assert.match(helperSource, /^BUNDLE_UID = 0$/m)
  assert.match(helperSource, /^BUNDLE_GID = 10001$/m)
  assert.match(helperSource, /^BUNDLE_MODE = 0o550$/m)
  assert.match(helperSource, /^BUNDLE_FILE_MODE = 0o440$/m)

  assert.match(compose, /KINVEST_SECRET_PROVIDER_MODE/)
  assert.match(compose, /KINVEST_SECRET_VERSION_IDS/)
  assert.match(compose, /^ {6}- KINVEST_SECRET_BUNDLE_PATH$/m)
  assert.match(compose, /source: \$\{KINVEST_SECRET_BUNDLE_HOST_PATH:\?[^}]+\}/)
  assert.match(compose, /target: \/run\/secrets\/kinvest/)
  assert.match(compose, /read_only: true/)
  assert.doesNotMatch(compose, /PASSWORD|HMAC_KEY|SecretString|SECRET_MATERIAL/)

  const syntax = spawnSync('bash', ['-n'], { encoding: 'utf8', input: deployer })
  assert.equal(syntax.status, 0, syntax.stderr)

  const inlineLegacyProbeMatch = deployer.match(
    /--entrypoint node "\$image_id" -e '([^'\n]*bootstrapSecrets[^'\n]*)'/
  )
  assert.ok(inlineLegacyProbeMatch, 'legacy fallback must expose one inline bootstrap probe')
  const inlineLegacyProbe = spawnSync(process.execPath, ['-e', inlineLegacyProbeMatch[1]], {
    cwd: rootDir,
    encoding: 'utf8',
    env: process.env
  })
  assert.equal(inlineLegacyProbe.status, 0, inlineLegacyProbe.stderr)
  assert.equal(inlineLegacyProbe.stdout, `${disabledPreflightSuccess}\n`)
  assert.equal(inlineLegacyProbe.stderr, '')

  const preflightFailure = runExecutor(deployer, { preflightFailure: true })
  try {
    assert.notEqual(preflightFailure.result.status, 0)
    assert.match(preflightFailure.result.stderr, /DEPLOY_V3_PREFLIGHT_FAILED/)
    const operations = fs.readFileSync(preflightFailure.log, 'utf8')
    assert.match(operations, /^flock\nfindmnt\n/)
    assert.equal(fs.readFileSync(preflightFailure.preflightLog, 'utf8'), 'preflight\n')
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
    assert.equal(fs.readFileSync(disabledExecutor.preflightLog, 'utf8'), 'preflight\npreflight\n')
    assert.match(fs.readFileSync(disabledExecutor.log, 'utf8'), /^compose-bundle-env:unset$/m)
  } finally {
    disabledExecutor.cleanup()
  }

  const poisonedDisabledExecutor = runExecutor(deployer, {
    metadataBundlePath: true,
    provider: 'disabled',
    realDisabledPreflight: true
  })
  try {
    assert.notEqual(poisonedDisabledExecutor.result.status, 0)
    assert.equal(poisonedDisabledExecutor.result.stderr, 'DEPLOY_V3_METADATA_CONFIG_FORBIDDEN\n')
    assert.equal(fs.existsSync(poisonedDisabledExecutor.preflightLog), false)
    assert.equal(fs.readFileSync(poisonedDisabledExecutor.log, 'utf8'), 'flock\n')
    assert.equal(
      fs.readFileSync(path.join(poisonedDisabledExecutor.stateDir, 'current.state'), 'utf8'),
      stateText()
    )
    assert.equal(fs.existsSync(path.join(poisonedDisabledExecutor.stateDir, 'attempt.state')), false)
    assert.deepEqual(fs.readdirSync(poisonedDisabledExecutor.backupDir), [])
  } finally {
    poisonedDisabledExecutor.cleanup()
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

  const linuxBoundedPreFixFailure = runExecutor(deployer, {
    backupFailure: true,
    disableHarnessLogLimitLift: true,
    enforceLinuxDiagnosticFileLimit: true,
    requirePreflightFileLimit: true
  })
  try {
    assert.notEqual(linuxBoundedPreFixFailure.result.status, 0)
    assert.equal(
      linuxBoundedPreFixFailure.result.stderr,
      'DEPLOY_V3_RECOVERY_PREFLIGHT_FAILED\n'
    )
    assert.equal(
      fs.readFileSync(linuxBoundedPreFixFailure.preflightLog, 'utf8'),
      'preflight\n'
    )
    assert.equal(
      fs.readFileSync(linuxBoundedPreFixFailure.dockerRunLog, 'utf8').trim().split('\n').length,
      1
    )
    assert.deepEqual(fs.readdirSync(linuxBoundedPreFixFailure.backupDir), [])
    assert.doesNotMatch(fs.readFileSync(linuxBoundedPreFixFailure.log, 'utf8'), /compose/)
  } finally {
    linuxBoundedPreFixFailure.cleanup()
  }

  const linuxBoundedBackupFailure = runExecutor(deployer, {
    backupFailure: true,
    enforceLinuxDiagnosticFileLimit: true,
    requirePreflightFileLimit: true
  })
  try {
    assert.notEqual(linuxBoundedBackupFailure.result.status, 0)
    assert.match(
      linuxBoundedBackupFailure.result.stderr,
      /DEPLOY_V3_DATABASE_BACKUP_FAILED/
    )
    assert.equal(
      fs.readFileSync(linuxBoundedBackupFailure.preflightLog, 'utf8'),
      'preflight\npreflight\n'
    )
    assert.equal(
      fs.readFileSync(linuxBoundedBackupFailure.dockerRunLog, 'utf8').trim().split('\n').length,
      2
    )
  } finally {
    linuxBoundedBackupFailure.cleanup()
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
    assert.equal(fs.readFileSync(forward.preflightLog, 'utf8'), 'preflight\npreflight\n')
    assert.match(operations, /compose/)
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
    assert.equal(fs.existsSync(reuseConflict.preflightLog), false)
    assert.doesNotMatch(fs.readFileSync(reuseConflict.log, 'utf8'), /compose/)
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
    assert.equal(fs.existsSync(historicalConflict.preflightLog), false)
    assert.doesNotMatch(fs.readFileSync(historicalConflict.log, 'utf8'), /compose/)
  } finally {
    historicalConflict.cleanup()
  }

  const pendingForward = runExecutor(deployer, { existingAttempt: true })
  try {
    assert.notEqual(pendingForward.result.status, 0)
    assert.match(pendingForward.result.stderr, /DEPLOY_V3_ATTEMPT_PENDING/)
    assert.equal(fs.existsSync(pendingForward.preflightLog), false)
    assert.doesNotMatch(fs.readFileSync(pendingForward.log, 'utf8'), /compose/)
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
    assert.equal(fs.existsSync(incompatibleRecovery.preflightLog), false)
    assert.doesNotMatch(fs.readFileSync(incompatibleRecovery.log, 'utf8'), /compose/)
    assert.equal(fs.existsSync(path.join(incompatibleRecovery.stateDir, 'attempt.state')), false)
  } finally {
    incompatibleRecovery.cleanup()
  }

  const stateCommitFailure = runExecutor(deployer, { stateCommitFailure: true })
  try {
    assert.notEqual(stateCommitFailure.result.status, 0)
    assert.equal(fs.existsSync(path.join(stateCommitFailure.stateDir, 'attempt.state')), false)
    const recovered = fs.readFileSync(path.join(stateCommitFailure.stateDir, 'current.state'), 'utf8')
    assert.equal(recovered, stateText())
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
    assert.equal(recovered, stateText({ imageSchemaMax: 1 }))
    assert.equal(fs.existsSync(path.join(compatibleAfterMigration.stateDir, 'attempt.state')), false)
  } finally {
    compatibleAfterMigration.cleanup()
  }

  const legacyRecoveryCompatibility = runExecutor(deployer, legacyRecoveryOptions())
  try {
    assert.equal(
      legacyRecoveryCompatibility.result.status,
      0,
      legacyRecoveryCompatibility.result.stderr
    )
    assert.equal(
      fs.readFileSync(legacyRecoveryCompatibility.preflightLog, 'utf8'),
      'preflight\npreflight\nlegacy-fallback\n'
    )
    const dockerRuns = fs.readFileSync(legacyRecoveryCompatibility.dockerRunLog, 'utf8').trim().split('\n')
    assert.equal(dockerRuns.length, 3)
    assert.match(dockerRuns[0], new RegExp(`${legacyRecoveryCompatibility.candidateId}.*server/secret-preflight\\.js`))
    assert.match(dockerRuns[1], new RegExp(`${legacyRecoveryIdentity.runtimeImageId}.*server/secret-preflight\\.js`))
    assert.match(dockerRuns[2], new RegExp(`${legacyRecoveryIdentity.runtimeImageId}.*bootstrapSecrets`))
    for (const hardening of [
      '--user 10001:10001',
      '--read-only',
      '--cap-drop ALL',
      '--security-opt no-new-privileges:true',
      '--network none',
      'KINVEST_SECRET_PROVIDER_MODE=disabled',
      'KINVEST_SECRET_VERSION_IDS={}'
    ]) assert.match(dockerRuns[2], new RegExp(hardening.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(dockerRuns[2], /KINVEST_SECRET_BUNDLE_PATH|--volume/)
  } finally {
    legacyRecoveryCompatibility.cleanup()
  }

  for (const failureMode of [
    { name: 'candidate Compose failure', composeFailure: true },
    { name: 'candidate health failure', healthFailure: true }
  ]) {
    const legacyRecoveredSwitch = runExecutor(deployer, legacyRecoveryOptions(failureMode))
    try {
      assert.notEqual(legacyRecoveredSwitch.result.status, 0, failureMode.name)
      assert.equal(
        fs.readFileSync(path.join(legacyRecoveredSwitch.stateDir, 'current.state'), 'utf8'),
        legacyStateText(legacyRecoveryIdentity),
        failureMode.name
      )
      assert.equal(
        fs.readFileSync(legacyRecoveredSwitch.activeImage, 'utf8'),
        legacyRecoveryIdentity.runtimeImageId,
        failureMode.name
      )
      assert.equal(
        fs.existsSync(path.join(legacyRecoveredSwitch.stateDir, 'attempt.state')),
        false,
        failureMode.name
      )
      assert.equal(
        fs.existsSync(path.join(legacyRecoveredSwitch.stateDir, 'previous.state')),
        false,
        failureMode.name
      )
      const operations = fs.readFileSync(legacyRecoveredSwitch.log, 'utf8').trim().split('\n')
      const recoveryCompose = operations.filter((line) => line.startsWith('compose-env:')).at(-1)
      assert.equal(
        recoveryCompose,
        `compose-env:${legacyRecoveryIdentity.runtimeImageId}|{}|${path.join(legacyRecoveredSwitch.runRoot, 'kinvest-secrets', 'disabled')}`,
        failureMode.name
      )
      assert.equal(
        operations.filter((line) => line.startsWith('compose-bundle-env:')).at(-1),
        'compose-bundle-env:unset',
        failureMode.name
      )
      const fallbackRun = fs.readFileSync(legacyRecoveredSwitch.dockerRunLog, 'utf8')
        .trim().split('\n').find((line) => line.includes('bootstrapSecrets'))
      assert.ok(fallbackRun, failureMode.name)
      assert.doesNotMatch(fallbackRun, /KINVEST_SECRET_BUNDLE_PATH|--volume|\/run\/secrets\/kinvest/, failureMode.name)
    } finally {
      legacyRecoveredSwitch.cleanup()
    }
  }

  /** @type {Array<[string, Record<string, any>]>} */
  const legacyGuardCases = [
    ['protocol v4', {
      currentStateText: stateText(legacyRecoveryIdentity)
    }],
    ['wrong intent', {
      intent: 'ROLLBACK',
      previousState: {
        imageDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'a'.repeat(64)}`,
        runtimeImageId: `sha256:${'a'.repeat(64)}`,
        commit: 'b'.repeat(40)
      }
    }],
    ['wrong request provider', {
      provider: 'github-tmpfs-v1',
      preflightOutput: 'KINVEST_SECRET_PREFLIGHT_OK mode=github-tmpfs-v1 references=2'
    }],
    ['wrong request versions', { requestVersionsOverride: '{"unexpected":"v1"}' }],
    ['wrong request fingerprints', { requestFingerprintsOverride: '{"unexpected":"hash"}' }],
    ['wrong request bundle', { requestBundleOverride: 'f'.repeat(32) }],
    ['wrong current provider', { currentProviderOverride: 'github-tmpfs-v1' }],
    ['wrong current versions', { currentVersionsOverride: '{"unexpected":"v1"}' }],
    ['wrong current fingerprints', { currentFingerprintsOverride: '{"unexpected":"hash"}' }],
    ['wrong current bundle', { currentBundleOverride: 'e'.repeat(32) }],
    ['wrong recovery digest', {
      currentStateText: legacyStateText({
        ...legacyRecoveryIdentity,
        imageDigest: `ghcr.io/zwphhxx/kinvest@sha256:${'9'.repeat(64)}`
      })
    }],
    ['wrong recovery image ID', {
      currentState: { runtimeImageId: `sha256:${'8'.repeat(64)}` },
      currentStateText: legacyStateText({
        ...legacyRecoveryIdentity,
        runtimeImageId: `sha256:${'8'.repeat(64)}`
      })
    }],
    ['wrong recovery commit', {
      currentStateText: legacyStateText({
        ...legacyRecoveryIdentity,
        commit: '7'.repeat(40)
      })
    }],
    ['normal stdout is nonempty', { legacyNormalOutput: 'unexpected\n' }],
    ['normal stderr differs', { legacyNormalStderr: 'SSM_PREFLIGHT_FAILED\n' }],
    ['normal status differs', { legacyNormalStatus: 2 }]
  ]
  for (const [name, overrides] of legacyGuardCases) {
    const guarded = runExecutor(deployer, legacyRecoveryOptions(overrides))
    try {
      assert.notEqual(guarded.result.status, 0, name)
      assert.equal(
        fs.existsSync(guarded.preflightLog) && fs.readFileSync(guarded.preflightLog, 'utf8').includes('legacy-fallback'),
        false,
        name
      )
    } finally {
      guarded.cleanup()
    }
  }

  /** @type {Array<[string, Record<string, any>]>} */
  const malformedLegacyProbes = [
    ['unexpected output', { legacyFallbackOutput: 'unexpected\n' }],
    ['unexpected stderr', { legacyFallbackStderr: 'unexpected\n' }],
    ['unexpected status', { legacyFallbackStatus: 17 }],
    ['timeout status', { legacyFallbackStatus: 124 }]
  ]
  for (const [name, overrides] of malformedLegacyProbes) {
    const malformedProbe = runExecutor(deployer, legacyRecoveryOptions(overrides))
    try {
      assert.notEqual(malformedProbe.result.status, 0, name)
      assert.match(malformedProbe.result.stderr, /DEPLOY_V3_RECOVERY_PREFLIGHT_FAILED/, name)
      assert.equal(
        fs.readFileSync(malformedProbe.preflightLog, 'utf8'),
        'preflight\npreflight\nlegacy-fallback\n',
        name
      )
    } finally {
      malformedProbe.cleanup()
    }
  }

  const originalPrevious = stateText({ commit: '6'.repeat(40) })
  const originalLedger = {
    adminPasswordVerifier: {},
    deviceTokenHmac: {}
  }
  const legacyPretransactionFailure = runExecutor(deployer, legacyRecoveryOptions({
    legacyFallbackOutput: 'malformed\n',
    ledger: originalLedger,
    previousState: { commit: '6'.repeat(40) }
  }))
  try {
    assert.notEqual(legacyPretransactionFailure.result.status, 0)
    assert.equal(
      fs.readFileSync(path.join(legacyPretransactionFailure.stateDir, 'current.state'), 'utf8'),
      legacyStateText(legacyRecoveryIdentity)
    )
    assert.equal(
      fs.readFileSync(path.join(legacyPretransactionFailure.stateDir, 'previous.state'), 'utf8'),
      originalPrevious
    )
    assert.equal(
      fs.readFileSync(path.join(legacyPretransactionFailure.stateDir, 'secret-version-ledger.json'), 'utf8'),
      `${JSON.stringify(originalLedger)}\n`
    )
    assert.equal(fs.existsSync(path.join(legacyPretransactionFailure.stateDir, 'attempt.state')), false)
    assert.deepEqual(fs.readdirSync(legacyPretransactionFailure.backupDir), [])
    assert.doesNotMatch(fs.readFileSync(legacyPretransactionFailure.log, 'utf8'), /compose/)
    assert.equal(
      fs.readFileSync(legacyPretransactionFailure.activeImage, 'utf8'),
      legacyRecoveryIdentity.runtimeImageId
    )
  } finally {
    legacyPretransactionFailure.cleanup()
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
      assert.equal(recoveredState, stateText())
      assert.equal(fs.existsSync(path.join(failedSwitch.stateDir, 'attempt.state')), false)
      if (failureMode.healthFailure) {
        assert.equal(
          fs.readFileSync(failedSwitch.activeImage, 'utf8'),
          `sha256:${'2'.repeat(64)}`
        )
      }
      assert.equal(fs.existsSync(path.join(failedSwitch.runRoot, 'kinvest-secrets')), false)
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
        .replace('/usr/local/sbin/deploy-kinvest', capture)
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
