# Production verification - 2026-07-30

## Release identity

- Public URL: `https://dearmina.cn`
- Git commit: `b648fd403438acb1fa5a8cd80310814b43022508`
- Immutable image: `ghcr.io/zwphhxx/kinvest@sha256:9151484634c27f8f7041e9a9733462e153090ce68be54f7c20b897a7654f502f`
- GitHub Actions run: `30544540045`
- Data mode: `mock`

## Server and edge checks

- Application container: `healthy`
- SQLite status: `ready`
- SQLite file owner/mode: `10001:10001`, `0600`
- Nginx: `running`
- Nginx networks: `docker_default`, `web`
- Application host ports: none
- HTTPS GET `/`: `200`
- Health endpoint: `status=ok`, `service=kinvest`, `dataMode=mock`, `database=ready`
- Security headers observed: CSP, HSTS, `X-Frame-Options`, `X-Content-Type-Options`, Referrer Policy

## Browser checks

Desktop viewport: `1440 x 1000`

- Document width: `1425 / 1425`, no page-level horizontal overflow
- Mock financial identity visible
- Refresh quota and timing explanation visible
- Valuation thermometer position: `50`
- Quarterly switch displayed `2026-Q1`
- Research body visible after validated response
- Research thesis length: `48`

Mobile viewport: `390 x 844`

- Document width: `375 / 375`, no page-level horizontal overflow
- Finance table: `1024 / 301`, scrolls inside its own container
- Business breakdown table: `680 / 301`, scrolls inside its own container
- Mock identity and refresh explanation visible

Failure-closed check:

- Invalid research code `../api/health` was rejected
- Research body remained hidden
- User-facing message: `证券代码格式无效`

Browser console:

- Errors: `0`
- Warnings: `0`

## Rollback protection

- `current.state` records the release commit and exact immutable image above.
- `previous.state` records commit `790379a6f090c4275e88fda673c1acbd8b899b9b` and its previously healthy immutable image.
- A candidate pull was cancelled before container replacement; the previous production container remained `healthy`.
- The same exact candidate was then deployed from the preheated local image cache and passed health checks.
- The first Nginx cutover had previously exercised configuration rollback before the successful cutover.

These checks validate candidate isolation and preservation of the previous healthy release. A future schema-changing release must also pass the schema compatibility gate in the production runbook before an application rollback is attempted.

## Screenshots

- [Desktop home](screenshots/production-desktop-home.png)
- [Desktop research](screenshots/production-desktop-research.png)
- [Mobile home](screenshots/production-mobile-home.png)

## External integration boundary

This verification does not claim live iFinD, model-provider, or Tencent Cloud Secret Manager integration. Those remain stage 5 work and must not be represented as real until their identifiers, permissions, secret delivery, and minimum-query checks are complete.
