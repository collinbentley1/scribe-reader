# Native capture transport

The installed product contains one compiled Bun executable and one Swift/AppKit/WebKit helper. Bun runs reader commands and watcher captures through the same module. One helper owns the whole operation: login or the initial metadata request, every sequential page render, and the final metadata bracket. Archive, PNG, notebook, and snapshot validation remain in Bun.

The helper owns persistent `WKWebsiteDataStore` UUID `D91D21E0-FE72-47D2-83BC-7C96D12576C8`. Keep that UUID stable across releases. It holds `native-session.lock` under the existing private storage root using `flock`; the lock applies across configurations. Bun also holds `reader-ownership.sqlite3` through command completion and snapshot publication. Both ownership mechanisms release on process exit. No previous browser profile or cookie is read.

Login uses a visible native window. Capture uses a hidden WebKit view. Login navigation permits HTTPS on `read.amazon.com`, `www.amazon.com`, and `amazon.com`, without credentials or alternate ports. Bun accepts login only when the existing notebook-list parser succeeds. Closing the window cancels login.

The helper exposes help, version, and a private pipe mode. Help, version, and invalid arguments exit before account storage or locks are opened. Pipe requests are typed; there is no URL, script, header-map, cookie-export, or production-endpoint override command.

`native/bridge.js` runs in a named isolated content world. It builds only the existing notes, notebook-open, and page-render HTTPS GET routes. Requests use same-origin credentials and reject every redirect. WebKit supplies cookies. The rendering token crosses only the private Bun/helper pipe and the fixed render header. It is never placed in command arguments, diagnostics, receipts, or public output.

Every pipe control starts with a four-byte unsigned big-endian length and at most 65,536 bytes of UTF-8 JSON. Requests carry protocol version 1 and an increasing positive integer ID. A successful response carries the same ID and the complete body length, followed by exactly that many binary bytes. Errors carry only a recognized error kind. Boolean values cannot substitute for numeric fields. One request is outstanding at a time.

JavaScript reads response chunks, subdivides them into at most 32 KiB raw slices, and posts base64 through `WKScriptMessageHandlerWithReply`. It awaits each acknowledgement before posting another slice. Swift verifies the main frame, normalized HTTPS origin, request ID, sequence, base64, and size before appending the bytes. Swift accumulates at most 2 MiB for JSON or 64 MiB for a page archive, then writes a known-length body off the UI thread. Bun independently enforces the same endpoint bounds before parsing. The bridge does not create temporary archive files.

Request deadlines, whole-operation deadlines, cancellation, stdin EOF, and termination all close native ownership. Bun escalates an unresponsive owned child to termination and then kill. A partial response cannot become a published snapshot. WebKit reports fetch redirects and network failures through the same bounded `network-error` result; neither follows the redirect.

Run `bun run test:native` on macOS to compile a separate fixture helper and exercise the actual bridge against a local HTTPS server. `--out /absolute/directory` retains its app and receipt at a chosen location. Fixture compilation alone includes the fixed localhost origin and certificate pin; the shipping build has neither. The fixture uses UUID `91B37029-632B-46F0-80A9-7B95D61AE04B`, a separate bundle ID, and a temporary-directory lock. Its synthetic certificate is never added to system trust.

The native executable is signed with hardened runtime and empty effective entitlements. The compiled Bun executable alone receives the documented Bun runtime entitlements. The package keeps skill files as real resources and invokes external Python with `-B`; runtime checks must leave signed resources unchanged.
