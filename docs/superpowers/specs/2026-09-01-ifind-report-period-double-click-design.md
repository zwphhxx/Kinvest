# iFinD Report-Period Double-Click Protection Design

## Problem

The administrator report-period diagnostic permits a second click while the first request is still being handled. The server correctly rejects the duplicate through its cooldown gate, but the browser applies that rejection as a replacement result. This clears the completed diagnostic and its in-memory, redacted failure evidence. The database confirms that only one real diagnostic ran, so the defect is client-side result ownership rather than duplicate vendor execution.

## Scope

This change applies only to the administrator report-period diagnostic control. It does not change iFinD request parameters, retry policy, quotas, persistence, household Mock data, authentication, or deployment protocols.

## Chosen Approach

Use a browser-side single-flight guard and preserve the last completed result:

- Acquire the guard synchronously before any asynchronous request work.
- Disable the diagnostic button while the request is in flight.
- Ignore subsequent activation attempts until the first request settles.
- A completed diagnostic response may replace the displayed result.
- A local duplicate, `IN_PROGRESS`, or `COOLDOWN` response may update transient status text but must not clear or replace the last completed result.
- Release the guard in a `finally` path so transport and rendering failures cannot leave the control permanently locked.
- Keep failure evidence in memory only; refresh or restart may still clear it, as designed.

## Alternatives Considered

1. Add a server idempotency key. This would provide broader protection but changes the HTTP and quota contracts and is unnecessary because the existing server gate already prevented the second vendor call.
2. Persist redacted failure evidence in SQLite. This would recover evidence after refresh, but expands retention and schema scope beyond the observed UI bug.
3. Use a time-based debounce only. This is weaker than a single-flight guard because a slow request can outlive the debounce interval.

## Error and State Rules

- The button reflects the in-flight state immediately, before the request promise yields.
- Duplicate activation does not issue another HTTP request.
- The existing result remains visible when the server reports cooldown or an already-running diagnostic.
- An ordinary completed failure, including `IFIND_RESPONSE_SHAPE`, remains a valid completed result and displays its redacted evidence.
- No raw iFinD payload, token, header, message, or stack trace is added to browser state, logs, SQLite, or tests.

## Test Contract

Automated frontend tests will prove:

- Two synchronous activations produce one HTTP submission.
- The button is disabled for the entire in-flight interval and re-enabled after settlement.
- A duplicate/cooldown outcome does not replace an existing completed result.
- A completed response-shape failure remains rendered with the existing safe evidence fields.
- Rejection releases the single-flight guard without introducing an automatic retry.

Existing type checks, lint, build, security checks, and container build remain required before merge.

## Acceptance

The fix is accepted when rapid repeated activation produces one real diagnostic attempt, the completed result remains on screen, and no production or persistence contract changes.
