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

function readLogLines(filePath) {
  if (!fs.existsSync(filePath)) return []
  const source = fs.readFileSync(filePath, 'utf8').trim()
  return source ? source.split('\n') : []
}

function createSqlite(databasePath, userVersion = 0) {
  const result = spawnSync(
    'python3',
    ['-c', `import sqlite3; c=sqlite3.connect(${JSON.stringify(databasePath)}); c.execute('pragma user_version=${userVersion}'); c.close()`],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
}

function runRootFixture(deploySource, {
  mode = 'success',
  registryMode = 'ghcr-public',
  metadataPhase = 'active',
  metadataConfigVariant = 'valid',
  activationHash = null,
  activationStateSource = null,
  activationStat = '0:0:600',
  activationSymlink = false,
  secretVersionIds = '{}',
  currentSecretVersionIds = null,
  currentStateSource = null,
  previousStateSource = null,
  preflightReferences = '2'
} = {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-deploy-v2-root-'))
  const root = path.join(fixture, 'root', 'docker', 'kinvest')
  const runRoot = path.join(fixture, 'run')
  const fakeBin = path.join(fixture, 'bin')
  const fakeState = path.join(fixture, 'fake-state')
  const metadataConfigDir = path.join(fixture, 'etc', 'kinvest')
  const metadataNetworkConfig = path.join(metadataConfigDir, 'metadata-network.conf')
  const dataDir = path.join(root, 'data')
  const stateDir = path.join(root, 'state')
  const metadataActivationState = path.join(stateDir, 'metadata-network.state')
  const tcrPolicyFile = path.join(root, 'policy', 'tcr-basic.enabled')
  const database = path.join(dataDir, 'kinvest.sqlite')
  const previousDigest = `ghcr.io/zwphhxx/kinvest@sha256:${'1'.repeat(64)}`
  const candidateRepository = registryMode === 'tcr-basic'
    ? 'ccr.ccs.tencentyun.com/website-dev/kinvest'
    : 'ghcr.io/zwphhxx/kinvest'
  const candidateDigest = `${candidateRepository}@sha256:${'2'.repeat(64)}`
  const previousCommit = '3'.repeat(40)
  const candidateCommit = '4'.repeat(40)
  const previousImageId = `sha256:${'5'.repeat(64)}`
  const candidateImageId = `sha256:${'6'.repeat(64)}`
  const secretValidator = path.join(root, 'secret-version-config.py')
  const offlineImageAttestation = path.join(fakeBin, 'kinvest-offline-image-attestation')

  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(stateDir)
  fs.mkdirSync(runRoot)
  fs.mkdirSync(fakeBin)
  fs.mkdirSync(fakeState)
  fs.mkdirSync(metadataConfigDir, { recursive: true })
  if (registryMode === 'tcr-basic') {
    fs.mkdirSync(path.dirname(tcrPolicyFile), { recursive: true })
    fs.writeFileSync(tcrPolicyFile, 'enabled\n', { mode: 0o600 })
  }
  fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'services: {}\n')
  let metadataConfigSource = [
    'KINVEST_METADATA_NETWORK=kinvest-metadata-egress',
    'KINVEST_METADATA_SUBNET=172.31.252.0/29',
    'KINVEST_METADATA_GATEWAY=172.31.252.1',
    'KINVEST_CONTAINER_NAME=kinvest',
    'KINVEST_CONTAINER_IP=172.31.252.2',
    'KINVEST_BRIDGE_INTERFACE=br-kinvest-meta',
    'KINVEST_METADATA_IP=169.254.0.23',
    ''
  ].join('\n')
  if (metadataConfigVariant === 'duplicate') {
    metadataConfigSource += 'KINVEST_METADATA_GATEWAY=172.31.252.1\n'
  } else if (metadataConfigVariant === 'unknown') {
    metadataConfigSource += 'KINVEST_UNAPPROVED=value\n'
  } else if (metadataConfigVariant === 'missing') {
    metadataConfigSource = metadataConfigSource.replace('KINVEST_METADATA_GATEWAY=172.31.252.1\n', '')
  }
  fs.writeFileSync(metadataNetworkConfig, metadataConfigSource, { mode: 0o600 })
  const approvedConfigHash = crypto.createHash('sha256').update(metadataConfigSource).digest('hex')
  writeExecutable(path.join(root, 'prepare-data-dir.sh'), '#!/bin/sh\nexit 0\n')
  createSqlite(database)
  const initialCurrentState = currentStateSource === null
    ? currentSecretVersionIds === null
      ? `digest_ref=${previousDigest}\ncommit=${previousCommit}\n`
      : [
        'protocolVersion=2',
        `imageDigest=${previousDigest}`,
        `commit=${previousCommit}`,
        'schemaVersion=0',
        'imageSchemaMin=0',
        'imageSchemaMax=0',
        `secretVersionIds=${currentSecretVersionIds}`,
        'releaseRecordSchemaVersion=2',
        'verificationRunId=123456',
        'artifactSource=ghcr-public',
        'databaseBackupPath=none',
        'databaseBackupChecksum=none',
        'deployedAt=2026-08-11T00:00:00Z',
        ''
      ].join('\n')
    : currentStateSource
        .replaceAll('__DIGEST__', previousDigest)
        .replaceAll('__RUNTIME_IMAGE_ID__', previousImageId)
        .replaceAll('__COMMIT__', previousCommit)
        .replaceAll('__BACKUP_DIR__', path.join(root, 'backups'))
  fs.writeFileSync(path.join(stateDir, 'current.state'), initialCurrentState)
  const initialPreviousState = previousStateSource === null
    ? null
    : previousStateSource
        .replaceAll('__DIGEST__', candidateDigest)
        .replaceAll('__RUNTIME_IMAGE_ID__', candidateImageId)
        .replaceAll('__COMMIT__', candidateCommit)
        .replaceAll('__BACKUP_DIR__', path.join(root, 'backups'))
  if (initialPreviousState !== null) {
    fs.writeFileSync(
      path.join(stateDir, 'previous.state'),
      initialPreviousState
    )
  }
  fs.copyFileSync(path.join(rootDir, 'deploy/server/secret-version-config.py'), secretValidator)
  fs.chmodSync(secretValidator, 0o755)
  if (metadataPhase !== null || activationStateSource !== null) {
    const stateSource = activationStateSource === null
      ? `version=1\nmode=${metadataPhase}\nconfig_sha256=${activationHash || approvedConfigHash}\n`
      : activationStateSource.replaceAll('__CONFIG_SHA256__', approvedConfigHash)
    if (activationSymlink) {
      const activationTarget = path.join(stateDir, 'metadata-network.state.target')
      fs.writeFileSync(activationTarget, stateSource, { mode: 0o600 })
      fs.symlinkSync(activationTarget, metadataActivationState)
    } else {
      fs.writeFileSync(metadataActivationState, stateSource, { mode: 0o600 })
    }
  }
  fs.writeFileSync(
    path.join(fakeState, 'running.ref'),
    `${initialCurrentState.startsWith('protocolVersion=3\n') ? previousImageId : previousDigest}\n`
  )
  fs.writeFileSync(path.join(fakeState, 'running.id'), `${previousImageId}\n`)
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
printf '%s\n' "$*" >> "$KINVEST_FAKE_STATE/timeout.log"
if [ "$KINVEST_FAKE_MODE" = offline-helper-timeout ] && [ "$1" = "$KINVEST_OFFLINE_HELPER_PATH" ]; then exit 124; fi
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
    path.join(fakeBin, 'stat'),
    `#!/bin/sh
target=''
for argument in "$@"; do target="$argument"; done
if [ "$target" = "$KINVEST_METADATA_CONFIG_PATH" ]; then
  printf '%s\n' '0:0:600'
  exit 0
fi
if [ "$target" = "$KINVEST_METADATA_ACTIVATION_PATH" ]; then
  printf '%s\n' "$KINVEST_METADATA_ACTIVATION_STAT"
  exit 0
fi
if [ "$target" = "$KINVEST_TCR_POLICY_PATH" ]; then
  case " $* " in
    *" %U:%G "*) printf '%s\n' 'root:root' ;;
    *" %a "*) printf '%s\n' '600' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
case "$target" in
  "$KINVEST_METADATA_SNAPSHOT_PREFIX"*) printf '%s\n' '0:0:600'; exit 0 ;;
esac
exec /usr/bin/stat "$@"
`
  )
  writeExecutable(path.join(fakeBin, 'chown'), '#!/bin/sh\nexit 0\n')
  writeExecutable(
    path.join(fakeBin, 'cp'),
    `#!/bin/sh
if [ "$1" = -- ]; then shift; fi
source_path="$1"
destination_path="$2"
if [ "$KINVEST_FAKE_MODE" = config-replaced-during-copy ] && [ "$source_path" = "$KINVEST_METADATA_CONFIG_PATH" ]; then
  /bin/cp "$source_path" "$destination_path"
  sed 's/KINVEST_CONTAINER_IP=172.31.252.2/KINVEST_CONTAINER_IP=172.31.252.3/' "$destination_path" > "$destination_path.next"
  mv "$destination_path.next" "$destination_path"
  sed 's/KINVEST_CONTAINER_IP=172.31.252.2/KINVEST_CONTAINER_IP=172.31.252.3/' "$source_path" > "$source_path.next"
  mv "$source_path.next" "$source_path"
  exit 0
fi
exec /bin/cp "$@"
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
    offlineImageAttestation,
    `#!/bin/sh
printf '%s\n' "$*" >> "$KINVEST_FAKE_STATE/offline-helper.log"
[ "$1" = resolve ] || exit 2
case "$KINVEST_FAKE_MODE" in
  exact-digest-with-helper|offline-valid|offline-missing-local-id|tcr-exact-with-helper|tcr-helper-valid|tcr-helper-valid-pull-failure)
    printf '%s\n' "$KINVEST_CANDIDATE_IMAGE_ID"
    ;;
  offline-error-code)
    printf '%s\n' 'OFFLINE_ATTESTATION_NOT_FOUND' >&2
    exit 1
    ;;
  offline-arbitrary-stderr)
    printf '%s\n' 'secret-like-payload-must-never-escape' >&2
    exit 1
    ;;
  offline-multiline-stderr)
    printf '%s\n%s\n' 'OFFLINE_ATTESTATION_NOT_FOUND' 'secret-like-payload-must-never-escape' >&2
    exit 1
    ;;
  offline-helper-abnormal)
    printf '%s\n' 'secret-like-payload-must-never-escape' >&2
    exit 137
    ;;
  offline-helper-parent-signal)
    kill -TERM "$KINVEST_TEST_DEPLOY_PID"
    sleep 1
    exit 143
    ;;
  offline-malformed|offline-pull-failure)
    printf '%s\n' 'sha256:not-an-image-id'
    ;;
  offline-wrong-commit|offline-wrong-run)
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
`
  )
  writeExecutable(
    path.join(fakeBin, 'docker'),
    `#!/bin/sh
printf '%s\n' "$*" >> "$KINVEST_FAKE_STATE/docker.log"
printf 'docker:%s\n' "$*" >> "$KINVEST_FAKE_STATE/lifecycle.log"
if [ "$1" = run ] || [ "$1" = compose ]; then
  printf '%s|%s|%s\n' "$1" "\${KINVEST_SECRET_PROVIDER_MODE:-}" "\${KINVEST_SECRET_VERSION_IDS:-}" >> "$KINVEST_FAKE_STATE/runtime-env.log"
fi
if [ "$1" = compose ]; then
  printf 'compose|%s\n' "\${KINVEST_IMAGE:-}" >> "$KINVEST_FAKE_STATE/image-env.log"
fi
if [ "$1" = network ]; then
  target=''
  for argument in "$@"; do target="$argument"; done
  if [ "$KINVEST_FAKE_MODE" = metadata-network-missing ] && [ "$target" = kinvest-metadata-egress ]; then exit 1; fi
  exit 0
fi
if [ "$1" = pull ]; then
  if [ "$KINVEST_FAKE_MODE" = signal ]; then kill -TERM "$PPID"; sleep 1; exit 143; fi
  pull_count=0
  if [ -f "$KINVEST_FAKE_STATE/pull-count" ]; then pull_count="$(cat "$KINVEST_FAKE_STATE/pull-count")"; fi
  pull_count=$((pull_count + 1))
  printf '%s\n' "$pull_count" > "$KINVEST_FAKE_STATE/pull-count"
  if [ "$KINVEST_FAKE_MODE" = local-digest-transient ] && [ "$pull_count" -eq 1 ]; then exit 124; fi
  if [ "$KINVEST_FAKE_MODE" = pull-failure-with-digest ]; then : > "$KINVEST_FAKE_STATE/pulled"; printf 'access denied\n' >&2; exit 1; fi
  if [ "$KINVEST_FAKE_MODE" = offline-pull-failure ] || [ "$KINVEST_FAKE_MODE" = tcr-helper-valid-pull-failure ]; then printf 'access denied\n' >&2; exit 1; fi
  : > "$KINVEST_FAKE_STATE/pulled"
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
        case "$KINVEST_FAKE_MODE" in
          local-tag-and-id-only|local-digest-transient|signal|offline-*|pull-failure-with-digest|tcr-helper-valid|tcr-helper-valid-pull-failure)
            if [ ! -f "$KINVEST_FAKE_STATE/pulled" ]; then
              printf '["ghcr.io/zwphhxx/kinvest:offline-import"]\n'
            else
              printf '["%s"]\n' "$ref"
            fi
            ;;
          *) printf '["%s"]\n' "$ref" ;;
        esac
      fi
      ;;
    *schema.min*|*schema.max*) printf '0\n' ;;
    *secret-bootstrap*)
      if [ "$KINVEST_FAKE_MODE" = preflight-label-missing ]; then printf '<no value>\n'; else printf '1\n'; fi
      ;;
    *Id*)
      case "$ref" in
        "$KINVEST_CANDIDATE"|"$KINVEST_CANDIDATE_IMAGE_ID")
          if [ "$KINVEST_FAKE_MODE" = offline-missing-local-id ] && [ "$ref" = "$KINVEST_CANDIDATE_IMAGE_ID" ] && [ ! -f "$KINVEST_FAKE_STATE/pulled" ]; then exit 1; fi
          printf '%s\n' "$KINVEST_CANDIDATE_IMAGE_ID"
          ;;
        "$KINVEST_PREVIOUS"|"$KINVEST_PREVIOUS_IMAGE_ID") printf '%s\n' "$KINVEST_PREVIOUS_IMAGE_ID" ;;
        *) exit 1 ;;
      esac
      ;;
  esac
  exit 0
fi
if [ "$1" = run ]; then
  case "$KINVEST_FAKE_MODE" in
    preflight-failure) printf 'SSM_PREFLIGHT_FAILED\n' >&2; exit 1 ;;
    preflight-stderr) printf 'unexpected\n' >&2 ;;
    preflight-extra-output) printf 'KINVEST_SSM_PREFLIGHT_OK references=%s\nextra\n' "$KINVEST_PREFLIGHT_REFERENCES"; exit 0 ;;
    preflight-missing-entry) exit 127 ;;
  esac
  printf 'KINVEST_SSM_PREFLIGHT_OK references=%s\n' "$KINVEST_PREFLIGHT_REFERENCES"
  exit 0
fi
if [ "$1" = inspect ]; then
  format="$3"
  case "$format" in
    *Health.Status*) cat "$KINVEST_FAKE_STATE/running.health" ;;
    *Config.Image*) cat "$KINVEST_FAKE_STATE/running.ref" ;;
    *Image*) cat "$KINVEST_FAKE_STATE/running.id" ;;
  esac
  exit 0
fi
if [ "$1" = compose ]; then
  case " $* " in
    *" config "*) printf '%s\n' 'services: {}'; exit 0 ;;
  esac
  printf '%s\n' "$KINVEST_IMAGE" > "$KINVEST_FAKE_STATE/running.ref"
  case "$KINVEST_IMAGE" in
    "$KINVEST_CANDIDATE"|"$KINVEST_CANDIDATE_IMAGE_ID") printf '%s\n' "$KINVEST_CANDIDATE_IMAGE_ID" > "$KINVEST_FAKE_STATE/running.id" ;;
    "$KINVEST_PREVIOUS"|"$KINVEST_PREVIOUS_IMAGE_ID") printf '%s\n' "$KINVEST_PREVIOUS_IMAGE_ID" > "$KINVEST_FAKE_STATE/running.id" ;;
    *) exit 1 ;;
  esac
  if [ "$KINVEST_FAKE_MODE" = runtime-ref-mismatch ]; then printf '%s\n' "$KINVEST_CANDIDATE" > "$KINVEST_FAKE_STATE/running.ref"; fi
  if [ "$KINVEST_FAKE_MODE" = runtime-id-mismatch ]; then printf 'sha256:%064d\n' 9 > "$KINVEST_FAKE_STATE/running.id"; fi
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

  const fakeMetadataFirewall = path.join(fakeBin, 'kinvest-metadata-firewall')
  writeExecutable(
    fakeMetadataFirewall,
    `#!/bin/sh
printf '%s\n' "$1" >> "$KINVEST_FAKE_STATE/firewall.log"
printf '%s\n' "\${KMF_CONFIG:-}" >> "$KINVEST_FAKE_STATE/firewall-config.log"
printf 'firewall:%s\n' "$1" >> "$KINVEST_FAKE_STATE/lifecycle.log"
case "$1:$KINVEST_FAKE_MODE" in
  validate-config:*) [ "$KINVEST_FAKE_CONFIG_VALID" = 1 ] || exit 1 ;;
  status:wrong-bridge|status:extra-member) exit 1 ;;
  reconcile:post-reconcile-failure) exit 1 ;;
  guard:*|apply:*|status:*|reconcile:*) exit 0 ;;
  *) exit 91 ;;
esac
`
  )

  const instrumented = deploySource
    .replace('set -euo pipefail', () => 'set -euo pipefail\nexport KINVEST_TEST_DEPLOY_PID=$$')
    .replace("ROOT='/root/docker/kinvest'", `ROOT='${root}'`)
    .replace("RUN_ROOT='/run'", `RUN_ROOT='${runRoot}'`)
    .replace("METADATA_NETWORK_CONFIG='/etc/kinvest/metadata-network.conf'", `METADATA_NETWORK_CONFIG='${metadataNetworkConfig}'`)
    .replace("METADATA_FIREWALL='/usr/local/sbin/kinvest-metadata-firewall'", `METADATA_FIREWALL='${fakeMetadataFirewall}'`)
    .replace("SECRET_VERSION_VALIDATOR='/usr/local/libexec/kinvest-secret-version-config'", `SECRET_VERSION_VALIDATOR='${secretValidator}'`)
    .replace("OFFLINE_IMAGE_ATTESTATION='/usr/local/libexec/kinvest-offline-image-attestation'", `OFFLINE_IMAGE_ATTESTATION='${offlineImageAttestation}'`)
    .replace('TCR_POLICY_FILE="$ROOT/policy/tcr-basic.enabled"', `TCR_POLICY_FILE='${tcrPolicyFile}'`)
  const scriptPath = path.join(fixture, 'deploy-v2')
  writeExecutable(scriptPath, instrumented)
  const payload = [
    'KINVEST_DEPLOY_V2',
    candidateDigest,
    candidateCommit,
    registryMode,
    registryMode === 'tcr-basic' ? 'ccr.ccs.tencentyun.com' : 'ghcr.io',
    registryMode === 'tcr-basic' ? 'pull-only-user' : '',
    registryMode === 'tcr-basic' ? 'registry-password-fixture-never-log' : '',
    '2',
    '987654',
    registryMode === 'tcr-basic' ? 'tcr-private' : 'ghcr-public',
    secretVersionIds,
    'EOF'
  ].join('\n') + '\n'
  const result = spawnSync(scriptPath, [], {
    encoding: 'utf8',
    input: payload,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      KINVEST_CANDIDATE: candidateDigest,
      KINVEST_CANDIDATE_IMAGE_ID: candidateImageId,
      KINVEST_PREVIOUS: previousDigest,
      KINVEST_PREVIOUS_IMAGE_ID: previousImageId,
      KINVEST_FAKE_DB: database,
      KINVEST_FAKE_MODE: mode,
      KINVEST_FAKE_STATE: fakeState,
      KINVEST_PREFLIGHT_REFERENCES: preflightReferences,
      KINVEST_METADATA_CONFIG_PATH: metadataNetworkConfig,
      KINVEST_METADATA_ACTIVATION_PATH: metadataActivationState,
      KINVEST_METADATA_ACTIVATION_STAT: activationStat,
      KINVEST_TCR_POLICY_PATH: tcrPolicyFile,
      KINVEST_OFFLINE_HELPER_PATH: offlineImageAttestation,
      KINVEST_METADATA_SNAPSHOT_PREFIX: path.join(runRoot, 'kinvest-metadata-network.'),
      KINVEST_FAKE_CONFIG_VALID: metadataConfigVariant === 'valid' ? '1' : '0'
    }
  })

  return {
    candidateDigest,
    candidateCommit,
    candidateImageId,
    cleanup() { fs.rmSync(fixture, { recursive: true, force: true }) },
    fakeState,
    initialCurrentState,
    initialPreviousState,
    metadataActivationState,
    metadataNetworkConfig,
    approvedConfigHash,
    result,
    previousCommit,
    previousDigest,
    previousImageId,
    registryMode,
    root,
    runRoot,
    stateDir
  }
}

function runUnsafeInstallerTargetFixture(installerSource) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-installer-target-'))
  const fakeBin = path.join(fixtureRoot, 'bin')
  const sourceDir = path.join(fixtureRoot, 'source')
  const localSbin = path.join(fixtureRoot, 'root', 'usr', 'local', 'sbin')
  const localLibexec = path.join(fixtureRoot, 'root', 'usr', 'local', 'libexec')
  const runDir = path.join(fixtureRoot, 'root', 'run')
  const operationsLog = path.join(fixtureRoot, 'operations.log')
  const deployTarget = path.join(localSbin, 'deploy-kinvest')
  const wrapperTarget = path.join(localSbin, 'kinvest-ssh-command')
  const validatorTarget = path.join(localLibexec, 'kinvest-secret-version-config')
  const helperTarget = path.join(localLibexec, 'kinvest-offline-image-attestation')

  for (const directory of [fakeBin, sourceDir, localSbin, localLibexec, runDir]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  for (const sourceFile of ['deploy-kinvest-v2.sh', 'kinvest-ssh-command-v2']) {
    fs.writeFileSync(path.join(sourceDir, sourceFile), '#!/usr/bin/env bash\nexit 0\n', {
      mode: 0o755
    })
  }
  fs.writeFileSync(
    path.join(sourceDir, 'secret-version-config.py'),
    '#!/usr/bin/env python3\nimport sys\nassert sys.argv[1:] == ["mapping"]\nassert sys.stdin.read() == "{}\\n"\nprint("{}")\n',
    { mode: 0o755 }
  )
  fs.writeFileSync(
    path.join(sourceDir, 'offline-image-attestation.py'),
    '#!/usr/bin/env python3\nimport sys\nif sys.argv[1:] == ["self-check"]:\n    print("KINVEST_OFFLINE_ATTESTATION_SELF_CHECK_OK")\nelse:\n    raise SystemExit(1)\n',
    { mode: 0o755 }
  )
  fs.writeFileSync(deployTarget, 'original-deployer\n', { mode: 0o755 })
  fs.writeFileSync(wrapperTarget, 'original-wrapper\n', { mode: 0o755 })
  fs.writeFileSync(validatorTarget, 'original-validator\n', { mode: 0o755 })
  fs.mkdirSync(helperTarget)

  fs.writeFileSync(
    path.join(fakeBin, 'id'),
    '#!/bin/sh\n[ "${1:-}" = "-u" ] || exit 90\nprintf \'%s\\n\' 0\n',
    { mode: 0o755 }
  )
  fs.writeFileSync(
    path.join(fakeBin, 'realpath'),
    '#!/bin/sh\nfor argument do canonical="$argument"; done\nprintf \'%s\\n\' "$canonical"\n',
    { mode: 0o755 }
  )
  for (const command of ['install', 'mv', 'chown']) {
    fs.writeFileSync(
      path.join(fakeBin, command),
      `#!/bin/sh\nprintf '%s\\n' '${command}' >> "$KINVEST_INSTALLER_OPERATIONS"\nexit 97\n`,
      { mode: 0o755 }
    )
  }

  const instrumentedInstaller = installerSource
    .replaceAll('/usr/local/sbin', localSbin)
    .replaceAll('/usr/local/libexec', localLibexec)
    .replaceAll('/run/kinvest-offline-pycache', path.join(runDir, 'kinvest-offline-pycache'))
  const installerPath = path.join(fixtureRoot, 'install-deploy-v2.sh')
  fs.writeFileSync(installerPath, instrumentedInstaller, { mode: 0o755 })
  const result = spawnSync('bash', [installerPath, sourceDir], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KINVEST_INSTALLER_OPERATIONS: operationsLog,
      PATH: `${fakeBin}:${process.env.PATH}`
    },
    timeout: 5000
  })

  return {
    cleanup() {
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    },
    deployTarget,
    helperTarget,
    localLibexec,
    localSbin,
    operationsLog,
    result,
    validatorTarget,
    wrapperTarget
  }
}

function runTransactionalInstallerFixture(installerSource, {
  fault,
  helperInitiallyAbsent = false,
  deploymentOwnsLock = false
}) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-installer-transaction-'))
  const fakeBin = path.join(fixtureRoot, 'bin')
  const sourceDir = path.join(fixtureRoot, 'source')
  const localSbin = path.join(fixtureRoot, 'root', 'usr', 'local', 'sbin')
  const localLibexec = path.join(fixtureRoot, 'root', 'usr', 'local', 'libexec')
  const runDir = path.join(fixtureRoot, 'root', 'run')
  const fakeState = path.join(fixtureRoot, 'state')
  const deployState = path.join(fixtureRoot, 'deploy-state')
  const deployLock = path.join(deployState, 'deploy.lock')
  const moveCount = path.join(fakeState, 'move-count')
  const pythonCount = path.join(fakeState, 'python-count')
  for (const directory of [fakeBin, sourceDir, localSbin, localLibexec, runDir, fakeState, deployState]) {
    fs.mkdirSync(directory, { recursive: true })
  }

  const sourceAssets = {
    'deploy-kinvest-v2.sh': '#!/usr/bin/env bash\nprintf \'%s\\n\' new-deployer\n',
    'kinvest-ssh-command-v2': '#!/usr/bin/env bash\nprintf \'%s\\n\' new-wrapper\n',
    'secret-version-config.py': '#!/usr/bin/env python3\nimport sys\nassert sys.argv[1:] == ["mapping"]\nassert sys.stdin.read() == "{}\\n"\nprint("{}")\n',
    'offline-image-attestation.py': '#!/usr/bin/env python3\nimport sys\nif sys.argv[1:] == ["self-check"]:\n    print("KINVEST_OFFLINE_ATTESTATION_SELF_CHECK_OK")\nelse:\n    raise SystemExit(1)\n'
  }
  for (const [name, contents] of Object.entries(sourceAssets)) {
    fs.writeFileSync(path.join(sourceDir, name), contents, { mode: 0o755 })
  }

  const targets = {
    deployer: path.join(localSbin, 'deploy-kinvest'),
    wrapper: path.join(localSbin, 'kinvest-ssh-command'),
    validator: path.join(localLibexec, 'kinvest-secret-version-config'),
    helper: path.join(localLibexec, 'kinvest-offline-image-attestation')
  }
  const originals = {
    deployer: { contents: 'original-deployer\n', mode: 0o700 },
    wrapper: { contents: 'original-wrapper\n', mode: 0o710 },
    validator: { contents: 'original-validator\n', mode: 0o720 },
    helper: helperInitiallyAbsent ? null : { contents: 'original-helper\n', mode: 0o730 }
  }
  for (const [name, target] of Object.entries(targets)) {
    const original = originals[name]
    if (original !== null) {
      fs.writeFileSync(target, original.contents, { mode: original.mode })
      fs.chmodSync(target, original.mode)
    }
  }

  const realPython = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8'
  }).stdout.trim()
  const realMv = spawnSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).stdout.trim()
  const realCp = spawnSync('sh', ['-c', 'command -v cp'], { encoding: 'utf8' }).stdout.trim()
  const realShasum = spawnSync('sh', ['-c', 'command -v shasum'], { encoding: 'utf8' }).stdout.trim()

  fs.writeFileSync(path.join(fakeBin, 'id'), '#!/bin/sh\nprintf \'%s\\n\' 0\n', { mode: 0o755 })
  fs.writeFileSync(
    path.join(fakeBin, 'realpath'),
    '#!/bin/sh\nfor argument do canonical="$argument"; done\nprintf \'%s\\n\' "$canonical"\n',
    { mode: 0o755 }
  )
  fs.writeFileSync(
    path.join(fakeBin, 'sha256sum'),
    `#!/bin/sh
set -eu
for path do :; done
checksum="$("$KINVEST_REAL_SHASUM" -a 256 "$path" | awk '{print $1}')"
printf '%s  %s\n' "$checksum" "$path"
`,
    { mode: 0o755 }
  )
  fs.writeFileSync(
    path.join(fakeBin, 'stat'),
    `#!/bin/sh
set -eu
for path do :; done
mode="$(/usr/bin/stat -f '%Lp' "$path")"
printf '0:0:%s\n' "$mode"
`,
    { mode: 0o755 }
  )
  fs.writeFileSync(path.join(fakeBin, 'chown'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(
    path.join(fakeBin, 'flock'),
    `#!/bin/sh
exec "$KINVEST_REAL_PYTHON" - "$@" <<'PY'
import fcntl
import sys

operation = fcntl.LOCK_EX
if "-n" in sys.argv[1:]:
    operation |= fcntl.LOCK_NB
try:
    fcntl.flock(int(sys.argv[-1]), operation)
except BlockingIOError:
    raise SystemExit(1)
PY
`,
    { mode: 0o755 }
  )
  fs.writeFileSync(
    path.join(fakeBin, 'install'),
    `#!/bin/sh
set -eu
directory_mode=0
mode=0755
source=''
target=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d) directory_mode=1; shift ;;
    -o|-g|-m) [ "$1" = '-m' ] && mode="$2"; shift 2 ;;
    --) shift ;;
    *) if [ -z "$source" ]; then source="$1"; else target="$1"; fi; shift ;;
  esac
done
if [ "$directory_mode" -eq 1 ]; then
  target="$source"
  mkdir -p "$target"
  chmod "$mode" "$target"
else
  cat "$source" > "$target"
  chmod "$mode" "$target"
fi
`,
    { mode: 0o755 }
  )
  fs.writeFileSync(
    path.join(fakeBin, 'cp'),
    `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in --preserve=*|--) shift ;; *) break ;; esac
done
exec "$KINVEST_REAL_CP" -p "$1" "$2"
`,
    { mode: 0o755 }
  )
  fs.writeFileSync(
    path.join(fakeBin, 'mv'),
    `#!/bin/sh
set -eu
"$KINVEST_REAL_PYTHON" - "$KINVEST_DEPLOY_LOCK_PATH" <<'PY'
import fcntl
import os
import sys

descriptor = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)
try:
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        pass
    else:
        raise SystemExit(95)
finally:
    os.close(descriptor)
PY
count=0
[ ! -f "$KINVEST_MOVE_COUNT" ] || count="$(cat "$KINVEST_MOVE_COUNT")"
count=$((count + 1))
printf '%s\n' "$count" > "$KINVEST_MOVE_COUNT"
while [ "$#" -gt 0 ]; do
  case "$1" in -fT|--|-f) shift ;; *) break ;; esac
done
if [ "$KINVEST_INSTALL_FAULT" = "move-$count" ]; then exit 97; fi
if [ "$KINVEST_INSTALL_FAULT" = 'restore-stage-failure' ]; then
  [ "$count" -ne 4 ] || exit 97
  [ "$count" -ne 5 ] || exit 98
fi
if [ "$KINVEST_INSTALL_FAULT" = 'rollback-second-signal' ] && [ "$count" -eq 4 ]; then exit 97; fi
"$KINVEST_REAL_MV" -f "$1" "$2"
if [ "$KINVEST_INSTALL_FAULT" = "signal-$count" ]; then
  kill -TERM "$PPID"
  sleep 1
  exit 143
fi
if [ "$KINVEST_INSTALL_FAULT" = 'rollback-second-signal' ] && [ "$count" -eq 5 ]; then
  kill -TERM "$PPID"
  sleep 1
  exit 143
fi
`,
    { mode: 0o755 }
  )
  fs.writeFileSync(
    path.join(fakeBin, 'python3'),
    `#!/bin/sh
set -eu
case " $* " in
  *' self-check '*)
    count=0
    [ ! -f "$KINVEST_PYTHON_COUNT" ] || count="$(cat "$KINVEST_PYTHON_COUNT")"
    count=$((count + 1))
    printf '%s\n' "$count" > "$KINVEST_PYTHON_COUNT"
    if [ "$KINVEST_INSTALL_FAULT" = 'post-helper-validation' ] && [ "$count" -eq 3 ]; then
      exit 96
    fi
    ;;
esac
exec "$KINVEST_REAL_PYTHON" "$@"
`,
    { mode: 0o755 }
  )

  const instrumentedInstaller = installerSource
    .replaceAll('/usr/local/sbin', localSbin)
    .replaceAll('/usr/local/libexec', localLibexec)
    .replaceAll('/run/kinvest-offline-pycache', path.join(runDir, 'kinvest-offline-pycache'))
    .replaceAll('/run/kinvest-deploy-v2-backup', path.join(runDir, 'kinvest-deploy-v2-backup'))
    .replaceAll('/root/docker/kinvest/state/deploy.lock', deployLock)
  const installerPath = path.join(fixtureRoot, 'install-deploy-v2.sh')
  fs.writeFileSync(installerPath, instrumentedInstaller, { mode: 0o755 })
  const installerEnvironment = {
    ...process.env,
    KINVEST_DEPLOY_LOCK_PATH: deployLock,
    KINVEST_INSTALL_FAULT: fault,
    KINVEST_MOVE_COUNT: moveCount,
    KINVEST_PYTHON_COUNT: pythonCount,
    KINVEST_REAL_CP: realCp,
    KINVEST_REAL_MV: realMv,
    KINVEST_REAL_PYTHON: realPython,
    KINVEST_REAL_SHASUM: realShasum,
    PATH: `${fakeBin}:${process.env.PATH}`
  }
  const result = deploymentOwnsLock
    ? spawnSync(realPython, ['-c', `
import fcntl
import os
import subprocess
import sys

with open(sys.argv[3], "a+b") as lock_file:
    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    completed = subprocess.run(
        ["bash", sys.argv[1], sys.argv[2]],
        env=os.environ,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=5,
    )
sys.stdout.write(completed.stdout)
sys.stderr.write(completed.stderr)
raise SystemExit(completed.returncode)
`, installerPath, sourceDir, deployLock], {
        encoding: 'utf8',
        env: installerEnvironment,
        timeout: 5000
      })
    : spawnSync('bash', [installerPath, sourceDir], {
    encoding: 'utf8',
    env: installerEnvironment,
    timeout: 5000
  })

  return {
    cleanup() {
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    },
    localLibexec,
    localSbin,
    originals,
    result,
    runDir,
    targets
  }
}

async function run() {
  const wrapper = read('deploy/server/kinvest-ssh-command-v2')
  const deploy = read('deploy/server/deploy-kinvest-v2.sh')
  const installer = read('deploy/server/install-deploy-v2.sh')
  const workflow = read('.github/workflows/deploy-production-v2-manual.yml')
  const publishWorkflow = read('.github/workflows/deploy.yml')
  const dockerfile = read('Dockerfile')
  const attestationDesign = read('docs/superpowers/specs/2026-08-12-offline-artifact-attestation-design.md')
  const deployRunbook = read('docs/operations/deploy-v2-runbook.md')

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
  assert.match(deploy, /^OFFLINE_IMAGE_ATTESTATION='\/usr\/local\/libexec\/kinvest-offline-image-attestation'$/m)
  assert.match(deploy, /ROLLBACK_REQUIRES_DB_RESTORE/)
  assert.match(deploy, /TCR_POLICY_FILE/)
  assert.match(deploy, /atomic_write_attempt_state/)
  assert.match(deploy, /run_docker stop kinvest/)
  assert.match(deploy, /verify_public_health/)
  assert.match(deploy, /protocolVersion=3/)
  assert.match(deploy, /^METADATA_NETWORK_CONFIG='\/etc\/kinvest\/metadata-network\.conf'$/m)
  assert.match(deploy, /^METADATA_FIREWALL='\/usr\/local\/sbin\/kinvest-metadata-firewall'$/m)
  assert.match(deploy, /atomic_write_metadata_activation_state/)
  assert.match(deploy, /metadata_config_snapshot=.*mktemp.*\$RUN_ROOT/)
  assert.match(deploy, /run_metadata_firewall validate-config/)
  assert.match(deploy, /run_metadata_firewall status/)
  assert.match(deploy, /run_metadata_firewall guard[\s\S]{0,300}run_compose "\$candidate_runtime_image_id"/)
  assert.match(deploy, /run_compose "\$candidate_runtime_image_id"[\s\S]{0,300}run_metadata_firewall reconcile/)
  assert.match(deploy, /docker compose[\s\\]*\n?[\s\S]{0,300}--env-file "\$metadata_config_snapshot"/)
  assert.doesNotMatch(deploy, /--env-file\s+(?:\.env|"\.env")/)
  for (const field of [
    'imageDigest',
    'runtimeImageId',
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
  assert.match(installer, /secret-version-config\.py/)
  assert.match(installer, /offline-image-attestation\.py/)
  assert.match(
    installer,
    /^LOCAL_OFFLINE_ATTESTATION='\/usr\/local\/libexec\/kinvest-offline-image-attestation'$/m
  )
  assert.match(installer, /install -d -o root -g root -m 0755 -- \/usr\/local\/libexec/)
  assert.doesNotMatch(installer, /for source_file in [^\n]*secret-version-config\.py/)
  assert.match(installer, /python3 "\$SOURCE_DIR\/secret-version-config\.py" mapping/)
  assert.match(installer, /! -f "\$SOURCE_DIR\/offline-image-attestation\.py"/)
  assert.match(installer, /-L "\$SOURCE_DIR\/offline-image-attestation\.py"/)
  assert.match(installer, /python3 -m py_compile "\$SOURCE_DIR\/offline-image-attestation\.py"/)
  assert.match(installer, /python3 "\$SOURCE_DIR\/offline-image-attestation\.py" self-check/)
  assert.match(installer, /compile_cache="\$\(mktemp -d \/run\/kinvest-offline-pycache\.XXXXXX\)"/)
  assert.match(installer, /PYTHONPYCACHEPREFIX="\$compile_cache" python3 -m py_compile/)
  assert.match(installer, /rm -rf -- "\$compile_cache"/)
  assert.match(installer, /mktemp \/usr\/local\/libexec\/\.kinvest-offline-image-attestation\.XXXXXX/)
  assert.match(installer, /install -o root -g root -m 0755 -- "\$SOURCE_DIR\/offline-image-attestation\.py"/)
  assert.match(installer, /mv -fT -- "\$attestation_temporary" "\$LOCAL_OFFLINE_ATTESTATION"/)
  assert.match(installer, /\( -e "\$target" \|\| -L "\$target" \)/)
  assert.match(installer, /\( ! -f "\$target" \|\| -L "\$target" \)/)
  assert.ok((installer.match(/mv -fT --/g) ?? []).length >= 5)
  assert.match(installer, /stat -c ['"]%u:%g:%a['"] "\$LOCAL_OFFLINE_ATTESTATION"/)
  assert.match(installer, /SOURCE_ASSETS=.*offline-image-attestation\.py/)
  assert.match(installer, /EXPECTED_ASSET_HASHES\+=\("\$\(sha256sum "\$SOURCE_DIR\/\$source_asset"/)
  assert.match(installer, /sha256sum "\$LOCAL_OFFLINE_ATTESTATION"/)
  assert.match(installer, /python3 "\$LOCAL_OFFLINE_ATTESTATION" self-check/)
  assert.ok(
    installer.indexOf('python3 "$LOCAL_OFFLINE_ATTESTATION" self-check') <
      installer.indexOf('mv -fT -- "$wrapper_temporary" "$LOCAL_SSH_COMMAND"'),
    'the installed helper must be verified before the forced-command wrapper is replaced'
  )
  assert.doesNotMatch(installer, /offline-image-attestation\.py" (?:import|resolve)/)
  assert.doesNotMatch(installer, /^\s*(?:docker|systemctl|service)\b/m)
  assert.match(installer, /no container was restarted/)
  assert.match(installer, /^DEPLOY_LOCK='\/root\/docker\/kinvest\/state\/deploy\.lock'$/m)
  assert.match(installer, /exec 9>"\$DEPLOY_LOCK"/)
  assert.match(installer, /flock -n 9/)
  assert.ok(
    installer.indexOf('flock -n 9') < installer.lastIndexOf('\nsnapshot_targets\n'),
    'the shared deployment lock must be acquired before any target snapshot or replacement'
  )
  assert.doesNotMatch(attestationDesign, /atomically\s+renames/i)
  assert.match(attestationDesign, /durable armed-state[\s\S]{0,300}no-overwrite hard link/i)
  assert.doesNotMatch(deployRunbook, /sourceReference|source_reference/)
  assert.match(deployRunbook, /deployer,\s+validator,\s+helper,\s+wrapper last/i)

  const unsafeInstallerTarget = runUnsafeInstallerTargetFixture(installer)
  try {
    assert.notEqual(unsafeInstallerTarget.result.status, 0)
    assert.equal(fs.readFileSync(unsafeInstallerTarget.deployTarget, 'utf8'), 'original-deployer\n')
    assert.equal(fs.readFileSync(unsafeInstallerTarget.wrapperTarget, 'utf8'), 'original-wrapper\n')
    assert.equal(fs.readFileSync(unsafeInstallerTarget.validatorTarget, 'utf8'), 'original-validator\n')
    assert.equal(fs.lstatSync(unsafeInstallerTarget.helperTarget).isDirectory(), true)
    assert.deepEqual(fs.readdirSync(unsafeInstallerTarget.helperTarget), [])
    assert.equal(fs.existsSync(unsafeInstallerTarget.operationsLog), false)
    assert.deepEqual(
      fs.readdirSync(unsafeInstallerTarget.localSbin).filter((name) => name.startsWith('.')),
      []
    )
    assert.deepEqual(
      fs.readdirSync(unsafeInstallerTarget.localLibexec).filter((name) => name.startsWith('.')),
      []
    )
    assert.match(unsafeInstallerTarget.result.stderr, /non-regular deploy-v2 target/)
  } finally {
    unsafeInstallerTarget.cleanup()
  }

  for (const scenario of [
    { fault: 'move-1' },
    { fault: 'move-2' },
    { fault: 'move-3' },
    { fault: 'move-4', helperInitiallyAbsent: true },
    { fault: 'post-helper-validation' },
    { fault: 'signal-2' }
  ]) {
    const transactional = runTransactionalInstallerFixture(installer, scenario)
    try {
      assert.notEqual(transactional.result.status, 0, JSON.stringify(transactional.result, null, 2))
      assert.equal(transactional.result.stdout, '')
      for (const [name, target] of Object.entries(transactional.targets)) {
        const original = transactional.originals[name]
        if (original === null) {
          assert.equal(fs.existsSync(target), false, `${scenario.fault}: ${name} must return to absent`)
        } else {
          assert.equal(fs.readFileSync(target, 'utf8'), original.contents, `${scenario.fault}: ${name} contents`)
          assert.equal(fs.statSync(target).mode & 0o777, original.mode, `${scenario.fault}: ${name} mode`)
        }
      }
      assert.deepEqual(
        fs.readdirSync(transactional.localSbin).filter((name) => name.startsWith('.')),
        [],
        `${scenario.fault}: sbin temporaries`
      )
      assert.deepEqual(
        fs.readdirSync(transactional.localLibexec).filter((name) => name.startsWith('.')),
        [],
        `${scenario.fault}: libexec temporaries`
      )
      assert.deepEqual(fs.readdirSync(transactional.runDir), [], `${scenario.fault}: backup cleanup`)
      for (const target of Object.values(transactional.targets)) {
        if (fs.existsSync(target)) {
          assert.equal(fs.lstatSync(target).isFile(), true, `${scenario.fault}: no nested target`)
        }
      }
    } finally {
      transactional.cleanup()
    }
  }

  for (const fault of ['restore-stage-failure', 'rollback-second-signal']) {
    const failedRestore = runTransactionalInstallerFixture(installer, { fault })
    try {
      assert.notEqual(failedRestore.result.status, 0)
      assert.equal(failedRestore.result.stdout, '')
      assert.match(failedRestore.result.stderr, /transactional restoration failed/)
      const recoveryMatch = failedRestore.result.stderr.match(/backup preserved at ([^\n]+)/)
      assert.ok(recoveryMatch, `${fault}: a non-secret recovery path must be reported`)
      const recoveryPath = recoveryMatch[1]
      assert.equal(path.dirname(recoveryPath), failedRestore.runDir)
      assert.equal(fs.lstatSync(recoveryPath).isDirectory(), true)
      assert.equal(fs.statSync(recoveryPath).mode & 0o777, 0o700)
      assert.ok(fs.readdirSync(recoveryPath).length >= 4)
      assert.doesNotMatch(failedRestore.result.stderr, /restoration (?:complete|succeeded)/i)
      assert.deepEqual(
        fs.readdirSync(failedRestore.localSbin).filter((name) => name.startsWith('.')),
        []
      )
      assert.deepEqual(
        fs.readdirSync(failedRestore.localLibexec).filter((name) => name.startsWith('.')),
        []
      )
      if (fault === 'restore-stage-failure') {
        assert.notEqual(
          fs.readFileSync(failedRestore.targets.deployer, 'utf8'),
          failedRestore.originals.deployer.contents,
          'a failed restore must not be falsely reported as restored'
        )
      } else {
        for (const [name, target] of Object.entries(failedRestore.targets)) {
          const original = failedRestore.originals[name]
          assert.equal(fs.readFileSync(target, 'utf8'), original.contents, `${fault}: ${name}`)
          assert.equal(fs.statSync(target).mode & 0o777, original.mode, `${fault}: ${name} mode`)
        }
      }
    } finally {
      failedRestore.cleanup()
    }
  }

  const deploymentLockedInstaller = runTransactionalInstallerFixture(installer, {
    fault: 'none',
    deploymentOwnsLock: true
  })
  try {
    assert.notEqual(deploymentLockedInstaller.result.status, 0)
    assert.match(deploymentLockedInstaller.result.stderr, /another Kinvest deployment is already running/)
    assert.equal(deploymentLockedInstaller.result.stdout, '')
    for (const [name, target] of Object.entries(deploymentLockedInstaller.targets)) {
      const original = deploymentLockedInstaller.originals[name]
      assert.equal(fs.readFileSync(target, 'utf8'), original.contents, `lock busy: ${name}`)
      assert.equal(fs.statSync(target).mode & 0o777, original.mode, `lock busy: ${name} mode`)
    }
  } finally {
    deploymentLockedInstaller.cleanup()
  }

  const directAdapterFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-attestation-adapter-'))
  try {
    writeExecutable(path.join(directAdapterFixture, 'python3'), '#!/bin/sh\nexit 23\n')
    const directAdapter = spawnSync(process.execPath, [path.join(__dirname, 'offline-image-attestation.test.js')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${directAdapterFixture}:${process.env.PATH}` }
    })
    assert.notEqual(directAdapter.status, 0, 'direct adapter invocation must propagate the Python suite failure')
  } finally {
    fs.rmSync(directAdapterFixture, { recursive: true, force: true })
  }

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
    assert.match(currentState, /^protocolVersion=3$/m)
    assert.match(currentState, new RegExp(`^imageDigest=${successfulRoot.candidateDigest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    assert.match(currentState, new RegExp(`^runtimeImageId=${successfulRoot.candidateImageId}$`, 'm'))
    assert.match(currentState, /^verificationRunId=987654$/m)
    assert.match(currentState, /^databaseBackupChecksum=[0-9a-f]{64}$/m)
    assert.equal(fs.existsSync(path.join(successfulRoot.stateDir, 'attempt.state')), false)
    assert.equal(fs.readdirSync(successfulRoot.runRoot).length, 0)
    const dockerOperations = fs.readFileSync(path.join(successfulRoot.fakeState, 'docker.log'), 'utf8').trim().split('\n')
    assert.equal(
      dockerOperations.some((operation) => operation.startsWith('pull ')),
      false,
      'an exact locally available RepoDigest must skip the registry pull'
    )
    assert.match(successfulRoot.result.stderr, /RepoDigest is already verified locally; registry pull skipped/)
    assert.deepEqual(readLogLines(path.join(successfulRoot.fakeState, 'offline-helper.log')), [])
    assert.ok(
      readLogLines(path.join(successfulRoot.fakeState, 'image-env.log')).some((line) => line === `compose|${successfulRoot.candidateImageId}`),
      'Compose must receive the immutable candidate Image ID'
    )
    const composeOperations = dockerOperations.filter((operation) => operation.startsWith('compose '))
    assert.ok(composeOperations.some((operation) => /\bconfig\b/.test(operation)))
    assert.ok(composeOperations.some((operation) => /\bup\b/.test(operation)))
    const composeConfigPaths = []
    for (const operation of composeOperations) {
      const envFileMatches = operation.match(/--env-file\s+\S+/g) || []
      assert.equal(envFileMatches.length, 1)
      composeConfigPaths.push(envFileMatches[0].replace(/^--env-file\s+/, ''))
      assert.doesNotMatch(operation, /172\.31\.252\.|169\.254\.0\.23|br-kinvest-meta/)
    }
    assert.equal(new Set(composeConfigPaths).size, 1)
    const deploymentConfigSnapshot = composeConfigPaths[0]
    assert.notEqual(deploymentConfigSnapshot, successfulRoot.metadataNetworkConfig)
    assert.match(deploymentConfigSnapshot, new RegExp(`^${successfulRoot.runRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/kinvest-metadata-network\\.`))
    assert.ok(
      readLogLines(path.join(successfulRoot.fakeState, 'firewall-config.log')).every((configPath) => configPath === deploymentConfigSnapshot),
      'Compose and every firewall action must use one deployment config snapshot'
    )
    const configIndex = dockerOperations.findIndex((operation) => operation.startsWith('compose ') && /\bconfig\b/.test(operation))
    const upIndex = dockerOperations.findIndex((operation) => operation.startsWith('compose ') && /\bup\b/.test(operation))
    assert.ok(configIndex >= 0 && upIndex > configIndex, 'Compose must render config before any up')
    assert.deepEqual(readLogLines(path.join(successfulRoot.fakeState, 'firewall.log')), [
      'validate-config',
      'status',
      'guard',
      'reconcile'
    ])
    const lifecycleOperations = readLogLines(path.join(successfulRoot.fakeState, 'lifecycle.log'))
    const validationIndex = lifecycleOperations.indexOf('firewall:validate-config')
    const firstComposeIndex = lifecycleOperations.findIndex((operation) => /^docker:compose\b/.test(operation))
    assert.ok(validationIndex >= 0 && firstComposeIndex > validationIndex, 'config validation must precede every Compose operation')
    assert.equal(
      fs.readFileSync(successfulRoot.metadataActivationState, 'utf8'),
      `version=1\nmode=active\nconfig_sha256=${successfulRoot.approvedConfigHash}\n`
    )
  } finally {
    successfulRoot.cleanup()
  }

  const exactDigestPrecedence = runRootFixture(deploy, { mode: 'exact-digest-with-helper' })
  try {
    assert.equal(exactDigestPrecedence.result.status, 0, exactDigestPrecedence.result.stderr)
    assert.deepEqual(readLogLines(path.join(exactDigestPrecedence.fakeState, 'offline-helper.log')), [])
    assert.equal(readLogLines(path.join(exactDigestPrecedence.fakeState, 'docker.log')).filter((line) => line.startsWith('pull ')).length, 0)
  } finally {
    exactDigestPrecedence.cleanup()
  }

  const offlineValid = runRootFixture(deploy, { mode: 'offline-valid' })
  try {
    assert.equal(offlineValid.result.status, 0, offlineValid.result.stderr)
    assert.equal(readLogLines(path.join(offlineValid.fakeState, 'docker.log')).filter((line) => line.startsWith('pull ')).length, 0)
    assert.deepEqual(readLogLines(path.join(offlineValid.fakeState, 'offline-helper.log')), [
      `resolve ${offlineValid.candidateDigest} ${offlineValid.candidateCommit} 987654`
    ])
    assert.ok(readLogLines(path.join(offlineValid.fakeState, 'image-env.log')).some((line) => line === `compose|${offlineValid.candidateImageId}`))
    assert.equal(fs.readdirSync(offlineValid.runRoot).length, 0, 'successful helper resolution must clean parent-owned temp files')
  } finally {
    offlineValid.cleanup()
  }

  for (const mode of ['offline-wrong-commit', 'offline-wrong-run', 'offline-malformed', 'offline-missing-local-id']) {
    const invalidOffline = runRootFixture(deploy, { mode })
    try {
      assert.equal(invalidOffline.result.status, 0, invalidOffline.result.stderr)
      assert.equal(readLogLines(path.join(invalidOffline.fakeState, 'offline-helper.log')).length, 1)
      assert.deepEqual(
        readLogLines(path.join(invalidOffline.fakeState, 'docker.log')).filter((line) => line.startsWith('pull ')),
        [`pull ${invalidOffline.candidateDigest}`],
        `${mode} must fall back to the bounded registry pull`
      )
    } finally {
      invalidOffline.cleanup()
    }
  }

  const invalidOfflineWithoutRegistry = runRootFixture(deploy, { mode: 'offline-pull-failure' })
  try {
    assert.notEqual(invalidOfflineWithoutRegistry.result.status, 0)
    assert.equal(readLogLines(path.join(invalidOfflineWithoutRegistry.fakeState, 'offline-helper.log')).length, 1)
    assert.deepEqual(
      readLogLines(path.join(invalidOfflineWithoutRegistry.fakeState, 'docker.log')).filter((line) => line.startsWith('pull ')),
      [`pull ${invalidOfflineWithoutRegistry.candidateDigest}`]
    )
  } finally {
    invalidOfflineWithoutRegistry.cleanup()
  }

  const allowedHelperCode = runRootFixture(deploy, { mode: 'offline-error-code' })
  try {
    assert.equal(allowedHelperCode.result.status, 0, allowedHelperCode.result.stderr)
    assert.match(allowedHelperCode.result.stderr, /^OFFLINE_ATTESTATION_NOT_FOUND$/m)
    assert.equal(fs.readdirSync(allowedHelperCode.runRoot).length, 0)
  } finally {
    allowedHelperCode.cleanup()
  }

  for (const mode of ['offline-arbitrary-stderr', 'offline-multiline-stderr']) {
    const suppressedHelperError = runRootFixture(deploy, { mode })
    try {
      assert.equal(suppressedHelperError.result.status, 0, suppressedHelperError.result.stderr)
      assert.doesNotMatch(suppressedHelperError.result.stderr, /secret-like-payload|OFFLINE_ATTESTATION_NOT_FOUND/)
      assert.equal(fs.readdirSync(suppressedHelperError.runRoot).length, 0)
    } finally {
      suppressedHelperError.cleanup()
    }
  }

  for (const mode of ['offline-helper-timeout', 'offline-helper-abnormal']) {
    const helperFailure = runRootFixture(deploy, { mode })
    try {
      assert.equal(helperFailure.result.status, 0, helperFailure.result.stderr)
      assert.deepEqual(
        readLogLines(path.join(helperFailure.fakeState, 'docker.log')).filter((line) => line.startsWith('pull ')),
        [`pull ${helperFailure.candidateDigest}`],
        `${mode} must preserve registry pull fallback`
      )
      assert.doesNotMatch(helperFailure.result.stderr, /secret-like-payload/)
      assert.equal(fs.readdirSync(helperFailure.runRoot).length, 0, `${mode} must clean helper temp files`)
      if (mode === 'offline-helper-timeout') {
        assert.ok(
          readLogLines(path.join(helperFailure.fakeState, 'timeout.log')).some((line) => line.includes('kinvest-offline-image-attestation resolve')),
          'helper resolution must use the bounded timeout wrapper'
        )
      }
    } finally {
      helperFailure.cleanup()
    }
  }

  const helperParentSignal = runRootFixture(deploy, { mode: 'offline-helper-parent-signal' })
  try {
    assert.equal(helperParentSignal.result.status, 143)
    assert.equal(fs.readdirSync(helperParentSignal.runRoot).length, 0, 'parent signal trap must clean helper temp files')
    assert.equal(
      readLogLines(path.join(helperParentSignal.fakeState, 'docker.log')).some((line) => line.startsWith('pull ')),
      false
    )
  } finally {
    helperParentSignal.cleanup()
  }

  const tcrExactDigest = runRootFixture(deploy, {
    mode: 'tcr-exact-with-helper',
    registryMode: 'tcr-basic'
  })
  try {
    assert.equal(tcrExactDigest.result.status, 0, tcrExactDigest.result.stderr)
    assert.deepEqual(readLogLines(path.join(tcrExactDigest.fakeState, 'offline-helper.log')), [])
    assert.equal(readLogLines(path.join(tcrExactDigest.fakeState, 'docker.log')).filter((line) => line.startsWith('pull ')).length, 0)
  } finally {
    tcrExactDigest.cleanup()
  }

  const tcrPullFallback = runRootFixture(deploy, {
    mode: 'tcr-helper-valid',
    registryMode: 'tcr-basic'
  })
  try {
    assert.equal(tcrPullFallback.result.status, 0, tcrPullFallback.result.stderr)
    assert.deepEqual(readLogLines(path.join(tcrPullFallback.fakeState, 'offline-helper.log')), [])
    assert.deepEqual(
      readLogLines(path.join(tcrPullFallback.fakeState, 'docker.log')).filter((line) => line.startsWith('pull ')),
      [`pull ${tcrPullFallback.candidateDigest}`]
    )
  } finally {
    tcrPullFallback.cleanup()
  }

  const tcrPullFailure = runRootFixture(deploy, {
    mode: 'tcr-helper-valid-pull-failure',
    registryMode: 'tcr-basic'
  })
  try {
    assert.notEqual(tcrPullFailure.result.status, 0)
    assert.deepEqual(readLogLines(path.join(tcrPullFailure.fakeState, 'offline-helper.log')), [])
    assert.deepEqual(
      readLogLines(path.join(tcrPullFailure.fakeState, 'docker.log')).filter((line) => line.startsWith('pull ')),
      [`pull ${tcrPullFailure.candidateDigest}`]
    )
  } finally {
    tcrPullFailure.cleanup()
  }

  const v2Migration = runRootFixture(deploy, { currentSecretVersionIds: '{}' })
  try {
    assert.equal(v2Migration.result.status, 0, v2Migration.result.stderr)
    const previous = fs.readFileSync(path.join(v2Migration.stateDir, 'previous.state'), 'utf8')
    assert.match(previous, /^protocolVersion=3$/m)
    assert.match(previous, new RegExp(`^runtimeImageId=${v2Migration.previousImageId}$`, 'm'))
  } finally {
    v2Migration.cleanup()
  }

  const legacyMigration = runRootFixture(deploy)
  try {
    assert.equal(legacyMigration.result.status, 0, legacyMigration.result.stderr)
    const previous = fs.readFileSync(path.join(legacyMigration.stateDir, 'previous.state'), 'utf8')
    assert.match(previous, /^protocolVersion=3$/m)
    assert.match(previous, new RegExp(`^runtimeImageId=${legacyMigration.previousImageId}$`, 'm'))
  } finally {
    legacyMigration.cleanup()
  }

  const localTagAndIdOnly = runRootFixture(deploy, { mode: 'local-tag-and-id-only' })
  try {
    assert.equal(localTagAndIdOnly.result.status, 0, localTagAndIdOnly.result.stderr)
    assert.deepEqual(
      readLogLines(path.join(localTagAndIdOnly.fakeState, 'docker.log')).filter((operation) => operation.startsWith('pull ')),
      [`pull ${localTagAndIdOnly.candidateDigest}`],
      'a local tag and matching Image ID without the exact RepoDigest must not bypass the pull'
    )
  } finally {
    localTagAndIdOnly.cleanup()
  }

  const localDigestTransient = runRootFixture(deploy, { mode: 'local-digest-transient' })
  try {
    assert.equal(localDigestTransient.result.status, 0, localDigestTransient.result.stderr)
    assert.deepEqual(
      readLogLines(path.join(localDigestTransient.fakeState, 'docker.log')).filter((operation) => operation.startsWith('pull ')),
      [`pull ${localDigestTransient.candidateDigest}`, `pull ${localDigestTransient.candidateDigest}`],
      'a missing local RepoDigest must retain bounded transient pull retries'
    )
    assert.match(localDigestTransient.result.stderr, /pull attempt 1 of 3 failed with exit code 124/)
    assert.match(localDigestTransient.result.stderr, /pull attempt 2 of 3 succeeded/)
  } finally {
    localDigestTransient.cleanup()
  }

  const failedPullExposesDigest = runRootFixture(deploy, { mode: 'pull-failure-with-digest' })
  try {
    assert.notEqual(failedPullExposesDigest.result.status, 0)
    assert.deepEqual(
      readLogLines(path.join(failedPullExposesDigest.fakeState, 'docker.log')).filter((line) => line.startsWith('pull ')),
      [`pull ${failedPullExposesDigest.candidateDigest}`]
    )
    assert.equal(
      readLogLines(path.join(failedPullExposesDigest.fakeState, 'docker.log')).some((line) => /^compose .*\bup\b/.test(line)),
      false,
      'a failed pull must stop before Compose even if the exact RepoDigest becomes visible'
    )
    assert.equal(
      fs.readFileSync(path.join(failedPullExposesDigest.stateDir, 'current.state'), 'utf8'),
      failedPullExposesDigest.initialCurrentState
    )
    assert.equal(fs.existsSync(path.join(failedPullExposesDigest.stateDir, 'attempt.state')), false)
    assert.equal(fs.readdirSync(path.join(failedPullExposesDigest.root, 'backups')).length, 0)
  } finally {
    failedPullExposesDigest.cleanup()
  }

  const missingMetadataNetwork = runRootFixture(deploy, { mode: 'metadata-network-missing' })
  try {
    assert.notEqual(missingMetadataNetwork.result.status, 0)
    assert.match(missingMetadataNetwork.result.stderr, /metadata network.*conflict.*approval/i)
    const dockerOperations = fs.readFileSync(path.join(missingMetadataNetwork.fakeState, 'docker.log'), 'utf8')
    assert.doesNotMatch(dockerOperations, /^compose .*\bup\b/m)
    assert.deepEqual(readLogLines(path.join(missingMetadataNetwork.fakeState, 'firewall.log')), [
      'validate-config',
      'guard'
    ])
  } finally {
    missingMetadataNetwork.cleanup()
  }

  const firstMigration = runRootFixture(deploy, {
    mode: 'metadata-network-missing',
    metadataPhase: 'pending'
  })
  try {
    assert.equal(firstMigration.result.status, 0, firstMigration.result.stderr)
    assert.equal(
      fs.readFileSync(firstMigration.metadataActivationState, 'utf8'),
      `version=1\nmode=active\nconfig_sha256=${firstMigration.approvedConfigHash}\n`
    )
    assert.deepEqual(
      readLogLines(path.join(firstMigration.fakeState, 'firewall.log')),
      ['validate-config', 'guard', 'reconcile']
    )
  } finally {
    firstMigration.cleanup()
  }

  for (const metadataConfigVariant of ['duplicate', 'unknown', 'missing']) {
    const invalidConfig = runRootFixture(deploy, { metadataConfigVariant })
    try {
      assert.notEqual(invalidConfig.result.status, 0)
      const lifecycleOperations = readLogLines(path.join(invalidConfig.fakeState, 'lifecycle.log'))
      assert.equal(lifecycleOperations[0], 'firewall:validate-config')
      assert.equal(lifecycleOperations.some((operation) => /^docker:compose\b/.test(operation)), false)
    } finally {
      invalidConfig.cleanup()
    }
  }

  const replacedDuringCopy = runRootFixture(deploy, { mode: 'config-replaced-during-copy' })
  try {
    assert.notEqual(replacedDuringCopy.result.status, 0)
    assert.match(replacedDuringCopy.result.stderr, /approved.*hash|hash.*approved/i)
    assert.equal(
      readLogLines(path.join(replacedDuringCopy.fakeState, 'lifecycle.log')).some((operation) => /^docker:compose\b/.test(operation)),
      false
    )
    assert.equal(fs.readdirSync(replacedDuringCopy.runRoot).length, 0, 'config snapshot must be removed on hash mismatch')
    assert.equal(
      fs.readFileSync(path.join(replacedDuringCopy.stateDir, 'current.state'), 'utf8'),
      replacedDuringCopy.initialCurrentState
    )
  } finally {
    replacedDuringCopy.cleanup()
  }

  const hashMismatch = runRootFixture(deploy, { activationHash: '0'.repeat(64) })
  try {
    assert.notEqual(hashMismatch.result.status, 0)
    assert.equal(
      readLogLines(path.join(hashMismatch.fakeState, 'lifecycle.log')).some((operation) => /^docker:compose\b/.test(operation)),
      false
    )
  } finally {
    hashMismatch.cleanup()
  }

  const invalidActivationStates = [
    '',
    'version=1\nmode=active\nconfig_sha256=__CONFIG_SHA256__\n\n',
    'version=1\nmode=active\nmode=active\nconfig_sha256=__CONFIG_SHA256__\n',
    'version=1\nmode=active\nunknown=value\nconfig_sha256=__CONFIG_SHA256__\n',
    'mode=active\nversion=1\nconfig_sha256=__CONFIG_SHA256__\n',
    'version=1\nmode=active\nconfig_sha256=not-a-sha256\n'
  ]
  for (const activationStateSource of invalidActivationStates) {
    const invalidState = runRootFixture(deploy, { activationStateSource })
    try {
      assert.notEqual(invalidState.result.status, 0)
      assert.equal(
        readLogLines(path.join(invalidState.fakeState, 'lifecycle.log')).some((operation) => /^docker:compose\b/.test(operation)),
        false
      )
    } finally {
      invalidState.cleanup()
    }
  }

  const missingActivationState = runRootFixture(deploy, { metadataPhase: null })
  try {
    assert.notEqual(missingActivationState.result.status, 0)
    assert.equal(
      readLogLines(path.join(missingActivationState.fakeState, 'lifecycle.log')).some((operation) => /^docker:compose\b/.test(operation)),
      false
    )
  } finally {
    missingActivationState.cleanup()
  }

  for (const activationStat of ['0:0:640', '1000:0:600', '0:1000:600']) {
    const insecureState = runRootFixture(deploy, { activationStat })
    try {
      assert.notEqual(insecureState.result.status, 0)
      assert.equal(
        readLogLines(path.join(insecureState.fakeState, 'lifecycle.log')).some((operation) => /^docker:compose\b/.test(operation)),
        false
      )
    } finally {
      insecureState.cleanup()
    }
  }

  const symlinkState = runRootFixture(deploy, { activationSymlink: true })
  try {
    assert.notEqual(symlinkState.result.status, 0)
    assert.equal(
      readLogLines(path.join(symlinkState.fakeState, 'lifecycle.log')).some((operation) => /^docker:compose\b/.test(operation)),
      false
    )
  } finally {
    symlinkState.cleanup()
  }

  for (const mode of ['wrong-bridge', 'extra-member']) {
    const brokenTopology = runRootFixture(deploy, { mode })
    try {
      assert.notEqual(brokenTopology.result.status, 0)
      assert.equal(
        fs.readFileSync(path.join(brokenTopology.stateDir, 'current.state'), 'utf8'),
        brokenTopology.initialCurrentState
      )
      assert.deepEqual(
        readLogLines(path.join(brokenTopology.fakeState, 'firewall.log')),
        ['validate-config', 'status', 'guard']
      )
      const dockerOperations = fs.readFileSync(path.join(brokenTopology.fakeState, 'docker.log'), 'utf8')
      assert.doesNotMatch(dockerOperations, /^compose .*\bup\b/m)
    } finally {
      brokenTopology.cleanup()
    }
  }

  const postReconcileFailure = runRootFixture(deploy, { mode: 'post-reconcile-failure' })
  try {
    assert.notEqual(postReconcileFailure.result.status, 0)
    assert.equal(
      fs.readFileSync(path.join(postReconcileFailure.stateDir, 'current.state'), 'utf8'),
      postReconcileFailure.initialCurrentState
    )
    const firewallOperations = readLogLines(path.join(postReconcileFailure.fakeState, 'firewall.log'))
    assert.deepEqual(firewallOperations.slice(0, 4), ['validate-config', 'status', 'guard', 'reconcile'])
    const dockerOperations = readLogLines(path.join(postReconcileFailure.fakeState, 'docker.log'))
    assert.equal(
      firewallOperations[4],
      'guard',
      `firewall operations: ${JSON.stringify(firewallOperations)}; docker operations: ${JSON.stringify(dockerOperations)}; stderr: ${postReconcileFailure.result.stderr}`
    )
  } finally {
    postReconcileFailure.cleanup()
  }

  const wrongDigest = runRootFixture(deploy, { mode: 'wrong-digest' })
  try {
    assert.notEqual(wrongDigest.result.status, 0)
    assert.match(wrongDigest.result.stderr, /RepoDigests/)
    assert.deepEqual(
      readLogLines(path.join(wrongDigest.fakeState, 'docker.log')).filter((operation) => operation.startsWith('pull ')),
      [`pull ${wrongDigest.candidateDigest}`],
      'a wrong local RepoDigest must still pull before the final digest guard rejects it'
    )
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
    const firewallOperations = readLogLines(path.join(schemaReadFailure.fakeState, 'firewall.log'))
    const reconcileIndex = firewallOperations.indexOf('reconcile')
    assert.ok(reconcileIndex >= 0)
    assert.equal(firewallOperations[reconcileIndex + 1], 'guard', 'rollback must install guard before schema/image/container work')
  } finally {
    schemaReadFailure.cleanup()
  }

  const publicHealthFailure = runRootFixture(deploy, { mode: 'public-health-failure' })
  try {
    assert.notEqual(publicHealthFailure.result.status, 0)
    assert.match(publicHealthFailure.result.stderr, /evaluating verified rollback/)
    assert.equal(fs.existsSync(path.join(publicHealthFailure.stateDir, 'attempt.state')), false)
    const composeImages = readLogLines(path.join(publicHealthFailure.fakeState, 'image-env.log'))
    assert.deepEqual(composeImages.slice(-2), [
      `compose|${publicHealthFailure.candidateImageId}`,
      `compose|${publicHealthFailure.previousImageId}`
    ])
  } finally {
    publicHealthFailure.cleanup()
  }

  for (const mode of ['runtime-ref-mismatch', 'runtime-id-mismatch']) {
    const runtimeMismatch = runRootFixture(deploy, { mode })
    try {
      assert.notEqual(runtimeMismatch.result.status, 0, `${mode} must fail runtime identity verification`)
      assert.match(runtimeMismatch.result.stderr, /evaluating verified rollback/)
    } finally {
      runtimeMismatch.cleanup()
    }
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

module.exports = { readLogLines, run, runRootFixture }

if (require.main === module) {
  run().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
