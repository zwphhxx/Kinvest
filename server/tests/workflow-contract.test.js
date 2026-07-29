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
  fs.writeFileSync(filePath, source, { mode: 0o755 })
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
if [ "\${1:-}" = "--signal=TERM" ]; then
  shift 2
else
  shift
fi
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

case "$command_name" in
  network)
    [ "\${1:-}" = 'inspect' ] && [ "\${2:-}" = 'web' ]
    ;;
  pull)
    ref="\${1:-}"
    if [[ -f "$state/fail-old-pull" && "$ref" == "$OLD_REF" ]]; then
      exit 31
    fi
    printf '%s\\n' "$ref" >> "$state/pulls.log"
    ;;
  image)
    [ "\${1:-}" = 'inspect' ]
    ref="\${4:-}"
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
    if [[ -f "$state/fail-old-compose" && "$ref" == "$OLD_REF" ]]; then
      exit 33
    fi
    if [[ -f "$state/candidate-mismatch" && "$ref" == "$CANDIDATE_REF" ]]; then
      printf '%s\\n' "$OLD_REF" > "$state/running.ref"
      image_id "$OLD_REF" > "$state/running.id"
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
  writeExecutable(path.join(serverRoot, 'prepare-data-dir.sh'), '#!/bin/sh\\nexit 0\\n')

  if (withPrevious) {
    fs.writeFileSync(
      path.join(stateDir, 'current.state'),
      `digest_ref=${previousRef}\ncommit=${previousCommit}\n`,
      { mode: 0o600 }
    )
  }

  for (const marker of markers) {
    fs.writeFileSync(path.join(fakeState, marker), '')
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
  assert.match(deploy, /digest_ref=%s\\ncommit=%s/)
  assert.match(deploy, /timeout --signal=TERM/)
  assert.match(deploy, /verify_running_image/)
  assert.match(deploy, /\.Config\.Image/)
  assert.match(deploy, /run_inspect image inspect/)
  assert.match(deploy, /actual_image_id/)
  assert.match(deploy, /expected_image_id/)
  assert.doesNotMatch(deploy, /set \+e/)
  assert.doesNotMatch(deploy, /:latest\b/)

  assert.match(wrapper, /^ALLOWED_REPOSITORY='ghcr\.io\/zwphhxx\/kinvest'$/m)
  assert.match(wrapper, /SSH_ORIGINAL_COMMAND/)
  assert.match(wrapper, /expected_command="deploy \$digest_ref \$commit_sha"/)
  assert.match(wrapper, /sudo -n \/usr\/local\/sbin\/deploy-kinvest/)
  assert.doesNotMatch(wrapper, /eval|docker/)

  assert.match(bootstrap, /kinvest-ssh-command/)
  assert.match(
    bootstrap,
    /install -o root -g root -m 0755 -- "\$TARGET\/kinvest-ssh-command" \/usr\/local\/sbin\/kinvest-ssh-command/
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
  assert.doesNotMatch(bootstrap, /usermod[^\n]*docker|gpasswd[^\n]*docker|docker group/i)
  assert.doesNotMatch(bootstrap, /ssh-(?:ed25519|rsa) [A-Za-z0-9+/]{40,}/)

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
    assert.notEqual(mismatch.result.status, 0)
    assert.ok(fs.existsSync(path.join(mismatch.fakeState, 'removed')))
    assert.match(mismatch.result.stderr, /running image does not match/)
    assert.match(mismatch.result.stderr, /manual intervention is required/i)
  } finally {
    mismatch.cleanup()
  }

  const pullFailure = runDeployFixture(['candidate-mismatch', 'fail-old-pull'])
  try {
    assert.notEqual(pullFailure.result.status, 0)
    assert.ok(fs.existsSync(path.join(pullFailure.fakeState, 'removed')))
    assert.match(pullFailure.result.stderr, /previous digest pull failed/i)
    assert.match(pullFailure.result.stderr, /manual intervention is required/i)
    assert.doesNotMatch(pullFailure.result.stderr, /was restored/)
  } finally {
    pullFailure.cleanup()
  }

  const composeFailure = runDeployFixture(['candidate-mismatch', 'fail-old-compose'])
  try {
    assert.notEqual(composeFailure.result.status, 0)
    assert.ok(fs.existsSync(path.join(composeFailure.fakeState, 'removed')))
    assert.match(composeFailure.result.stderr, /previous release compose failed/i)
    assert.match(composeFailure.result.stderr, /manual intervention is required/i)
    assert.doesNotMatch(composeFailure.result.stderr, /was restored/)
  } finally {
    composeFailure.cleanup()
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
    assert.match(timeoutLog, /docker pull/)
    assert.match(timeoutLog, /docker compose/)
    assert.match(timeoutLog, /docker image inspect/)
    assert.match(timeoutLog, /docker inspect/)
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
