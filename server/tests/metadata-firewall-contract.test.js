const assert = require('node:assert/strict')
const crypto = require('node:crypto')
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
    'KINVEST_REMOVE_PATH_MATCH=$(printenv KINVEST_REMOVE_PATH_MATCH || true)',
    'if [ -n "$KINVEST_REMOVE_PATH_MATCH" ] && printf "%s\\n" "$operation" | grep -F -- "$KINVEST_REMOVE_PATH_MATCH" >/dev/null; then',
    '  rmdir -- "$KINVEST_REMOVE_PATH"',
    'fi',
    'KINVEST_FAIL_MATCH=$(printenv KINVEST_FAIL_MATCH || true)',
    'if [ -n "$KINVEST_FAIL_MATCH" ] && printf "%s\\n" "$operation" | grep -F -- "$KINVEST_FAIL_MATCH" >/dev/null; then',
    '  KINVEST_FAIL_MATCH_AT=$(printenv KINVEST_FAIL_MATCH_AT || true)',
    '  failure_count_file="$KINVEST_IPTABLES_MODEL/failure-match-count"',
    '  failure_count=0',
    '  [ ! -f "$failure_count_file" ] || failure_count=$(cat "$failure_count_file")',
    '  failure_count=$((failure_count + 1))',
    '  printf "%s\\n" "$failure_count" > "$failure_count_file"',
    '  if [ -z "$KINVEST_FAIL_MATCH_AT" ] || [ "$failure_count" -eq "$KINVEST_FAIL_MATCH_AT" ]; then exit 70; fi',
    'fi',
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
    '        grep -F -- "--comment kinvest-metadata-normalization-guard" "$rules" >/dev/null 2>&1 ||',
    '        grep -Fx -- "-j KINVEST-METADATA" "$rules" >/dev/null 2>&1 || exit 94',
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
  fs.writeFileSync(library, 'kinvest_metadata_verify_bridge_netfilter() { :; }\nkinvest_metadata_status() { :; }\n')
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

function runWrapperActivationFixture(wrapperText, fixture, name, options = {}) {
  const wrapperFixture = path.join(fixture, `wrapper-activation-${name}`)
  const fakeBin = path.join(wrapperFixture, 'bin')
  const library = path.join(wrapperFixture, 'firewall-lib.sh')
  const bridgeNetfilterModule = path.join(wrapperFixture, 'sys-module-br-netfilter')
  const bridgeNfCallIptables = path.join(wrapperFixture, 'bridge-nf-call-iptables')
  const config = path.join(wrapperFixture, 'metadata-network.conf')
  const activationStateDirectory = path.join(wrapperFixture, 'state')
  const activationStateTargetDirectory = path.join(wrapperFixture, 'state-target')
  const activationState = path.join(activationStateDirectory, 'metadata-network.state')
  const activationTarget = path.join(activationStateDirectory, 'metadata-network.state.target')
  const operations = path.join(wrapperFixture, 'operations')
  const events = path.join(wrapperFixture, 'events')
  const lock = path.join(wrapperFixture, 'firewall.lock')
  const fakeFlock = path.join(fakeBin, 'flock')
  const fakeIptables = path.join(fakeBin, 'iptables')
  const fakeIptablesRestore = path.join(fakeBin, 'iptables-restore')
  const fakeDocker = path.join(fakeBin, 'docker')
  const fakeMktemp = path.join(fakeBin, 'mktemp')
  const fakeSha256sum = path.join(fakeBin, 'sha256sum')
  const fakeSync = path.join(fakeBin, 'sync')
  const fakeMv = path.join(fakeBin, 'mv')
  const configSource = 'fixture=non-secret\n'
  const configHash = crypto.createHash('sha256').update(configSource).digest('hex')
  const action = options.action || 'reconcile-active'
  const stateSource = (options.stateSource || `version=1\nmode=active\nconfig_sha256=${configHash}\n`)
    .replaceAll('__CONFIG_SHA256__', configHash)

  fs.mkdirSync(fakeBin, { recursive: true })
  if (!options.moduleMissing) fs.mkdirSync(bridgeNetfilterModule)
  fs.writeFileSync(bridgeNfCallIptables, '1\n')
  const fixtureLibrarySource = options.productionLibrary
    ? `. "${options.productionLibrary}"\n`
    : [
    'kinvest_metadata_verify_bridge_netfilter() { :; }',
    'kinvest_test_assert_config() {',
    '  "$KINVEST_TEST_NODE" -e \'const fs=require("node:fs"); const [target, original, expected, snapshot]=process.argv.slice(1); if (snapshot === "1") { if (target === original) process.exit(10); if ((fs.statSync(target).mode & 0o777) !== 0o600) process.exit(11); } else if (target !== original) process.exit(12); if (fs.readFileSync(target, "utf8") !== expected) process.exit(13);\' "$1" "$KINVEST_TEST_ORIGINAL_CONFIG" "$KINVEST_TEST_CONFIG_SOURCE" "$KINVEST_TEST_EXPECT_SNAPSHOT"',
    '}',
    'kinvest_metadata_reconcile() {',
    `  printf '%s\\n' "reconcile:$4" >> "${operations}"`,
    `  printf '%s\\n' "reconcile:$4" >> "${events}"`,
    '  kinvest_test_assert_config "$4"',
    '}',
    'kinvest_metadata_reconcile_deny_all() {',
    `  printf '%s\\n' "reconcile-deny-all:$3" >> "${operations}"`,
    `  printf '%s\\n' "reconcile-deny-all:$3" >> "${events}"`,
    '  kinvest_test_assert_config "$3"',
    '}',
    ''
  ].join('\n')
  fs.writeFileSync(library, fixtureLibrarySource)
  fs.writeFileSync(config, configSource)
  fs.writeFileSync(operations, '')
  fs.writeFileSync(events, '')
  if (options.activationParentSymlink) {
    fs.mkdirSync(activationStateTargetDirectory)
    fs.symlinkSync(activationStateTargetDirectory, activationStateDirectory)
  } else {
    fs.mkdirSync(activationStateDirectory)
  }
  if (!options.missingState) {
    if (options.activationSymlink) {
      fs.writeFileSync(activationTarget, stateSource)
      fs.symlinkSync(activationTarget, activationState)
    } else {
      fs.writeFileSync(activationState, stateSource)
    }
  }
  writeExecutable(path.join(fakeBin, 'stat'), [
    '#!/bin/sh',
    'format=$2',
    'target=$3',
    'if [ "$format" = "%d:%i" ]; then',
    '  if [ "$target" = "$KINVEST_TEST_ACTIVATION_STATE" ]; then',
    '    printf "%s\\n" "$KINVEST_TEST_ACTIVATION_IDENTITY"',
    '  elif [ "$target" = /dev/fd/8 ]; then',
    '    printf "%s\\n" "$KINVEST_TEST_ACTIVATION_FD_IDENTITY"',
    '  else',
    '    printf "%s\\n" "9:9"',
    '  fi',
    'elif [ "$target" = "$KINVEST_TEST_ACTIVATION_STATE" ] || [ "$target" = /dev/fd/8 ]; then',
    '  printf "%s\\n" "$KINVEST_TEST_ACTIVATION_STAT"',
    'elif [ "$target" = "$KINVEST_TEST_ACTIVATION_STATE_DIRECTORY" ]; then',
    '  printf "%s\\n" "$KINVEST_TEST_ACTIVATION_STATE_DIRECTORY_STAT"',
    'else',
    '  printf "%s\\n" "0:0:600"',
    'fi'
  ])
  writeExecutable(fakeSha256sum, [
    '#!/bin/sh',
    'printf "%s\\n" "sha256:$1" >> "$KINVEST_TEST_EVENTS"',
    '"$KINVEST_TEST_NODE" -e \'const fs=require("node:fs"),crypto=require("node:crypto"); const file=process.argv[1]; process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")+"  "+file+"\\n");\' "$1"'
  ])
  writeExecutable(fakeFlock, ['#!/bin/sh', 'printf "%s\\n" flock >> "$KINVEST_TEST_EVENTS"'])
  writeExecutable(fakeMktemp, [
    '#!/bin/sh',
    'printf "%s\\n" mktemp >> "$KINVEST_TEST_EVENTS"',
    'exec /usr/bin/mktemp "$@"'
  ])
  writeExecutable(fakeSync, [
    '#!/bin/sh',
    'set -eu',
    'printf "%s\\n" "sync:$1" >> "$KINVEST_TEST_EVENTS"',
    'case "${KINVEST_TEST_SYNC_FAILURE:-}" in',
    '  temp) [ "$1" = "$KINVEST_TEST_ACTIVATION_STATE_DIRECTORY" ] || exit 88 ;;',
    '  parent) [ "$1" != "$KINVEST_TEST_ACTIVATION_STATE_DIRECTORY" ] || exit 89 ;;',
    'esac'
  ])
  writeExecutable(fakeMv, [
    '#!/bin/sh',
    'set -eu',
    'printf "%s\\n" "mv:$*" >> "$KINVEST_TEST_EVENTS"',
    'exec /bin/mv "$@"'
  ])
  writeExecutable(fakeIptables, ['#!/bin/sh', 'printf "%s\\n" iptables >> "$KINVEST_TEST_EVENTS"'])
  writeExecutable(fakeIptablesRestore, ['#!/bin/sh', 'printf "%s\\n" iptables-restore >> "$KINVEST_TEST_EVENTS"'])
  writeExecutable(fakeDocker, ['#!/bin/sh', 'printf "%s\\n" docker >> "$KINVEST_TEST_EVENTS"'])

  const instrumentedWrapper = wrapperText
    .replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin', `PATH=${fakeBin}:/usr/sbin:/usr/bin:/sbin:/bin`)
    .replace('KMF_LIBRARY=/usr/local/libexec/kinvest-metadata-firewall-lib.sh', `KMF_LIBRARY=${library}`)
    .replace(/^KMF_CONFIG=.*$/m, `KMF_CONFIG=\${KMF_CONFIG:-${config}}`)
    .replace(/^KMF_ACTIVATION_STATE=.*$/m, `KMF_ACTIVATION_STATE=\${KMF_ACTIVATION_STATE:-${activationState}}`)
    .replace(/^KMF_RUNTIME_DIR=.*$/m, `KMF_RUNTIME_DIR=\${KMF_RUNTIME_DIR:-${wrapperFixture}}`)
    .replace('KMF_LOCK=/run/lock/kinvest-metadata-firewall.lock', `KMF_LOCK=${lock}`)
    .replace('KMF_IPTABLES=/usr/sbin/iptables', `KMF_IPTABLES=${fakeIptables}`)
    .replace('KMF_IPTABLES_RESTORE=/usr/sbin/iptables-restore', `KMF_IPTABLES_RESTORE=${fakeIptablesRestore}`)
    .replace('KMF_DOCKER=/usr/bin/docker', `KMF_DOCKER=${fakeDocker}`)
    .replace('KMF_SHA256SUM=/usr/bin/sha256sum', `KMF_SHA256SUM=${fakeSha256sum}`)
    .replace('KMF_SYNC=/usr/bin/sync', `KMF_SYNC=${fakeSync}`)
    .replaceAll('/usr/bin/flock', fakeFlock)
  const wrapper = path.join(wrapperFixture, 'kinvest-metadata-firewall')
  writeExecutable(wrapper, instrumentedWrapper.trimEnd().split('\n'))
  const harnessEnvironment = {
    KINVEST_TEST_ACTIVATION_STATE: activationState,
    KINVEST_TEST_ACTIVATION_STATE_DIRECTORY: activationStateDirectory,
    KINVEST_TEST_ACTIVATION_STATE_DIRECTORY_STAT: options.activationParentStat || '0:0:700',
    KINVEST_TEST_ACTIVATION_STAT: options.activationStat || '0:0:600',
    KINVEST_TEST_ACTIVATION_IDENTITY: options.activationIdentity || '1:2',
    KINVEST_TEST_ACTIVATION_FD_IDENTITY: options.activationFdIdentity || '1:2',
    KINVEST_TEST_CONFIG_SHA256: configHash,
    KINVEST_TEST_CONFIG_SOURCE: configSource,
    KINVEST_TEST_EVENTS: events,
    KINVEST_TEST_EXPECT_SNAPSHOT: action === 'reconcile-active' ? '1' : '0',
    KINVEST_TEST_NODE: process.execPath,
    KINVEST_TEST_ORIGINAL_CONFIG: config,
    KINVEST_TEST_SYNC_FAILURE: options.syncFailure || '',
    KMF_BR_NETFILTER_MODULE_PATH: bridgeNetfilterModule,
    KMF_BRIDGE_NF_CALL_IPTABLES_PATH: bridgeNfCallIptables
  }
  const result = runHarness(wrapper, options.actionArgs || [action], harnessEnvironment)
  const eventsAfterFirst = fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean)
  const operationsAfterFirst = fs.readFileSync(operations, 'utf8')
  const activationStateSourceAfterFirst = fs.existsSync(activationState)
    ? fs.readFileSync(activationState, 'utf8')
    : null
  const followUpResult = options.followUpArgs
    ? runHarness(wrapper, options.followUpArgs, {
      ...harnessEnvironment,
      KINVEST_TEST_EXPECT_SNAPSHOT: '1',
      KINVEST_TEST_SYNC_FAILURE: ''
    })
    : null
  return {
    result,
    followUpResult,
    config,
    configHash,
    activationStateSource: fs.existsSync(activationState) ? fs.readFileSync(activationState, 'utf8') : null,
    activationStateSourceAfterFirst,
    activationStateMode: fs.existsSync(activationState) ? fs.statSync(activationState).mode & 0o777 : null,
    activationStateTemps: fs.readdirSync(activationStateDirectory)
      .filter((entry) => /^metadata-network[.]state[.][0-9]+[.]/.test(entry)),
    events: fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean),
    eventsAfterFirst,
    operations: fs.readFileSync(operations, 'utf8'),
    operationsAfterFirst,
    snapshots: fs.readdirSync(wrapperFixture).filter((entry) => entry.startsWith('kinvest-metadata-network.'))
  }
}

function runWrapperBridgeNetfilterFixture(wrapperText, library, fixture, name, options = {}) {
  const wrapperFixture = path.join(fixture, `wrapper-bridge-netfilter-${name}`)
  const fakeBin = path.join(wrapperFixture, 'bin')
  const bridgeNetfilterModule = path.join(wrapperFixture, 'sys-module-br-netfilter')
  const bridgeNetfilterModuleTarget = path.join(wrapperFixture, 'sys-module-br-netfilter-target')
  const bridgeNfCallIptables = path.join(wrapperFixture, 'bridge-nf-call-iptables')
  const bridgeNfCallIptablesTarget = path.join(wrapperFixture, 'bridge-nf-call-iptables-target')
  const bridgeNfCallIptablesReplacement = path.join(wrapperFixture, 'bridge-nf-call-iptables-replacement')
  const operations = path.join(wrapperFixture, 'operations')
  const lock = path.join(wrapperFixture, 'firewall.lock')
  const fakeFlock = path.join(fakeBin, 'flock')
  const fakeIptables = path.join(fakeBin, 'iptables')
  const fakeIptablesRestore = path.join(fakeBin, 'iptables-restore')
  const fakeDocker = path.join(fakeBin, 'docker')
  const fakeSha256sum = path.join(fakeBin, 'sha256sum')

  fs.mkdirSync(fakeBin, { recursive: true })
  if (options.moduleType === 'file') {
    fs.writeFileSync(bridgeNetfilterModule, '')
  } else if (options.moduleType === 'symlink') {
    fs.mkdirSync(bridgeNetfilterModuleTarget)
    fs.symlinkSync(bridgeNetfilterModuleTarget, bridgeNetfilterModule)
  } else if (options.moduleType !== 'missing') {
    fs.mkdirSync(bridgeNetfilterModule)
  }
  if (options.sysctlType === 'symlink') {
    fs.writeFileSync(bridgeNfCallIptablesTarget, options.sysctlValue || '1\n')
    fs.symlinkSync(bridgeNfCallIptablesTarget, bridgeNfCallIptables)
  } else if (options.sysctlType !== 'missing') {
    fs.writeFileSync(
      bridgeNfCallIptables,
      options.sysctlValue || '1\n',
      { mode: options.sysctlMode === undefined ? 0o600 : options.sysctlMode }
    )
  }
  if (options.sysctlSymlinkReplacement) {
    fs.writeFileSync(bridgeNfCallIptablesReplacement, '1\n')
  }
  fs.writeFileSync(operations, '')
  writeExecutable(path.join(fakeBin, 'stat'), [
    '#!/bin/sh',
    'format=$2',
    'target=$3',
    'if [ "$format" = "%d:%i" ]; then',
    '  if [ "$target" = /dev/fd/7 ]; then',
    '    if [ "${KINVEST_TEST_REPLACE_SYSCTL_ON_FD_STAT:-0}" = 1 ]; then',
    '      /bin/mv "$KINVEST_TEST_SYSCTL_PATH" "$KINVEST_TEST_SYSCTL_PATH.original"',
    '      /bin/ln -s "$KINVEST_TEST_SYSCTL_REPLACEMENT" "$KINVEST_TEST_SYSCTL_PATH"',
    '    fi',
    '    printf "%s\\n" "${KINVEST_TEST_SYSCTL_FD_IDENTITY:-1:2}"',
    '  else',
    '    printf "%s\\n" "${KINVEST_TEST_SYSCTL_PATH_IDENTITY:-1:2}"',
    '  fi',
    'else',
    '  printf "%s\\n" "0:0:644"',
    'fi'
  ])
  for (const [dependency, executable] of [
    ['flock', fakeFlock],
    ['iptables', fakeIptables],
    ['iptables-restore', fakeIptablesRestore],
    ['docker', fakeDocker],
    ['sha256sum', fakeSha256sum]
  ]) {
    fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${dependency}' >> '${operations}'\n`, { mode: 0o600 })
  }

  const instrumentedWrapper = wrapperText
    .replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin', `PATH=${fakeBin}:/usr/sbin:/usr/bin:/sbin:/bin`)
    .replace('KMF_LIBRARY=/usr/local/libexec/kinvest-metadata-firewall-lib.sh', `KMF_LIBRARY=${library}`)
    .replace('KMF_LOCK=/run/lock/kinvest-metadata-firewall.lock', `KMF_LOCK=${lock}`)
    .replace('KMF_IPTABLES=/usr/sbin/iptables', `KMF_IPTABLES=${fakeIptables}`)
    .replace('KMF_IPTABLES_RESTORE=/usr/sbin/iptables-restore', `KMF_IPTABLES_RESTORE=${fakeIptablesRestore}`)
    .replace('KMF_DOCKER=/usr/bin/docker', `KMF_DOCKER=${fakeDocker}`)
    .replace('KMF_SHA256SUM=/usr/bin/sha256sum', `KMF_SHA256SUM=${fakeSha256sum}`)
    .replaceAll('/usr/bin/flock', fakeFlock)
  const wrapper = path.join(wrapperFixture, 'kinvest-metadata-firewall')
  writeExecutable(wrapper, instrumentedWrapper.trimEnd().split('\n'))
  const wrapperArguments = options.args || ['verify-bridge-netfilter']
  const harnessFile = options.shell || wrapper
  const harnessArguments = options.shell ? [wrapper, ...wrapperArguments] : wrapperArguments
  const result = runHarness(harnessFile, harnessArguments, {
    KMF_BR_NETFILTER_MODULE_PATH: bridgeNetfilterModule,
    KMF_BRIDGE_NF_CALL_IPTABLES_PATH: bridgeNfCallIptables,
    KINVEST_TEST_REPLACE_SYSCTL_ON_FD_STAT: options.sysctlSymlinkReplacement ? '1' : '0',
    KINVEST_TEST_SYSCTL_FD_IDENTITY: options.sysctlIdentityMismatch ? '1:3' : '1:2',
    KINVEST_TEST_SYSCTL_PATH: bridgeNfCallIptables,
    KINVEST_TEST_SYSCTL_PATH_IDENTITY: '1:2',
    KINVEST_TEST_SYSCTL_REPLACEMENT: bridgeNfCallIptablesReplacement
  })
  return {
    result,
    operations: fs.readFileSync(operations, 'utf8').trim().split('\n').filter(Boolean)
  }
}

function runCleanBootFixture(
  wrapperText,
  library,
  fixture,
  fakeIptables,
  fakeIptablesRestore,
  fakeDocker,
  sourceConfig
) {
  const bootFixture = path.join(fixture, 'clean-boot')
  const fakeBin = path.join(bootFixture, 'bin')
  const runtime = path.join(bootFixture, 'run')
  const bridgeNetfilterModule = path.join(bootFixture, 'sys-module-br-netfilter')
  const bridgeNfCallIptables = path.join(bootFixture, 'bridge-nf-call-iptables')
  const config = path.join(bootFixture, 'metadata-network.conf')
  const activationState = path.join(bootFixture, 'metadata-network.state')
  const lock = path.join(bootFixture, 'firewall.lock')
  const fakeFlock = path.join(fakeBin, 'flock')
  const fakeSha256sum = path.join(fakeBin, 'sha256sum')

  fs.mkdirSync(fakeBin, { recursive: true })
  fs.mkdirSync(runtime)
  fs.copyFileSync(sourceConfig, config)
  fs.chmodSync(config, 0o600)
  const configHash = crypto.createHash('sha256').update(fs.readFileSync(config)).digest('hex')
  const model = createModel(bootFixture, 'iptables-model')

  writeExecutable(path.join(fakeBin, 'stat'), [
    '#!/bin/sh',
    'case "$2" in',
    '  "%d:%i") printf "%s\\n" "1:2" ;;',
    '  "%u:%g:%a") printf "%s\\n" "0:0:600" ;;',
    '  *) exit 1 ;;',
    'esac'
  ])
  writeExecutable(fakeFlock, ['#!/bin/sh', 'exit 0'])
  writeExecutable(fakeSha256sum, [
    '#!/bin/sh',
    `printf "%s  %s\\n" "${configHash}" "$1"`
  ])

  const instrumentedWrapper = wrapperText
    .replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin', `PATH=${fakeBin}:/usr/sbin:/usr/bin:/sbin:/bin`)
    .replace('KMF_LIBRARY=/usr/local/libexec/kinvest-metadata-firewall-lib.sh', `KMF_LIBRARY=${library}`)
    .replace('KMF_LOCK=/run/lock/kinvest-metadata-firewall.lock', `KMF_LOCK=${lock}`)
    .replace('KMF_IPTABLES=/usr/sbin/iptables', `KMF_IPTABLES=${fakeIptables}`)
    .replace('KMF_IPTABLES_RESTORE=/usr/sbin/iptables-restore', `KMF_IPTABLES_RESTORE=${fakeIptablesRestore}`)
    .replace('KMF_DOCKER=/usr/bin/docker', `KMF_DOCKER=${fakeDocker}`)
    .replace('KMF_SHA256SUM=/usr/bin/sha256sum', `KMF_SHA256SUM=${fakeSha256sum}`)
    .replaceAll('/usr/bin/flock', fakeFlock)
  const wrapper = path.join(bootFixture, 'kinvest-metadata-firewall')
  writeExecutable(wrapper, instrumentedWrapper.trimEnd().split('\n'))

  const environment = {
    KINVEST_IPTABLES_MODEL: model,
    KMF_ACTIVATION_STATE: activationState,
    KMF_BR_NETFILTER_MODULE_PATH: bridgeNetfilterModule,
    KMF_BRIDGE_NF_CALL_IPTABLES_PATH: bridgeNfCallIptables,
    KMF_CONFIG: config,
    KMF_RUNTIME_DIR: runtime
  }
  const missingModuleVerification = runHarness(wrapper, ['verify-bridge-netfilter'], environment)
  const operationsAfterMissingModule = fs.readFileSync(path.join(model, 'operations'), 'utf8')

  fs.mkdirSync(bridgeNetfilterModule)
  fs.writeFileSync(bridgeNfCallIptables, '1\n')
  const enabledVerification = runHarness(wrapper, ['verify-bridge-netfilter'], environment)
  const preStartGuard = runHarness(wrapper, ['guard'], environment)
  const primaryGuardRule = '-d 169.254.0.23/32 -p tcp --dport 80 -m comment --comment kinvest-metadata-docker-start-guard -j REJECT --reject-with tcp-reset'

  fs.writeFileSync(
    path.join(model, 'FORWARD.rules'),
    `${primaryGuardRule}\n-j DOCKER-USER\n-j PREEXISTING-FORWARD\n`
  )
  fs.writeFileSync(path.join(model, 'DOCKER-USER.rules'), '-j RETURN\n')
  const dockerRebuiltForward = rules(model, 'FORWARD')
  const dockerRebuiltDockerUser = rules(model, 'DOCKER-USER')

  fs.writeFileSync(
    activationState,
    `version=1\nmode=deny-all\nconfig_sha256=${configHash}\n`,
    { mode: 0o600 }
  )
  const reconcileActive = runHarness(wrapper, ['reconcile-active'], environment)

  return {
    dockerRebuiltDockerUser,
    dockerRebuiltForward,
    enabledVerification,
    finalDockerUser: rules(model, 'DOCKER-USER'),
    finalForward: rules(model, 'FORWARD'),
    finalManagedChain: rules(model, 'KINVEST-METADATA'),
    missingModuleVerification,
    operationsAfterMissingModule,
    preStartGuard,
    primaryGuardRule,
    reconcileActive,
    sysctlValue: fs.readFileSync(bridgeNfCallIptables, 'utf8')
  }
}

function run() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kinvest-metadata-firewall-'))
  const library = path.resolve(__dirname, '../../deploy/server/kinvest-metadata-firewall-lib.sh')
  const wrapper = path.resolve(__dirname, '../../deploy/server/kinvest-metadata-firewall.sh')
  const modulesLoad = path.resolve(__dirname, '../../deploy/server/kinvest-br-netfilter.modules-load.conf')
  const bridgeNetfilterSysctl = path.resolve(__dirname, '../../deploy/server/kinvest-br-netfilter.sysctl.conf')
  const dockerDropIn = path.resolve(__dirname, '../../deploy/server/docker-kinvest-metadata-firewall.conf')
  const firewallService = path.resolve(__dirname, '../../deploy/server/kinvest-metadata-firewall.service')
  const firewallTimer = path.resolve(__dirname, '../../deploy/server/kinvest-metadata-firewall.timer')
  const operationsDoc = path.resolve(__dirname, '../../docs/operations/2026-08-11-metadata-ssm-rollout.md')
  const fakeIptables = createFakeIptables(fixture)
  const fakeIptablesRestore = createFakeIptablesRestore(fixture)
  const fakeDocker = createFakeDocker(fixture)
  const bridgeNetfilterModule = path.join(fixture, 'sys-module-br-netfilter')
  const bridgeNfCallIptables = path.join(fixture, 'bridge-nf-call-iptables')
  const config = path.join(fixture, 'metadata-network.conf')
  fs.mkdirSync(bridgeNetfilterModule)
  fs.writeFileSync(bridgeNfCallIptables, '1\n')
  const previousBridgeNetfilterModulePath = process.env.KMF_BR_NETFILTER_MODULE_PATH
  const previousBridgeNfCallIptablesPath = process.env.KMF_BRIDGE_NF_CALL_IPTABLES_PATH
  process.env.KMF_BR_NETFILTER_MODULE_PATH = bridgeNetfilterModule
  process.env.KMF_BRIDGE_NF_CALL_IPTABLES_PATH = bridgeNfCallIptables
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
  const gatedReconcileHarness = path.join(fixture, 'gated-reconcile.sh')
  writeExecutable(gatedReconcileHarness, [
    '#!/bin/sh',
    'set -eu',
    '. "$1"',
    'kinvest_metadata_verify_bridge_netfilter',
    'kinvest_metadata_reconcile "$2" "$3" "$4" "$5"'
  ])
  const denyAllReconcileHarness = path.join(fixture, 'reconcile-deny-all.sh')
  writeExecutable(denyAllReconcileHarness, [
    '#!/bin/sh',
    'set -eu',
    '. "$1"',
    'kinvest_metadata_reconcile_deny_all "$2" "$3" "$4"',
    'kinvest_metadata_reconcile_deny_all "$2" "$3" "$4"'
  ])
  const denyAllReconcileOnceHarness = path.join(fixture, 'reconcile-deny-all-once.sh')
  writeExecutable(denyAllReconcileOnceHarness, [
    '#!/bin/sh',
    'set -eu',
    '. "$1"',
    'kinvest_metadata_reconcile_deny_all "$2" "$3" "$4"'
  ])
  const validateConfigHarness = path.join(fixture, 'validate-config.sh')
  writeExecutable(validateConfigHarness, [
    '#!/bin/sh',
    'set -eu',
    '. "$1"',
    'kinvest_metadata_validate_config "$2"'
  ])
  const verifyCallerFdHarness = path.join(fixture, 'verify-caller-fd.sh')
  writeExecutable(verifyCallerFdHarness, [
    '#!/bin/sh',
    'set -eu',
    '. "$1"',
    'exec 7< "$2"',
    'kinvest_metadata_verify_bridge_netfilter',
    'IFS= read -r kmf_caller_fd_value <&7',
    '[ "$kmf_caller_fd_value" = caller-owned ]'
  ])

  try {
    const callerFd = path.join(fixture, 'caller-fd')
    const callerFdBin = path.join(fixture, 'caller-fd-bin')
    fs.mkdirSync(callerFdBin)
    fs.writeFileSync(callerFd, 'caller-owned\n')
    writeExecutable(path.join(callerFdBin, 'stat'), [
      '#!/bin/sh',
      'printf "%s\\n" "1:2"'
    ])
    const preservedCallerFd = runHarness(verifyCallerFdHarness, [library, callerFd], {
      PATH: `${callerFdBin}:${process.env.PATH}`
    })
    assert.equal(preservedCallerFd.status, 0, preservedCallerFd.stderr)

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

    const denyAllModel = createModel(fixture, 'deny-all-model')
    fs.appendFileSync(path.join(denyAllModel, 'chains'), 'KINVEST-METADATA\n')
    fs.writeFileSync(
      path.join(denyAllModel, 'FORWARD.rules'),
      '-j KINVEST-METADATA\n-j PREEXISTING-FORWARD\n-j KINVEST-METADATA\n'
    )
    fs.writeFileSync(
      path.join(denyAllModel, 'DOCKER-USER.rules'),
      '-j KINVEST-METADATA\n-j KINVEST-METADATA\n-j PREEXISTING-DOCKER-USER\n'
    )
    fs.writeFileSync(path.join(denyAllModel, 'KINVEST-METADATA.rules'), [
      '-i br-kinvest-meta -s 172.31.252.2/32 -d 169.254.0.23/32 -p tcp --dport 80 -m comment --comment kinvest-metadata-app-allow -j ACCEPT',
      '-d 169.254.0.0/16 -p tcp --dport 80 -j ACCEPT',
      '-j RETURN',
      ''
    ].join('\n'))
    const denyAll = runHarness(
      denyAllReconcileHarness,
      [library, fakeIptables, fakeIptablesRestore, config],
      {
        KINVEST_IPTABLES_MODEL: denyAllModel,
        KINVEST_REQUIRE_GUARD_CONTINUITY: '1'
      }
    )
    assert.equal(denyAll.status, 0, denyAll.stderr)
    assert.deepEqual(rules(denyAllModel, 'FORWARD'), [
      '-j KINVEST-METADATA',
      '-j PREEXISTING-FORWARD'
    ])
    assert.deepEqual(rules(denyAllModel, 'DOCKER-USER'), [
      '-j KINVEST-METADATA',
      '-j PREEXISTING-DOCKER-USER'
    ])
    assert.deepEqual(rules(denyAllModel, 'KINVEST-METADATA'), [
      '-d 169.254.0.23/32 -p tcp --dport 80 -m comment --comment kinvest-metadata-default-deny -j REJECT --reject-with tcp-reset',
      '-j RETURN'
    ])
    assert.doesNotMatch(rules(denyAllModel, 'KINVEST-METADATA').join('\n'), /ACCEPT|169\.254\.0\.0\/16/)

    const denyAllApplyFailureModel = createModel(fixture, 'deny-all-apply-failure-model')
    const denyAllApplyFailure = runHarness(
      denyAllReconcileOnceHarness,
      [library, fakeIptables, fakeIptablesRestore, config],
      {
        KINVEST_IPTABLES_MODEL: denyAllApplyFailureModel,
        KINVEST_FAIL_MATCH: '-A KINVEST-METADATA -j RETURN'
      }
    )
    assert.notEqual(denyAllApplyFailure.status, 0)
    assert.match(rules(denyAllApplyFailureModel, 'FORWARD')[0], /kinvest-metadata-docker-start-guard/)

    const denyAllStatusFailureModel = createModel(fixture, 'deny-all-status-failure-model')
    const denyAllStatusFailure = runHarness(
      denyAllReconcileOnceHarness,
      [library, fakeIptables, fakeIptablesRestore, config],
      {
        KINVEST_IPTABLES_MODEL: denyAllStatusFailureModel,
        KINVEST_FAIL_MATCH: '-S KINVEST-METADATA',
        KINVEST_FAIL_MATCH_AT: '5'
      }
    )
    assert.notEqual(denyAllStatusFailure.status, 0)
    assert.match(rules(denyAllStatusFailureModel, 'FORWARD')[0], /kinvest-metadata-docker-start-guard/)

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

    const disappearingModule = path.join(fixture, 'disappearing-sys-module-br-netfilter')
    fs.mkdirSync(disappearingModule)
    const disappearingModuleModel = createModel(fixture, 'disappearing-module-model')
    const disappearingModuleFailureMatch = '-A KINVEST-METADATA -j RETURN'
    const disappearingModuleReconcile = runHarness(gatedReconcileHarness, commandArgs, {
      KINVEST_FAIL_MATCH: disappearingModuleFailureMatch,
      KINVEST_IPTABLES_MODEL: disappearingModuleModel,
      KINVEST_REMOVE_PATH: disappearingModule,
      KINVEST_REMOVE_PATH_MATCH: disappearingModuleFailureMatch,
      KMF_BR_NETFILTER_MODULE_PATH: disappearingModule,
      PATH: `${callerFdBin}:${process.env.PATH}`
    })
    assert.notEqual(disappearingModuleReconcile.status, 0)
    assert.equal(fs.existsSync(disappearingModule), false)
    const disappearingModuleOperations = fs.readFileSync(path.join(disappearingModuleModel, 'operations'), 'utf8').trim().split('\n')
    const disappearingModuleFailureIndex = disappearingModuleOperations.indexOf(disappearingModuleFailureMatch)
    assert.ok(disappearingModuleFailureIndex >= 0)
    assert.equal(
      disappearingModuleOperations.slice(disappearingModuleFailureIndex + 1)[0].trim(),
      '-S FORWARD',
      'recovery guard must remain usable if bridge netfilter disappears after entry gating'
    )

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

    const missingModuleRollbackModel = createModel(fixture, 'missing-module-rollback-model')
    const missingModuleRollbackApplied = runHarness(applyOnceHarness, commandArgs, {
      KINVEST_IPTABLES_MODEL: missingModuleRollbackModel
    })
    assert.equal(missingModuleRollbackApplied.status, 0, missingModuleRollbackApplied.stderr)
    const missingModuleRollback = runHarness(rollbackHarness, [library, fakeIptables], {
      KINVEST_IPTABLES_MODEL: missingModuleRollbackModel,
      KMF_BR_NETFILTER_MODULE_PATH: path.join(fixture, 'missing-module-for-rollback')
    })
    assert.equal(missingModuleRollback.status, 0, missingModuleRollback.stderr)
    assert.deepEqual(rules(missingModuleRollbackModel, 'FORWARD'), [primaryGuardRule, '-j PREEXISTING-FORWARD'])
    assert.deepEqual(rules(missingModuleRollbackModel, 'DOCKER-USER'), ['-j PREEXISTING-DOCKER-USER'])
    assert.match(fs.readFileSync(path.join(missingModuleRollbackModel, 'operations'), 'utf8'), /-X KINVEST-METADATA/)

    const missingSysctlPreBindModel = createModel(fixture, 'missing-sysctl-pre-bind-model')
    const missingSysctlPreBindApplied = runHarness(applyOnceHarness, commandArgs, {
      KINVEST_IPTABLES_MODEL: missingSysctlPreBindModel
    })
    assert.equal(missingSysctlPreBindApplied.status, 0, missingSysctlPreBindApplied.stderr)
    const missingSysctlPreBindRollback = runHarness(
      preBindRollbackHarness,
      [library, fakeIptables, '--assert-role-unbound'],
      {
        KINVEST_IPTABLES_MODEL: missingSysctlPreBindModel,
        KMF_BRIDGE_NF_CALL_IPTABLES_PATH: path.join(fixture, 'missing-sysctl-for-pre-bind')
      }
    )
    assert.equal(missingSysctlPreBindRollback.status, 0, missingSysctlPreBindRollback.stderr)
    assert.deepEqual(rules(missingSysctlPreBindModel, 'FORWARD'), ['-j PREEXISTING-FORWARD'])
    assert.deepEqual(rules(missingSysctlPreBindModel, 'DOCKER-USER'), ['-j PREEXISTING-DOCKER-USER'])
    assert.match(fs.readFileSync(path.join(missingSysctlPreBindModel, 'operations'), 'utf8'), /-X KINVEST-METADATA/)

    const wrapperText = fs.readFileSync(wrapper, 'utf8')
    const modulesLoadText = fs.existsSync(modulesLoad) ? fs.readFileSync(modulesLoad, 'utf8') : null
    const bridgeNetfilterSysctlText = fs.existsSync(bridgeNetfilterSysctl)
      ? fs.readFileSync(bridgeNetfilterSysctl, 'utf8')
      : null
    const dropInText = fs.readFileSync(dockerDropIn, 'utf8')
    const serviceText = fs.readFileSync(firewallService, 'utf8')
    const timerText = fs.readFileSync(firewallTimer, 'utf8')
    const operationsText = fs.readFileSync(operationsDoc, 'utf8')
    assert.equal(modulesLoadText, 'br_netfilter\n')
    assert.equal(bridgeNetfilterSysctlText, 'net.bridge.bridge-nf-call-iptables = 1\n')
    assert.equal(
      dropInText,
      '[Unit]\n' +
        'After=systemd-modules-load.service systemd-sysctl.service\n' +
        '\n' +
        '[Service]\n' +
        'ExecStartPre=+/usr/local/sbin/kinvest-metadata-firewall verify-bridge-netfilter\n' +
        'ExecStartPre=+/usr/local/sbin/kinvest-metadata-firewall guard\n' +
        'ExecStartPost=+/usr/local/sbin/kinvest-metadata-firewall reconcile-active\n' +
        'ExecStopPost=+/usr/local/sbin/kinvest-metadata-firewall guard\n'
    )
    const dropInSequence = [
      'After=systemd-modules-load.service systemd-sysctl.service',
      'ExecStartPre=+/usr/local/sbin/kinvest-metadata-firewall verify-bridge-netfilter',
      'ExecStartPre=+/usr/local/sbin/kinvest-metadata-firewall guard',
      'ExecStartPost=+/usr/local/sbin/kinvest-metadata-firewall reconcile-active',
      'ExecStopPost=+/usr/local/sbin/kinvest-metadata-firewall guard'
    ]
    const dropInSequencePositions = dropInSequence.map((line) => dropInText.indexOf(line))
    assert.ok(dropInSequencePositions.every((position) => position >= 0))
    assert.deepEqual(
      [...dropInSequencePositions].sort((left, right) => left - right),
      dropInSequencePositions,
      'Docker bridge-netfilter and firewall hooks must retain their required order'
    )
    assert.match(wrapperText, /flock -x/)
    assert.match(wrapperText, /stat -Lc/)
    assert.match(wrapperText, /-L/)
    assert.match(wrapperText, /iptables-restore/)
    assert.match(wrapperText, /rollback-pre-bind --assert-role-unbound/)
    assert.match(wrapperText, /validate-config/)
    assert.match(wrapperText, /reconcile/)
    assert.match(wrapperText, /^KMF_CONFIG=\$\{KMF_CONFIG:-\/etc\/kinvest\/metadata-network\.conf\}$/m)
    assert.match(wrapperText, /^KMF_BR_NETFILTER_MODULE_PATH=\$\{KMF_BR_NETFILTER_MODULE_PATH:-\/sys\/module\/br_netfilter\}$/m)
    assert.match(wrapperText, /^KMF_BRIDGE_NF_CALL_IPTABLES_PATH=\$\{KMF_BRIDGE_NF_CALL_IPTABLES_PATH:-\/proc\/sys\/net\/bridge\/bridge-nf-call-iptables\}$/m)
    assert.match(wrapperText, /^KMF_ACTIVATION_STATE=\$\{KMF_ACTIVATION_STATE:-\/root\/docker\/kinvest\/state\/metadata-network\.state\}$/m)
    assert.match(wrapperText, /kinvest_assert_active_config_binding/)
    assert.match(wrapperText, /exec 8< "\$KMF_ACTIVATION_STATE"/)
    assert.match(wrapperText, /done <&8/)
    assert.ok(
      wrapperText.indexOf('trap kinvest_cleanup_reconcile_config EXIT') <
        wrapperText.indexOf('kmf_reconcile_config=$(mktemp'),
      'snapshot cleanup traps must be installed before mktemp'
    )
    const insecureConfig = runWrapperPermissionFixture(wrapperText, fixture)
    assert.notEqual(insecureConfig.status, 0, 'root:root mode 0640 metadata config must be rejected')
    assert.match(insecureConfig.stderr, /mode 0600/i)

    const verifierCases = [
      ['module-missing', { moduleType: 'missing' }, 'METADATA_BR_NETFILTER_MODULE_MISSING'],
      ['module-not-directory', { moduleType: 'file' }, 'METADATA_BR_NETFILTER_MODULE_MISSING'],
      ['module-symlink', { moduleType: 'symlink' }, 'METADATA_BR_NETFILTER_MODULE_MISSING'],
      ['sysctl-missing', { sysctlType: 'missing' }, 'METADATA_BR_NETFILTER_SYSCTL_MISSING'],
      ['sysctl-symlink', { sysctlType: 'symlink' }, 'METADATA_BR_NETFILTER_SYSCTL_MISSING'],
      ['sysctl-disabled', { sysctlValue: '0\n' }, 'METADATA_BR_NETFILTER_SYSCTL_DISABLED'],
      ['sysctl-invalid', { sysctlValue: '1 \n' }, 'METADATA_BR_NETFILTER_SYSCTL_INVALID'],
      ['sysctl-missing-newline', { sysctlValue: '1' }, 'METADATA_BR_NETFILTER_SYSCTL_INVALID'],
      ['sysctl-extra-lines', { sysctlValue: '1\n1\n' }, 'METADATA_BR_NETFILTER_SYSCTL_INVALID'],
      ['sysctl-open-failure', { sysctlMode: 0o000 }, 'METADATA_BR_NETFILTER_SYSCTL_INVALID'],
      ['sysctl-identity-mismatch', { sysctlIdentityMismatch: true }, 'METADATA_BR_NETFILTER_SYSCTL_INVALID'],
      ['sysctl-symlink-replacement', { sysctlSymlinkReplacement: true }, 'METADATA_BR_NETFILTER_SYSCTL_INVALID']
    ]
    if (fs.existsSync('/bin/dash')) {
      verifierCases.push([
        'sysctl-open-failure-dash',
        { shell: '/bin/dash', sysctlMode: 0o000 },
        'METADATA_BR_NETFILTER_SYSCTL_INVALID'
      ])
    }
    for (const [name, options, expectedCode] of verifierCases) {
      const verification = runWrapperBridgeNetfilterFixture(wrapperText, library, fixture, name, options)
      assert.notEqual(verification.result.status, 0, `${name} must fail closed`)
      assert.equal(verification.result.stdout, '')
      assert.equal(verification.result.stderr, `${expectedCode}\n`)
      assert.deepEqual(verification.operations, [], `${name} must not invoke firewall or Docker dependencies`)
    }
    const enabledBridgeNetfilter = runWrapperBridgeNetfilterFixture(wrapperText, library, fixture, 'enabled')
    assert.equal(enabledBridgeNetfilter.result.status, 0, enabledBridgeNetfilter.result.stderr)
    assert.equal(enabledBridgeNetfilter.result.stdout, '')
    assert.equal(enabledBridgeNetfilter.result.stderr, '')
    assert.deepEqual(enabledBridgeNetfilter.operations, [])

    for (const action of ['guard', 'apply', 'status', 'reconcile']) {
      const gatedAction = runWrapperBridgeNetfilterFixture(wrapperText, library, fixture, `missing-module-${action}`, {
        args: [action],
        moduleType: 'missing'
      })
      assert.notEqual(gatedAction.result.status, 0, `${action} must fail closed without bridge netfilter`)
      assert.equal(gatedAction.result.stdout, '')
      assert.equal(gatedAction.result.stderr, 'METADATA_BR_NETFILTER_MODULE_MISSING\n')
      assert.deepEqual(gatedAction.operations, [], `${action} must fail before dependency operations`)
    }

    const expectedUsage = 'Usage: kinvest-metadata-firewall validate-config|verify-bridge-netfilter|guard|apply|status|reconcile|reconcile-active|activate-deny-all --confirm-deny-all|rollback|rollback-pre-bind --assert-role-unbound'
    const invalidVerifierArguments = runWrapperBridgeNetfilterFixture(wrapperText, library, fixture, 'invalid-arguments', {
      args: ['verify-bridge-netfilter', 'unexpected']
    })
    assert.equal(invalidVerifierArguments.result.status, 2)
    assert.equal(invalidVerifierArguments.result.stderr, `${expectedUsage}\n`)
    assert.deepEqual(invalidVerifierArguments.operations, [])

    const cleanBoot = runCleanBootFixture(
      wrapperText,
      library,
      fixture,
      fakeIptables,
      fakeIptablesRestore,
      fakeDocker,
      config
    )
    assert.notEqual(cleanBoot.missingModuleVerification.status, 0)
    assert.equal(cleanBoot.missingModuleVerification.stderr, 'METADATA_BR_NETFILTER_MODULE_MISSING\n')
    assert.equal(cleanBoot.operationsAfterMissingModule, '')
    assert.equal(cleanBoot.sysctlValue, '1\n')
    assert.equal(cleanBoot.enabledVerification.status, 0, cleanBoot.enabledVerification.stderr)
    assert.equal(cleanBoot.preStartGuard.status, 0, cleanBoot.preStartGuard.stderr)
    assert.deepEqual(cleanBoot.dockerRebuiltForward, [
      cleanBoot.primaryGuardRule,
      '-j DOCKER-USER',
      '-j PREEXISTING-FORWARD'
    ])
    assert.deepEqual(cleanBoot.dockerRebuiltDockerUser, ['-j RETURN'])
    assert.equal(cleanBoot.reconcileActive.status, 0, cleanBoot.reconcileActive.stderr)
    assert.deepEqual(cleanBoot.finalManagedChain, [
      '-d 169.254.0.23/32 -p tcp --dport 80 -m comment --comment kinvest-metadata-default-deny -j REJECT --reject-with tcp-reset',
      '-j RETURN'
    ])
    assert.doesNotMatch(cleanBoot.finalManagedChain.join('\n'), /kinvest-metadata-app-allow/)
    assert.deepEqual(cleanBoot.finalForward, [
      '-j KINVEST-METADATA',
      '-j DOCKER-USER',
      '-j PREEXISTING-FORWARD'
    ])
    assert.deepEqual(cleanBoot.finalDockerUser, ['-j KINVEST-METADATA', '-j RETURN'])
    assert.doesNotMatch(
      cleanBoot.finalForward.join('\n'),
      /kinvest-metadata-(?:docker-start|normalization)-guard/
    )

    const activeState = runWrapperActivationFixture(wrapperText, fixture, 'active')
    assert.equal(activeState.result.status, 0, activeState.result.stderr)
    assert.match(activeState.operations, /^reconcile:/)
    assert.notEqual(activeState.operations.trim().slice('reconcile:'.length), activeState.config)
    assert.equal(activeState.events[0], 'flock', 'the lock must be acquired before snapshot hashing and reconciliation')
    assert.equal(activeState.events[1], 'mktemp', 'the snapshot must be created only after acquiring the lock')
    assert.match(activeState.events[2], /^sha256:/)
    assert.equal(activeState.events[3], activeState.operations.trim())
    assert.equal(
      activeState.events[2].slice('sha256:'.length),
      activeState.events[3].slice('reconcile:'.length),
      'hashing and reconciliation must use the same immutable snapshot'
    )
    assert.deepEqual(activeState.snapshots, [], 'the active config snapshot must be removed after success')
    const missingModuleActiveReconcile = runWrapperActivationFixture(wrapperText, fixture, 'missing-module', {
      moduleMissing: true,
      productionLibrary: library
    })
    assert.notEqual(missingModuleActiveReconcile.result.status, 0)
    assert.equal(missingModuleActiveReconcile.result.stderr, 'METADATA_BR_NETFILTER_MODULE_MISSING\n')
    assert.equal(missingModuleActiveReconcile.operations, '')
    assert.deepEqual(missingModuleActiveReconcile.events, [])
    const denyAllState = runWrapperActivationFixture(wrapperText, fixture, 'deny-all', {
      stateSource: 'version=1\nmode=deny-all\nconfig_sha256=__CONFIG_SHA256__\n'
    })
    assert.equal(denyAllState.result.status, 0, denyAllState.result.stderr)
    assert.match(denyAllState.operations, /^reconcile-deny-all:/)
    assert.notEqual(denyAllState.operations.trim().slice('reconcile-deny-all:'.length), denyAllState.config)
    assert.equal(denyAllState.events[0], 'flock')
    assert.equal(denyAllState.events[1], 'mktemp')
    assert.match(denyAllState.events[2], /^sha256:/)
    assert.equal(denyAllState.events[3], denyAllState.operations.trim())
    assert.doesNotMatch(denyAllState.events.join('\n'), /^(?:iptables|iptables-restore|docker)$/m)
    assert.deepEqual(denyAllState.snapshots, [], 'the deny-all config snapshot must be removed after success')
    const pendingDeploy = runWrapperActivationFixture(wrapperText, fixture, 'pending-deploy', {
      action: 'reconcile',
      stateSource: 'version=1\nmode=pending\nconfig_sha256=__CONFIG_SHA256__\n'
    })
    assert.equal(pendingDeploy.result.status, 0, pendingDeploy.result.stderr)
    assert.equal(pendingDeploy.operations, `reconcile:${pendingDeploy.config}\n`)
    assert.deepEqual(pendingDeploy.snapshots, [], 'deployment reconcile must not create an active-state snapshot')
    const unconfirmedDenyAllActivation = runWrapperActivationFixture(wrapperText, fixture, 'unconfirmed-deny-all', {
      action: 'activate-deny-all',
      actionArgs: ['activate-deny-all']
    })
    assert.notEqual(unconfirmedDenyAllActivation.result.status, 0)
    assert.match(unconfirmedDenyAllActivation.activationStateSource, /^version=1\nmode=active\n/)
    assert.doesNotMatch(unconfirmedDenyAllActivation.events.join('\n'), /^(?:iptables|iptables-restore|docker)$/m)
    const confirmedDenyAllActivation = runWrapperActivationFixture(wrapperText, fixture, 'confirmed-deny-all', {
      action: 'activate-deny-all',
      actionArgs: ['activate-deny-all', '--confirm-deny-all']
    })
    assert.equal(confirmedDenyAllActivation.result.status, 0, confirmedDenyAllActivation.result.stderr)
    assert.equal(
      confirmedDenyAllActivation.activationStateSource,
      `version=1\nmode=deny-all\nconfig_sha256=${confirmedDenyAllActivation.configHash}\n`
    )
    assert.equal(confirmedDenyAllActivation.operations, '')
    assert.doesNotMatch(confirmedDenyAllActivation.events.join('\n'), /^(?:iptables|iptables-restore|docker)$/m)
    assert.equal(confirmedDenyAllActivation.activationStateMode, 0o600)
    const stateTempSyncIndex = confirmedDenyAllActivation.events.findIndex(
      (event) => /^sync:.*metadata-network[.]state[.][0-9]+[.]/.test(event)
    )
    const stateRenameIndex = confirmedDenyAllActivation.events.findIndex(
      (event) => /^mv:-f -- .*metadata-network[.]state[.][0-9]+[.]\S+ .*metadata-network[.]state$/.test(event)
    )
    const stateParentSyncIndex = confirmedDenyAllActivation.events.indexOf(
      `sync:${path.dirname(path.join(path.dirname(confirmedDenyAllActivation.config), 'state', 'metadata-network.state'))}`
    )
    assert.ok(stateTempSyncIndex >= 0, 'the completed activation state temp file must be fsynced')
    assert.ok(stateRenameIndex > stateTempSyncIndex, 'the state temp file must be fsynced before atomic rename')
    assert.ok(stateParentSyncIndex > stateRenameIndex, 'the activation state parent must be fsynced after rename')
    assert.deepEqual(confirmedDenyAllActivation.activationStateTemps, [])

    const tempSyncFailure = runWrapperActivationFixture(wrapperText, fixture, 'deny-all-temp-sync-failure', {
      action: 'activate-deny-all',
      actionArgs: ['activate-deny-all', '--confirm-deny-all'],
      syncFailure: 'temp'
    })
    assert.notEqual(tempSyncFailure.result.status, 0)
    assert.match(tempSyncFailure.activationStateSourceAfterFirst, /^version=1\nmode=active\n/)
    assert.doesNotMatch(tempSyncFailure.eventsAfterFirst.join('\n'), /^mv:/m)
    assert.doesNotMatch(tempSyncFailure.eventsAfterFirst.join('\n'), /^(?:iptables|iptables-restore|docker)$/m)
    assert.deepEqual(tempSyncFailure.activationStateTemps, [])

    const parentSyncFailure = runWrapperActivationFixture(wrapperText, fixture, 'deny-all-parent-sync-failure', {
      action: 'activate-deny-all',
      actionArgs: ['activate-deny-all', '--confirm-deny-all'],
      syncFailure: 'parent'
    })
    assert.notEqual(parentSyncFailure.result.status, 0)
    assert.equal(
      parentSyncFailure.activationStateSourceAfterFirst,
      `version=1\nmode=deny-all\nconfig_sha256=${parentSyncFailure.configHash}\n`
    )
    assert.match(parentSyncFailure.eventsAfterFirst.join('\n'), /^mv:/m)
    assert.doesNotMatch(parentSyncFailure.eventsAfterFirst.join('\n'), /^(?:iptables|iptables-restore|docker)$/m)
    assert.deepEqual(parentSyncFailure.activationStateTemps, [])

    /** @type {Array<[string, { activationParentSymlink?: boolean, activationParentStat?: string }]>} */
    const rejectedActivationParents = [
      ['symlink', { activationParentSymlink: true }],
      ['wrong-owner', { activationParentStat: '1000:0:700' }],
      ['wrong-group', { activationParentStat: '0:1000:700' }],
      ['group-writable', { activationParentStat: '0:0:770' }],
      ['other-writable', { activationParentStat: '0:0:707' }]
    ]
    for (const [name, parentOptions] of rejectedActivationParents) {
      const rejectedParent = runWrapperActivationFixture(wrapperText, fixture, `deny-all-parent-${name}`, {
        action: 'activate-deny-all',
        actionArgs: ['activate-deny-all', '--confirm-deny-all'],
        ...parentOptions
      })
      assert.notEqual(rejectedParent.result.status, 0, `${name} activation parent must fail closed`)
      assert.match(rejectedParent.activationStateSourceAfterFirst, /^version=1\nmode=active\n/)
      assert.doesNotMatch(rejectedParent.eventsAfterFirst.join('\n'), /^(?:sync:|mv:|iptables|iptables-restore|docker)/m)
      assert.deepEqual(rejectedParent.activationStateTemps, [])
    }

    const activationBoundary = runWrapperActivationFixture(wrapperText, fixture, 'deny-all-boundary', {
      action: 'activate-deny-all',
      actionArgs: ['activate-deny-all', '--confirm-deny-all'],
      followUpArgs: ['reconcile-active']
    })
    assert.equal(activationBoundary.result.status, 0, activationBoundary.result.stderr)
    assert.equal(activationBoundary.operationsAfterFirst, '')
    assert.doesNotMatch(activationBoundary.eventsAfterFirst.join('\n'), /^(?:iptables|iptables-restore|docker|reconcile)/m)
    assert.equal(
      activationBoundary.activationStateSourceAfterFirst,
      `version=1\nmode=deny-all\nconfig_sha256=${activationBoundary.configHash}\n`
    )
    assert.equal(activationBoundary.followUpResult.status, 0, activationBoundary.followUpResult.stderr)
    assert.match(activationBoundary.operations, /^reconcile-deny-all:/)
    const rejectedActivationStates = [
      ['pending', { stateSource: 'version=1\nmode=pending\nconfig_sha256=__CONFIG_SHA256__\n' }],
      ['old-incompatible-mode', { stateSource: 'version=1\nmode=deny\nconfig_sha256=__CONFIG_SHA256__\n' }],
      ['missing', { missingState: true }],
      ['wrong-version', { stateSource: 'version=2\nmode=active\nconfig_sha256=__CONFIG_SHA256__\n' }],
      ['wrong-order', { stateSource: 'mode=active\nversion=1\nconfig_sha256=__CONFIG_SHA256__\n' }],
      ['extra-line', { stateSource: 'version=1\nmode=active\nconfig_sha256=__CONFIG_SHA256__\nunexpected=value\n' }],
      ['hash-mismatch', { stateSource: `version=1\nmode=active\nconfig_sha256=${'0'.repeat(64)}\n` }],
      ['deny-all-hash-mismatch', { stateSource: `version=1\nmode=deny-all\nconfig_sha256=${'0'.repeat(64)}\n` }],
      ['insecure-mode', { activationStat: '0:0:640' }],
      ['wrong-owner', { activationStat: '1000:0:600' }],
      ['wrong-group', { activationStat: '0:1000:600' }],
      ['replaced-state', { activationIdentity: '1:2', activationFdIdentity: '1:3' }],
      ['deny-all-replaced-state', {
        stateSource: 'version=1\nmode=deny-all\nconfig_sha256=__CONFIG_SHA256__\n',
        activationIdentity: '1:2',
        activationFdIdentity: '1:3'
      }],
      ['symlink', { activationSymlink: true }]
    ]
    for (const [name, options] of rejectedActivationStates) {
      const rejected = runWrapperActivationFixture(wrapperText, fixture, name, options)
      assert.notEqual(rejected.result.status, 0, `${name} activation state must fail closed`)
      assert.equal(rejected.operations, '', `${name} must fail before firewall reconciliation`)
      assert.doesNotMatch(rejected.events.join('\n'), /^(?:iptables|iptables-restore|docker|reconcile:)/m)
      assert.deepEqual(rejected.snapshots, [], `${name} must remove the config snapshot after failure`)
    }
    assert.match(dropInText, /ExecStartPre=.* guard/)
    assert.match(dropInText, /ExecStopPost=.* guard/)
    assert.match(serviceText, /^Requisite=docker\.service$/m)
    assert.match(serviceText, /^After=docker\.service$/m)
    assert.doesNotMatch(serviceText, /^Requires=docker\.service$/m)
    assert.match(serviceText, /^ExecStart=\/usr\/local\/sbin\/kinvest-metadata-firewall reconcile-active$/m)
    assert.doesNotMatch(serviceText, /^ExecStartPost=/m)
    assert.match(timerText, /^Unit=kinvest-metadata-firewall\.service$/m)
    assert.match(wrapperText, /activate-deny-all --confirm-deny-all/)
    assert.match(wrapperText, /kinvest_metadata_reconcile_deny_all/)
    assert.match(wrapperText, /^KMF_SYNC=\/usr\/bin\/sync$/m)
    assert.ok(
      wrapperText.indexOf('kinvest_assert_secure_state_directory') <
        wrapperText.indexOf('kmf_activation_state_tmp=$(mktemp'),
      'the activation state parent must be rejected before creating a state temp file'
    )
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
    assert.match(operationsText, /T6[\s\S]*activate-deny-all --confirm-deny-all/i)
    assert.match(operationsText, /Kinvest[\s\S]{0,120}Nginx[\s\S]{0,160}temporary bridge containers/i)
    assert.match(operationsText, /T7[\s\S]{0,160}separate approval/i)
    assert.match(operationsText, /no CAM or SSM/i)
    assert.match(
      operationsText,
      /`reconcile-active`[\s\S]{0,700}`mode=active`[\s\S]{0,240}`mode=deny-all`[\s\S]{0,700}dispatch/i
    )
    assert.match(
      operationsText,
      /pending[\s\S]{0,200}(?:unknown|unsupported)[\s\S]{0,200}fail(?:s)? closed/i
    )
    assert.doesNotMatch(
      operationsText,
      /`reconcile-active`[\s\S]{0,500}requires[\s\S]{0,200}exactly `version=1`, `mode=active`/i
    )
    const t6RollbackStart = operationsText.indexOf('### T6 rollback')
    const t6RollbackEnd = operationsText.indexOf('## Apply and status', t6RollbackStart)
    assert.ok(t6RollbackStart >= 0 && t6RollbackEnd > t6RollbackStart)
    const t6RollbackText = operationsText.slice(t6RollbackStart, t6RollbackEnd)
    const rollbackPublicationSequence = [
      'set -eu',
      'state_tmp="$(mktemp "$state_directory/.metadata-network.state.XXXXXX")"',
      'chown root:root "$state_tmp"',
      'chmod 0600 "$state_tmp"',
      '/usr/bin/sync "$state_tmp"',
      'mv -f -- "$state_tmp" "$state_directory/metadata-network.state"',
      '/usr/bin/sync "$state_directory"',
      '/usr/local/sbin/kinvest-metadata-firewall reconcile-active'
    ]
    const rollbackPublicationIndexes = rollbackPublicationSequence.map((step) => t6RollbackText.indexOf(step))
    assert.ok(
      rollbackPublicationIndexes.every((index) => index >= 0),
      'allow-mode rollback must document every strict durable publication step'
    )
    assert.deepEqual(
      [...rollbackPublicationIndexes].sort((left, right) => left - right),
      rollbackPublicationIndexes,
      'allow-mode rollback durability barriers must precede rename and reconciliation in order'
    )
    assert.doesNotMatch(
      t6RollbackText,
      /mv -f -- "\$state_tmp"[^\n]*metadata-network[.]state\n\s+\/usr\/local\/sbin\/kinvest-metadata-firewall reconcile-active/,
      'allow-mode rollback must not publish state with a bare unsynced rename'
    )
    assert.doesNotMatch(operationsText, /\bins-[a-z0-9]+\b/i)
    assert.doesNotMatch(operationsText, /\b2\.35\.1\b/)
  } finally {
    if (previousBridgeNetfilterModulePath === undefined) {
      delete process.env.KMF_BR_NETFILTER_MODULE_PATH
    } else {
      process.env.KMF_BR_NETFILTER_MODULE_PATH = previousBridgeNetfilterModulePath
    }
    if (previousBridgeNfCallIptablesPath === undefined) {
      delete process.env.KMF_BRIDGE_NF_CALL_IPTABLES_PATH
    } else {
      process.env.KMF_BRIDGE_NF_CALL_IPTABLES_PATH = previousBridgeNfCallIptablesPath
    }
    fs.rmSync(fixture, { recursive: true, force: true })
  }
}

module.exports = { run }
