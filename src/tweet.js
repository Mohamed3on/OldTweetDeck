// The tweet adapter: X's GraphQL tweet results → the legacy v1.1 tweet objects TweetDeck's
// TwitterStatus.fromJSONObject consumes (note-tweet expansion, Grok translation, quote
// permalinks, card flattening), indexing handles and community notes on the way. A page
// script injected just ahead of the local interception.js, whose routes and window.OTD use
// it; exported for the bun fixture tests.

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

// Clicking a @mention/"Replying to" link makes TweetDeck resolve a user via the
// legacy users/show.json (by screen_name) or users/lookup.json (by id) — both of
// which x.com now Cloudflare-blocks, as do the UserByRestId/UsersByRestIds GraphQL
// fallbacks. UserByScreenName is the only user endpoint still reachable, so we
// route everything through it: screen_name straight through, and ids mapped back
// to a handle harvested from tweets we've already parsed (handleById).

const handleById = {};
function indexHandle(id, screen_name) {
    if (id && screen_name) handleById[String(id)] = screen_name;
}
function indexTweetHandles(t) {
    if (!t) return;
    if (t.user) indexHandle(t.user.id_str, t.user.screen_name);
    for (let m of t.entities?.user_mentions ?? []) indexHandle(m.id_str, m.screen_name);
}

// Community notes arrive as birdwatch_pivot on GraphQL tweet results, but the
// legacy chirp TweetDeck builds (fromJSONObject) has no slot to carry them.
// Index pivots by tweet id; xlr.js reads the map off the rendered DOM to draw them.
const birdwatchById = {};
function indexBirdwatch(result) {
    if (result?.tweet) result = result.tweet;
    let id = result?.legacy?.id_str ?? result?.rest_id;
    if (id && result.birdwatch_pivot) birdwatchById[id] = result.birdwatch_pivot;
}

function parseTweet(res) {
    try {

        if (typeof res !== "object") return;
        if (res.limitedActionResults) {
            let limitation = res.limitedActionResults.limited_actions.find((l) => l.action === "Reply");
            if (limitation) {
                res.tweet.legacy.limited_actions_text = limitation.prompt
                    ? limitation.prompt.subtext.text
                    : "This tweet has limitations to who can reply.";
            }
            res = res.tweet;
        }
        if (!res.legacy && res.tweet) res = res.tweet;
        let tweet = res.legacy;
        if (!res.core || !tweet) return;
        let result = res.core.user_results?.result;
        if (!result?.legacy) return;
        if(!tweet.id) {
            tweet.id = +tweet.id_str;
        }
        tweet.conversation_id = +tweet.conversation_id_str;
        tweet.text = tweet.full_text;
        tweet.user = result.legacy;
        tweet.user.id = +tweet.user_id_str;
        tweet.user.id_str = tweet.user_id_str;
        hydrateUser(tweet.user, result);

        if (tweet.retweeted_status_result?.result) {
            let result = tweet.retweeted_status_result.result;
            if (result.limitedActionResults) {
                let limitation = result.limitedActionResults.limited_actions.find(
                    (l) => l.action === "Reply"
                );
                if (limitation) {
                    result.tweet.legacy.limited_actions_text = limitation.prompt
                        ? limitation.prompt.subtext.text
                        : "This tweet has limitations to who can reply.";
                }
                result = result.tweet;
            }
            if (
                result.quoted_status_result &&
                result.quoted_status_result.result &&
                result.quoted_status_result.result.legacy &&
                result.quoted_status_result.result.core &&
                result.quoted_status_result.result.core.user_results.result.legacy
            ) {
                result.legacy.quoted_status = result.quoted_status_result.result.legacy;
                result.legacy.quoted_status.id = +result.legacy.quoted_status.id_str;
                result.legacy.quoted_status.text = result.legacy.quoted_status.full_text;
                result.legacy.quoted_status.conversation_id = +result.legacy.quoted_status.conversation_id_str;
                if (result.legacy.quoted_status) {
                    result.legacy.quoted_status.user =
                        result.quoted_status_result.result.core.user_results.result.legacy;
                    result.legacy.quoted_status.user.id_str = result.legacy.quoted_status.user_id_str;
                    result.legacy.quoted_status.user.id = +result.legacy.quoted_status.user_id_str;
                    let user_result = result?.quoted_status_result?.result?.core?.user_results?.result;
                    hydrateUser(result.legacy.quoted_status.user, user_result);
                } else {
                    console.warn("No retweeted quoted status", result);
                }
            }
            tweet.retweeted_status = result.legacy;
            if (tweet.retweeted_status && result.core?.user_results?.result?.legacy) {
                let user_result = result?.core?.user_results?.result;
                tweet.retweeted_status.text = tweet.retweeted_status.full_text;
                tweet.retweeted_status.id = +tweet.retweeted_status.id_str;
                tweet.retweeted_status.conversation_id = +tweet.retweeted_status.conversation_id_str;
                tweet.retweeted_status.user = user_result.legacy;
                tweet.retweeted_status.user.id_str = tweet.retweeted_status.user_id_str;
                tweet.retweeted_status.user.id = +tweet.retweeted_status.user_id_str;
                hydrateUser(tweet.retweeted_status.user, user_result);
                tweet.retweeted_status.ext = {};
                if (result.views) {
                    tweet.retweeted_status.ext.views = { r: { ok: { count: +result.views.count } } };
                }
                if (result.card && result.card.legacy && result.card.legacy.binding_values) {
                    tweet.retweeted_status.card = result.card.legacy;
                    let bvo = {};
                    for (let bv of tweet.retweeted_status.card.binding_values) bvo[bv.key] = bv.value;
                    tweet.retweeted_status.card.binding_values = bvo;
                }
            } else {
                console.warn("No retweeted status", result);
            }
            if (result.note_tweet && result.note_tweet.note_tweet_results && localStorage.OTDenableAutoExpand === "1") {
                let note = parseNoteTweet(result);
                let implicit = captureReplyMentions(tweet.retweeted_status);
                tweet.retweeted_status.full_text = note.text;
                tweet.retweeted_status.entities = note.entities;
                tweet.retweeted_status.display_text_range = undefined; // no text range for long tweets
                attachReplyMentions(tweet.retweeted_status.entities, implicit, note.text);
                hideNoteAttachmentUrls(tweet.retweeted_status, note);
            }
        }
    
        if (res.quoted_status_result) {
            tweet.quoted_status_result = res.quoted_status_result;
        }
        if (res.note_tweet && res.note_tweet.note_tweet_results) {
            let note = parseNoteTweet(res);
            let implicit = captureReplyMentions(tweet);
            tweet.full_text = note.text;
            tweet.entities = note.entities;
            tweet.display_text_range = undefined; // no text range for long tweets
            attachReplyMentions(tweet.entities, implicit, note.text);
            hideNoteAttachmentUrls(tweet, note);
        }
        if (tweet.quoted_status_result && tweet.quoted_status_result.result) {
            let result = tweet.quoted_status_result.result;
            if (!result.core && result.tweet) result = result.tweet;
            if (result.limitedActionResults) {
                let limitation = result.limitedActionResults.limited_actions.find(
                    (l) => l.action === "Reply"
                );
                if (limitation) {
                    result.tweet.legacy.limited_actions_text = limitation.prompt
                        ? limitation.prompt.subtext.text
                        : "This tweet has limitations to who can reply.";
                }
                result = result.tweet;
            }
            if(result && result.legacy && result.core?.user_results?.result?.legacy) {
                tweet.quoted_status = result.legacy;
                tweet.quoted_status.id = +tweet.quoted_status.id_str;
                tweet.quoted_status.conversation_id = +tweet.quoted_status.conversation_id_str;
                tweet.quoted_status.text = tweet.quoted_status.full_text;
                if (tweet.quoted_status) {
                    tweet.quoted_status.user = result.core.user_results.result.legacy;
                    if (!tweet.quoted_status.user) {
                        delete tweet.quoted_status;
                    } else {
                        tweet.quoted_status.user.id_str = tweet.quoted_status.user_id_str;
                        tweet.quoted_status.user.id = +tweet.quoted_status.user_id_str;
                        let user_result = result?.core?.user_results?.result;
                        hydrateUser(tweet.quoted_status.user, user_result);
                        tweet.quoted_status.ext = {};
                        if (result.views) {
                            tweet.quoted_status.ext.views = { r: { ok: { count: +result.views.count } } };
                        }
                        // A quoted note (long) tweet carries its full text in note_tweet, same as
                        // the focal tweet (above) and retweets — but nothing expanded it here, so a
                        // quoted long tweet (and its media-modal preview) showed the cut legacy text
                        // until you opened the tweet itself. Expand it in place like the sibling paths.
                        if (result.note_tweet && result.note_tweet.note_tweet_results && localStorage.OTDenableAutoExpand === "1") {
                            let note = parseNoteTweet(result);
                            let implicit = captureReplyMentions(tweet.quoted_status);
                            tweet.quoted_status.full_text = note.text;
                            tweet.quoted_status.text = note.text;
                            tweet.quoted_status.entities = note.entities;
                            tweet.quoted_status.display_text_range = undefined; // no text range for long tweets
                            attachReplyMentions(tweet.quoted_status.entities, implicit, note.text);
                            hideNoteAttachmentUrls(tweet.quoted_status, note);
                        }
                    }
                } else {
                    console.warn("No quoted status", result);
                }
            }
        }
        if (res.card && res.card.legacy) {
            tweet.card = res.card.legacy;
            let bvo = {};
            for (let i = 0; i < tweet.card.binding_values.length; i++) {
                let bv = tweet.card.binding_values[i];
                bvo[bv.key] = bv.value;
            }
            tweet.card.binding_values = bvo;
        }
        if (res.views) {
            if (!tweet.ext) tweet.ext = {};
            tweet.ext.views = { r: { ok: { count: +res.views.count } } };
        }
        if (res.source) {
            tweet.source = res.source;
        }
        if (res.birdwatch_pivot) {
            // community notes
            tweet.birdwatch = res.birdwatch_pivot;
        }
    
        if (tweet.favorited && tweet.favorite_count === 0) {
            tweet.favorite_count = 1;
        }
        if (tweet.retweeted && tweet.retweet_count === 0) {
            tweet.retweet_count = 1;
        }

        applyGrokTranslation(res, tweet);
        let rt = tweet.retweeted_status_result?.result;
        if (rt?.tweet) rt = rt.tweet;
        applyGrokTranslation(rt, tweet.retweeted_status);
        applyGrokTranslation(tweet.quoted_status_result?.result, tweet.quoted_status);
        applyGrokTranslation(rt?.quoted_status_result?.result, tweet.retweeted_status?.quoted_status);

        indexBirdwatch(res);
        indexBirdwatch(tweet.quoted_status_result?.result);
        indexBirdwatch(rt);
        indexBirdwatch(rt?.quoted_status_result?.result);

        // The quoted tweet is unavailable (suspended/deleted), so no card can render —
        // surface the permalink so the quote isn't silently dropped.
        for (let t of [tweet, tweet.retweeted_status]) {
            if (t && (t.is_quote_status || t.quoted_status_id_str) && !t.quoted_status) {
                appendQuotePermalink(t);
            }
        }

        // Harvest id->handle from every user + mention so the show/lookup routes can
        // resolve reply-prefix recipients (which arrive as bare ids) by screen_name.
        indexTweetHandles(tweet);
        indexTweetHandles(tweet.retweeted_status);
        indexTweetHandles(tweet.quoted_status);

        return tweet;
    } catch (e) {
        console.error('error parsing tweet', e.message, 'stack:', e.stack, 'res:', JSON.stringify(res, null, 2)?.slice(0, 2000));
        return;
    }
}

if (typeof module !== 'undefined') module.exports = { parseTweet, handleById, birdwatchById };
