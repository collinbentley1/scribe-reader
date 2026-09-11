# Scribe Reader

A local macOS reader for Kindle Scribe cloud notebooks. It uses its own Amazon sign-in window and preserves rendered page PNGs without resizing, recompression, or transcription.

The reader supports login, notebook listing, a bounded single-page probe, and notebook sync. It also includes a resident notebook-change watcher and a portable preparation skill. The watcher polls without a model and queues an existing Codex task only when notebook content changes. See [watcher setup](docs/watch.md).

The capture protocol has been verified against a live notebook. The native WebKit replacement has a separate synthetic HTTPS acceptance suite; a fresh native login and live capture remain release acceptance steps.

This project is independent of Amazon and Obsidian. It does not write to cloud notebooks.

## Run the reader

Build and sign the [macOS product](#package-for-macos), install it in `~/Applications`, and prepare the private [watcher configuration](docs/watch.md). For an existing installation, complete the [replacement sequence](#replace-an-existing-installation) first. The installed app contains a compiled Bun watcher and one Swift/AppKit/WebKit capture helper. Python and Codex remain configured external dependencies.

```sh
SCRIBE="$HOME/Applications/Scribe Reader.app/Contents/MacOS/Scribe Reader"
CONFIG="/absolute/private/integration.json"
"$SCRIBE" reader --config "$CONFIG" -- login
```

Run reader commands while the watcher is stopped. Complete Amazon's normal sign-in flow in the reader window. The command reports `login-confirmed` only after the notebook endpoint returns a valid list. Closing the window cancels login. WebKit owns a dedicated persistent data store with a stable product UUID. Fresh sign-in is required when replacing the previous reader. The app does not read or migrate the previous browser profile.

List your notebooks and select an ID from the JSON result:

```sh
"$SCRIBE" reader --config "$CONFIG" -- list
"$SCRIBE" reader --config "$CONFIG" -- probe NOTEBOOK_ID --page 1
```

`--page` is a one-based ordinal. Requests use a zero-based position with equal start and end indexes. The probe command saves a bounded raw archive, metadata key/type shape, and receipt privately for inspection. It does not run the archive validator. Its `probe-captured-unverified` result means only that the response was saved. The sync command validates each archive before publication.

Capture a notebook, or force a fresh page-content comparison:

```sh
"$SCRIBE" reader --config "$CONFIG" -- sync NOTEBOOK_ID
"$SCRIBE" reader --config "$CONFIG" -- sync NOTEBOOK_ID --full
```

## Local files and command outcomes

Probes, snapshots, and reader ownership files live under `~/Library/Application Support/Scribe Reader`. WebKit manages account persistence in its dedicated product data store. Directories use owner-only access and generated files use mode `0600`. Keep this directory private. The source repository contains no account data or captures.

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
| `authentication-required`    | The service returned an authentication refusal or HTML response.                           |
| `protocol-unsupported`       | A service or archive shape falls outside the supported format.                             |

Commands write JSON to standard output. Failures exit with code 1. An unsupported probe metadata receipt is an inspection result, not a successful capture. The native helper uses a private framed pipe; its diagnostics are not forwarded as command results.

## Snapshot guarantees and limits

The canonical digest includes notebook ID, title, opaque modification marker, declared page count, marketplace, render settings, protocol interpretation, and ordered page hashes. Fetch time does not affect identity. Page records include byte length, dimensions, original archive member name, and actual request bounds.

A normal sync uses a metadata fast path. `--full` always renders all pages and compares their hashes, even when metadata matches. Receipts identify changed and added ordinals and count removed pages. Ordinals describe positions within a capture; they are not permanent page IDs.

The reader compares metadata before and after rendering. A detected change rejects the capture. Equal metadata establishes a `metadata-bracketed` observation. The undocumented service does not establish server revision isolation, so undetected concurrent edits remain possible.

The reader writes and flushes a complete staging directory before publishing its current pointer with an atomic rename. Interruption before that rename preserves the prior pointer. A complete orphan can be reused after validation and a fresh successful capture. Incomplete staging directories are discarded on the next capture. Bun holds an OS-released SQLite ownership transaction through publication. The native helper separately holds an exclusive lock for the fixed WebKit store.

Requests use only fixed HTTPS GET routes on `read.amazon.com`. API redirects are refused. The native login window uses system WebKit. Fixed capture JavaScript runs in an isolated content world. Top-level login navigation permits only the official Amazon reader and US login hosts. There is no cookie export, generic authenticated request command, header override, security-header rewrite, or TLS exception.

Initial limits are 2 MiB per JSON response, 10,000 tree nodes, depth 32, 1,000 pages, 64 MiB per archive, 128 archive headers, including PAX headers, 16 MiB per PNG, 20 million pixels per PNG, and 1 GiB per capture. Requests time out after 30 seconds. A sync has a 10-minute deadline. Interactive login has a 15-minute deadline.

The archive parser accepts USTAR files with bounded timestamp-only PAX headers. PAX records may contain only `atime`, `ctime`, `mtime`, and `LIBARCHIVE.creationtime`; they cannot override paths, sizes, or links. The parser validates record lengths, TAR checksums, padding, and end markers. It does not extract member paths onto the filesystem.

Each supported response contains ten regular files, in any order. The reader binds `manifest.json` to the requested notebook ID and requires a complete fixed-format notebook. It checks the requested global position in `page_data_N_N.json`, one local page, and one full-image reference to `img_0.png`. That image name is local to each response and does not identify a permanent page. Auxiliary notebook metadata is not used to assign page identity.

The raw PNG is the exported page. Observed source images are 1860 by 2480, while the requested canvas is 620 by 877. The reader obtains source dimensions from the PNG and validates a full-image rectangle with uniform scaling centered in the canvas. Letterboxing is supported. Cropping, rotation, unequal scaling, and additional page or image coverage are rejected. PNG validation checks chunk CRCs, non-interlaced 8-bit decoding, and bounded decompression. Source bytes are preserved without applying the viewing transform.

## Develop and verify

Install Bun 1.4.2, the pinned dependencies, and an Xcode toolchain supporting Swift 6 and macOS 14 or newer. Reader and watcher commands use the compiled app.

```sh
bun --no-env-file install --frozen-lockfile
bun --no-env-file run check
bun --no-env-file test
bun --no-env-file run test:native
bun --no-env-file run build --out /absolute/empty/package-output
"$PYTHON" -B -m unittest discover -s skills/scribe-prep/tests -v
```

Tests generate synthetic page archives with fake PAX timestamps and real temporary snapshot directories. They cover notebook and position mismatches, unsupported geometry, PAX overrides, malformed archives, duplicate pages, PNG corruption, changed content, metadata-only comparison, full comparison, interruption, orphan reuse, and stale staging recovery.

The previous transport's live verification covered notebook listing, individual page archives, a complete 83-page capture, both repeat-sync modes, changed-during-capture rejection, and competing-owner refusal. Those observations ground the retained protocol and snapshot validators; they do not establish native-session acceptance.

The native suite compiles and signs a separate fixture-only helper, runs a local HTTPS server, validates 83 synthetic pages, and checks cookies, headers, redirects, size limits, framing, cancellation, and session ownership. The fixture build has a separate store UUID and lock, and its pinned localhost certificate is never installed as a trust root. Production endpoint and TLS policy remain fixed. See [native transport](docs/native-transport.md).

`native/main.swift` owns WebKit, login, the store lock, and the private transport boundary. `native/bridge.js` performs the three fixed requests. `src/account.ts` validates framed native responses. `src/reader.ts` owns command orchestration and publication ownership. `src/archive.ts`, `src/protocol.ts`, and `src/snapshots.ts` retain archive, PNG, page coverage, and snapshot validation.

`src/watch.ts` owns the supervisor, immutable receipts, queue attempts, and acknowledgement reconciliation. `src/watch-service.ts` manages the user LaunchAgent. The bundled [preparation skill](skills/scribe-prep/SKILL.md) includes its SQLite ledger, output renderers, policy, and synthetic tests. Its Python state directory is explicit, and its PDF dependency is pinned to ReportLab 4.4.9.

## Package for macOS

Build on Apple Silicon macOS with Bun 1.4.2 and Swift 6. `scripts/macos.ts` compiles the outer Bun executable and one Swift helper targeting macOS 14, then copies an allowlist of resources. The bundle contains exactly two Mach-O executables and uses system WebKit. Choose an empty output directory outside the installed app.

```sh
bun run macos build --out /absolute/package-output
APP="/absolute/package-output/Scribe Reader.app"
bun run macos sign --app "$APP" --mode adhoc
bun run macos verify --app "$APP" --mode adhoc
"$APP/Contents/MacOS/Scribe Reader" --help
"$APP/Contents/Helpers/Scribe Reader Capture.app/Contents/MacOS/Scribe Reader Capture" --help
```

The outer app is `com.cdbentley.scribe-reader`, with a `Scribe Reader` Mach-O and `LSBackgroundOnly=true`. Its nested `Scribe Reader Capture.app` is `com.cdbentley.scribe-reader.capture`. The skill lives at `Contents/Resources/skills/scribe-prep` as real files. Python calls use `-B`, and packaging excludes bytecode caches. No private configuration, profile, ledger, snapshot, receipt, or output belongs in the bundle. Bun's upstream [versioned license notice](https://github.com/oven-sh/bun/blob/bun-v1.4.2/LICENSE.md), and pngjs's MIT license are retained.

The build receipt records input hashes, embedded Bun hash, Swift/SDK versions, output hashes, and source revision. `sourceDirty` and `sourceDigest` distinguish a dirty development build from its base commit. Sign and verify receipts bind their own output manifests. Each release should be rebuilt from the reviewed clean commit before final signing.

Ad hoc verification checks the two executables and their bundles, stable identities, exact entitlements, hardened runtime, and resource signatures. The native helper has empty effective entitlements in both signing modes. Only the compiled Bun executable receives Bun's documented runtime entitlements. Developer ID runtime acceptance still requires its own real run.

After the separate authorized certificate step, use the actual Developer ID identity and Team returned by the keychain:

```sh
bun run macos sign --app "$APP" --mode developer-id --identity "$SIGNING_IDENTITY" --team "$TEAM_ID"
bun run macos verify --app "$APP" --mode developer-id --team "$TEAM_ID"
```

The identity name or hash and Team are public certificate metadata. Never pass credentials or private keys. Signing proceeds from the native helper to the outer app. Developer ID requires hardened runtime, secure timestamps, and matching Team identity on every native object. Verify Gatekeeper separately. Off-Mac distribution additionally requires accepted notarization, stapling, and a validated ticket. The packaging tool does not enroll accounts, install apps, register services, or submit notarization requests.

The compiled watcher disables dotenv, bunfig, package.json, and tsconfig autoload. Its LaunchAgent explicitly neutralizes `BUN_OPTIONS` and `BUN_BE_BUN`. For a direct CLI launched from a customized shell, unset those variables before invoking it; Bun processes them before application code runs.

## Replace an existing installation

Keep the current executable, source checkout, original integration bytes, exact plist bytes, and installed skill-link target until the new product passes live verification. If configured Python lives in the old checkout's `.venv`, that checkout remains an external runtime dependency. Do not remove it.

Inspect both `~/Library/LaunchAgents/com.scribe-reader.watch.plist` and `launchctl print gui/UID/com.scribe-reader.watch` before changing anything.

| Plist                           | Scoped launchd job         | Next step                                                    |
| ------------------------------- | -------------------------- | ------------------------------------------------------------ |
| Exact current/predecessor bytes | Loaded or confirmed absent | Let the current version remove its own registration.         |
| Absent                          | Confirmed absent, exit 113 | Proceed after confirming no supervisor owner.                |
| Absent                          | Loaded or unknown          | Stop migration; a missing file does not establish ownership. |
| Different bytes                 | Any state                  | Refuse replacement and inspect the unrelated registration.   |

1. Let any active reader or preparation operation finish. Record the existing profile, notebook/task IDs, state root, watcher root, checkpoint, receipt hashes, and skill target. Keep private backups outside source and app.
2. Use the old reviewed CLI and the original integration at its original path to remove the service **before** editing the config or skill link. For the source-based predecessor, run `"$OLD_BUN" --no-env-file "$OLD_SOURCE/dist/watch.js" remove --config "$CONFIG"`. A backup config at another path does not match the old plist. If that older CLI reports its known immediate-unload false negative, separately confirm exit 113 and old process termination, then retry the same remove command. Never bypass a mismatched plist or unverifiable owner.
3. Verify the new signed app, stage it beside `~/Applications/Scribe Reader.app`, then rename it into that stable location while stopped. Refuse an unrelated destination app; retain the previous product for rollback. Replace the whole app, including its nested reader.
4. At the same private integration path, atomically publish schema 2 with `app_bundle` and remove only `cloud_reader.source_directory` and `watcher.bun_executable`. Preserve every other private field and data path. Compare the installed skill symlink to the captured exact predecessor target, then atomically replace that link with the app's Resources skill directory. Refuse a different link or a real directory; ordinary installation remains strict.
5. While the old reader and supervisor are stopped, complete a fresh native login and a validated native capture. Preserve the existing snapshot root, ledger, receipts, and checkpoint. Do not activate the service until these acceptance checks pass.
6. Register the installed app with `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"`, where `APP` now names its final installed path. Run `"$SCRIBE" install --config "$CONFIG"`, then verify status, launchd's actual executable, signatures, and the macOS Settings label separately.

Keep a private receipt of completed migration steps. Preserve queued and uncertain events; do not reset state or retry delivery as part of packaging. Verify the new persistent session through normal reader behavior and a helper restart. Compare unchanged capture/output behavior and private data after activation.

For later product updates, stop the installed version before replacing its bundle. Stable app/config paths keep the plist and skill link unchanged unless registration policy changes. If policy changes, remove through the current version first. A matching stop waits for confirmed unload with a 30-second bound; unknown state or a replaced process owner still fails.

Rollback first stops/removes the exact new registration and confirms its owner has exited. Restore the previous code at its original address, original config bytes at the original path, and captured skill link, then use that version's install/start commands. Restore code and configuration only. Never rewind the ledger, snapshots, receipts, checkpoint, or watcher state. Keep the source predecessor intact through the first product activation so this rollback remains possible.

Native cloud notebook writeback remains unimplemented and unverified. Historical users reported replacing an editable native notebook over USB and subsequent synchronization. That is a concrete research lead rather than proof of a cloud write API. See the [firsthand report](https://www.mobileread.com/forums/showpost.php?p=4391735&postcount=635) and [capability notes](skills/scribe-prep/references/scribe-access.md). Preparation output remains a separate local companion.

## Acknowledgment

The public request sequence was informed by [Obsidian Kindle Scribe Notes Sync](https://github.com/k4rnaj1k/obsidian-kindle-scribe-notes-sync-plugin), an MIT-licensed project. This reader is an original implementation. It does not include that project's application code or depend on the Obsidian runtime.

Released under the [MIT License](LICENSE).
