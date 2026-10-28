# CalmSkip submission fields and review instructions

This file accompanies the release ZIP, icon, screenshots, [listing copy](LISTING.md), and [privacy policy](PRIVACY.md). It does not assert that a store item has been uploaded, approved, or published.

## Privacy practices: single purpose

Automatically skip supported recaps and intros and advance at credits on TheCalm using IntroDB community episode timestamps, with visible Undo, Cancel, and feature controls.

## Permission justifications

Use the fields corresponding to the final release manifest. These descriptions cover the required permissions after removing the unnecessary `activeTab` permission.

| Permission or host | Paste-ready justification |
| --- | --- |
| `storage` | Save the user's skip preferences, show-to-IMDb mappings, and a bounded local timestamp cache. Browser-session storage also keeps verified player frame associations so connected players survive background-worker suspension. These records are not synced to a developer server. |
| `scripting` | Run the extension's packaged player controller and frame verification code inside an embedded video player after the user grants access to that host. This is necessary to read the HTML video's current time and perform the selected skip or Undo. No executable code is downloaded. |
| `webNavigation` | Identify the frame/document hierarchy within a TheCalm episode tab and reconnect an already granted player when its document loads or redirects. Navigation events outside the supported episode context are discarded, rather than recorded as browsing history. |
| `https://thecalm.site/*` and `https://www.thecalm.site/*` | Identify the current show, season, and episode; read primary metadata and visible player frames; display skip controls and confirmations; and follow the site's actual next-episode link. The extension can read a same-origin show/season page to resolve an episode chooser. |
| `https://api.introdb.app/*` | Request community intro, recap, and credit timestamps using the current IMDb series ID, season, and episode. These HTTPS requests omit cookies and the page referrer. |
| Optional `https://*/*` | TheCalm embeds players on different HTTPS hosts, so their names cannot all be declared in advance. The extension requests access only to the particular player origin selected by the user with Connect player. It verifies the player belongs to the visible TheCalm embed before controlling it. It does not request access to every HTTPS site or operate those controls in unrelated tabs. |

### Remote code

Answer **No** to using remotely hosted executable code. The player controller, background worker, popup, and frame verification functions are packaged in the extension. IntroDB supplies validated timestamp JSON, not executable code. Reading a TheCalm episode catalog supplies links, not code to evaluate.

## Data usage disclosures

Do not use a blanket “no user data” declaration. The extension handles the current episode's page/player information locally and sends episode identifiers to IntroDB. Google's [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) requires disclosure even when data stays on the device.

Based on the current implementation, disclose these relevant categories using the dashboard's current definitions:

| Category | What CalmSkip handles |
| --- | --- |
| Web history / browsing activity | The current TheCalm episode address and connected player addresses are processed to identify the supported episode and frames. IMDb series ID, season, and episode are sent to IntroDB for the requested feature. No general browsing-history log is created. |
| Website content | Primary show/episode metadata, episode links, embedded player elements, video properties, and the timestamp response are read to operate the player. Video/audio content is not recorded or uploaded. |
| User activity | Current playback position and play/pause/seek state, together with the user's extension controls, are used to decide and undo skips. There is no general click, keyboard, or advertising analytics logging. |

The implementation does not read names, contact details, payment/health information, passwords, authentication cookies, private communications, or geolocation. Browser-managed same-origin cookies attached to a normal TheCalm request are not read or exported by the extension. IntroDB can receive ordinary network information such as IP addresses; that disclosure appears in the privacy policy, without claiming that CalmSkip reads geolocation.

The three limited-use certifications are consistent with this release: no sale or unrelated transfer of user data; use only for the extension's stated purpose; no creditworthiness or lending use. Verify the dashboard's actual wording against the final release before certifying.

Privacy policy URL after this file is pushed to the public repository:

```text
https://github.com/richhiiee/TheCalm/blob/development/docs/store/PRIVACY.md
```

## Reviewer test instructions

The extension works on authenticated episode pages at `https://thecalm.site`. CalmSkip itself has no account or subscription, but it does not supply access to TheCalm.

**Before submission, supply any dedicated TheCalm review account/access instructions required to reach a playable episode directly in the dashboard's private test-instructions field. Do not put credentials in this public file, source control, or the listing.** No review account has been created or verified by this repository setup. A recording or synthetic browser test is useful supporting evidence, but does not replace working reviewer access when the live site requires it.

Paste and complete the following private test instructions:

1. Sign in to TheCalm using the review access provided privately in this field, if required.
2. Open `https://thecalm.site/shows/prison-break/season-1/episode-21?pl=0` and start the episode. A different available episode with IntroDB coverage may be used if this episode becomes unavailable.
3. Open CalmSkip from the browser's extensions menu. Confirm it identifies Prison Break, season 1, episode 21, and says Auto enabled.
4. If the player is embedded on another HTTPS host, choose that host and press Connect player, accept the specific-host permission prompt, and continue playback. The popup should say Player ready.
5. Play from approximately 0:10. The community recap range is 0:00–1:25, so the video should jump to 1:25 and briefly show Skipped recap with Undo.
6. Play from approximately 3:40. The intro range is 3:37–4:07, so the video should jump to 4:07. Undo returns to the earlier position and prevents immediate repeat skipping of that segment.
7. Near 42:57, the credit marker should start a three-second next-episode countdown. Cancel keeps the episode open. Without cancellation, the extension follows a verified next-episode link, including through an episode chooser when supported. This intentionally can skip post-credit scenes.
8. Turn Automatic skipping off to check manual controls. Turn individual feature switches off to verify they are respected. Reloading preserves the chosen settings and granted host access.
9. An episode without usable timestamp data should keep playing without fabricated skip ranges. Community timing and availability can change; the privacy policy and listing explain these limits.

For an API outage only, the popup's Import an IntroDB response accepts the matching public response saved in `tests/fixtures/prison-break-s01e21.json`. This imports timestamp JSON, not video or executable code. A matching import is not a substitute for a playable TheCalm episode.

## Distribution and final submission

- Visibility: **Public**, as requested by the publisher.
- Upload the release ZIP containing `manifest.json` at its root; do not upload a ZIP containing the whole repository or a nested ZIP.
- Upload the 128×128 extension icon and at least one screenshot at the dimensions required by the dashboard. Keep screenshots consistent with the released UI.
- Complete the publisher/account contact verification, privacy fields, and private reviewer access instructions.
- Use **Submit for review** only after those actual fields and assets are complete. Google decides review timing and approval; submitting does not make the item immediately available.
- After approval/publication, install the resulting listing in Brave and disable the unpacked development copy while testing the store copy.

Official references: [privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), [store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing), [publish](https://developer.chrome.com/docs/webstore/publish).
