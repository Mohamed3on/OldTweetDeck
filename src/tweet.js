// The tweet adapter: X's GraphQL tweet results → the legacy v1.1 tweet objects TweetDeck's
// TwitterStatus.fromJSONObject consumes (note-tweet expansion, Grok translation, quote
// permalinks, card flattening), plus the handles and community notes it saw. A page script
// injected just ahead of the local interception.js, whose routes and window.OTD use it;
// exported for the bun fixture tests.

// Reply-prefix mentions ("Replying to @x") sit before a tweet's display range. Whenever
// we replace a tweet's text + entities (Grok translation, note-tweet expansion) the new
// entity set drops them, so TweetDeck's reply header (getReplyingToUsers) renders empty.
// captureReplyMentions grabs them before a swap; attachReplyMentions re-adds them after.
// Capture is flag-aware so chained swaps (note expansion then Grok) don't lose them.
function captureReplyMentions(legacy) {
    let start = (legacy?.display_text_range ?? [0])[0];
    return (legacy?.entities?.user_mentions ?? []).filter(
        (m) => m.isImplicitMention || m.indices?.[1] <= start
    );
}

// Re-add captured mentions past the new text's end: the body renderer skips entities
// beyond the text length, but getReplyingToUsers still picks them up via the flag.
function attachReplyMentions(entities, mentions, text) {
    if (!entities || !mentions?.length) return;
    let end = (text?.length ?? 0) + 1;
    for (let m of mentions) {
        (entities.user_mentions ??= []).push({ ...m, indices: [end, end], isImplicitMention: true });
    }
}

// Swap legacy.full_text for Twitter's pre-rendered translation when present.
function applyGrokTranslation(result, legacy) {
    if (result?.tweet) result = result.tweet; // some routes wrap the result in a `.tweet`
    if (!result || !legacy) return;
    let data = result.grok_translated_post_with_availability?.data;
    let translation = data?.translation;
    if (typeof translation !== "string" || !translation || typeof legacy.full_text !== "string") return;

    // Grok drops the reply-prefix mentions from the translation; capture them first.
    let implicit = captureReplyMentions(legacy);
    // It can also drop a visible link (a long tweet's trailing YouTube link), so re-append
    // those. Attachment links (outside the display range or flagged) stay hidden.
    let range = legacy.display_text_range;
    let dropped = [];
    for (let u of legacy.entities?.urls ?? []) {
        if (u.isUrlForAttachment || translation.includes(u.url)) continue;
        if (range && (u.indices[0] < range[0] || u.indices[1] > range[1])) continue;
        let start = [...translation].length + 2; // entity indices count code points
        translation += "\n\n" + u.url;
        dropped.push({ ...u, indices: [start, start + u.url.length] });
    }

    legacy.full_text = translation;
    legacy.text = translation;
    // TweetDeck sets text direction from lang, so an RTL source would render the translation RTL.
    if (data.destination_language) legacy.lang = data.destination_language;
    legacy.display_text_range = undefined;
    // Adopt Grok's entities: their indices point into the translated text, so mentions
    // and links linkify in place. The old entities pointed into the pre-translation text;
    // pushing them to the end made TweetDeck append a duplicate mention link after the
    // plain-text mention already present in the translation.
    let end = translation.length;
    if (legacy.entities) {
        for (let key of ["hashtags", "symbols", "urls", "user_mentions"]) {
            legacy.entities[key] = data.entities?.[key] ?? [];
        }
        legacy.entities.urls = legacy.entities.urls.concat(dropped);
        attachReplyMentions(legacy.entities, implicit, translation);
        // Media isn't in Grok's entities and its URL is dropped from the translation, so
        // neutralize the stale inline indices — it still renders via the media-preview path.
        for (let m of legacy.entities.media ?? []) m.indices = [end, end];
    }
    for (let m of legacy.extended_entities?.media ?? []) m.indices = [end, end];
}

// When the quoted tweet is unavailable, X omits it and there's no card to render.
// The quote link lives in the separate quoted_status_permalink field rather than
// inline, so nothing shows. Splice the permalink in as a real URL entity so it does.
function appendQuotePermalink(tweet) {
    let p = tweet?.quoted_status_permalink;
    if (!p?.url || typeof tweet.full_text !== "string") return;
    if ((tweet.entities?.urls ?? []).some((u) => u.url === p.url)) return;

    // Indices are Unicode code points, not UTF-16 units — work in a code-point array.
    let cp = Array.from(tweet.full_text);
    let range = tweet.display_text_range ?? [0, cp.length];
    let at = range[1];
    let prefix = at > 0 && cp[at - 1] !== " " ? " " : "";
    let insert = Array.from(prefix + p.url);
    cp.splice(at, 0, ...insert);
    tweet.full_text = cp.join("");
    tweet.text = tweet.full_text;

    if (!tweet.entities) tweet.entities = {};
    let bump = (arr) => {
        for (let e of arr ?? []) if (e.indices?.[0] >= at) { e.indices[0] += insert.length; e.indices[1] += insert.length; }
    };
    for (let key of ["hashtags", "symbols", "urls", "user_mentions", "media"]) bump(tweet.entities[key]);
    bump(tweet.extended_entities?.media);

    let urlStart = at + prefix.length;
    let urlEnd = urlStart + Array.from(p.url).length;
    (tweet.entities.urls ??= []).push({ url: p.url, expanded_url: p.expanded, display_url: p.display, indices: [urlStart, urlEnd] });
    tweet.display_text_range = [range[0], urlEnd];
}

function parseNoteTweet(result) {
    let text, entities;
    if (result.note_tweet.note_tweet_results.result) {
        text = result.note_tweet.note_tweet_results.result.text;
        entities = result.note_tweet.note_tweet_results.result.entity_set;
        if (result.note_tweet.note_tweet_results.result.richtext?.richtext_tags.length) {
            entities.richtext = result.note_tweet.note_tweet_results.result.richtext.richtext_tags; // logically, richtext is an entity, right?
        }
    } else {
        text = result.note_tweet.note_tweet_results.text;
        entities = result.note_tweet.note_tweet_results.entity_set;
    }
    return { text, entities };
}

// A note (long) tweet's own media or quoted-tweet link comes back as a trailing
// URL entity in entity_set.urls. We clear display_text_range for note tweets,
// which disables TweetDeck's native trailing-attachment hiding (its identify*
// AttachmentUrls helpers only run when a display range is present) — so the
// media/quote renders AND a bare link is left in the text. Flag those trailing
// self-media / tweet-permalink links as attachments so the linkifier drops them,
// matching x.com.
const NOTE_ATTACHMENT_PERMALINK = /(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/\d+/i;
function hideNoteAttachmentUrls(tweet, note) {
    let urls = note.entities?.urls;
    if (!urls?.length) return;
    let selfMedia = new Set(
        (tweet.extended_entities?.media ?? tweet.entities?.media ?? []).map((m) => m.url)
    );
    let end = [...note.text].length; // codepoints, to match entity indices
    for (let u of [...urls].sort((a, b) => b.indices[0] - a.indices[0])) {
        if (end - u.indices[1] > 1) break; // only trailing entities (allow one space)
        if (!selfMedia.has(u.url) && !NOTE_ATTACHMENT_PERMALINK.test(u.expanded_url || "")) break;
        u.isUrlForAttachment = true;
        end = u.indices[0];
    }
}

// X's modern API splits user fields across user_results.result (avatar, core, privacy,
// relationship_perspectives, verification). Fold them into the flat legacy user shape,
// filling only the gaps the legacy payload left behind.
function hydrateUser(user, userResult) {
    if (!user || !userResult) return;
    if (userResult.is_blue_verified) {
        user.verified = true;
        user.verified_type = "Blue";
    }
    if (!user.profile_image_url && userResult.avatar?.image_url) {
        user.profile_image_url = userResult.avatar.image_url;
        user.profile_image_url_https = user.profile_image_url.replace("http://", "https://");
    }
    if (!user.profile_image_url && user.profile_image_url_https) {
        user.profile_image_url = user.profile_image_url_https.replace("https://", "http://");
    }
    if (!user.name && userResult.core?.name) user.name = userResult.core.name;
    if (!user.screen_name && userResult.core?.screen_name) user.screen_name = userResult.core.screen_name;
    if (!user.created_at && userResult.core?.created_at) user.created_at = userResult.core.created_at;
    if (userResult.relationship_perspectives?.muting) user.muting = true;
    if (userResult.relationship_perspectives?.blocking) user.blocking = true;
    if (userResult.privacy?.protected) user.protected = true;
    if (userResult.location?.location) user.location = userResult.location.location;
    if (userResult.verification?.verified) user.verified = true;
}

// A note (long) tweet's full text and entities replace the cut legacy ones.
function expandNote(legacy, node) {
    let note = parseNoteTweet(node);
    let implicit = captureReplyMentions(legacy);
    legacy.full_text = legacy.text = note.text;
    legacy.entities = note.entities;
    legacy.display_text_range = undefined; // no text range for long tweets
    attachReplyMentions(legacy.entities, implicit, note.text);
    hideNoteAttachmentUrls(legacy, note);
}

// Peel a result down to the tweet node: reply limits arrive as limitedActionResults
// wrapping the tweet, and visibility-filtered tweets as a { tweet } wrapper.
function unwrapTweet(node) {
    if (node?.limitedActionResults) {
        let limitation = node.limitedActionResults.limited_actions.find((l) => l.action === "Reply");
        if (limitation && node.tweet?.legacy) {
            node.tweet.legacy.limited_actions_text = limitation.prompt
                ? limitation.prompt.subtext.text
                : "This tweet has limitations to who can reply.";
        }
        node = node.tweet;
    }
    if (node && !node.legacy && node.tweet) node = node.tweet;
    return node;
}

// One tweet node (the top tweet, its retweet, either one's quote) → its legacy object with
// ids, author, view count, card and expanded note text, then its own retweet and quote the
// same way. Returns null for a node without a usable legacy tweet and author.
// role is "top", "retweet" or "quote": only the top tweet carries a retweet, quotes carry no
// quote of their own (TweetDeck renders one level), and only nested tweets' notes wait on
// auto-expand.
function adaptNode(raw, role, autoExpand) {
    let node = unwrapTweet(raw);
    let legacy = node?.legacy, author = node?.core?.user_results?.result;
    if (!legacy || !author?.legacy) return null;
    if (!legacy.id) legacy.id = +legacy.id_str;
    legacy.conversation_id = +legacy.conversation_id_str;
    legacy.text = legacy.full_text;
    legacy.user = author.legacy;
    legacy.user.id = +legacy.user_id_str;
    legacy.user.id_str = legacy.user_id_str;
    hydrateUser(legacy.user, author);
    if (node.views) (legacy.ext ??= {}).views = { r: { ok: { count: +node.views.count } } };
    if (node.card?.legacy?.binding_values) {
        legacy.card = node.card.legacy;
        let bvo = {};
        for (let bv of legacy.card.binding_values) bvo[bv.key] = bv.value;
        legacy.card.binding_values = bvo;
    }
    if (node.note_tweet?.note_tweet_results) {
        if (role === "top" || autoExpand) expandNote(legacy, node);
        else legacy.truncated_note = true; // bundle.js draws an "Expand tweet" link for it
    }

    let rt = role === "top" ? adaptNode(legacy.retweeted_status_result?.result, "retweet", autoExpand) : null;
    if (rt) legacy.retweeted_status = rt.legacy;
    let quote = role !== "quote" ? adaptNode(node.quoted_status_result?.result, "quote", autoExpand) : null;
    if (quote) legacy.quoted_status = quote.legacy;
    applyGrokTranslation(node, legacy);
    return { node, legacy, rt, quote };
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

// The adapter. Pure: it works on a copy of the result, reads no settings of its own and
// writes no globals. Returns { tweet, facts } or null, where facts are what callers index:
//   handles: id → screen_name for every author and mention. Clicking a @mention/"Replying
//     to" link makes TweetDeck resolve a user by id, and only UserByScreenName is still
//     reachable (by-id lookups are Cloudflare-blocked), so ids map back to handles.
//   notes: tweet id → birdwatch_pivot. Community notes have no slot in the legacy chirp
//     fromJSONObject builds, so xlr.js draws them onto the rendered tweet from this map.
function adaptTweet(result, { autoExpand = true } = {}) {
    try {
        if (!result || typeof result !== "object") return null;
        let top = adaptNode(structuredClone(result), "top", autoExpand);
        if (!top) return null;
        let { node: res, legacy: tweet } = top;

        if (res.quoted_status_result) tweet.quoted_status_result = res.quoted_status_result;
        if (res.source) tweet.source = res.source;
        if (res.birdwatch_pivot) tweet.birdwatch = res.birdwatch_pivot; // community notes
        if (tweet.favorited && tweet.favorite_count === 0) tweet.favorite_count = 1;
        if (tweet.retweeted && tweet.retweet_count === 0) tweet.retweet_count = 1;

        // The quoted tweet is unavailable (suspended/deleted), so no card can render —
        // surface the permalink so the quote isn't silently dropped.
        for (let t of [tweet, tweet.retweeted_status]) {
            if (t && (t.is_quote_status || t.quoted_status_id_str) && !t.quoted_status) {
                appendQuotePermalink(t);
            }
        }

        let facts = { handles: {}, notes: {} };
        for (let n of [top, top.quote, top.rt, top.rt?.quote]) {
            let id = n?.legacy.id_str ?? n?.node.rest_id;
            if (id && n.node.birdwatch_pivot) facts.notes[id] = n.node.birdwatch_pivot;
        }
        let handle = (id, screen_name) => { if (id && screen_name) facts.handles[String(id)] = screen_name; };
        for (let t of [tweet, tweet.retweeted_status, tweet.quoted_status]) {
            if (!t) continue;
            if (t.user) handle(t.user.id_str, t.user.screen_name);
            for (let m of t.entities?.user_mentions ?? []) handle(m.id_str, m.screen_name);
        }
        return { tweet, facts };
    } catch (e) {
        console.error('error parsing tweet', e.message, 'stack:', e.stack, 'res:', JSON.stringify(result, null, 2)?.slice(0, 2000));
        return null;
    }
}

if (typeof module !== 'undefined') module.exports = { adaptTweet, userResultToLegacy };
