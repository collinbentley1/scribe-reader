# Run preparation when a notebook changes

The watcher keeps one Bun process running and checks one authorized notebook every five minutes. Electron owns each bounded authenticated capture. Normal checks use modification metadata. The first check and one check per day compare all page bytes.

Changed ordered page hashes queue one fixed notification for an existing Codex task. Title-only changes, unchanged checks, and local expiry do not call a model. The task uses the bundled [scribe-prep skill](../skills/scribe-prep/SKILL.md) to reconcile the notebook and prepare a local companion.

## Prepare a stable installation

Use a stable checkout of this repository. Do not register a temporary worktree. Install Bun 1.4.2 and Python 3.10 or newer, then build the reader and watcher:

```sh
bun --no-env-file install --frozen-lockfile --ignore-scripts
bun --no-env-file node_modules/electron/install.js
bun --no-env-file run build
python3 -m venv .venv
.venv/bin/python -m pip install -r skills/scribe-prep/requirements.txt
```

The rendering dependency is ReportLab 4.4.9. No package installation occurs during polls. Use a stable absolute Bun path, such as `/opt/homebrew/bin/bun`, and the virtual environment's absolute Python path in configuration.

Use the reader's existing login and listing commands to authorize the profile and select a notebook ID. Keep the normal Amazon login window for authentication. Other reader commands hide the Dock icon.

Copy [integration.example.json](../integration.example.json) to your private preparation workspace and replace its placeholders. For an existing preparation workflow, add the `watcher` object to its integration file and preserve the rest. Do not copy credentials, notebook captures, the ledger, or the private integration file into the repository.

`cloud_reader.private_storage` must equal `~/Library/Application Support/Scribe Reader` expanded to an absolute path. The reader keeps that existing profile. `watcher.thread_id` must identify the existing task that owns preparation. Select the actual Codex executable with `queue --thread` and `--message` support. Installation checks its help without sending a message.

The default watcher state directory is `<state_root>/watch`. `watcher.state_directory` can override it with an explicit private path. The queue notification includes only fixed policy and the private integration path. It does not include handwriting, notebook titles, or task text.

## Establish the reviewed baseline

For an existing workflow, retain `cloud_reader.review_checkpoint` and its immutable snapshot. The watcher validates the checkpoint and snapshot before adopting them. Finding a current capture alone never establishes review.

For a new workflow, perform one check:

```sh
bun --no-env-file dist/watch.js check --config /absolute/private/integration.json
```

Without a reviewed checkpoint, the successful capture becomes `baseline-required` and sends nothing. To explicitly request initial review, run:

```sh
bun --no-env-file dist/watch.js bootstrap --config /absolute/private/integration.json
```

The preparation task admits only pages with established current scope. Historical pages remain baseline or reference material. The [cloud intake instructions](../skills/scribe-prep/references/cloud-intake.md) define checkpoint fields and review behavior. If you complete the baseline manually instead, save that checkpoint and run `recover` while the watcher is stopped.

## Register the login service

Back up an existing installed `scribe-prep` directory and move it aside before installation. Keep its private ledger in place. Installation refuses to overwrite a different skill directory. It links the configured skill location to this checkout's `skills/scribe-prep` directory.

```sh
bun --no-env-file dist/watch.js install --config /absolute/private/integration.json
bun --no-env-file dist/watch.js status --config /absolute/private/integration.json
```

Installation registers the user LaunchAgent `com.scribe-reader.watch` with `RunAtLoad` and starts it. A repeated matching installation preserves state. Status reports the observed process owner, last successful check, pause, capture fingerprints, delivery phase, and queue counters. A running job with `RunAtLoad` is not evidence that a full macOS login was observed.

For foreground operation during setup, use `run` instead of `install`. Do not run `check`, `recover`, `bootstrap`, or `delivery-test` while the supervisor owns its lock.

```sh
bun --no-env-file dist/watch.js run --config /absolute/private/integration.json
```

## Verify one notification

Stop the supervisor first, then explicitly request a delivery test:

```sh
bun --no-env-file dist/watch.js stop --config /absolute/private/integration.json
bun --no-env-file dist/watch.js delivery-test --config /absolute/private/integration.json
```

This writes a typed verification receipt and uses the same durable queue path as a content event. It performs no cloud capture or preparation. It refuses another test while an event is outstanding.

`queued` means Codex accepted the submission. The owning desktop task still needs to be loaded and idle to pick it up. A closed or unloaded task can remain queued. The producer never resumes the task in another process or opens a separate app-server daemon.

On pickup, the skill calls the built `target` command, then acknowledges the exact test receipt. Only that acknowledgement establishes pickup by the workflow. Start the supervisor after the test. Retire a previous model-driven polling schedule only after separately verifying unchanged checks, service behavior, queue acceptance, and owner pickup.

## Resume after login or failure

Use the existing profile for login:

```sh
bun --no-env-file dist/watch.js stop --config /absolute/private/integration.json
bun --no-env-file run start login
bun --no-env-file dist/watch.js recover --config /absolute/private/integration.json
bun --no-env-file dist/watch.js start --config /absolute/private/integration.json
```

Authentication and unsupported protocol pause acquisition until recovery. A busy profile or transient transport failure waits for a later tick. The supervisor renders local expiry even while paused or awaiting acknowledgement. It never invokes a model solely to refresh expired output.

A failed or interrupted queue response can be `uncertain`. The watcher continues capturing but does not automatically send again. A valid acknowledgement resolves uncertainty. To authorize a retry with possible duplicate delivery, stop the supervisor and use:

```sh
bun --no-env-file dist/watch.js recover --config /absolute/private/integration.json --retry-uncertain
bun --no-env-file dist/watch.js start --config /absolute/private/integration.json
```

An accepted `queued` event cannot be retried through recovery. Investigate the owning task's pickup instead. Queue absence alone is not evidence that a previous notification was never processed.

## Remove the service

```sh
bun --no-env-file dist/watch.js remove --config /absolute/private/integration.json
```

Removal stops the matching service and removes its LaunchAgent. It preserves the installed skill link, profile, snapshots, ledger, receipts, and output. A mismatched service registration is refused before it is stopped or removed. Stop and removal also refuse an unverifiable or replaced process owner, and preserve the LaunchAgent if launchd cannot confirm that the service is absent.

## Verify development changes

```sh
bun --no-env-file run check
bun --no-env-file test
bun --no-env-file run build
.venv/bin/python -m unittest discover -s skills/scribe-prep/tests -v
```

The watcher tests use synthetic snapshots, process substitutes for cloud and queue requests, real local child cancellation, and a real OS-held singleton lock. Service tests intercept launchctl calls and use an isolated plist directory. Python tests exercise the actual ledger commands and concurrent output renderers. These tests do not access an account or send a notification.

The machine must be awake, the profile valid, and writing uploaded to the cloud. Equal-marker edits may wait until the daily full audit. Captures remain metadata-bracketed, not guaranteed atomic cloud revisions. A hard-killed supervisor can leave its bounded Electron worker alive until its existing deadline. The profile lock prevents another authenticated owner in that interval. See [delivery state](watch-state.md) for receipt and crash semantics.
