# CVM metadata isolation and SSM rollout

Date: 2026-08-11

## Repository-only boundary

This change defines repository contracts only. It does not authorize or perform
a production Docker network change, Compose recreation, Docker restart,
iptables or systemd installation, CAM operation, secret rotation, or reboot.
Never place credentials, secret values, production inventory, or raw audit logs
in the repository or in Compose command arguments.

## Candidate network contract

`deploy/server/kinvest-metadata-network.conf` is one versioned, non-secret
candidate topology. It is not pre-approved production topology and is not a
claim that the candidate is conflict-free. Install an approved copy as the
root-owned mode `0600` file `/etc/kinvest/metadata-network.conf`. Both Compose
and the firewall consume that same file. Do not create or use a working-directory
`.env` for these settings.

The Compose release in the deployment environment supports `gw_priority`, so
the metadata network is the Kinvest default gateway. It does not use
`interface_name`. The deterministic host-side bridge comes from
`com.docker.network.bridge.name`. The network is deliberately not `internal`
because CVM metadata requires external connectivity.

Kinvest remains attached to the shared proxy network and alone joins the
metadata-egress network with its configured static address. Nginx is attached
only to the shared proxy network. Its override drops all capabilities and adds
back only `CHOWN`, `SETGID`, `SETUID`, and `NET_BIND_SERVICE`; it never adds
`NET_RAW` or `NET_ADMIN`. Repository validation renders the Compose
configuration. A local no-network smoke test with `nginx:1.27.5-alpine`
confirmed this set starts successfully; removing `CHOWN` reproduces a startup
failure while preparing `/var/cache/nginx/client_temp`. Production runtime
compatibility remains a separate deployment approval and verification gate.

## Security invariants

- Only forwarded container traffic to `169.254.0.23/32` TCP port `80` is in
  scope. Host metadata access is unchanged.
- A temporary first-position FORWARD reject guard remains installed throughout
  validation, chain rebuilding, and permanent jump installation.
- The permanent chain is first in FORWARD, before any pre-existing jump, and is
  also first in DOCKER-USER for defense in depth.
- The two permanent jumps are installed in one `iptables-restore --noflush`
  filter transaction so unrelated platform and Docker rules are preserved.
- The guard is removed only after exact chain contents, jump order, uniqueness,
  Docker network identity, bridge name, IPAM, sole membership, static address,
  and metadata route source have been verified.
- Only the dedicated bridge plus the exact Kinvest source address may reach the
  exact metadata address and port. Every other forwarded source is rejected.
  No rule permits all of `169.254.0.0/16`.
- All wrapper actions share one flock lock. Root-executed library and config
  files must be regular, non-symlink, root-owned files that are not writable by
  group or others.
- Cleanup removes only Kinvest-managed jumps, rules, chains, and the exact
  temporary guard.

## Read-only conflict preflight

Before requesting Compose/network recreation approval, compare every candidate
setting with read-only evidence:

1. Enumerate all Docker network IPAM ranges and host IPv4 routes; reject any
   overlap with the candidate subnet.
2. Confirm the candidate gateway and static Kinvest address are unused.
3. Confirm the deterministic bridge interface name is unused.
4. Render the exact repository Compose model without changing containers:

       docker compose --env-file /etc/kinvest/metadata-network.conf --project-name kinvest -f /root/docker/kinvest/docker-compose.yml config

5. Record only sanitized conclusions, not production identifiers or raw logs.
6. Obtain explicit user confirmation after the conflict evidence is reviewed.

The root deployment script uses the explicit state file
`/root/docker/kinvest/state/metadata-network.state`. After the approved config
has been installed, the operator confirms its SHA-256 and creates the pending
state with the same approved hash. These commands are a template, not a record
that approval or installation has occurred:

    approved_hash="$(sha256sum /etc/kinvest/metadata-network.conf | awk '{print $1}')"
    printf 'approved metadata config SHA-256: %s\n' "$approved_hash"
    state_tmp="$(mktemp /root/docker/kinvest/state/.metadata-network.state.XXXXXX)"
    printf 'version=1\nmode=pending\nconfig_sha256=%s\n' "$approved_hash" > "$state_tmp"
    chown root:root "$state_tmp"
    chmod 0600 "$state_tmp"
    mv -f -- "$state_tmp" /root/docker/kinvest/state/metadata-network.state

The state is accepted only as a regular, non-symlink, root-owned mode `0600`
file with exactly the ordered `version`, `mode`, and `config_sha256` lines.
Both pending and active states must match the current config byte-for-byte by
SHA-256. A successful guarded first migration atomically changes pending to
active while preserving the approved hash. Missing, malformed, insecure, or
mismatched state fails closed before Compose. Every routine deployment in
active state requires the network to exist and runs a read-only firewall
`status` before pulling or changing the container; a failed precheck reinstalls
and confirms the deny guard before exit. A broken active topology is never
treated as a first migration. Only explicit, hash-matched pending state may
create the initially absent network after the conflict preflight.

## Separate approval gates

### Compose/network recreation approval

Required after conflict preflight and before creating or recreating the named
bridge or Kinvest container. Every Compose `config`, `pull`, or `up` command
must use the explicit `--env-file /etc/kinvest/metadata-network.conf` contract.

### Docker restart approval

Required separately because live restore is disabled and a restart interrupts
running containers. The Docker drop-in installs only the startup/stop deny guard;
it does not run network-dependent apply or status actions that could fail
`docker.service`. The independent oneshot service uses `Requisite` and `After`,
so a timer attempt never starts inactive Docker. It invokes one locked
`reconcile-active` operation. Before any firewall or Docker call, the wrapper requires
the activation state to be a regular, non-symlink, root-owned mode `0600` file
with exactly `version=1`, `mode=active`, and the installed config SHA-256. Under
the same lock it opens the state once, verifies that the path and descriptor
still identify the same inode, and parses only that descriptor. It installs
cleanup traps before creating a process-unique mode `0600` `/run` snapshot,
verifies
the state hash against that snapshot, and uses only the snapshot for guard,
apply, and status. Missing, pending, malformed, insecure, or mismatched state
removes the snapshot and returns nonzero without changing firewall rules. If
apply or status fails after successful binding, reconcile reinstalls and
confirms the guard before returning nonzero; a later timer attempt retries after
containers and networks become ready.

The deployment script continues to use the separate `reconcile` action after
it has independently validated and pinned its approved config snapshot. That
action preserves the explicit `pending` to `active` first-migration workflow;
only the unattended timer path requires an already-active state.

### iptables/systemd installation approval

Required before installing the wrapper, library, root-owned config, service,
timer, or Docker drop-in, and before enabling any unit.

### CAM role binding approval

Required only after network isolation, Docker restart persistence, and negative
reachability tests pass. Role binding is never implied by firewall rollout.

### Secret rotation approval

Required separately for creating or rotating external secret versions and for
changing application references. Secret values never enter chat, repository
files, or shell command arguments.

### Reboot approval

Required for a maintenance-window reboot after the Docker restart gate passes.
Repeat firewall ordering, network membership, route, and reachability checks.

## Install layout

The intended root-owned destinations are:

    /usr/local/sbin/kinvest-metadata-firewall
    /usr/local/libexec/kinvest-metadata-firewall-lib.sh
    /etc/kinvest/metadata-network.conf
    /etc/systemd/system/kinvest-metadata-firewall.service
    /etc/systemd/system/kinvest-metadata-firewall.timer
    /etc/systemd/system/docker.service.d/kinvest-metadata-firewall.conf

Installation commands are an operator checklist and are not authorization to
run them. Install executable files mode `0755`, library and unit files mode
`0644`, and the config mode `0600`, all owned by root.

## Apply and status

Run `guard` before any approved change. `apply` retains that deny guard while it
validates Docker and rebuilds managed rules. A failed validation or transaction
leaves the guard first in FORWARD. Successful apply verifies staged ordering,
removes only the guard, and verifies final ordering. Repeated `apply` and
`status` calls are idempotent.

Positive validation allows only Kinvest. Negative validation must cover Nginx,
an unprivileged temporary container, and all other containers. No test may send
credentials or persist a metadata response.

Deploy-v2 copies the approved config to one root-owned mode `0600` deployment
snapshot under `/run`, validates that snapshot, and compares its SHA-256 with
the activation state before any Compose or firewall Docker operation. Every
Compose `--env-file` and firewall action in that attempt uses only the same
snapshot; the exit trap always removes it. Deploy then installs the guard
immediately before `compose up` and calls the single locked firewall `reconcile`
entry point before recording `current.state`. Any failure enters deployment
rollback and cannot write a successful release state. Rollback first installs
and confirms the deny guard before schema, image, or container work.
After restoring the previous container, rollback reconciles the firewall; if the
old topology cannot satisfy the allow contract, rollback retains the deny guard
and explicitly reports that allow-path isolation is not active.

## Rollback semantics

Default `rollback` is also the post-bind rollback. It installs the global deny
guard and removes the permanent Kinvest chain and jumps, leaving all forwarded
container metadata traffic denied. It never restores broad metadata access.

Before role binding only, an operator may run:

    kinvest-metadata-firewall rollback-pre-bind --assert-role-unbound

The flag is an explicit operator assertion that the role is unbound. This
operator assertion does not query, control, detach, or otherwise inspect CAM.
Without the exact assertion, the action fails with the deny guard retained.
After the asserted firewall cleanup, restoring any earlier Docker network state
is still a separate approved Compose/network operation.

These scripts do not revoke already issued STS credentials, invalidate external
secrets, rotate secret versions, or prove that credentials have expired. Those
external security actions require their own approval and provider-side process.

## Residual risk

Bridge plus source-address filtering is not cryptographic workload identity.
Keep `NET_RAW` and `NET_ADMIN` absent from application and proxy containers,
limit Docker administration, scope any future role to exact secret resources,
and leave secret loading disabled whenever these controls cannot be maintained.
