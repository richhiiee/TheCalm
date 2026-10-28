const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../extension/shared.js");

const context = { slug: "prison-break", imdbId: "tt0455275", season: 1, episode: 18 };
function raw() {
  return {
    imdb_id: "tt0455275", media_type: "tv", is_movie: false, season: 1, episode: 18,
    intro: { start_sec: 269, end_sec: 302, start_ms: 269000, end_ms: 302000, confidence: 1, submission_count: 1 },
    recap: { start_sec: 0, end_sec: 52, start_ms: 0, end_ms: 52000, confidence: 1, submission_count: 1 },
    outro: { start_sec: 2599, end_sec: 2639, start_ms: 2599000, end_ms: 2639000, confidence: 1, submission_count: 1 },
    post_credits: null, no_intro: false, no_recap: false, no_outro: false,
  };
}

test("identifies the canonical episode and ignores tracking parameters", () => {
  const result = Core.resolveEpisode("https://thecalm.site/shows/prison-break/season-1/episode-18?pl=0&_u=private");
  assert.deepEqual(result, context);
  assert.equal(Core.episodeKey(result), "tt0455275:1:18");
  assert.equal(Core.parseEpisodeUrl("https://thecalm.site.evil.test/shows/prison-break/season-1/episode-18"), null);
  assert.equal(Core.parseEpisodeUrl("http://thecalm.site/shows/prison-break/season-1/episode-18"), null);
  assert.equal(Core.parseEpisodeUrl("https://thecalm.site:444/shows/prison-break/season-1/episode-18"), null);
  assert.equal(Core.parseEpisodeUrl("https://thecalm.site/shows/prison-break/season-1/episode-0"), null);
});

test("does not guess a show identity and honors an explicit saved mapping", () => {
  const url = "https://thecalm.site/shows/another-show/season-1/episode-1";
  assert.equal(Core.resolveEpisode(url).imdbId, null);
  assert.equal(Core.resolveEpisode(url, {}, "https://www.imdb.com/title/tt0903747/").imdbId, "tt0903747");
  assert.equal(Core.resolveEpisode(url, { "another-show": "tt1234567" }, "tt0903747").imdbId, "tt1234567");
  assert.equal(Core.normalizeImdbId("https://imdb.com.evil.test/title/tt0455275"), null);
  assert.equal(Core.normalizeImdbId("other text tt0455275"), null);
});

test("preserves recap zero, cold open, and exact intro/credit boundaries", () => {
  const timings = Core.validateTimings(raw(), context);
  const settings = { enabled: true, skipIntro: true, skipRecap: true, autoNext: true };
  assert.equal(Core.segmentAt(timings, 0, settings).end, 52);
  assert.equal(Core.segmentAt(timings, 52, settings), null);
  assert.equal(Core.segmentAt(timings, 200, settings), null, "the cold open is story content");
  assert.equal(Core.segmentAt(timings, 269, settings).type, "intro");
  assert.equal(Core.segmentAt(timings, 302, settings), null);
  assert.equal(Core.segmentAt(timings, 2599, settings).type, "outro");
  assert.equal(Core.segmentAt(timings, 2639, settings), null);
  assert.equal(Core.assessTimings(timings, 2639).safe, true);
  assert.equal(Core.segmentAt(timings, 270, { ...settings, skipIntro: false }), null);
  assert.equal(Core.DEFAULT_SETTINGS.enabled, true, "installation starts with automatic skipping enabled");
});

test("rejects another episode, malformed timestamps, and conflicting units", () => {
  for (const altered of [
    { ...raw(), imdb_id: "tt0903747" },
    { ...raw(), episode: 19 },
    { ...raw(), media_type: "movie" },
    { ...raw(), intro: { start_sec: 302, end_sec: 269 } },
    { ...raw(), intro: { start_sec: "269", end_sec: 302 } },
    { ...raw(), intro: { start_sec: 269, start_ms: 2690010, end_sec: 302 } },
    { ...raw(), no_intro: true },
  ]) assert.throws(() => Core.validateTimings(altered, context));
});

test("millisecond-only ranges work without inventing missing confidence", () => {
  const input = raw();
  input.intro = { start_ms: 269000, end_ms: 302000 };
  const result = Core.validateTimings(input, context);
  assert.equal(result.segments.intro.start, 269);
  assert.equal(result.segments.intro.confidence, 0);
  assert.equal(Core.assessTimings(result, 2639, "intro").safe, false);
  assert.equal(Core.assessTimings(result, 2639).safe, true, "a usable recap is independent of the uncertain intro");
});

test("invalid duration, overlapping segments, and low confidence deny the affected action", () => {
  const timings = Core.validateTimings(raw(), context);
  for (const duration of [NaN, Infinity, 0]) assert.equal(Core.assessTimings(timings, duration).safe, false);
  assert.equal(Core.assessTimings(timings, 250, "intro").safe, false, "a skip target must fit the file");
  assert.equal(Core.assessTimings(timings, 2500, "outro").safe, false);
  const overlapping = raw();
  overlapping.recap.end_sec = 280;
  overlapping.recap.end_ms = 280000;
  assert.equal(Core.assessTimings(Core.validateTimings(overlapping, context), 2639).safe, false);
  const uncertain = raw();
  uncertain.intro.confidence = 0.7;
  assert.equal(Core.assessTimings(Core.validateTimings(uncertain, context), 2639, "intro").safe, false);
});

test("intro and recap work without an outro or an exact ending-duration match", () => {
  const timings = Core.validateTimings(raw(), context);
  for (const duration of [2625, 2645, 2700]) {
    assert.equal(Core.assessTimings(timings, duration, "intro").safe, true);
    assert.equal(Core.assessTimings(timings, duration, timings.segments.recap).safe, true);
    assert.equal(Core.assessTimings(timings, duration).safe, true);
  }
  const noEnding = raw();
  noEnding.outro = null;
  const introOnly = Core.validateTimings({ ...noEnding, recap: null }, context);
  assert.equal(Core.assessTimings(introOnly, 2639, "intro").safe, true);
  assert.equal(Core.assessTimings(introOnly, 2639).safe, true);
  assert.equal(Core.assessTimings(introOnly, 2639, "outro").safe, false);
  assert.equal(Core.assessTimings(introOnly, 2639, "__proto__").safe, false);
});

test("unrelated low-confidence credits do not prevent a trusted intro", () => {
  const lowConfidenceCredits = raw();
  lowConfidenceCredits.outro.confidence = 0.1;
  const timings = Core.validateTimings(lowConfidenceCredits, context);
  assert.equal(Core.assessTimings(timings, 2639, "outro").safe, false);
  assert.equal(Core.assessTimings(timings, 2639, "intro").safe, true);
  assert.equal(Core.assessTimings(timings, 2639).safe, true);
  const longerEnding = Core.validateTimings(raw(), context);
  assert.equal(Core.assessTimings(longerEnding, 2605, "outro").safe, true, "advancing at credits does not seek to their stored endpoint");
  assert.equal(Core.assessTimings(longerEnding, 2605, "intro").safe, true);
});

test("automatic next episode requires a valid credit start, not a matching credit tail", () => {
  const timings = Core.validateTimings(raw(), context);
  assert.equal(Core.assessTimings(timings, 2600, "outro").safe, true, "credits begin inside a file with a shortened tail");
  assert.equal(Core.assessTimings(timings, 2599, "outro").safe, false, "a credit start at the file endpoint is not playable");
  assert.equal(Core.assessTimings(timings, 2500, "outro").safe, false, "a credit marker beyond the file cannot trigger navigation");
  for (const duration of [NaN, Infinity, 0]) assert.equal(Core.assessTimings(timings, duration, "outro").safe, false);
  const uncertain = raw();
  uncertain.outro.confidence = 0.7;
  assert.equal(Core.assessTimings(Core.validateTimings(uncertain, context), 2600, "outro").safe, false, "confidence is still required for credit starts");
  assert.equal(Core.assessTimings(timings, 300, "intro").safe, true, "the existing two-second seek endpoint tolerance remains");
  assert.equal(Core.assessTimings(timings, 299, "intro").safe, false, "intro seek endpoints must still fit the file");
});

test("empty valid data is distinguished from corrupt data", () => {
  const empty = { imdb_id: context.imdbId, media_type: "tv", season: 1, episode: 18, intro: null, recap: null, outro: null };
  const result = Core.validateTimings(empty, context);
  assert.equal(result.hasData, false);
  assert.equal(Core.assessTimings(result, 2639).safe, false);
  assert.equal(Core.segmentAt(result, 1), null);
});

test("formats the user-confirmed ranges accurately", () => {
  assert.equal(Core.formatTime(0), "0:00");
  assert.equal(Core.formatTime(269), "4:29");
  assert.equal(Core.formatTime(302), "5:02");
  assert.equal(Core.formatTime(2599), "43:19");
  assert.equal(Core.formatTime(2639), "43:59");
  assert.equal(Core.formatTime(3601), "1:00:01");
});
