# Native WebKit HTTPS fixture

`server.ts` exports `startFixture()`. It binds only
`https://localhost:18443` and returns a control object with:

- `setScenario(...)`, which requires no active requests and resets observations;
- `snapshot()`, including per-endpoint counts, cookie and rendering-token
  observations, active requests, maximum concurrent requests, and cancelled
  bodies;
- `stop()`, which force-closes the local server;
- the certificate path, private-key path, and SHA-256 digest of the certificate's
  DER bytes.

The scenarios are `normal`, `same-origin-redirect`,
`cross-origin-redirect`, `json-2mib-exact`, `json-2mib-over`,
`render-64mib-exact`, `render-64mib-over`, and `slow-cancellation`.

Loading `/` sets the synthetic fixture cookie with `Path=/`, `Max-Age=3600`,
`HttpOnly`, `Secure`, and `SameSite=Lax`. The explicit lifetime lets the native
restart test distinguish persistent WebKit storage from a process session.

The checked-in certificate and private key are synthetic test fixtures. Native
test code may accept the certificate only when its fixture compile flag is set.
Never trust or install either file in a keychain, and never use them outside this
localhost fixture.
