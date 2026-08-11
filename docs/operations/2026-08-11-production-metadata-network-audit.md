# Production metadata network audit

Date: 2026-08-11

Status: read-only audit complete; production changes not authorized or performed

## Decision

The production host is a Tencent Cloud CVM. Read-only guest evidence and the
approved production inventory agree on the product type. Shell usernames and
console URL paths were not treated as reliable product identifiers.

CAM/SSM activation is blocked. Both the Kinvest and Nginx containers can
currently reach the CVM metadata service at `169.254.0.23`. Binding an instance
role now would expose the same workload credentials to both containers.

No Docker network, firewall, systemd, CAM, SSM, container, or database state
was changed during this audit.

## Evidence handling

- Commands were executed interactively in Tencent Cloud OrcaTerm.
- Tests requested only a non-secret identity endpoint or discarded HTTP
  bodies.
- The CAM role endpoint was requested with its response body discarded; the
  body was never displayed or recorded.
- The public audit record excludes instance and container IDs, exact runtime
  versions, private IP addresses, network and firewall chain names, MAC
  addresses, terminal logs, and screenshots containing unrelated browser UI.
- No token, API key, refresh token, registry password, `.env` value, or
  temporary cloud credential was displayed or stored.

## Host baseline

| Item | Observed value |
|---|---|
| Product | Tencent Cloud CVM |
| Metadata service | Reachable from the host at the documented CVM endpoint |
| Instance identity endpoint | Reachable from the host |
| CAM role endpoint | HTTP 404; no role credentials are currently exposed |

Tencent Cloud documents that a VPC CVM can bind one CAM instance role and
obtain rotating STS credentials from the instance metadata service. This
confirms that workload identity is technically available on this host, but it
does not make the current container boundary safe. See [Managing instance
roles](https://cloud.tencent.com/document/product/213/47668) and [Viewing
instance metadata](https://cloud.tencent.com/document/product/213/4934).

## Docker baseline

| Item | Observed value |
|---|---|
| Docker Engine | Running with the expected Linux bridge firewall integration |
| Cgroup mode | systemd with cgroup v2 |
| Live restore | Disabled |
| Running application containers | Kinvest and Nginx |
| Application networking | Shared application bridge; Nginx has an additional bridge attachment |

### Kinvest container

- Runs as a non-root application user.
- Is not privileged.
- Drops all Linux capabilities.
- Uses `no-new-privileges:true`.
- Root filesystem is writable.
- Uses a dynamically assigned address on the shared application bridge.
- An HTTP request to the instance identity endpoint returned status 200.

### Nginx container

- Uses the image default user and runtime capability set.
- Is not privileged.
- Does not set `no-new-privileges`.
- Root filesystem is writable.
- Is attached to the shared application bridge and one additional bridge.
- A request to the instance identity endpoint succeeded.

Dropping all capabilities from Kinvest does not prevent ordinary TCP access to
metadata. Network policy is required. Nginx's broader runtime privileges are a
separate hardening concern, but metadata isolation must not depend on capability
configuration alone.

## Firewall baseline

| Item | Observed value |
|---|---|
| Firewall compatibility | iptables compatibility layer backed by nftables |
| Forwarding default | Drop |
| Pre-Docker ordering | A pre-existing forwarding chain runs before Docker's user chain |
| Docker user chain | Exists but currently passes traffic through |
| Metadata filtering | None |

Docker documents that `DOCKER-USER` is evaluated before Docker's own forwarding
rules and is the intended location for user filtering. The production host also
has an earlier forwarding jump, so the rollout must keep the repository's
fail-closed pre-Docker guard and verify ordering rather than assuming that an
appended rule is sufficient. See [Docker with
iptables](https://docs.docker.com/engine/network/firewall-iptables/).

## Reachability matrix

| Source | Instance identity endpoint | CAM role endpoint |
|---|---:|---:|
| Host | Reachable | HTTP 404 |
| Kinvest container | HTTP 200 | Not queried |
| Nginx container | Reachable | Not queried |

The role endpoint was intentionally tested only on the host and with the
response body discarded. A 404 proves that role credentials were not exposed
through that endpoint during the audit. It does not independently prove the
control-plane attachment state and is not evidence of container isolation.

## Required production change gate

The next production operation is a separate J3 change and requires explicit
user approval at action time. Approval of this audit or the overall plan does
not authorize it.

Before binding a CAM role:

1. Create a dedicated metadata-egress bridge that only Kinvest may join.
   Reserve a conflict-checked static Kinvest address on that bridge, validate
   that its membership count and container identity are exact, and ensure that
   the shared Nginx bridge is not selected for metadata egress.
2. Reconcile the repository firewall templates with the observed nftables
   compatibility mode, pre-existing forwarding jump, Docker user chain, and
   all discovered Docker bridge networks without publishing their identifiers.
3. Remove Nginx's unnecessary bridge attachment and capabilities where runtime
   tests show they are not required. This is defense in depth and does not
   replace network isolation.
4. Install the versioned, idempotent systemd firewall unit with an explicit
   rollback command and a lock against concurrent updates.
5. Place a fail-closed metadata guard before any chain that could accept the
   packet, then allow only the exact Kinvest source IP to
   `169.254.0.23/32` TCP port 80.
6. Match both the dedicated bridge interface and the exact Kinvest source IP;
   fail closed if either identity or network membership differs from the
   expected deployment state.
7. Deny Nginx and every other current Docker bridge source from reaching that
   exact metadata address. Do not broadly allow `169.254.0.0/16`.
8. Verify that ordinary application traffic, Nginx HTTPS, Docker health checks,
   and the public health endpoint remain healthy.
9. Verify host metadata access succeeds, Kinvest access succeeds, and Nginx
   plus an approved negative-test source are denied.
10. Because live restore is disabled, obtain a separate explicit approval and
    maintenance window before restarting Docker. Define outage, health, and
    container recovery criteria in advance; then re-run the reachability matrix
    and confirm the rules are restored.
11. Reboot verification remains a separate, explicitly approved interruption.

Only after this gate passes may the user bind a least-privilege CVM role. The
post-bind test must prove that Kinvest can request the intended role and read
only the explicitly allowed SSM secret versions while Nginx and other
containers cannot reach metadata. Long-term `SecretId` or `SecretKey` values
must not be used as a fallback.

## Rollback boundary

Before a role is bound, the network change must be reversible without Docker or
host restart. Rollback must remove only Kinvest-managed jumps and chains,
preserve platform-managed rules, and restore the pre-change reachability and
public health baselines.

After a role is bound, rollback must never restore broad container metadata
access. It must first detach the role through an explicitly approved
control-plane operation and keep a deny-all metadata rule in place for
non-host traffic until previously issued STS credentials have expired. If role
detachment or expiry cannot be verified, the safe rollback state is metadata
denied for every container, not the pre-audit network state.

If an untrusted workload reached role credentials, or exposure cannot be ruled
out, expiry is not sufficient incident containment. Through separately approved
control-plane actions, immediately remove the role's effective permissions,
audit cloud API use for the exposure window, and inventory every secret the
role could read. For externally issued credentials, revoke or rotate them at
the issuing system, verify that the old value is rejected, and only then store
the replacement under a new SSM VersionId. Creating or deleting an SSM version
alone is not credential revocation. For application-owned verifiers or signing
keys, replace the secret and revoke or migrate every dependent credential;
specifically revoke devices whose signing-key version may have been exposed.
Do not reactivate the role or delete old SSM versions until the incident record,
dependency migration, and rollback references have been reconciled.

If rule ordering, network discovery, dedicated-network membership, or static-IP
validation is ambiguous, installation must fail closed before the CAM role is
bound.

## J2 acceptance result

- Production product type and instance identity: confirmed.
- CVM instance-role capability: supported by Tencent Cloud documentation.
- Role credentials exposed through metadata: none observed; control-plane role
  attachment still requires an explicit pre-change check.
- Current container metadata isolation: failed.
- J3 firewall/static-IP rollout: required and awaiting its own approval.
- CAM/SSM and production device approval: remain disabled.
