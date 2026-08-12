# J4-B deploy-v2 secret VersionId contract

Date: 2026-08-12

## Repository-only status

J4-B extends the repository deployment contract. It does not install a server
asset, connect to production, change a GitHub Environment, bind CAM, create an
SSM Secret, read a real secret, migrate SQLite, or restart a container. Those
operations remain separate approval gates beginning with J4-C.

## Envelope semantics

The existing `KINVEST_DEPLOY_V2` stdin line order is unchanged. Its reserved
`secretVersionIds` line now has three exact meanings:

```text
{}
{"adminPasswordVerifier":"vYYYYMMDD-NNN","deviceTokenHmac":{"accepted":["vYYYYMMDD-NNN"],"active":"vYYYYMMDD-NNN"}}
{"rollback":"previous"}
```

The first form is disabled. The second is a forward mapping and must be the
byte-for-byte canonical representation accepted by both the J4-A application
contract and the deployment validator. The third is a command sentinel, not
state. It is accepted only for the exact digest and commit already recorded in
`previous.state` and resolves to that state's canonical mapping before any
candidate invocation or state write.

## Workflow construction

The manual Production workflow reads four non-secret Environment Variables only
after the Production approval gate:

```text
SSM_BOOTSTRAP_ENABLED
SSM_ADMIN_PASSWORD_VERIFIER_VERSION_ID
SSM_DEVICE_TOKEN_HMAC_ACTIVE_VERSION_ID
SSM_DEVICE_TOKEN_HMAC_ACCEPTED_VERSION_IDS
```

Unset or `false` produces `{}` and rejects nonempty dependent values. `true`
requires all three dependent values and validates the accepted JSON array,
VersionId format, sorting, uniqueness, size, and active membership. The result
is canonicalized again immediately before the encrypted SSH stdin operation.
The workflow does not print the mapping and does not expose these values as
Secrets.

## Candidate ordering and isolation

Enabled mappings require a one-shot J4-A preflight before backup or mutation.
The deployer verifies the bootstrap image label and entry file, then runs the
candidate as non-root with a read-only filesystem, no capabilities,
`no-new-privileges`, and the currently running Kinvest network namespace. Only
provider mode and VersionId JSON enter that container. Exact stdout, empty
stderr, expected reference count, and a zero status are all mandatory.

Failure leaves the database, Compose runtime, `attempt.state`, and successful
release states untouched. `{}` skips the preflight so the current Mock behavior
continues unchanged.

## Joint rollback

Successful state files remain root-owned mode `0600` and record only image,
commit, schema compatibility, release provenance, backup metadata, and the
canonical VersionId mapping. Automatic rollback restores the previous mapping
with the previous image. Manual one-step rollback uses the sentinel plus the
exact previous digest and commit. If the previous image does not support the
current schema, `ROLLBACK_REQUIRES_DB_RESTORE` remains the terminal automatic
boundary; switching only the digest is not considered a complete rollback.

No SecretString, STS credential, password, HMAC key, long-lived cloud key, or
rollback sentinel may be written to state or logs.
