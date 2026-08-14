# Kinvest T7 br_netfilter Persistence Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the metadata deny-all boundary survive a clean CVM boot by loading bridge netfilter prerequisites before Docker, failing Docker startup closed when they are absent, and reconciling the final Docker rules immediately after daemon initialization.

**Architecture:** Keep the reviewed iptables-nft rule model. Add explicit module/sysctl assets, a wrapper prerequisite verifier, Docker pre/post lifecycle gates, and a new atomic installer with backup and rollback. Production remains stopped until the PR is merged and each installation, Docker-start, second-reboot, and RESTORE gate is separately approved.

**Tech Stack:** POSIX shell, systemd, Linux `br_netfilter`, sysctl, iptables-nft, Node.js built-in test runner, GitHub Actions.

---

## File structure

- Create `deploy/server/kinvest-br-netfilter.modules-load.conf`: canonical modules-load source asset.
- Create `deploy/server/kinvest-br-netfilter.sysctl.conf`: canonical sysctl source asset.
- Create `deploy/server/install-metadata-firewall.sh`: root-only atomic installer and rollback handler; it never starts Docker.
- Create `deploy/server/metadata-firewall-assets.sha256`: immutable hashes for every installed source asset.
- Create `server/tests/metadata-firewall-installer.test.js`: behavioral installer model with fake host commands and filesystem.
- Modify `deploy/server/kinvest-metadata-firewall-lib.sh`: bridge-netfilter prerequisite verifier and fail-closed guard integration.
- Modify `deploy/server/kinvest-metadata-firewall.sh`: testable prerequisite paths and the `verify-bridge-netfilter` command.
- Modify `deploy/server/docker-kinvest-metadata-firewall.conf`: prerequisite check before Docker and immediate reconciliation after Docker.
- Modify `server/tests/metadata-firewall-contract.test.js`: reboot regression, prerequisite, lifecycle-order, and asset tests.
- Modify `server/tests/run-tests.js`: register the installer test exactly once.
- Modify `docs/operations/2026-08-11-metadata-ssm-rollout.md`: replace the obsolete T7 assumption with the repaired boot contract and approval gates.
- Create `docs/operations/2026-08-14-t7-br-netfilter-incident.md`: non-secret incident evidence, containment, recovery, and acceptance record.

### Task 1: Add the bridge-netfilter fail-closed runtime contract

**Files:**
- Modify: `server/tests/metadata-firewall-contract.test.js`
- Modify: `deploy/server/kinvest-metadata-firewall-lib.sh`
- Modify: `deploy/server/kinvest-metadata-firewall.sh`

- [ ] **Step 1: Add fixture paths and failing prerequisite tests**

Extend the wrapper fixture with two controlled paths and set them in the spawned environment:

```js
const modulePath = path.join(fixture, 'sys', 'module', 'br_netfilter')
const sysctlPath = path.join(fixture, 'proc', 'sys', 'net', 'bridge', 'bridge-nf-call-iptables')

if (options.modulePresent !== false) fs.mkdirSync(modulePath, { recursive: true })
if (options.sysctlValue !== undefined) {
  fs.mkdirSync(path.dirname(sysctlPath), { recursive: true })
  fs.writeFileSync(sysctlPath, `${options.sysctlValue}\n`)
}

const env = {
  ...process.env,
  KMF_BR_NETFILTER_MODULE_PATH: modulePath,
  KMF_BRIDGE_NF_CALL_IPTABLES_PATH: sysctlPath
}
```

Add assertions for all four states:

```js
for (const [name, options, errorCode] of [
  ['module-missing', { modulePresent: false, sysctlValue: '1' }, 'METADATA_BR_NETFILTER_MODULE_MISSING'],
  ['sysctl-missing', { modulePresent: true }, 'METADATA_BR_NETFILTER_SYSCTL_MISSING'],
  ['sysctl-zero', { modulePresent: true, sysctlValue: '0' }, 'METADATA_BR_NETFILTER_SYSCTL_DISABLED'],
  ['sysctl-malformed', { modulePresent: true, sysctlValue: '1  ' }, 'METADATA_BR_NETFILTER_SYSCTL_INVALID']
]) {
  const result = runWrapperFixture(wrapperText, fixture, name, {
    ...options,
    actionArgs: ['verify-bridge-netfilter']
  })
  assert.notEqual(result.result.status, 0)
  assert.match(result.result.stderr, new RegExp(`^${errorCode}\\n$`))
  assert.equal(result.operations, '')
}

const valid = runWrapperFixture(wrapperText, fixture, 'bridge-netfilter-valid', {
  modulePresent: true,
  sysctlValue: '1',
  actionArgs: ['verify-bridge-netfilter']
})
assert.equal(valid.result.status, 0, valid.result.stderr)
assert.equal(valid.operations, '')
```

- [ ] **Step 2: Run the focused contract test and observe RED**

Run:

```bash
node -e "require('./server/tests/metadata-firewall-contract.test').run()"
```

Expected: FAIL because `verify-bridge-netfilter` is rejected by wrapper usage or the prerequisite function is absent.

- [ ] **Step 3: Implement the minimal prerequisite verifier**

Add fixed defaults near the wrapper path constants:

```sh
KMF_BR_NETFILTER_MODULE_PATH=${KMF_BR_NETFILTER_MODULE_PATH:-/sys/module/br_netfilter}
KMF_BRIDGE_NF_CALL_IPTABLES_PATH=${KMF_BRIDGE_NF_CALL_IPTABLES_PATH:-/proc/sys/net/bridge/bridge-nf-call-iptables}
```

Add this library function and call it at the start of `kinvest_metadata_guard`:

```sh
kinvest_metadata_verify_bridge_netfilter() {
  [ -d "$KMF_BR_NETFILTER_MODULE_PATH" ] || {
    printf '%s\n' METADATA_BR_NETFILTER_MODULE_MISSING >&2
    return 1
  }
  [ -f "$KMF_BRIDGE_NF_CALL_IPTABLES_PATH" ] &&
    [ ! -L "$KMF_BRIDGE_NF_CALL_IPTABLES_PATH" ] || {
      printf '%s\n' METADATA_BR_NETFILTER_SYSCTL_MISSING >&2
      return 1
    }
  IFS= read -r kmf_bridge_nf_value < "$KMF_BRIDGE_NF_CALL_IPTABLES_PATH" || {
    printf '%s\n' METADATA_BR_NETFILTER_SYSCTL_INVALID >&2
    return 1
  }
  case "$kmf_bridge_nf_value" in
    1) return 0 ;;
    0)
      printf '%s\n' METADATA_BR_NETFILTER_SYSCTL_DISABLED >&2
      return 1
      ;;
    *)
      printf '%s\n' METADATA_BR_NETFILTER_SYSCTL_INVALID >&2
      return 1
      ;;
  esac
}
```

Add `verify-bridge-netfilter` to the exact usage/case grammar and dispatch it directly to `kinvest_metadata_verify_bridge_netfilter`. Do not require iptables, Docker, config, activation state, or the deployment lock for this read-only command.

- [ ] **Step 4: Prove guard and reconciliation fail before touching iptables**

Add test cases invoking `guard`, `reconcile`, and `reconcile-active` with a missing module. Each must return nonzero, emit `METADATA_BR_NETFILTER_MODULE_MISSING`, and leave the fake iptables operation log empty.

- [ ] **Step 5: Run focused tests and observe GREEN**

Run:

```bash
node -e "require('./server/tests/metadata-firewall-contract.test').run()"
/bin/sh -n deploy/server/kinvest-metadata-firewall-lib.sh
/bin/sh -n deploy/server/kinvest-metadata-firewall.sh
```

Expected: all commands exit `0`.

- [ ] **Step 6: Commit the runtime contract**

```bash
git add server/tests/metadata-firewall-contract.test.js deploy/server/kinvest-metadata-firewall-lib.sh deploy/server/kinvest-metadata-firewall.sh
git commit -m "fix: fail closed without bridge netfilter"
```

### Task 2: Persist prerequisites and close the Docker startup window

**Files:**
- Create: `deploy/server/kinvest-br-netfilter.modules-load.conf`
- Create: `deploy/server/kinvest-br-netfilter.sysctl.conf`
- Modify: `deploy/server/docker-kinvest-metadata-firewall.conf`
- Modify: `deploy/server/kinvest-metadata-firewall.sh`
- Modify: `deploy/server/kinvest-metadata-firewall-lib.sh`
- Modify: `server/tests/metadata-firewall-contract.test.js`

- [ ] **Step 1: Write failing exact-asset and ordering tests**

Add these assertions:

```js
assert.equal(fs.readFileSync(modulesLoadAsset, 'utf8'), 'br_netfilter\n')
assert.equal(
  fs.readFileSync(sysctlAsset, 'utf8'),
  'net.bridge.bridge-nf-call-iptables = 1\n'
)
assert.match(dropInText, /^ExecStartPre=\+\/usr\/local\/sbin\/kinvest-metadata-firewall verify-bridge-netfilter$/m)
assert.match(dropInText, /^ExecStartPre=\+\/usr\/local\/sbin\/kinvest-metadata-firewall boot-guard$/m)
assert.match(dropInText, /^ExecStartPre=\+\/usr\/local\/sbin\/kinvest-metadata-firewall guard$/m)
assert.match(dropInText, /^ExecStartPost=\+\/usr\/local\/sbin\/kinvest-metadata-firewall reconcile-active$/m)
assert.match(dropInText, /^ExecStopPost=\+\/usr\/local\/sbin\/kinvest-metadata-firewall boot-guard$/m)
assert.match(dropInText, /^ExecStopPost=\+\/usr\/local\/sbin\/kinvest-metadata-firewall guard$/m)
const orderedLifecycle = [
  'verify-bridge-netfilter',
  'boot-guard',
  ' guard',
  'reconcile-active'
].map((entry) => dropInText.indexOf(entry))
assert.deepEqual([...orderedLifecycle].sort((a, b) => a - b), orderedLifecycle)
```

Remove the obsolete assertion that forbids every `ExecStartPost` entry. Add a transition recorder that recognizes an equivalent metadata deny only when a first-position `mangle/PREROUTING` boot DROP, a filter guard, or the complete permanent managed policy is present. Add a negative fixture that removes the boot guard during Docker's filter rebuild and assert that continuity validation rejects it.

- [ ] **Step 2: Run the focused test and observe RED**

Run:

```bash
node -e "require('./server/tests/metadata-firewall-contract.test').run()"
```

Expected: FAIL because both assets and Docker lifecycle lines are absent.

- [ ] **Step 3: Create exact assets and implement the boot-guard lifecycle**

Create `deploy/server/kinvest-br-netfilter.modules-load.conf`:

```text
br_netfilter
```

Create `deploy/server/kinvest-br-netfilter.sysctl.conf`:

```text
net.bridge.bridge-nf-call-iptables = 1
```

Replace the drop-in with:

```ini
[Unit]
After=systemd-modules-load.service systemd-sysctl.service

[Service]
ExecStartPre=+/usr/local/sbin/kinvest-metadata-firewall verify-bridge-netfilter
ExecStartPre=+/usr/local/sbin/kinvest-metadata-firewall boot-guard
ExecStartPre=+/usr/local/sbin/kinvest-metadata-firewall guard
ExecStartPost=+/usr/local/sbin/kinvest-metadata-firewall reconcile-active
ExecStopPost=+/usr/local/sbin/kinvest-metadata-firewall boot-guard
ExecStopPost=+/usr/local/sbin/kinvest-metadata-firewall guard
```

Add `boot-guard` to the wrapper's exact action grammar and dispatch it to a library operation that installs this rule at position 1:

```sh
iptables -w 5 -t mangle -I PREROUTING 1 \
  -d 169.254.0.23/32 -p tcp --dport 80 \
  -m comment --comment kinvest-metadata-docker-boot-guard -j DROP
```

The operation must be idempotent and verify that the rule is first. After either the active or deny-all permanent policy has reconciled and passed its final status verification, `reconcile-active` removes every matching boot guard. A reconciliation failure must return before removal, leaving the boot guard in place for the non-ignored `ExecStartPost` failure and the stop-post reinstall.

- [ ] **Step 4: Model the clean-boot sequence**

Add one test that first runs the pre-start verifier with no module and expects failure, then creates the module/sysctl fixtures and runs verifier, `boot-guard`, and filter `guard` through the real wrapper/library behavior. Starting from that actual pre-start state, simulate Docker removing the filter guard and rebuilding `FORWARD` and `DOCKER-USER` step by step. Record every observable transition and assert that the independent first-position `mangle/PREROUTING` DROP remains through the containers-ready boundary.

Run `reconcile-active` with deny-all activation and assert the final managed chain contains exactly the metadata REJECT plus `RETURN`, contains no app allow, has the reviewed final jumps, and no longer contains the boot guard. Add a negative fixture in which Docker also removes the boot guard and assert that the continuity contract fails. Add a lifecycle fixture in which `reconcile-active` fails and assert that the non-ignored `ExecStartPost` marks Docker failed/stopped, executes stop-post guards, and never leaves the modeled service serving unprotected.

- [ ] **Step 5: Run the focused test and observe GREEN**

Run:

```bash
node -e "require('./server/tests/metadata-firewall-contract.test').run()"
/bin/sh -n deploy/server/kinvest-metadata-firewall-lib.sh
/bin/sh -n deploy/server/kinvest-metadata-firewall.sh
```

Expected: all commands exit `0`.

- [ ] **Step 6: Commit boot assets and lifecycle ordering**

```bash
git add deploy/server/kinvest-br-netfilter.modules-load.conf deploy/server/kinvest-br-netfilter.sysctl.conf deploy/server/docker-kinvest-metadata-firewall.conf deploy/server/kinvest-metadata-firewall.sh deploy/server/kinvest-metadata-firewall-lib.sh server/tests/metadata-firewall-contract.test.js
git commit -m "fix: guard metadata across Docker startup"
```

### Task 3: Add an atomic metadata-firewall installer

**Files:**
- Create: `deploy/server/install-metadata-firewall.sh`
- Create: `deploy/server/metadata-firewall-assets.sha256`
- Create: `server/tests/metadata-firewall-installer.test.js`
- Modify: `server/tests/run-tests.js`

- [ ] **Step 1: Write a failing installer behavior test**

Build a temporary fake root and fake `modprobe`, `sysctl`, `systemctl`, and `sha256sum` binaries. Execute a test-adjusted copy of the installer and assert:

```js
assert.equal(result.status, 0, result.stderr)
assert.equal(fileMode(targets.wrapper), 0o755)
assert.equal(fileMode(targets.library), 0o755)
assert.equal(fileMode(targets.service), 0o644)
assert.equal(fileMode(targets.timer), 0o644)
assert.equal(fileMode(targets.dropIn), 0o644)
assert.equal(fileMode(targets.modulesLoad), 0o644)
assert.equal(fileMode(targets.sysctl), 0o644)
assert.match(operations, /^modprobe:br_netfilter$/m)
assert.match(operations, /^sysctl:--load .*90-kinvest-br-netfilter[.]conf$/m)
assert.match(operations, /^systemctl:daemon-reload$/m)
assert.doesNotMatch(operations, /systemctl:(?:start|restart):?docker/)
```

Add failure cases for a manifest mismatch, module-load failure, sysctl failure, and prerequisite-verification failure. Assert previous assets are restored and absent assets are removed only when the backup manifest marks them absent.

- [ ] **Step 2: Register the test and observe RED**

Add exactly one entry to `server/tests/run-tests.js`:

```js
require('./metadata-firewall-installer.test'),
```

Run:

```bash
node -e "require('./server/tests/metadata-firewall-installer.test').run()"
```

Expected: FAIL because the installer does not exist.

- [ ] **Step 3: Implement the root-only installer**

The installer accepts one non-secret repository root argument:

```text
Usage: install-metadata-firewall.sh <verified-repository-root>
```

It must perform this exact order:

```sh
test "$(id -u)" -eq 0
cd "$source_root"
sha256sum -c deploy/server/metadata-firewall-assets.sha256
install -d -o root -g root -m 0700 "$backup_dir"
# Record present/absent state, copy existing assets, then stage every replacement.
# Verify staged modes and shell syntax.
# Atomically rename staged files into their target directories.
modprobe br_netfilter
sysctl --load /etc/sysctl.d/90-kinvest-br-netfilter.conf
/usr/local/sbin/kinvest-metadata-firewall verify-bridge-netfilter
systemctl daemon-reload
```

Target mappings are fixed in the script:

```text
kinvest-metadata-firewall-lib.sh -> /usr/local/libexec/kinvest-metadata-firewall-lib.sh (0755)
kinvest-metadata-firewall.sh -> /usr/local/sbin/kinvest-metadata-firewall (0755)
kinvest-metadata-firewall.service -> /etc/systemd/system/kinvest-metadata-firewall.service (0644)
kinvest-metadata-firewall.timer -> /etc/systemd/system/kinvest-metadata-firewall.timer (0644)
docker-kinvest-metadata-firewall.conf -> /etc/systemd/system/docker.service.d/kinvest-metadata-firewall.conf (0644)
kinvest-br-netfilter.modules-load.conf -> /etc/modules-load.d/kinvest-br-netfilter.conf (0644)
kinvest-br-netfilter.sysctl.conf -> /etc/sysctl.d/90-kinvest-br-netfilter.conf (0644)
```

The error trap restores the recorded present files, removes only recorded-absent targets, runs `systemctl daemon-reload`, prints one stable failure code plus backup path, and never starts Docker.

- [ ] **Step 4: Generate the exact asset manifest**

Run from repository root after implementation is stable:

```bash
sha256sum \
  deploy/server/kinvest-metadata-firewall-lib.sh \
  deploy/server/kinvest-metadata-firewall.sh \
  deploy/server/kinvest-metadata-firewall.service \
  deploy/server/kinvest-metadata-firewall.timer \
  deploy/server/docker-kinvest-metadata-firewall.conf \
  deploy/server/kinvest-br-netfilter.modules-load.conf \
  deploy/server/kinvest-br-netfilter.sysctl.conf \
  > deploy/server/metadata-firewall-assets.sha256
```

- [ ] **Step 5: Run installer tests and observe GREEN**

Run:

```bash
node -e "require('./server/tests/metadata-firewall-installer.test').run()"
/bin/sh -n deploy/server/install-metadata-firewall.sh
```

Expected: exit `0` and no Docker start/restart operation in the fixture log.

- [ ] **Step 6: Commit the installer**

```bash
git add deploy/server/install-metadata-firewall.sh deploy/server/metadata-firewall-assets.sha256 server/tests/metadata-firewall-installer.test.js server/tests/run-tests.js
git commit -m "feat: install metadata firewall atomically"
```

### Task 4: Document the incident and controlled recovery

**Files:**
- Modify: `server/tests/metadata-firewall-contract.test.js`
- Modify: `docs/operations/2026-08-11-metadata-ssm-rollout.md`
- Create: `docs/operations/2026-08-14-t7-br-netfilter-incident.md`
- Modify: `docs/superpowers/specs/2026-08-14-t7-br-netfilter-persistence-design.md`

- [ ] **Step 1: Add failing documentation contract assertions**

Require the operations text to contain all of these concepts:

```js
assert.match(operationsText, /br_netfilter/i)
assert.match(operationsText, /bridge-nf-call-iptables[\s\S]{0,80}(?:exactly|must be)[\s\S]{0,40}`?1`?/i)
assert.match(operationsText, /Docker[\s\S]{0,160}fail(?:s)? closed/i)
assert.match(operationsText, /ExecStartPost[\s\S]{0,160}reconcile-active/i)
assert.match(operationsText, /second CVM reboot[\s\S]{0,200}separate approval/i)
assert.match(operationsText, /RESTORE[\s\S]{0,160}Production approval/i)
```

- [ ] **Step 2: Run focused tests and observe RED**

Run:

```bash
node -e "require('./server/tests/metadata-firewall-contract.test').run()"
```

Expected: FAIL because the reboot prerequisite and revised recovery sequence are undocumented.

- [ ] **Step 3: Write the non-secret incident record and update the runbook**

Record only stable evidence:

```text
Detection: real bridge-container probes reached 169.254.0.23 after CVM reboot.
Containment: Docker service and socket stopped; RESTORE not triggered.
Root cause: br_netfilter and its sysctl were not persisted across boot.
Repair: modules-load + sysctl assets, pre-start verification, post-start reconciliation.
Recovery gates: install, Docker start, second reboot, RESTORE, deployment-gate reset.
```

Do not include IP credentials, secret values, bundle file contents, STS responses, or unrestricted firewall dumps.

- [ ] **Step 4: Run focused tests and observe GREEN**

Run:

```bash
node -e "require('./server/tests/metadata-firewall-contract.test').run()"
```

Expected: exit `0`.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/operations/2026-08-11-metadata-ssm-rollout.md docs/operations/2026-08-14-t7-br-netfilter-incident.md docs/superpowers/specs/2026-08-14-t7-br-netfilter-persistence-design.md server/tests/metadata-firewall-contract.test.js
git commit -m "docs: record T7 bridge filtering incident"
```

### Task 5: Verify, review, and create the repair PR

**Files:**
- Verify all files changed in Tasks 1 through 4.

- [ ] **Step 1: Install locked dependencies**

Run:

```bash
npm ci
```

Expected: exit `0`; no dependency files change.

- [ ] **Step 2: Run the complete project check**

Run:

```bash
npm run check
```

Expected: tests, build, lint, and typecheck all pass.

- [ ] **Step 3: Run shell and installer-specific verification**

Run:

```bash
/bin/sh -n deploy/server/kinvest-metadata-firewall-lib.sh
/bin/sh -n deploy/server/kinvest-metadata-firewall.sh
/bin/sh -n deploy/server/install-metadata-firewall.sh
node -e "require('./server/tests/metadata-firewall-contract.test').run()"
node -e "require('./server/tests/metadata-firewall-installer.test').run()"
git diff --check origin/main...HEAD
```

Expected: every command exits `0`.

- [ ] **Step 4: Run security checks**

Run:

```bash
npm audit --audit-level=high
git diff --name-only origin/main...HEAD | grep -E '(^|/)(\.env|.*\.pem|.*\.key)$' && exit 1 || true
git diff origin/main...HEAD | rg -n 'refresh_token|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9_]+' && exit 1 || true
```

Expected: no high/critical dependency finding and no sensitive file or value match.

- [ ] **Step 5: Request two-stage code review**

Request a specification review against the approved design, then a quality/security review focused on shell rollback, systemd ordering, and false-success paths. Address findings with a new RED/GREEN cycle rather than untested edits.

- [ ] **Step 6: Push and create the PR**

```bash
git push -u origin fix/t7-br-netfilter-persistence
gh pr create \
  --base main \
  --head fix/t7-br-netfilter-persistence \
  --title "fix: persist bridge netfilter before Docker" \
  --body-file /tmp/kinvest-t7-pr-body.md
```

The PR body must state that production Docker is intentionally stopped, the PR itself performs no production change, and installation waits for a separate approval.

- [ ] **Step 7: Wait for required checks and user merge**

Run:

```bash
gh pr checks --watch
```

Expected: `verify`, `security`, and `container-build` each pass exactly once. The user merges manually.

### Task 6: Execute post-merge production recovery gates

**Files:**
- Install only the exact assets from the PR merge commit.
- Save evidence under `/var/backups/kinvest-metadata-firewall/` with root-only permissions.

- [ ] **Step 1: Prepare exact merged assets without changing production**

Extract assets from the merge commit, verify `metadata-firewall-assets.sha256`, compare server hashes, confirm Docker service/socket remain inactive, and confirm public health remains failed closed.

- [ ] **Step 2: Pause for metadata-firewall installation approval**

Display changed target files, backup location, exact hashes, and rollback behavior. Do not install until the user explicitly approves.

- [ ] **Step 3: Install while Docker remains stopped**

Run the merged installer, then verify:

```text
/sys/module/br_netfilter exists
/proc/sys/net/bridge/bridge-nf-call-iptables equals 1
verify-bridge-netfilter exits 0
Docker service and socket remain inactive
timer remains enabled
activation state remains mode=deny-all with the same config hash
```

- [ ] **Step 4: Pause for Docker-start approval**

Explain that Kinvest must remain unavailable because the tmpfs bundle is absent. Start Docker only after explicit approval.

- [ ] **Step 5: Start Docker in fail-closed mode and prove the boundary**

Verify Docker pre/post gates, exact deny-all rules, Nginx plus temporary bridge-container denial, absent secret files, unhealthy Kinvest, and failed public health.

- [ ] **Step 6: Pause for the second CVM reboot approval**

Present current containment, installed hashes, and expected continued outage. Reboot only after explicit approval.

- [ ] **Step 7: Prove clean-boot persistence**

Verify a changed boot ID, automatically loaded module/sysctl, successful Docker pre/post gates, exact deny-all rules, failed-closed Kinvest, denied real probes, active timer, and unchanged deployment state.

- [ ] **Step 8: Pause for RESTORE configuration and Production approval**

The user sets `DEPLOY_V3_ENABLED=true`, triggers exact `RESTORE`, and approves the Production deployment. Secret values never enter chat.

- [ ] **Step 9: Verify recovery and close T7**

Confirm exact image ID, commit, schema, release provenance, VersionIds, bundle ID, healthy containers, SQLite readiness, public HTTPS, Mock mode, deny-all probes, timer success, and secret-free logs. The user restores `DEPLOY_V3_ENABLED=false` before T7 is declared complete.
