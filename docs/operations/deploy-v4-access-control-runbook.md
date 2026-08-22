# deploy-v4 access-control activation runbook

Deploy-v4 is a separately gated Production forced-command path. It retains the
release-record v2 and offline immutable-image proof chain, the approved tmpfs
secret bundle, and the v3 transaction while adding canonical access policy,
root-owned trusted-proxy topology, state protocol v5, access preflight, and
post-switch access acceptance. State and logs contain no secret material.

## Required approval sequence

1. Install the reviewed v4 assets with `install-deploy-v4.sh`. Installation
   first atomically publishes the backward-compatible forced-command gate, then
   takes a root-only backup and installs the complete v3/v4 asset closure. It
   does not enable v4, restart a service, alter Docker networking, or run
   Compose.
2. Set Production `KINVEST_ACCESS_CONTROL_MODE=disabled`, temporarily approve
   `DEPLOY_V4_ENABLED=true`, and run a v4 disabled baseline. This writes v5 state
   with an empty trusted-proxy list.
3. Install `/etc/kinvest/access-control-network.conf` from the example as a
   root-owned regular `0600` file. Its exact `KINVEST_NGINX_IPV4` is the only
   permitted source for the fixed-IP overlay. Never copy an address from chat,
   an arbitrary `.env`, the current dynamic container address, or the
   `172.19.0.0/16` subnet.
4. Run the read-only fixed-IP render gate below. Stop after its exact success
   line and obtain the separate Docker/network approval.
5. After that approval only, run the apply gate below. It recreates only Nginx,
   immediately verifies running/network/IP and the public Kinvest HTTPS health
   response, then stops. Do not continue automatically into access activation.
6. In a separate Production approval, change the variable to `device-approval`
   and activate with deploy-v4.

## Fixed Nginx IP gates

The reviewed root project is fixed to workdir `/root/docker`, base file
`/root/docker/docker-compose.yml`, existing Nginx overlay
`/root/docker/docker-compose.kinvest-nginx.yml`, and trusted fixed-IP overlay
`/root/docker/kinvest/docker-compose.nginx-fixed-ip.yml`. The v4 installer owns
and hashes the last file but never applies it, invokes Compose, or restarts a
container.

Gate 1 is read-only:

```bash
cd /root/docker
sudo /usr/local/sbin/kinvest-nginx-fixed-ip-gate render
```

The gate requires Docker Compose `2.24.4` or newer for `!override`, parses the
IP only through the strict root-owned access-control config contract, runs
`docker compose config --format json`, and requires the rendered
`services.nginx.networks.web.ipv4_address` to equal that exact IP. The only
success output is `KINVEST_NGINX_FIXED_IP_RENDER_OK ip=<approved-ip>`.

Stop here. After a separate Docker/network approval, Gate 2 is:

```bash
cd /root/docker
sudo /usr/local/sbin/kinvest-nginx-fixed-ip-gate apply
```

Gate 2 repeats Gate 1 before `up -d --no-deps --force-recreate nginx`, then
requires Nginx running on exactly network `web` at the configured IP and an
HTTPS `200 application/json` Kinvest health body. Its only success output is
`KINVEST_NGINX_FIXED_IP_APPLY_OK ip=<approved-ip> health=ready https=ready`.
Stop again; device approval remains a separate Production approval.

## Rollback boundary

After a successful device-approval state commit, FORWARD cannot select
`disabled`. ROLLBACK retains current access mode, secret identity, and trusted
proxy instead of adopting the previous release's weaker policy. RESTORE must
reproduce current image, commit, schema, secrets, mode, and proxy. An
incompatible target or recovery fails before persistent database backup,
attempt state, Compose down, or switching. Emergency protection removal is not
a deploy-v4 operation and requires a separately reviewed incident change.

RESTORE is also the tmpfs secret rehydration path after a host restart. The
approved payload must reproduce the recorded provider, VersionIds, material
fingerprints, image, schema, access mode, and trusted proxy. Preflight and
Compose use the newly approved candidate bundle; a successful RESTORE changes
only `secretBundleId`. The old `/run/kinvest-secrets/<bundle>` directory is not
required to survive a restart.

## Crash recovery boundary

Before changing `attempt.state`, `previous.state`, or `current.state`, the
deployer fsyncs `state/deploy-transaction.journal`. It contains only the exact
non-secret state before-images, absent markers, protocol version, stage, target
digest, verified database-backup path/checksum, and candidate schema range. A
normal verified automatic recovery replays those before-images before deleting
the journal. If a process or host dies, the next invocation replays the journal,
preserves the database recovery references in `deploy-incomplete.marker`, and exits with
`DEPLOY_INCOMPLETE_RESTORE_REQUIRED`. Subsequent FORWARD or ROLLBACK requests
fail with `DEPLOY_RESTORE_REQUIRED`; only a fully accepted RESTORE clears the
marker. Do not delete either file manually.

RESTORE reads the production SQLite `PRAGMA user_version` before proceeding. If
the current image supports that schema, an exact RESTORE may complete and clear
the marker. Otherwise it stops with `ROLLBACK_REQUIRES_DB_RESTORE` and preserves
the backup path and checksum. Database restoration remains a separate manual,
approved operation; deploy-v4 never restores the persistent database itself.

For an ACTIVE marker, RESTORE uses the marker's database backup reference ahead
of state or attempt data. The referenced file must be a root-owned regular
`0600` file directly under the approved backup directory, and its actual
SHA-256 must match the marker. Invalid, missing, writable, symlinked, or changed
references fail closed while preserving the marker. A compatible successful
RESTORE first persists that exact path and checksum in `current.state`; only
after the atomic state write and directory fsync may it clear the marker.

The v4 installer first installs one backward-compatible journal-aware gate by
fsyncing a temporary file, atomically renaming it, and fsyncing its directory.
With no install journal, deploy-v3 still delegates to the old assets; deploy-v4
delegates only after its complete asset closure exists. With a journal, both
paths return `DEPLOY_INSTALL_INCOMPLETE` before executing any deploy asset.

The installer requires both non-secret `KINVEST_DEPLOY_GATE_USER` and
`KINVEST_DEPLOY_GATE_GROUP`; there are no guessed defaults. For the current
Production host, set both to `lighthouse` only after read-only `getent` and `id`
checks confirm that the `lighthouse` group exists and the `lighthouse` user is
already a member. If its real primary or supplementary group differs, use that
observed group instead. The installer never creates users or changes group
membership.

The installer creates `/var/lib/kinvest-deploy-gate` as
`root:<KINVEST_DEPLOY_GATE_GROUP>` `0750`. The directory itself is the flock
object; there is no replaceable lock file. The gate records the installed user,
group, and numeric gid in a non-secret `0640` identity file. A later invocation
must provide the same identity. A change is rejected with a stable error and
requires a separately reviewed identity-migration procedure.

Both the v3 and v4 installers require the same explicit identity and safely
create or validate the same gate directory and identity file. A clean host may
run only the v3 installer; afterward the deploy-v2 and deploy-v3 forced-command
branches are usable because the v3 transaction also installs the required v2
deployer, secret validator, and offline-attestation helper. The v3 installer
does not make deploy-v4 usable until the complete v4 closure is installed.

Each installer takes an exclusive gate-directory lock before the shared private
`deploy.lock` and holds both through gate installation, reconciliation,
transaction commit, and marker clearing. A deployment already holding
`deploy.lock` therefore prevents the installer from reading or replacing any
target asset. The deployer continues to own the deploy lock itself, so there is
no reverse lock acquisition path.

The forced-command gate never reads or stats the private `/root` journal or
backup tree. As the ordinary SSH user it validates the public directory and
lock owner, group, mode, type, and link count. The lock group must be in the
process effective primary or supplementary groups before the gate opens it
read-only and requests a nonblocking shared lock. A busy lock is never ignored
after a timeout. A busy lock, unsafe metadata, missing group access,
permission/stat failure, or root-and-gate-group-owned `0640`
`install-incomplete` marker produces `DEPLOY_INSTALL_INCOMPLETE` before sudo.
The public marker contains only the fixed line `ACTIVE`; only the trusted gate
group can read it, and only root can change or replace it.
Only members of the explicitly configured trusted forced-command deployment
group can open the directory and hold its shared lock. That trusted principal
already controls Production deployment availability. The Production workflow
also compares protected secret `SSH_USER` with the non-secret
`KINVEST_DEPLOY_GATE_USER` after approval and fails without printing either
value when they differ.

The subsequent v4 transaction includes the shared deployer, both v3 and v4
contract paths, Compose, sudoers, and configuration. Before publishing
`state/install-v4.journal`, every backup file, backup manifest, backup directory,
and parent directory is fsynced. After install or rollback renames, every target
parent directory is fsynced before the journal is cleared; its parent directory
is fsynced again after clearing. Re-run the same reviewed installer to reconcile
an interrupted installation: it restores the complete old target set first and
then starts a new transaction. Installation and reconciliation never restart a
service or invoke Compose.

Each installed or restored regular file is written to a same-directory
temporary file, fsynced, atomically renamed, and followed immediately by a
parent-directory fsync. Removing a target recorded as originally absent is
followed by a parent-directory fsync. These calls establish the intended
filesystem ordering for crash recovery; they do not claim protection from
storage hardware or filesystems that falsely report completed flushes.

The installer fsyncs and atomically publishes the public marker before the
private journal rename. After SIGKILL, the released lock is therefore not enough
to reopen deployment while a stale transaction may exist. Reconciliation or a
successful install removes and fsyncs the private journal first, then removes
and fsyncs the public marker. The private journal remains root-only `0600` and
its backup directory remains root-only `0700`.

The v3 installer provides the equivalent crash boundary with its distinct
root-private `state/install-v3.journal` and deploy-v3 backup manifest. Before
the first target rename it fsyncs every before-image or absent marker, the
manifest, backup directory and backup parent, publishes and fsyncs the private
journal, and keeps the public marker active. Install and restore both use
fsynced same-directory temporary files, atomic rename, and immediate parent
directory fsync. On reentry it validates the journal identity, path, owner,
mode, manifest hash and every backup entry under both locks, restores the exact
old target set, fsyncs it, clears and fsyncs the private journal, then clears and
fsyncs the public marker. It returns
`DEPLOY_V3_INSTALL_RECONCILED_RETRY_REQUIRED`; a separate invocation may then
install the new closure.

The v3 and v4 private journals have distinct names and formats. The shared gate
directory lock serializes both installers. If either installer sees the other
version's journal, it returns `DEPLOY_INSTALL_INCOMPLETE` without parsing,
clearing, or modifying that journal or the public marker. These fsync boundaries
provide ordered filesystem persistence but do not claim guarantees beyond the
host filesystem and storage hardware.

The v3 and v4 installers render the same reviewed sudoers template for the
explicit gate user. With no historical sudoers present, that file grants only
the three fixed, no-argument root commands `/usr/local/sbin/deploy-kinvest`,
`/usr/local/sbin/deploy-kinvest-v3`, and
`/usr/local/sbin/deploy-kinvest-v4`. Each installer validates the rendered file
with `visudo` and checks all three grants as the configured user. Usernames with
template or shell metacharacters are rejected before rendering.

The installers track same-directory `.install-incomplete.XXXXXX` and
`.identity.XXXXXX` files.
The gate treats any such temporary entry, including a malformed partial file,
as `DEPLOY_INSTALL_INCOMPLETE`. Under the exclusive directory lock, installer
reentry removes only an exact direct-child basename that remains root-owned,
regular, single-linked, and non-symlink; unsafe entries remain in place and
keep deployment fail-closed.
Ordinary failure removes only the exact inode it created when it remains a
root-owned regular file with one link, then fsyncs the directory. On reentry,
after taking the directory's exclusive lock, it removes a SIGKILL orphan only
when the basename is exact and it is a direct root-owned regular non-symlink
child with one link; partial mode or content is expected. An unexpected owner,
symlink, malformed name, or additional hard link stops
installation without deleting the suspicious file.

If a protocol-v4 RESTORE has already switched runtime to a newly approved tmpfs
bundle and post-switch acceptance fails, the marker remains even though the raw
protocol-v4 state bytes are restored. FORWARD and ROLLBACK stay blocked; retry
the exact RESTORE with an approved new bundle. Successful retry updates only the
bundle identifier and clears the marker.

The device-approval candidate receives only a consistent SQLite backup in
`/run`, never the production database. The deployer mounts that snapshot
read-only at `/preflight/candidate.sqlite`, keeps the production logic path at
the distinct `/data/kinvest.sqlite`, and explicitly executes
`node server/access-preflight.js /preflight/candidate.sqlite`. It has no
network, runs as UID 10001, uses a read-only root filesystem, drops all
capabilities, and receives a `noexec,nosuid,nodev` UID/GID 10001 `/tmp` tmpfs.
Snapshots are limited to 256 MiB and the tmpfs is 512 MiB so the application can
make its separately verified private SQLite backup without writing the mounted
snapshot. Activation requires the exact access
preflight output and post-switch anonymous 401/200 behavior. Disabled acceptance
requires an `application/json` watchlist response with exactly `success: true`
and an array `data`; HTML catchalls and malformed JSON fail recovery-safe.

## Residual risk

The previously identified medium-severity UUID concern is unchanged in this
task and remains separately tracked. This deployment change does not broaden
its use or treat it as an access-control or secret identifier.
