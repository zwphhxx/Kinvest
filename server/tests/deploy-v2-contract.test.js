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
  metadataPhase = 'active',
  metadataConfigVariant = 'valid',
  activationHash = null,
  activationStateSource = null,
  activationStat = '0:0:600',
  activationSymlink = false,
  secretVersionIds = '{}',
  currentSecretVersionIds = null,
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
  const database = path.join(dataDir, 'kinvest.sqlite')
  const previousDigest = `ghcr.io/zwphhxx/kinvest@sha256:${'1'.repeat(64)}`
  const candidateDigest = `ghcr.io/zwphhxx/kinvest@sha256:${'2'.repeat(64)}`
  const previousCommit = '3'.repeat(40)
  const candidateCommit = '4'.repeat(40)
  const secretValidator = path.join(root, 'secret-version-config.py')

  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(stateDir)
  fs.mkdirSync(runRoot)
  fs.mkdirSync(fakeBin)
  fs.mkdirSync(fakeState)
  fs.mkdirSync(metadataConfigDir, { recursive: true })
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
  const initialCurrentState = currentSecretVersionIds === null
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
  fs.writeFileSync(path.join(stateDir, 'current.state'), initialCurrentState)
  const initialPreviousState = previousStateSource === null
    ? null
    : previousStateSource
        .replaceAll('__DIGEST__', candidateDigest)
        .replaceAll('__COMMIT__', candidateCommit)
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
    path.join(fakeBin, 'docker'),
    `#!/bin/sh
printf '%s\n' "$*" >> "$KINVEST_FAKE_STATE/docker.log"
printf 'docker:%s\n' "$*" >> "$KINVEST_FAKE_STATE/lifecycle.log"
if [ "$1" = run ] || [ "$1" = compose ]; then
  printf '%s|%s|%s\n' "$1" "\${KINVEST_SECRET_PROVIDER_MODE:-}" "\${KINVEST_SECRET_VERSION_IDS:-}" >> "$KINVEST_FAKE_STATE/runtime-env.log"
fi
if [ "$1" = network ]; then
  target=''
  for argument in "$@"; do target="$argument"; done
  if [ "$KINVEST_FAKE_MODE" = metadata-network-missing ] && [ "$target" = kinvest-metadata-egress ]; then exit 1; fi
  exit 0
fi
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
    *secret-bootstrap*)
      if [ "$KINVEST_FAKE_MODE" = preflight-label-missing ]; then printf '<no value>\n'; else printf '1\n'; fi
      ;;
    *Id*) printf 'sha256:fixture-image-id\n' ;;
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
    *Image*) printf 'sha256:fixture-image-id\n' ;;
  esac
  exit 0
fi
if [ "$1" = compose ]; then
  case " $* " in
    *" config "*) printf '%s\n' 'services: {}'; exit 0 ;;
  esac
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
    .replace("ROOT='/root/docker/kinvest'", `ROOT='${root}'`)
    .replace("RUN_ROOT='/run'", `RUN_ROOT='${runRoot}'`)
    .replace("METADATA_NETWORK_CONFIG='/etc/kinvest/metadata-network.conf'", `METADATA_NETWORK_CONFIG='${metadataNetworkConfig}'`)
    .replace("METADATA_FIREWALL='/usr/local/sbin/kinvest-metadata-firewall'", `METADATA_FIREWALL='${fakeMetadataFirewall}'`)
    .replace("SECRET_VERSION_VALIDATOR='/usr/local/libexec/kinvest-secret-version-config'", `SECRET_VERSION_VALIDATOR='${secretValidator}'`)
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
      KINVEST_FAKE_DB: database,
      KINVEST_FAKE_MODE: mode,
      KINVEST_FAKE_STATE: fakeState,
      KINVEST_PREFLIGHT_REFERENCES: preflightReferences,
      KINVEST_METADATA_CONFIG_PATH: metadataNetworkConfig,
      KINVEST_METADATA_ACTIVATION_PATH: metadataActivationState,
      KINVEST_METADATA_ACTIVATION_STAT: activationStat,
      KINVEST_METADATA_SNAPSHOT_PREFIX: path.join(runRoot, 'kinvest-metadata-network.'),
      KINVEST_FAKE_CONFIG_VALID: metadataConfigVariant === 'valid' ? '1' : '0'
    }
  })

  return {
    candidateDigest,
    candidateCommit,
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
    root,
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
  assert.match(deploy, /^METADATA_NETWORK_CONFIG='\/etc\/kinvest\/metadata-network\.conf'$/m)
  assert.match(deploy, /^METADATA_FIREWALL='\/usr\/local\/sbin\/kinvest-metadata-firewall'$/m)
  assert.match(deploy, /atomic_write_metadata_activation_state/)
  assert.match(deploy, /metadata_config_snapshot=.*mktemp.*\$RUN_ROOT/)
  assert.match(deploy, /run_metadata_firewall validate-config/)
  assert.match(deploy, /run_metadata_firewall status/)
  assert.match(deploy, /run_metadata_firewall guard[\s\S]{0,300}run_compose "\$digest_ref"/)
  assert.match(deploy, /run_compose "\$digest_ref"[\s\S]{0,300}run_metadata_firewall reconcile/)
  assert.match(deploy, /docker compose[\s\\]*\n?[\s\S]{0,300}--env-file "\$metadata_config_snapshot"/)
  assert.doesNotMatch(deploy, /--env-file\s+(?:\.env|"\.env")/)
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
  assert.match(installer, /secret-version-config\.py/)
  assert.match(installer, /install -d -o root -g root -m 0755 -- \/usr\/local\/libexec/)
  assert.doesNotMatch(installer, /for source_file in [^\n]*secret-version-config\.py/)
  assert.match(installer, /python3 "\$SOURCE_DIR\/secret-version-config\.py" mapping/)
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
    const dockerOperations = fs.readFileSync(path.join(successfulRoot.fakeState, 'docker.log'), 'utf8').trim().split('\n')
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

module.exports = { readLogLines, run, runRootFixture }
