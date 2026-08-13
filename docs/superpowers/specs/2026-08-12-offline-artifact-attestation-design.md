# Kinvest Offline Artifact Attestation Design
## Context

Kinvest production runs Docker 28 with the classic `overlay2` image store. An
offline `docker load` restores image content but does not restore a GHCR
`RepoDigest`. A multi-architecture OCI archive also contains an attestation
manifest that this image store cannot load directly. Repeating `docker pull`
therefore leaves production dependent on an unreliable cross-border registry
connection, while accepting a tag or Image ID without provenance would weaken
the immutable release contract.

This design adds an explicit cryptographic bridge between the release-record
digest and the local Docker Image ID. It does not manufacture a RepoDigest or
edit Docker's internal metadata.

## Scope

The change provides:

- a Mac export helper for one exact GHCR digest and `linux/amd64` runtime;
- a root-only server importer and verifier;
- a root-owned, non-secret offline attestation record;
- deploy-v2 support for either a real RepoDigest or a valid offline
  attestation;
- joint deployment state containing both source digest and runtime Image ID;
- compatible rollback for legacy, state v2, and new state v3 releases.

It does not enable SSM, CAM, device approval, TCR, iFinD, models, database
migrations, or a production deployment.

## Artifact model

The export helper accepts only:

```text
ghcr.io/zwphhxx/kinvest@sha256:<64 lowercase hex>
```

It performs an exact `linux/amd64` pull, confirms the local `RepoDigests`
contains that full reference, and writes a Docker archive. Docker 28 archives
contain both:

- `index.json`, `oci-layout`, and content-addressed OCI blobs that preserve the
  published top-level index and its source repository annotation;
- exactly one Docker `manifest.json` entry selecting the `linux/amd64` config
  and layer blobs that `docker load` can consume.

The helper writes through a private same-filesystem temporary file. Before
verification it creates a private same-filesystem `0700` directory and a
no-overwrite hard-link anchor to the temporary archive. Keeping that link alive
prevents Linux from recycling the verified inode if the temporary path is
unlinked and replaced with identical bytes. The helper records a durable armed-state
cleanup identity before publication, compares temporary, anchor, and
output identities and checksums at each boundary, and re-hashes the final bytes
before the no-overwrite hard link reports success. Interruption before completed success removes only
that process's linked inode. The anchor is removed on success, failure, and
handled signals, and it never appears in success metadata. Output contains only
the path, SHA-256, size, source digest, platform manifest digest, and runtime
config digest. The helper never reads registry credentials directly or writes
them to the archive.

## Import verification

The server importer takes positional non-secret metadata:

```text
import <archive> <archive-sha256> <source-digest-ref> <commit> <verification-run-id>
```

It must run as root. Before invoking Docker it verifies:

1. The archive is a regular non-symlink file with a matching SHA-256 and a
   bounded size.
2. Tar paths are relative, unique, and restricted to `oci-layout`,
   `index.json`, `manifest.json`, and `blobs/sha256/<digest>`. Links, devices,
   sparse members, traversal, and duplicate entries are rejected.
3. `index.json` has one top-level descriptor equal to the requested source
   digest and the exact GHCR source annotation `zwphhxx/kinvest`.
4. Every reachable descriptor has the declared digest and size. Parsing is
   bounded by descriptor count, depth, JSON size, and total archive size.
5. The top-level image index contains exactly one ordinary `linux/amd64` image
   manifest. Attestation manifests may be present but are validated and cannot
   be selected as runtime content.
6. The selected image manifest, config, and layers are content-addressed and
   complete. The config declares `linux/amd64` and the required Kinvest schema
   labels.
7. `manifest.json` contains exactly one entry whose config and ordered layers
   are identical to the selected OCI manifest. `RepoTags` must be null or
   empty.

After `docker load`, the importer confirms that `sha256:<config-digest>` exists,
that Docker reports the same ID and `linux/amd64` platform, and that its schema
and secret-bootstrap labels equal the validated config. A failed check never
writes an attestation.

## Attestation record

On success the importer atomically writes:

```text
/root/docker/kinvest/state/offline-images/<source-digest>.state
```

The directory is `root:root 0700`; records are regular `root:root 0600` files.
The canonical format is:

```text
version=1
sourceDigest=<full repository@sha256 reference>
platform=linux/amd64
platformManifestDigest=sha256:<64 lowercase hex>
runtimeImageId=sha256:<64 lowercase hex>
archiveSha256=<64 lowercase hex>
commit=<40 lowercase hex>
verificationRunId=<digits>
importedAt=<UTC RFC3339>
```

The record contains no credentials or secret values. Existing records are not
silently overwritten: an identical import is idempotent; different metadata
for the same source digest fails closed. Records are not automatically deleted
while current or previous deployment state may reference them.

## Deployment resolution

Deploy-v2 keeps the existing stdin envelope and release-record checks. For a
forward GHCR deployment it resolves the candidate in this order:

1. If Docker reports the exact requested RepoDigest, accept it and obtain its
   immutable Image ID.
2. Otherwise, validate the corresponding offline attestation against the
   payload digest, commit, and verification run ID, then confirm Docker still
   has the recorded Image ID with matching platform and labels.
3. Otherwise, use the existing bounded registry pull. The pull is accepted only
   if the exact RepoDigest appears afterward.

An invalid attestation is not treated as success. It is reported with a stable
error code and the normal pull path remains bounded. TCR never uses offline
GHCR attestations.

Schema-label checks, SSM preflight, Compose, and running-container verification
use the resolved immutable runtime reference. Offline candidates use the Image
ID directly; mutable tags are never created or trusted.

## Joint state v3 and rollback

Successful releases write state v3:

```text
protocolVersion=3
imageDigest=<source repository digest>
runtimeImageId=sha256:<64 lowercase hex>
commit=<commit>
schemaVersion=<SQLite user_version>
imageSchemaMin=<minimum>
imageSchemaMax=<maximum>
secretVersionIds=<canonical mapping>
releaseRecordSchemaVersion=<version>
verificationRunId=<run id>
artifactSource=<source>
databaseBackupPath=<path or none>
databaseBackupChecksum=<sha256 or none>
deployedAt=<UTC RFC3339>
```

The deployer continues to read legacy two-line state and state v2. For those
formats it resolves the running Image ID once and snapshots the previous
release as state v3 before mutation. `attempt.state` also records the runtime
Image ID.

Rollback checks the current schema range, confirms the exact previous Image ID
is still local, reruns the previous secret preflight by Image ID, and starts
that ID. It never relies on a mutable tag. Source digest, Image ID, schema,
secret VersionIds, backup, and release provenance move together. Existing
`ROLLBACK_REQUIRES_DB_RESTORE` behavior remains unchanged.

## Logging and failure behavior

Logs may contain stable result codes, source digest, Image ID, checksums, and
counts. They must not contain archive payloads, Docker configuration contents,
registry credentials, STS credentials, or secret values.

Importer failure leaves the production container and deployment states
untouched. Candidate-resolution failure occurs before database backup, Compose,
or state mutation. A container-switch failure follows the existing verified
rollback path.

## Installation and production gates

The existing installer adds the importer and verifier under
`/usr/local/libexec`. Installation validates Python syntax and a non-mutating
self-check, acquires the deployment lock, and transactionally installs root-owned
assets in the explicit order deployer, validator, helper, wrapper last. It does
not import an image, restart a container, or deploy.

After the PR is merged, production remains split into separate approvals:

1. install the importer, verifier, deployer, and related assets;
2. run one offline import and inspect its root-only attestation;
3. enable and approve the disabled-SSM J4-C deployment;
4. restore `DEPLOY_V2_ENABLED=false` after acceptance.

## Test strategy

Tests construct small deterministic archives and fake Docker commands. They
cover valid import, idempotency, checksum mismatch, unsafe tar members,
duplicate paths, descriptor tampering, missing blobs, unreferenced blobs, wrong
repository annotation, duplicate or absent runtime platform, config/layer
mismatch, Docker ID mismatch, and write-failure cleanup.

Deploy contract tests cover real RepoDigest precedence, valid offline fallback,
invalid or stale attestations, no-pull offline success, normal bounded pull,
state v3, legacy/v2 migration, candidate preflight by Image ID, and rollback by
previous Image ID. Full tests, typecheck, lint, build, shell/Python syntax,
sensitive-pattern scanning, and all three PR checks are required before merge.
