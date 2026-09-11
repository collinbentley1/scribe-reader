# Run preparation when a notebook changes

The watcher keeps one compiled Scribe Reader process running and checks one authorized notebook every five minutes. Bun orchestrates each capture in process through one native WebKit child. Normal checks use modification metadata. The first check and one check per day compare all page bytes.

Changed ordered page hashes queue one fixed notification for an existing Codex task. Title-only changes, unchanged checks, and local expiry do not call a model. The task uses the bundled [scribe-prep skill](../skills/scribe-prep/SKILL.md) to reconcile the notebook and prepare a local companion.

## Prepare a stable installation

Build and sign the product with the [macOS packaging commands](../README.md#package-for-macos), then place `Scribe Reader.app` in `~/Applications`. Shared Bun and the source checkout are build inputs; the installed watcher executes its own Mach-O and bundled reader.

```sh
SCRIBE="$HOME/Applications/Scribe Reader.app/Contents/MacOS/Scribe Reader"
```

Use a stable external Python 3.10 or newer with ReportLab 4.4.9 already installed. Configuration retains that runtime's absolute path and the absolute Codex executable path. No dependency installation occurs during polls. All Python calls pass `-B` to keep signed skill resources unchanged.

Copy [integration.example.json](../integration.example.json) to the private workspace for a new installation. It uses schema 2 and an absolute `app_bundle`. Existing schema-1 installations must follow the [migration sequence](../README.md#replace-an-existing-installation) before editing their configuration. Keep private fields and data paths unchanged. Do not copy the integration, profile, snapshots, or ledger into source or the app.

Use `"$SCRIBE" reader --config PATH -- login` and `list` while the supervisor is stopped. A dedicated persistent WebKit store replaces the previous browser session. Complete a fresh normal Amazon login; never extract or migrate cookies.

`cloud_reader.private_storage` must equal `~/Library/Application Support/Scribe Reader` expanded to an absolute path. The reader preserves that snapshot root; WebKit owns separate account storage. `watcher.thread_id` must identify the existing task that owns preparation. Select the actual Codex executable with `queue --thread` and `--message` support. Installation checks its help without sending a message.

The default watcher state directory is `<state_root>/watch`. `watcher.state_directory` can override it with an explicit private path. The queue notification includes only fixed policy and the private integration path. It does not include handwriting, notebook titles, or task text.

## Establish the reviewed baseline

For an existing workflow, retain `cloud_reader.review_checkpoint` and its immutable snapshot. The watcher validates the checkpoint and snapshot before adopting them. Finding a current capture alone never establishes review.

For a new workflow, perform one check:

```sh
"$SCRIBE" check --config /absolute/private/integration.json
```

Without a reviewed checkpoint, the successful capture becomes `baseline-required` and sends nothing. To explicitly request initial review, run:

```sh
"$SCRIBE" bootstrap --config /absolute/private/integration.json
```

The preparation task admits only pages with established current scope. Historical pages remain baseline or reference material. The [cloud intake instructions](../skills/scribe-prep/references/cloud-intake.md) define checkpoint fields and review behavior. If you complete the baseline manually instead, save that checkpoint and run `recover` while the watcher is stopped.

## Register the login service

Back up an existing installed `scribe-prep` directory and move it aside before installation. Keep its private ledger in place. Installation refuses to overwrite a different skill directory. It links the configured skill location to `Scribe Reader.app/Contents/Resources/skills/scribe-prep`.

```sh
"$SCRIBE" install --config /absolute/private/integration.json
"$SCRIBE" status --config /absolute/private/integration.json
```

Register the installed app with Launch Services using the packaging runbook before installation. Installation registers the user LaunchAgent `com.scribe-reader.watch` with `RunAtLoad` and starts it. A repeated matching installation preserves state. Status reports the observed process owner, last successful check, pause, capture fingerprints, delivery phase, and queue counters. A running job with `RunAtLoad` is not evidence that a full macOS login was observed.

For foreground operation during setup, use `run` instead of `install`. Do not run `check`, `recover`, `bootstrap`, or `delivery-test` while the supervisor owns its lock.

```sh
"$SCRIBE" run --config /absolute/private/integration.json
```

## Verify one notification

Stop the supervisor first, then explicitly request a delivery test:

```sh
"$SCRIBE" stop --config /absolute/private/integration.json
"$SCRIBE" delivery-test --config /absolute/private/integration.json
```

This writes a typed verification receipt and uses the same durable queue path as a content event. It performs no cloud capture or preparation. It refuses another test while an event is outstanding.

`queued` means Codex accepted the submission. The owning desktop task still needs to be loaded and idle to pick it up. A closed or unloaded task can remain queued. The producer never resumes the task in another process or opens a separate app-server daemon.

On pickup, the skill calls the built `target` command, then acknowledges the exact test receipt. Only that acknowledgement establishes pickup by the workflow. Start the supervisor after the test. Retire a previous model-driven polling schedule only after separately verifying unchanged checks, service behavior, queue acceptance, and owner pickup.

## Resume after login or failure

Sign in through the native window:

```sh
"$SCRIBE" stop --config /absolute/private/integration.json
"$SCRIBE" reader --config /absolute/private/integration.json -- login
"$SCRIBE" recover --config /absolute/private/integration.json
"$SCRIBE" start --config /absolute/private/integration.json
```

Authentication and unsupported protocol pause acquisition until recovery. A busy profile or transient transport failure waits for a later tick. The supervisor renders local expiry even while paused or awaiting acknowledgement. It never invokes a model solely to refresh expired output.

A failed or interrupted queue response can be `uncertain`. The watcher continues capturing but does not automatically send again. A valid acknowledgement resolves uncertainty. To authorize a retry with possible duplicate delivery, stop the supervisor and use:

```sh
"$SCRIBE" recover --config /absolute/private/integration.json --retry-uncertain
"$SCRIBE" start --config /absolute/private/integration.json
```

An accepted `queued` event cannot be retried through recovery. Investigate the owning task's pickup instead. Queue absence alone is not evidence that a previous notification was never processed.

## Remove the service

```sh
"$SCRIBE" remove --config /absolute/private/integration.json
```

Removal stops the matching service and removes its LaunchAgent. It preserves the installed skill link, profile, snapshots, ledger, receipts, and output. A mismatched service registration is refused before it is stopped or removed. A missing plist with a loaded or unknown job at the same label is refused before installation writes anything. Stop and removal also refuse an unverifiable or replaced process owner, and preserve the LaunchAgent if launchd cannot confirm that the service is absent. Stop waits up to 30 seconds for a matching job to unload; an unknown status fails immediately.

## Verify development changes

```sh
bun --no-env-file run check
bun --no-env-file test
bun --no-env-file run test:native
bun --no-env-file run build --out /absolute/empty/package-output
.venv/bin/python -B -m unittest discover -s skills/scribe-prep/tests -v
```

The watcher tests use synthetic snapshots, process substitutes for cloud and queue requests, real local child cancellation, and a real OS-held singleton lock. Service tests intercept launchctl calls and use an isolated plist directory. Python tests exercise the actual ledger commands and concurrent output renderers. These tests do not access an account or send a notification.

The machine must be awake, the profile valid, and writing uploaded to the cloud. Equal-marker edits may wait until the daily full audit. Captures remain metadata-bracketed, not guaranteed atomic cloud revisions. Parent pipe closure, cancellation, and native deadlines terminate the capture helper. Native session ownership and Bun publication ownership are both released by the OS when their owner exits. See [delivery state](watch-state.md) for receipt and crash semantics.
