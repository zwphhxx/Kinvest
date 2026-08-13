# Offline Artifact Attestation Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Kinvest to deploy a cryptographically verified offline GHCR artifact by binding its published source digest to the immutable local Docker Image ID without fabricating a RepoDigest.

**Architecture:** A focused Python verifier/importer validates one Docker archive's OCI index and selected `linux/amd64` Docker manifest, loads it, and atomically writes a root-only attestation. Deploy-v2 resolves either a real RepoDigest or that attestation to an immutable runtime Image ID and stores source digest plus runtime ID in backward-compatible joint state v3.

**Tech Stack:** Python 3 standard library, Bash, Docker Engine 28, Node.js contract tests, GitHub Actions.

---

## File map

- Create `deploy/server/offline-image-attestation.py`: archive verification, Docker load verification, attestation storage, and resolve CLI.
- Create `server/tests/offline-image-attestation.test.py`: deterministic archive fixtures and Python unit tests.
- Create `server/tests/offline-image-attestation.test.js`: Node adapter that runs the Python suite inside the existing test runner.
- Modify `server/tests/run-tests.js`: register the new test adapter.
- Modify `deploy/server/deploy-kinvest-v2.sh`: resolve immutable runtime Image IDs and read/write joint state v3.
- Modify `server/tests/deploy-v2-contract.test.js`: fake attestation helper, no-pull offline path, stale attestation failure, and Image-ID runtime assertions.
- Modify `server/tests/deploy-v2-secret-state.test.js`: state v3 and rollback VersionId assertions.
- Create `scripts/export-offline-image.sh`: deterministic Mac export wrapper around exact digest pull/save and archive verification.
- Modify `deploy/server/install-deploy-v2.sh`: atomically install and self-check the attestation helper.
- Modify `docs/operations/deploy-v2-runbook.md`: export, import, deploy, rollback, cleanup, and approval gates.

### Task 1: Archive verifier and deterministic fixtures

**Files:**
- Create: `deploy/server/offline-image-attestation.py`
- Create: `server/tests/offline-image-attestation.test.py`
- Create: `server/tests/offline-image-attestation.test.js`
- Modify: `server/tests/run-tests.js`

- [ ] **Step 1: Write failing archive-validation tests**

Build a tiny archive containing `oci-layout`, `index.json`, `manifest.json`, and content-addressed config/layer/manifest/index blobs. Assert the wished-for API:

```python
module = load_module()
result = module.verify_archive(archive, archive_sha, source_ref)
self.assertEqual(result.platform, "linux/amd64")
self.assertEqual(result.runtime_image_id, f"sha256:{config_digest}")
```

Add separate failing tests for checksum mismatch, traversal, symlink, duplicate member, unreferenced blob, wrong source annotation, tampered descriptor, missing blob, duplicate runtime platform, config/layer mismatch, and non-`linux/amd64` config.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
python3 server/tests/offline-image-attestation.test.py -v
```

Expected: failure because `deploy/server/offline-image-attestation.py` does not exist.

- [ ] **Step 3: Implement minimal bounded verification**

Define immutable result data and strict constants:

```python
@dataclasses.dataclass(frozen=True)
class VerifiedArchive:
    source_digest: str
    platform_manifest_digest: str
    runtime_image_id: str
    archive_sha256: str
    schema_min: int
    schema_max: int
    secret_bootstrap: str

ALLOWED_SOURCE = re.compile(
    r"^ghcr\.io/zwphhxx/kinvest@sha256:[0-9a-f]{64}$"
)
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_MEMBERS = 4096
MAX_JSON_BYTES = 1024 * 1024
MAX_DESCRIPTOR_DEPTH = 8
```

Use streaming SHA-256, reject unsafe or duplicate tar members, validate all reachable and only reachable blobs, select one ordinary `linux/amd64` manifest, and require exact ordered equality between OCI config/layers and Docker `manifest.json`.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run:

```bash
python3 server/tests/offline-image-attestation.test.py -v
node server/tests/offline-image-attestation.test.js
```

Expected: all archive-verifier cases pass.

- [ ] **Step 5: Register the suite and commit**

Add `require('./offline-image-attestation.test')` before deploy integration tests in `run-tests.js`, then run `npm test` and commit:

```bash
git add deploy/server/offline-image-attestation.py server/tests/offline-image-attestation.test.py server/tests/offline-image-attestation.test.js server/tests/run-tests.js
git commit -m "feat: verify offline deployment artifacts"
```

### Task 2: Root importer, attestation store, and resolver

**Files:**
- Modify: `deploy/server/offline-image-attestation.py`
- Modify: `server/tests/offline-image-attestation.test.py`

- [ ] **Step 1: Write failing importer and store tests**

Use `unittest.mock` for Docker subprocesses and temporary directories for state. Cover:

```python
record = module.import_archive(
    verified,
    archive_path,
    commit="a" * 40,
    verification_run_id="31601622272",
    state_dir=state_dir,
    docker=docker,
)
self.assertEqual(record.runtime_image_id, verified.runtime_image_id)
self.assertEqual(stat.S_IMODE(record_path.stat().st_mode), 0o600)
```

Assert no record on load/inspect mismatch, symlink rejection, canonical line order, identical import idempotency, conflicting overwrite rejection, strict owner/mode checks, exact commit/run matching, stale Image ID rejection, and stable error messages without Docker stderr disclosure.

- [ ] **Step 2: Run the focused test and confirm RED**

Run `python3 server/tests/offline-image-attestation.test.py -v`.

Expected: failures for missing `import_archive`, `AttestationStore`, and `resolve_attestation`.

- [ ] **Step 3: Implement import and resolve commands**

Add CLI forms:

```text
verify-archive <archive> <archive-sha256> <source-digest-ref>
import <archive> <archive-sha256> <source-digest-ref> <commit> <verification-run-id>
resolve <source-digest-ref> <commit> <verification-run-id>
self-check
```

`import` and `resolve` require root and use the fixed directory
`/root/docker/kinvest/state/offline-images`. Run Docker with argument arrays,
capture but never replay raw stderr, require `.Id`, platform, and labels to match
the verified archive, and atomically write canonical root-only state. `resolve`
prints exactly one `sha256:<64 hex>` line.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run:

```bash
python3 server/tests/offline-image-attestation.test.py -v
python3 deploy/server/offline-image-attestation.py self-check
python3 -m py_compile deploy/server/offline-image-attestation.py
```

Expected: all cases pass; self-check prints only `KINVEST_OFFLINE_ATTESTATION_SELF_CHECK_OK`.

- [ ] **Step 5: Commit importer behavior**

```bash
git add deploy/server/offline-image-attestation.py server/tests/offline-image-attestation.test.py
git commit -m "feat: attest imported runtime images"
```

### Task 3: Deploy-v2 runtime Image ID and joint state v3

**Files:**
- Modify: `deploy/server/deploy-kinvest-v2.sh`
- Modify: `server/tests/deploy-v2-contract.test.js`
- Modify: `server/tests/deploy-v2-secret-state.test.js`

- [ ] **Step 1: Write failing deployment contract tests**

Extend the fake root fixture with an attestation helper that returns a configured
Image ID. Assert:

```javascript
assert.equal(pulls.length, 0)
assert.match(composeUp, /KINVEST_IMAGE=sha256:[0-9a-f]{64}/)
assert.match(currentState, /^protocolVersion=3$/m)
assert.match(currentState, /^runtimeImageId=sha256:[0-9a-f]{64}$/m)
```

Add cases for exact RepoDigest precedence, valid offline fallback, wrong
commit/run, malformed helper output, missing local Image ID, registry pull
fallback, legacy/v2 current-state migration, automatic rollback by previous
Image ID, and secret preflight by runtime Image ID.

- [ ] **Step 2: Run focused deploy tests and confirm RED**

Run:

```bash
node server/tests/deploy-v2-contract.test.js
node server/tests/deploy-v2-secret-state.test.js
```

Expected: failures because deploy-v2 has no offline resolver or state v3.

- [ ] **Step 3: Implement candidate resolution and state v3**

Add fixed helper path and strict runtime ID parsing:

```bash
OFFLINE_IMAGE_ATTESTATION='/usr/local/libexec/kinvest-offline-image-attestation'
candidate_runtime_image_id=''

resolve_offline_image_id() {
  local value=''
  value="$($OFFLINE_IMAGE_ATTESTATION resolve "$digest_ref" "$commit_sha" "$verification_run_id" 2>/dev/null)" || return 1
  [[ "$value" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$value"
}
```

Resolve exact RepoDigest first, valid offline attestation second, and bounded
pull third. Use the resolved Image ID for labels, SSM preflight, Compose, and
container verification. Write state v3 with `runtimeImageId` after
`imageDigest`; continue strict reads of legacy and v2 state and snapshot them as
v3 before switching. Preserve schema and database-restore gates.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the two focused Node tests plus `bash -n deploy/server/deploy-kinvest-v2.sh`.

Expected: all pass and shell syntax succeeds.

- [ ] **Step 5: Commit deployment integration**

```bash
git add deploy/server/deploy-kinvest-v2.sh server/tests/deploy-v2-contract.test.js server/tests/deploy-v2-secret-state.test.js
git commit -m "feat: deploy attested local image IDs"
```

### Task 4: Export helper, installer, and operations contract

**Files:**
- Create: `scripts/export-offline-image.sh`
- Modify: `deploy/server/install-deploy-v2.sh`
- Modify: `server/tests/deploy-v2-contract.test.js`
- Modify: `server/tests/workflow-contract.test.js`
- Modify: `docs/operations/deploy-v2-runbook.md`

- [ ] **Step 1: Write failing helper and installer contract tests**

Assert the export helper accepts only the fixed GHCR digest pattern, uses
`docker pull --platform linux/amd64`, verifies exact `RepoDigests`, writes via a
temporary archive, calls `verify-archive`, and never invokes `docker login`.
Assert the installer validates, self-checks, and atomically installs the Python
helper at `/usr/local/libexec/kinvest-offline-image-attestation` without running
`import` or Docker.

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
node server/tests/deploy-v2-contract.test.js
node server/tests/workflow-contract.test.js
```

Expected: failures for the absent export helper and installer contract.

- [ ] **Step 3: Implement helper, installer, and runbook**

The export interface is:

```text
scripts/export-offline-image.sh <full-ghcr-digest-ref> <absolute-output.tar>
```

The installer creates one additional temporary file under `/usr/local/libexec`,
runs Python compile plus `self-check`, installs root-owned mode `0755`, and adds
it to cleanup traps. Document exact release-record inputs, archive checksum
handoff, root import command, attestation fields, state v3, cleanup rules,
failure behavior, and separate production approval gates.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run the focused tests plus:

```bash
bash -n scripts/export-offline-image.sh
bash -n deploy/server/install-deploy-v2.sh
python3 -m py_compile deploy/server/offline-image-attestation.py
```

- [ ] **Step 5: Commit operations assets**

```bash
git add scripts/export-offline-image.sh deploy/server/install-deploy-v2.sh server/tests/deploy-v2-contract.test.js server/tests/workflow-contract.test.js docs/operations/deploy-v2-runbook.md
git commit -m "docs: operationalize offline image attestation"
```

### Task 5: Full verification, independent review, and PR

**Files:**
- Verify all changed files from Tasks 1-4.

- [ ] **Step 1: Run full local verification**

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run build
bash -n deploy/server/deploy-kinvest-v2.sh
bash -n deploy/server/install-deploy-v2.sh
bash -n scripts/export-offline-image.sh
python3 -m py_compile deploy/server/offline-image-attestation.py
git diff --check origin/main...HEAD
```

Expected: every command exits zero.

- [ ] **Step 2: Run sensitive-information and scope audit**

Scan the complete branch diff for private-key markers, access-token patterns,
refresh tokens, registry passwords, `.env` files, and sensitive logs. Confirm
only the approved design, implementation, tests, helper, installer, and runbook
are present.

- [ ] **Step 3: Request specification and quality reviews**

Review against
`docs/superpowers/specs/2026-08-12-offline-artifact-attestation-design.md`, fix
all critical or important findings using new failing tests, and rerun the full
verification suite.

- [ ] **Step 4: Push and create the governed PR**

```bash
git push -u origin feat/offline-artifact-attestation
gh pr create --base main --head feat/offline-artifact-attestation
gh pr checks <number> --watch
```

Expected: `verify`, `security`, and `container-build` each pass once. Do not
merge; the user performs the manual merge.

- [ ] **Step 5: Stop at production gates**

After user merge, separately request approval to install the new assets, import
the candidate archive, and trigger the disabled-SSM J4-C deployment. Do not
combine those approvals.
