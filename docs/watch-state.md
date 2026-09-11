# Watcher state and delivery

The producer owns `<watch_root>/state.json` and immutable `receipts/` files. Agent helpers own immutable `acks/` files and checkpoint copies. Each writer uses a separate SQLite exclusive transaction as a lifetime lock. These small lock databases contain no preparation data and remain separate from the ledger. SQLite releases the lock after a crash.

A capture's content identity hashes a versioned encoding of notebook ID and ordered page hashes. The manifest digest and manifest file hash record exact provenance. Metadata can change provenance without changing content. Page reorder changes content but does not assign new task IDs.

| Delivery phase | Meaning                                                         | Next step                                                             |
| -------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `settled`      | No event is outstanding.                                        | Different reviewed content creates a durable receipt and ready event. |
| `ready`        | The event exists and no producer may have run for this attempt. | Persist `attempting` before invoking the queue producer.              |
| `attempting`   | The producer may have run and no outcome was persisted.         | A validated response becomes queued. Restart becomes uncertain.       |
| `queued`       | The expected thread accepted a submission ID.                   | Wait for receipt-bound acknowledgement.                               |
| `uncertain`    | The attempt's external outcome is unknown.                      | Wait for acknowledgement or an explicit operator retry.               |

Only one event is outstanding. Further captures advance its latest immutable receipt generation without sending another message. Once B creates an event, returning to reviewed A keeps the event. The task must reconcile any partial B ledger observations before acknowledging A.

The producer publishes each receipt before advancing the state pointer. If it crashes between those writes, restart validates and adopts the next receipt for the outstanding event, preserving its original bytes and delivery phase. This happens before consuming an older acknowledgement, so the recovered capture remains eligible for follow-up.

`target` returns one immutable receipt. Preparation keeps that receipt even if a newer generation appears. Acknowledgement binds its event, generation, receipt hash, and completed checkpoint. It cannot substitute a newer capture at completion. The producer advances its reviewed baseline to the acknowledged snapshot and compares the latest content against it. A difference creates one follow-up event.

The agent completes the existing reviewed checkpoint after page dispositions are complete. The acknowledgement helper validates it, stores an immutable copy, runs both renderers, and publishes acknowledgement. A render failure leaves no acknowledgement. Retrying can use the saved completed checkpoint. The existing ledger's idempotent observations/results and draft receipts handle partial preparation. No claim table or model timer is added.

`delivery-test` is an explicitly requested event with no notebook input. It uses the same outbox, queue attempt, target, and acknowledgement path. Acknowledging it never advances the notebook's reviewed baseline. Notebook changes captured while the test is outstanding wait for a follow-up event.

Queue acceptance and local state writes cannot form one transaction. The producer has no deduplication API, and upstream dispatch can replay a message. The watcher therefore makes ambiguous outcomes visible instead of promising exactly-once delivery. A replayed acknowledged event returns `no-work`. Partial preparation resumes from its actual ledger and checkpoint.

Both Python renderers take the same output-directory flock before reading input and hold it through atomic publication. Ledger rendering also opens a consistent SQLite transaction. The PDF renderer reads the latest cards after acquiring the lock. The supervisor can retire expired cards while a notification is queued or uncertain, and these local output changes never trigger a model.

The Codex command is `queue --thread UUID --message TEXT`. Installation checks that the configured executable exposes those options. Its fixed notification includes the private integration path and preparation policy. Notebook content remains external evidence and does not enter user-authority notification text. The producer never uses `exec resume`, private desktop endpoints, or Codex database edits.
