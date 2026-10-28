# TheCalm Skip

A personal Brave extension that uses [IntroDB](https://introdb.app) community timestamps to skip recaps and intros on **thecalm.site**, and move to the next episode at the credits. It runs in your browser and needs no Netflix account, API key, or backend server.

For development updates without manually replacing ZIPs, see [Windows development setup](docs/DEVELOPMENT_WINDOWS.md). It syncs a local checkout of the `development` branch into the existing Brave installation, with backups. The browser still needs a **Reload** click after extension files change. Registration and later store publishing are covered in [Chrome Web Store setup](docs/CHROME_WEB_STORE.md); a store account is not needed for unpacked development.

## Install in Brave

1. Download and extract `dist/thecalm-skip.zip`, or use this checkout's `extension` directory directly.
2. Open `brave://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Select the extracted directory containing `manifest.json`. In this checkout, select `extension`.
4. Reload your TheCalm episode, start playback, and open **TheCalm Skip** from the browser's extensions menu.
5. Automatic skipping is already on. Supported intros and recaps skip during playback, followed by a brief **Skipped intro** or **Skipped recap** toast.

The confirmation toast disappears after three seconds. Its **Undo** button restores your previous position; **Undo last skip** in the extension popup remains available after the toast disappears. To use manual skip buttons instead, turn off **Automatic skipping**. That preference is saved for future episodes.

### Updating an installed version

Replace the contents of your installed extension folder with the current extension files, click **Reload** for TheCalm Skip in `brave://extensions`, then reload the TheCalm episode. The popup footer should show **TheCalm Skip v0.1.3** and the header should show **Auto enabled**. The old 0.1.0 review-mode default is upgraded to automatic mode once; any later decision to pause automatic skipping is preserved. Existing player permissions, show mappings, and cached timings are retained when reloading the same extension folder. The user's local installation target is `C:\Users\richh\Downloads\thecalm-skip`; this cloud workspace cannot directly access that Windows drive.

For the 0.1.2 performance fix, close existing TheCalm/player tabs before updating, then reopen them afterward so the old polling scripts are fully unloaded. Keep only one enabled copy of TheCalm Skip. Reload the existing extension folder instead of loading another extracted copy as a second extension.

For a player hosted inside another website's iframe, choose its host under the player controls and press **Connect player**. Brave asks for access to that specific host. Access is optional; the extension does not automatically request access to every site. Reloading or changing episodes reconnects previously granted hosts within TheCalm tabs. A new or nested player host may require another connection.

## What the extension does

- Identifies season and episode from TheCalm's episode URL.
- Resolves the show using primary page metadata or a saved IMDb series ID. Prison Break is already mapped to `tt0455275`. If another show cannot be identified, enter its **series** IMDb ID once in the popup; no timestamp entry is needed.
- Fetches that episode's intro, recap, and outro from IntroDB, without sending cookies or your viewing history. Successful timings are cached locally for 24 hours. Empty results are cached for 15 minutes; connection failures are not treated as missing data.
- Skips only the marked ranges. Story scenes between a recap and an intro keep playing.
- Automatically skips supported recaps and intros, then shows a compact three-second confirmation toast. Offers **Undo** after a seek. Undo and the manual-mode **Keep watching** control prevent that segment from being skipped again until the episode or video source changes.
- When credits begin, automatically advances after a three-second countdown with **Cancel**. It follows an existing TheCalm episode link or clicks an explicit, visible **Next episode** button. Native video fullscreen exits automatically before advancing. It does not invent URLs, click generic carousel controls, or advance when no supported next control exists.
- Provides per-type switches for recaps, intros, and next episode, plus a global automation switch.

There is no local AI detection or Netflix importer in this first version. An episode without usable IntroDB data keeps playing normally.

## Timing checks and limitations

Before each automatic action, the extension checks the show/season/episode identity, current media source, active visible player, non-overlapping ranges, and the selected segment's provider confidence (at least 0.9). Intro and recap endpoints must fit the measured video duration, with two seconds allowed for rounding. For automatic next episode, the credit **start** must be inside the video; a longer stored credit tail does not block navigation. Missing or invalid data leaves that segment unchanged.

An intro or recap does **not** require a credit timestamp or an exact match between the credits' endpoint and the file duration. A different credit tail, or unavailable/low-confidence data for another segment, no longer disables a valid intro. Provider confidence does not prove matching edits; **Undo** and manual mode remain available if community timings are wrong for your version. The credit action intentionally advances to the next episode and may miss a post-credit scene.

Player support requires a normal seekable HTML video element, including one in an open shadow root or an explicitly connected HTTPS iframe. A connected frame stays associated with its verified visible parent when its own URL changes; hidden parents and revoked permissions still disable automatic actions. Closed shadow roots, opaque/sandboxed frames, initial redirects that cannot be associated with a visible player, custom non-HTML players, and sites with an unlabeled custom next control can need a site-specific adapter. Native video-element fullscreen may hide the toast or countdown; automatic next episode still runs, and the popup's Undo control remains available for intro/recap seeks.

### Page load and automatic action handling

Version 0.1.2 removes the continuous full-page scans and short-lived status heartbeat that could slow pages and prevent automatic skips. Media discovery walks an episode page once, then examines only added or removed subtrees. Text-only updates do not rescan the document. Non-episode TheCalm pages perform no media discovery, timestamp lookups, or playback reporting.

Skip decisions follow the video's playback events. When a segment is reached, the worker checks the current episode, settings, player permission, visible parent, and canonical segment range before authorizing the seek. A slow or missing status report no longer blocks skipping. Inactive frames do not poll the timing provider every three seconds. Status snapshots are sent for meaningful media changes and at most every 15 seconds during playback; the popup requests fresh player status when opened.

The extension considers all visible player iframes, so a larger unrelated ad iframe no longer excludes the movie. Reconnection is limited to TheCalm episode tabs and each changed, granted frame document is injected once. Unrelated HTTPS pages do not trigger tab queries or player injection.

### Confirmed example: Prison Break S1E18

The user supplied this actual IntroDB response; it is preserved as a test fixture, not hardcoded into the extension:

| Segment | Start | End |
| --- | ---: | ---: |
| Recap | 0:00 | 0:52 |
| Intro | 4:29 | 5:02 |
| Credits | 43:19 | 43:59 |

If a lookup fails, open [the public episode lookup](https://api.introdb.app/segments?imdb_id=tt0455275&season=1&episode=18), copy its JSON, and paste it under **Import an IntroDB response**. Imports must match the current episode and pass the same schema checks as fetched data. No credentials or media files are imported. Imported data is also cached for 24 hours; refreshing replaces it with a live lookup.

## Development and validation

Use the existing checkout; cloud tasks are already isolated and do not need another Git worktree.

```sh
cd /workspace/TheCalm
npm ci --no-audit --no-fund
npm test
npm run test:dev-sync
npm run test:browser
npm run package
```

Node 20 or newer is required. The extension itself has no runtime dependencies and needs no build step. Playwright is a pinned development dependency. Browser tests use the system `/usr/bin/chromium`; set `CHROMIUM_PATH` if it is elsewhere. There is no browser download during installation. ZIP packaging uses Python 3.

The Windows sync script only needs Git and PowerShell 5.1 or later; it does not need Node or Python. Its test suite requires PowerShell (`powershell.exe` on Windows or `pwsh` elsewhere); `CALM_SKIP_PWSH` can select an explicit executable. Tests also run in CI. The cloud validation uses PowerShell 7 on Linux and does not establish that the updater has run on the user's Windows computer.

Unit tests cover identity and timestamp validation, zero-start recaps, cold opens, per-segment bounds/confidence checks, automatic-default migration, preserved pause preferences, cache behavior, timeouts/provider errors, imported JSON, on-action authorization, embedded-frame associations, and deduplicated injection. Browser tests exercise the production player scripts with real, seekable synthetic media and a simulated extension API. Performance regressions count full-document scans and message traffic during large-page text updates and on non-episode pages. No movie files are included or downloaded.

The cloud browser's managed policy blocks loading unpacked extensions, so browser-harness results do **not** establish installed-extension behavior. The live site remains inaccessible from this cloud workspace. The user confirmed correct manual controls but reported failed automation and slower refreshes in 0.1.1. Version 0.1.2 addresses reproduced frame-selection, heartbeat, repeated-injection, and scan problems. Version 0.1.3 additionally enables automatic next episode in native fullscreen, with truncated credit tails, and through explicitly labeled buttons. The updated build still needs a live check in Brave.

### First live acceptance check

1. Load the unpacked extension in Brave, open Prison Break S1E18, and connect its embedded player host if needed.
2. Confirm the popup identifies **Prison Break · Season 1 · Episode 18** and displays the three ranges above. Use JSON import if the live API is unavailable.
3. With automatic mode on, verify the recap skips to 0:52 and the intro skips to 5:02 without pressing a skip button. Each action should show a three-second confirmation toast.
4. Check preservation of the cold open, Undo, and Cancel during the next-episode countdown. Turning automatic mode off should restore manual controls and persist after reloading.
5. Confirm advancing uses the actual next episode and the new episode receives its own timings. Unknown episodes, out-of-bounds segments, and stale media sources must leave playback unchanged.

## Privacy and permissions

The required hosts are `thecalm.site`, `www.thecalm.site`, and `api.introdb.app`. Optional HTTPS host permission is requested only when you connect a player from the popup. `storage` keeps settings, show mappings, and up to 100 timing records locally. Temporary session storage retains frame IDs, the top document ID, and hashes of verified iframe source URLs across worker suspension; it does not retain raw iframe URLs or query tokens. `activeTab`, `scripting`, and `webNavigation` locate and connect the player inside the current TheCalm tab.

Only the IMDb show ID, season, and episode are sent to IntroDB. The extension does not export your Netflix login, browser cookies, video/audio, or local playback history. Local settings and cached data can be removed by uninstalling the extension.
