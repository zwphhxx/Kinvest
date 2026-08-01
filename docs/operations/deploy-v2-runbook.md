# deploy-v2 rollout runbook

## Status and gates

`deploy-v2` is introduced in parallel with v1. Merging the code does not install
it and does not deploy production. The following actions each require a separate
user approval:

1. Install the v2 wrapper and root script on the CVM.
2. Enable the GitHub `DEPLOY_V2_ENABLED` Production variable.
3. Approve the Production Environment deployment.
4. Remove the persistent root TCR Docker auth entry.
5. Remove v1 after one successful v2 deployment and rollback rehearsal.

## Protocol

The SSH forced command accepts only the literal `deploy-v2`. All other data is
sent over encrypted stdin:

```text
KINVEST_DEPLOY_V2
<repository@sha256:digest>
<40-character-commit>
<registry-mode>
<registry-host>
<registry-username-or-empty>
<registry-password-or-empty>
<release-record-schema-version>
<verification-run-id>
<artifact-source>
<secret-version-ids-json>
EOF
```

The four non-secret provenance lines before `EOF` extend the original draft.
They are required because the joint server deployment state cannot otherwise
record the release record, workflow run, artifact source, or active SSM VersionId
set. The current phase accepts only `{}` for secret versions; CAM/SSM activation
will expand that validator in a separate reviewed PR.

## Registry behavior

- `ghcr-public` is the only production-enabled mode at this baseline.
- `tcr-basic` exists in the root parser but must not be enabled until a pull-only,
  independently revocable credential is proven. The root script also requires
  `/root/docker/kinvest/policy/tcr-basic.enabled`, owned by `root:root`, mode
  `0600`, containing only `enabled`; creating it is a separate approval gate.
- `DOCKER_CONFIG` is created under `/run`, mode `0700`, and removed on every exit.
- TCR passwords use `docker login --password-stdin` and are never command-line
  arguments, state fields, or log messages.
- The pulled image is accepted only when `RepoDigests` contains the requested
  full repository digest.

## Release record v2

The main publish workflow writes a GHCR release record containing only
non-secret metadata:

```text
schema_version
verification_run_id
verification_run_attempt
commit_sha
artifact_source
source_repository
source_digest
ghcr_digest
tcr_digest
created_at
```

The existing v1 TCR workflow and deployment workflow remain read-only compatible
during the transition. They stay disabled by the existing deployment gate and
are removed only after v2 succeeds.

## Joint state and rollback

v2 writes `protocolVersion`, image digest, commit, SQLite schema, image schema
range, secret VersionIds, release record schema, verification run, artifact
source, backup path/checksum, and deployment time. Before switching the
container, it creates a SQLite online backup using the SQLite backup API and
checks the backup with `PRAGMA quick_check`.

Automatic deployment is allowed only when the current schema is within the
candidate image range. Automatic image rollback is allowed only when the
post-failure schema is within the previous image range. Otherwise the script
stops the candidate, preserves `attempt.state`, prints
`ROLLBACK_REQUIRES_DB_RESTORE`, and stops. A database restore remains a separate
user-approved maintenance operation.

Normal releases use `FORWARD` and must reference the current `origin/main`
release record. Historical main releases require the explicit `ROLLBACK` intent
and `ROLLBACK_V2` confirmation.

## Installation gate

After the PR is merged and all checks pass, compare repository and server hashes.
Only after explicit approval run the repository installer as root with the
canonical server-source directory. The installer replaces the root program
first and the forced wrapper second, validates shell syntax, prints only
non-secret hashes, and does not restart a container.
