const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const allowedRepository = 'ghcr.io/zwphhxx/kinvest'
const candidateDigest = `sha256:${'b'.repeat(64)}`
const candidateRef = `${allowedRepository}@${candidateDigest}`
const candidateCommit = 'c'.repeat(40)
const previousDigest = `sha256:${'a'.repeat(64)}`
const previousRef = `${allowedRepository}@${previousDigest}`
const previousCommit = 'd'.repeat(40)

function rootPath(relativePath) {
  return path.join(rootDir, relativePath)
}

function readRootFile(relativePath) {
  return fs.readFileSync(rootPath(relativePath), 'utf8')
}

function writeExecutable(filePath, source) {
  assert.match(
    source,
    /^#![^\r\n]+\n/,
    `${filePath} must start with an LF-terminated portable shebang`
  )
  fs.writeFileSync(filePath, source, { mode: 0o755 })
}

function readOptionalFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null
}

function deployFixtureDiagnostics(fixture) {
  return JSON.stringify(
    {
      status: fixture.result.status,
      signal: fixture.result.signal,
      error: fixture.result.error?.message ?? null,
      stdout: fixture.result.stdout,
      stderr: fixture.result.stderr,
      fakeStateFiles: fs.readdirSync(fixture.fakeState).sort(),
      timeoutCalls: readOptionalFile(path.join(fixture.fakeState, 'timeout.log')),
      dockerCalls: readOptionalFile(path.join(fixture.fakeState, 'docker-calls.log'))
    },
    null,
    2
  )
}

function assertBasicWorkflowYaml(source) {
  const rootKeys = []
  let scalarIndent = null

  for (const [index, line] of source.split('\n').entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue
    }

    assert.doesNotMatch(line, /\t/, `workflow line ${index + 1} must not contain tabs`)

    const indent = line.length - line.trimStart().length
    assert.equal(indent % 2, 0, `workflow line ${index + 1} must use two-space indentation`)

    if (scalarIndent !== null && indent > scalarIndent) {
      continue
    }
    scalarIndent = null

    const content = line.trimStart()
    assert.match(
      content,
      /^(?:-\s+)?(?:[A-Za-z_][A-Za-z0-9_-]*|"[^"]+"|'[^']+'):\s*(?:.*)?$|^-\s+\S.*$/,
      `workflow line ${index + 1} must be a basic YAML mapping or sequence entry`
    )

    if (indent === 0) {
      rootKeys.push(content.match(/^([^:]+):/)[1].replace(/^['"]|['"]$/g, ''))
    }

    if (/[|>][-+]?\s*$/.test(content)) {
      scalarIndent = indent
    }
  }

  assert.deepEqual(rootKeys, ['name', 'on', 'permissions', 'concurrency', 'jobs'])
}

function createFakeDocker(binDir) {
  writeExecutable(
    path.join(binDir, 'id'),
    `#!/bin/sh
if [ "\${1:-}" = "-u" ]; then
  printf '%s\\n' '0'
  exit 0
fi
exec /usr/bin/id "$@"
`
  )

  writeExecutable(
    path.join(binDir, 'flock'),
    `#!/bin/sh
if [ -f "$FAKE_DOCKER_STATE/flock-busy" ]; then
  exit 75
fi
exit 0
`
  )

  writeExecutable(
    path.join(binDir, 'sleep'),
    `#!/bin/sh
exit 0
`
  )

  writeExecutable(
    path.join(binDir, 'timeout'),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_DOCKER_STATE/timeout.log"
while [ "\${1:-}" = "--signal=TERM" ] || [ "\${1#--kill-after=}" != "\${1:-}" ]; do
  shift
done
shift
exec "$@"
`
  )

  writeExecutable(
    path.join(binDir, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail

state="$FAKE_DOCKER_STATE"

image_id() {
  case "$1" in
    "$OLD_REF") printf 'sha256:%s\\n' '${'1'.repeat(64)}' ;;
    "$CANDIDATE_REF") printf 'sha256:%s\\n' '${'2'.repeat(64)}' ;;
    *) printf 'sha256:%s\\n' '${'9'.repeat(64)}' ;;
  esac
}

command_name="\${1:-}"
shift || true
printf '%s\\n' "$command_name $*" >> "$state/docker-calls.log"

case "$command_name" in
  network)
    [ "\${1:-}" = 'inspect' ] && [ "\${2:-}" = 'web' ]
    ;;
  pull)
    ref="\${1:-}"
    if [[ -f "$state/fail-candidate-pull" && "$ref" == "$CANDIDATE_REF" ]]; then
      exit 30
    fi
    if [[ -f "$state/fail-old-pull" && "$ref" == "$OLD_REF" ]]; then
      if [[ -f "$state/restore-old-on-pull-failure" ]]; then
        printf '%s\\n' "$OLD_REF" > "$state/running.ref"
        image_id "$OLD_REF" > "$state/running.id"
        printf '%s\\n' 'healthy' > "$state/running.health"
        : > "$state/old-pull-attempted"
      fi
      exit 31
    fi
    printf '%s\\n' "$ref" >> "$state/pulls.log"
    ;;
  image)
    [ "\${1:-}" = 'inspect' ]
    ref="\${4:-}"
    if [[ "$ref" == "$OLD_REF" && -f "$state/fail-previous-snapshot" ]]; then
      exit 35
    fi
    if [[ "$ref" == "$OLD_REF" && -f "$state/fail-old-image-after-snapshot" ]]; then
      old_inspect_count=0
      if [[ -f "$state/old-image-inspect-count" ]]; then
        old_inspect_count="$(cat "$state/old-image-inspect-count")"
      fi
      old_inspect_count=$((old_inspect_count + 1))
      printf '%s\\n' "$old_inspect_count" > "$state/old-image-inspect-count"
      if ((old_inspect_count > 1)); then
        exit 35
      fi
    fi
    if [[ "$ref" == "$OLD_REF" && -f "$state/fail-old-image-inspect-after-pull" && -f "$state/old-pull-attempted" ]]; then
      exit 35
    fi
    image_id "$ref"
    ;;
  inspect)
    format="\${2:-}"
    case "$format" in
      *'.Config.Image'*) cat "$state/running.ref" ;;
      '{{.Image}}') cat "$state/running.id" ;;
      *'.State.Health.Status'*) cat "$state/running.health" ;;
      *) exit 32 ;;
    esac
    ;;
  compose)
    ref="\${KINVEST_IMAGE:-}"
    if [[ -f "$state/fail-candidate-compose" && "$ref" == "$CANDIDATE_REF" ]]; then
      exit 36
    fi
    if [[ -f "$state/fail-old-compose" && "$ref" == "$OLD_REF" ]]; then
      exit 33
    fi
    if [[ -f "$state/candidate-mismatch" && "$ref" == "$CANDIDATE_REF" ]]; then
      printf '%s\\n' 'ghcr.io/zwphhxx/kinvest@sha256:${'9'.repeat(64)}' > "$state/running.ref"
      printf 'sha256:%s\\n' '${'9'.repeat(64)}' > "$state/running.id"
    else
      printf '%s\\n' "$ref" > "$state/running.ref"
      image_id "$ref" > "$state/running.id"
    fi
    printf '%s\\n' 'healthy' > "$state/running.health"
    ;;
  rm)
    rm -f "$state/running.ref" "$state/running.id" "$state/running.health"
    : > "$state/removed"
    ;;
  *)
    exit 34
    ;;
esac
`
  )
}

function runDeployFixture(markers = [], { withPrevious = true } = {}) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-deploy-behavior-'))
  const fakeBin = path.join(fixtureRoot, 'bin')
  const fakeState = path.join(fixtureRoot, 'docker-state')
  const serverRoot = path.join(fixtureRoot, 'root/docker/kinvest')
  const stateDir = path.join(serverRoot, 'state')

  fs.mkdirSync(fakeBin, { recursive: true })
  fs.mkdirSync(fakeState, { recursive: true })
  fs.mkdirSync(path.join(serverRoot, 'data'), { recursive: true })
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(serverRoot, 'docker-compose.yml'), 'services:\\n  kinvest:\\n    image: test\\n')
  writeExecutable(path.join(serverRoot, 'prepare-data-dir.sh'), '#!/bin/sh\nexit 0\n')

  if (withPrevious) {
    fs.writeFileSync(
      path.join(stateDir, 'current.state'),
      `digest_ref=${previousRef}\ncommit=${previousCommit}\n`,
      { mode: 0o600 }
    )
    fs.writeFileSync(path.join(fakeState, 'running.ref'), `${previousRef}\n`)
    fs.writeFileSync(path.join(fakeState, 'running.id'), `sha256:${'1'.repeat(64)}\n`)
    fs.writeFileSync(path.join(fakeState, 'running.health'), 'healthy\n')
  }

  for (const marker of markers) {
    if (marker === 'previous-unhealthy') {
      fs.writeFileSync(path.join(fakeState, 'running.health'), 'unhealthy\n')
    } else {
      fs.writeFileSync(path.join(fakeState, marker), '')
    }
  }

  createFakeDocker(fakeBin)

  const deploySource = readRootFile('deploy/server/deploy-kinvest.sh').replace(
    "ROOT='/root/docker/kinvest'",
    `ROOT='${serverRoot}'`
  )
  const instrumentedDeploy = path.join(fixtureRoot, 'deploy-kinvest.sh')
  writeExecutable(instrumentedDeploy, deploySource)

  const result = spawnSync(instrumentedDeploy, [], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_DOCKER_STATE: fakeState,
      OLD_REF: previousRef,
      CANDIDATE_REF: candidateRef
    },
    input: `${candidateRef}\n${candidateCommit}\n`,
    timeout: 5000
  })

  return {
    cleanup() {
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    },
    fakeState,
    result,
    stateDir
  }
}

function assertRejectedInput(input, messagePattern) {
  const result = spawnSync(rootPath('deploy/server/deploy-kinvest.sh'), [], {
    encoding: 'utf8',
    input
  })

  assert.equal(result.status, 2)
  assert.match(result.stderr, messagePattern)
}

function runBootstrapIdentityConflict(identityKind) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-bootstrap-identity-'))
  const fakeBin = path.join(fixtureRoot, 'bin')
  const sourceDir = path.join(fixtureRoot, 'source')
  const publicKeyFile = path.join(fixtureRoot, 'deploy.pub')
  const mutationMarker = path.join(fixtureRoot, 'mutation-attempted')

  fs.mkdirSync(fakeBin)
  fs.mkdirSync(sourceDir)
  fs.writeFileSync(publicKeyFile, `ssh-ed25519 ${'A'.repeat(44)} fixture\n`)

  writeExecutable(
    path.join(fakeBin, 'id'),
    `#!/bin/sh
if [ "\${1:-}" = "-u" ]; then
  printf '%s\\n' '0'
  exit 0
fi
exec /usr/bin/id "$@"
`
  )

  writeExecutable(
    path.join(fakeBin, 'getent'),
    `#!/bin/sh
if [ "\${1:-}" = "$BOOTSTRAP_CONFLICT_KIND" ] && [ "\${2:-}" = '10001' ]; then
  printf '%s\\n' 'occupied:x:10001:10001:fixture:/nonexistent:/usr/sbin/nologin'
  exit 0
fi
exit 2
`
  )

  writeExecutable(
    path.join(fakeBin, 'docker'),
    `#!/bin/sh
exit 0
`
  )

  for (const command of ['setpriv', 'install', 'useradd', 'groupadd', 'passwd', 'visudo']) {
    writeExecutable(
      path.join(fakeBin, command),
      `#!/bin/sh
: > "$BOOTSTRAP_MUTATION_MARKER"
exit 90
`
    )
  }

  for (const command of ['flock', 'timeout', 'mktemp', 'stat', 'fuser']) {
    writeExecutable(path.join(fakeBin, command), '#!/bin/sh\nexit 0\n')
  }

  const result = spawnSync(
    rootPath('deploy/server/bootstrap-server.sh'),
    [sourceDir, publicKeyFile],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        BOOTSTRAP_CONFLICT_KIND: identityKind,
        BOOTSTRAP_MUTATION_MARKER: mutationMarker
      }
    }
  )

  return {
    cleanup() {
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    },
    mutationMarker,
    result
  }
}

function runBootstrapUserFixture({
  existing,
  existingGid = '1001',
  existingGroups = 'kinvest-deploy',
  existingHome = '',
  existingUid = '1001',
  freshUidTaken = false,
  preflightSymlink = '',
  publicKeyContent = ''
}) {
  const rawFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-bootstrap-user-'))
  const fixtureRoot = fs.realpathSync(rawFixtureRoot)
  const fakeBin = path.join(fixtureRoot, 'bin')
  const fakeState = path.join(fixtureRoot, 'state')
  const sourceDir = path.join(fixtureRoot, 'source')
  const dockerRoot = path.join(fixtureRoot, 'docker')
  const deployHome = path.join(fixtureRoot, 'home/kinvest-deploy')
  const localSbin = path.join(fixtureRoot, 'usr/local/sbin')
  const sudoersDir = path.join(fixtureRoot, 'etc/sudoers.d')
  const publicKeyFile = path.join(fixtureRoot, 'deploy.pub')
  const modeledExistingHome = existingHome || deployHome

  for (const directory of [fakeBin, fakeState, sourceDir, dockerRoot, localSbin, sudoersDir]) {
    fs.mkdirSync(directory, { recursive: true })
  }

  fs.writeFileSync(
    publicKeyFile,
    publicKeyContent || `ssh-ed25519 ${'A'.repeat(44)} fixture\n`
  )
  fs.writeFileSync(path.join(sourceDir, 'docker-compose.yml'), 'services:\n  kinvest:\n    image: fixture\n')
  for (const scriptName of ['migrate-data-uid.sh', 'prepare-data-dir.sh']) {
    writeExecutable(
      path.join(sourceDir, scriptName),
      `#!/bin/sh
printf '%s\\n' '${scriptName}' >> "$BOOTSTRAP_FAKE_STATE/lifecycle.log"
printf '%s\\n' 'lifecycle ${scriptName}' >> "$BOOTSTRAP_FAKE_STATE/operations.log"
`
    )
  }
  fs.writeFileSync(
    path.join(sourceDir, 'migrate-data-uid-lib.sh'),
    '# migration core library fixture\n'
  )
  for (const scriptName of ['deploy-kinvest.sh', 'kinvest-ssh-command']) {
    writeExecutable(path.join(sourceDir, scriptName), '#!/bin/sh\nexit 0\n')
  }

  if (preflightSymlink) {
    const symlinkTarget = path.join(fixtureRoot, 'symlink-target')
    fs.mkdirSync(symlinkTarget)

    if (preflightSymlink === 'deploy-home') {
      fs.mkdirSync(path.dirname(deployHome), { recursive: true })
      fs.symlinkSync(symlinkTarget, deployHome)
    } else if (preflightSymlink === 'deploy-ssh') {
      fs.mkdirSync(deployHome, { recursive: true })
      fs.symlinkSync(symlinkTarget, path.join(deployHome, '.ssh'))
    } else if (preflightSymlink === 'authorized-keys') {
      fs.mkdirSync(path.join(deployHome, '.ssh'), { recursive: true })
      fs.symlinkSync(
        path.join(symlinkTarget, 'authorized_keys'),
        path.join(deployHome, '.ssh/authorized_keys')
      )
    } else if (preflightSymlink === 'sudoers') {
      fs.symlinkSync(
        path.join(symlinkTarget, 'kinvest-deploy'),
        path.join(sudoersDir, 'kinvest-deploy')
      )
    }
  }

  writeExecutable(
    path.join(fakeBin, 'id'),
    `#!/bin/sh
if [ "\${1:-}" = '-u' ] && [ "$#" -eq 1 ]; then
  printf '%s\\n' '0'
  exit 0
fi
if [ "\${1:-}" = '-nG' ]; then
  printf '%s\\n' "$BOOTSTRAP_EXISTING_GROUPS"
  exit 0
fi
if [ "\${1:-}" = 'kinvest-deploy' ]; then
  if [ "$BOOTSTRAP_EXISTING" = 'true' ] || [ -f "$BOOTSTRAP_FAKE_STATE/user-created" ]; then
    exit 0
  fi
  exit 1
fi
exec /usr/bin/id "$@"
`
  )

  writeExecutable(
    path.join(fakeBin, 'getent'),
    `#!/bin/sh
database="\${1:-}"
key="\${2:-}"
if [ "$database:$key" = 'passwd:10001' ]; then
  if [ "$BOOTSTRAP_EXISTING" = 'true' ] && [ "$BOOTSTRAP_EXISTING_UID" = '10001' ]; then
    printf 'kinvest-deploy:x:%s:%s::%s:/bin/bash\\n' \
      "$BOOTSTRAP_EXISTING_UID" "$BOOTSTRAP_EXISTING_GID" "$BOOTSTRAP_EXISTING_HOME"
    exit 0
  fi
  exit 2
fi
if [ "$database:$key" = 'group:10001' ]; then
  if [ "$BOOTSTRAP_EXISTING" = 'true' ] && [ "$BOOTSTRAP_EXISTING_GID" = '10001' ]; then
    printf '%s\\n' 'kinvest-deploy:x:10001:'
    exit 0
  fi
  exit 2
fi
if [ "$database:$key" = 'passwd:10002' ] || [ "$database:$key" = 'group:10002' ]; then
  [ "$BOOTSTRAP_FRESH_UID_TAKEN" = 'true' ] && {
    printf '%s\\n' 'occupied:x:10002:'
    exit 0
  }
  [ -f "$BOOTSTRAP_FAKE_STATE/user-created" ] && exit 0
  exit 2
fi
if [ "$database:$key" = 'group:kinvest-deploy' ]; then
  [ "$BOOTSTRAP_EXISTING" = 'true' ] || [ -f "$BOOTSTRAP_FAKE_STATE/group-created" ]
  exit
fi
if [ "$database:$key" = 'passwd:kinvest-deploy' ]; then
  if [ "$BOOTSTRAP_EXISTING" = 'true' ]; then
    printf 'kinvest-deploy:x:%s:%s::%s:/bin/bash\\n' \
      "$BOOTSTRAP_EXISTING_UID" "$BOOTSTRAP_EXISTING_GID" "$BOOTSTRAP_EXISTING_HOME"
    exit 0
  fi
  if [ -f "$BOOTSTRAP_FAKE_STATE/user-created" ]; then
    printf 'kinvest-deploy:x:10002:10002::%s:/bin/bash\\n' "$BOOTSTRAP_DEPLOY_HOME"
    exit 0
  fi
fi
exit 2
`
  )

  writeExecutable(
    path.join(fakeBin, 'groupadd'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$BOOTSTRAP_FAKE_STATE/groupadd.log"
printf '%s\\n' "groupadd $*" >> "$BOOTSTRAP_FAKE_STATE/operations.log"
: > "$BOOTSTRAP_FAKE_STATE/group-created"
`
  )
  writeExecutable(
    path.join(fakeBin, 'useradd'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$BOOTSTRAP_FAKE_STATE/useradd.log"
printf '%s\\n' "useradd $*" >> "$BOOTSTRAP_FAKE_STATE/operations.log"
: > "$BOOTSTRAP_FAKE_STATE/user-created"
`
  )
  writeExecutable(
    path.join(fakeBin, 'install'),
    `#!/usr/bin/env bash
set -e
printf '%s\\n' "install $*" >> "$BOOTSTRAP_FAKE_STATE/operations.log"
arguments=("$@")
count="\${#arguments[@]}"
destination="\${arguments[$((count - 1))]}"
mode='0755'
directory='false'
for ((index = 0; index < count; index += 1)); do
  [ "\${arguments[$index]}" = '-d' ] && directory='true'
  if [ "\${arguments[$index]}" = '-m' ]; then
    mode="\${arguments[$((index + 1))]}"
  fi
done
if [ "$directory" = 'true' ]; then
  mkdir -p "$destination"
  chmod "$mode" "$destination"
else
  source="\${arguments[$((count - 2))]}"
  mkdir -p "$(dirname "$destination")"
  cp "$source" "$destination"
  chmod "$mode" "$destination"
fi
`
  )
  writeExecutable(
    path.join(fakeBin, 'chown'),
    '#!/bin/sh\nprintf "%s\\n" "chown $*" >> "$BOOTSTRAP_FAKE_STATE/operations.log"\n'
  )
  writeExecutable(
    path.join(fakeBin, 'chmod'),
    '#!/bin/sh\nprintf "%s\\n" "chmod $*" >> "$BOOTSTRAP_FAKE_STATE/operations.log"\nexec /bin/chmod "$@"\n'
  )
  writeExecutable(
    path.join(fakeBin, 'passwd'),
    '#!/bin/sh\nprintf "%s\\n" "passwd $*" >> "$BOOTSTRAP_FAKE_STATE/operations.log"\n'
  )
  writeExecutable(path.join(fakeBin, 'visudo'), '#!/bin/sh\nexit 0\n')
  writeExecutable(
    path.join(fakeBin, 'realpath'),
    '#!/bin/sh\nfor argument in "$@"; do result="$argument"; done\nprintf "%s\\n" "$result"\n'
  )
  writeExecutable(
    path.join(fakeBin, 'docker'),
    `#!/bin/sh
if [ "\${1:-}" = 'compose' ] && [ "\${2:-}" = 'version' ]; then
  exit 0
fi
if [ "\${1:-}" = 'network' ] && [ "\${2:-}" = 'inspect' ]; then
  exit 1
fi
if [ "\${1:-}" = 'network' ] && [ "\${2:-}" = 'create' ]; then
  printf '%s\\n' "network-create \${3:-}" >> "$BOOTSTRAP_FAKE_STATE/operations.log"
  exit 0
fi
exit 90
`
  )
  writeExecutable(
    path.join(fakeBin, 'mktemp'),
    `#!/bin/sh
printf '%s\\n' "mktemp $*" >> "$BOOTSTRAP_FAKE_STATE/operations.log"
exec /usr/bin/mktemp "$@"
`
  )
  for (const command of ['setpriv', 'flock', 'timeout', 'stat', 'fuser']) {
    writeExecutable(path.join(fakeBin, command), '#!/bin/sh\nexit 0\n')
  }

  const bootstrapSource = readRootFile('deploy/server/bootstrap-server.sh')
    .replace("DOCKER_ROOT='/root/docker'", `DOCKER_ROOT='${dockerRoot}'`)
    .replace("DEPLOY_HOME='/home/kinvest-deploy'", `DEPLOY_HOME='${deployHome}'`)
    .replace(
      "LOCAL_DEPLOY_SCRIPT='/usr/local/sbin/deploy-kinvest'",
      `LOCAL_DEPLOY_SCRIPT='${path.join(localSbin, 'deploy-kinvest')}'`
    )
    .replace(
      "LOCAL_SSH_COMMAND='/usr/local/sbin/kinvest-ssh-command'",
      `LOCAL_SSH_COMMAND='${path.join(localSbin, 'kinvest-ssh-command')}'`
    )
    .replace(
      "SUDOERS_FILE='/etc/sudoers.d/kinvest-deploy'",
      `SUDOERS_FILE='${path.join(sudoersDir, 'kinvest-deploy')}'`
    )
  const scriptPath = path.join(fixtureRoot, 'bootstrap-server.sh')
  writeExecutable(scriptPath, bootstrapSource)

  const result = spawnSync(scriptPath, [sourceDir, publicKeyFile], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
        BOOTSTRAP_DEPLOY_HOME: deployHome,
        BOOTSTRAP_EXISTING: String(existing),
        BOOTSTRAP_EXISTING_GID: existingGid,
        BOOTSTRAP_EXISTING_GROUPS: existingGroups,
        BOOTSTRAP_EXISTING_HOME: modeledExistingHome,
        BOOTSTRAP_EXISTING_UID: existingUid,
        BOOTSTRAP_FAKE_STATE: fakeState,
        BOOTSTRAP_FRESH_UID_TAKEN: String(freshUidTaken)
    }
  })

  return {
    cleanup() {
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    },
    deployHome,
    fakeState,
    result
  }
}

function run() {
  const workflow = readRootFile('.github/workflows/deploy.yml')
  const deploy = readRootFile('deploy/server/deploy-kinvest.sh')
  const bootstrap = readRootFile('deploy/server/bootstrap-server.sh')
  const wrapper = readRootFile('deploy/server/kinvest-ssh-command')

  assertBasicWorkflowYaml(workflow)

  for (const relativePath of [
    'deploy/server/deploy-kinvest.sh',
    'deploy/server/bootstrap-server.sh',
    'deploy/server/kinvest-ssh-command'
  ]) {
    assert.equal(fs.statSync(rootPath(relativePath)).mode & 0o111, 0o111)
  }

  assert.match(workflow, /^ {2}group: kinvest-production$/m)
  assert.match(workflow, /^ {2}cancel-in-progress: false$/m)
  assert.equal((workflow.match(/timeout-minutes:/g) || []).length, 3)
  const deployTimeoutMatch = workflow.match(
    /^ {2}deploy:\n[\s\S]*?^ {4}timeout-minutes: ([0-9]+)$/m
  )
  assert.ok(deployTimeoutMatch, 'deploy job must define a bounded timeout')
  const deployTimeoutMinutes = Number.parseInt(deployTimeoutMatch[1], 10)
  assert.equal(deployTimeoutMinutes, 40)
  assert.match(workflow, /^ {4}if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}$/m)
  assert.match(
    workflow,
    /^ {4}if: \$\{\{ github\.ref == 'refs\/heads\/main' && vars\.DEPLOY_ENABLED == 'true' \}\}$/m
  )
  assert.match(workflow, /docker\/build-push-action@[0-9a-f]{40}/)
  assert.match(workflow, /docker\/login-action@[0-9a-f]{40}/)
  assert.match(workflow, /docker\/setup-buildx-action@[0-9a-f]{40}/)
  assert.match(workflow, /IMAGE_DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/)
  assert.match(workflow, /IMAGE_DIGEST: \$\{\{ needs\.publish\.outputs\.image_digest \}\}/)
  assert.match(workflow, /ghcr\.io\/zwphhxx\/kinvest/)
  assert.doesNotMatch(workflow, /github\.repository_owner/)
  assert.doesNotMatch(workflow, /:latest\b/)
  assert.match(workflow, /ConnectTimeout=10/)
  assert.match(workflow, /ServerAliveInterval=15/)
  assert.match(workflow, /ServerAliveCountMax=2/)
  assert.match(workflow, /StrictHostKeyChecking=yes/)
  assert.match(workflow, /"deploy \$IMAGE_DIGEST_REF \$DEPLOY_SHA"/)
  assert.doesNotMatch(workflow, /sudo \/usr\/local\/sbin\/deploy-kinvest/)

  assert.match(deploy, /^ALLOWED_REPOSITORY='ghcr\.io\/zwphhxx\/kinvest'$/m)
  assert.match(deploy, /\^ghcr\\\.io\/zwphhxx\/kinvest@sha256:\[0-9a-f\]\{64\}\$/)
  assert.match(deploy, /^CURRENT_STATE="\$STATE\/current\.state"$/m)
  assert.match(deploy, /^PREVIOUS_STATE="\$STATE\/previous\.state"$/m)
  assert.match(deploy, /^PULL_TIMEOUT='900s'$/m)
  assert.match(deploy, /^DOCKER_TIMEOUT='120s'$/m)
  assert.match(deploy, /^COMPOSE_TIMEOUT='120s'$/m)
  assert.match(deploy, /^INSPECT_TIMEOUT='15s'$/m)
  assert.match(deploy, /^HEALTH_TIMEOUT_SECONDS='120'$/m)
  assert.match(deploy, /digest_ref=%s\\ncommit=%s/)
  assert.match(deploy, /timeout --signal=TERM/)
  assert.match(deploy, /--kill-after=/)
  const runPullBody = deploy.match(/^run_pull\(\) \{([\s\S]*?)^\}$/m)
  const runDockerBody = deploy.match(/^run_docker\(\) \{([\s\S]*?)^\}$/m)
  assert.ok(runPullBody, 'deployment must define a dedicated pull wrapper')
  assert.ok(runDockerBody, 'deployment must retain a bounded general Docker wrapper')
  assert.match(runPullBody[1], /\$PULL_TIMEOUT/)
  assert.match(runPullBody[1], /docker pull "\$1"/)
  assert.match(runDockerBody[1], /\$DOCKER_TIMEOUT/)
  assert.doesNotMatch(runDockerBody[1], /pull/)
  assert.match(deploy, /run_docker network inspect web/)
  assert.match(deploy, /run_docker rm -f kinvest/)
  assert.doesNotMatch(deploy, /run_docker pull/)
  assert.match(deploy, /run_pull "\$digest_ref"/)
  assert.doesNotMatch(deploy, /run_pull "\$previous_digest_ref"/)
  assert.match(deploy, /verify_running_image/)
  assert.match(deploy, /\.Config\.Image/)
  assert.match(deploy, /run_inspect image inspect/)
  assert.match(deploy, /actual_image_id/)
  assert.match(deploy, /expected_image_id/)
  assert.doesNotMatch(deploy, /set \+e/)
  assert.doesNotMatch(deploy, /:latest\b/)

  const timeoutSeconds = (name) => {
    const match = deploy.match(new RegExp(`^${name}='([0-9]+)s'$`, 'm'))
    assert.ok(match, `${name} must be a bounded whole-second timeout`)
    return Number.parseInt(match[1], 10)
  }
  const plainSeconds = (name) => {
    const match = deploy.match(new RegExp(`^${name}='([0-9]+)'$`, 'm'))
    assert.ok(match, `${name} must be a bounded whole-second value`)
    return Number.parseInt(match[1], 10)
  }
  const functionBody = (name) => {
    const match = deploy.match(new RegExp(`^${name}\\(\\) \\{([\\s\\S]*?)^\\}$`, 'm'))
    assert.ok(match, `${name} must remain an auditable shell function`)
    return match[1]
  }
  const inspectCalls = (name) =>
    (functionBody(name).match(/\brun_inspect\b/g) || []).length

  const pullSeconds = timeoutSeconds('PULL_TIMEOUT')
  const dockerSeconds = timeoutSeconds('DOCKER_TIMEOUT')
  const composeSeconds = timeoutSeconds('COMPOSE_TIMEOUT')
  const inspectSeconds = timeoutSeconds('INSPECT_TIMEOUT')
  const dockerKillSeconds = timeoutSeconds('DOCKER_KILL_AFTER')
  const inspectKillSeconds = timeoutSeconds('INSPECT_KILL_AFTER')
  const healthSeconds = plainSeconds('HEALTH_TIMEOUT_SECONDS')
  const inspectCallSeconds = inspectSeconds + inspectKillSeconds
  const healthWorstSeconds = healthSeconds + inspectCallSeconds

  const snapshotInspectCalls = inspectCalls('capture_previous_snapshot')
  const candidateIdentityInspectCalls = inspectCalls('verify_running_image')
  const localSnapshotInspectCalls = inspectCalls(
    'previous_snapshot_is_locally_available'
  )
  const previousIdentityInspectCalls = inspectCalls(
    'verify_previous_image_from_snapshot'
  )
  const currentHealthInspectCalls = inspectCalls('current_is_healthy')
  const previousServingInspectCalls =
    localSnapshotInspectCalls +
    previousIdentityInspectCalls +
    currentHealthInspectCalls

  assert.equal(snapshotInspectCalls, 4)
  assert.equal(candidateIdentityInspectCalls, 3)
  assert.equal(localSnapshotInspectCalls, 1)
  assert.equal(previousIdentityInspectCalls, 2)
  assert.equal(currentHealthInspectCalls, 1)
  assert.equal(previousServingInspectCalls, 4)

  const networkPrecheckSeconds = dockerSeconds + dockerKillSeconds
  const previousSnapshotSeconds = snapshotInspectCalls * inspectCallSeconds
  const candidatePullSeconds = pullSeconds + dockerKillSeconds
  const candidateComposeSeconds = composeSeconds + dockerKillSeconds
  const candidateIdentitySeconds = candidateIdentityInspectCalls * inspectCallSeconds
  const rollbackPrecheckSeconds = previousServingInspectCalls * inspectCallSeconds
  const rollbackLocalImageSeconds = localSnapshotInspectCalls * inspectCallSeconds
  const rollbackComposeSeconds = composeSeconds + dockerKillSeconds
  const rollbackIdentitySeconds = previousIdentityInspectCalls * inspectCallSeconds
  const rollbackFailureRecheckSeconds = previousServingInspectCalls * inspectCallSeconds
  const rollbackCleanupSeconds = dockerSeconds + dockerKillSeconds
  const fixedOverheadSeconds = 120
  const cumulativeDeploySeconds =
    networkPrecheckSeconds +
    previousSnapshotSeconds +
    candidatePullSeconds +
    candidateComposeSeconds +
    healthWorstSeconds +
    candidateIdentitySeconds +
    rollbackPrecheckSeconds +
    rollbackLocalImageSeconds +
    rollbackComposeSeconds +
    rollbackIdentitySeconds +
    healthWorstSeconds +
    rollbackFailureRecheckSeconds +
    rollbackCleanupSeconds +
    fixedOverheadSeconds
  const deployJobSeconds = deployTimeoutMinutes * 60
  assert.ok(
    cumulativeDeploySeconds <= deployJobSeconds - 180,
    `worst-case ${cumulativeDeploySeconds}s deployment must leave at least 180s in the job`
  )

  assert.match(wrapper, /^ALLOWED_REPOSITORY='ghcr\.io\/zwphhxx\/kinvest'$/m)
  assert.match(wrapper, /SSH_ORIGINAL_COMMAND/)
  assert.match(wrapper, /expected_command="deploy \$digest_ref \$commit_sha"/)
  assert.match(wrapper, /sudo -n \/usr\/local\/sbin\/deploy-kinvest/)
  assert.doesNotMatch(wrapper, /eval|docker/)

  assert.match(bootstrap, /kinvest-ssh-command/)
  assert.match(bootstrap, /migrate-data-uid\.sh/)
  assert.match(bootstrap, /migrate-data-uid-lib\.sh/)
  assert.match(
    bootstrap,
    /install -o root -g root -m 0644 -- "\$SOURCE_DIR\/migrate-data-uid-lib\.sh" "\$TARGET\/migrate-data-uid-lib\.sh"/
  )
  assert.match(
    bootstrap,
    /install -o root -g root -m 0755 -- "\$TARGET\/kinvest-ssh-command" "\$LOCAL_SSH_COMMAND"/
  )
  assert.match(
    bootstrap,
    /restrict,command="\/usr\/local\/sbin\/kinvest-ssh-command"/
  )
  assert.match(bootstrap, /authorized_keys/)
  assert.match(
    bootstrap,
    /kinvest-deploy ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/deploy-kinvest ""/
  )
  assert.match(bootstrap, /id -nG "\$DEPLOY_USER"/)
  assert.match(bootstrap, /grep -Eq '[^']*docker/)
  assert.match(bootstrap, /^APP_UID='10001'$/m)
  assert.match(bootstrap, /^APP_GID='10001'$/m)
  assert.match(bootstrap, /^DEPLOY_UID='10002'$/m)
  assert.match(bootstrap, /^DEPLOY_GID='10002'$/m)
  assert.match(
    bootstrap,
    /for command in docker setpriv install useradd groupadd passwd visudo realpath flock timeout wc grep getent mktemp stat fuser; do/
  )
  assert.match(bootstrap, /getent passwd "\$APP_UID"/)
  assert.match(bootstrap, /getent group "\$APP_GID"/)
  assert.match(bootstrap, /groupadd --gid "\$DEPLOY_GID" "\$DEPLOY_USER"/)
  assert.match(
    bootstrap,
    /useradd --uid "\$DEPLOY_UID" --gid "\$DEPLOY_GID" --create-home --home-dir "\$DEPLOY_HOME" --shell \/bin\/bash "\$DEPLOY_USER"/
  )
  assert.match(bootstrap, /existing_deploy_uid/)
  assert.match(bootstrap, /existing_deploy_gid/)
  assert.doesNotMatch(bootstrap, /\bAPP_(?:UID|GID)='1000'\b/)
  assert.doesNotMatch(bootstrap, /usermod[^\n]*docker|gpasswd[^\n]*docker|docker group/i)
  assert.doesNotMatch(bootstrap, /ssh-(?:ed25519|rsa) [A-Za-z0-9+/]{40,}/)
  assert.doesNotMatch(deploy, /migrate-data-uid/)
  assert.match(deploy, /prepare-data-dir\.sh/)

  const migrateCallIndex = bootstrap.indexOf('"$TARGET/migrate-data-uid.sh"')
  const prepareCallIndex = bootstrap.indexOf('"$TARGET/prepare-data-dir.sh"')
  assert.ok(migrateCallIndex >= 0 && prepareCallIndex > migrateCallIndex)

  const freshUser = runBootstrapUserFixture({ existing: false })
  try {
    assert.equal(freshUser.result.status, 0, freshUser.result.stderr)
    assert.equal(
      fs.readFileSync(path.join(freshUser.fakeState, 'groupadd.log'), 'utf8').trim(),
      '--gid 10002 kinvest-deploy'
    )
    assert.equal(
      fs.readFileSync(path.join(freshUser.fakeState, 'useradd.log'), 'utf8').trim(),
      '--uid 10002 --gid 10002 --create-home --home-dir ' +
        `${freshUser.deployHome} ` +
        '--shell /bin/bash kinvest-deploy'
    )
    assert.deepEqual(
      fs.readFileSync(path.join(freshUser.fakeState, 'lifecycle.log'), 'utf8').trim().split('\n'),
      ['migrate-data-uid.sh', 'prepare-data-dir.sh']
    )
    const freshOperations = fs
      .readFileSync(path.join(freshUser.fakeState, 'operations.log'), 'utf8')
      .trim()
      .split('\n')
    assert.ok(freshOperations.findIndex((line) => line.startsWith('install ')) >= 0)
    assert.ok(
      freshOperations.indexOf('lifecycle migrate-data-uid.sh') <
        freshOperations.findIndex((line) => line.startsWith('groupadd '))
    )
  } finally {
    freshUser.cleanup()
  }

  const existingUser = runBootstrapUserFixture({ existing: true })
  try {
    assert.equal(existingUser.result.status, 0, existingUser.result.stderr)
    assert.equal(fs.existsSync(path.join(existingUser.fakeState, 'groupadd.log')), false)
    assert.equal(fs.existsSync(path.join(existingUser.fakeState, 'useradd.log')), false)
    assert.deepEqual(
      fs.readFileSync(path.join(existingUser.fakeState, 'lifecycle.log'), 'utf8').trim().split('\n'),
      ['migrate-data-uid.sh', 'prepare-data-dir.sh']
    )
  } finally {
    existingUser.cleanup()
  }

  for (const unsafeFixture of [
    { existing: true, existingHome: '/unexpected/home' },
    { existing: true, existingUid: '10001' },
    { existing: true, existingGid: '10001' },
    { existing: true, existingGroups: 'kinvest-deploy docker' },
    { existing: false, freshUidTaken: true }
  ]) {
    const rejectedPreflight = runBootstrapUserFixture(unsafeFixture)
    try {
      assert.notEqual(rejectedPreflight.result.status, 0)
      assert.equal(
        fs.existsSync(path.join(rejectedPreflight.fakeState, 'operations.log')),
        false,
        'unsafe deployment account preflight must fail before install, migration, or user creation'
      )
    } finally {
      rejectedPreflight.cleanup()
    }
  }

  for (const invalidPublicKey of [
    `ssh-ed25519 ${'A'.repeat(44)} first\nssh-ed25519 ${'B'.repeat(44)} second\n`,
    `ssh-rsa ${'A'.repeat(44)} fixture\n`,
    'ssh-ed25519 invalid!blob fixture\n'
  ]) {
    const rejectedKey = runBootstrapUserFixture({
      existing: false,
      publicKeyContent: invalidPublicKey
    })
    try {
      assert.notEqual(rejectedKey.result.status, 0)
      assert.equal(
        fs.existsSync(path.join(rejectedKey.fakeState, 'operations.log')),
        false,
        'invalid deployment public key must fail before every server write'
      )
      assert.doesNotMatch(
        `${rejectedKey.result.stdout}${rejectedKey.result.stderr}`,
        /invalid!blob|A{20}|B{20}/
      )
    } finally {
      rejectedKey.cleanup()
    }
  }

  for (const preflightSymlink of [
    'deploy-home',
    'deploy-ssh',
    'authorized-keys',
    'sudoers'
  ]) {
    const rejectedSymlink = runBootstrapUserFixture({
      existing: true,
      preflightSymlink
    })
    try {
      assert.notEqual(rejectedSymlink.result.status, 0)
      assert.equal(
        fs.existsSync(path.join(rejectedSymlink.fakeState, 'operations.log')),
        false,
        `${preflightSymlink} symlink must fail before install, migration, mktemp, or account changes`
      )
      assert.equal(
        fs.existsSync(path.join(rejectedSymlink.fakeState, 'lifecycle.log')),
        false
      )
    } finally {
      rejectedSymlink.cleanup()
    }
  }

  /** @type {Array<[string, RegExp]>} */
  const identityConflicts = [
    ['passwd', /UID 10001 is already assigned/i],
    ['group', /GID 10001 is already assigned/i]
  ]

  for (const [identityKind, messagePattern] of identityConflicts) {
    const conflict = runBootstrapIdentityConflict(identityKind)
    try {
      assert.equal(conflict.result.status, 1)
      assert.match(conflict.result.stderr, messagePattern)
      assert.equal(
        fs.existsSync(conflict.mutationMarker),
        false,
        `${identityKind} conflict must fail before any server mutation`
      )
    } finally {
      conflict.cleanup()
    }
  }

  assertRejectedInput(
    `ghcr.io/other/kinvest@${candidateDigest}\n${candidateCommit}\n`,
    /immutable Kinvest digest reference/
  )
  assertRejectedInput(
    `${allowedRepository}:release\n${candidateCommit}\n`,
    /immutable Kinvest digest reference/
  )
  assertRejectedInput(
    `${allowedRepository}@sha256:abcd\n${candidateCommit}\n`,
    /immutable Kinvest digest reference/
  )
  assertRejectedInput(`${candidateRef}\n${candidateCommit}\nextra\n`, /exactly two input lines/)

  const mismatch = runDeployFixture(['candidate-mismatch'], { withPrevious: false })
  try {
    const diagnostics = deployFixtureDiagnostics(mismatch)
    assert.notEqual(mismatch.result.status, 0, diagnostics)
    assert.ok(
      fs.existsSync(path.join(mismatch.fakeState, 'removed')),
      `unverified candidate must be removed when no previous release can be verified\n${diagnostics}`
    )
    assert.match(
      fs.readFileSync(path.join(mismatch.fakeState, 'docker-calls.log'), 'utf8'),
      /^rm -f kinvest$/m,
      diagnostics
    )
    assert.match(mismatch.result.stderr, /running image does not match/)
    assert.match(mismatch.result.stderr, /manual intervention is required/i)
  } finally {
    mismatch.cleanup()
  }

  const candidatePullFailure = runDeployFixture(['fail-candidate-pull'])
  try {
    assert.notEqual(candidatePullFailure.result.status, 0)
    assert.equal(
      fs.readFileSync(path.join(candidatePullFailure.fakeState, 'running.ref'), 'utf8').trim(),
      previousRef
    )
    assert.equal(fs.existsSync(path.join(candidatePullFailure.fakeState, 'removed')), false)
    assert.match(candidatePullFailure.result.stderr, /部署失败但previous继续服务/)
  } finally {
    candidatePullFailure.cleanup()
  }

  const previousSnapshotFailure = runDeployFixture(['fail-previous-snapshot'])
  try {
    const diagnostics = deployFixtureDiagnostics(previousSnapshotFailure)
    assert.notEqual(previousSnapshotFailure.result.status, 0, diagnostics)
    const dockerCalls = fs.readFileSync(
      path.join(previousSnapshotFailure.fakeState, 'docker-calls.log'),
      'utf8'
    )
    assert.doesNotMatch(dockerCalls, /^pull /m, diagnostics)
    assert.doesNotMatch(dockerCalls, /^compose /m, diagnostics)
    assert.doesNotMatch(dockerCalls, /^rm /m, diagnostics)
    assert.equal(
      fs.readFileSync(
        path.join(previousSnapshotFailure.fakeState, 'running.ref'),
        'utf8'
      ).trim(),
      previousRef,
      diagnostics
    )
    assert.equal(
      fs.existsSync(path.join(previousSnapshotFailure.stateDir, 'previous.state')),
      false,
      diagnostics
    )
    assert.match(previousSnapshotFailure.result.stderr, /refusing deployment.*snapshot/i)
  } finally {
    previousSnapshotFailure.cleanup()
  }

  const previousUnhealthy = runDeployFixture(['previous-unhealthy'])
  try {
    const diagnostics = deployFixtureDiagnostics(previousUnhealthy)
    assert.notEqual(previousUnhealthy.result.status, 0, diagnostics)
    const dockerCalls = fs.readFileSync(
      path.join(previousUnhealthy.fakeState, 'docker-calls.log'),
      'utf8'
    )
    assert.doesNotMatch(dockerCalls, new RegExp(candidateDigest), diagnostics)
    assert.doesNotMatch(dockerCalls, /^pull /m, diagnostics)
    assert.doesNotMatch(dockerCalls, /^compose /m, diagnostics)
    assert.doesNotMatch(dockerCalls, /^rm /m, diagnostics)
    assert.equal(
      fs.readFileSync(path.join(previousUnhealthy.fakeState, 'running.ref'), 'utf8').trim(),
      previousRef,
      diagnostics
    )
    assert.equal(
      fs.readFileSync(path.join(previousUnhealthy.fakeState, 'running.health'), 'utf8').trim(),
      'unhealthy',
      diagnostics
    )
    assert.match(previousUnhealthy.result.stderr, /refusing deployment.*snapshot/i)
  } finally {
    previousUnhealthy.cleanup()
  }

  const candidateComposeFailure = runDeployFixture(['fail-candidate-compose'])
  try {
    assert.notEqual(candidateComposeFailure.result.status, 0)
    assert.equal(
      fs.readFileSync(path.join(candidateComposeFailure.fakeState, 'running.ref'), 'utf8').trim(),
      previousRef
    )
    assert.equal(fs.existsSync(path.join(candidateComposeFailure.fakeState, 'removed')), false)
    assert.match(candidateComposeFailure.result.stderr, /部署失败但previous继续服务/)
  } finally {
    candidateComposeFailure.cleanup()
  }

  const successfulRollback = runDeployFixture(['candidate-mismatch'])
  try {
    const diagnostics = deployFixtureDiagnostics(successfulRollback)
    assert.notEqual(successfulRollback.result.status, 0, diagnostics)
    assert.equal(
      fs.readFileSync(path.join(successfulRollback.fakeState, 'running.ref'), 'utf8').trim(),
      previousRef,
      diagnostics
    )
    assert.equal(
      fs.existsSync(path.join(successfulRollback.fakeState, 'removed')),
      false,
      `verified healthy previous release must remain available\n${diagnostics}`
    )
    assert.doesNotMatch(
      fs.readFileSync(path.join(successfulRollback.fakeState, 'docker-calls.log'), 'utf8'),
      /^rm -f kinvest$/m,
      diagnostics
    )
    assert.doesNotMatch(
      fs.readFileSync(path.join(successfulRollback.fakeState, 'docker-calls.log'), 'utf8'),
      new RegExp(`^pull ${previousRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
      diagnostics
    )
    assert.match(successfulRollback.result.stderr, /previous healthy Kinvest digest was restored/i)
  } finally {
    successfulRollback.cleanup()
  }

  const currentNotPrevious = runDeployFixture([
    'candidate-mismatch',
    'fail-old-image-after-snapshot'
  ])
  try {
    assert.notEqual(currentNotPrevious.result.status, 0)
    assert.ok(fs.existsSync(path.join(currentNotPrevious.fakeState, 'removed')))
    assert.match(currentNotPrevious.result.stderr, /previous snapshot.*locally available/i)
    assert.match(currentNotPrevious.result.stderr, /manual intervention is required/i)
    assert.doesNotMatch(currentNotPrevious.result.stderr, /previous继续服务/)
  } finally {
    currentNotPrevious.cleanup()
  }

  const composeRollbackFailure = runDeployFixture(['candidate-mismatch', 'fail-old-compose'])
  try {
    assert.notEqual(composeRollbackFailure.result.status, 0)
    assert.ok(fs.existsSync(path.join(composeRollbackFailure.fakeState, 'removed')))
    assert.match(composeRollbackFailure.result.stderr, /previous release compose failed/i)
    assert.match(composeRollbackFailure.result.stderr, /manual intervention is required/i)
  } finally {
    composeRollbackFailure.cleanup()
  }

  const flockRejected = runDeployFixture(['flock-busy'])
  try {
    assert.notEqual(flockRejected.result.status, 0)
    assert.match(flockRejected.result.stderr, /already running/i)
    assert.equal(fs.existsSync(path.join(flockRejected.fakeState, 'removed')), false)
    assert.equal(fs.existsSync(path.join(flockRejected.fakeState, 'pulls.log')), false)
  } finally {
    flockRejected.cleanup()
  }

  const success = runDeployFixture()
  try {
    assert.equal(success.result.status, 0, success.result.stderr)
    assert.equal(
      fs.readFileSync(path.join(success.stateDir, 'current.state'), 'utf8'),
      `digest_ref=${candidateRef}\ncommit=${candidateCommit}\n`
    )
    assert.equal(
      fs.readFileSync(path.join(success.stateDir, 'previous.state'), 'utf8'),
      `digest_ref=${previousRef}\ncommit=${previousCommit}\n`
    )
    const timeoutLog = fs.readFileSync(path.join(success.fakeState, 'timeout.log'), 'utf8')
    assert.match(timeoutLog, /--signal=TERM --kill-after=10s 900s docker pull/)
    assert.match(timeoutLog, /--signal=TERM --kill-after=10s 120s docker network inspect/)
    assert.match(timeoutLog, /--signal=TERM --kill-after=10s 120s env .*docker compose/)
    assert.match(timeoutLog, /--signal=TERM --kill-after=5s 15s docker image inspect/)
    assert.match(timeoutLog, /--signal=TERM --kill-after=5s 15s docker inspect/)
    assert.doesNotMatch(timeoutLog, /900s docker (?!pull)/)
    assert.match(timeoutLog, /--kill-after=/)
  } finally {
    success.cleanup()
  }

  for (const source of [workflow, deploy, bootstrap, wrapper]) {
    assert.doesNotMatch(
      source,
      /(?:refresh_token|api[_-]?key|BEGIN [A-Z ]*PRIVATE KEY|106\.54\.229\.241)/i
    )
  }
}

module.exports = { run }
