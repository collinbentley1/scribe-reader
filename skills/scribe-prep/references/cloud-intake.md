# Cloud notebook intake

Use this route only when `integration.json` has `cloud_reader.enabled: true`. The standalone source repository is public, but the Amazon profile, notebook snapshots, preparation ledger, and acquisition receipts are private local data. Read the configured paths and notebook ID from integration state.

The reader uses its own Amazon session. A successful capture means Amazon's cloud copy was read; it does not prove an offline Scribe has uploaded its latest writing. It never edits the notebook. The local machine must be awake and the signed-in session must remain valid for scheduled checks.

## Use the pinned receipt

In event mode, follow the workflow's `watch target` command. Its immutable receipt binds `capture.directory`, manifest digest and hash, ordered page content, event, and generation. Use only that manifest's declared page files. Do not run another cloud sync or substitute a newer target during review.

Use `receipt.createdAt` as the capture observation time, or record the actual later visual review time consistently with ledger timestamp rules. A reverted capture can reuse an immutable directory whose `manifest.fetchedAt` is old. Preserve authored date and `active_until`; neither fetch nor receipt time extends task scope.

For explicitly requested manual acquisition, stop the watcher and use the existing reader's `sync NOTEBOOK_ID --full`. Full success returns `snapshot-published` or `content-compared`. Ordinary `metadata-match` does not compare new cloud page bytes. `remote-changed` retains the prior capture, and `busy` means another operation owns the existing profile.

The first watcher check and one check per day perform full audits. Other five-minute checks use modification metadata. Equal-marker edits can wait until the daily audit. Captures remain metadata-bracketed because the service does not promise an atomic server revision. Authentication and unsupported protocol pause acquisition until explicit recovery. Local expiry rendering continues without a model.

## Review relevant changes

Compare the new manifest with the last **reviewed** manifest in the checkpoint, not merely the previous capture or `changedOrdinals` in the latest command output. A prior run may have captured bytes and stopped before reviewing them. An unchanged subsequent command must not erase those pending changes.

Also inspect every current ledger page for this notebook, including pages first accepted after the checkpoint, and reconcile its source hash and mapping against the target manifest. Do this even when the target manifest equals the checkpoint. For example, a partially reviewed page may change from A to B and then revert to A before the checkpoint advances; the ledger must be reviewed back from B to A. Keep per-page pending or accepted dispositions in the acquisition receipt while a changed capture is being reviewed. The checkpoint and current ledger together determine remaining work.

The initial baseline can contain historical pages. Preserve its configured selected-page mappings, whether zero, one, or several pages are admitted to preparation. Do not copy the entire notebook into the inbox or turn unchanged historical pages into active work. On later captures, examine new or changed pages and the existing selected-page mappings. An exact image hash can identify a moved page only when the match is unambiguous and one-to-one across the old and new captures. Duplicate pages require visual and surrounding context; never merge task identities or silently attach a selected page to a historical duplicate. If identity remains uncertain, hold its visibility as unknown/reference. Ordinals are location hints, and `img_0.png` is an archive-local filename. Neither is a durable page ID. Amazon's observed `noteId` was identical across different pages and must not be used as a page identity.

Inspect changed originals visually, then use `scribe_state.py inspect` to preserve task IDs, handwritten completion, access authorization, dependencies, preparation receipts, and drafts. Use `kind: amazon_cloud_snapshot` with the actual PNG path and hash. Preserve an unknown authored date and the existing `active_until` when the same task list is merely re-observed. A cloud fetch time does not make old tasks current. Admit a new page only when its written date or the user's current context establishes that scope.

If a selected page disappears and cannot be matched elsewhere, retire its current visibility without marking tasks done: submit a newer `coverage: partial` review with no tasks, using its retained original PNG as `purpose: reference`, and record the new manifest as disappearance evidence in the private acquisition receipt. Retain the previous authored date and expiry. This records loss of current coverage without inventing a replacement page. If acquisition itself failed, no disappearance has been established.

Save reviewed observations before preparing work. Advance the checkpoint only after every changed page needing review has an accepted observation or an explicit reference-only disposition. Record the committed manifest directory/digest, reviewed page mappings, and receipt paths. If interrupted, leave it pending; replaying an accepted review is safe. Do not advance the checkpoint just because the reader published a capture.

## Checkpoint and acknowledgement

The checkpoint is agent-owned JSON at `cloud_reader.review_checkpoint`. Preserve useful existing fields and selected-page mappings. Required completion fields are `schema_version: 1`, configured `notebook_id`, `reviewed_snapshot` containing `digest`, `directory`, and `manifest_sha256`, timezone-aware `completed_at`, `selected_pages`, and an empty `pending_page_dispositions` list. Selected pages retain stable ledger notebook/page IDs, current source hashes, ordinal hints, and observation references. An empty selected list is valid only when no pages are admitted.

The acknowledgement helper validates the checkpoint's schema, snapshot, and absence of pending dispositions. The agent remains responsible for the truth and completeness of the review. A completed checkpoint alone is not an acknowledgement. Run `watch acknowledge` with the pinned receipt after review. The helper completes both renderers and publishes the receipt-bound acknowledgement. If it fails, resume the existing checkpoint and ledger, then retry it without repeating completed preparation.

## Prepare and finish

Run `due` for each notebook-change wake and use the shipped renderers for local output. Reuse valid preparation and existing drafts; preserve denied-access blocks. Keep drafts unsent and output as a local companion. Refresh the PDF only when cards change. An unchanged successful check should create no new research, drafts, receipt files, or rewritten output.

Keep the email route available for an explicitly shared export. It is a separate source receipt, not proof of cloud acquisition. Record actual unattended cloud acquisition separately from supervised setup verification. Service registration alone does not establish a successful scheduled run.
