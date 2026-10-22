# Issue #1 regression tests

## Run

```sh
npm ci
npm test
```

The default suite runs the actual Bundle entry point and the Dynamic function body in a Node VM without `process`, `require`, or imports. Its session services use deterministic synthetic logs. Snapshot isolation tests also use real temporary directories and file I/O. Harness HTTP and native-storage integration tests are skipped unless `DSH_SOURCE` is set.

For real Harness HTTP and native-storage integration, use Node 24 and this pinned upstream checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git /tmp/deepseek-harness
git -C /tmp/deepseek-harness checkout 687f282e8625c6b8d11ff58211a90524be2e4317
DSH_SOURCE=/tmp/deepseek-harness npm test
```

`npm run test:integration` runs the HTTP and native-storage suites. The source loader resolves Harness workspace packages and strips TypeScript; it does not replace authentication or routing. HTTP tests run real Cordis, WebServer, Connection and BrowserAuth code over real localhost HTTP sockets. Session services and the credentials record backend are test doubles. Native-storage tests run real Storage and JSON-backend code against temporary directories, including reopening a snapshot through a new backend instance. No provider credentials or live user data are needed. Node's TypeScript transform emits an experimental-feature warning.

GitHub Actions is configured to run the ordinary suite on Node 20 and 24, plus the integration suites on Node 24 against the pinned Harness revision. Changing that revision requires rechecking the contracts below.

## Coverage

- Both forms: `150 → 150 → 150`, all aggregates reset together, concurrent rescan callers wait for completion, deleted-session behavior, malformed snapshots, sequence zero, live-event/replay ordering, new seeded sessions, failure/retry and startup/finalizer races.
- Native persistence, both forms: works without `fs`, restores saved history through a new backend with source logs absent, isolates two configured storage roots, serializes writes, flushes and releases the unit when the plugin is disposed before its provider, migrates a readable legacy snapshot only when the native unit is empty, and never redirects a failed native write into the workspace filesystem.
- Legacy persistence fallback: separate homes do not read or overwrite each other's snapshots, launcher-home precedence, per-instance `DSH_HOME` resolution, tilde/relative/blank overrides for Bundle, explicit absolute configuration or memory-only fallback for Dynamic. In normal Cordis activation, the native storage services are required; the fallback applies to directly embedded hosts without them.
- Bundle HTTP: anonymous, forged/tampered-cookie and launch-token-query requests receive 401; hostile Host/Origin receive 403, including with a valid cookie. Rejections cannot read session logs or trigger scans. Only GET stats and POST rescan are dispatched; other methods return Harness's 404 without side effects. Authenticated repeated rescans stay at 150, responses have `no-store`, and disposal removes both routes.
- Current Harness compatibility: without the legacy `sessionPersistence.readFrom`, startup reads through `sessionQuery.readSession` and folds only events after the saved watermark. This fallback reads the full log; it does not promise storage-level suffix seeking.

## Verified contracts

All source links pin Harness revision `687f282e8625c6b8d11ff58211a90524be2e4317`:

- [Connection HTTP admission](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/index.ts#L150): Host/Origin and browser-session checks precede dispatch through `/api`.
- [Fetch registration and dispatch](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/rpc-host.ts): paths must include `/api/`; the route's methods restrict dispatch. `/token-stats` alone is invalid. Routes are owned by the plugin fiber and restricted to the owner peer.
- [Dynamic client RPC](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/extensions/cordis-client-runner/src/client/index.ts#L211) and [Host runner](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/extensions/cordis-host-runner/src/index.ts#L759): `harness.handle` calls travel through Gateway/Connection's authenticated `/api` RPC channel. Dynamic does not install an extra raw HTTP route.
- [Launcher profile context](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/profile-boot.ts#L314) and [home resolution](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/util/home-paths/src/index.ts): `profileContext.home` is the resolved Harness home. The Dynamic VM lacks `process`, so it uses this context instead of reading environment variables.

## Local result and limits

On macOS arm64, Node 24.21.0, the complete suite passed **68 tests**, with **0 failures and 0 skipped**, using the pinned Harness source: 58 aggregation, path and native-storage tests, four HTTP integration tests and six real JSON-backend integration tests. Node 20.20.2 separately passed all **58 ordinary tests**. `git diff --check`, package creation, and `npm audit` also passed (zero reported vulnerabilities).

The Bundle was also installed and exercised in DSH Desktop **0.2.1-rc.2**, build `332895e0f7c9d4dbfb29729f5eb367fa263ff986`, on macOS arm64. This installed build is distinct from the pinned source revision above. The Statistics settings page rendered successfully. API aggregates matched an independent read-only audit of actual multi-frame `session.v4.jsonl.zstd` logs. Three sequential and three concurrent authenticated rescans left the aggregates unchanged. Anonymous statistics and rescan requests returned 401; hostile Origin requests returned 403. Authenticated GET/HEAD/PUT/PATCH/DELETE/OPTIONS requests to the rescan URL returned 404. The host wrote `storages/token_stats.json`, and a desktop restart preserved the same statistics. Temporary renderer debugging was disabled after verification.

The tooltip follow-up was installed on the same desktop build. Real renderer mouse events checked 384 daily/weekly hover cases across viewport widths of 1280, 960, 800 and 600 CSS pixels (heatmap widths down to 308 pixels), including both edges, the formerly clipped near-right columns, and top/middle/bottom rows. All tooltip rectangles stayed inside the heatmap, with no added horizontal overflow. Eight additional checks temporarily substituted a long English weekly label and verified two-line wrapping at the top/bottom and left/center/right edges; the original text and viewport were restored afterward. The Bundle result was also inspected visually. Both client implementations use the same positioning logic; the Dynamic UI was not separately deployed for this check.

Not exercised end to end: `cordis_define`/Runner/Gateway deployment of the Dynamic plugin, SQLite session storage, remote filesystem providers, Linux or Windows. Dynamic aggregation and native persistence are tested in a VM; its complete network authentication chain was inspected in source rather than deployed. Storage-root isolation was tested with real JSON backends in temporary directories, not by changing the user's active desktop home. The results above describe local verification; remote workflow outcomes are reported by GitHub Actions.

Bundle and Dynamic are alternative installations. They share the same native unit name; enabling both simultaneously is unsupported because the JSON backend allows only one open handle for a unit.

The 10-second periodic snapshot flush and plugin-before-provider disposal are covered. During whole-host shutdown, a storage provider may close before the plugin's final flush; that last flush is best effort. Events since the last successful snapshot are recovered from retained session logs on the next startup. An abrupt shutdown combined with deletion of those unsaved source logs is not covered by a durability guarantee.

Existing version-1 snapshots remain readable. If a previously affected installation already saved inflated totals, an authenticated POST rescan rebuilds from the logs that still exist; deleted logs cannot be reconstructed. Ordinary startup deliberately retains saved history rather than discarding deleted-session statistics.
