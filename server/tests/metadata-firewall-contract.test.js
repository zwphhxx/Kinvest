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
  fs.writeFileSync(path.join(model, 'FORWARD.rules'), '-j PREEXISTING-FORWARD\n')
  fs.writeFileSync(path.join(model, 'DOCKER-USER.rules'), '-j PREEXISTING-DOCKER-USER\n')
  fs.writeFileSync(path.join(model, 'operations'), '')
  return model
}

function rules(model, chain) {
  return fs.readFileSync(path.join(model, `${chain}.rules`), 'utf8').trim().split('\n').filter(Boolean)
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
    '    while IFS= read -r rule; do',
    '      if [ -n "$rule" ]; then',
    '        canonical=$(printf "%s\\n" "$rule" | sed "s/ -p tcp --dport / -p tcp -m tcp --dport /")',
    '        printf "%s\\n" "-A $chain $canonical"',
    '      fi',
    '    done < "$rules"',
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
    'esac',
    'if [ "${KINVEST_REQUIRE_GUARD_CONTINUITY:-0}" = 1 ] && [ "$chain" = FORWARD ]; then',
    '  case "$command" in',
    '    -D|-I)',
    '      grep -F -- "--comment kinvest-metadata-docker-start-guard" "$rules" >/dev/null 2>&1 ||',
    '        grep -F -- "--comment kinvest-metadata-normalization-guard" "$rules" >/dev/null 2>&1 || exit 94',
    '      ;;',
    '  esac',
    'fi'
  ])
  return fake
}

function createFakeIptablesRestore(fixture) {
  const fake = path.join(fixture, 'iptables-restore')
  writeExecutable(fake, [
    '#!/bin/sh',
    'set -eu',
    '[ "$#" -eq 3 ] && [ "$1" = -w ] && [ "$2" = 5 ] && [ "$3" = --noflush ] || exit 73',
    'cat > "$KINVEST_IPTABLES_MODEL/restore.input"',
    'printf "%s\\n" "RESTORE $*" >> "$KINVEST_IPTABLES_MODEL/operations"',
    '[ "${KINVEST_RESTORE_FAIL:-0}" = 1 ] && exit 71',
    'first=$(sed -n "1p" "$KINVEST_IPTABLES_MODEL/restore.input")',
    'forward=$(sed -n "2p" "$KINVEST_IPTABLES_MODEL/restore.input")',
    'docker_user=$(sed -n "3p" "$KINVEST_IPTABLES_MODEL/restore.input")',
    'last=$(sed -n "4p" "$KINVEST_IPTABLES_MODEL/restore.input")',
    'line_count=$(wc -l < "$KINVEST_IPTABLES_MODEL/restore.input")',
    '[ "$line_count" -eq 4 ] || exit 74',
    '[ "$first" = "*filter" ] || exit 75',
    '[ "$forward" = "-I FORWARD 2 -j KINVEST-METADATA" ] || exit 76',
    '[ "$docker_user" = "-I DOCKER-USER 1 -j KINVEST-METADATA" ] || exit 77',
    '[ "$last" = COMMIT ] || exit 78',
    'cp "$KINVEST_IPTABLES_MODEL/FORWARD.rules" "$KINVEST_IPTABLES_MODEL/FORWARD.rules.restore"',
    'cp "$KINVEST_IPTABLES_MODEL/DOCKER-USER.rules" "$KINVEST_IPTABLES_MODEL/DOCKER-USER.rules.restore"',
    'awk "NR == 1 { print; print \\"-j KINVEST-METADATA\\"; next } { print }" "$KINVEST_IPTABLES_MODEL/FORWARD.rules.restore" > "$KINVEST_IPTABLES_MODEL/FORWARD.rules.restore.next"',
    'mv "$KINVEST_IPTABLES_MODEL/FORWARD.rules.restore.next" "$KINVEST_IPTABLES_MODEL/FORWARD.rules.restore"',
    'printf "%s\\n" "-j KINVEST-METADATA" > "$KINVEST_IPTABLES_MODEL/DOCKER-USER.rules.restore.next"',
    'cat "$KINVEST_IPTABLES_MODEL/DOCKER-USER.rules.restore" >> "$KINVEST_IPTABLES_MODEL/DOCKER-USER.rules.restore.next"',
    'mv "$KINVEST_IPTABLES_MODEL/DOCKER-USER.rules.restore.next" "$KINVEST_IPTABLES_MODEL/DOCKER-USER.rules.restore"',
    'mv "$KINVEST_IPTABLES_MODEL/FORWARD.rules.restore" "$KINVEST_IPTABLES_MODEL/FORWARD.rules"',
    'mv "$KINVEST_IPTABLES_MODEL/DOCKER-USER.rules.restore" "$KINVEST_IPTABLES_MODEL/DOCKER-USER.rules"'
  ])
  return fake
}

function createFakeDocker(fixture) {
  const fake = path.join(fixture, 'docker')
  writeExecutable(fake, [
    '#!/bin/sh',
    'set -eu',
    'case "$1" in',
    '  network)',
    '    [ "$2" = inspect ] && [ "$3" = --format ] || exit 80',
    '    kmf_inspect_count_file="$KINVEST_IPTABLES_MODEL/docker-network-inspect-count"',
    '    kmf_inspect_count=0',
    '    [ ! -f "$kmf_inspect_count_file" ] || kmf_inspect_count=$(cat "$kmf_inspect_count_file")',
    '    kmf_inspect_count=$((kmf_inspect_count + 1))',
    '    printf "%s\\n" "$kmf_inspect_count" > "$kmf_inspect_count_file"',
    '    [ "$kmf_inspect_count" != "${KINVEST_DOCKER_FAIL_NETWORK_INSPECT_AT:-0}" ] || exit 87',
    '    [ "${KINVEST_DOCKER_MISSING:-0}" != 1 ] || exit 81',
    '    [ "$5" = "${KINVEST_DOCKER_EXPECTED_NETWORK:-kinvest-metadata-egress}" ] || exit 82',
    '    case "$4" in',
    '      "{{.Driver}}") printf "%s\\n" "${KINVEST_DOCKER_DRIVER:-bridge}" ;;',
    '      "{{index .Options \\"com.docker.network.bridge.name\\"}}") printf "%s\\n" "${KINVEST_DOCKER_BRIDGE:-br-kinvest-meta}" ;;',
    '      "{{len .Containers}}") printf "%s\\n" "${KINVEST_DOCKER_MEMBER_COUNT:-1}" ;;',
    '      "{{range .IPAM.Config}}{{printf \\"%s|%s\\\\n\\" .Subnet .Gateway}}{{end}}") printf "%s\\n" "${KINVEST_DOCKER_IPAM:-172.31.252.0/29|172.31.252.1}" ;;',
    '      "{{range .Containers}}{{printf \\"%s|%s\\\\n\\" .Name .IPv4Address}}{{end}}") printf "%s\\n" "${KINVEST_DOCKER_MEMBERS:-kinvest|172.31.252.2/29}" ;;',
    '      *) exit 83 ;;',
    '    esac',
    '    ;;',
    '  exec)',
    '    [ "$2" = "${KINVEST_DOCKER_EXPECTED_CONTAINER:-kinvest}" ] || exit 84',
    '    [ "$3" = ip ] && [ "$4" = -4 ] && [ "$5" = route ] && [ "$6" = get ] || exit 85',
    '    printf "%s\\n" "${KINVEST_DOCKER_ROUTE:-169.254.0.23 via 172.31.252.1 dev metadata-test0 src 172.31.252.2}"',
    '    ;;',
    '  *) exit 86 ;;',
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

function runWrapperPermissionFixture(wrapperText, fixture) {
  const wrapperFixture = path.join(fixture, 'wrapper-permission')
  const fakeBin = path.join(wrapperFixture, 'bin')
  const library = path.join(wrapperFixture, 'firewall-lib.sh')
  const config = path.join(wrapperFixture, 'metadata-network.conf')
  const lock = path.join(wrapperFixture, 'firewall.lock')
  const fakeFlock = path.join(fakeBin, 'flock')
  const fakeIptables = path.join(fakeBin, 'iptables')
  const fakeIptablesRestore = path.join(fakeBin, 'iptables-restore')
  const fakeDocker = path.join(fakeBin, 'docker')
  fs.mkdirSync(fakeBin, { recursive: true })
  fs.writeFileSync(library, 'kinvest_metadata_status() { :; }\n')
  fs.writeFileSync(config, 'fixture=non-secret\n')
  writeExecutable(path.join(fakeBin, 'stat'), [
    '#!/bin/sh',
    'target=',
    'for argument in "$@"; do target=$argument; done',
    'if [ "$target" = "$KINVEST_TEST_CONFIG" ]; then printf "%s\\n" "0:0:640"; else printf "%s\\n" "0:0:644"; fi'
  ])
  for (const executable of [fakeFlock, fakeIptables, fakeIptablesRestore, fakeDocker]) {
    writeExecutable(executable, ['#!/bin/sh', 'exit 0'])
  }
  const instrumentedWrapper = wrapperText
    .replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin', `PATH=${fakeBin}:/usr/sbin:/usr/bin:/sbin:/bin`)
    .replace('KMF_LIBRARY=/usr/local/libexec/kinvest-metadata-firewall-lib.sh', `KMF_LIBRARY=${library}`)
    .replace(/^KMF_CONFIG=.*$/m, `KMF_CONFIG=\${KMF_CONFIG:-${config}}`)
    .replace('KMF_LOCK=/run/lock/kinvest-metadata-firewall.lock', `KMF_LOCK=${lock}`)
    .replace('KMF_IPTABLES=/usr/sbin/iptables', `KMF_IPTABLES=${fakeIptables}`)
    .replace('KMF_IPTABLES_RESTORE=/usr/sbin/iptables-restore', `KMF_IPTABLES_RESTORE=${fakeIptablesRestore}`)
    .replace('KMF_DOCKER=/usr/bin/docker', `KMF_DOCKER=${fakeDocker}`)
    .replaceAll('/usr/bin/flock', fakeFlock)
  const wrapper = path.join(wrapperFixture, 'kinvest-metadata-firewall')
  writeExecutable(wrapper, instrumentedWrapper.trimEnd().split('\n'))
  return runHarness(wrapper, ['status'], { KINVEST_TEST_CONFIG: config })
}

function run() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-metadata-firewall-'))
  const library = path.resolve(__dirname, '../../deploy/server/kinvest-metadata-firewall-lib.sh')
  const wrapper = path.resolve(__dirname, '../../deploy/server/kinvest-metadata-firewall.sh')
  const dockerDropIn = path.resolve(__dirname, '../../deploy/server/docker-kinvest-metadata-firewall.conf')
  const firewallService = path.resolve(__dirname, '../../deploy/server/kinvest-metadata-firewall.service')
  const operationsDoc = path.resolve(__dirname, '../../docs/operations/2026-08-11-metadata-ssm-rollout.md')
  const fakeIptables = createFakeIptables(fixture)
  const fakeIptablesRestore = createFakeIptablesRestore(fixture)
  const fakeDocker = createFakeDocker(fixture)
  const config = path.join(fixture, 'metadata-network.conf')
  fs.writeFileSync(config, [
    'KINVEST_METADATA_NETWORK=kinvest-metadata-egress',
    'KINVEST_METADATA_SUBNET=172.31.252.0/29',
    'KINVEST_METADATA_GATEWAY=172.31.252.1',
    'KINVEST_CONTAINER_NAME=kinvest',
    'KINVEST_CONTAINER_IP=172.31.252.2',
    'KINVEST_BRIDGE_INTERFACE=br-kinvest-meta',
    'KINVEST_METADATA_IP=169.254.0.23',
    ''
  ].join('\n'))

  const applyHarness = path.join(fixture, 'apply.sh')
  writeExecutable(applyHarness, [
    '#!/bin/sh',
    'set -eu',
    '. "$1"',
    'kinvest_metadata_apply "$2" "$3" "$4" "$5"',
    'kinvest_metadata_apply "$2" "$3" "$4" "$5"',
    'kinvest_metadata_status "$2" "$4" "$5"'
  ])
  const applyOnceHarness = path.join(fixture, 'apply-once.sh')
  writeExecutable(applyOnceHarness, [
    '#!/bin/sh',
    'set -eu',
    '. "$1"',
    'kinvest_metadata_apply "$2" "$3" "$4" "$5"'
  ])
  const statusHarness = path.join(fixture, 'status.sh')
  writeExecutable(statusHarness, [
    '#!/bin/sh',
    'set -eu',
    '. "$1"',
    'kinvest_metadata_status "$2" "$3" "$4"',
    'kinvest_metadata_status "$2" "$3" "$4"'
  ])
  const rollbackHarness = path.join(fixture, 'rollback.sh')
  writeExecutable(rollbackHarness, [
    '#!/bin/sh',
    'set -eu',
    '. "$1"',
    'kinvest_metadata_rollback "$2"'
  ])
  const preBindRollbackHarness = path.join(fixture, 'rollback-pre-bind.sh')
  writeExecutable(preBindRollbackHarness, [
    '#!/bin/sh',
    'set -eu',
    '. "$1"',
    'kinvest_metadata_rollback_pre_bind "$2" "${3:-}"'
  ])
  const guardHarness = path.join(fixture, 'guard.sh')
  writeExecutable(guardHarness, [
    '#!/bin/sh',
    'set -eu',
    '. "$1"',
    'kinvest_metadata_guard "$2"'
  ])
  const guardedApplyHarness = path.join(fixture, 'guarded-apply.sh')
  writeExecutable(guardedApplyHarness, [
    '#!/bin/sh',
    'set -eu',
    '. "$1"',
    'kinvest_metadata_guard "$2"',
    'printf "%s\\n" "GUARD-THEN-APPLY" >> "$KINVEST_IPTABLES_MODEL/operations"',
    'kinvest_metadata_apply "$2" "$3" "$4" "$5"'
  ])
  const reconcileHarness = path.join(fixture, 'reconcile.sh')
  writeExecutable(reconcileHarness, [
    '#!/bin/sh',
    'set -eu',
    '. "$1"',
    'kinvest_metadata_reconcile "$2" "$3" "$4" "$5"'
  ])
  const validateConfigHarness = path.join(fixture, 'validate-config.sh')
  writeExecutable(validateConfigHarness, [
    '#!/bin/sh',
    'set -eu',
    '. "$1"',
    'kinvest_metadata_validate_config "$2"'
  ])

  try {
    const model = createModel(fixture, 'happy-model')
    const commandArgs = [library, fakeIptables, fakeIptablesRestore, fakeDocker, config]
    const happyDockerEnvironment = {
      KINVEST_IPTABLES_MODEL: model,
      KINVEST_DOCKER_ROUTE: '169.254.0.23 via 172.31.252.1 dev eth9 src 172.31.252.2 uid 10001 cache'
    }
    const applied = runHarness(applyHarness, commandArgs, happyDockerEnvironment)
    assert.equal(applied.status, 0, applied.stderr)
    assert.deepEqual(rules(model, 'FORWARD'), [
      '-j KINVEST-METADATA',
      '-j PREEXISTING-FORWARD'
    ])
    assert.deepEqual(rules(model, 'DOCKER-USER'), [
      '-j KINVEST-METADATA',
      '-j PREEXISTING-DOCKER-USER'
    ])
    assert.deepEqual(rules(model, 'KINVEST-METADATA'), [
      '-i br-kinvest-meta -s 172.31.252.2/32 -d 169.254.0.23/32 -p tcp --dport 80 -m comment --comment kinvest-metadata-app-allow -j ACCEPT',
      '-d 169.254.0.23/32 -p tcp --dport 80 -m comment --comment kinvest-metadata-default-deny -j REJECT --reject-with tcp-reset',
      '-j RETURN'
    ])
    assert.doesNotMatch(rules(model, 'KINVEST-METADATA').join('\n'), /169\.254\.0\.0\/16/)

    const applyOperations = fs.readFileSync(path.join(model, 'operations'), 'utf8').trim().split('\n')
    const restoreIndexes = applyOperations
      .map((operation, index) => operation.startsWith('RESTORE ') ? index : -1)
      .filter((index) => index >= 0)
    assert.equal(restoreIndexes.length, 2, 'each apply must atomically install the permanent jumps')
    for (const restoreIndex of restoreIndexes) {
      const guardRemoval = applyOperations.findIndex(
        (operation, index) => index > restoreIndex && operation.includes('-D FORWARD') && operation.includes('kinvest-metadata-docker-start-guard')
      )
      assert.ok(guardRemoval > restoreIndex, 'the guard must remain until after the atomic permanent jump transaction')
    }

    fs.writeFileSync(path.join(model, 'operations'), '')
    const status = runHarness(statusHarness, [library, fakeIptables, fakeDocker, config], {
      ...happyDockerEnvironment
    })
    assert.equal(status.status, 0, status.stderr)
    const statusOperations = fs.readFileSync(path.join(model, 'operations'), 'utf8')
    assert.doesNotMatch(statusOperations, /^(?:-A|-D|-F|-I|-N|-X|RESTORE)\b/m)

    const primaryGuardRule = '-d 169.254.0.23/32 -p tcp --dport 80 -m comment --comment kinvest-metadata-docker-start-guard -j REJECT --reject-with tcp-reset'
    const normalizationGuardRule = '-d 169.254.0.23/32 -p tcp --dport 80 -m comment --comment kinvest-metadata-normalization-guard -j REJECT --reject-with tcp-reset'
    const idempotentGuardModel = createModel(fixture, 'idempotent-guard-model')
    fs.writeFileSync(
      path.join(idempotentGuardModel, 'FORWARD.rules'),
      `${primaryGuardRule}\n-j PREEXISTING-FORWARD\n`
    )
    const idempotentGuard = runHarness(guardHarness, [library, fakeIptables], {
      KINVEST_IPTABLES_MODEL: idempotentGuardModel
    })
    assert.equal(idempotentGuard.status, 0, idempotentGuard.stderr)
    assert.deepEqual(rules(idempotentGuardModel, 'FORWARD'), [primaryGuardRule, '-j PREEXISTING-FORWARD'])
    assert.doesNotMatch(
      fs.readFileSync(path.join(idempotentGuardModel, 'operations'), 'utf8'),
      /^(?:-D|-I) FORWARD/m,
      'a unique first-position guard must not be deleted and reinserted'
    )

    const duplicateGuardModel = createModel(fixture, 'duplicate-guard-model')
    fs.writeFileSync(
      path.join(duplicateGuardModel, 'FORWARD.rules'),
      `-j PREEXISTING-FORWARD\n${primaryGuardRule}\n${primaryGuardRule}\n`
    )
    const normalizedGuard = runHarness(guardHarness, [library, fakeIptables], {
      KINVEST_IPTABLES_MODEL: duplicateGuardModel,
      KINVEST_REQUIRE_GUARD_CONTINUITY: '1'
    })
    assert.equal(normalizedGuard.status, 0, normalizedGuard.stderr)
    assert.deepEqual(rules(duplicateGuardModel, 'FORWARD'), [primaryGuardRule, '-j PREEXISTING-FORWARD'])
    assert.doesNotMatch(rules(duplicateGuardModel, 'FORWARD').join('\n'), /kinvest-metadata-normalization-guard/)

    const guardWriteFailures = [
      ['normalization-insert', `-I FORWARD 1 ${normalizationGuardRule}`],
      ['old-primary-delete', `-D FORWARD ${primaryGuardRule}`],
      ['new-primary-insert', `-I FORWARD 1 ${primaryGuardRule}`],
      ['normalization-delete', `-D FORWARD ${normalizationGuardRule}`]
    ]
    for (const [name, failureMatch] of guardWriteFailures) {
      const failureModel = createModel(fixture, `${name}-guard-failure-model`)
      fs.writeFileSync(
        path.join(failureModel, 'FORWARD.rules'),
        `-j PREEXISTING-FORWARD\n${primaryGuardRule}\n${primaryGuardRule}\n`
      )
      const failedGuard = runHarness(guardHarness, [library, fakeIptables], {
        KINVEST_IPTABLES_MODEL: failureModel,
        KINVEST_FAIL_MATCH: failureMatch,
        KINVEST_REQUIRE_GUARD_CONTINUITY: '1'
      })
      assert.notEqual(failedGuard.status, 0, `${name} must propagate the write failure`)
      assert.match(failedGuard.stderr, /guard/i, `${name} must report an explicit guard failure`)
      assert.ok(
        rules(failureModel, 'FORWARD').some((rule) => rule === primaryGuardRule || rule === normalizationGuardRule),
        `${name} must return with a provable deny guard`
      )
      const operations = fs.readFileSync(path.join(failureModel, 'operations'), 'utf8').trim().split('\n')
      const failureIndex = operations.findIndex((operation) => operation.includes(failureMatch))
      assert.ok(failureIndex >= 0)
      assert.deepEqual(
        operations.slice(failureIndex + 1).filter((operation) => /^-(?:I|D) FORWARD\b/.test(operation)),
        [],
        `${name} must not continue normalization writes after the failed write`
      )
    }

    const guardedApplyModel = createModel(fixture, 'guarded-apply-model')
    const guardedApply = runHarness(guardedApplyHarness, commandArgs, {
      KINVEST_IPTABLES_MODEL: guardedApplyModel,
      KINVEST_DOCKER_ROUTE: happyDockerEnvironment.KINVEST_DOCKER_ROUTE
    })
    assert.equal(guardedApply.status, 0, guardedApply.stderr)
    const guardedApplyOperations = fs.readFileSync(path.join(guardedApplyModel, 'operations'), 'utf8').trim().split('\n')
    const guardedApplyMarker = guardedApplyOperations.indexOf('GUARD-THEN-APPLY')
    const guardedApplyRestore = guardedApplyOperations.findIndex((operation) => operation.startsWith('RESTORE '))
    assert.ok(guardedApplyMarker >= 0 && guardedApplyRestore > guardedApplyMarker)
    assert.doesNotMatch(
      guardedApplyOperations.slice(guardedApplyMarker + 1, guardedApplyRestore).join('\n'),
      /^(?:-D|-I) FORWARD .*kinvest-metadata-docker-start-guard/m,
      'apply must retain an already-correct Docker start guard until permanent jumps are installed'
    )

    const reconcileStatusFailureModel = createModel(fixture, 'reconcile-status-failure-model')
    const reconcileStatusFailure = runHarness(reconcileHarness, commandArgs, {
      KINVEST_IPTABLES_MODEL: reconcileStatusFailureModel,
      KINVEST_DOCKER_FAIL_NETWORK_INSPECT_AT: '6'
    })
    assert.notEqual(reconcileStatusFailure.status, 0)
    assert.match(rules(reconcileStatusFailureModel, 'FORWARD')[0], /kinvest-metadata-docker-start-guard/)

    const invalidConfigs = [
      ['duplicate-key', `${fs.readFileSync(config, 'utf8')}KINVEST_METADATA_IP=169.254.0.23\n`],
      ['unknown-key', `${fs.readFileSync(config, 'utf8')}KINVEST_UNKNOWN=value\n`],
      ['missing-key', fs.readFileSync(config, 'utf8').replace(/^KINVEST_METADATA_GATEWAY=.*\n/m, '')]
    ]
    for (const [name, source] of invalidConfigs) {
      const invalidConfig = path.join(fixture, `${name}.conf`)
      fs.writeFileSync(invalidConfig, source)
      const validation = runHarness(validateConfigHarness, [library, invalidConfig])
      assert.notEqual(validation.status, 0, `${name} must fail config-only validation`)
    }

    /** @type {Array<[string, Record<string, string>]>} */
    const validationFailures = [
      ['missing-network', { KINVEST_DOCKER_MISSING: '1' }],
      ['wrong-driver', { KINVEST_DOCKER_DRIVER: 'overlay' }],
      ['wrong-bridge', { KINVEST_DOCKER_BRIDGE: 'br-wrong' }],
      ['wrong-ipam', { KINVEST_DOCKER_IPAM: '172.31.251.0/29|172.31.251.1' }],
      ['multiple-members', {
        KINVEST_DOCKER_MEMBER_COUNT: '2',
        KINVEST_DOCKER_MEMBERS: 'kinvest|172.31.252.2/29\nother|172.31.252.3/29'
      }],
      ['wrong-member', { KINVEST_DOCKER_MEMBERS: 'nginx|172.31.252.2/29' }],
      ['dynamic-ip', { KINVEST_DOCKER_MEMBERS: 'kinvest|172.31.252.2' }],
      ['wrong-ip', { KINVEST_DOCKER_MEMBERS: 'kinvest|172.31.252.3/29' }],
      ['wrong-route', { KINVEST_DOCKER_ROUTE: '169.254.0.23 via 172.31.252.1 dev any-name src 172.20.0.4' }],
      ['duplicate-via', {
        KINVEST_DOCKER_ROUTE: '169.254.0.23 via 172.31.252.1 via 172.31.252.1 dev eth9 src 172.31.252.2 uid 10001 cache'
      }],
      ['duplicate-dev', {
        KINVEST_DOCKER_ROUTE: '169.254.0.23 via 172.31.252.1 dev eth9 dev eth9 src 172.31.252.2 uid 10001 cache'
      }],
      ['duplicate-src', {
        KINVEST_DOCKER_ROUTE: '169.254.0.23 via 172.31.252.1 dev eth9 src 172.31.252.2 src 172.31.252.2 uid 10001 cache'
      }]
    ]
    for (const [name, environment] of validationFailures) {
      const failureModel = createModel(fixture, `${name}-model`)
      const failed = runHarness(applyOnceHarness, commandArgs, {
        KINVEST_IPTABLES_MODEL: failureModel,
        ...environment
      })
      assert.notEqual(failed.status, 0, `${name} must fail closed`)
      assert.match(rules(failureModel, 'FORWARD')[0], /kinvest-metadata-docker-start-guard/)
    }

    const buildFailureModel = createModel(fixture, 'build-failure-model')
    const buildFailed = runHarness(applyOnceHarness, commandArgs, {
      KINVEST_IPTABLES_MODEL: buildFailureModel,
      KINVEST_FAIL_MATCH: '-A KINVEST-METADATA -j RETURN'
    })
    assert.notEqual(buildFailed.status, 0)
    assert.match(rules(buildFailureModel, 'FORWARD')[0], /kinvest-metadata-docker-start-guard/)

    const restoreFailureModel = createModel(fixture, 'restore-failure-model')
    const restoreFailed = runHarness(applyOnceHarness, commandArgs, {
      KINVEST_IPTABLES_MODEL: restoreFailureModel,
      KINVEST_RESTORE_FAIL: '1'
    })
    assert.notEqual(restoreFailed.status, 0)
    assert.match(rules(restoreFailureModel, 'FORWARD')[0], /kinvest-metadata-docker-start-guard/)
    assert.equal(rules(restoreFailureModel, 'FORWARD').includes('-j KINVEST-METADATA'), false)
    assert.equal(rules(restoreFailureModel, 'DOCKER-USER').includes('-j KINVEST-METADATA'), false)

    const rolledBack = runHarness(rollbackHarness, [library, fakeIptables], {
      KINVEST_IPTABLES_MODEL: model
    })
    assert.equal(rolledBack.status, 0, rolledBack.stderr)
    assert.match(rules(model, 'FORWARD')[0], /kinvest-metadata-docker-start-guard/)
    assert.deepEqual(rules(model, 'DOCKER-USER'), ['-j PREEXISTING-DOCKER-USER'])
    assert.equal(fs.existsSync(path.join(model, 'KINVEST-METADATA.rules')), false)

    const preBindModel = createModel(fixture, 'pre-bind-model')
    const preBindApplied = runHarness(applyOnceHarness, commandArgs, { KINVEST_IPTABLES_MODEL: preBindModel })
    assert.equal(preBindApplied.status, 0, preBindApplied.stderr)
    const unasserted = runHarness(preBindRollbackHarness, [library, fakeIptables], {
      KINVEST_IPTABLES_MODEL: preBindModel
    })
    assert.notEqual(unasserted.status, 0)
    assert.match(rules(preBindModel, 'FORWARD')[0], /kinvest-metadata-docker-start-guard/)
    const preBindRolledBack = runHarness(
      preBindRollbackHarness,
      [library, fakeIptables, '--assert-role-unbound'],
      { KINVEST_IPTABLES_MODEL: preBindModel }
    )
    assert.equal(preBindRolledBack.status, 0, preBindRolledBack.stderr)
    assert.deepEqual(rules(preBindModel, 'FORWARD'), ['-j PREEXISTING-FORWARD'])
    assert.deepEqual(rules(preBindModel, 'DOCKER-USER'), ['-j PREEXISTING-DOCKER-USER'])

    const wrapperText = fs.readFileSync(wrapper, 'utf8')
    const dropInText = fs.readFileSync(dockerDropIn, 'utf8')
    const serviceText = fs.readFileSync(firewallService, 'utf8')
    const operationsText = fs.readFileSync(operationsDoc, 'utf8')
    assert.match(wrapperText, /flock -x/)
    assert.match(wrapperText, /stat -Lc/)
    assert.match(wrapperText, /-L/)
    assert.match(wrapperText, /iptables-restore/)
    assert.match(wrapperText, /rollback-pre-bind --assert-role-unbound/)
    assert.match(wrapperText, /validate-config/)
    assert.match(wrapperText, /reconcile/)
    assert.match(wrapperText, /^KMF_CONFIG=\$\{KMF_CONFIG:-\/etc\/kinvest\/metadata-network\.conf\}$/m)
    const insecureConfig = runWrapperPermissionFixture(wrapperText, fixture)
    assert.notEqual(insecureConfig.status, 0, 'root:root mode 0640 metadata config must be rejected')
    assert.match(insecureConfig.stderr, /mode 0600/i)
    assert.match(dropInText, /ExecStartPre=.* guard/)
    assert.doesNotMatch(dropInText, /^ExecStartPost=/m)
    assert.match(dropInText, /ExecStopPost=.* guard/)
    assert.match(serviceText, /^Requisite=docker\.service$/m)
    assert.match(serviceText, /^After=docker\.service$/m)
    assert.doesNotMatch(serviceText, /^Requires=docker\.service$/m)
    assert.match(serviceText, /^ExecStart=\/usr\/local\/sbin\/kinvest-metadata-firewall reconcile$/m)
    assert.doesNotMatch(serviceText, /^ExecStartPost=/m)
    const libraryText = fs.readFileSync(library, 'utf8')
    assert.doesNotMatch(libraryText, /\beth1\b/)
    assert.doesNotMatch(`${wrapperText}\n${libraryText}`, /revoke.*(?:STS|secret)/i)

    for (const gate of [
      'Compose/network recreation approval',
      'Docker restart approval',
      'iptables/systemd installation approval',
      'CAM role binding approval',
      'secret rotation approval',
      'reboot approval'
    ]) {
      assert.match(operationsText, new RegExp(gate, 'i'))
    }
    assert.match(operationsText, /live restore is disabled/i)
    assert.match(operationsText, /(?:do|does) not revoke[\s\S]{0,80}STS credentials/i)
    assert.match(operationsText, /candidate.*not pre-approved/i)
    assert.match(operationsText, /conflict preflight/i)
    assert.match(operationsText, /explicit user (?:confirmation|approval)/i)
    assert.match(operationsText, /operator assertion/i)
    assert.match(operationsText, /does not query[^\n]*CAM/i)
    assert.match(operationsText, /not a\s+claim that the candidate is conflict-free/i)
    assert.match(operationsText, /pending[\s\S]{0,160}active/i)
    assert.match(operationsText, /routine[\s\S]{0,200}read-only[\s\S]{0,80}status/i)
    assert.doesNotMatch(operationsText, /\bins-[a-z0-9]+\b/i)
    assert.doesNotMatch(operationsText, /\b2\.35\.1\b/)
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}

module.exports = { run }
