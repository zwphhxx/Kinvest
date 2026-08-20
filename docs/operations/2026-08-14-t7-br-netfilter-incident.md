# T7 bridge filtering persistence incident

Date detected: 2026-08-14

This record contains only non-secret operational evidence. Never request or
record secret values, tmpfs bundle contents, credentials, metadata responses,
unrestricted firewall dumps, or raw sensitive logs.

## Detection

After the explicitly approved T7 CVM reboot, real bridge-container probes from
the proxy bridge and a temporary bridge container reached `169.254.0.23:80`.
The existing rules appeared installed, but their deny counters did not prove
that bridged packets traversed the forwarding hooks.

## Impact

The intended container metadata deny-all boundary was not effective after a
clean kernel boot. No metadata response or secret value was retained in this
record. The application was subsequently made unavailable as the safer state.

## Containment

The Docker service and socket were stopped, and RESTORE was not triggered. This
prevents bridge containers from running while the kernel prerequisite is
unproven. The containment does not authorize any installation, Docker start,
reboot, deployment, or secret operation.

## Root cause

`br_netfilter` and its sysctl were not persisted across boot. Without the module,
`/proc/sys/net/bridge/bridge-nf-call-iptables` did not exist, so Docker bridge
traffic could bypass the iptables-nft forwarding policy even though the rules
were present. The required persistent setting is exactly:

```text
net.bridge.bridge-nf-call-iptables = 1
```

`br_netfilter` must load and the runtime value must be exactly `1` before Docker
bridge traffic can be filtered by this policy.

## Repair design

The repair adds root-owned modules-load and sysctl assets, independent runtime
verification, and a Docker lifecycle that fails closed if the module, sysctl,
interlock, boot guard, or reconciliation prerequisite is missing or invalid.

The atomic installer accepts only a root-only verified installation source. Its
first durable host change is a self-contained Docker recovery interlock. Failed
or incomplete installation and rollback paths retain that interlock and record
`operator-required`; they do not start or restart Docker.

Before Docker starts, `boot-guard` installs a first-position
`mangle/PREROUTING` metadata DROP that Docker does not own. The Docker drop-in
then installs its filter guard. `ExecStartPost` is not failure-ignored and runs
`reconcile-active`; the permanent deny-all policy is restored and verified
before startup protection is released. If reconciliation fails, Docker stops
and the boot and filter guards remain or are reinstated.

## Current status

Production remains deliberately fail closed: Docker stopped, public unavailable.
It stays in this state until the repair is merged and each host
installation and recovery action is separately approved. The tmpfs secret
bundle is absent, and no RESTORE has run.

No CAM/SSM, real iFinD, model, database migration, or image change is part of
this repair. It does not enable authentication, device approval, or real data.

## Evidence and backups

Only stable, non-secret locations and conclusions are recorded:

- Pre-reboot evidence and backup:
  `/var/backups/kinvest-metadata-firewall/t7-cvm-20260814T033859Z`
- Controlled Docker-restart evidence:
  `/var/backups/kinvest-metadata-firewall/t7-docker-20260814T033524Z`
- Before containment, Kinvest used the dedicated metadata-egress bridge and
  Nginx used the shared proxy bridge; both were Docker bridge networks.
- The clean boot had no loaded `br_netfilter` and no bridge netfilter sysctl
  node or persistent modules-load/sysctl assets.

These paths identify operator evidence; they are not approval to restore files
or run commands. Do not copy their raw contents into chat or the repository.

## Recovery gates

Recovery remains sequential and every production mutation has its own approval:

1. Merge the reviewed repair only after all required PR checks pass.
2. Obtain separate approval to install the exact merged assets while Docker
   remains stopped; verify hashes, module, exact sysctl, interlock behavior,
   timer state, and activation state without starting Docker.
3. Obtain separate approval for a controlled Docker start without reconstructing
   the tmpfs bundle; Kinvest remains failed closed while real non-secret probes
   prove Kinvest, Nginx, and a temporary bridge container cannot reach metadata.
4. The second CVM reboot requires separate explicit approval. After that clean
   boot, prove the module and sysctl loaded before Docker, the lifecycle gates
   succeeded, and metadata remains denied.
5. On a CVM reboot the tmpfs bundle disappears. Rebuilding it requires an exact
   RESTORE and GitHub Production approval. RESTORE must not change the image,
   commit, schema, release provenance, VersionIds, or database.
6. Verify exact runtime state, internal and public health, Mock mode, deny-all
   behavior, timer state, and secret-free logs.
7. Restore the deployment enable switch to its disabled steady state.

No step may bypass or combine these approvals. A rollback that cannot prove
the prior bridge-filtering prerequisites remains `operator-required`, keeps the
interlock installed, and leaves Docker stopped pending a new explicit decision.
