const cursors = {};
const OTD_INIT_TIME = Date.now();

let verifiedUser;
if(localStorage.OTDverifiedUser) {
    try {
        verifiedUser = JSON.parse(localStorage.OTDverifiedUser);
    } catch(e) {
        console.warn(`Error parsing OTDverifiedUser.`, e);
        verifiedUser = null;
    }
}
// Snapshot the persisted layout hourly as a rolling backup (no-op if <1h since last).
OTDLayout.backupHourly();
setInterval(() => OTDLayout.backupHourly(), 60 * 60 * 1000);
let seenNotifications = [];
const timings = {}; // stream key → when its last request went out
// Refresh cadence adapts to whether you're actually watching the tab. The guards below only
// *cancel* TweetDeck's background polls, so these are floors on how often a real fetch escapes:
// fast while the tab is focused, slower when the window's in the background, slowest when hidden
// or while we're backing off from a rate limit. OTDrefreshInterval (if set) overrides the fast floor.
let refreshInterval = localStorage.OTDrefreshInterval ? parseInt(localStorage.OTDrefreshInterval) : 12000;
const BLURRED_INTERVAL = 30000; // tab visible but window unfocused
const IDLE_INTERVAL = 90000;    // tab hidden, or cooling off after a 429
let rateCoolUntil = 0;
function pollFloor() {
    if (Date.now() < rateCoolUntil || document.hidden) return IDLE_INTERVAL;
    return document.hasFocus() ? refreshInterval : BLURRED_INTERVAL;
}
// TweetDeck can't refresh search faster than it polls, so hint its own timer a bit under the
// current floor; the guard is still the real governor of how often a request actually goes out.
const searchPollHint = (query) => Math.max(6, Math.round((query != null ? searchFloor(query) : pollFloor()) / 2000));
// Per-column gating: TweetDeck tracks how much of each column is scrolled into view
// (column.visibility.visibleFraction — 1 on-screen, 0 off-screen). Match an intercepted poll to
// its column by feed type + search text, and back a scrolled-off column down to IDLE — no point
// spending rate limit refreshing a feed nobody's looking at. Fails open: an unmatched request
// (TweetDeck not ready, native list/user columns we can't key, an unknown feed) isn't gated.
const tdColumn = (key) => { try { return window.TD?.controller?.columnManager?.get(key) ?? null; } catch { return null; } };
const normQuery = (s) => (s || "").replace(/\p{Cf}/gu, "").trim().replace(/\s+/g, " ");
function columnFraction(type, acct, query) {
    let best = null;
    for (const sec of document.querySelectorAll("section.column")) {
        const m = tdColumn(sec.getAttribute("data-column"));
        const sub = m && m.feedSubscriptions && Object.keys(m.feedSubscriptions)[0];
        if (!sub) continue;
        const parts = sub.split(":"); // twitter:<acct>:<type>:<hash>
        if (parts[2] !== type) continue;
        if (acct && parts[1] !== String(acct)) continue;
        if (type === "search" && normQuery(sec.querySelector(".column-title-edit-box")?.value) !== normQuery(query)) continue;
        const vf = m.visibility ? m.visibility.visibleFraction : 1;
        best = best === null ? vf : Math.max(best, vf);
    }
    return best; // null = no column matched → don't gate
}
// Refresh floor for one stream: the tab-state floor, raised to IDLE when its column is off-screen.
// Used for home (its 500/window budget is abundant); search has its own budget pacer below.
function streamFloor(type, acct, query) {
    const base = pollFloor();
    const vf = columnFraction(type, acct, query);
    return vf !== null && vf < 0.1 ? Math.max(base, IDLE_INTERVAL) : base;
}
// Every search column shares ONE rate-limit bucket (SearchTimeline: ~50 requests / 15-min window,
// read live from x-rate-limit-* headers in interceptResponseText). Pace polls to spend `remaining`
// over the time left in the window — but weighted by column order, so the leftmost (highest
// priority) visible columns get a bigger share and refresh faster than the ones further right.
const SEARCH_WINDOW = 900000; // 15 min
const SEARCH_SAFETY = 0.85;   // only pace against 85% of the bucket — leave headroom for the
                              // user's own searches (typing a query, suggestions) that share it
let searchBudget = { remaining: 50, reset: 0, limit: 50 };
function searchBudgetNow() {
    const now = Date.now();
    const { remaining, reset, limit } = searchBudget;
    if (!reset || reset <= now) return { remaining: limit, msLeft: SEARCH_WINDOW }; // unknown/expired → fresh window
    return { remaining: Math.max(1, remaining), msLeft: reset - now };
}
function searchFloor(query) {
    const target = normQuery(query);
    const cols = []; // every search column, DOM order = left→right, with how much of it is on screen
    for (const sec of document.querySelectorAll("section.column")) {
        const m = tdColumn(sec.getAttribute("data-column"));
        const sub = m && m.feedSubscriptions && Object.keys(m.feedSubscriptions)[0];
        if (!sub || sub.split(":")[2] !== "search") continue;
        cols.push({ q: normQuery(sec.querySelector(".column-title-edit-box")?.value),
                    vf: m.visibility ? m.visibility.visibleFraction : 1 });
    }
    const idx = cols.findIndex((c) => c.q === target);
    if (idx < 0) return pollFloor(); // unknown feed → fail open to the tab-state floor
    // Weight = priority (leftmost column highest) scaled by on-screen fraction. Off-screen columns
    // get ~0 weight, so they drop out of the split and hand their whole budget share to the visible
    // ones — the leftmost visible column ends up with the largest share and the shortest interval.
    const n = cols.length;
    let sumW = 0, w = 0;
    cols.forEach((c, i) => { const wi = (n - i) * c.vf; sumW += wi; if (i === idx) w = wi; });
    if (w < 0.01 || sumW <= 0) return SEARCH_WINDOW; // scrolled off → refresh on return, not on the budget
    const { remaining, msLeft } = searchBudgetNow();
    const paced = msLeft * sumW / (remaining * SEARCH_SAFETY * w);
    return Math.max(pollFloor(), Math.min(paced, SEARCH_WINDOW));
}
// Coming back to a stale tab: let the next poll of every stream through immediately instead of
// waiting out the interval (background polls were throttled or cancelled while you were away).
document.addEventListener("visibilitychange", () => {
    if (document.hidden || Date.now() < rateCoolUntil) return;
    for (const k in timings) timings[k] = 0;
});

let lastToastAt = 0;
function showToast(message, { dedupeMs = 3000, type = "error" } = {}) {
    const now = Date.now();
    if (now - lastToastAt < dedupeMs) return;
    lastToastAt = now;
    if (!document.body) return;
    const el = document.createElement("div");
    el.className = `otd-toast otd-toast-${type}`;
    el.textContent = message;
    // Shared bottom-centre stack with xlr.js's countdown pills, so concurrent notices stack instead of overprinting.
    const stack = document.querySelector(".otd-stack") || document.createElement("div");
    stack.className = "otd-stack";
    if (!stack.parentNode) document.body.appendChild(stack);
    stack.appendChild(el);
    requestAnimationFrame(() => el.classList.add("otd-toast-show"));
    setTimeout(() => {
        el.classList.remove("otd-toast-show");
        setTimeout(() => el.remove(), 300);
    }, 4000);
}

function exportState() {
	const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(OTDLayout.snapshot())], {type: 'application/json'}));
    a.download = 'OTDState.json';
    a.click();
}

function importState() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
        const file = input.files[0];
        if(!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
            let data;
            try {
                data = JSON.parse(e.target.result);
            } catch(e) {}
            if(!OTDLayout.replace(data)) return alert("Error parsing file");
            location.reload();
        };
        reader.readAsText(file);
    };
    input.click();
}

// Restore the layout from the rolling backup (see OTDLayout.backupHourly). Mirrors
// importState's write-and-reload, with a confirm because it replaces the current state.
// Stays synchronous for the bundle's onclick: injection.js already fetched the backup.
function restoreState() {
    let data = OTDLayout.backup;
    if (!data) {
        alert("No backup found yet — one is saved automatically once you've used TweetDeck.");
        return;
    }
    if (!OTDLayout.isValid(data)) {
        alert("Backup is incomplete and can't be restored.");
        return;
    }
    let when = data.savedAt ? new Date(data.savedAt).toLocaleString() : "an earlier session";
    if (!confirm(`Restore your layout from the backup saved ${when}? This replaces your current columns and settings.`)) {
        return;
    }
    OTDLayout.replace(data);
    location.reload();
}

// What the tweet adapter (src/tweet.js) saw, indexed for later: id → handle for the
// show/lookup routes, which can only resolve users by screen_name, and community notes
// by tweet id for xlr.js to draw.
const handleById = {};
const birdwatchById = {};
function parseTweet(result) {
    const adapted = adaptTweet(result, { autoExpand: localStorage.OTDenableAutoExpand === "1" });
    if (!adapted) return;
    Object.assign(handleById, adapted.facts.handles);
    Object.assign(birdwatchById, adapted.facts.notes);
    return adapted.tweet;
}

// Flatten a UserByScreenName result into the legacy v1.1 user object that
// TwitterUser.fromJSONObject (the show/lookup processor) expects.
function userResultToLegacy(result) {
    if (!result || result.__typename === "UserUnavailable" || !result.legacy) return null;
    let user = result.legacy;
    user.id_str = result.rest_id;
    user.id = +result.rest_id;
    hydrateUser(user, result);
    // fromJSONObject calls .replace on profile_image_url_https unconditionally.
    if (!user.profile_image_url_https) {
        user.profile_image_url_https = "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png";
    }
    return user;
}

const userByNameCache = {};
function fetchUserByScreenName(screen_name) {
    let key = screen_name.toLowerCase();
    if (userByNameCache[key]) return userByNameCache[key];
    let p = (async () => {
        let res = await XApi.gql("UserByScreenName", { screen_name });
        let data = await res.json();
        return userResultToLegacy(data?.data?.user?.result);
    })();
    p.catch(() => { delete userByNameCache[key]; });
    userByNameCache[key] = p;
    return p;
}

// Everything xlr.js takes from interception, on one namespace. The remote upstream
// interception (OTDalwaysUseLocalFiles = "0") doesn't set it, and xlr switches off what
// depends on it.
//   parseTweet: rebuild a quoted tweet X stripped from search/list results (muted authors)
//     into the legacy shape TweetDeck's fromJSONObject consumes
//   userByScreenName: list/mute/block-by-handle and hover cards resolve users through this
//     one UserByScreenName cache, not a second copy
//   birdwatch: community-note pivots by tweet id, drawn onto rendered tweets
window.OTD = { parseTweet, userByScreenName: fetchUserByScreenName, birdwatch: birdwatchById };

function getCurrentUserId() {
    let accounts = TD.storage.accountController.getAll();
    let screen_name = TD.storage.accountController.getUserIdentifier();
    let account = accounts.find((account) => account.state.username === screen_name);
    return account?.state?.userId ?? verifiedUser?.id_str ?? localStorage.twitterAccountID;
}

// Build the TweetDetail GraphQL URL, shared by the statuses/show routes (focal tweet only)
// and the conversation route (focal tweet + reply thread). `extra` merges in per-route
// variables such as a pagination `cursor`. Single-sources the variables set.
const tweetDetailUrl = (tweetId, extra = {}) =>
    XApi.url("TweetDetail", {
        focalTweetId: tweetId,
        with_rux_injections: false,
        includePromotedContent: false,
        withCommunity: true,
        withQuickPromoteEligibilityTweetFields: true,
        withBirdwatchNotes: true,
        withVoice: true,
        withV2Timeline: true,
        ...extra,
    });

function extractAssignedJSON(html, varName = "window.__INITIAL_STATE__") {
    const assignPos = html.indexOf(varName);
    if (assignPos === -1) {
        console.error(html);
        throw new Error(`Variable ${varName} not found`);
    }
  
    let i = assignPos + varName.length;
    while (i < html.length && /\s/.test(html[i])) i++;
    if (html[i] !== '=') {
      i = html.indexOf('=', i);
      if (i === -1) throw new Error(`Assignment for ${varName} not found`);
    }
    i++; // skip '='
    while (i < html.length && /\s/.test(html[i])) i++;
  
    const opener = html[i];
    if (opener !== '{' && opener !== '[') {
      throw new Error(`Expected JSON object/array after ${varName} = ...`);
    }
    const closer = opener === '{' ? '}' : ']';
  
    let depth = 0, inStr = false, quote = null, escaped = false;
    const start = i;
    for (; i < html.length; i++) {
      const ch = html[i];
  
      if (inStr) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === quote) {
          inStr = false;
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = true;
        quote = ch;
        continue;
      }
      if (ch === opener) depth++;
      else if (ch === closer) {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) throw new Error(`Unterminated JSON for ${varName}`);
  
    let jsonText = html.slice(start, i + 1);
  
    let j = i + 1;
    while (j < html.length && /\s/.test(html[j])) j++;
    if (html[j] === ';') j++;
  
    try {
      return JSON.parse(stripBOM(jsonText));
    } catch (e) {
      const repaired = repairCommonJSONIssues(jsonText);
      try {
        return JSON.parse(repaired);
      } catch (e2) {
        const ctx = repaired.slice(0, 1200);
        throw new Error(
          `Found assignment, but JSON.parse failed twice. First: ${e.message}. Second: ${e2.message}. ` +
          `Sample of repaired text start:\n${ctx}`
        );
      }
    }
  
    function stripBOM(s) {
      return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
    }
  
    function repairCommonJSONIssues(s) {
      s = stripBOM(s);
  
      let out = '';
      let inStr = false;
      let quote = null;
      let escaped = false;
  
      for (let k = 0; k < s.length; k++) {
        let ch = s[k];
  
        if (!inStr) {
          if (ch === '"' || ch === "'") {
            inStr = true;
            quote = ch;
            out += ch;
            continue;
          }
          out += ch;
          continue;
        }
  
        if (escaped) {
          escaped = false;
          out += ch;
          continue;
        }
        if (ch === '\\') {
          escaped = true;
          out += ch;
          continue;
        }
        if (ch === quote) {
          inStr = false;
          quote = null;
          out += ch;
          continue;
        }
  
        const code = ch.charCodeAt(0);
  
        if (code === 0x2028) { out += '\\u2028'; continue; }
        if (code === 0x2029) { out += '\\u2029'; continue; }
  
        if (code >= 0x00 && code <= 0x1F) {
          if (ch === '\n') { out += '\\n'; continue; }
          if (ch === '\r') { out += '\\r'; continue; }
          if (ch === '\t') { out += '\\t'; continue; }
          if (ch === '\b') { out += '\\b'; continue; }
          if (ch === '\f') { out += '\\f'; continue; }
          out += '\\u' + code.toString(16).padStart(4, '0');
          continue;
        }
  
        out += ch;
      }
  
      return out;
    }
}
function formatTwitterStyle(date) {
    const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  
    const day = days[date.getUTCDay()];
    const month = months[date.getUTCMonth()];
    const dayNum = String(date.getUTCDate()).padStart(2, "0");
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const mins = String(date.getUTCMinutes()).padStart(2, "0");
    const secs = String(date.getUTCSeconds()).padStart(2, "0");
    const year = date.getUTCFullYear();
  
    return `${day} ${month} ${dayNum} ${hours}:${mins}:${secs} +0000 ${year}`;
}

function emulateResponse(xhr) {
    xhr._status = xhr._status || 200;
    xhr._readyState = 4;
    xhr.responseHeaderOverride = {
        "content-type": () => "application/json"
    }
    const loadEvent = new ProgressEvent('load');
    loadEvent.lengthComputable = true;
    loadEvent.loaded = 1;
    loadEvent.total = 1;

    if(xhr.onload) xhr.onload(loadEvent);
    if(xhr.onloadend) xhr.onloadend(loadEvent);

    const readyStateEvent = new Event('readystatechange');
    if(xhr.onreadystatechange) xhr.onreadystatechange(readyStateEvent);
}

let counter = 0;
let bookmarkTimes = {};
const OriginalXHR = XMLHttpRequest;

// Pagination cursors are timeline entries whose id carries a cursor-<dir>-/sq-cursor-<dir>-
// prefix. GraphQL keeps the value on content, the v2 notifications API under
// content.operation.cursor, and a page fetched with a cursor re-sends its cursors as
// replace-entry instructions instead. Returns undefined if absent.
function findCursor(entries, direction, instructions = []) {
    const isCursor = (id) => id?.startsWith(`sq-cursor-${direction}-`) || id?.startsWith(`cursor-${direction}-`);
    const content = entries.find((e) => isCursor(e.entryId))?.content
        ?? instructions.find((i) => isCursor(i.entry_id_to_replace))?.entry?.content;
    return content?.value ?? content?.operation?.cursor?.value;
}

// Every proxied route swaps TweetDeck's headers for the modern GraphQL API's
// (JSON, public bearer, no client-version). lang defaults to "en"; a couple of
// routes pass the user's locale. Header names are case-insensitive but the XHR joins
// two spellings of one into "a, b", so drop TweetDeck's copy before setting ours.
function setApiHeaders(xhr, lang = "en") {
    const h = xhr.modReqHeaders;
    const ours = XApi.headers(lang);
    for (const k of Object.keys(h)) {
        if (k.toLowerCase() in ours || k.toLowerCase() === "x-twitter-client-version") delete h[k];
    }
    Object.assign(h, ours);
}

// Parse a route's GraphQL response, logging + returning null on malformed JSON
// so callers can fall back to their empty shape.
function parseResponse(xhr) {
    try {
        return JSON.parse(xhr.responseText);
    } catch (e) {
        console.error(e);
        return null;
    }
}

// X returns timeline tweets unsorted; newest-first is what every column wants.
function sortByDate(tweets) {
    return tweets.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

// Throttled timeline routes mark themselves cancelled in openHandler; honor that
// here by faking an empty response instead of hitting the network.
function sendOrEmulate(xhr, data) {
    if (xhr.storage.cancelled) {
        emulateResponse(xhr);
    } else {
        xhr.send(data);
    }
}

// ── Timeline paging ──
// TweetDeck pages its legacy timelines with max_id/since_id; their GraphQL replacements page
// with opaque cursors. Tweet streams pin each cursor to the tweet ids TweetDeck will echo back:
// bottom on the oldest tweet (returned as max_id+1), top on the newest two (either can come back
// as since_id). Notification streams (perTweet: false) keep one top/bottom pair.
function cursorFor(stream, params, perTweet) {
    const since_id = params.get("since_id"), max_id = params.get("max_id");
    if (since_id) return cursors[perTweet ? `${stream}-${since_id}-top` : `${stream}-top`];
    if (max_id) return cursors[perTweet ? `${stream}-${BigInt(max_id) + 1n}` : `${stream}-bottom`];
}
function recordCursors(stream, page, entries, items, perTweet) {
    const top = findCursor(entries, "top", page.instructions);
    const bottom = findCursor(entries, "bottom", page.instructions);
    if (!perTweet) {
        if (top) cursors[`${stream}-top`] = top;
        if (bottom) cursors[`${stream}-bottom`] = bottom;
    } else if (items.length) {
        if (bottom) cursors[`${stream}-${items[items.length - 1].id_str}`] = bottom;
        if (top) for (const t of items.slice(0, 2)) cursors[`${stream}-${t.id_str}-top`] = top;
    }
}
// Tweets on a GraphQL timeline page: tweet entries, plus the tweets inside the route's
// conversation modules (with home's feedback actions attached).
function timelineTweets(xhr, spec, page, entries) {
    const feedbackActions = page.responseObjects?.feedbackActions ?? [];
    const tweets = [];
    for (const e of entries) {
        if (e.entryId.startsWith("tweet-") || e.entryId.startsWith("sq-I-t-")) {
            if (e.content.itemContent?.promotedMetadata) continue;
            const tweet = parseTweet(e.content.itemContent?.tweet_results?.result);
            if (tweet) tweets.push(tweet);
        } else if (spec.conversation && e.entryId.startsWith(spec.conversation)) {
            for (const { entryId, item } of e.content.items) {
                if (!entryId.includes("-tweet-")) continue;
                const tweet = parseTweet(item.itemContent.tweet_results.result);
                if (!tweet || (spec.keepThreaded && !spec.keepThreaded(tweet, xhr))) continue;
                if (item.feedbackInfo) {
                    tweet.feedback = item.feedbackInfo.feedbackKeys
                        .map((f) => feedbackActions.find((a) => a.key === f)?.value)
                        .filter((f) => f);
                    if (tweet.feedback.length) tweet.feedbackMetadata = item.feedbackInfo.feedbackMetadata;
                }
                tweets.push(tweet);
            }
        }
    }
    return tweets;
}
const notMuted = (t) => !t.user?.muting && !t.user?.blocking;
// A timeline route is its stream key, its query and where its page lives; this owns the rest.
//   stream(params, xhr) → stream key (may stash route state on xhr.storage)
//   request(xhr, params, cursor) → sets modUrl (and storage.body when post: true)
//   timeline(data) → the page's { instructions, responseObjects }
// Optional: floor(xhr) poll gate, conversation prefix + keepThreaded(tweet, xhr), items(entries,
// data) for non-GraphQL pages, visible filter, sort: false, perTweet: false, finish(items, xhr,
// page), wrap(items, bottomCursor, xhr) response shape. Other keys pass through onto the route.
function timelineRoute(spec) {
    const { stream, request, timeline, floor, perTweet = true, sort = true, visible = notMuted, wrap = (items) => items } = spec;
    return {
        method: "GET",
        beforeSendHeaders: (xhr) => setApiHeaders(xhr),
        ...spec,
        beforeRequest: (xhr) => {
            try {
                const params = new URL(xhr.modUrl).searchParams;
                xhr.storage.stream = stream(params, xhr);
                xhr.storage.poll = params.has("since_id");
                request(xhr, params, cursorFor(xhr.storage.stream, params, perTweet));
            } catch (e) {
                console.error(e);
            }
        },
        // Polls (since_id) go out no faster than the route's floor; a throttled one is answered empty.
        openHandler: (xhr, method, url, ...rest) => {
            const key = xhr.storage.stream;
            if (floor && xhr.storage.poll && Date.now() - (timings[key] ?? 0) < floor(xhr)) {
                xhr.storage.cancelled = true;
            } else {
                xhr.open(spec.post ? "POST" : method, url, ...rest);
                timings[key] = Date.now();
            }
        },
        sendHandler: (xhr, body) => sendOrEmulate(xhr, xhr.storage.body ?? body),
        afterRequest: (xhr) => {
            if (xhr.storage.cancelled) return wrap([], null, xhr);
            try {
                const data = parseResponse(xhr);
                const page = data && timeline(data);
                const add = page?.instructions?.find((i) => i.entries || i.addEntries);
                const entries = add?.entries ?? add?.addEntries?.entries;
                if (!entries) return wrap([], null, xhr);
                const items = (spec.items ? spec.items(entries, data) : timelineTweets(xhr, spec, page, entries)).filter(visible);
                if (sort) sortByDate(items);
                recordCursors(xhr.storage.stream, page, entries, items, perTweet);
                spec.finish?.(items, xhr, page);
                return wrap(items, findCursor(entries, "bottom", page.instructions) ?? null, xhr);
            } catch (e) {
                console.error(e);
                return wrap([], null, xhr);
            }
        },
    };
}

const proxyRoutes = [
    // Home timeline
    timelineRoute({
        path: "/1.1/statuses/home_timeline.json",
        post: true, // GraphQL HomeLatestTimeline only accepts POST; the original XHR was GET.
        stream: (params, xhr) => `home-${xhr.storage.user_id = params.get("user_id") ?? getCurrentUserId()}`,
        floor: (xhr) => streamFloor("home", xhr.storage.user_id),
        request: (xhr, params, cursor) => {
            let variables = {"count":40,"enableRanking":false,"includePromotedContent":false,"requestContext":"launch","seenTweetIds":[]};
            if (cursor) variables.cursor = cursor;
            xhr.modUrl = XApi.url("HomeLatestTimeline");
            xhr.storage.body = XApi.body("HomeLatestTimeline", variables);
        },
        timeline: (data) => data.data?.home?.home_timeline_urt,
        conversation: "home-conversation-",
    }),
    // List timeline
    timelineRoute({
        path: "/1.1/lists/statuses.json",
        stream: (params) => `list-${params.get("list_id")}`,
        floor: pollFloor,
        request: (xhr, params, cursor) => {
            let variables = { count: 40, includePromotedContent: false, listId: params.get("list_id") };
            if (cursor) variables.cursor = cursor;
            xhr.modUrl = XApi.url("ListLatestTweetsTimeline", variables);
        },
        timeline: (data) => data.data?.list?.tweets_timeline?.timeline,
        conversation: "list-conversation-",
    }),
    // User timeline
    timelineRoute({
        path: "/1.1/statuses/user_timeline.json",
        stream: (params, xhr) => `user-${xhr.storage.user_id = params.get("user_id") || getCurrentUserId()}`,
        floor: pollFloor,
        request: (xhr, params, cursor) => {
            let variables = {
                userId: xhr.storage.user_id,
                count: 20,
                includePromotedContent: false,
                withCommunity: true,
                withVoice: true,
            };
            if (cursor) variables.cursor = cursor;
            xhr.modUrl = XApi.url("UserTweetsAndReplies", variables, { withArticlePlainText: false });
        },
        timeline: (data) => (data.data?.user?.result?.timeline ?? data.data?.user?.result?.timeline_v2)?.timeline,
        // Reply threads carry other people's tweets; the profile column only shows the user's own.
        conversation: "profile-conversation-",
        keepThreaded: (tweet, xhr) => tweet.user.id_str === xhr.storage.user_id,
        // Slot the pinned tweet in where its date puts it, unless that's past the end of the page.
        finish: (tweets, xhr, page) => {
            let pinEntry = page.instructions.find((e) => e.type === "TimelinePinEntry");
            let pinnedTweet = parseTweet(pinEntry?.entry?.content?.itemContent?.tweet_results?.result);
            if (!pinnedTweet) return;
            let time = new Date(pinnedTweet.created_at).getTime();
            let index = tweets.findIndex((t) => new Date(t.created_at).getTime() < time);
            if (index !== -1) tweets.splice(index, 0, pinnedTweet);
        },
    }),
    // Bookmarks timeline
    timelineRoute({
        path: "/1.1/statuses/bookmarks.json",
        stream: () => "bookmarks",
        request: (xhr, params, cursor) => {
            let variables = {
                "count": 40,
                "includePromotedContent":false
            };
            if (cursor) variables.cursor = cursor;
            let max_id = params.get("max_id");
            if (max_id) xhr.storage.time = bookmarkTimes[BigInt(max_id) + 1n];
            xhr.modUrl = XApi.url("Bookmarks", variables);
        },
        timeline: (data) => data.data?.bookmark_timeline_v2?.timeline,
        // Bookmarks keep bookmark order: each gets a receive time just below the previous one.
        sort: false,
        finish: (tweets, xhr) => {
            for(let i = 0; i < tweets.length; i++) {
                const tweet = tweets[i];
                tweet.receiveTime = bookmarkTimes[tweet.id_str] ?? ((xhr.storage.time ?? Date.now()) - i);
                bookmarkTimes[tweet.id_str] = tweet.receiveTime;
            }
        },
        // artificially slow down, because theres an invisible rate limit that gets hit after a few hours
        responseHeaderOverride: {
            "x-rate-limit-limit": (value) => {
                return Math.floor(+value/5);
            },
            "x-rate-limit-remaining": (value) => {
                return Math.floor(+value/5);
            },
        },
    }),
    // Notifications column
    timelineRoute({
        path: "/1.1/activity/about_me.json",
        stream: (params) => `notifications-${params.get("user_id") ?? getCurrentUserId()}`,
        request: (xhr, params, cursor) => {
            xhr.modUrl = `https://${location.hostname}/i/api/2/notifications/all.json?include_profile_interstitial_type=1&include_blocking=1&include_blocked_by=1&include_followed_by=1&include_want_retweets=1&include_mute_edge=1&include_can_dm=1&include_can_media_tag=1&include_ext_has_nft_avatar=1&include_ext_is_blue_verified=1&include_ext_verified_type=1&include_ext_profile_image_shape=1&skip_status=1&cards_platform=Web-12&include_cards=1&include_ext_alt_text=true&include_ext_limited_action_results=true&include_quote_count=true&include_reply_count=1&tweet_mode=extended&include_ext_views=true&include_entities=true&include_user_entities=true&include_ext_media_color=true&include_ext_media_availability=true&include_ext_sensitive_media_warning=true&include_ext_trusted_friends_metadata=true&send_error_codes=true&simple_quoted_tweet=true&count=20&requestContext=launch&ext=mediaStats%2ChighlightedLabel%2ChasNftAvatar%2CvoiceInfo%2CbirdwatchPivot%2CsuperFollowMetadata%2CunmentionInfo%2CeditControl${cursor ? `&cursor=${cursor}` : ''}`;
        },
        beforeSendHeaders: (xhr) => setApiHeaders(xhr, navigator.language.split("-")[0]),
        timeline: (data) => data.timeline,
        perTweet: false,
        sort: false,
        visible: (n) => !n.sources.some((u) => u?.muting || u?.blocking),
        items: (entries, data) => {
            const go = data.globalObjects;
            const notifications = [];
            for(let entry of entries) {
                try {
                    if(entry.entryId.startsWith("notification-")) {
                        const sortIndex = entry.sortIndex;
                        const item = entry.content.item;
                        const type = item.clientEventInfo.element;
                        const notif = item.content.notification;

                        switch(type) {
                            case "users_retweeted_your_retweet":
                            case "users_retweeted_your_tweet":
                            case "user_liked_multiple_tweets": 
                            case "users_liked_your_retweet":
                            case "users_liked_your_tweet": {
                                const nf = go.notifications[notif.id];
                                const actions = nf.template.aggregateUserActionsV1;
                                const users = actions.fromUsers.map(u => u.user.id);
                                const tweets = actions.targetObjects.map(t => t.tweet.id);
                                let i = 0;
                                for(const userId of users) {
                                    for(const tweetId of tweets) {
                                        const tweet = go.tweets[tweetId];
                                        const user = go.users[userId];
                                        const action = type === "users_retweeted_your_tweet" || type === "users_retweeted_your_retweet" ? "retweet" : "favorite";
                                        if(!tweet || !user) continue;
                                        const id = `${tweetId}-${userId}-${action}`;
                                        if(seenNotifications.includes(id)) continue;
                                        seenNotifications.push(id);
                                        const notifSortIndex = +sortIndex - (i++);
                                        tweet.user = go.users[tweet.user_id_str];
                                        if(tweet.quoted_status_id_str) {
                                            tweet.quoted_status = go.tweets[tweet.quoted_status_id_str];
                                            tweet.quoted_status.user = go.users[tweet.quoted_status.user_id_str];
                                        }

                                        const sources = [user];
                                        const targets = [tweet];
                                        const target_objects = [tweet];
                                        notifications.push({
                                            action,
                                            created_at: formatTwitterStyle(new Date(notifSortIndex)),
                                            max_position: notifSortIndex+"",
                                            min_position: notifSortIndex+"",
                                            sources,
                                            sources_size: sources.length,
                                            target_objects,
                                            target_objects_size: target_objects.length,
                                            targets,
                                            targets_size: targets.length,
                                        })
                                    }
                                }
                                break;
                            }
                            case "user_mentioned_you":
                            case "user_replied_to_your_tweet": 
                            case "user_quoted_your_tweet":{
                                const tweetId = item.content.tweet.id;
                                const tweet = go.tweets[tweetId];
                                if(!tweet) continue;
                                tweet.user = go.users[tweet.user_id_str];
                                const type = item.clientEventInfo.element === "user_mentioned_you" ? "mention" : item.clientEventInfo.element === "user_replied_to_your_tweet" ? "reply" : "quote";
                                
                                const id = `${tweetId}-${tweet.user_id_str}-${type}`;
                                if(seenNotifications.includes(id)) continue;
                                seenNotifications.push(id);

                                if(tweet.quoted_status_id_str) {
                                    tweet.quoted_status = go.tweets[tweet.quoted_status_id_str];
                                    tweet.quoted_status.user = go.users[tweet.quoted_status.user_id_str];
                                }
                                
                                notifications.push({
                                    action: type,
                                    created_at: formatTwitterStyle(new Date(+sortIndex)),
                                    max_position: sortIndex+"",
                                    min_position: sortIndex+"",
                                    sources: [tweet.user],
                                    sources_size: 1,
                                    target_objects: [tweet],
                                    target_objects_size: 1,
                                    targets: [tweet],
                                    targets_size: 1,
                                });
                                break;
                            }
                            case "follow_from_recommended_user":
                            case "users_followed_you": {
                                const nf = go.notifications[notif.id];
                                const users = nf.template.aggregateUserActionsV1.fromUsers.map(u => u.user.id);
                                for(const userId of users) {
                                    const user = go.users[userId];
                                    if(!user) continue;
                                    const id = `${userId}-follow`;
                                    if(seenNotifications.includes(id)) continue;
                                    seenNotifications.push(id);
                                    notifications.push({
                                        action: "follow",
                                        created_at: formatTwitterStyle(new Date(+sortIndex)),
                                        max_position: sortIndex+"",
                                        min_position: sortIndex+"",
                                        sources: [user],
                                        sources_size: 1,
                                        target_objects: [user],
                                        target_objects_size: 1,
                                        targets: [user],
                                        targets_size: 1
                                    });
                                }
                                break;
                            }
                            case "generic_login_notification":
                            case "generic_acid_notification":
                            case "generic_safety_label_added":
                                break;
                            default:
                                console.warn(`Unknown notification type: ${type}`);
                        }
                    }
                } catch (e) {
                    console.error(`Error parsing notification`, JSON.stringify(entry));
                }
            }
            return notifications;
        },
    }),
    // Mentions timeline
    timelineRoute({
        path: "/1.1/statuses/mentions_timeline.json",
        stream: (params) => `mentions-${params.get("user_id") ?? getCurrentUserId()}`,
        request: (xhr, params, cursor) => {
            xhr.modUrl = `https://${location.hostname}/i/api/2/notifications/mentions.json?include_profile_interstitial_type=1&include_blocking=1&include_blocked_by=1&include_followed_by=1&include_want_retweets=1&include_mute_edge=1&include_can_dm=1&include_can_media_tag=1&include_ext_has_nft_avatar=1&include_ext_is_blue_verified=1&include_ext_verified_type=1&include_ext_profile_image_shape=1&skip_status=1&cards_platform=Web-12&include_cards=1&include_ext_alt_text=true&include_ext_limited_action_results=true&include_quote_count=true&include_reply_count=1&tweet_mode=extended&include_ext_views=true&include_entities=true&include_user_entities=true&include_ext_media_color=true&include_ext_media_availability=true&include_ext_sensitive_media_warning=true&include_ext_trusted_friends_metadata=true&send_error_codes=true&simple_quoted_tweet=true&count=20&requestContext=launch&ext=mediaStats%2ChighlightedLabel%2ChasNftAvatar%2CvoiceInfo%2CbirdwatchPivot%2CsuperFollowMetadata%2CunmentionInfo%2CeditControl${cursor ? `&cursor=${cursor}` : ''}`;
        },
        timeline: (data) => data.timeline,
        perTweet: false,
        sort: false,
        items: (entries, data) => {
            const go = data.globalObjects;
            const tweets = [];
            for(let entry of entries) {
                if(!entry.entryId.startsWith("notification-")) continue;
                const item = entry.content.item;
                switch(item.clientEventInfo.element) {
                    case "user_mentioned_you":
                    case "user_replied_to_your_tweet": 
                    case "user_quoted_your_tweet":{
                        const tweet = go.tweets[item.content.tweet.id];
                        if(!tweet) continue;
                        tweet.user = go.users[tweet.user_id_str];

                        if(tweet.quoted_status_id_str) {
                            tweet.quoted_status = go.tweets[tweet.quoted_status_id_str];
                            tweet.quoted_status.user = go.users[tweet.quoted_status.user_id_str];
                        }
                        
                        tweets.push(tweet);
                        break;
                    }
                }
            }
            return tweets;
        },
    }),
    // User likes timeline
    timelineRoute({
        path: "/1.1/favorites/list.json",
        stream: (params, xhr) => `likes-${xhr.storage.user_id = params.get("user_id") ?? getCurrentUserId()}`,
        request: (xhr, params, cursor) => {
            let variables = {
                "userId": xhr.storage.user_id,
                "count": 50,
                "includePromotedContent": false,
                "withSuperFollowsUserFields": true,
                "withDownvotePerspective": false,
                "withReactionsMetadata": false,
                "withReactionsPerspective": false,
                "withSuperFollowsTweetFields": true,
                "withClientEventToken": false,
                "withBirdwatchNotes": false,
                "withVoice": true,
                "withV2Timeline": true
            };
            if (cursor) variables.cursor = cursor;
            xhr.modUrl = XApi.url("Likes", variables);
        },
        timeline: (data) => (data.data?.user?.result?.timeline ?? data.data?.user?.result?.timeline_v2)?.timeline,
    }),
    // Liking / unliking
    {
        path: /\/1\.1\/favorites\/.*\.json/,
        method: "POST",
        beforeRequest: (xhr) => {
            const isFavorite = xhr.modUrl.includes("create.json");
            xhr.storage.isFavorite = isFavorite;

            xhr.modUrl = XApi.url(isFavorite ? "FavoriteTweet" : "UnfavoriteTweet");
        },
        sendHandler: (xhr, data) => {
            const tweet_id = new URLSearchParams(data).get("id");
            xhr.send(XApi.body(xhr.storage.isFavorite ? "FavoriteTweet" : "UnfavoriteTweet", { tweet_id }));
        },
        beforeSendHeaders: (xhr) => setApiHeaders(xhr),
        afterRequest: (xhr) => {
            return {};
        },
    },
    // Collections
    {
        path: /\/1\.1\/collections\/.*\.json/,
        method: "GET",
        openHandler: () => {},
        sendHandler: emulateResponse,
        afterRequest: (xhr) => {
            xhr._status = 404;
            return "";
        },
    },
    {
        path: /\/1\.1\/collections\/.*\.json/,
        method: "POST",
        openHandler: () => {},
        sendHandler: emulateResponse,
        afterRequest: (xhr) => {
            xhr._status = 404;
            return "";
        },
    },
    // User profile — resolve through UserByScreenName (see fetchUserByScreenName).
    // Mentions hit this with screen_name; the rare user_id form maps via handleById.
    {
        path: "/1.1/users/show.json",
        method: "GET",
        openHandler: () => {},
        sendHandler: async (xhr) => {
            let status = 200, body;
            try {
                let params = new URLSearchParams(new URL(xhr.originalUrl).search);
                let screen_name = params.get("screen_name") || handleById[params.get("user_id")];
                let user = screen_name ? await fetchUserByScreenName(screen_name) : null;
                if (user) {
                    body = JSON.stringify(user);
                } else {
                    status = 404;
                    body = JSON.stringify({ errors: [{ code: 50, message: "User not found." }] });
                }
            } catch (e) {
                console.error("OTD users/show.json", e);
                status = 500;
                body = JSON.stringify({ errors: [{ code: 131, message: "Sorry, an error occurred." }] });
            }
            xhr._responseText = body;
            xhr._status = status;
            emulateResponse(xhr);
        },
    },
    // Reply-prefix "Replying to @x" links resolve recipients via users/lookup.json
    // (POST, comma-joined ids). Map each id back to a handle harvested from parsed
    // tweets, then resolve the lot through UserByScreenName.
    {
        path: "/1.1/users/lookup.json",
        method: "POST",
        openHandler: () => {},
        sendHandler: async (xhr, body) => {
            let users = [];
            try {
                let raw = new URLSearchParams(body || "").get("user_id")
                    || new URLSearchParams(new URL(xhr.originalUrl).search).get("user_id") || "";
                let names = raw.split(",").map((id) => handleById[id.trim()]).filter(Boolean);
                let resolved = await Promise.all(names.map((n) => fetchUserByScreenName(n).catch(() => null)));
                users = resolved.filter(Boolean);
            } catch (e) {
                console.error("OTD users/lookup.json", e);
            }
            xhr._responseText = JSON.stringify(users);
            emulateResponse(xhr);
        },
    },
    // Search
    timelineRoute({
        path: "/1.1/search/universal.json",
        // TweetDeck pages search with since_id:/max_id: operators inside q, which SearchTimeline
        // understands natively; lift them into params so the poll gate, stream key and pacer see
        // the bare column query, and send q through untouched.
        stream: (params, xhr) => {
            xhr.storage.query = params.get("q").replace(/\s*\b(since_id|max_id):(\d+)/g, (_, op, id) => (params.set(op, id), "")).trim();
            return `search-${xhr.storage.query}`;
        },
        floor: (xhr) => searchFloor(xhr.storage.query),
        request: (xhr, params) => {
            let variables = {
                rawQuery: params.get("q"),
                count: 20,
                querySource: "typed_query",
                product: "Latest",
                withGrokTranslatedBio: false,
                withQuickPromoteEligibilityTweetFields: false,
            };
            xhr.modUrl = XApi.url("SearchTimeline", variables);
        },
        timeline: (data) => data.data?.search_by_raw_query?.search_timeline?.timeline,
        wrap: (tweets, cursor, xhr) => ({
            metadata: { cursor, refresh_interval_in_sec: searchPollHint(xhr.storage.query) },
            modules: tweets.map((t) => ({ status: { data: t } })),
        }),
    }),
    // User search
    {
        path: "/1.1/users/search.json",
        method: "GET",
        beforeRequest: (xhr) => {
            try {
                let url = new URL(xhr.modUrl);
                let params = new URLSearchParams(url.search);
                let variables = {
                    rawQuery: params.get("q"),
                    count: 20,
                    querySource: "typed_query",
                    product: "People",
                };

                xhr.modUrl = XApi.url("PeopleSearch", variables);
            } catch (e) {
                console.error(e);
            }
        },
        beforeSendHeaders: (xhr) => setApiHeaders(xhr),
        afterRequest: (xhr) => {
            let data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                console.warn("User search response unparseable", { status: xhr.status, body: xhr.responseText?.slice(0, 200) }, e);
                return [];
            }
            if (data.errors && data.errors[0]) {
                return [];
            }
            let instructions = data.data.search_by_raw_query.search_timeline.timeline.instructions;
            let entries = instructions.find((i) => i.entries);
            if (!entries) {
                return [];
            }
            entries = entries.entries;
            let res = [];
            for (let entry of entries) {
                if (entry.entryId.startsWith("sq-I-u-") || entry.entryId.startsWith("user-")) {
                    let result = entry.content.itemContent.user_results.result;
                    if (!result || !result.legacy) {
                        console.log("Bug: no user", entry);
                        continue;
                    }
                    let user = result.legacy;
                    user.id_str = result.rest_id;
                    res.push(user);
                }
            }
            let cursor = findCursor(entries, "bottom");
            if (!cursor) {
                cursor = instructions.find(
                    (e) =>
                        e.entry_id_to_replace &&
                        (e.entry_id_to_replace.startsWith("sq-cursor-bottom-") ||
                            e.entry_id_to_replace.startsWith("cursor-bottom-"))
                );
                if (cursor) {
                    cursor = cursor.entry.content.value;
                } else {
                    cursor = null;
                }
            }

            return res;
        },
    },
    // Tweet creation
    {
        path: "/1.1/statuses/update.json",
        method: "POST",
        beforeRequest: (xhr) => {
            xhr.modUrl = XApi.url("CreateTweet");
        },
        beforeSendHeaders: (xhr) => setApiHeaders(xhr),
        beforeSendBody: (xhr, body) => {
            let params = Object.fromEntries(new URLSearchParams(body));
            let variables = {
                tweet_text: params.status,
                media: {
                    media_entities: [],
                    possibly_sensitive: false,
                },
                semantic_annotation_ids: [],
                dark_request: false,
            };
            if (params.in_reply_to_status_id) {
                variables.reply = {
                    in_reply_to_tweet_id: params.in_reply_to_status_id,
                    exclude_reply_user_ids: [],
                };
                if (params.exclude_reply_user_ids) {
                    variables.reply.exclude_reply_user_ids =
                        params.exclude_reply_user_ids.split(",");
                }
            }
            if (params.media_ids) {
                variables.media.media_entities = params.media_ids
                    .split(",")
                    .map((id) => ({ media_id: id, tagged_users: [] }));
            }
            if (params.attachment_url) {
                variables.attachment_url = params.attachment_url;
            }

            return XApi.body("CreateTweet", variables);
        },
        afterRequest: (xhr) => {
            let data = parseResponse(xhr);
            if (!data) return {};
            if (data.errors && data.errors[0]) {
                return {};
            }
            let tweet = parseTweet(data.data.create_tweet.tweet_results.result);
            return tweet;
        },
    },
    // Retweeting
    {
        path: /\/1.1\/statuses\/retweet\/(\d+).json/,
        method: "POST",
        beforeRequest: (xhr) => {
            let originalUrl = new URL(xhr.originalUrl);
            xhr.storage.tweet_id = originalUrl.pathname.match(
                /\/1.1\/statuses\/retweet\/(\d+).json/
            )[1];
            xhr.storage.retweeter = getCurrentUserId();
            xhr.modUrl = XApi.url("CreateRetweet");
        },
        beforeSendHeaders: (xhr) => {
            setApiHeaders(xhr);
            if (xhr.modReqHeaders["x-act-as-user-id"]) {
                xhr.storage.retweeter = xhr.modReqHeaders["x-act-as-user-id"];
            }
        },
        beforeSendBody: (xhr, body) => {
            return XApi.body("CreateRetweet", { tweet_id: xhr.storage.tweet_id, dark_request: false });
        },
        afterRequest: (xhr) => {
            let data = parseResponse(xhr);
            if (!data) return {};
            if (data.errors && data.errors[0]) {
                return {};
            }
            let res = data.data.create_retweet.retweet_results.result;
            let tweet = res.legacy;
            tweet.id_str = res.rest_id;
            if (!tweet.user) {
                tweet.user = {
                    id_str: xhr.storage.retweeter,
                };
            }
            return tweet;
        },
    },
    // Unretweeting
    {
        path: /\/1.1\/statuses\/unretweet\/(\d+).json/,
        method: "POST",
        beforeRequest: (xhr) => {
            let originalUrl = new URL(xhr.originalUrl);
            xhr.storage.tweet_id = originalUrl.pathname.match(
                /\/1.1\/statuses\/unretweet\/(\d+).json/
            )[1];
            xhr.storage.retweeter = getCurrentUserId();
            xhr.modUrl = XApi.url("DeleteRetweet");
        },
        beforeSendHeaders: (xhr) => {
            setApiHeaders(xhr);
            if (xhr.modReqHeaders["x-act-as-user-id"]) {
                xhr.storage.retweeter = xhr.modReqHeaders["x-act-as-user-id"];
            }
        },
        beforeSendBody: (xhr, body) => {
            return XApi.body("DeleteRetweet", { source_tweet_id: xhr.storage.tweet_id, dark_request: false });
        },
        afterRequest: (xhr) => {
            let data = parseResponse(xhr);
            if (!data) return {};
            if (data.errors && data.errors[0]) {
                return {};
            }
            let res = data.data.unretweet.source_tweet_results.result;
            let tweet = res.legacy;
            tweet.id_str = res.rest_id;
            if (!tweet.user) {
                tweet.user = {
                    id_str: xhr.storage.retweeter,
                };
            }
            return tweet;
        },
    },
    // Getting tweet details
    {
        path: /\/1.1\/statuses\/show\/(\d+).json/,
        method: "GET",
        beforeRequest: (xhr) => {
            let originalUrl = new URL(xhr.originalUrl);
            xhr.storage.tweet_id = originalUrl.pathname.match(
                /\/1.1\/statuses\/show\/(\d+).json/
            )[1];
            xhr.modUrl = tweetDetailUrl(xhr.storage.tweet_id);
        },
        beforeSendHeaders: (xhr) => setApiHeaders(xhr),
        afterRequest: (xhr) => {
            let data = parseResponse(xhr);
            if (!data) return {};
            if (data.errors && data.errors[0]) {
                return {};
            }
            let ic = data.data.threaded_conversation_with_injections_v2.instructions
                .find((i) => i.type === "TimelineAddEntries")
                .entries.find((e) => e.entryId === `tweet-${xhr.storage.tweet_id}`)
                .content.itemContent;
            let res = ic.tweet_results.result;
            let tweet = parseTweet(res);
            return tweet;
        },
    },
    {
        path: "/1.1/statuses/show.json",
        method: "GET",
        beforeRequest: (xhr) => {
            let originalUrl = new URL(xhr.originalUrl);
            xhr.storage.tweet_id = originalUrl.searchParams.get("id");
            xhr.modUrl = tweetDetailUrl(xhr.storage.tweet_id);
        },
        beforeSendHeaders: (xhr) => setApiHeaders(xhr),
        afterRequest: (xhr) => {
            let data = parseResponse(xhr);
            if (!data) return {};
            if (data.errors && data.errors[0]) {
                return {};
            }
            let ic = data.data.threaded_conversation_with_injections_v2.instructions
                .find((i) => i.type === "TimelineAddEntries")
                .entries.find((e) => e.entryId === `tweet-${xhr.storage.tweet_id}`)
                .content.itemContent;
            let res = ic.tweet_results.result;
            let tweet = parseTweet(res);
            return tweet;
        },
    },
    // Tweet deletion
    {
        path: /\/1.1\/statuses\/destroy\/(\d+).json/,
        method: "POST",
        beforeRequest: (xhr) => {
            let originalUrl = new URL(xhr.originalUrl);
            xhr.storage.tweet_id = originalUrl.pathname.match(
                /\/1.1\/statuses\/destroy\/(\d+).json/
            )[1];
            xhr.modUrl = XApi.url("DeleteTweet");
        },
        beforeSendHeaders: (xhr) => setApiHeaders(xhr),
        beforeSendBody: (xhr, body) => {
            return XApi.body("DeleteTweet", { tweet_id: xhr.storage.tweet_id, dark_request: false });
        },
    },
    // Tweet replies
    {
        path: /\/2\/timeline\/conversation\/(\d+).json/,
        method: "GET",
        // Route the conversation/detail fetch at GraphQL TweetDetail instead of the legacy
        // endpoint. TweetDetail returns the full longform (note_tweet) text for the focal
        // tweet AND the whole reply thread in one request, so the detail view renders the
        // complete text on first paint — no truncation, no "Expand tweet" round-trip.
        // afterRequest rebuilds the legacy globalObjects + timeline.instructions shape that
        // TwitterClient.processTimeline/getConversation consume.
        beforeRequest: (xhr) => {
            let originalUrl = new URL(xhr.originalUrl);
            xhr.storage.tweet_id = originalUrl.pathname.match(
                /\/2\/timeline\/conversation\/(\d+).json/
            )[1];
            // Preserve "load more replies" pagination: TweetDeck sends back the cursor we
            // emitted below, and we forward it straight to TweetDetail (also a GraphQL cursor).
            let cursor = originalUrl.searchParams.get("cursor");
            xhr.modUrl = tweetDetailUrl(xhr.storage.tweet_id, cursor ? { cursor } : {});
        },
        beforeSendHeaders: (xhr) => setApiHeaders(xhr),
        afterRequest: (xhr) => {
            // Wrap parsed tweets + entries in the legacy globalObjects shape that
            // processTimeline/getConversation consume. Each chirp's author is resolved from
            // globalObjects.users[user_id_str] (the legacy v2-timeline join), NOT the embedded
            // `.user` parseTweet attaches — so the users map must carry every parsed author or
            // getMainTweet()/render hit a null user.
            let conversation = (tweets, users, entries) => ({
                globalObjects: { tweets, users },
                timeline: {
                    id: `Conversation-${xhr.storage.tweet_id}`,
                    instructions: [{ addEntries: { entries } }, { terminateTimeline: { direction: "Top" } }],
                    responseObjects: { feedbackActions: {}, immediateReactions: {} },
                },
            });
            let data = parseResponse(xhr);
            if (!data) return conversation({}, {}, []);
            if (data.errors && data.errors[0]) {
                return conversation({}, {}, []);
            }

            let tweets = {};
            let users = {};
            // parseTweet builds the legacy chirp (note-tweet text already expanded) that
            // processTimeline feeds to TwitterStatus.fromJSONObject. Key it by id_str — the
            // string id the entries reference and that fromJSONObject uses for chirp.id. Register
            // the parsed author (plus any quoted/retweeted authors) into the user map keyed by
            // user_id_str, the id the chirp resolves its user through.
            let addTweet = (ic) => {
                // Ads Twitter slots in among the replies (promoted tweets, e.g. "Attio") aren't part of it.
                if (ic?.promotedMetadata) return null;
                let parsed = parseTweet(ic?.tweet_results?.result);
                if (!parsed || !parsed.id_str) return null;
                tweets[parsed.id_str] = parsed;
                if (parsed.user && parsed.user_id_str) users[parsed.user_id_str] = parsed.user;
                if (parsed.quoted_status?.user && parsed.quoted_status.user_id_str)
                    users[parsed.quoted_status.user_id_str] = parsed.quoted_status.user;
                if (parsed.retweeted_status?.user && parsed.retweeted_status.user_id_str)
                    users[parsed.retweeted_status.user_id_str] = parsed.retweeted_status.user;
                return parsed.id_str;
            };

            let instr = (data.data?.threaded_conversation_with_injections_v2?.instructions || []).find(
                (i) => i.type === "TimelineAddEntries"
            );
            let entries = [];
            for (let entry of (instr ? instr.entries : [])) {
                let content = entry.content;
                let type = content?.entryType;
                // Skip the "Discover more" injection: tweets "sourced from across X" that aren't
                // part of this conversation. Twitter tags the module and every item inside it
                // with a RelatedTweet conversationSection.
                if (content?.clientEventInfo?.details?.conversationDetails?.conversationSection === "RelatedTweet")
                    continue;
                if (type === "TimelineTimelineItem") {
                    // Focal tweet, or an ancestor in the reply chain above it.
                    let ic = content.itemContent;
                    let id = addTweet(ic);
                    if (!id) continue;
                    entries.push({
                        entryId: `tweet-${id}`,
                        sortIndex: entry.sortIndex,
                        content: { item: { content: { tweet: { id, displayType: ic.tweetDisplayType || "Tweet", hasModeratedReplies: false } } } },
                    });
                } else if (type === "TimelineTimelineModule") {
                    // A reply thread: a single reply, or a self-thread of several tweets.
                    let components = [];
                    for (let item of (content.items || [])) {
                        let ic = item.item?.itemContent;
                        let id = addTweet(ic);
                        if (!id) continue;
                        components.push({ conversationTweetComponent: { tweet: { id, displayType: ic.tweetDisplayType || "Tweet" } } });
                    }
                    if (!components.length) continue;
                    // Legacy entryId uses a capital T; getConversation matches includes("conversationThread-").
                    let tid = entry.entryId.replace(/^conversationthread-/, "");
                    entries.push({
                        entryId: `conversationThread-${tid}`,
                        sortIndex: entry.sortIndex,
                        content: { item: { content: { conversationThread: { conversationComponents: components } } } },
                    });
                } else if (type === "TimelineTimelineCursor") {
                    entries.push({
                        entryId: entry.entryId,
                        sortIndex: entry.sortIndex,
                        content: { operation: { cursor: { value: content.value, cursorType: content.cursorType } } },
                    });
                }
            }

            // Rank the replies by likes, newest first on ties (ids are time-ordered), keeping the author's
            // own self-thread continuation on top. getConversation renders entries in array order, so the
            // threads are dealt back into the slots they held: ancestors, focal tweet and cursors stay put.
            let rank = (e) => {
                let { id, displayType } = e.content.item.content.conversationThread.conversationComponents[0].conversationTweetComponent.tweet;
                return { self: displayType === "SelfThread", likes: tweets[id].favorite_count, id: tweets[id].id };
            };
            let slots = entries.flatMap((e, i) => (e.entryId.startsWith("conversationThread-") ? [i] : []));
            slots
                .map((i) => entries[i])
                .sort((a, b) => {
                    let [x, y] = [rank(a), rank(b)];
                    return y.self - x.self || y.likes - x.likes || y.id - x.id;
                })
                .forEach((e, k) => (entries[slots[k]] = e));

            return conversation(tweets, users, entries);
        },
    },
    // getting user
    {
        path: "/1.1/account/verify_credentials.json",
        method: "GET",
        beforeRequest: (xhr) => {
            // xhr.modUrl = `https://x.com/home/`;
        },
        beforeSendHeaders: (xhr) => {
            xhr.storage.user_id = xhr.modReqHeaders["x-act-as-user-id"];
            setApiHeaders(xhr);
        },
        afterRequest: (xhr) => {
            const data = JSON.parse(xhr.responseText);
            try {
                if(!xhr.storage.user_id && !data.errors) {
                    localStorage.OTDverifiedUser = JSON.stringify(data);
                    verifiedUser = data;
                } 
            } catch (e) {
                console.error('error parsing verified user', e);
            }
            return data;
        },
        // afterRequest: (xhr) => {
        //     try {
        //         const state = extractAssignedJSON(xhr.responseText);
        //         const user_id = state.session.user_id;
        //         const user = state.entities.users.entities[user_id];
        //         if(!user) {
        //             console.error(`User not found: ${JSON.stringify(state)}`);
        //             if(localStorage.OTDverifiedUser) {
        //                 try {
        //                     verifiedUser = JSON.parse(localStorage.OTDverifiedUser);
        //                     console.warn("Using verified user from localStorage");
        //                     return verifiedUser;
        //                 } catch (e) {}
        //             }
        //             throw new Error('User not found');
        //         }
        //         verifiedUser = user;
        //         localStorage.OTDverifiedUser = JSON.stringify(user);
        //         return user;
        //     } catch (e) {
        //         console.error(`Failed to get user data`, e);
        //         return null;
        //     }
        // }
    },
    // DM messages
    {
        path: /\/1.1\/dm\/conversation\/(\d+)-(\d+).json/,
        method: "GET",
        afterRequest: (xhr) => {
            return xhr.responseText.replaceAll("\\/\\/ton.twitter.com\\/1.1", "\\/\\/ton.x.com\\/i");
        }
    },
    // Inbox
    {
        path: "/1.1/dm/user_updates.json",
        method: "GET",
        afterRequest: (xhr) => {
            return xhr.responseText.replaceAll("\\/\\/ton.twitter.com\\/1.1", "\\/\\/ton.x.com\\/i");
        }
    },
    // Translating tweets
    {
        path: "/1.1/translations/show.json",
        method: "GET",
        beforeRequest: (xhr) => {
            let url = new URL(xhr.modUrl);
            let params = new URLSearchParams(url.search);
            let tweet_id = params.get("id");
            let dest = params.get("dest");
            xhr.modUrl = `https://${location.hostname}/i/api/1.1/strato/column/None/tweetId=${tweet_id},destinationLanguage=None,translationSource=Some(Google),feature=None,timeout=None,onlyCached=None/translation/service/translateTweet`;
        },
        beforeSendHeaders: (xhr) => setApiHeaders(xhr, navigator.language.split("-")[0]),
        afterRequest: (xhr) => {
            const response = JSON.parse(xhr.responseText);

            return JSON.stringify({
                text: response.translation,
                entities: response.entities,
                translated_lang: response.sourceLanguage,
            });
        }
    },

    // TweetDeck state
    {
        path: "/1.1/tweetdeck/clients/blackbird/all",
        method: "GET",
        openHandler: () => {},
        sendHandler: emulateResponse,
        afterRequest: (xhr) => {
            // verifiedUser may be unset if verify_credentials raced or errored this
            // session; fall back to the persisted account id so the state bootstrap
            // never throws — a throw here aborts the load and wipes the saved layout.
            const accountId = verifiedUser?.id_str ?? localStorage.twitterAccountID;
            OTDLayout.prune();
            const layout = OTDLayout.get();
            const state = {
                client: {
                    columns: layout.columnIds,
                    mtime: new Date().toISOString(),
                    name: "blackbird",
                    settings: OTDLayout.ensureSettings({
                        account_whitelist: [`twitter:${accountId}`],
                        default_account: `twitter:${accountId}`,
                        recent_searches: [],
                        display_sensitive_media: false,
                        name_cache: {
                            customTimelines: {},
                            lists: {},
                            users: {}
                        },
                        navbar_width: "full-size",
                        previous_splash_version: "4.0.220811153004",
                        show_search_filter_callout: false,
                        show_trends_filter_callout: false,
                        theme: "light",
                        use_narrow_columns: null,
                        version: 2
                    }),
                },
                columns: layout.columns,
                decider: {},
                feeds: layout.feeds,
                messages: [],
                new: true
            };
            console.log('account state', state);

            return state;
        },
    },
    // emulate sending state data
    {
        path: "/1.1/tweetdeck/clients/blackbird",
        method: "POST",
        responseHeaderOverride: {
            "x-td-mtime": () => {
                return new Date().toISOString();
            },
        },
        openHandler: () => {},
        sendHandler: emulateResponse,
        beforeSendBody: (xhr, body) => {
            let json = JSON.parse(body);
            console.log('state push', json);
            OTDLayout.setColumnIds(json.columns);
            if(json.settings) OTDLayout.mergeSettings(json.settings);
            OTDLayout.prune();
            return body;
        },
        afterRequest: (xhr) => {
            return "";
        }
    },
    // emulate sending feeds
    {
        path: "/1.1/tweetdeck/feeds",
        method: "POST",
        responseHeaderOverride: {
            "X-Td-Mtime": () => {
                return new Date().toISOString();
            },
        },
        openHandler: () => {},
        sendHandler: emulateResponse,
        beforeSendBody: (xhr, body) => {
            let json = JSON.parse(body);
            let ids = OTDLayout.putFeeds(json);
            xhr.storage.ids = ids;
            console.log('feeds push', json, ids);
            return body;
        },
        afterRequest: (xhr) => {
            return xhr.storage.ids;
        }
    },
    // emulate sending columns
    {
        path: "/1.1/tweetdeck/columns",
        method: "POST",
        responseHeaderOverride: {
            "X-Td-Mtime": () => {
                return new Date().toISOString();
            },
        },
        openHandler: () => {},
        sendHandler: emulateResponse,
        beforeSendBody: (xhr, body) => {
            let json = JSON.parse(body);
            let ids = OTDLayout.putColumns(json);
            xhr.storage.ids = ids;
            console.log('columns push', json, ids);
            return body;
        },
        afterRequest: (xhr) => {
            return xhr.storage.ids;
        }
    },
    // tweetdeck stuff
    {
        path: "/decider",
        method: "GET",
        openHandler: () => {},
        sendHandler: emulateResponse,
        afterRequest: (xhr) => {
            console.log("Got decider");
            return {"decider":{"tweetdeck_subsequent_follows":true,"scheduler_write":true,"in_reply_to_indicator":true,"enable_cors_firefox":true,"create_moment":true,"simplified_edit_collection_flow":true,"suggest_refresh":true,"poll_streamed_feed_favorites":true,"disable_oauth_echo":true,"scheduler_read_visible":true,"upload_big_gifs":true,"cookie_force_migrate":true,"action_retweeted_retweet":true,"native_animated_gifs":true,"touchdeck_sidebar_v2":true,"account_settings_join_team_flow":true,"enable_rewrite_columns":true,"touchdeck_font_size_v2":true,"touchdeck_search_v2":true,"disable_typeahead_search_with_feather_v2":true,"dataminr_proxied_auth_flow":true,"disable_streaming":true,"abuse_emergency_filter_info":true,"poll_streamed_feed_home":true,"compose_quoted_tweet_as_attachment":true,"send_twitter_auth_type_header":true,"dataminr":true,"heartfave_animation":true,"touchdeck_column_options_v2":true,"tweets_emoji":true,"column_unread_bar":true,"with_video_upload":true,"continuous_pipeline_staging":true,"universal_search_timelines":true,"machine_translated_tweets":true,"hashflags":true,"scheduler_read_background":true,"cookie_streaming":true,"poll_streamed_feed_usertweets":true,"faster_notifications":true,"disable_scheduled_messages":true,"streamed_chirp_lookup_metrics":true,"tweet_up_to_four_images":true,"sample_failed_requests":true,"iq_tweets":true,"add_column_by_url_query_param":true,"use_twitter_api_sync":true,"track_search_engagement":true,"quote_tweet_read":true,"cookie_access_tweetdeck":true,"account_settings_redesign":true,"windows_migration_logged_in_2":true,"tweetstorms":true,"action_favorited_retweet":true,"tweetdeck_subsequent_likes":true,"touchdeck_tweet_controls_v3":true,"trends_tailored":true,"live_video_timelines":true,"slow_collection_refresh":true,"fetch_entire_blocklist":true,"report_flow_iframe":true,"tweet_hide_suffix":true,"windows_migration_warning_2":true,"version_poll_force_upgrade":true,"quote_tweet_write":true,"poll_cards_enabled":true,"version_poll":true,"migrate_chrome_app_session_to_web":true,"add_account":true,"disable_quote_tweet_unavailable_msg":true,"convert_new_oauth_account_to_contributor":true,"iq_rts":true,"migrate_mac_app_session_to_web_gt_3_9_482":true,"enable_cors_2":true,"windows_migration_logged_out_2":true,"simplified_replies":true,"scheduler_write_media":true,"multi_photo_media_grid":true,"touchdeck_modals_v2":true,"non_destructive_chirp_rerender":true,"touchdeck_dropdowns_v2":true,"umf_prompts":true,"cramming":true,"trends_regional":true,"cookie_td_cookie_migration":true,"universal_search_timelines_by_id":true,"add_account_via_xauth_2":true,"native_video":true,"chirp_lateness_metric":true,"upload_use_sru":true,"mute_conversation":true,"action_quoted_tweet":true,"dm_rounded_avatars":true,"compose_character_limit_do_not_count_attachments":true,"touchdeck_compose_v2":true,"autocomplete_remote_sources":true,"cards_enabled_detail_view":true}};
        },
    },
    {
        path: "/web/dist/version.json",
        method: "GET",
        openHandler: () => {},
        sendHandler: emulateResponse,
        afterRequest: (xhr) => {
            console.log("Got version.json");
            return {"version":"4.0.220811153004","minimum":"4.0.190610153508"};
        },
    },
    {
        path: "/1.1/help/settings.json",
        method: "GET",
        openHandler: () => {},
        sendHandler: emulateResponse,
        afterRequest: (xhr) => {
            console.log("Got settings.json");
            return {"versions":{"feature_switches":"a6da3a3fb61e9c1423276a8df0da3258980b42cf","experiments":"a6da3a3fb61e9c1423276a8df0da3258980b42cf","settings":"a88b5266c59f52ccf8a8f1fd85f2b92a"},"config":{"live_engagement_in_column_8020":{"value":"live_engagement_enabled"},"tweetdeck_activity_streaming":{"value":false},"tweetdeck_content_render_search_tweets":{"value":true},"tweetdeck_live_engagements":{"value":true},"tweetdeck_scheduled_new_api":{"value":true},"tweetdeck_trends_column":{"value":true},"twitter_text_emoji_counting_enabled":{"value":true}},"impression_pointers":{}};
        },
    },
    {
        path: "/i/jot",
        method: "GET",
        openHandler: () => {},
        sendHandler: emulateResponse,
        afterRequest: (xhr) => {
            return "";
        },
    },
];

// wrap the XMLHttpRequest
XMLHttpRequest = function () {
    return new Proxy(new OriginalXHR(), {
        open(method, url, async, username = null, password = null) {
            this.modMethod = method;
            this.modUrl = url;
            this.originalUrl = url;
            this.modReqHeaders = {};
            this.storage = {};


            try {
                let parsedUrl = new URL(url);
                this.proxyRoute = proxyRoutes.find((route) => {
                    if(!route) return false;
                    if (route.method.toUpperCase() !== method.toUpperCase()) return false;
                    if (typeof route.path === "string") {
                        return route.path === parsedUrl.pathname;
                    } else if (route.path instanceof RegExp) {
                        return route.path.test(parsedUrl.pathname);
                    }
                });
            } catch (e) {
                console.error(e);
            }
            if (this.proxyRoute && this.proxyRoute.beforeRequest) {
                this.proxyRoute.beforeRequest(this);
            }

            // both handlers must be set, because if openHandler never opens the request 'send' will always error
            if(this.proxyRoute && this.proxyRoute.openHandler && this.proxyRoute.sendHandler) {
                this.proxyRoute.openHandler(this, this.modMethod, this.modUrl, async, username, password);
            } else {
                this.open(this.modMethod, this.modUrl, async, username, password);
            }
        },
        setRequestHeader(name, value) {
            this.modReqHeaders[name] = value;
        },
        async send(body = null) {
            let parsedUrl = new URL(this.modUrl);
            let method = this.modMethod;
            if(!method) {
                method = "GET";
            } else {
                method = method.toUpperCase();
            }
            if(
                this.readyState === 1 &&
                (
                    this.modUrl.includes("api.twitter.com") || 
                    this.modUrl.includes("api.x.com") || 
                    this.modUrl.includes("twitter.com/i/api") ||
                    this.modUrl.includes("x.com/i/api")
                )
            ) {
                if(localStorage.device_id) this.setRequestHeader('X-Client-UUID', localStorage.device_id);
                if(Date.now() - OTD_INIT_TIME < 3000 && !window.solveChallenge) {
                    console.log('waiting for challenge');
                    let i = 0;
                    while(!window.solveChallenge && i++ < 50) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                }
                if(window.solveChallenge) {
                    try {
                        this.setRequestHeader('x-client-transaction-id', await solveChallenge(parsedUrl.pathname, method));
                    } catch (e) {
                        // if(localStorage.secureRequests) {
                            console.error(`Challenge error for ${method} ${parsedUrl.pathname}:`, e);
                            throw e;
                        // }
                    }
                }
            }
            if (this.proxyRoute && this.proxyRoute.beforeSendHeaders) {
                this.proxyRoute.beforeSendHeaders(this);
            }
            try {
                for (const [name, value] of Object.entries(this.modReqHeaders)) {
                    this.setRequestHeader(name, value);
                }
            } catch(e) {
                if(!String(e).includes('OPENED')) {
                    console.error(e);
                }
            }
            if (this.proxyRoute && this.proxyRoute.beforeSendBody) {
                body = this.proxyRoute.beforeSendBody(this, body);
            }
            if(this.proxyRoute && this.proxyRoute.sendHandler) {
                this.proxyRoute.sendHandler(this, body);
            } else {
                this.send(body);
            }
        },
        get(xhr, key) {
            if (!key in xhr) return undefined;
            if (key === "responseText" && xhr._responseText) return xhr._responseText;
            if (key === "responseText") return this.interceptResponseText(xhr);
            if (key === "readyState" && xhr._readyState) return xhr._readyState;
            if (key === "status" && xhr._status) return xhr._status;
            if (key === "statusText" && (xhr._statusText || xhr._status)) return xhr._statusText ? xhr._statusText : xhr._status+"";

            let value = xhr[key];
            if (typeof value === "function") {
                value = this[key] || value;
                return (...args) => value.apply(xhr, args);
            } else {
                return value;
            }
        },
        set(xhr, key, value) {
            if (key in xhr) {
                xhr[key] = value;
            }
            return value;
        },
        interceptResponseText(xhr) {
            // Cache the shared SearchTimeline budget from live rate-limit headers — drives searchFloor's pacer.
            const rl = xhr.responseURL?.includes("SearchTimeline") && XApi.rateLimit(xhr);
            if (rl) searchBudget = { ...rl, limit: rl.limit || searchBudget.limit };
            if (xhr.status === 429) {
                rateCoolUntil = Date.now() + IDLE_INTERVAL;
                showToast("Twitter rate limit hit — slow down or try again in a bit.");
            }
            if (xhr.proxyRoute && xhr.proxyRoute.afterRequest) {
                // TweetDeck reads responseText more than once; convert a finished response once, so
                // cursors and seen-notification dedupe aren't re-applied on the second read.
                if ("out" in xhr.storage) return xhr.storage.out;
                let out = xhr.proxyRoute.afterRequest(xhr);
                if (typeof out === "object") out = JSON.stringify(out);
                if ((xhr._readyState || xhr.readyState) === 4) xhr.storage.out = out;
                return out;
            }
            return xhr.responseText;
        },
        getResponseHeader(name) {
            let override = this.responseHeaderOverride ? this.responseHeaderOverride : this.proxyRoute ? this.proxyRoute.responseHeaderOverride : undefined;
            if(this.proxyRoute && override) {
                for(let header in override) {
                    if(header.toLowerCase() === name.toLowerCase()) {
                        return override[header](this.getResponseHeader(header));
                    }
                }
            }
            return this.getResponseHeader(name);
        },
        getAllResponseHeaders() {
            let headers = this.getAllResponseHeaders();

            let override = this.responseHeaderOverride ? this.responseHeaderOverride : this.proxyRoute ? this.proxyRoute.responseHeaderOverride : undefined;
            if (this.proxyRoute && override) {
                let splitHeaders = headers.split("\r\n");
                let objHeaders = {};
                for (let header of splitHeaders) {
                    let splitHeader = header.split(": ");
                    let headerName = splitHeader[0];
                    let headerValue = splitHeader[1];
                    objHeaders[headerName.toLowerCase()] = headerValue;
                }
                for(let header in override) {
                    objHeaders[header.toLowerCase()] = override[header](objHeaders[header.toLowerCase()], objHeaders);
                }
                headers = Object.entries(objHeaders).filter(([_, value]) => value).map(([name, value]) => `${name}: ${value}`).join("\r\n");
            }

            return headers;
        },
    });
};
