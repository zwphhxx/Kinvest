# Production read-only audit - 2026-08-01

This record contains no credential values, temporary cloud credentials, tokens,
or application data. The audit made no server changes.

## Confirmed baseline

| Item | Observed state | Decision |
|---|---|---|
| Workload | CVM host, Kinvest and Nginx containers healthy | Keep production unchanged until the v2 gate is approved |
| CAM role | Metadata endpoint returned no CAM role | Real SSM access remains disabled |
| Installed forced wrapper SHA-256 | `bf3ea8aff3bddd75a76406c26b7625804275dac18e684e78aaedc2de6174a3bd` | Does not match current repository |
| Installed root deploy SHA-256 | `9ee996ace2c8211622a4586cedd21bf9fa3ae6c42b79124e03b885eccd49ea67` | Does not match current repository |
| Repository wrapper SHA-256 | `dbf1e67b9c2a54e8d600de349a1bfeedb116a03685f0c5e51c31d6e68da39fe1` | Do not install without a separate approval |
| Repository root deploy SHA-256 | `e71cb3777119f8328264749551a3f7b7f04044b10166c33bc80999b2bfe719ad` | Do not install without a separate approval |
| Running source | GHCR immutable digest, Mock mode | Production has not moved to TCR |
| Deployment state | Current and previous both reference the same legacy GHCR release | Image-only rollback has no independent older release |
| SQLite | `/root/docker/kinvest/data/kinvest.sqlite`, mode `0600`, UID/GID `10001:10001`, `user_version=0`, `quick_check=ok` | v2 must preserve schema 0 compatibility |
| Docker registry config | `/root/.docker/config.json`, root-owned mode `0600`, TCR auth entry present, GHCR entry absent, no observed `credsStore` | Treat as a persistent credential; v2 must not read it |
| Metadata reachability | Host, Kinvest, and Nginx all received HTTP 200 from the instance metadata endpoint | CAM binding is blocked until isolation is approved and verified |
| Metadata firewall | No `KINVEST-METADATA` nftables chain | Isolation is not implemented |
| Metadata systemd unit | `kinvest-metadata.service` not found | Persistence is not implemented |
| Public health | HTTPS health endpoint returned `status=ok`, `dataMode=mock`, `database=ready` | Existing production remains the fallback |

## TCR decision

TCR is **no-go for production at this baseline**. The account can push and the
server has a persistent TCR Docker auth entry, but an independently revocable,
pull-only production credential has not been demonstrated. The production
release source therefore remains the public GHCR immutable digest. The existing
TCR entry must not be reused by deploy-v2 and must not be deleted without a
separate user-approved credential cleanup operation.
