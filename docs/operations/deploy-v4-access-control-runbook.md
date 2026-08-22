# deploy-v4 access-control activation runbook

Deploy-v4 is a separately gated Production forced-command path. It retains the
release-record v2 and offline immutable-image proof chain, the approved tmpfs
secret bundle, and the v3 transaction while adding canonical access policy,
root-owned trusted-proxy topology, state protocol v5, access preflight, and
post-switch access acceptance. State and logs contain no secret material.

## Required approval sequence

1. Install the reviewed v4 assets with `install-deploy-v4.sh`. Installation
   takes a root-only backup and does not enable a gate, restart a service, alter
   Docker networking, or run Compose.
2. Set Production `KINVEST_ACCESS_CONTROL_MODE=disabled`, temporarily approve
   `DEPLOY_V4_ENABLED=true`, and run a v4 disabled baseline. This writes v5 state
   with an empty trusted-proxy list.
3. In a separate Docker/network change, assign Nginx one fixed IPv4 on `web`
   using `docker-compose.nginx-fixed-ip.yml`. Never trust the current dynamic
   address or the `172.19.0.0/16` subnet.
4. Install `/etc/kinvest/access-control-network.conf` from the example as a
   root-owned regular `0600` file. Confirm the named Nginx container is running
   on exactly the named network and exact configured IPv4.
5. In a separate Production approval, change the variable to `device-approval`
   and activate with deploy-v4.

## Rollback boundary

After a successful device-approval state commit, FORWARD cannot select
`disabled`. ROLLBACK retains current access mode, secret identity, and trusted
proxy instead of adopting the previous release's weaker policy. RESTORE must
reproduce current image, commit, schema, secrets, mode, and proxy. An
incompatible target or recovery fails before persistent database backup,
attempt state, Compose down, or switching. Emergency protection removal is not
a deploy-v4 operation and requires a separately reviewed incident change.

The device-approval candidate receives only a consistent SQLite backup in
`/run`, never the production database. It has no network, runs as UID 10001,
uses a read-only root filesystem, drops all capabilities, and mounts the tmpfs
secret bundle and snapshot read-only. Activation requires the exact access
preflight output and post-switch anonymous 401/200 behavior.
