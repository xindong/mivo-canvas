# Development Logging Rule

Every user-facing feature must emit Debug Log entries through `debugLogger`.

## Required Levels

- `debugLogger.log(source, message)` for successful user actions, state changes, loaded data, and completed workflows.
- `debugLogger.warn(source, message)` for unavailable placeholder actions, skipped operations, offline connectors, invalid user context, and recoverable fallback paths.
- `debugLogger.error(source, message)` for failed requests, failed imports, blocked destructive operations, and unrecoverable runtime failures.

## Scope

This rule applies to new buttons, menu items, canvas actions, asset workflows, imports, settings actions, and AI workflow actions. If an item is visible but not implemented yet, clicking it must still produce a warning log so the Debug Log panel explains what happened.

## Verification

Run:

```bash
npm run verify:logging
```

The verifier checks that the Debug Log store exposes all three levels, key feature files emit all three levels, the Settings menu uses a logged action model, and this rule remains documented. `npm run test:e2e` runs the verifier before launching the smoke test.
