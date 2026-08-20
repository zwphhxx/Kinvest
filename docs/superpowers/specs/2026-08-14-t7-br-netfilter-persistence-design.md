# Kinvest T7 br_netfilter Persistence Repair Design

## Status and scope

This design repairs the production persistence failure discovered during the T7 CVM reboot test. It does not enable authentication, real iFinD data, model calls, CAM, SSM, or TCR. It does not modify SQLite or secret material.

Production remains intentionally fail closed while this repair is reviewed:

- Docker service and socket are stopped.
- The `/run` tmpfs secret bundle is absent after reboot.
- Kinvest is unavailable and public health returns an upstream failure.
- No RESTORE deployment has been triggered.

## Confirmed root cause

Before the CVM reboot, Docker restart validation succeeded because `br_netfilter` was already loaded. After the CVM reboot:

- `br_netfilter` was absent from the loaded module list.
- `/proc/sys/net/bridge/bridge-nf-call-iptables` did not exist.
- No modules-load or sysctl persistence entry existed.
- The firewall timer ran after Docker and reported success.
- The expected nftables-compatible rules were present, but their metadata reject counters remained zero.
- Real probes from the Nginx bridge network and a temporary bridge container reached `169.254.0.23:80`.

The current firewall implementation assumes bridged container traffic traverses the iptables/nftables forwarding hooks. That assumption is false after a clean boot unless `br_netfilter` is loaded and `net.bridge.bridge-nf-call-iptables=1`.

## Selected architecture

Retain the current iptables-nft implementation and add three layers of protection.

### Persistent kernel prerequisites

Install a root-owned mode `0644` modules-load file containing only:

```text
br_netfilter
```

Install a root-owned mode `0644` sysctl file containing only:

```text
net.bridge.bridge-nf-call-iptables = 1
```

The installer loads the module and applies the exact sysctl during the controlled repair. Normal boots rely on `systemd-modules-load.service` followed by `systemd-sysctl.service`.

### Fail-closed runtime verification

Add a stable wrapper operation that succeeds only when:

- `/sys/module/br_netfilter` exists;
- `/proc/sys/net/bridge/bridge-nf-call-iptables` exists; and
- the sysctl value is exactly `1`.

The Docker drop-in runs this verification before the existing deny guard. A missing module or incorrect sysctl makes Docker startup fail instead of allowing unfiltered bridge containers.

The firewall `guard`, `reconcile`, and `reconcile-active` paths also verify these prerequisites before reporting success. Error output uses stable codes and contains no host, container, secret, or credential data.

### Docker lifecycle ordering

Docker owns and may rebuild the filter-layer `FORWARD` and `DOCKER-USER` chains during daemon startup, so the filter pre-start guard is not the startup continuity boundary. Before Docker starts, the wrapper installs a first-position `mangle/PREROUTING` rule that drops TCP traffic to `169.254.0.23:80`. Docker does not own that layer, so the boot guard remains effective while Docker resets its filter chains.

The exact startup order is:

```text
ExecStartPre=verify bridge netfilter prerequisites
ExecStartPre=install first-position mangle/PREROUTING boot DROP
ExecStartPre=install filter deny guard
Docker daemon start and filter-chain rebuild
ExecStartPost=reconcile-active and verify the permanent deny
remove the boot DROP only after reconciliation succeeds
```

The `reconcile-active` command normalizes and verifies the final `FORWARD`, `DOCKER-USER`, and `KINVEST-METADATA` rules before removing the boot guard. Its `ExecStartPost` entry is not failure-ignored. If reconciliation fails, Docker startup fails and stops rather than remaining in service, the boot guard is not removed, and `ExecStopPost` reinstalls the boot guard and filter guard. There is no lifecycle state in which Docker is allowed to keep serving without either the temporary boot DROP or the verified permanent metadata deny.

The boot guard deliberately overblocks all prerouted TCP traffic to `169.254.0.23:80`, including the approved Kinvest application path, during the short Docker startup and recovery interval. This is acceptable because fail-closed startup takes precedence over application availability, and the rule is temporary: it is removed only after the permanent policy is verified. The change does not add an `OUTPUT` rule or block host-generated traffic, so Tencent Cloud host-agent behavior is unchanged.

## Installation and rollback

A dedicated metadata-firewall installer is added to manage the existing runtime assets, the two new configuration assets, and the Docker drop-in as one versioned installation set. The repository currently has no standalone installer for this subsystem; prior installations used audited manual commands.

Installation rules:

- Verify source hashes and syntax before changing the host.
- Back up existing files and record whether each new file was previously absent.
- Make the independent Docker recovery interlock the first durable target-side change. Atomically install and sync it in the identity-bound Docker drop-in directory, run `daemon-reload`, and verify its exact contract before writing an incomplete transaction phase or staging/replacing any runtime asset.
- Install with same-filesystem temporary files and atomic rename.
- Load `br_netfilter`, apply only the Kinvest sysctl file, and verify the exact runtime values.
- On Linux, compare the opened sysctl file descriptor with the validated path by device and inode using explicitly dereferenced `stat -L`; keep the original path's non-symlink and before/after identity checks.
- Do not start Docker or reconstruct the secret bundle during installation.

Rollback rules:

- Restore every replaced file from the timestamped backup.
- Remove a newly introduced file only when the manifest proves it was absent before installation.
- Reload the previous module/sysctl configuration where possible.
- Retain the durable Docker interlock for every incomplete or failed transaction, including file-restore, module, sysctl, wrapper, independent verifier, phase, and `daemon-reload` failures.
- Keep Docker stopped if the previous configuration cannot prove bridge traffic is filtered.
- Never use a successful command exit as a substitute for a real metadata-denial probe.

An absent or unsafe prior persistent sysctl, a failed prior-config reload, or an unsafe prior runtime value is not an automatically recovered state. Rollback preserves the live value `1`, retains the timestamped backup and transaction, records phase `operator-required`, and exits nonzero with a stable diagnostic. Every transaction first atomically installs and durably syncs `/etc/systemd/system/docker.service.d/00-kinvest-metadata-recovery-interlock.conf` as root-owned mode `0644`, reloads systemd, and verifies its exact contents before the transaction can become incomplete. Its self-contained `ExecStartPre=/bin/false` blocks Docker without invoking repository code, including after reboot if a later systemd reload fails.

A later installer invocation may safely supersede an `operator-required` transaction. There is one interlock-removal invariant: all exact files must be durable; the persistent module and sysctl assets must be safe; `modprobe` and the exact sysctl load must succeed; both the installed wrapper and the installer's independent `stat -L` bridge-prerequisite verifier must pass; and a first `daemon-reload` must succeed while the interlock remains present. Only then may the installer durably record `safe-committed`, atomically remove and sync the exact validated interlock, and perform the final `daemon-reload`. If that final reload fails, the installer immediately recreates and syncs the interlock, attempts to reload it, retains an incomplete/operator-required phase, and exits nonzero. Only a successful final reload allows older operator transactions to become `superseded` and the new transaction to become `committed`. Crash recovery resumes from `safe-committed`; it never marks a partial rollback `recovered` and never unblocks Docker before a durable safe state exists.

## Automated test design

Tests are written before implementation and must first fail for the missing behavior.

- A missing `br_netfilter` module makes prerequisite verification fail.
- A missing sysctl node makes verification fail.
- Sysctl values other than exact `1` fail.
- Valid prerequisites allow guard and reconciliation to proceed.
- Docker cannot start when prerequisite verification fails.
- Docker post-start invokes `reconcile-active` before the unit is considered successful.
- A modeled Docker start begins from guards installed by the real wrapper, records each filter-chain rebuild transition, and proves that the independent `mangle/PREROUTING` boot DROP remains while Docker removes the filter guard.
- A negative continuity fixture models Docker removing the boot guard as well as rebuilding its filter chains; the contract must fail before the containers-ready boundary.
- A failed non-ignored `ExecStartPost` reconciliation stops the modeled Docker service and leaves or reinstalls the boot guard instead of serving unprotected.
- Successful post-start reconciliation ends with the exact deny-all chain and removes the boot guard only after the permanent policy is verified.
- The installer manages module, sysctl, drop-in, hashes, modes, backup, and rollback without starting Docker.
- A crash immediately before the first runtime replacement still leaves the durable interlock, and reinvocation cannot release it without satisfying the single removal invariant.
- Module, restore, verifier, and consecutive reload failures retain the interlock; a failed final release reload recreates it before returning failure.
- PR `verify`, `security`, and `container-build` checks remain secret-free.

## Controlled production recovery

Production recovery remains split into explicit gates.

1. Merge the repair PR after all required checks pass.
2. Approve installation while Docker remains stopped.
3. Verify the module, sysctl, installed hashes, timer, and persistent activation state.
4. Approve starting Docker without a secret bundle. Kinvest must remain failed closed, Nginx may return an upstream error, and real metadata probes must be denied.
5. Approve a second CVM reboot while the application is already unavailable. After boot, verify that the module and sysctl loaded automatically, Docker passed its gates, Kinvest remains failed closed, and metadata probes are denied.
6. Set `DEPLOY_V3_ENABLED=true`, trigger the exact `RESTORE` workflow, and approve the Production deployment.
7. Verify the exact image and state, tmpfs bundle, internal and public health, Mock mode, deny-all boundary, timer, and secret-free logs.
8. Restore `DEPLOY_V3_ENABLED=false`.

The second reboot is required because restarting services cannot prove modules-load persistence across a clean kernel boot. Performing it before RESTORE avoids reconstructing the secret bundle twice.

## Acceptance criteria

- A clean CVM boot loads `br_netfilter` and sets `bridge-nf-call-iptables=1` before Docker starts.
- Docker fails closed when either prerequisite is missing or incorrect.
- Docker startup immediately ends with the exact deny-all rules; no two-minute timer window exists.
- Kinvest, Nginx, and a temporary bridge container cannot reach `169.254.0.23:80`.
- The application cannot listen after reboot until an approved RESTORE reconstructs the tmpfs bundle.
- RESTORE does not change image digest, commit, schema, release provenance, VersionIds, or database contents.
- Public health returns to `status=ok`, `dataMode=mock`, and `database=ready` only after RESTORE.
- No secret content enters files outside `/run`, command arguments, logs, Docker inspect output, state files, or Git history.

## Rejected alternatives

- A native nftables rewrite is deferred because it expands the emergency repair into a firewall architecture migration.
- A host-level unreachable route is rejected because it may disrupt Tencent Cloud host agents and changes more than the container boundary.
- Relying only on the timer is rejected because it leaves an unacceptable post-boot exposure window.
- Restoring the application before proving the repaired boundary is rejected.
