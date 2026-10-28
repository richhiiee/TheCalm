# Identifying shows and finding timestamps

Development version 0.1.6 identifies series beyond Prison Break automatically. It first uses an explicit saved IMDb mapping, primary page metadata, or the existing Prison Break mapping. When none is available, the extension searches IntroDB's metadata endpoint for the show title derived from its URL.

The automatic match must be a TV series with an exact normalized title and a valid IMDb ID. Punctuation differences are normalized; a trailing year can distinguish remakes only after trying the complete title, so a title such as Space: 1999 is preserved. Multiple matches require a choice in the popup. **Change show** also allows correction of a previously saved mapping.

Searches use the existing IntroDB host permission, omit credentials and the referrer, and never include full player URLs or navigation tokens. Requests are coalesced and the local cache is limited to 100 titles: 24 hours for a match and 15 minutes for ambiguous/missing results. Network/schema failures are retryable and are not cached as missing. Explicit mappings remain separate and take precedence.

The search endpoint is the public `metadata.searchMedia` route used by IntroDB's Discover frontend. Its response is checked before use; an incompatible response leaves the show unidentified rather than choosing a guessed series.

## Checked episodes

These public responses were checked on October 28, 2026 and are preserved as test fixtures. Community coverage can change.

| Episode | Show identification | Available timestamps |
| --- | --- | --- |
| Better Call Saul S1E1 | IMDb `tt3032476` | Intro 6:00.5–6:15; credits 52:18–53:02; no recap marker |
| The Simpsons S13E3 | IMDb `tt0096697` | IntroDB currently supplies no intro, recap, or credit markers |

To check Better Call Saul, play from about **6:05** with automatic skipping on; it should jump to **6:15**. Story before the intro should keep playing. An identified episode with no markers should display a missing-timings message, with the player shown as connected when it is detected.

An alternative provider's Simpsons marker was also inspected, but its reported confidence was about 0.284, below the extension's 0.9 threshold. It is not used, and the extension's confidence requirement is unchanged. No additional timing provider or host permission was added.

## Development update and store review

Pull the `development` branch, run the existing Windows sync watcher, reload CalmSkip in `brave://extensions`, and reopen the episode. The popup footer should show **v0.1.6**. If the old watcher has not been restarted since the CalmSkip rename, follow the one-time restart in [the Windows guide](DEVELOPMENT_WINDOWS.md#upgrading-the-name-to-calmskip).

The already submitted Chrome Web Store bundle remains **v0.1.5**. These development changes do not upload a replacement, cancel the pending review, or update a store installation automatically.
