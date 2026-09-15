# Close codes

## Close codes: where this beats the documentation

The protocol field guide catalogues ten close codes and states that five of them (4100, 4200, 4310, 4500, 4700) are "not otherwise documented by any of the three projects", recommending they be treated as reconnect-worthy by default. **That advice is wrong, and this package does not follow it.**

The game's own client bundle (`version/<v>/assets/store-*.js`) contains the authoritative enum: **eighteen codes, all named.** Reading it changes real behaviour:

| Code | Name | What it means for a client |
|---|---|---|
| 4100 | `ReconnectInitiated` | The server is asking you to reconnect |
| 4200 | `PlayerLeftVoluntarily` | **Terminal**: reconnect is pointless |
| 4250 | `UserSessionSuperseded` | **`reconnect-confirm`**: a person must confirm; then slower, with `reclaimSupersededSession=true` |
| 4300 | `ConnectionSuperseded` | As 4250, unless the reason mentions "heartbeat". That is our own reconnect and reconnects normally |
| 4310 | `ServerDisposed` | Server going away; reconnect |
| 4320 | `RoomTransitioning` | Room changing; reconnect |
| 4400 | `HeartbeatExpired` | ~30s of unanswered pings; reconnect |
| 4500 | `PlayerKicked` | **Terminal**: reconnecting just gets you kicked again |
| 4700 | `VersionMismatch` | Re-fetch the version; a second version code the docs miss |
| 4710 | `VersionExpired` | Re-fetch the version |
| 4720 | `UserDataSchemaAhead` | **Terminal**: a reconnect cannot help |
| 4721 | `UnreadableUserData` | **Terminal**: a reconnect cannot help |
| 4800 | `AuthenticationFailure` | Bounded retries only |
| 4801 | `UnexpectedHandshakeError` | Bounded retries only |
| 4810 | `UserNotFound` | Bounded retries only |
| 4830 | `AuthenticatingExternalAccountRemoved` | **Terminal** |
| 4840 | `SessionExpired` | A new *session*, not merely a new socket |
| 4900 | `Banned` | **Terminal**: this is the one that would have had a banned client reconnecting forever |

The three terminal codes the guide recommended reconnecting on (4200, 4500, 4900) are the clearest case: a kicked or banned client following the documented advice would sit in a reconnect loop indefinitely. `analyzeClose` now returns `shouldReconnect: false` and `isTerminal: true` for all of them, and the guide's names are kept as deprecated aliases so existing callers keep compiling.

