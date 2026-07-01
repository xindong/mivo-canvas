# Development Feedback Rule

User-facing feature flows that change app state, load data, run workflows, skip unavailable paths, or fail must emit Debug Log entries through `debugLogger`. Actions that need immediate user acknowledgement must use the global toast feedback API.

## Debug Log Levels

- `debugLogger.log(source, message)` for successful state changes, loaded data, and completed workflows.
- `debugLogger.warn(source, message)` for unavailable placeholder actions, skipped operations, offline connectors, invalid user context, and recoverable fallback paths.
- `debugLogger.error(source, message)` for failed requests, failed imports, blocked destructive operations, and unrecoverable runtime failures.

## Toast Feedback

Use `toastFeedback` from `src/store/toastStore.ts` for short, user-visible outcomes:

- `toastFeedback.success(message)` when a user-triggered action completes and there is no persistent on-screen confirmation.
- `toastFeedback.info(message)` for neutral acknowledgements or background state changes the user should notice.
- `toastFeedback.warn(message)` for recoverable skipped actions, unavailable prototype controls, or inputs that need attention.
- `toastFeedback.error(message)` for failed actions the user can see or retry.

Toasts are bottom-centered, transient, and intentionally brief. They should say what happened in product language, not expose stack traces or internal implementation details.

Ephemeral confirmations that do not change app state, such as a successful copy-to-clipboard action, can be toast-only. If that same action fails, log it with `debugLogger.error` and show an error toast.

## Scope

This rule applies to new buttons, menu items, canvas actions, asset workflows, imports, settings actions, and AI workflow actions. If an item is visible but not implemented yet, clicking it must still produce a warning log so the Debug Log panel explains what happened, and it should show a warning toast when the user needs immediate feedback.

Use both systems together when appropriate: `debugLogger` records what happened for diagnosis, while `toastFeedback` tells the user the visible result.

## Verification

Run:

```bash
npm run verify:logging
```

The verifier checks that the Debug Log store exposes all three levels, the toast feedback store exposes all four levels, key feature files emit required log levels, the Settings menu uses a logged action model, and this rule remains documented. `npm run test:e2e` runs the verifier before launching the smoke test.
