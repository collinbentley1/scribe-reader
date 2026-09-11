# Scribe Reader

A local macOS reader for Kindle Scribe cloud notebooks. It uses its own Amazon sign-in window and preserves rendered page PNGs without resizing, recompression, or transcription.

The current build supports login, notebook listing, and a bounded single-page protocol probe. Multi-page sync remains disabled until the undocumented rendering protocol has been checked against live responses. Synthetic tests exercise the snapshot implementation but do not establish live compatibility.

This project is independent of Amazon and Obsidian. It does not write to cloud notebooks.

## Run the reader

Install [Bun 1.4.2](https://bun.sh/) on macOS. From this repository, run:

```sh
bun --no-env-file install --frozen-lockfile --ignore-scripts
bun --no-env-file node_modules/electron/install.js
bun --no-env-file run build
bun --no-env-file run start login
```

Complete Amazon's normal sign-in flow in the reader window. The command reports `login-confirmed` only after the notebook endpoint returns a valid list. Closing the window cancels login. Account data stays in the reader's own Chromium profile.

List your notebooks and select an ID from the JSON result:

```sh
bun --no-env-file run start list
bun --no-env-file run start probe NOTEBOOK_ID --page 1
```

`--page` is a one-based ordinal. The initial probe tests a zero-based request with equal start and end indexes. That interpretation is unverified. A probe saves a bounded raw archive, metadata key/type shape, and receipt privately. `probe-captured-unverified` means the response was saved; it does not mean the page format or ordering was validated.

The following command is implemented but returns `protocol-unverified` until the protocol check is complete:

```sh
bun --no-env-file run start sync NOTEBOOK_ID
bun --no-env-file run start sync NOTEBOOK_ID --full
```

## Local files and command outcomes

All account state, probes, and snapshots live under `~/Library/Application Support/Scribe Reader`. Directories use owner-only access and generated files use mode `0600`. Keep this directory private. The source repository contains no account data or captures.

Each notebook uses a SHA-256-derived directory name. Complete captures live in immutable `snapshots/<digest>` directories with generated `page-0001.png` filenames and a `manifest.json`. The notebook's `current` file names the published digest. Temporary files use hidden names and are not current snapshots.

| Outcome                      | Meaning                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `login-confirmed`            | This app's session returned a parsed notebook list.                                        |
| `notebooks-listed`           | The response passed the notebook-tree schema checks.                                       |
| `probe-captured-unverified`  | A bounded response is available for private inspection.                                    |
| `probe-metadata-unsupported` | Metadata did not match the expected schema; a sanitized shape is available.                |
| `metadata-match`             | Metadata and render settings match the current capture. No cloud page bytes were compared. |
| `content-compared`           | A full render produced the same canonical digest. Existing files remain unchanged.         |
| `snapshot-published`         | Every page was validated and the current pointer was replaced.                             |
| `remote-changed`             | Metadata changed around rendering. The prior snapshot remains current.                     |
| `busy`                       | Another command owns the reader profile and publication lock.                              |
| `authentication-required`    | The service returned an authentication refusal, redirect, or HTML response.                |
| `protocol-unsupported`       | A service or archive shape falls outside the supported format.                             |
| `protocol-unverified`        | Live rendering verification has not enabled sync.                                          |

Commands write JSON to standard output. Failures exit with code 1. An unsupported probe metadata receipt is an inspection result, not a successful capture. Electron may write runtime diagnostics to standard error.

## Snapshot guarantees and limits

The canonical digest includes notebook ID, title, opaque modification marker, declared page count, marketplace, render settings, protocol interpretation, and ordered page hashes. Fetch time does not affect identity. Page records include byte length, dimensions, original archive member name, and actual request bounds.

A normal sync uses a metadata fast path. `--full` always renders all pages and compares their hashes, even when metadata matches. Receipts identify changed and added ordinals and count removed pages. Ordinals describe positions within a capture; they are not permanent page IDs.

The reader compares metadata before and after rendering. A detected change rejects the capture. Equal metadata establishes a `metadata-bracketed` observation. The undocumented service does not establish server revision isolation, so undetected concurrent edits remain possible.

The reader writes and flushes a complete staging directory before publishing its current pointer with an atomic rename. Interruption before that rename preserves the prior pointer. A complete orphan can be reused after validation and a fresh successful capture. Incomplete staging directories are discarded on the next capture. The app holds its single-instance lock through publication.

Requests use only fixed HTTPS GET routes on `read.amazon.com`. API redirects are refused. The login window has sandboxing and context isolation enabled, with Node integration disabled. Top-level login navigation permits only the official Amazon reader and US login hosts. There is no cookie export, generic authenticated request command, header override, security-header rewrite, or TLS exception.

Initial limits are 2 MiB per JSON response, 10,000 tree nodes, depth 32, 1,000 pages, 64 MiB per archive, 128 archive members, 16 MiB per PNG, 20 million pixels per PNG, and 1 GiB per capture. Requests time out after 30 seconds. A sync has a 10-minute deadline. Interactive login has a 15-minute deadline.

The provisional archive parser accepts regular USTAR members containing plain, non-interlaced, 8-bit PNGs. It validates TAR checksums and framing, exact page coverage, PNG chunk CRCs, decoded dimensions, and bounded decompression. It does not extract member paths onto the filesystem. Other framing is unsupported until observed and explicitly implemented.

## Develop and verify

```sh
bun --no-env-file run check
bun --no-env-file test
bun --no-env-file run build
bun --no-env-file run start --help
```

Tests generate synthetic pages and real temporary snapshot directories. They cover malformed archives, duplicate pages, PNG corruption, changed content, metadata-only comparison, full comparison, interruption, orphan reuse, and stale staging recovery. The dedicated login window and competing-process `busy` result have also been exercised on macOS. Authenticated rendering remains unverified.

`src/account.ts` owns the Electron session and fixed requests. `src/archive.ts` validates archive and PNG bytes. `src/protocol.ts` defines the observed mapping when available. `src/snapshots.ts` owns capture comparison and publication. `src/main.ts` holds process ownership for each CLI command.

## Acknowledgment

The public request sequence was informed by [Obsidian Kindle Scribe Notes Sync](https://github.com/k4rnaj1k/obsidian-kindle-scribe-notes-sync-plugin), an MIT-licensed project. This reader is an original implementation. It does not include that project's application code or depend on the Obsidian runtime.

Released under the [MIT License](LICENSE).
