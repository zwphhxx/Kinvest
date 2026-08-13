# deploy-v3 GitHub tmpfs production runbook

## Scope and security boundary

deploy-v3 delivers the two Kinvest bootstrap materials through this path:

```text
GitHub Production Secrets
  -> Production required-reviewer approval
  -> encrypted SSH standard input
  -> /run/kinvest-secrets on host tmpfs
  -> read-only container mount
```

The materials must never be placed in the repository, workflow artifacts, command arguments, logs, container environment, database, Docker image, or persistent server storage. The workflow does not use `GITHUB_ENV` for either material. It constructs the fixed 12-line payload in the approved deploy step's memory, validates it locally, and sends it to the forced SSH command whose only command argument is `deploy-v3`.

This phase establishes secret bootstrap only. It does not enable administrator login, device cookies, real iFinD data, model calls, CAM, SSM, or KMS.

## Production configuration

Configure these GitHub `Production` Environment Secrets in the GitHub UI. Do not place their values in chat or shell history.

```text
KINVEST_ADMIN_PASSWORD_VERIFIER_B64URL
KINVEST_DEVICE_TOKEN_HMAC_KEY
```

Configure these `Production` Environment Variables:

```text
DEPLOY_USER=kinvest-deploy
DEPLOY_V3_ENABLED=false
TMPFS_BOOTSTRAP_ENABLED=false
TMPFS_ADMIN_PASSWORD_VERIFIER_VERSION_ID=vYYYYMMDD-NNN
TMPFS_DEVICE_TOKEN_HMAC_VERSION_ID=vYYYYMMDD-NNN
```

`DEPLOY_HOST`, `DEPLOY_PORT`, and `DEPLOY_USER` remain non-secret Production variables. The production forced-command account is fixed as `kinvest-deploy`; do not substitute the maintenance account. `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS` remain Production Environment Secrets.

Generate bootstrap materials only with the local interactive generator. It writes the result to the macOS clipboard, not standard output or disk. Paste directly into the GitHub Environment Secret field and clear the clipboard immediately. `SIGKILL` cannot be intercepted, so confirm the clipboard is empty before leaving the workstation.

Version IDs identify material immutably. Reusing one VersionId with different material must fail with `SECRET_VERSION_REUSE_CONFLICT`. Kinvest keeps one active HMAC version in this free scheme. HMAC rotation revokes all device credentials before the new version is activated.

The root-owned `0600` VersionId fingerprint ledger is append-only for the lifetime of the installation. A VersionId remains reserved after it rolls out of `current.state` and `previous.state`; do not delete or edit ledger history to reuse a name.

## Gate 1: install server assets

Do not install deploy-v3 server assets merely because the code PR merged.

1. Record the exact merged commit and expected SHA-256 hashes for the dispatcher, root deployer, contract helper, Compose file, sudoers policy, and installer. Verify the installer hash manually before running it.
2. Confirm `Production/DEPLOY_USER=kinvest-deploy`, the current v2 deployment state, J3 timer, internal health, public HTTPS health, and rollback backup.
3. Obtain explicit approval to install server assets.
4. Run the reviewed installer only after its own hash matches. The installer compares every asset with its embedded merged-commit hash, copies it into a root-private `/run` staging directory, writes the old assets and a hash manifest to the persistent root-only `/root/docker/kinvest/install-backups/deploy-v3` tree, then atomically installs the staged copy.
5. Keep `DEPLOY_V3_ENABLED=false` and `TMPFS_BOOTSTRAP_ENABLED=false`.
6. Confirm the forced-command dispatcher accepts only the exact literals `deploy-v2` and `deploy-v3`. It must reject arguments, prefixes, suffixes, shell operators, and every other command.
7. Confirm `visudo -cf /etc/sudoers.d/kinvest-deploy-v3` succeeds. Both entries are granted only to the production forced-command account `kinvest-deploy` and include the sudoers empty-argument constraint `""`, so the dedicated rule permits only no-argument execution of the two fixed deployer paths. Review `sudo -n -U kinvest-deploy -l` and the maintenance account's permissions separately; record any broader inherited administrator rule as a residual trusted-admin boundary and do not add a wildcard deploy command.

The dispatcher preserves the currently installed v2 path, `/usr/local/sbin/deploy-kinvest`, during the disabled v3 baseline. If the first v3 switch fails, the deployer restores the exact protocol-v3 state bytes, so the migration boundary is not crossed. Only the first successful v3 deployment writes protocol-v4 state; after that, v2 is no longer a deployment rollback mechanism because its older state parser must fail closed. All later forward, rollback, and reboot recovery operations use deploy-v3 until a separately reviewed v2 retirement change removes the legacy branch.

Any hash, owner, permission, syntax, or health mismatch stops the installation. Restore the backups and leave v3 disabled.

## Gate 2: disabled baseline deployment

Use a successful `main` release run that contains one non-expired `release-record v2` artifact. The validation job independently verifies the run, artifact name, commit, digest, GHCR source, and ancestry before the Production job can request approval.

After approval, the deploy job re-reads the current `main` SHA. The workflow control-plane SHA must still equal current `main`; FORWARD also requires the target release SHA to equal it. The deploy helper always comes from that trusted control-plane checkout. Historical release commits provide metadata and image identity only and are never executed with Production Secrets.

1. Keep `TMPFS_BOOTSTRAP_ENABLED=false`.
2. Temporarily set `DEPLOY_V3_ENABLED=true`.
3. Dispatch `Deploy production v3 (manual)` from `main`.
4. Select `FORWARD`, enter `DEPLOY_V3`, and provide the successful release run ID.
5. Review the validated commit and deployment summary, then explicitly approve the `Production` deployment.
6. Verify Mock mode, SQLite health, public HTTPS, security headers, and the J3 timer.
7. Restore `DEPLOY_V3_ENABLED=false` immediately after acceptance.

Disabled mode sends `disabled` plus four empty VersionId/material lines. It does not expose the two bootstrap Secrets to the step environment through the conditional expressions.

## Gate 3: tmpfs bootstrap deployment

1. Enter both Environment Secrets in the GitHub UI and set fresh VersionId variables.
2. Set `TMPFS_BOOTSTRAP_ENABLED=true` while leaving `DEPLOY_V3_ENABLED=false`.
3. Confirm `/run` is tmpfs and the current image supports `github-tmpfs-v1` preflight.
4. Temporarily set `DEPLOY_V3_ENABLED=true`.
5. Dispatch `FORWARD` with confirmation `DEPLOY_V3` and approve the `Production` deployment.
6. Confirm state protocol v4 records only VersionIds, SHA-256 fingerprints, and bundle ID. It must not contain secret material.
7. Scan workflow, deployer, Docker, application, and system logs for sensitive patterns without printing candidate values.
8. Verify internal and public health remain Mock and no authentication route has been opened.
9. Restore `DEPLOY_V3_ENABLED=false`.

The root deployer must create the candidate bundle and pass isolated preflight before database backup, Compose replacement, or success-state writes. A failed preflight deletes the candidate bundle and leaves the running deployment unchanged.

## Intent and confirmation matrix

| Intent | Required confirmation | Use |
|---|---|---|
| `FORWARD` | `DEPLOY_V3` | Deploy the current `main` release after attestation validation |
| `ROLLBACK` | `ROLLBACK_V3` | Select exact previous image state while applying the currently approved GitHub materials |
| `RESTORE` | `RESTORE_V3` | Rebuild the lost tmpfs bundle for exact current state without pull, migration, backup, or digest change |

`ROLLBACK` never resurrects revoked secret material. It uses the materials currently stored in the Production Environment and stops if the previous image cannot use `github-tmpfs-v1` or cannot support the current schema.

`RESTORE` requires a release run whose digest and commit match `current.state` exactly. A mismatch fails closed. RESTORE does not pull an image, migrate or restore the database, change release provenance, or change the active digest.

When RESTORE reconciles an existing `attempt.state`, it reads the actual SQLite schema after the container is healthy and carries forward the attempt's pre-migration backup reference. The resulting `current.state` records that actual schema and backup instead of silently restoring stale values.

## Failure-closed behavior

- A missing or malformed release artifact stops before Production approval.
- A disabled deploy gate stops after approval but before SSH setup or deployment.
- Invalid mode, VersionId, material, payload line count, provenance, or registry metadata stops before SSH.
- SSH only receives the payload on standard input. Materials must not appear in `ps`, command arguments, runner output, SSH command text, or state files.
- Candidate preflight failure leaves the existing container, database, and state unchanged.
- Runtime startup failure restores only a compatible prior image with current approved material; otherwise it stops at an explicit recovery gate.
- Recovery first stops the failed candidate and reads the migrated on-disk schema. It never starts the old image until that actual schema is inside the old image's declared range. Compatible recovery records the actual schema and the new backup; incompatible recovery returns `ROLLBACK_REQUIRES_DB_RESTORE`.
- During the one-time protocol-v3 baseline migration, any schema change before a failed switch also returns `ROLLBACK_REQUIRES_DB_RESTORE`; the deployer will not write a stale protocol-v3 schema value or start the old image.
- SQLite backup creation and both pre- and post-rename `quick_check` validations are mandatory. Any failed operation removes the invalid candidate backup and stops before Compose.
- Atomic-state recovery markers include old content and the candidate hash. Startup only clears a marker when the destination provably equals one of those states; an ambiguous state stops at `DEPLOY_V3_ATOMIC_RECOVERY_REQUIRED`.
- The active bundle is protected before `current.state` commit. A post-commit cleanup failure reports `DEPLOY_V3_CLEANUP_PENDING` but cannot delete the mounted bundle. The fixed disabled directory is never treated as candidate-owned cleanup.
- Every unreferenced random bundle removal has an explicit checked result. A malformed or partially written bundle stops cleanup with `DEPLOY_V3_CLEANUP_PENDING` instead of being silently retained behind a successful deployment result.
- Any existing `attempt.state` blocks ordinary `FORWARD` and `ROLLBACK`. Do not delete or overwrite it manually. Use an approved exact-state `RESTORE` to reconcile the running image, schema, current approved material, and state.
- A failed automatic recovery preserves `attempt.state` and the candidate tmpfs bundle and returns `DEPLOY_V3_RECOVERY_FAILED`; treat this as an incident and do not retry a normal deployment.
- Once `github-tmpfs-v1` is active, a normal intent cannot downgrade the provider to `disabled`.
- No failure path may fall back to Mock secrets, long-lived cloud credentials, disk files, or a less restricted provider.

## Docker restart and CVM reboot

A Docker service restart does not clear the host `/run` tmpfs. The existing bundle should remain available, and containers can be recreated from the same read-only mount. Verify health and state after restart.

A CVM reboot clears `/run`. This is intentional: the application must fail closed rather than start without its approved material. Recovery requires a new human-approved Production deployment:

1. Verify the server rebooted cleanly, the application is unavailable for the expected secret-bootstrap reason, and the database volume is intact.
2. Confirm `current.state` and the locally present runtime Image ID have not changed.
3. Keep `TMPFS_BOOTSTRAP_ENABLED=true` and verify the two VersionId variables still match `current.state`.
4. Temporarily set `DEPLOY_V3_ENABLED=true`.
5. Dispatch `RESTORE` with confirmation `RESTORE_V3` and the release run matching the current digest and commit.
6. Approve the `Production` deployment.
7. Verify the exact current image, schema, release provenance, bundle fingerprints, internal health, public HTTPS, Mock status, and J3 timer.
8. Restore `DEPLOY_V3_ENABLED=false`.

If RESTORE cannot prove exact state equality, do not switch to FORWARD as a shortcut. Investigate the state mismatch and obtain a separate recovery approval.

## Acceptance evidence

Retain only non-secret evidence:

- workflow run ID and approval time;
- release run ID, commit, immutable digest, and release-record schema;
- deployed state protocol, schema range, VersionIds, fingerprints, and bundle ID;
- installed asset hashes and backup location;
- SQLite quick check, internal health, public HTTPS, security-header, Mock-mode, and J3 timer results;
- a sensitive-pattern scan result containing counts only, never matched values.

The final steady state is `DEPLOY_V3_ENABLED=false`. Production secrets remain confined to the `Production` Environment, and tmpfs bootstrap may remain enabled only after the controlled deployment has passed acceptance.
