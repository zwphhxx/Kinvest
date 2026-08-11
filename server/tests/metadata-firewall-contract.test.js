const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function writeExecutable(file, lines) {
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o700 })
}

function createModel(fixture, name) {
  const model = path.join(fixture, name)
  fs.mkdirSync(model)
  fs.writeFileSync(path.join(model, 'chains'), 'FORWARD\nDOCKER-USER\n')
  fs.writeFileSync(path.join(model, 'FORWARD.rules'), '')
  fs.writeFileSync(path.join(model, 'DOCKER-USER.rules'), '')
  fs.writeFileSync(path.join(model, 'operations'), '')
  return model
}

function createFakeIptables(fixture) {
  const fake = path.join(fixture, 'iptables')
  writeExecutable(fake, [
    '#!/bin/sh',
    'set -eu',
    '[ "$1" = "-w" ] && shift 2',
    'command=$1',
    'chain=$2',
    'shift 2',
    'rules="$KINVEST_IPTABLES_MODEL/$chain.rules"',
    'operation="$command $chain $*"',
    'printf "%s\\n" "$operation" >> "$KINVEST_IPTABLES_MODEL/operations"',
    'KINVEST_FAIL_MATCH=$(printenv KINVEST_FAIL_MATCH || true)',
    'if [ -n "$KINVEST_FAIL_MATCH" ] && printf "%s\\n" "$operation" | grep -F -- "$KINVEST_FAIL_MATCH" >/dev/null; then exit 70; fi',
    'case "$command" in',
    '  -S)',
    '    grep -Fx "$chain" "$KINVEST_IPTABLES_MODEL/chains" >/dev/null 2>&1 || exit 1',
    '    while IFS= read -r rule; do [ -n "$rule" ] && printf "%s\\n" "-A $chain $rule"; done < "$rules"',
    '    ;;',
    '  -N)',
    '    grep -Fx "$chain" "$KINVEST_IPTABLES_MODEL/chains" >/dev/null 2>&1 && exit 1',
    '    printf "%s\\n" "$chain" >> "$KINVEST_IPTABLES_MODEL/chains"',
    '    : > "$rules"',
    '    ;;',
    '  -F) : > "$rules" ;;',
    '  -A) printf "%s\\n" "$*" >> "$rules" ;;',
    '  -I)',
    '    [ "$1" = "1" ] || exit 91',
    '    shift',
    '    printf "%s\\n" "$*" > "$rules.next"',
    '    cat "$rules" >> "$rules.next"',
    '    mv "$rules.next" "$rules"',
    '    ;;',
    '  -C) grep -Fx -- "$*" "$rules" >/dev/null 2>&1 ;;',
    '  -D)',
    '    awk -v target="$*" "BEGIN { removed=0 } { if (!removed && \\$0 == target) { removed=1; next } print } END { if (!removed) exit 1 }" "$rules" > "$rules.next"',
    '    mv "$rules.next" "$rules"',
    '    ;;',
    '  -X)',
    '    [ ! -s "$rules" ] || exit 1',
    '    grep -Fxv "$chain" "$KINVEST_IPTABLES_MODEL/chains" > "$KINVEST_IPTABLES_MODEL/chains.next"',
    '    mv "$KINVEST_IPTABLES_MODEL/chains.next" "$KINVEST_IPTABLES_MODEL/chains"',
    '    rm -f "$rules"',
    '    ;;',
    '  *) exit 92 ;;',
    'esac'
  ])
  return fake
}

function runHarness(file, args, env = {}) {
  return spawnSync(file, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
}

function run() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-metadata-firewall-'))
  const library = path.resolve(__dirname, '../../deploy/server/kinvest-metadata-firewall-lib.sh')
  const wrapper = path.resolve(__dirname, '../../deploy/server/kinvest-metadata-firewall.sh')
  const dockerDropIn = path.resolve(__dirname, '../../deploy/server/docker-kinvest-metadata-firewall.conf')
  const fakeIptables = createFakeIptables(fixture)
  const config = path.join(fixture, 'firewall.conf')
  fs.writeFileSync(config, [
    'KINVEST_CONTAINER_IP=172.30.0.10',
    'KINVEST_BRIDGE_INTERFACE=br-kinvest',
    'KINVEST_METADATA_IP=169.254.0.23',
    ''
  ].join('\n'))

  const applyHarness = path.join(fixture, 'apply.sh')
  writeExecutable(applyHarness, [
    '#!/bin/sh',
    'set -eu',
    '. "$1"',
    'kinvest_metadata_apply "$2" "$3"',
    'kinvest_metadata_apply "$2" "$3"',
    'kinvest_metadata_status "$2" "$3"'
  ])

  try {
    const model = createModel(fixture, 'happy-model')
    const applied = runHarness(applyHarness, [library, fakeIptables, config], {
      KINVEST_IPTABLES_MODEL: model
    })
    assert.equal(applied.status, 0, applied.stderr)
    const dockerRules = fs.readFileSync(path.join(model, 'DOCKER-USER.rules'), 'utf8').trim().split('\n').filter(Boolean)
    const metadataRules = fs.readFileSync(path.join(model, 'KINVEST-METADATA.rules'), 'utf8').trim().split('\n').filter(Boolean)
    const forwardRules = fs.readFileSync(path.join(model, 'FORWARD.rules'), 'utf8').trim()
    assert.deepEqual(dockerRules, ['-j KINVEST-METADATA'])
    assert.deepEqual(metadataRules, [
      '-i br-kinvest -s 172.30.0.10/32 -d 169.254.0.23/32 -p tcp --dport 80 -m comment --comment kinvest-metadata-app-allow -j ACCEPT',
      '-d 169.254.0.23/32 -p tcp --dport 80 -m comment --comment kinvest-metadata-default-deny -j REJECT --reject-with tcp-reset',
      '-j RETURN'
    ])
    assert.equal(forwardRules, '')

    fs.unlinkSync(config)
    const rollbackHarness = path.join(fixture, 'rollback.sh')
    writeExecutable(rollbackHarness, [
      '#!/bin/sh',
      'set -eu',
      '. "$1"',
      'kinvest_metadata_rollback "$2"',
      'kinvest_metadata_iptables -C FORWARD -d 169.254.0.23/32 -p tcp --dport 80 -m comment --comment kinvest-metadata-docker-start-guard -j REJECT --reject-with tcp-reset'
    ])
    const rolledBack = runHarness(rollbackHarness, [library, fakeIptables], {
      KINVEST_IPTABLES_MODEL: model
    })
    assert.equal(rolledBack.status, 0, rolledBack.stderr)
    assert.equal(fs.existsSync(path.join(model, 'KINVEST-METADATA.rules')), false)

    fs.writeFileSync(config, [
      'KINVEST_CONTAINER_IP=172.30.0.10',
      'KINVEST_BRIDGE_INTERFACE=br-kinvest',
      'KINVEST_METADATA_IP=169.254.0.23',
      ''
    ].join('\n'))
    const failureModel = createModel(fixture, 'failure-model')
    const failed = runHarness(applyHarness, [library, fakeIptables, config], {
      KINVEST_IPTABLES_MODEL: failureModel,
      KINVEST_FAIL_MATCH: '-A KINVEST-METADATA -j RETURN'
    })
    assert.notEqual(failed.status, 0)
    const guardRule = '-d 169.254.0.23/32 -p tcp --dport 80 -m comment --comment kinvest-metadata-docker-start-guard -j REJECT --reject-with tcp-reset'
    assert.equal(fs.readFileSync(path.join(failureModel, 'FORWARD.rules'), 'utf8').trim(), guardRule)

    const wrapperText = fs.readFileSync(wrapper, 'utf8')
    const dropInText = fs.readFileSync(dockerDropIn, 'utf8')
    assert.match(wrapperText, /flock -x/)
    assert.match(wrapperText, /stat -Lc/)
    assert.match(wrapperText, /-L/)
    assert.match(dropInText, /ExecStartPre=.* guard/)
    assert.match(dropInText, /ExecStartPost=.* apply/)
    assert.match(dropInText, /ExecStopPost=.* guard/)
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}

module.exports = { run }
