# iFinD local provenance contract implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Execute the bounded repair below; preserve all live-data approval gates.

**Goal:** Stop treating Kinvest-generated collection time and source mode as vendor indicators.

**Architecture:** Keep the existing branded, immutable evidence bundle. Financial metadata distinguishes seven vendor-backed fields from two fixed local descriptors. The diagnostic service supplies collection time after receiving the financial response; the parser validates remote content and the service rejects a parser that changes this trusted time.

**Tech Stack:** CommonJS Node.js, node:assert, node:sqlite; existing HTTP client and test harnesses. No dependency or schema changes.

## Scope and decisions

The user's instruction to execute the next step authorizes this local repair and PR, not deployment or real calls. The official metadata evidence remains separate from production configuration. All three production cases stay liveReady=false.

Use the smallest repair for the two proven provenance defects. Do not introduce arbitrary JSON-path mappings or infer response-envelope fields while their exact contracts are unverified. Other metadata retains its existing explicit vendor evidence gate. Quote time, units, reporting periods and financial indicator selection are not made live by this change.

The exact local descriptors are:

```javascript
fetchTime: { source: 'runtime-clock' },
sourceMode: { source: 'verified-adapter' }
```

These descriptors accept no additional keys or vendor IDs. Remote metadata retains vendorIndicatorId, evidenceStatus and sourceReference. Only remote IDs enter financial request indicatorIds and provider dataVol accounting.

## Files

- Modify server/domain/ifind-market-manifest-validator.js: validate the two local descriptor shapes and exclude them from request IDs.
- Modify server/domain/ifind-market-cases.js: represent known local provenance without marking any vendor evidence verified.
- Modify server/domain/ifind-market-financial-parser.js: require trusted input.fetchTime, reject provider provenance injection, preserve missing values and all fiscal/currency checks.
- Modify server/services/ifind-market-diagnostic-service.js: capture trusted completion time and bind parser output to it.
- Modify server/tests/helpers/ifind-market-evidence.js and the existing market cases, financial parser, service and integration test modules: migrate synthetic evidence and cover the repaired boundary.
- Add docs/operations/2026-08-30-ifind-market-metadata-evidence.md: record confirmed UI metadata and explicit remaining uncertainties.

## Task 1: RED tests and fixture migration

Write assertions for both local descriptor shapes, old vendor-backed local mappings rejected, malformed/getter/proxy descriptors rejected without evaluation, and outgoing requests excluding local provenance IDs. Preserve seven verified dimensions, immutable bundle checks and production zero-network gates.

Financial parser inputs include an explicit trusted time:

```javascript
parseIfindMarketFinancials({
  caseId, payload, verification, financialReportingCurrencyEvidence,
  manifestBundle, fetchTime: '2026-08-29T04:00:00.000Z'
})
```

Test missing/invalid trusted time, sourceTime after collection, vendor-injected sourceMode/fetchTime, and missing real metrics remaining missing. Integration tests check all three markets persist the trusted clock value and reject parser-forged fetchTime.

Run the focused modules before production edits and retain the expected failing assertions:

```sh
node -e "require('./server/tests/ifind-market-cases.test').run().catch(e=>{console.error(e);process.exitCode=1})"
```

## Task 2: One production patch

Update the four runtime files together. Capture financialFetchTime only after a successfully decoded financial response, using the existing reservation/clock validation. Pass it to the financial parser separately from payload. Require each returned point.fetchTime to equal the captured value exactly. Keep original safe error handling, lease/budget checks and cleanup.

Do not trust provider sourceMode. Real source classification remains conditional on the verified internal evidence bundle and successful payload validation. The parser's remote table allowlist excludes both local fields, and dataVol counts only actual remote arrays.

## Task 3: Verification and independent review

Run focused cases, quote/financial parser, diagnostic service and HTTP/repository integration suites. Then run the existing project gates:

```sh
npm run check
```

All tests use local fixtures and synthetic transport. No credentials, external data requests, production access, migration or network-rule changes. Obtain separate spec and quality review; a discovered defect is reported before any unapproved follow-up correction.

## Task 4: PR delivery

Inspect the scoped diff for secrets and unintended changes, commit only the repair and evidence files, and push fix/ifind-provenance-contract. Open a PR against main and observe verify, security and container-build. The user merges manually. Do not alter repository governance, Production variables or trigger deployment.
