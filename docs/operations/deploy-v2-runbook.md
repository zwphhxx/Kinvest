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
set. The final metadata line accepts one of three exact single-line forms:

- `{}` for disabled secret bootstrap.
- The canonical admin verifier and device HMAC VersionId mapping for a forward
  deployment.
- `{"rollback":"previous"}` for an explicit one-step rollback request.

The shared validator rejects extra keys, alternate key order, aliases such as
`current`, unsorted or duplicate accepted versions, and an active HMAC version
that is not accepted. The rollback sentinel is never stored. It is resolved to
the mapping in `previous.state` only when the requested digest and commit also
match that state exactly.

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

## Offline GHCR export and transfer

Offline import is a controlled fallback for the Shanghai CVM when a bounded
Registry pull cannot complete. It is valid only for the fixed public repository
`ghcr.io/zwphhxx/kinvest` and never converts an Image ID or tag into a fabricated
RepoDigest.

Start from one validated release record v2 and retain these exact inputs:

```text
source_digest=ghcr.io/zwphhxx/kinvest@sha256:<64-lowercase-hex>
commit_sha=<40-lowercase-hex>
verification_run_id=<GitHub Actions run id>
archive_sha256=<calculated by the exporter>
```

On the administrator Mac, with Docker already able to pull the public image,
export to a new absolute `.tar` path:

```bash
scripts/export-offline-image.sh \
  'ghcr.io/zwphhxx/kinvest@sha256:<digest>' \
  '/absolute/private/path/kinvest-<digest-prefix>-linux-amd64.tar'
```

The exporter requires macOS, pulls only `linux/amd64`, checks that Docker reports
the exact requested RepoDigest, writes mode `0600` through a private temporary
file, and invokes the repository verifier before an atomic no-overwrite hard link
publication followed by unlinking the temporary name. Before verification it
captures the temporary file's device, inode, size, mode, owner, and SHA-256. The
same identity and checksum must still hold after verification, across the hard
link, and after a final output re-hash. It does not
log in to Docker or read Docker credential configuration. Preserve the printed
path, SHA-256, byte size, source digest, platform manifest digest, and runtime
Image ID as non-secret transfer metadata. Transfer the archive separately and
recalculate its SHA-256 on the server before import; both checksums must match.
A private same-filesystem `0700` directory holds a no-overwrite hard-link anchor before verification.
The anchor prevents an unlinked temporary inode from being reused for identical replacement bytes.
The anchor is removed after success, failure, or signal cleanup and never appears in success metadata.
Anchor cleanup completes synchronously before success metadata is constructed or emitted.
During EXIT or signal cleanup, handled signals are ignored so a second signal cannot interrupt cleanup.

After a separate server-import approval, root imports the archive using the
release record's exact provenance:

```bash
sudo /usr/local/libexec/kinvest-offline-image-attestation import \
  '/absolute/private/path/candidate.tar' \
  '<64-lowercase-hex-archive-sha256>' \
  'ghcr.io/zwphhxx/kinvest@sha256:<digest>' \
  '<40-lowercase-commit>' \
  '<verification-run-id>'
```

The helper binds the verified archive bytes to Docker's loaded immutable Image
ID. Its root-owned attestation record contains only `version`,
`sourceDigest`, `platform`, `platformManifestDigest`, `runtimeImageId`,
`archiveSha256`, `commit`, `verificationRunId`, and `importedAt`. The directory
is root-only and records are `root:root` mode `0600`; no Registry credential,
SecretString, STS credential, or application data is stored.

Exporter or verifier failure removes the private temporary archive and leaves
the requested output absent. Import failure must not write or replace an
attestation record. Do not retry blindly, do not retag the image as proof, and
do not hand-edit an attestation. Remove a transferred archive only after import,
record verification, and a separately approved deployment have completed.
Until all success metadata has been written, signal and exit cleanup removes the
final path only when it is still the same process-created inode recorded at link
creation; a raced replacement is never removed. Output paths containing control
characters are rejected so metadata remains one field per line.
The exporter fsyncs an `armed` device/inode cleanup record before the hard link.
The armed record remains unchanged through link validation and metadata output;
there is no destructive normal-state rewrite. If a signal lands after link
creation, cleanup can therefore remove only that still-matching archive inode.
Temporary, anchor, and output identities and checksums are compared before and
after verification, during publication, and before success metadata is emitted.
If normal-path anchor unlink or directory removal fails, the exporter exits nonzero
without success stdout and removes the final path only when its armed inode still
matches. It reports the non-secret private recovery directory: an unlink failure
may preserve the known archive hard link there, while a directory-removal failure
may preserve only the empty `0700` directory for deliberate administrator cleanup.

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

`current.state`, `previous.state`, and `attempt.state` contain only canonical
VersionId metadata or `{}`. They never contain a SecretString, STS credential,
long-lived cloud credential, or rollback sentinel. Compose receives only the
derived provider mode and the canonical VersionId JSON. Automatic rollback
restores the previous image, commit, schema range, and VersionId mapping as one
deployment state.

Protocol v3 additionally records `runtimeImageId`, so a deployment resolved by
offline attestation is jointly bound to the original source digest and the exact
local Image ID that runs. A strict legacy or v2 state may be migrated only after
the deployer captures and validates the currently running immutable Image ID;
malformed or ambiguous legacy state fails closed. `previous.state` retains that
Image ID for automatic rollback. Rollback never resolves a mutable tag and never
substitutes a newly loaded image with matching labels.

If the previous Image ID is unavailable, its schema range is incompatible, or
its attestation/provenance no longer validates, automatic rollback stops. A
matching archive re-import, database restore, or state repair is a new manual
operation with its own backup review and approval; switching only the source
digest is not a complete rollback.

## Candidate SSM preflight

An enabled VersionId mapping adds a fail-closed candidate gate after immutable
digest and schema-label verification but before database backup, Compose
mutation, or attempt/success state writes:

1. Require `io.kinvest.secret-bootstrap=1` on the candidate image.
2. Confirm the J4-A preflight entry is a regular readable file in the image.
3. Run it once as UID/GID `10001`, read-only, with all capabilities dropped,
   `no-new-privileges`, and `--network container:kinvest`.
4. Pass only `KINVEST_SECRET_PROVIDER_MODE=cvm-ssm` and the canonical VersionId
   JSON.
5. Accept only one exact stdout line with the expected reference count, empty
   stderr, and exit status zero.

Disabled `{}` deployments skip this preflight and retain the established Mock
path. A rollback to an enabled previous mapping performs the same candidate
preflight before restoring that release.

Normal releases use `FORWARD` and must reference the current `origin/main`
release record. Historical main releases require the explicit `ROLLBACK` intent
and `ROLLBACK_V2` confirmation.

## Installation gate

After the PR is merged and all checks pass, compare repository and server hashes.
Only after explicit approval run the repository installer as root with the
canonical server-source directory. The installer takes the same nonblocking
deployment lock as `deploy-kinvest-v2.sh`; an active deployment makes installation
fail before snapshots or replacements. While holding that lock through validation
or rollback, it installs in the explicit order deployer, validator, helper,
wrapper last. It validates shell syntax, prints only non-secret hashes, and does
not restart a container.

The J4-B repository changes do not install these assets or deploy production.
Installing the validator, deployment script, and Compose file and performing a
disabled `{}` baseline deployment belong to J4-C and require their own explicit
approvals.

The installer validates `offline-image-attestation.py` as a regular non-symlink,
runs `py_compile` and the exact `self-check`, and installs all four assets as one
four-asset transaction. Before its first exact-target replacement it records each
prior file or prior absence in a root-private backup directory together with
hash, mode, and ownership. Any replacement failure, validation failure, or
handled signal restores and verifies all four prior states. The forced-command
wrapper remains last, after the installed helper is verified as exact
`root:root` mode `0755`, hash-matched, and self-checking. Installation never runs
`import`, invokes Docker, restarts a service, or changes deployment state.
Cleanup will ignore handled signals during restoration so a second signal cannot
interrupt the rollback. The root-private backup is preserved when restoration
verification fails, and only its non-secret recovery path is reported; operators
must not treat that outcome as a successful restore.

Keep the approval gates separate:

1. Merge the reviewed code and verify the release-record inputs.
2. Approve installation of the helper and deploy-v2 assets.
3. Approve Mac export and archive transfer.
4. Approve root import and attestation creation.
5. Approve enabling the Production deployment gate.
6. Approve the GitHub Production deployment.
7. Restore the deployment gate to disabled after acceptance.

An approval for export, installation, or import does not authorize container
replacement, database mutation, CAM/SSM activation, or a Production deployment.
