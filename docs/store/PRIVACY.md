# CalmSkip privacy policy

Effective October 28, 2026.

CalmSkip is an independent browser extension for skipping supported recaps and intros and advancing at credits on thecalm.site. This policy covers the extension. TheCalm, IntroDB, your browser, and the Chrome Web Store operate separately under their own policies.

## Information used to make skipping work

CalmSkip processes the current TheCalm episode's URL, show metadata, IMDb series ID, season and episode numbers, episode links, and embedded player addresses. It reads player visibility, video duration, playback position, play/pause state, and related media events to find the player and decide when to skip. It reads your choices in the extension, such as enabled features, connected player hosts, and an IMDb mapping or timestamp response you enter.

This information is used for the extension's visible skipping and next-episode features. The extension does not build or transmit a general browsing history, inspect unrelated pages for content, or log keystrokes or private messages.

## Requests to other websites

**IntroDB:** CalmSkip sends the IMDb series ID, season number, and episode number to `https://api.introdb.app` to request community timestamps. These identifiers reveal which episode's timings are being requested. Requests do not include your TheCalm cookies, login details, full page or player URLs, video/audio, or a stored viewing history. They omit cookies and the page referrer. Like other HTTPS services, IntroDB can receive normal network information, such as the requesting IP address. CalmSkip does not control IntroDB's server logs or retention. Information about the service is available at [introdb.app](https://introdb.app).

**Automatic series identification (v0.1.6 and later):** When the page does not identify the series and no saved mapping exists, CalmSkip can also send the show title derived from its URL to IntroDB’s metadata search endpoint. This request omits cookies and the page referrer, and does not include the full TheCalm/player URL or its query tokens. Only an unambiguous exact TV-series match is used automatically; otherwise the user can select the intended series. Version 0.1.5 does not perform this additional title lookup.

**TheCalm:** To find the real next-episode link, CalmSkip can request a same-origin show or season page on TheCalm. The browser may attach your existing TheCalm session cookies to that normal same-origin request. The extension does not read those cookies or send them to IntroDB or the developer. Following an episode or starting its player causes the website's normal navigation and playback requests.

CalmSkip has no developer-operated data collection server. It contains no advertising or analytics service. The developer does not receive your episode requests, player information, or extension settings through the extension.

## Information kept on your device

- **Preferences and show mappings:** Feature switches and any saved show-to-IMDb mappings remain in the browser's local extension storage until changed or removed.
- **Timestamp cache:** Up to 100 episode timing records are kept locally. Successful results can be reused for 24 hours; missing results for 15 minutes. Expired records are removed during subsequent cache writes. Failed network requests are not stored as missing data.
- **Automatic show matches (v0.1.6 and later):** Up to 100 series-identification results are cached locally. Successful matches can be reused for 24 hours; ambiguous or unmatched titles for 15 minutes. Failed searches are not cached. This cache is separate from explicit show mappings, which remain until changed or removed.
- **Player associations:** Browser-session extension storage holds frame/document identifiers and hashes of verified iframe source addresses so an already connected player can reconnect after the extension worker restarts. Raw iframe URLs and their query parameters are not persisted in these records.
- **Next-episode continuation:** When the website opens a separate episode list, the current tab's TheCalm session storage can briefly hold the originating show, season, episode, numeric player selection, and creation time. This record is valid for 15 seconds and is cleared when consumed or when the extension completes or rejects the continuation. It contains no login details or full player address.
- **Current playback and Undo:** The current player status and Undo position are held in memory for the active page/extension session, rather than saved as a viewing log.

The extension does not use Chrome Sync to upload these records. Browser permissions for connected hosts are managed by the browser.

## Permissions and your choices

CalmSkip needs access to TheCalm episode pages and the IntroDB API. Embedded video players can use different HTTPS hosts, so additional host access is optional and requested for the specific player host you choose with Connect player. This does not grant automatic access to every HTTPS website.

You can turn automatic actions off, disable individual skip types, undo a seek, cancel next episode, or revoke a connected host's access in your browser's extension settings. Removing CalmSkip removes its local extension data through the browser's uninstall process. TheCalm page session storage is controlled separately by the browser and can also be cleared with that site's data.

## Limited use and sharing

CalmSkip uses the information described here only to provide its skipping and next-episode features. It does not sell user data, use it for advertising or credit decisions, or transfer it for unrelated purposes. Timestamp requests to IntroDB and normal website requests are the disclosures described above.

## Contact and updates

The source and support information are available at [github.com/richhiiee/TheCalm](https://github.com/richhiiee/TheCalm). Privacy questions can be raised through the [project's issue tracker](https://github.com/richhiiee/TheCalm/issues). Issues are public: do not post passwords, cookies, payment details, private messages, or private player links.

Changes to this policy will be published at this URL with an updated effective date.
