# CVM metadata isolation and SSM rollout

Date: 2026-08-11

## Current boundary

This change prepares repository-side contracts only. It does not change the
production Docker network, iptables, systemd, CAM role, SSM secrets, application
startup, or running containers.

The production rollout remains disabled until a read-only server audit is
recorded and the user separately approves each external change.

## Security invariants

- The only metadata destination used by Kinvest is 169.254.0.23 port 80.
- Docker startup installs a FORWARD-chain reject guard before dockerd starts.
- The guard remains active while the dedicated DOCKER-USER chain is rebuilt.
- The guard is removed only after rule presence, jump position, uniqueness, and
  target order have been verified.
- A failed apply or rollback leaves the guard active, denying metadata to every
  container.
- Only the audited Kinvest bridge interface and fixed container IP may pass the
  dedicated chain.
- All wrapper operations share one flock lock.
- Root-executed library and config files must be regular, non-symlink,
  root-owned files with no group or world write permission.
- The application reads temporary credentials only from the fixed CVM metadata
  endpoint. It has no environment SecretId or SecretKey fallback.
- Every SSM read includes an explicit SecretName and VersionId.
- Secret values are retained only in process memory and are not included in
  audit events.

## Read-only audit gate

Before any install, record without changing the server:

1. Confirm the instance is CVM ins-qsohtsg7 in ap-shanghai and uses a VPC.
2. Confirm Docker uses the iptables backend and the FORWARD and DOCKER-USER
   chains exist.
3. Resolve metadata.tencentyun.com from the host and confirm it still maps to
   169.254.0.23. Any change is a no-go.
4. Inspect the external web network subnet, bridge interface, Kinvest container
   IP, Nginx container IP, and every attached container.
5. Confirm the proposed fixed Kinvest IP is unused and survives Compose
   recreation.
6. Inspect effective Linux capabilities for Kinvest, Nginx, and other
   containers. Kinvest and Nginx must not retain NET_RAW or NET_ADMIN.
7. Confirm no CAM instance role is currently bound and no long-term Tencent
   credential exists in environment files, Docker config, commands, logs, or
   the repository.

If the Docker backend, bridge identity, or capability boundary cannot be
verified, do not bind a CAM role.

## Candidate install layout

The following paths are the intended root-owned destinations:

    /usr/local/sbin/kinvest-metadata-firewall
    /usr/local/libexec/kinvest-metadata-firewall-lib.sh
    /etc/kinvest/metadata-firewall.conf
    /etc/systemd/system/kinvest-metadata-firewall.service
    /etc/systemd/system/kinvest-metadata-firewall.timer
    /etc/systemd/system/docker.service.d/kinvest-metadata-firewall.conf

Installation must use explicit ownership and modes:

    install -o root -g root -m 0755 kinvest-metadata-firewall.sh /usr/local/sbin/kinvest-metadata-firewall
    install -o root -g root -m 0644 kinvest-metadata-firewall-lib.sh /usr/local/libexec/kinvest-metadata-firewall-lib.sh
    install -o root -g root -m 0600 metadata-firewall.conf /etc/kinvest/metadata-firewall.conf
    install -o root -g root -m 0644 kinvest-metadata-firewall.service /etc/systemd/system/kinvest-metadata-firewall.service
    install -o root -g root -m 0644 kinvest-metadata-firewall.timer /etc/systemd/system/kinvest-metadata-firewall.timer
    install -o root -g root -m 0644 docker-kinvest-metadata-firewall.conf /etc/systemd/system/docker.service.d/kinvest-metadata-firewall.conf

These commands are an operator checklist, not authorization to run them.

## Approved rollout sequence

Each numbered external step requires a fresh user approval.

1. Add a conflict-checked fixed IP and audited bridge interface to the Kinvest
   Compose configuration without restarting production.
2. Install the wrapper, library, and root-only config.
3. Run the guard action first. Verify every current container is denied access
   to 169.254.0.23 port 80.
4. Run apply and status. Verify Kinvest alone can reach the endpoint, while
   Nginx, an unprivileged temporary container, and all other bridge containers
   are denied.
5. Install the systemd service, timer, and Docker drop-in.
6. After a separate production interruption approval, restart Docker. Verify
   the guard exists before startup and the dedicated chain is restored after
   startup.
7. Reboot only during an approved maintenance window and repeat the same
   isolation checks.
8. Only after both persistence tests pass may the user bind a least-privilege
   CVM CAM role.
9. The user creates legal SSM SecretName and VersionId values in the Tencent
   console. Secret values never enter chat or shell commands.
10. Start a candidate Kinvest container with explicit non-secret role name and
    SSM VersionId configuration. Perform minimal reads and fail closed if any
    requested version is unavailable.

## Safe rollback

The rollback action intentionally does not restore unrestricted metadata
access. It first installs the global FORWARD reject guard, then removes the
KINVEST-METADATA jump and chain without reading the config file. This still
works when the config is missing or corrupt.

Before removing the final guard, the user must first detach the CAM role and
confirm that no workload needs metadata access. Removing that final guard is a
separate manual recovery decision and is not automated by this repository.

## SSM startup contract

The repository provider accepts:

- an ASCII CAM role name;
- explicit secret references containing SecretName and VersionId;
- an SSM client factory initialized with temporary credential ID, temporary
  key, session token, expiry, and ap-shanghai.

The provider itself requests credentials from:

    http://169.254.0.23/latest/meta-data/cam/security-credentials/<role-name>

It enforces a 1500 millisecond timeout, a 16 KiB response limit, a successful
Tencent response code, matching expiration fields, and at least 60 seconds of
remaining credential lifetime before every SSM read. A partial load is wiped
and rejected.

The metadata transport injection exists only as a unit-test seam. Production
startup must use the fixed default transport. The SSM SDK adapter and actual
startup wiring remain a later, separately reviewed change.

Tencent documents that a CVM instance with an attached CAM role can retrieve
periodically refreshed STS credentials from this metadata path:
https://cloud.tencent.com/document/product/213/47668

## Residual risk

An input bridge plus source IP rule is stronger than source IP alone, but it is
not a cryptographic workload identity. A compromised container on the same
bridge with raw networking capability could attempt spoofing. Therefore:

- remove NET_RAW and NET_ADMIN from Kinvest, Nginx, and peer containers;
- do not permit arbitrary containers on the production web bridge;
- grant the CVM role only read access to the exact Kinvest SSM secrets;
- treat every same-host root or Docker administrator as inside the trust
  boundary;
- keep real secret loading disabled if these controls cannot be maintained.

No screenshot is required for this repository-only backend contract. The later
production validation must save non-secret evidence of rule status, container
reachability results, Docker restart persistence, and public application
health.
