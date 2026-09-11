# Preparation workflow

Read the schema-2 private integration file identified by the event or requested workspace. Its `app_bundle`, `workspace`, `state_root`, `skill`, and `cloud_reader` fields supply all paths. Set `SCRIBE` to `app_bundle` followed by `/Contents/MacOS/Scribe Reader`. Preserve the existing ledger when installing this skill. Read [state formats](state-format.md) before changing observations or preparation records.

The resident reader polls the cloud notebook without a model. A fixed notification wakes the existing Codex task only for changed notebook content or an explicitly requested delivery test. It retires expired output locally. Research refresh waits until the next notebook-change event.

## Handle an event

1. Run `"$SCRIBE" target --config /absolute/integration.json`. Keep the returned receipt, `receiptPath`, and `receiptSha256` together. They identify immutable input. Do not substitute a newer target midway through review.
2. For `no-work`, stop. For `delivery-test`, acknowledge that receipt using step 6 and stop. A transport test requests no review or preparation.
3. For `review`, follow [cloud intake](cloud-intake.md). Inspect both the exact snapshot and current ledger, including observations accepted after the checkpoint. Preserve task identity, completion, access denials, dependencies, draft receipts, authored dates, and expiry.
4. Save reviewed observations before preparation. Run `due` and handle useful pending or expired preparation within the source's active scope. Reuse valid drafts and artifacts. Reconcile uncertain external outcomes before retrying. A todo does not authorize sending messages or submitting forms.
5. Complete the reviewed checkpoint for this receipt's snapshot after every relevant page disposition is complete. A matching completed checkpoint resumes from the ledger and finishes rendering without repeating completed preparation. Even when the target matches the older checkpoint, reconcile partial later ledger observations that differ.
6. Run `"$SCRIBE" acknowledge --config /absolute/integration.json --receipt /absolute/receipt.json` with the pinned receipt path. For a notebook change, the helper validates the checkpoint, runs both renderers, and publishes a receipt-bound acknowledgement. Retry this command after a local render failure. Do not fabricate acknowledgement files.

Acceptance, owner pickup, review, rendering, and acknowledgement are separate results. An acknowledgement of an older snapshot does not claim that a newer capture was reviewed. The watcher queues one follow-up when content differs.

## Handle a shared file

Use the configured inbox for explicitly shared photos or exported PDFs. Keep it separate from `state_root`. Follow [email intake](email-intake.md) only for an authorized mailbox source. Email exports are shared snapshots, not continuous synchronization.

Run `scan`, inspect the original visually, and use `inspect` to recover task IDs and metadata. `observe` accepts the reviewed transcription. `due` identifies eligible preparation. Import time does not establish writing date or extend active scope. A manual review must not advance a cloud checkpoint or acknowledge an unrelated receipt.

## Render local output

Use the configured Python executable with ReportLab already installed. Always pass `-B` so imports do not write bytecode into the signed app's skill resources. Do not install dependencies during polls or model wakes.

```sh
"$PYTHON" -B "$SKILL/scripts/scribe_state.py" --root "$STATE_ROOT" render
"$PYTHON" -B "$SKILL/scripts/render_companion.py" --cards "$STATE_ROOT/output/cards.json" --output "$STATE_ROOT/output/companion.pdf"
```

Both commands acquire the output-directory lock before reading data and hold it through publication. Ledger rendering also holds a consistent SQLite transaction. A delayed PDF invocation reads the latest cards after obtaining the lock. Unchanged output preserves bytes and modification time.

Use available PDF tools to inspect layout when formatting changes. The renderer creates a local companion and performs no delivery or handwriting edits.
