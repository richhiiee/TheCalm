/* Pure helpers shared by the extension and its Node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CalmSkip = api;
})(globalThis, function () {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({ enabled: true, skipIntro: true, skipRecap: true, autoNext: true });
  const MIN_CONFIDENCE = 0.9;
  const DURATION_TOLERANCE = 2;
  const BUILTIN_MAPPINGS = Object.freeze({ "prison-break": "tt0455275" });
  const SEGMENT_TYPES = Object.freeze(["recap", "intro", "outro"]);

  function isCalmUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && ["thecalm.site", "www.thecalm.site"].includes(url.hostname) && !url.port && !url.username && !url.password;
    } catch { return false; }
  }

  function parseEpisodeUrl(value) {
    if (!isCalmUrl(value)) return null;
    const match = new URL(value).pathname.match(/^\/shows\/([a-z0-9]+(?:-[a-z0-9]+)*)\/season-(\d+)\/episode-(\d+)\/?$/i);
    if (!match) return null;
    const season = Number(match[2]);
    const episode = Number(match[3]);
    if (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 1) return null;
    return { slug: match[1].toLowerCase(), season, episode };
  }

  function normalizeImdbId(value) {
    if (typeof value !== "string") return null;
    const input = value.trim();
    if (/^tt\d{7,10}$/i.test(input)) return input.toLowerCase();
    try {
      const url = new URL(input);
      if (url.protocol !== "https:" || !["imdb.com", "www.imdb.com", "m.imdb.com"].includes(url.hostname)) return null;
      const match = url.pathname.match(/^\/title\/(tt\d{7,10})\/?$/i);
      return match ? match[1].toLowerCase() : null;
    } catch { return null; }
  }

  function extractPrimaryImdb(documents, pageUrl, metaValues = []) {
    const episode = parseEpisodeUrl(pageUrl);
    if (!episode) return null;
    const types = node => (Array.isArray(node?.["@type"]) ? node["@type"] : [node?.["@type"]])
      .filter(value => typeof value === "string").map(value => value.split(/[\/#:]/).pop());
    const isType = (node, type) => types(node).includes(type);
    const reference = value => {
      try { return typeof value === "string" ? new URL(value, pageUrl).href : null; } catch { return null; }
    };
    const index = new Map();
    const nodes = [];
    const visited = new WeakSet();
    const collect = (value, depth = 0) => {
      if (!value || typeof value !== "object" || visited.has(value) || depth > 16 || nodes.length >= 512) return;
      visited.add(value);
      if (Array.isArray(value)) { for (const item of value) collect(item, depth + 1); return; }
      nodes.push(value);
      const id = reference(value["@id"]);
      if (id && Object.keys(value).length > 1) index.set(id, value);
      for (const child of Object.values(value)) collect(child, depth + 1);
    };
    for (const source of documents || []) collect(source);
    const expand = value => {
      if (typeof value === "string") return index.get(reference(value)) || null;
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const definition = index.get(reference(value["@id"]));
      return definition && definition !== value ? { ...definition, ...value } : value;
    };
    const matchingUrl = value => {
      try {
        const url = new URL(typeof value === "object" ? value?.["@id"] : value, pageUrl);
        if (!isCalmUrl(url.href)) return false;
        const media = parseEpisodeUrl(url.href);
        return media ? media.slug === episode.slug && media.season === episode.season && media.episode === episode.episode
          : url.pathname.replace(/\/$/, "").toLowerCase() === `/shows/${episode.slug}`;
      } catch { return false; }
    };
    const pointsHere = node => [node.url, node.mainEntityOfPage].some(value => value && matchingUrl(value)) ||
      (typeof node["@id"] === "string" && (isType(node, "WebPage") || !node["@id"].startsWith("#")) && matchingUrl(node["@id"]));
    const directIds = node => {
      const ids = new Set();
      const read = value => {
        if (Array.isArray(value)) { value.forEach(read); return; }
        if (value && typeof value === "object") {
          const property = value.propertyID || value.name;
          if (property && !/imdb/i.test(String(property))) return;
          read(value.value); read(value["@id"]); return;
        }
        const id = normalizeImdbId(value); if (id) ids.add(id);
      };
      for (const value of [node.imdb_id, node.imdbId, node.url, node["@id"], node.identifier, node.sameAs]) read(value);
      return ids;
    };
    const titleKey = value => typeof value === "string" ? value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "") : "";
    const expectedTitles = [episode.slug, episode.slug.replace(/-(?:19|20)\d{2}$/, "")].map(titleKey);
    const yearHint = Number(episode.slug.match(/-((?:19|20)\d{2})$/)?.[1]) || null;
    const seriesMatches = node => {
      if (typeof node.name === "string" && !expectedTitles.includes(titleKey(node.name))) return false;
      if ([node.url, node["@id"]].some(value => {
        if (typeof value !== "string" || !value) return false;
        try { const url = new URL(value, pageUrl); return isCalmUrl(url.href) && !matchingUrl(value); } catch { return false; }
      })) return false;
      const years = [node.startDate, node.datePublished, node.year].map(value => {
        const match = String(value ?? "").match(/^((?:19|20)\d{2})(?:$|[-T])/);
        return match ? Number(match[1]) : null;
      }).filter(Boolean);
      return !yearHint || years.every(year => year === yearHint);
    };
    const seriesIds = (value, ancestors = new Set(), depth = 0, asSeries = false) => {
      if (depth > 12) return new Set();
      if (Array.isArray(value)) {
        const ids = new Set();
        for (const item of value) for (const id of seriesIds(item, ancestors, depth + 1, asSeries)) ids.add(id);
        return ids;
      }
      if (asSeries && normalizeImdbId(value)) return new Set([normalizeImdbId(value)]);
      const node = expand(value);
      if (!node || typeof node !== "object") return new Set();
      const identity = reference(node["@id"]) || node;
      if (ancestors.has(identity)) return new Set();
      const next = new Set(ancestors); next.add(identity);
      if (isType(node, "TVSeries") || (asSeries && !types(node).length)) {
        // Stale SPA metadata for another show must not identify the new URL.
        if (!seriesMatches(node)) return new Set();
        return directIds(node);
      }
      if (isType(node, "TVEpisode") || isType(node, "TVSeason")) {
        // An episode's own IMDb ID is not an IMDb series ID.
        return node.partOfSeries ? seriesIds(node.partOfSeries, next, depth + 1, true) : seriesIds(node.partOfSeason, next, depth + 1);
      }
      if (isType(node, "WebPage")) return seriesIds(node.mainEntity, next, depth + 1);
      return new Set();
    };
    const mediaNodes = nodes.filter(node => isType(node, "TVSeries") || isType(node, "TVEpisode"));
    let primary = nodes.filter(node => isType(node, "WebPage") && node.mainEntity && pointsHere(node));
    if (!primary.length) primary = mediaNodes.filter(pointsHere);
    if (!primary.length) {
      const roots = (documents || []).flatMap(source => Array.isArray(source) ? source : [source]);
      const hasOtherPage = node => [node?.url, node?.["@id"]].some(value => {
        if (typeof value !== "string" || !value) return false;
        try { const url = new URL(value, pageUrl); return isCalmUrl(url.href) && !matchingUrl(value); } catch { return false; }
      });
      const rootMedia = roots.filter(node => !hasOtherPage(node) && (isType(node, "TVSeries") || isType(node, "TVEpisode") || (isType(node, "WebPage") && node.mainEntity)));
      if (rootMedia.length === 1) primary = rootMedia;
      else if (!rootMedia.length) {
        const graphMedia = roots.flatMap(node => Array.isArray(node?.["@graph"]) ? node["@graph"] : [])
          .filter(node => !hasOtherPage(node) && (isType(node, "TVSeries") || isType(node, "TVEpisode")));
        if (graphMedia.length === 1) primary = graphMedia;
      }
    }
    const ids = new Set();
    for (const node of primary) for (const id of seriesIds(node)) ids.add(id);
    const incompatible = new Set(nodes.filter(node => isType(node, "TVEpisode") || (isType(node, "TVSeries") && !seriesMatches(node)))
      .flatMap(node => [...directIds(node)]));
    for (const value of metaValues) { const id = normalizeImdbId(value); if (id && !incompatible.has(id)) ids.add(id); }
    return ids.size === 1 ? [...ids][0] : null;
  }

  function resolveEpisode(value, mappings = {}, primaryImdbId = null) {
    const episode = parseEpisodeUrl(value);
    if (!episode) return null;
    const mapped = Object.hasOwn(mappings, episode.slug) ? normalizeImdbId(mappings[episode.slug]) : null;
    return { ...episode, imdbId: mapped || normalizeImdbId(primaryImdbId) || BUILTIN_MAPPINGS[episode.slug] || null };
  }

  function episodeKey(context) {
    if (!context || !normalizeImdbId(context.imdbId) || !Number.isSafeInteger(context.season) || !Number.isSafeInteger(context.episode)) return null;
    return `${context.imdbId}:${context.season}:${context.episode}`;
  }

  function readTime(value, secondsField, millisecondsField) {
    const seconds = value[secondsField];
    const milliseconds = value[millisecondsField];
    const hasSeconds = seconds !== undefined && seconds !== null;
    const hasMilliseconds = milliseconds !== undefined && milliseconds !== null;
    if (!hasSeconds && !hasMilliseconds) throw new Error("A segment is missing a timestamp.");
    if (hasSeconds && (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0)) throw new Error("A segment has an invalid seconds timestamp.");
    if (hasMilliseconds && (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0)) throw new Error("A segment has an invalid milliseconds timestamp.");
    if (hasSeconds && hasMilliseconds && Math.abs(seconds - milliseconds / 1000) > 0.01) throw new Error("A segment's seconds and milliseconds disagree.");
    return hasSeconds ? seconds : milliseconds / 1000;
  }

  function normalizeSegment(raw, type) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`The ${type} segment is malformed.`);
    const start = readTime(raw, "start_sec", "start_ms");
    const end = readTime(raw, "end_sec", "end_ms");
    if (end <= start) throw new Error(`The ${type} segment ends before it starts.`);
    const confidence = raw.confidence === undefined ? 0 : raw.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error(`The ${type} confidence is invalid.`);
    const submissionCount = raw.submission_count === undefined ? 0 : raw.submission_count;
    if (!Number.isSafeInteger(submissionCount) || submissionCount < 0) throw new Error(`The ${type} submission count is invalid.`);
    return { type, start, end, confidence, submissionCount };
  }

  function validateTimings(raw, context) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("IntroDB returned malformed episode data.");
    if (!context || normalizeImdbId(raw.imdb_id) !== context.imdbId || raw.season !== context.season || raw.episode !== context.episode || raw.media_type !== "tv" || raw.is_movie === true) {
      throw new Error("The timing data belongs to a different episode.");
    }
    const segments = {};
    const issues = [];
    for (const type of SEGMENT_TYPES) {
      segments[type] = normalizeSegment(raw[type], type);
      if (raw[`no_${type}`] === true && segments[type]) throw new Error(`The provider both marks ${type} absent and supplies a segment.`);
    }
    const ordered = Object.values(segments).filter(Boolean).sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].start < ordered[i - 1].end) issues.push("The timing ranges overlap.");
    }
    const postCredits = normalizeSegment(raw.post_credits, "post_credits");
    return { imdbId: context.imdbId, season: context.season, episode: context.episode, segments, postCredits, issues: [...new Set(issues)], hasData: ordered.length > 0 };
  }

  function assessTimings(timings, duration, requestedSegment) {
    if (!timings || !timings.hasData) return { safe: false, reason: "No skip timings are available for this episode." };
    if (!Number.isFinite(duration) || duration <= 0) return { safe: false, reason: "Waiting for the video duration." };
    if (timings.issues.length) return { safe: false, reason: timings.issues[0] };
    const type = typeof requestedSegment === "string" ? requestedSegment : requestedSegment?.type;
    if (requestedSegment !== undefined && !SEGMENT_TYPES.includes(type)) return { safe: false, reason: "No timing is available for this segment." };
    const segments = requestedSegment === undefined
      ? Object.values(timings.segments).filter(Boolean)
      : [timings.segments[type]].filter(Boolean);
    if (!segments.length) return { safe: false, reason: "No timing is available for this segment." };
    const assessSegment = segment => {
      // Credits advance to another episode instead of seeking to their stored
      // endpoint. A shortened credit tail must not block a valid start marker.
      if (segment.start >= duration || (segment.type !== "outro" && segment.end > duration + DURATION_TOLERANCE)) return { safe: false, reason: "This segment's timestamps extend beyond the video." };
      if (segment.confidence < MIN_CONFIDENCE) return { safe: false, reason: "This segment has insufficient provider confidence for automatic skipping." };
      return { safe: true, reason: "Automatic skipping is ready for available, confident segments." };
    };
    const results = segments.map(assessSegment);
    // An absent or differently cut credit tail must not prevent an otherwise
    // valid recap/intro from skipping. Each action checks its own stored range.
    return results.find(result => result.safe) || results[0];
  }

  function segmentAt(timings, time, settings = DEFAULT_SETTINGS) {
    if (!timings || !Number.isFinite(time) || time < 0) return null;
    for (const type of SEGMENT_TYPES) {
      if ((type === "intro" && !settings.skipIntro) || (type === "recap" && !settings.skipRecap) || (type === "outro" && !settings.autoNext)) continue;
      const segment = timings.segments[type];
      if (segment && time >= segment.start && time < segment.end - 0.05) return segment;
    }
    return null;
  }

  function formatTime(value) {
    if (!Number.isFinite(value) || value < 0) return "—";
    const seconds = Math.floor(value);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function sanitizeSettings(value) {
    const settings = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) settings[key] = typeof value?.[key] === "boolean" ? value[key] : DEFAULT_SETTINGS[key];
    return settings;
  }

  return Object.freeze({ DEFAULT_SETTINGS, MIN_CONFIDENCE, DURATION_TOLERANCE, BUILTIN_MAPPINGS, SEGMENT_TYPES, isCalmUrl, parseEpisodeUrl, normalizeImdbId, extractPrimaryImdb, resolveEpisode, episodeKey, validateTimings, assessTimings, segmentAt, formatTime, sanitizeSettings });
});
