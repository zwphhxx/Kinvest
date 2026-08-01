const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')
const tcrRepository = 'ccr.ccs.tencentyun.com/website-dev/kinvest'
const ghcrRepository = 'ghcr.io/zwphhxx/kinvest'
const candidateDigest = `sha256:${'b'.repeat(64)}`
const candidateRef = `${tcrRepository}@${candidateDigest}`
const candidateCommit = 'c'.repeat(40)
const previousDigest = `sha256:${'a'.repeat(64)}`
const previousRef = `${ghcrRepository}@${previousDigest}`
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

function findWorkflowBlock(source, key, indent) {
  const lines = source.split('\n')
  const marker = `${' '.repeat(indent)}${key}:`
  const start = lines.findIndex((line) => line === marker)
  if (start === -1) {
    return null
  }

  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue
    }
    const lineIndent = line.length - line.trimStart().length
    if (lineIndent <= indent) {
      end = index
      break
    }
  }

  return lines.slice(start, end).join('\n')
}

function workflowBlock(source, key, indent) {
  const block = findWorkflowBlock(source, key, indent)
  assert.ok(block, `${key} must be a workflow mapping at indentation ${indent}`)
  return block
}

function directMappingKeys(block, indent) {
  const keyPattern = new RegExp(`^ {${indent}}([A-Za-z_][A-Za-z0-9_-]*):`, 'm')
  return block
    .split('\n')
    .map((line) => line.match(keyPattern)?.[1] ?? null)
    .filter((key) => key !== null)
}

function directScalar(block, key, indent) {
  const match = block.match(new RegExp(`^ {${indent}}${key}:\\s*(.+)$`, 'm'))
  assert.ok(match, `${key} must be a scalar at indentation ${indent}`)
  return match[1]
}

function directListItems(block, indent) {
  const itemPattern = new RegExp(`^ {${indent}}-\\s+(.+)$`, 'm')
  return block
    .split('\n')
    .map((line) => line.match(itemPattern)?.[1] ?? null)
    .filter((item) => item !== null)
}

function triggerBranches(events, trigger) {
  const triggerBlock = findWorkflowBlock(events, trigger, 2)
  if (!triggerBlock) {
    return []
  }
  const branchesBlock = findWorkflowBlock(triggerBlock, 'branches', 4)
  return branchesBlock ? directListItems(branchesBlock, 6) : []
}

function namedStep(job, name) {
  const lines = job.split('\n')
  const marker = `      - name: ${name}`
  const start = lines.findIndex((line) => line === marker)
  assert.notEqual(start, -1, `job must contain the "${name}" step`)

  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('      - ')) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

function multilineStepRun(step) {
  const lines = step.split('\n')
  const start = lines.findIndex((line) => line === '        run: |')
  assert.notEqual(start, -1, 'step must define a multiline run script')
  return lines
    .slice(start + 1)
    .map((line) => {
      assert.ok(
        line === '' || line.startsWith('          '),
        'multiline run script must retain YAML indentation'
      )
      return line === '' ? '' : line.slice(10)
    })
    .join('\n')
}

function runRepositoryScanFixture(repositoryScan, trackedPath) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-repository-scan-'))
  try {
    const trackedFile = path.join(fixtureRoot, trackedPath)
    fs.mkdirSync(path.dirname(trackedFile), { recursive: true })
    fs.writeFileSync(trackedFile, Buffer.from([0, 1, 2, 3]))

    const init = spawnSync('git', ['init', '--quiet'], {
      cwd: fixtureRoot,
      encoding: 'utf8'
    })
    assert.equal(init.status, 0, init.stderr)
    const add = spawnSync('git', ['add', '--', trackedPath], {
      cwd: fixtureRoot,
      encoding: 'utf8'
    })
    assert.equal(add.status, 0, add.stderr)

    return spawnSync('bash', ['-c', multilineStepRun(repositoryScan)], {
      cwd: fixtureRoot,
      encoding: 'utf8'
    })
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

function inlineList(value) {
  assert.match(value, /^\[[A-Za-z0-9_, -]+\]$/, 'value must be an inline YAML list')
  return value
    .slice(1, -1)
    .split(',')
    .map((item) => item.trim())
}

function assertRequiredPrJobsCannotSkipPullRequests(prJobs) {
  for (const [jobId, job] of Object.entries(prJobs)) {
    assert.equal(
      directMappingKeys(job, 4).includes('if'),
      false,
      `${jobId} must not define a job-level if that can skip pull_request checks`
    )
  }
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
    printf '%s\\n' "$ref" >> "$state/pull-attempts.log"
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
    if [[ "$ref" == "$CANDIDATE_REF" && -f "$state/candidate-pull-timeout-once" ]]; then
      rm -f "$state/candidate-pull-timeout-once"
      exit 124
    fi
    if [[ "$ref" == "$CANDIDATE_REF" && -f "$state/candidate-pull-permanent-error" ]]; then
      printf '%s\\n' 'Error response from daemon: manifest unknown' >&2
      exit 1
    fi
    if [[ "$ref" == "$CANDIDATE_REF" ]]; then
      remaining='0'
      if [[ -f "$state/candidate-pull-transient-remaining" ]]; then
        remaining="$(cat "$state/candidate-pull-transient-remaining")"
      fi
      if ((remaining > 0)); then
        printf '%s\\n' "$((remaining - 1))" > "$state/candidate-pull-transient-remaining"
        printf '%s\\n' 'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp 203.0.113.10:443: i/o timeout' >&2
        exit 1
      fi
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
    } else if (marker.startsWith('candidate-pull-transient-remaining:')) {
      fs.writeFileSync(
        path.join(fakeState, 'candidate-pull-transient-remaining'),
        marker.slice('candidate-pull-transient-remaining:'.length)
      )
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

function readPullAttempts(fixture) {
  const logPath = path.join(fixture.fakeState, 'pull-attempts.log')
  return fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trim().split('\n')
    : []
}

function assertRejectedInput(input, messagePattern, message) {
  const result = spawnSync(rootPath('deploy/server/deploy-kinvest.sh'), [], {
    encoding: 'utf8',
    input
  })

  assert.equal(result.status, 2, message)
  assert.match(result.stderr, messagePattern, message)
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
  const mirrorWorkflow = readRootFile('.github/workflows/mirror-tcr-manual.yml')
  const productionWorkflow = readRootFile('.github/workflows/deploy-production-manual.yml')
  const deploy = readRootFile('deploy/server/deploy-kinvest.sh')
  const bootstrap = readRootFile('deploy/server/bootstrap-server.sh')
  const wrapper = readRootFile('deploy/server/kinvest-ssh-command')

  assertBasicWorkflowYaml(workflow)
  assertBasicWorkflowYaml(mirrorWorkflow)
  assertBasicWorkflowYaml(productionWorkflow)

  const events = workflowBlock(workflow, 'on', 0)
  const jobs = workflowBlock(workflow, 'jobs', 0)
  const jobIds = directMappingKeys(jobs, 2)
  const missingPrContracts = []
  if (!triggerBranches(events, 'pull_request').includes('main')) {
    missingPrContracts.push('pull_request(main)')
  }
  for (const requiredJob of ['security', 'container-build']) {
    if (!jobIds.includes(requiredJob)) {
      missingPrContracts.push(`job:${requiredJob}`)
    }
  }
  assert.deepEqual(
    missingPrContracts,
    [],
    `secure PR workflow contracts are missing: ${missingPrContracts.join(', ')}`
  )

  assert.deepEqual(
    directMappingKeys(events, 2).sort(),
    ['pull_request', 'push', 'workflow_dispatch']
  )
  assert.deepEqual(triggerBranches(events, 'push'), ['main'])
  assert.deepEqual(triggerBranches(events, 'pull_request'), ['main'])
  assert.doesNotMatch(workflow, /^\s*pull_request_target:/m)

  assert.deepEqual(
    [...jobIds].sort(),
    ['container-build', 'publish', 'security', 'verify']
  )
  const prJobs = Object.fromEntries(
    ['verify', 'security', 'container-build'].map((jobId) => [
      jobId,
      workflowBlock(jobs, jobId, 2)
    ])
  )
  assertRequiredPrJobsCannotSkipPullRequests(prJobs)
  const pullRequestSkippingVerify = prJobs.verify.replace(
    '    runs-on: ubuntu-latest',
    "    if: github.event_name != 'pull_request'\n    runs-on: ubuntu-latest"
  )
  assert.throws(
    () =>
      assertRequiredPrJobsCannotSkipPullRequests({
        ...prJobs,
        verify: pullRequestSkippingVerify
      }),
    /verify must not define a job-level if that can skip pull_request checks/
  )

  for (const [jobId, job] of Object.entries(prJobs)) {
    assert.equal(directScalar(job, 'name', 4), jobId)
    const jobPermissions = workflowBlock(job, 'permissions', 4)
    assert.deepEqual(directMappingKeys(jobPermissions, 6), ['contents'])
    assert.equal(directScalar(jobPermissions, 'contents', 6), 'read')
    assert.equal(directMappingKeys(job, 4).includes('environment'), false)
    assert.doesNotMatch(job, /\$\{\{\s*secrets\./)
  }

  assert.equal(
    directScalar(namedStep(prJobs.verify, 'Install locked dependencies'), 'run', 8),
    'npm ci'
  )
  assert.equal(
    directScalar(namedStep(prJobs.verify, 'Run quality gates'), 'run', 8),
    'npm run check'
  )

  assert.equal(
    directScalar(namedStep(prJobs.security, 'Install locked dependencies'), 'run', 8),
    'npm ci'
  )
  assert.equal(
    directScalar(namedStep(prJobs.security, 'Audit high severity dependencies'), 'run', 8),
    'npm audit --audit-level=high'
  )
  const repositoryScan = namedStep(prJobs.security, 'Scan tracked files for secrets')
  assert.equal(directScalar(repositoryScan, 'shell', 8), 'bash')
  assert.equal(directScalar(repositoryScan, 'run', 8), '|')
  for (const uppercaseCredentialPath of [
    'credentials/secret.P12',
    'credentials/private.PFX',
    'credentials/private.JKS',
    'credentials/private.KEYSTORE',
    'credentials/key.DER'
  ]) {
    const scanResult = runRepositoryScanFixture(
      repositoryScan,
      uppercaseCredentialPath
    )
    assert.notEqual(
      scanResult.status,
      0,
      `${uppercaseCredentialPath} must be rejected regardless of extension case`
    )
    assert.ok(
      scanResult.stderr.includes(uppercaseCredentialPath),
      'scanner diagnostics must retain the original tracked path'
    )
  }
  assert.match(repositoryScan, /git ls-files -z/)
  assert.match(repositoryScan, /while IFS= read -r -d '' path/)
  assert.match(
    repositoryScan,
    /LC_ALL=C tr '\[:upper:\]' '\[:lower:\]'/
  )
  assert.match(repositoryScan, /forbidden_path="\$path"/)
  assert.match(repositoryScan, /\*\.example\|\*\.sample\|\*\.template/)
  assert.match(
    repositoryScan,
    /id_rsa\|id_dsa\|id_ecdsa\|id_ed25519\|\*\.key\|\*\.p12\|\*\.pfx\|\*\.jks\|\*\.keystore\|\*\.der/
  )
  assert.match(repositoryScan, /private_key_prefix='BEGIN \[A-Z \]\*PRIVATE'/)
  assert.match(repositoryScan, /private_key_suffix=' KEY'/)
  assert.match(repositoryScan, /github_prefix='gh\[pousr\]_'/)
  assert.match(repositoryScan, /github_fine_prefix='github_''pat_'/)
  assert.match(repositoryScan, /aws_prefix='AK''IA'/)
  assert.match(repositoryScan, /google_prefix='AI''za'/)
  assert.match(repositoryScan, /stripe_prefix='sk_''live_'/)
  assert.match(repositoryScan, /slack_prefix='xox''\[baprs\]-'/)
  assert.equal((repositoryScan.match(/git grep -IlE/g) || []).length, 2)
  assert.equal((repositoryScan.match(/>\/dev\/null/g) || []).length, 2)
  assert.doesNotMatch(repositoryScan, /git grep -IEn/)

  assert.match(
    prJobs['container-build'],
    /uses: docker\/setup-buildx-action@[0-9a-f]{40}/
  )
  assert.match(
    prJobs['container-build'],
    /uses: docker\/build-push-action@[0-9a-f]{40}/
  )
  assert.match(prJobs['container-build'], /^ {10}platforms: linux\/amd64$/m)
  assert.match(prJobs['container-build'], /^ {10}push: false$/m)
  assert.doesNotMatch(prJobs['container-build'], /docker\/login-action|push: true/)

  const publishJob = workflowBlock(jobs, 'publish', 2)
  assert.deepEqual(inlineList(directScalar(publishJob, 'needs', 4)), [
    'verify',
    'security',
    'container-build'
  ])
  assert.equal(
    directScalar(publishJob, 'if', 4),
    "${{ github.event_name != 'pull_request' && github.ref == 'refs/heads/main' }}"
  )
  assert.equal(
    directMappingKeys(publishJob, 4).includes('environment'),
    false,
    'GHCR-only publish must not require the RegistryPublish environment'
  )
  assert.match(publishJob, /ghcr\.io\/zwphhxx\/kinvest:\$\{\{ github\.sha \}\}/)
  assert.match(
    publishJob,
    /image_digest: \$\{\{ steps\.digest\.outputs\.ghcr_image_digest \}\}/,
    'publish must expose the GHCR digest output for the manual mirror input'
  )
  assert.doesNotMatch(
    publishJob,
    /tcr_image_digest|ccr\.ccs\.tencentyun\.com|TCR_USERNAME|TCR_PASSWORD|crane|RegistryPublish/,
    'automatic publish must not touch TCR; mirroring is manual only'
  )
  const publishDigestRun = multilineStepRun(
    namedStep(publishJob, 'Validate immutable image digest')
  )
  assert.match(publishDigestRun, /imagetools inspect "\$GHCR_REF"/)
  assert.match(
    publishDigestRun,
    /\[\[ ! "\$GHCR_DIGEST" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/,
    'GHCR digest must be format-validated as reported by GHCR'
  )
  assert.match(
    publishDigestRun,
    /"\$GHCR_DIGEST" != "\$BUILD_DIGEST"/,
    'GHCR digest must be verified against the build output digest'
  )
  assert.match(publishDigestRun, /printf 'ghcr_image_digest=%s\\n' "\$GHCR_DIGEST"/)

  const buildPublishStep = namedStep(publishJob, 'Build and publish audit-tagged image')
  assert.match(buildPublishStep, /ghcr\.io\/zwphhxx\/kinvest:\$\{\{ github\.sha \}\}/)
  assert.doesNotMatch(
    buildPublishStep,
    /ccr\.ccs\.tencentyun\.com/,
    'the build-push action must only publish GHCR'
  )

  assert.equal(
    jobIds.includes('deploy'),
    false,
    'deploy.yml must not deploy to production; production deploy is manual only'
  )
  assert.doesNotMatch(
    workflow,
    /\$\{\{\s*secrets\.(DEPLOY_|TCR_)/,
    'the automatic pipeline must not reference deploy or TCR credentials'
  )
  assert.doesNotMatch(
    workflow,
    /environment: (Production|RegistryPublish)/,
    'the automatic pipeline must not require any protected environment'
  )
  for (const [jobId, job] of Object.entries(prJobs)) {
    assert.doesNotMatch(
      job,
      /RegistryPublish|TCR_USERNAME|TCR_PASSWORD|ccr\.ccs\.tencentyun\.com/,
      `${jobId} must not access TCR credentials or the RegistryPublish environment`
    )
  }

  const mirrorEvents = workflowBlock(mirrorWorkflow, 'on', 0)
  assert.deepEqual(
    directMappingKeys(mirrorEvents, 2),
    ['workflow_dispatch'],
    'TCR mirroring must only be triggered manually'
  )
  const mirrorDispatch = workflowBlock(mirrorEvents, 'workflow_dispatch', 2)
  const mirrorInputs = workflowBlock(mirrorDispatch, 'inputs', 4)
  assert.deepEqual(directMappingKeys(mirrorInputs, 6).sort(), [
    'commit_sha',
    'confirm',
    'ghcr_digest'
  ])
  for (const inputName of ['commit_sha', 'confirm', 'ghcr_digest']) {
    const input = workflowBlock(mirrorInputs, inputName, 6)
    assert.equal(directScalar(input, 'required', 8), 'true')
  }
  const mirrorJobs = workflowBlock(mirrorWorkflow, 'jobs', 0)
  assert.deepEqual(directMappingKeys(mirrorJobs, 2).sort(), ['mirror', 'validate'])

  const mirrorValidateJob = workflowBlock(mirrorJobs, 'validate', 2)
  assert.equal(
    directMappingKeys(mirrorValidateJob, 4).includes('environment'),
    false,
    'mirror input validation must complete before entering the RegistryPublish environment'
  )
  const mirrorValidatePerms = workflowBlock(mirrorValidateJob, 'permissions', 4)
  assert.deepEqual(directMappingKeys(mirrorValidatePerms, 6), ['contents'])
  assert.equal(directScalar(mirrorValidatePerms, 'contents', 6), 'read')
  assert.doesNotMatch(
    mirrorValidateJob,
    /\$\{\{\s*secrets\.(TCR_|DEPLOY_)/,
    'mirror validate must not access registry or deploy credentials'
  )
  const mirrorValidateRun = multilineStepRun(
    namedStep(mirrorValidateJob, 'Validate mirror inputs')
  )
  assert.match(
    mirrorValidateRun,
    /"\$WORKFLOW_REF" != 'refs\/heads\/main'/,
    'mirror workflow must reject runs from non-main refs'
  )
  assert.match(mirrorValidateRun, /"\$CONFIRM" != 'MIRROR'/)
  assert.match(mirrorValidateRun, /\[\[ ! "\$COMMIT_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/)
  assert.match(
    mirrorValidateRun,
    /\[\[ ! "\$GHCR_DIGEST" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/
  )
  assert.match(
    mirrorValidateRun,
    /git merge-base --is-ancestor "\$COMMIT_SHA" origin\/main/,
    'mirror must only accept commits from main history'
  )
  const mirrorBindRun = multilineStepRun(
    namedStep(mirrorValidateJob, 'Bind GHCR digest to the commit tag')
  )
  assert.match(
    mirrorBindRun,
    /TAG_DIGEST="\$\(\/tmp\/crane digest "ghcr\.io\/zwphhxx\/kinvest:\$\{COMMIT_SHA\}"\)"/
  )
  assert.match(
    mirrorBindRun,
    /"\$TAG_DIGEST" != "\$GHCR_DIGEST"/,
    'mirror must bind ghcr_digest to the commit tag on GHCR before entering the environment'
  )

  const mirrorJob = workflowBlock(mirrorJobs, 'mirror', 2)
  assert.equal(
    directScalar(mirrorJob, 'needs', 4),
    'validate',
    'the RegistryPublish environment must only be entered after validation succeeds'
  )
  assert.equal(
    directScalar(mirrorJob, 'environment', 4),
    'RegistryPublish',
    'TCR credentials must only resolve inside the RegistryPublish environment'
  )
  assert.equal(directScalar(mirrorJob, 'timeout-minutes', 4), '150')
  assert.match(
    mirrorJob,
    /tcr_image_digest: \$\{\{ steps\.mirror\.outputs\.tcr_image_digest \}\}/,
    'mirror must expose the TCR digest output only after a verified copy'
  )
  assert.match(mirrorJob, /registry: ccr\.ccs\.tencentyun\.com/)
  assert.match(mirrorJob, /username: \$\{\{ secrets\.TCR_USERNAME \}\}/)
  assert.match(mirrorJob, /password: \$\{\{ secrets\.TCR_PASSWORD \}\}/)

  const mirrorCraneStep = namedStep(mirrorJob, 'Install pinned crane')
  assert.match(mirrorCraneStep, /CRANE_VERSION: 'v0\.21\.7'/)
  assert.match(mirrorCraneStep, /CRANE_SHA256: '[0-9a-f]{64}'/)
  assert.match(mirrorCraneStep, /sha256sum -c -/)
  assert.match(mirrorCraneStep, /curl -fsSL --max-time 60/)
  assert.match(
    mirrorCraneStep,
    /releases\/download\/\$\{CRANE_VERSION\}\/go-containerregistry_Linux_x86_64\.tar\.gz/
  )

  const mirrorRun = multilineStepRun(
    namedStep(mirrorJob, 'Mirror exact digest to TCR (single bounded attempt)')
  )
  assert.match(
    mirrorRun,
    /COPY_SRC="ghcr\.io\/zwphhxx\/kinvest@\$\{GHCR_DIGEST\}"/,
    'the TCR copy source must use the exact GHCR digest'
  )
  assert.match(
    mirrorRun,
    /TCR_REF="ccr\.ccs\.tencentyun\.com\/website-dev\/kinvest:\$\{COMMIT_SHA\}"/,
    'the TCR copy target must use the audit commit tag'
  )
  assert.doesNotMatch(mirrorRun, /:latest\b/, 'registry copy must not use mutable tags')
  assert.match(
    mirrorRun,
    /timeout --signal=TERM --kill-after=10s 7800s \\?\n\s+\/tmp\/crane copy/,
    'the single TCR copy attempt must be bounded to 7800 seconds'
  )
  assert.doesNotMatch(
    mirrorRun,
    /COPY_ATTEMPTS|while \(\(attempt/,
    'crane cannot resume an interrupted copy; retries must not restart from zero'
  )
  assert.doesNotMatch(
    mirrorWorkflow,
    /--verbose/,
    'mirror must not run crane in verbose mode'
  )
  assert.match(
    mirrorRun,
    /copy_log"\s*2>&1 \|\| status=\$\?/,
    'crane output must be captured, never streamed to the workflow log'
  )
  assert.doesNotMatch(
    mirrorRun,
    /cat "\$copy_log"|sed -E|grep -viE/,
    'captured crane output must never be printed'
  )
  assert.match(
    mirrorRun,
    /TCR mirror is still running\./,
    'the long copy must only emit a fixed safe heartbeat'
  )
  assert.match(mirrorRun, /sleep 300/)
  assert.match(
    mirrorRun,
    /trap cleanup EXIT INT TERM/,
    'temp files and the heartbeat process must be cleaned up on any exit'
  )
  assert.match(mirrorRun, /rm -f "\$copy_log"/)
  assert.match(mirrorRun, /kill "\$heartbeat_pid"/)
  assert.match(
    mirrorRun,
    /TCR mirror copy failed with exit code %s\./,
    'a failed copy must only report the exit code'
  )
  assert.match(mirrorRun, /TCR mirror copy succeeded\./)
  assert.doesNotMatch(
    mirrorRun,
    /TCR_USERNAME|TCR_PASSWORD/,
    'copy step logs must not expose credentials'
  )
  assert.ok(
    mirrorRun.indexOf('crane copy') < mirrorRun.indexOf('tcr_image_digest=%s'),
    'a failed copy must exit before any tcr_image_digest output is produced'
  )
  assert.match(
    mirrorRun,
    /\/tmp\/crane digest "\$TCR_REF"/,
    'TCR digest must be queried independently after the copy'
  )
  assert.match(
    mirrorRun,
    /\[\[ ! "\$TCR_DIGEST" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/,
    'TCR digest must be format-validated as reported by TCR'
  )
  assert.match(
    mirrorRun,
    /"\$TCR_DIGEST" != "\$GHCR_DIGEST"/,
    'TCR digest must be identical to the mirrored GHCR digest'
  )
  assert.match(mirrorRun, /printf 'tcr_image_digest=%s\\n' "\$TCR_DIGEST"/)
  const mirrorCopyWorstSeconds = 7800 + 10
  assert.ok(
    mirrorCopyWorstSeconds <= 150 * 60 - 600,
    `bounded single TCR copy (${mirrorCopyWorstSeconds}s) must leave at least 600s of job budget`
  )

  const recordRun = multilineStepRun(namedStep(mirrorJob, 'Write release record'))
  assert.match(recordRun, /--argjson schema_version 1/)
  assert.match(recordRun, /--arg commit_sha "\$COMMIT_SHA"/)
  assert.match(recordRun, /--arg ghcr_digest "\$GHCR_DIGEST"/)
  assert.match(recordRun, /--arg tcr_digest "\$TCR_DIGEST"/)
  assert.match(
    recordRun,
    /--arg tcr_repository 'ccr\.ccs\.tencentyun\.com\/website-dev\/kinvest'/,
    'release record must pin the exact TCR repository'
  )
  assert.match(recordRun, /--arg mirror_run_id "\$MIRROR_RUN_ID"/)
  assert.match(recordRun, /--arg mirror_run_attempt "\$MIRROR_RUN_ATTEMPT"/)
  assert.doesNotMatch(
    recordRun,
    /\$\{\{\s*secrets\.|TCR_PASSWORD|token|signature/,
    'release record must not contain credentials, tokens or URL signatures'
  )
  const uploadStep = namedStep(mirrorJob, 'Upload release record')
  assert.match(
    uploadStep,
    /uses: actions\/upload-artifact@[0-9a-f]{40}/,
    'release record upload must use a full-SHA pinned official action'
  )
  assert.match(
    uploadStep,
    /name: kinvest-release-record-\$\{\{ github\.run_id \}\}/,
    'release record artifact name must contain the mirror run id'
  )
  assert.match(uploadStep, /path: release-record\.json/)
  assert.match(uploadStep, /retention-days: 30/)

  const productionEvents = workflowBlock(productionWorkflow, 'on', 0)
  assert.deepEqual(
    directMappingKeys(productionEvents, 2),
    ['workflow_dispatch'],
    'production deploy must only be triggered manually'
  )
  const productionDispatch = workflowBlock(productionEvents, 'workflow_dispatch', 2)
  const productionInputs = workflowBlock(productionDispatch, 'inputs', 4)
  assert.deepEqual(
    directMappingKeys(productionInputs, 6).sort(),
    ['confirm', 'mirror_run_id'],
    'deploy must only accept a mirror run id, never a manual commit/digest pair'
  )
  for (const inputName of ['confirm', 'mirror_run_id']) {
    const input = workflowBlock(productionInputs, inputName, 6)
    assert.equal(directScalar(input, 'required', 8), 'true')
  }
  const productionJobs = workflowBlock(productionWorkflow, 'jobs', 0)
  assert.deepEqual(directMappingKeys(productionJobs, 2).sort(), ['deploy', 'validate'])

  const productionValidateJob = workflowBlock(productionJobs, 'validate', 2)
  assert.equal(
    directMappingKeys(productionValidateJob, 4).includes('environment'),
    false,
    'release record validation must complete before entering the Production environment'
  )
  const productionValidatePerms = workflowBlock(productionValidateJob, 'permissions', 4)
  assert.deepEqual(directMappingKeys(productionValidatePerms, 6).sort(), [
    'actions',
    'contents'
  ])
  assert.equal(directScalar(productionValidatePerms, 'contents', 6), 'read')
  assert.equal(directScalar(productionValidatePerms, 'actions', 6), 'read')
  assert.match(
    productionValidateJob,
    /commit_sha: \$\{\{ steps\.record\.outputs\.commit_sha \}\}/,
    'validate must expose the verified commit sha as a job output'
  )
  assert.match(
    productionValidateJob,
    /tcr_digest: \$\{\{ steps\.record\.outputs\.tcr_digest \}\}/,
    'validate must expose the verified TCR digest as a job output'
  )
  assert.doesNotMatch(
    productionValidateJob,
    /\$\{\{\s*secrets\.(TCR_|DEPLOY_)/,
    'release record validation must not access registry or deploy credentials'
  )

  const deployValidateRun = multilineStepRun(
    namedStep(productionValidateJob, 'Validate deploy inputs')
  )
  assert.match(
    deployValidateRun,
    /"\$WORKFLOW_REF" != 'refs\/heads\/main'/,
    'deploy workflow must reject runs from non-main refs'
  )
  assert.match(
    deployValidateRun,
    /"\$DEPLOY_ENABLED" != 'true'/,
    'manual deploy must refuse to run while DEPLOY_ENABLED is not true'
  )
  assert.match(deployValidateRun, /refusing to deploy/)
  assert.match(deployValidateRun, /"\$CONFIRM" != 'DEPLOY'/)
  assert.match(
    deployValidateRun,
    /\[\[ ! "\$MIRROR_RUN_ID" =~ \^\[0-9\]\+\$ \]\]/,
    'mirror_run_id must be validated as numeric'
  )

  const provenanceRun = multilineStepRun(
    namedStep(productionValidateJob, 'Verify mirror run provenance')
  )
  assert.match(
    provenanceRun,
    /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{MIRROR_RUN_ID\}"/,
    'the mirror run must be queried within this repository'
  )
  assert.match(
    provenanceRun,
    /"\$run_path" != '\.github\/workflows\/mirror-tcr-manual\.yml'/,
    'the run must come from mirror-tcr-manual.yml'
  )
  assert.match(
    provenanceRun,
    /"\$run_event" != 'workflow_dispatch'/,
    'the mirror run must be a manual dispatch'
  )
  assert.match(
    provenanceRun,
    /"\$run_head_branch" != 'main'/,
    'the mirror run must have run on main'
  )
  assert.match(
    provenanceRun,
    /"\$run_conclusion" != 'success'/,
    'only a successful mirror run may be deployed'
  )
  assert.match(
    provenanceRun,
    /expected_name="kinvest-release-record-\$\{MIRROR_RUN_ID\}"/,
    'the release record artifact name must bind to the mirror run id'
  )
  assert.match(
    provenanceRun,
    /"\$artifact_count" != '1'/,
    'the mirror run must contain exactly one release record artifact'
  )
  assert.match(provenanceRun, /"\$artifact_name" != "\$expected_name"/)

  const recordValidateRun = multilineStepRun(
    namedStep(productionValidateJob, 'Download and validate release record')
  )
  assert.match(
    recordValidateRun,
    /gh run download "\$MIRROR_RUN_ID"/,
    'the release record must be downloaded from the verified mirror run'
  )
  assert.match(recordValidateRun, /--name "kinvest-release-record-\$\{MIRROR_RUN_ID\}"/)
  assert.match(
    recordValidateRun,
    /"\$schema_version" != '1'/,
    'release record schema_version must be enforced'
  )
  assert.match(
    recordValidateRun,
    /"\$record_run_id" != "\$MIRROR_RUN_ID"/,
    'release record must belong to the requested mirror run'
  )
  assert.match(
    recordValidateRun,
    /"\$tcr_repository" != 'ccr\.ccs\.tencentyun\.com\/website-dev\/kinvest'/,
    'release record repository must be pinned to the exact TCR repository'
  )
  assert.match(recordValidateRun, /\[\[ ! "\$commit_sha" =~ \^\[0-9a-f\]\{40\}\$ \]\]/)
  assert.match(recordValidateRun, /\[\[ ! "\$ghcr_digest" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/)
  assert.match(recordValidateRun, /\[\[ ! "\$tcr_digest" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/)
  assert.match(
    recordValidateRun,
    /"\$tcr_digest" != "\$ghcr_digest"/,
    'release record must keep the constraint that tcr_digest equals the verified ghcr_digest'
  )
  assert.match(
    recordValidateRun,
    /git merge-base --is-ancestor "\$commit_sha" origin\/main/,
    'release record commit must belong to main history'
  )
  assert.match(recordValidateRun, /printf 'commit_sha=%s\\n' "\$commit_sha"/)
  assert.match(recordValidateRun, /printf 'tcr_digest=%s\\n' "\$tcr_digest"/)

  const productionDeployJob = workflowBlock(productionJobs, 'deploy', 2)
  assert.equal(
    directScalar(productionDeployJob, 'needs', 4),
    'validate',
    'the Production environment must only be entered after validation succeeds'
  )
  assert.equal(directScalar(productionDeployJob, 'environment', 4), 'Production')
  assert.equal(directScalar(productionDeployJob, 'timeout-minutes', 4), '40')
  assert.match(productionDeployJob, /\$\{\{\s*secrets\.DEPLOY_SSH_KEY\s*\}\}/)
  assert.match(productionDeployJob, /\$\{\{\s*secrets\.DEPLOY_KNOWN_HOSTS\s*\}\}/)
  assert.match(
    productionDeployJob,
    /IMAGE_DIGEST: \$\{\{ needs\.validate\.outputs\.tcr_digest \}\}/,
    'deploy must consume only the validated TCR digest output'
  )
  assert.match(
    productionDeployJob,
    /DEPLOY_SHA: \$\{\{ needs\.validate\.outputs\.commit_sha \}\}/,
    'deploy must consume only the validated commit sha output'
  )
  assert.doesNotMatch(
    productionWorkflow,
    /inputs\.(commit_sha|tcr_digest)/,
    'deploy must not consume manually entered commit or digest values'
  )
  assert.match(productionDeployJob, /IMAGE_REPOSITORY='ccr\.ccs\.tencentyun\.com\/website-dev\/kinvest'/)
  assert.match(
    productionDeployJob,
    /\^ccr\\\.ccs\\\.tencentyun\\\.com\/website-dev\/kinvest@sha256:\[0-9a-f\]\{64\}\$/,
    'deploy must validate the exact TCR digest reference before SSH'
  )
  assert.doesNotMatch(productionWorkflow, /ghcr\.io\/zwphhxx\/kinvest@/)
  assert.doesNotMatch(productionWorkflow, /:latest\b/)
  assert.doesNotMatch(
    productionWorkflow,
    /\$\{\{\s*secrets\.TCR_(USERNAME|PASSWORD)\s*\}\}/,
    'production deploy must not reference TCR credentials'
  )
  assert.doesNotMatch(
    mirrorWorkflow,
    /\$\{\{\s*secrets\.DEPLOY_/,
    'TCR mirroring must not reference deploy credentials'
  )
  for (const workflowSource of [workflow, mirrorWorkflow, productionWorkflow]) {
    assert.doesNotMatch(
      workflowSource,
      /docker login /,
      'registry authentication must use the pinned login action, never inline credentials'
    )
    assert.doesNotMatch(
      workflowSource,
      /config\.json|DOCKER_CONFIG/,
      'workflows must never read or print docker client configuration'
    )
    const usesLines = workflowSource.match(/^\s+uses:\s+\S+\s*$/gm) || []
    assert.ok(usesLines.length > 0)
    for (const usesLine of usesLines) {
      const action = usesLine.trim().match(/^uses:\s+([^@\s]+)@([^\s]+)$/)
      assert.ok(action, `Action reference must include a commit SHA: ${usesLine.trim()}`)
      assert.match(action[2], /^[0-9a-f]{40}$/, `${action[1]} must use a full commit SHA`)
    }
  }

  for (const relativePath of [
    'deploy/server/deploy-kinvest.sh',
    'deploy/server/bootstrap-server.sh',
    'deploy/server/kinvest-ssh-command'
  ]) {
    assert.equal(fs.statSync(rootPath(relativePath)).mode & 0o111, 0o111)
  }

  assert.match(workflow, /^ {2}group: kinvest-ci$/m)
  assert.match(workflow, /^ {2}cancel-in-progress: false$/m)
  assert.match(
    productionWorkflow,
    /^ {2}group: kinvest-production$/m,
    'manual production deploy must keep the production concurrency group'
  )
  assert.match(productionWorkflow, /^ {2}cancel-in-progress: false$/m)
  assert.equal((workflow.match(/timeout-minutes:/g) || []).length, 4)
  const publishTimeoutMatch = workflow.match(
    /^ {2}publish:\n[\s\S]*?^ {4}timeout-minutes: ([0-9]+)$/m
  )
  assert.ok(publishTimeoutMatch, 'publish job must define a bounded timeout')
  const publishTimeoutMinutes = Number.parseInt(publishTimeoutMatch[1], 10)
  assert.equal(publishTimeoutMinutes, 30)
  assert.match(workflow, /docker\/build-push-action@[0-9a-f]{40}/)
  assert.match(workflow, /docker\/login-action@[0-9a-f]{40}/)
  assert.match(workflow, /docker\/setup-buildx-action@[0-9a-f]{40}/)
  assert.match(workflow, /BUILD_DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/)
  assert.match(workflow, /ghcr\.io\/zwphhxx\/kinvest/)
  assert.doesNotMatch(workflow, /github\.repository_owner/)
  assert.doesNotMatch(workflow, /:latest\b/)
  assert.match(productionWorkflow, /ConnectTimeout=10/)
  assert.match(productionWorkflow, /ServerAliveInterval=15/)
  assert.match(productionWorkflow, /ServerAliveCountMax=2/)
  assert.match(productionWorkflow, /StrictHostKeyChecking=yes/)
  assert.match(productionWorkflow, /"deploy \$IMAGE_DIGEST_REF \$DEPLOY_SHA"/)
  assert.match(
    productionWorkflow,
    /rm -f "\$HOME\/\.ssh\/id_ed25519" "\$HOME\/\.ssh\/known_hosts"/,
    'ephemeral SSH material must always be removed'
  )
  assert.doesNotMatch(productionWorkflow, /sudo \/usr\/local\/sbin\/deploy-kinvest/)

  assert.match(deploy, /^ALLOWED_REPOSITORY='ccr\.ccs\.tencentyun\.com\/website-dev\/kinvest'$/m)
  assert.match(
    deploy,
    /^ALLOWED_DEPLOYMENT_DIGEST_PATTERN='\^ccr\\\.ccs\\\.tencentyun\\\.com\/website-dev\/kinvest@sha256:\[0-9a-f\]\{64\}\$'$/m,
    'new deployments must only accept the exact TCR repository'
  )
  assert.match(
    deploy,
    /^ALLOWED_STATE_DIGEST_PATTERN='\^\(ccr\\\.ccs\\\.tencentyun\\\.com\/website-dev\/kinvest\|ghcr\\\.io\/zwphhxx\/kinvest\)@sha256:\[0-9a-f\]\{64\}\$'$/m,
    'historical state must accept both GHCR and TCR repositories for migration'
  )
  assert.match(deploy, /digest_ref" =~ \$ALLOWED_DEPLOYMENT_DIGEST_PATTERN/)
  assert.match(deploy, /\[\[ "\$1" =~ \$ALLOWED_STATE_DIGEST_PATTERN \]\]/)
  assert.match(deploy, /^CURRENT_STATE="\$STATE\/current\.state"$/m)
  assert.match(deploy, /^PREVIOUS_STATE="\$STATE\/previous\.state"$/m)
  assert.match(deploy, /^PULL_ATTEMPTS='3'$/m)
  assert.match(deploy, /^PULL_TIMEOUT='300s'$/m)
  assert.match(deploy, /^PULL_RETRY_BASE_WAIT_SECONDS='2'$/m)
  assert.match(deploy, /^DOCKER_TIMEOUT='120s'$/m)
  assert.match(deploy, /^COMPOSE_TIMEOUT='120s'$/m)
  assert.match(deploy, /^INSPECT_TIMEOUT='15s'$/m)
  assert.match(deploy, /^HEALTH_TIMEOUT_SECONDS='120'$/m)
  assert.match(deploy, /digest_ref=%s\\ncommit=%s/)
  assert.match(deploy, /timeout --signal=TERM/)
  assert.match(deploy, /--kill-after=/)
  const runPullBody = deploy.match(/^run_pull\(\) \{([\s\S]*?)^\}$/m)
  const runDockerBody = deploy.match(/^run_docker\(\) \{([\s\S]*?)^\}$/m)
  const pullWithRetriesBody = deploy.match(/^pull_with_retries\(\) \{([\s\S]*?)^\}$/m)
  const pullTransientBody = deploy.match(/^pull_failure_is_transient\(\) \{([\s\S]*?)^\}$/m)
  assert.ok(runPullBody, 'deployment must define a dedicated pull wrapper')
  assert.ok(runDockerBody, 'deployment must retain a bounded general Docker wrapper')
  assert.ok(pullWithRetriesBody, 'deployment must define a bounded pull retry wrapper')
  assert.ok(pullTransientBody, 'deployment must classify transient pull failures explicitly')
  assert.match(runPullBody[1], /\$PULL_TIMEOUT/)
  assert.match(runPullBody[1], /docker pull "\$1"/)
  assert.match(runDockerBody[1], /\$DOCKER_TIMEOUT/)
  assert.doesNotMatch(runDockerBody[1], /pull/)
  assert.match(pullWithRetriesBody[1], /run_pull "\$ref"/)
  assert.match(pullWithRetriesBody[1], /while \(\(attempt <= PULL_ATTEMPTS\)\)/)
  assert.match(pullWithRetriesBody[1], /pull_failure_is_transient "\$status" "\$stderr_file"/)
  assert.match(pullWithRetriesBody[1], /sleep "\$wait_seconds"/)
  assert.match(pullWithRetriesBody[1], /wait_seconds=\$\(\(wait_seconds \* 2\)\)/)
  assert.match(
    pullWithRetriesBody[1],
    /pull attempt %s of %s failed with exit code %s/,
    'retry log lines must contain only attempt number and exit code'
  )
  assert.doesNotMatch(
    pullWithRetriesBody[1],
    /\bcat\b|\btee\b/,
    'captured pull stderr must never be written to the deployment log'
  )
  assert.match(pullTransientBody[1], /status == 124/)
  assert.match(pullTransientBody[1], /grep -Eqi/)
  assert.match(deploy, /run_docker network inspect web/)
  assert.match(deploy, /run_docker rm -f kinvest/)
  assert.doesNotMatch(deploy, /run_docker pull/)
  assert.match(deploy, /pull_with_retries "\$digest_ref"/)
  assert.doesNotMatch(deploy, /run_pull "\$digest_ref"/)
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
  const pullAttempts = plainSeconds('PULL_ATTEMPTS')
  const pullRetryBaseWaitSeconds = plainSeconds('PULL_RETRY_BASE_WAIT_SECONDS')
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
  const pullRetryWaitsSeconds =
    pullRetryBaseWaitSeconds * (2 ** (pullAttempts - 1) - 1)
  const candidatePullSeconds =
    pullAttempts * (pullSeconds + dockerKillSeconds) + pullRetryWaitsSeconds
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
  const productionDeployTimeoutMatch = productionWorkflow.match(
    /^ {2}deploy:\n[\s\S]*?^ {4}timeout-minutes: ([0-9]+)$/m
  )
  assert.ok(productionDeployTimeoutMatch, 'manual deploy job must define a bounded timeout')
  const deployTimeoutMinutes = Number.parseInt(productionDeployTimeoutMatch[1], 10)
  assert.equal(deployTimeoutMinutes, 40)
  const deployJobSeconds = deployTimeoutMinutes * 60
  assert.ok(
    cumulativeDeploySeconds <= deployJobSeconds - 180,
    `worst-case ${cumulativeDeploySeconds}s deployment must leave at least 180s in the job`
  )

  assert.match(wrapper, /^ALLOWED_REPOSITORY='ccr\.ccs\.tencentyun\.com\/website-dev\/kinvest'$/m)
  assert.match(
    wrapper,
    /\^ccr\\\.ccs\\\.tencentyun\\\.com\/website-dev\/kinvest@sha256:\[0-9a-f\]\{64\}\$/,
    'SSH entrypoint must only accept the exact TCR digest'
  )
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
    /immutable Kinvest TCR digest reference/
  )
  assertRejectedInput(
    `${ghcrRepository}@${candidateDigest}\n${candidateCommit}\n`,
    /immutable Kinvest TCR digest reference/,
    'legacy GHCR references must not be accepted as new deployments'
  )
  assertRejectedInput(
    `${tcrRepository}:release\n${candidateCommit}\n`,
    /immutable Kinvest TCR digest reference/
  )
  assertRejectedInput(
    `${tcrRepository}:latest\n${candidateCommit}\n`,
    /immutable Kinvest TCR digest reference/,
    'mutable tags must never be deployed'
  )
  assertRejectedInput(
    `${tcrRepository}@sha256:abcd\n${candidateCommit}\n`,
    /immutable Kinvest TCR digest reference/
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
      `digest_ref=${candidateRef}\ncommit=${candidateCommit}\n`,
      'successful TCR deployment must write the TCR digest to current.state'
    )
    assert.equal(
      fs.readFileSync(path.join(success.stateDir, 'previous.state'), 'utf8'),
      `digest_ref=${previousRef}\ncommit=${previousCommit}\n`,
      'legacy GHCR previous state must remain readable for verified rollback'
    )
    assert.deepEqual(
      readPullAttempts(success),
      [candidateRef],
      'first-attempt pull success must not trigger a retry'
    )
    const timeoutLog = fs.readFileSync(path.join(success.fakeState, 'timeout.log'), 'utf8')
    assert.match(timeoutLog, /--signal=TERM --kill-after=10s 300s docker pull/)
    assert.match(timeoutLog, /--signal=TERM --kill-after=10s 120s docker network inspect/)
    assert.match(timeoutLog, /--signal=TERM --kill-after=10s 120s env .*docker compose/)
    assert.match(timeoutLog, /--signal=TERM --kill-after=5s 15s docker image inspect/)
    assert.match(timeoutLog, /--signal=TERM --kill-after=5s 15s docker inspect/)
    assert.doesNotMatch(timeoutLog, /300s docker (?!pull)/)
    assert.match(timeoutLog, /--kill-after=/)
  } finally {
    success.cleanup()
  }

  const transientRetrySuccess = runDeployFixture(['candidate-pull-transient-remaining:1'])
  try {
    const diagnostics = deployFixtureDiagnostics(transientRetrySuccess)
    assert.equal(transientRetrySuccess.result.status, 0, diagnostics)
    assert.deepEqual(
      readPullAttempts(transientRetrySuccess),
      [candidateRef, candidateRef],
      'one transient pull failure must be retried exactly once before success'
    )
    assert.equal(
      fs.readFileSync(path.join(transientRetrySuccess.stateDir, 'current.state'), 'utf8'),
      `digest_ref=${candidateRef}\ncommit=${candidateCommit}\n`
    )
    assert.match(
      transientRetrySuccess.result.stderr,
      /pull attempt 1 of 3 failed with exit code 1\./
    )
    assert.match(
      transientRetrySuccess.result.stderr,
      /pull attempt 2 of 3 succeeded\./
    )
    assert.doesNotMatch(
      transientRetrySuccess.result.stderr,
      /dial tcp|i\/o timeout/,
      'raw pull stderr must not leak into the deployment log'
    )
  } finally {
    transientRetrySuccess.cleanup()
  }

  const timeoutRetrySuccess = runDeployFixture(['candidate-pull-timeout-once'])
  try {
    const diagnostics = deployFixtureDiagnostics(timeoutRetrySuccess)
    assert.equal(timeoutRetrySuccess.result.status, 0, diagnostics)
    assert.deepEqual(readPullAttempts(timeoutRetrySuccess), [candidateRef, candidateRef])
    assert.match(
      timeoutRetrySuccess.result.stderr,
      /pull attempt 1 of 3 failed with exit code 124\./
    )
    assert.match(timeoutRetrySuccess.result.stderr, /pull attempt 2 of 3 succeeded\./)
  } finally {
    timeoutRetrySuccess.cleanup()
  }

  const allPullAttemptsFail = runDeployFixture(['candidate-pull-transient-remaining:3'])
  try {
    const diagnostics = deployFixtureDiagnostics(allPullAttemptsFail)
    assert.notEqual(allPullAttemptsFail.result.status, 0, diagnostics)
    assert.deepEqual(
      readPullAttempts(allPullAttemptsFail),
      [candidateRef, candidateRef, candidateRef],
      'pull retries must stop after the bounded attempt budget'
    )
    const pullTimeoutCalls = fs
      .readFileSync(path.join(allPullAttemptsFail.fakeState, 'timeout.log'), 'utf8')
      .split('\n')
      .filter((line) => /300s docker pull/.test(line))
    assert.equal(pullTimeoutCalls.length, 3, 'each pull attempt must keep the 300s bound')
    assert.equal(
      fs.readFileSync(path.join(allPullAttemptsFail.fakeState, 'running.ref'), 'utf8').trim(),
      previousRef
    )
    assert.equal(
      fs.readFileSync(path.join(allPullAttemptsFail.stateDir, 'current.state'), 'utf8'),
      `digest_ref=${previousRef}\ncommit=${previousCommit}\n`,
      'failed deployment must not replace current.state'
    )
    assert.equal(fs.existsSync(path.join(allPullAttemptsFail.fakeState, 'removed')), false)
    assert.match(allPullAttemptsFail.result.stderr, /pull failed after 3 attempts\./)
    assert.match(allPullAttemptsFail.result.stderr, /部署失败但previous继续服务/)
    assert.doesNotMatch(allPullAttemptsFail.result.stderr, /dial tcp|i\/o timeout/)
  } finally {
    allPullAttemptsFail.cleanup()
  }

  const permanentPullFailure = runDeployFixture(['candidate-pull-permanent-error'])
  try {
    const diagnostics = deployFixtureDiagnostics(permanentPullFailure)
    assert.notEqual(permanentPullFailure.result.status, 0, diagnostics)
    assert.deepEqual(
      readPullAttempts(permanentPullFailure),
      [candidateRef],
      'permanent pull failures must not be retried'
    )
    assert.equal(
      fs.readFileSync(path.join(permanentPullFailure.fakeState, 'running.ref'), 'utf8').trim(),
      previousRef
    )
    assert.match(permanentPullFailure.result.stderr, /non-retryable error \(exit code 1\)/)
    assert.match(permanentPullFailure.result.stderr, /部署失败但previous继续服务/)
    assert.doesNotMatch(
      permanentPullFailure.result.stderr,
      /manifest unknown/,
      'raw registry errors must not leak into the deployment log'
    )
  } finally {
    permanentPullFailure.cleanup()
  }

  const unclassifiedPullFailure = runDeployFixture(['fail-candidate-pull'])
  try {
    assert.deepEqual(
      readPullAttempts(unclassifiedPullFailure),
      [candidateRef],
      'unclassified pull failures must not be retried'
    )
  } finally {
    unclassifiedPullFailure.cleanup()
  }

  for (const source of [workflow, deploy, bootstrap, wrapper]) {
    assert.doesNotMatch(
      source,
      /(?:refresh_token|api[_-]?key|BEGIN [A-Z ]*PRIVATE KEY|106\.54\.229\.241)/i
    )
  }

  for (const source of [deploy, bootstrap, wrapper]) {
    assert.doesNotMatch(
      source,
      /TCR_(USERNAME|PASSWORD)/,
      'server-side scripts must never reference CI registry credentials'
    )
  }
}

module.exports = { run }
