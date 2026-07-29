const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '../..')

function rootPath(relativePath) {
  return path.join(rootDir, relativePath)
}

function readRootFile(relativePath) {
  return fs.readFileSync(rootPath(relativePath), 'utf8')
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
      const key = content.match(/^([^:]+):/)[1].replace(/^['"]|['"]$/g, '')
      rootKeys.push(key)
    }

    if (/[|>][-+]?\s*$/.test(content)) {
      scalarIndent = indent
    }
  }

  assert.deepEqual(rootKeys, ['name', 'on', 'permissions', 'concurrency', 'jobs'])
}

function assertExecutable(relativePath) {
  assert.equal(
    fs.statSync(rootPath(relativePath)).mode & 0o111,
    0o111,
    `${relativePath} must be executable`
  )
}

function run() {
  const workflow = readRootFile('.github/workflows/deploy.yml')
  const deploy = readRootFile('deploy/server/deploy-kinvest.sh')
  const bootstrap = readRootFile('deploy/server/bootstrap-server.sh')
  const deployPath = rootPath('deploy/server/deploy-kinvest.sh')

  assertBasicWorkflowYaml(workflow)
  assertExecutable('deploy/server/deploy-kinvest.sh')
  assertExecutable('deploy/server/bootstrap-server.sh')

  assert.match(workflow, /^on:\n {2}push:\n {4}branches:\n {6}- main$/m)
  assert.match(workflow, /^ {2}workflow_dispatch:$/m)
  assert.match(workflow, /^ {2}contents: read$/m)
  assert.match(workflow, /^ {2}group: kinvest-production$/m)
  assert.match(workflow, /^ {2}cancel-in-progress: false$/m)
  assert.match(workflow, /uses: actions\/checkout@[0-9a-f]{40}$/m)
  assert.match(workflow, /uses: actions\/setup-node@[0-9a-f]{40}$/m)
  assert.match(workflow, /node-version: "22\.13\.0"/)
  assert.match(workflow, /npm ci/)
  assert.match(workflow, /npm run check/)
  assert.match(workflow, /^ {6}packages: write$/m)
  assert.match(workflow, /ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/kinvest/)
  assert.match(workflow, /docker build --pull --tag "\$IMAGE_REF" \./)
  assert.match(workflow, /docker push "\$IMAGE_REF"/)
  assert.match(workflow, /\$\{\{ github\.sha \}\}/)
  assert.doesNotMatch(workflow, /:latest\b/)

  assert.match(workflow, /^ {4}if: \$\{\{ vars\.DEPLOY_ENABLED == 'true' \}\}$/m)
  assert.match(workflow, /^ {4}environment: Production$/m)
  assert.match(workflow, /DEPLOY_KNOWN_HOSTS: \$\{\{ secrets\.DEPLOY_KNOWN_HOSTS \}\}/)
  assert.match(workflow, /DEPLOY_KEY: \$\{\{ secrets\.DEPLOY_SSH_KEY \}\}/)
  assert.match(workflow, /StrictHostKeyChecking=yes/)
  assert.match(workflow, /UserKnownHostsFile=/)
  assert.match(workflow, /BatchMode=yes/)
  assert.match(workflow, /sudo \/usr\/local\/sbin\/deploy-kinvest/)
  assert.match(workflow, /DEPLOY_SHA: \$\{\{ github\.sha \}\}/)
  assert.match(workflow, /DEPLOY_HOST: \$\{\{ vars\.DEPLOY_HOST \}\}/)
  assert.match(workflow, /DEPLOY_PORT: \$\{\{ vars\.DEPLOY_PORT \}\}/)
  assert.match(workflow, /DEPLOY_USER: \$\{\{ vars\.DEPLOY_USER \}\}/)
  assert.doesNotMatch(workflow, /StrictHostKeyChecking=no/)
  assert.doesNotMatch(workflow, /(?:106\.54\.229\.241|4334|BEGIN [A-Z ]*PRIVATE KEY)/)
  assert.doesNotMatch(workflow, /(?:echo|printf)[^\n]*(?:DEPLOY_KEY|DEPLOY_KNOWN_HOSTS)[^>|\n]*$/m)

  assert.match(deploy, /^ROOT='\/root\/docker\/kinvest'$/m)
  assert.match(deploy, /\^\[0-9a-f\]\{40\}\$/)
  assert.match(deploy, /\^ghcr\\\.io\//)
  assert.match(deploy, /candidate_ref="\$\{image\}:\$\{sha\}"/)
  assert.match(deploy, /docker network inspect web/)
  assert.doesNotMatch(deploy, /docker network create/)
  assert.match(deploy, /"\$ROOT\/prepare-data-dir\.sh"/)
  assert.match(deploy, /docker pull "\$candidate_ref"/)
  assert.match(deploy, /KINVEST_IMAGE="\$candidate_ref" docker compose/)
  assert.match(deploy, /docker inspect --format/)
  assert.match(deploy, /\.State\.Health\.Status/)
  assert.match(deploy, /sleep "\$HEALTH_INTERVAL"/)
  assert.match(deploy, /expected_image_id/)
  assert.match(deploy, /actual_image_id/)
  assert.match(deploy, /rollback/)
  assert.match(deploy, /trap 'rollback \$\?' ERR/)
  assert.match(deploy, /previous\.ref/)
  assert.match(deploy, /current\.ref/)
  assert.match(deploy, /docker rm -f kinvest/)
  assert.doesNotMatch(deploy, /docker compose\b[^\n]*\bdown\b/)
  assert.doesNotMatch(deploy, /(?:nginx|\/etc\/kinvest|\/opt\/kinvest|\.env|:latest\b)/i)

  const invalidSha = spawnSync(deployPath, ['ghcr.io/example/kinvest', 'latest'], {
    encoding: 'utf8'
  })
  assert.equal(invalidSha.status, 2)
  assert.match(invalidSha.stderr, /40-character lowercase commit SHA/)

  const invalidImage = spawnSync(deployPath, ['docker.io/example/kinvest', 'a'.repeat(40)], {
    encoding: 'utf8'
  })
  assert.equal(invalidImage.status, 2)
  assert.match(invalidImage.stderr, /lowercase ghcr\.io image/)

  const missingArguments = spawnSync(deployPath, [], { encoding: 'utf8' })
  assert.equal(missingArguments.status, 2)
  assert.match(missingArguments.stderr, /requires an image and commit SHA/)

  assert.match(bootstrap, /^SOURCE_DIR="\$\{1:-\}"$/m)
  assert.match(bootstrap, /^PUBLIC_KEY_FILE="\$\{2:-\}"$/m)
  assert.match(bootstrap, /^TARGET='\/root\/docker\/kinvest'$/m)
  assert.match(bootstrap, /docker compose version/)
  assert.match(bootstrap, /for command in docker setpriv install useradd passwd visudo realpath flock/)
  assert.match(bootstrap, /command -v "\$command"/)
  assert.match(bootstrap, /assert_not_symlink/)
  assert.match(bootstrap, /realpath -e/)
  assert.match(bootstrap, /kinvest-deploy/)
  assert.match(bootstrap, /passwd --lock kinvest-deploy/)
  assert.match(bootstrap, /chmod 700/)
  assert.match(bootstrap, /authorized_keys/)
  assert.match(bootstrap, /docker network inspect web/)
  assert.match(bootstrap, /docker network create web/)
  assert.match(bootstrap, /prepare-data-dir\.sh/)
  assert.match(bootstrap, /docker-compose\.yml/)
  assert.match(bootstrap, /deploy-kinvest\.sh/)
  assert.match(bootstrap, /\/usr\/local\/sbin\/deploy-kinvest/)
  assert.match(bootstrap, /\/etc\/sudoers\.d\/kinvest-deploy/)
  assert.match(bootstrap, /visudo -cf/)
  assert.doesNotMatch(
    bootstrap,
    /(?:PasswordAuthentication|StrictHostKeyChecking=no|\.env|mysql|tailscale|firewalld|nginx)/i
  )

  for (const source of [workflow, deploy, bootstrap]) {
    assert.doesNotMatch(
      source,
      /(?:refresh_token|api[_-]?key|BEGIN [A-Z ]*PRIVATE KEY|106\.54\.229\.241)/i
    )
  }
}

module.exports = { run }
