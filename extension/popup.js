/* global chrome */
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const settingsKeys = ["enabled", "skipRecap", "skipIntro", "autoNext"];
  const view = { tabId: null, onSite: false, response: null, player: null, busy: false };

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "—";
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    const remainder = String(total % 60).padStart(2, "0");
    return minutes >= 60
      ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${remainder}`
      : `${minutes}:${remainder}`;
  }

  function rangeText(segment) {
    if (!segment) return "No timing data";
    return `${formatTime(segment.start)} – ${segment.end == null ? "end" : formatTime(segment.end)}`;
  }

  function feedback(message = "", isError = false) {
    $("feedback").textContent = message;
    $("feedback").classList.toggle("error", isError);
  }

  function prettyTitle(slug) {
    return String(slug || "Episode").split("-").filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
  }

  async function request(type, data = {}) {
    const response = await chrome.runtime.sendMessage({ type, tabId: view.tabId, ...data });
    if (!response || response.ok === false) {
      throw new Error(response?.error || "The extension did not respond. Reload the episode and try again.");
    }
    return response;
  }

  function refreshButtons() {
    const context = view.response?.context;
    for (const key of settingsKeys) $(key).disabled = view.busy || !view.onSite || !context;
    $("refresh").disabled = view.busy || !context?.imdbId;
    $("import").disabled = view.busy || !context?.imdbId || !$("import-json").value.trim();
    $("save-mapping").disabled = view.busy || !context?.slug;
    $("undo").disabled = view.busy || !view.player?.canUndo;
    $("connect").disabled = view.busy || !$("player-origin").value;
  }

  function setBusy(busy) {
    view.busy = busy;
    document.body.setAttribute("aria-busy", String(busy));
    refreshButtons();
  }

  function renderContext(response) {
    view.response = response;
    const { context, settings, timings, status, error } = response;
    $("episode-title").textContent = context ? prettyTitle(context.slug) : "Open an episode";
    $("episode-detail").textContent = context
      ? `Season ${context.season} · Episode ${context.episode}`
      : "Choose a show on thecalm.site to get started.";
    for (const key of settingsKeys) $(key).checked = Boolean(settings?.[key]);
    const enabled = Boolean(settings?.enabled);
    $("mode").textContent = enabled ? "Auto enabled" : "Manual mode";
    $("mode").classList.toggle("active", enabled);
    $("auto-description").textContent = enabled
      ? "Skips supported segments with a brief confirmation toast."
      : "Automatic skipping is paused. Skip buttons remain available.";
    const segments = timings?.segments || {};
    for (const type of ["intro", "recap", "outro"]) $(type + "-range").textContent = rangeText(segments[type]);
    const counts = Object.values(segments).filter(Boolean).map((segment) => segment.submissionCount).filter(Number.isFinite);
    $("source").textContent = counts.length && counts.every((count) => count === counts[0])
      ? `IntroDB · ${counts[0]} community contribution${counts[0] === 1 ? "" : "s"} per segment`
      : "Timings supplied by IntroDB";
    $("mapping-area").hidden = !context || Boolean(context.imdbId);
    const messages = {
      ready: "Timings found. Supported segments skip automatically when enabled.",
      missing: "IntroDB has no usable timings for this episode. Playback stays unchanged.",
      unidentified: "Identify this show below to look up its timestamps.",
      error: error || "The timing lookup failed. You can retry or import an IntroDB response.",
    };
    $("status").textContent = !context
      ? "Open a show’s season and episode page on thecalm.site."
      : messages[status] || (error ? String(error) : "Checking episode timings…");
    $("status").classList.toggle("error", status === "error");
    if (timings?.issues?.length) {
      $("source").textContent += " · Some segment data was rejected";
      $("source").title = timings.issues.join("; ");
    } else {
      $("source").removeAttribute("title");
    }
    refreshButtons();
  }

  function renderPlayer(player) {
    view.player = player;
    const hasVideo = Boolean(player?.videoFound);
    const safe = Boolean(player?.safety?.ok);
    $("player-title").textContent = hasVideo ? (safe ? "Player ready" : "Player needs review") : "Player not detected";
    $("player-dot").classList.toggle("connected", hasVideo && safe);
    $("player-dot").classList.toggle("warning", hasVideo && !safe);
    $("player-time").textContent = hasVideo && Number.isFinite(player.duration)
      ? `${formatTime(player.currentTime || 0)} / ${formatTime(player.duration)}` : "";
    $("player-detail").textContent = hasVideo
      ? (player.lastBlockReason || player.safety?.reason || "Supported segments skip during playback.")
      : "Start the episode or reload this page after installing. Embedded players may need separate access.";
    const options = $("player-origin");
    const previous = options.value;
    options.replaceChildren();
    const origins = Array.isArray(player?.playerOrigins) ? player.playerOrigins : [];
    for (const item of origins) {
      const origin = typeof item === "string" ? item : item.origin;
      try {
        const url = new URL(origin);
        if (!/^https?:$/.test(url.protocol) || url.origin !== origin) continue;
        const option = document.createElement("option");
        option.value = origin;
        option.textContent = url.host + (item.granted ? " · connected" : "");
        options.append(option);
      } catch { /* Unusable frame locations never become permission requests. */ }
    }
    if ([...options.options].some((option) => option.value === previous)) options.value = previous;
    $("connect-area").hidden = !options.options.length;
    refreshButtons();
  }

  async function loadPlayer() {
    if (!view.onSite) return renderPlayer(null);
    // Discovery repairs an already granted player before its fresh status is read.
    let originsResult;
    try { originsResult = await request("PLAYER_ORIGINS"); } catch { /* The page can still report a local player. */ }
    let player = null;
    const retryDelays = [100, 200, 400];
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        const result = await chrome.tabs.sendMessage(view.tabId, { type: "GET_PLAYER_STATUS" }, { frameId: 0 });
        player = result?.player || result || null;
      } catch { /* A new document may still be connecting. */ }
      if (player?.videoFound || !originsResult?.connectedFrames || attempt === retryDelays.length) break;
      await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
    }
    // Only the popup may enumerate nested player frames. Keep the page's
    // direct-frame fallback if privileged discovery fails during navigation.
    if (Array.isArray(originsResult?.playerOrigins)) {
      player = { ...(player || {}), playerOrigins: originsResult.playerOrigins };
    }
    renderPlayer(player);
  }

  async function loadContext() {
    const response = await request("GET_CONTEXT");
    renderContext(response);
    await loadPlayer();
  }

  async function perform(operation, successMessage = "") {
    feedback();
    setBusy(true);
    try {
      await operation();
      await loadContext();
      if (successMessage) feedback(successMessage);
    } catch (error) {
      feedback(error.message || "Something went wrong. Please try again.", true);
    } finally {
      setBusy(false);
    }
  }

  for (const key of settingsKeys) {
    $(key).addEventListener("change", () => {
      const checked = $(key).checked;
      perform(async () => {
        try {
          await request("SET_SETTINGS", { settings: { [key]: checked } });
        } catch (error) {
          $(key).checked = !checked;
          throw error;
        }
      }, key === "enabled" ? (checked ? "Automatic skipping enabled. Unusable timings still leave playback unchanged." : "Automatic skipping paused.") : "Settings saved.");
    });
  }

  $("refresh").addEventListener("click", () => perform(() => request("REFRESH_TIMINGS"), "Timing lookup refreshed."));
  $("undo").addEventListener("click", () => perform(() => request("UNDO_SKIP"), "Returned to the position before the last skip."));
  $("import-json").addEventListener("input", refreshButtons);
  $("import").addEventListener("click", () => perform(async () => {
    let data;
    try { data = JSON.parse($("import-json").value); }
    catch { throw new Error("Paste a valid JSON response from IntroDB."); }
    await request("IMPORT_TIMINGS", { data });
    $("import-json").value = "";
  }, "Timings imported for this episode."));

  $("mapping-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const imdbId = $("imdb-id").value.trim();
    if (!/^tt\d{7,10}$/.test(imdbId)) return feedback("Enter an IMDb series ID such as tt0455275.", true);
    perform(() => request("SET_MAPPING", { slug: view.response.context.slug, imdbId }), "Show identified. Future episodes use this series ID.");
  });

  $("connect").addEventListener("click", async () => {
    const origin = $("player-origin").value;
    if (!origin) return;
    try {
      // Keep this call directly in the click handler: Chromium requires a user gesture.
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) return feedback("Player access wasn’t granted. Playback is unchanged.");
      await perform(() => request("CONNECT_PLAYER", { origins: [origin] }), "Embedded player connected.");
    } catch (error) {
      feedback(error.message || "Could not connect to this embedded player.", true);
    }
  });

  async function initialize() {
    $("build-version").textContent = `TheCalm Skip v${chrome.runtime.getManifest?.().version || "0.1.4"}.`;
    setBusy(true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      view.tabId = tab?.id;
      let url;
      try { url = new URL(tab?.url); } catch { /* Browser-internal pages are unsupported. */ }
      view.onSite = Boolean(url && /^https?:$/.test(url.protocol) && ["thecalm.site", "www.thecalm.site"].includes(url.hostname));
      if (!view.onSite || !Number.isInteger(view.tabId)) {
        $("status").textContent = "Open an episode on thecalm.site, then open TheCalm Skip.";
        $("player-title").textContent = "Waiting for an episode";
        $("player-detail").textContent = "The extension only operates on TheCalm episode pages and connected player frames.";
        return;
      }
      await loadContext();
    } catch (error) {
      $("status").textContent = "Couldn’t load this episode. Reload its page, then reopen the extension.";
      $("status").classList.add("error");
      feedback(error.message || "The extension could not connect.", true);
      await loadPlayer();
    } finally {
      setBusy(false);
    }
  }

  initialize();
})();
