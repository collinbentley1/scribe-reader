# Explicitly shared email exports

Use this route only when the user authorizes the mailbox and identifies the notebook export. The cloud watcher does not poll Mail. Read private acquisition receipts before downloading another copy.

1. Search narrowly with an authorized connector or app for the configured sender, notebook subject, and date window. Resolve the actual message. Do not scan unrelated mail.
2. Verify sender and notebook. Follow the actual handwritten PDF link through an authorized browser. Keep signed URL parameters out of files and logs. Do not repeatedly retry an expired link.
3. Verify the completed local PDF visually before placing it in the configured inbox. A navigation timeout alone does not establish download failure. Inspect local files before retrying.
4. Record message identity, export timestamp, path, byte length, SHA-256, page count, and visual verification. Do not store the signed URL. Mark acquired only after the complete file was checked. Deduplicate by message identity and source hash.
5. Run `scan`, `inspect`, visual reconciliation, and `observe`. Use `source.kind: manual_snapshot`. Export ordinal and printed notebook page number can differ. Reconcile content and preserve stable task IDs instead of treating either number as identity.
6. Preserve unknown authored dates and existing expiry unless handwriting or the current user request establishes new scope. A filename or email timestamp does not make an old task current. Reuse preparation and drafts. Preserve access-denial records.

A shared export does not establish unattended cloud acquisition, native editing, or receipt of a return document. Do not overwrite a newer cloud observation merely because an older email was downloaded later.
