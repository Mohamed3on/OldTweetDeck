const PUBLIC_TOKENS = [
    "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
];
const NEW_API = `https://${location.hostname}/i/api/graphql`;
const cursors = {};
const OTD_INIT_TIME = Date.now();

// Shared features payload for the modern tweet-returning GraphQL endpoints
// (HomeLatestTimeline, UserTweetsAndReplies, SearchTimeline). Mirrors what
// x.com sends so grok_translated_post_with_availability is populated.
const TIMELINE_FEATURES = Object.freeze({"rweb_video_screen_enabled":false,"rweb_cashtags_enabled":true,"profile_label_improvements_pcf_label_in_post_enabled":true,"responsive_web_profile_redirect_enabled":false,"rweb_tipjar_consumption_enabled":false,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":true,"rweb_cashtags_composer_attachment_enabled":true,"responsive_web_jetfuel_frame":true,"responsive_web_grok_share_attachment_enabled":true,"responsive_web_grok_annotations_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"rweb_conversational_replies_downvote_enabled":false,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"content_disclosure_indicator_enabled":true,"content_disclosure_ai_generated_indicator_enabled":true,"responsive_web_grok_show_grok_translated_post":true,"responsive_web_grok_analysis_button_from_backend":true,"post_ctas_fetch_enabled":true,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":false,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_grok_imagine_annotation_enabled":true,"responsive_web_grok_community_note_auto_translation_is_enabled":true,"responsive_web_enhance_cards_enabled":false});

// TweetDetail (KwGBbJZc6DBx8EKmyQSP7g) — used by both the GraphQL and statuses/show.json routes.
const TWEET_DETAIL_FEATURES = Object.freeze({rweb_lists_timeline_redesign_enabled:false,blue_business_profile_image_shape_enabled:true,responsive_web_graphql_exclude_directive_enabled:true,verified_phone_label_enabled:false,creator_subscriptions_tweet_preview_api_enabled:false,responsive_web_graphql_timeline_navigation_enabled:true,responsive_web_graphql_skip_user_profile_image_extensions_enabled:false,tweetypie_unmention_optimization_enabled:true,vibe_api_enabled:true,responsive_web_edit_tweet_api_enabled:true,graphql_is_translatable_rweb_tweet_is_translatable_enabled:true,responsive_web_grok_show_grok_translated_post:true,view_counts_everywhere_api_enabled:true,longform_notetweets_consumption_enabled:true,tweet_awards_web_tipping_enabled:false,freedom_of_speech_not_reach_fetch_enabled:true,standardized_nudges_misinfo:true,tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled:false,interactive_text_enabled:true,responsive_web_text_conversations_enabled:false,longform_notetweets_rich_text_read_enabled:true,longform_notetweets_inline_media_enabled:false,responsive_web_enhance_cards_enabled:false});

const generateID = () => {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

let verifiedUser;
if(localStorage.OTDverifiedUser) {
    try {
        verifiedUser = JSON.parse(localStorage.OTDverifiedUser);
    } catch(e) {
        console.warn(`Error parsing OTDverifiedUser.`, e);
        verifiedUser = null;
    }
}
let feeds;
if(localStorage.OTDfeeds) {
    try {
        feeds = JSON.parse(localStorage.OTDfeeds);
    } catch(e) {
        console.warn(`Error parsing OTDfeeds.`, e);
        feeds = {};
    }
}
let columns;
if(localStorage.OTDcolumns) {
    try {
        columns = JSON.parse(localStorage.OTDcolumns);
    } catch(e) {
        console.warn(`Error parsing OTDcolumns.`, e);
        columns = {};
    }
}
let settings;
if(localStorage.OTDsettings) {
    try {
        settings = JSON.parse(localStorage.OTDsettings);
    } catch(e) {
        console.warn(`Error parsing OTDsettings.`, e);
        settings = null;
    }
}
// Snapshot the persisted layout once a day as a rolling backup (no-op if <24h since last).
backupStateDaily();
let seenNotifications = [];
let seenHomeTweets = {};
let timings = {
    home: {},
    list: {},
    user: {},
    search: {},
}
let refreshInterval = localStorage.OTDrefreshInterval ? parseInt(localStorage.OTDrefreshInterval) : 35000;

let lastToastAt = 0;
function showToast(message, { dedupeMs = 3000 } = {}) {
    const now = Date.now();
    if (now - lastToastAt < dedupeMs) return;
    lastToastAt = now;
    if (!document.body) return;
    const el = document.createElement("div");
    el.className = "otd-toast";
    el.textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("otd-toast-show"));
    setTimeout(() => {
        el.classList.remove("otd-toast-show");
        setTimeout(() => el.remove(), 300);
    }, 4000);
}

function snapshotState() {
    return {
        feeds,
        columns,
        settings,
        columnIds: localStorage.OTDcolumnIds ? JSON.parse(localStorage.OTDcolumnIds) : []
    };
}

function exportState() {
	const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(snapshotState())], {type: 'application/json'}));
    a.download = 'OTDState.json';
    a.click();
}

// Keep one rolling backup of the layout (feeds/columns/settings/columnIds) in a separate
// localStorage slot, refreshed at most once a day and overwriting the previous, so a reset
// or corrupted state can be recovered from a snapshot that's never more than ~24h stale.
// The blob matches the export format, so importState can restore it unchanged.
function backupStateDaily() {
    try {
        const DAY = 24 * 60 * 60 * 1000;
        let prev = localStorage.OTDstateBackup ? JSON.parse(localStorage.OTDstateBackup) : null;
        if (prev && Date.now() - prev.savedAt < DAY) return;
        if (!columns || !Object.keys(columns).length) return; // nothing worth saving yet — don't clobber a good backup
        localStorage.OTDstateBackup = JSON.stringify({ savedAt: Date.now(), ...snapshotState() });
    } catch (e) {
        console.error("OTD daily state backup failed", e);
    }
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
            const text = e.target.result;
            try {
                const data = JSON.parse(text);
                if(!data.feeds || !data.columns || !data.settings || !data.columnIds) {
                    throw new Error("Invalid file");
                }
                localStorage.OTDfeeds = JSON.stringify(data.feeds);
                localStorage.OTDcolumns = JSON.stringify(data.columns);
                localStorage.OTDsettings = JSON.stringify(data.settings);
                localStorage.OTDcolumnIds = JSON.stringify(data.columnIds);
                location.reload();
            } catch(e) {
                alert("Error parsing file");
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

// Restore the layout from the rolling daily backup (see backupStateDaily). Mirrors
// importState's write-and-reload, with a confirm because it replaces the current state.
function restoreState() {
    let raw = localStorage.OTDstateBackup;
    if (!raw) {
        alert("No daily backup found yet — one is saved automatically once you've used TweetDeck.");
        return;
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        alert("Backup is corrupted and can't be restored.");
        return;
    }
    if (!data.feeds || !data.columns || !data.settings || !data.columnIds) {
        alert("Backup is incomplete and can't be restored.");
        return;
    }
    let when = data.savedAt ? new Date(data.savedAt).toLocaleString() : "an earlier session";
    if (!confirm(`Restore your layout from the backup saved ${when}? This replaces your current columns and settings.`)) {
        return;
    }
    localStorage.OTDfeeds = JSON.stringify(data.feeds);
    localStorage.OTDcolumns = JSON.stringify(data.columns);
    localStorage.OTDsettings = JSON.stringify(data.settings);
    localStorage.OTDcolumnIds = JSON.stringify(data.columnIds);
    location.reload();
}

function cleanUp() {
    let ids = localStorage.OTDcolumnIds ? JSON.parse(localStorage.OTDcolumnIds) : [];
    for(let columnId in columns) {
        if(!ids.includes(columnId)) {
            delete columns[columnId];
        }
    }
    localStorage.OTDcolumns = JSON.stringify(columns);
    for(let id in feeds) {
        if(!localStorage.OTDcolumns.includes(id)) {
            delete feeds[id];
        }
    }
    localStorage.OTDfeeds = JSON.stringify(feeds);
}

function getFollows(id = getCurrentUserId(), cursor = -1, count = 5000) {
	return new Promise(function (resolve, reject) {
		var xhr = new XMLHttpRequest();
		xhr.open("GET", `https://api.${location.hostname}/1.1/friends/ids.json?user_id=${id}&cursor=${cursor}&stringify_ids=true&count=${count}`, true);
		xhr.setRequestHeader("X-Twitter-Active-User", "yes");
		xhr.setRequestHeader("X-Twitter-Auth-Type", "OAuth2Session");
		xhr.setRequestHeader("X-Twitter-Client-Language", "en");
		xhr.setRequestHeader("Authorization", "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA");
		xhr.setRequestHeader("X-Csrf-Token", (function () {
			var csrf = document.cookie.match(/(?:^|;\s*)ct0=([0-9a-f]+)\s*(?:;|$)/);
			return csrf ? csrf[1] : "";
		})());
		xhr.withCredentials = true;

		xhr.onreadystatechange = function () {
			if (xhr.readyState === 4 && xhr.status === 200) {
				resolve(JSON.parse(xhr.responseText));
			} else if (xhr.readyState === 4 && xhr.status !== 200) {
                reject(xhr);
            }
		};
		
		xhr.send();
	});
}

let followsData = JSON.parse(localStorage.OTDfollowsData || "{}");

let updatingFollows = false;
function updateFollows(id = getCurrentUserId()) {
    if(followsData[id] && followsData[id].lastUpdate && Date.now() - +followsData[id].lastUpdate < 1000 * 60 * 60 * 6) return;
    if(updatingFollows) return;
    updatingFollows = true;

    if(!followsData[id]) followsData[id] = {};
    let newfollows = [];
    let cursor = -1;
    let count = 5000;
    let i = 0;
    let get = async () => {
        let res = await getFollows(id, cursor, count);
        newfollows = newfollows.concat(res.ids);
        if(res.next_cursor_str === "0" || i++ > 10) {
            followsData[id].lastUpdate = Date.now();
            followsData[id].data = newfollows;
            localStorage.OTDfollowsData = JSON.stringify(followsData);
            updatingFollows = false;
            return;
        }
        cursor = res.next_cursor_str;
        get();
    };

    get();
}

// setTimeout(updateFollows, 1000);
// setInterval(updateFollows, 1000 * 60);

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

    legacy.full_text = translation;
    legacy.text = translation;
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
                if (res.card && res.card.legacy && res.card.legacy.binding_values) {
                    tweet.retweeted_status.card = res.card.legacy;
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

        // The quoted tweet is unavailable (suspended/deleted), so no card can render —
        // surface the permalink so the quote isn't silently dropped.
        for (let t of [tweet, tweet.retweeted_status]) {
            if (t && (t.is_quote_status || t.quoted_status_id_str) && !t.quoted_status) {
                appendQuotePermalink(t);
            }
        }

        return tweet;
    } catch (e) {
        console.error('error parsing tweet', e.message, 'stack:', e.stack, 'res:', JSON.stringify(res, null, 2)?.slice(0, 2000));
        return;
    }
}

function getCurrentUserId() {
    let accounts = TD.storage.accountController.getAll();
    let screen_name = TD.storage.accountController.getUserIdentifier();
    let account = accounts.find((account) => account.state.username === screen_name);
    return account?.state?.userId ?? verifiedUser?.id_str ?? localStorage.twitterAccountID;
}

function generateParams(features, variables, fieldToggles) {
    let params = new URLSearchParams();
    params.append("variables", JSON.stringify(variables));
    params.append("features", JSON.stringify(features));
    if (fieldToggles) params.append("fieldToggles", JSON.stringify(fieldToggles));

    return params.toString();
}

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
    xhr._status = 200;
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
// prefix; return the cursor's value (undefined if absent — callers all guard on it).
function findCursor(entries, direction) {
    return entries.find(
        (e) => e.entryId.startsWith(`sq-cursor-${direction}-`) || e.entryId.startsWith(`cursor-${direction}-`)
    )?.content?.value;
}

const proxyRoutes = [
    // Home timeline
    {
        path: "/1.1/statuses/home_timeline.json",
        method: "GET",
        beforeRequest: (xhr) => {
            try {
                let url = new URL(xhr.modUrl);
                let params = new URLSearchParams(url.search);
                let variables = {"count":40,"enableRanking":true,"includePromotedContent":true,"requestContext":"launch","seenTweetIds":[]};

                let max_id = params.get("max_id");
                let since_id = params.get("since_id");
                let user_id = xhr.modReqHeaders["x-act-as-user-id"] ?? params.get("user_id") ?? getCurrentUserId();
                if(params.get("user_id")) {
                    xhr.storage.user_id = params.get("user_id");
                }
                if (max_id) {
                    let bn = BigInt(params.get("max_id"));
                    bn += BigInt(1);
                    if (cursors[`home-${user_id}-${bn}`]) {
                        variables.cursor = cursors[`home-${user_id}-${bn}`];
                        // xhr.storage.cursor = true;
                    }
                }
                if (since_id) {
                    let bn = BigInt(params.get("since_id"));
                    if (cursors[`home-${user_id}-${bn}-top`]) {
                        variables.cursor = cursors[`home-${user_id}-${bn}-top`];
                        xhr.storage.cursor = true;
                        xhr.storage.since_id = since_id;
                    }
                }
                xhr.modUrl = `${NEW_API}/MR2EaMHFNTqPEFIodfclng/HomeLatestTimeline`;
                xhr.storage.body = JSON.stringify({ variables, features: TIMELINE_FEATURES, queryId: "MR2EaMHFNTqPEFIodfclng" });
            } catch (e) {
                console.error(e);
            }
        },
        openHandler: (xhr, method, url, async, username, password) => {
            let user_id = xhr.modReqHeaders["x-act-as-user-id"] ?? xhr.storage.user_id ?? getCurrentUserId();
            xhr.storage.user_id = user_id;
            if(!timings.home[user_id]) {
                timings.home[user_id] = 0;
            }
            if(Date.now() - timings.home[user_id] < refreshInterval && xhr.storage.cursor && Math.random() > 0.6) {
                xhr.storage.cancelled = true;
            } else {
                // GraphQL HomeLatestTimeline only accepts POST; the original XHR was GET.
                xhr.open("POST", url, async, username, password);
                timings.home[user_id] = Date.now();
            }
        },
        sendHandler: (xhr, data) => {
            if(xhr.storage.cancelled) {
                emulateResponse(xhr);
            } else {
                xhr.send(xhr.storage.body);
            }
        },
        beforeSendHeaders: (xhr) => {
            xhr.storage.user_id = xhr.modReqHeaders["x-act-as-user-id"] ?? getCurrentUserId();
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] = PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
            // updateFollows(xhr.storage.user_id);
        },
        afterRequest: (xhr) => {
            if(xhr.storage.cancelled) {
                return [];
            }
            if(xhr.storage.data) {
                return xhr.storage.data;
            }
            let data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                console.error(e);
                return [];
            }
            if (data.errors && data.errors[0]) {
                return [];
            }
            let instructions = data.data.home.home_timeline_urt.instructions;
            let entries = instructions.find((i) => i.type === "TimelineAddEntries");
            if (!entries) {
                return [];
            }
            entries = entries.entries;
            let tweets = [];
            for (let e of entries) {
                // thats a lot of trash https://lune.dimden.dev/0bf524e52eb.png
                if (e.entryId.startsWith("tweet-")) {
                    let res = e.content.itemContent.tweet_results.result;
                    let tweet = parseTweet(res);
                    if (!tweet) continue;
                    if (
                        tweet.source &&
                        (tweet.source.includes("Twitter for Advertisers") ||
                            tweet.source.includes("advertiser-interface"))
                    )
                        continue;
                    if (tweet.user.blocking || tweet.user.muting) continue;

                    tweets.push(tweet);
                } else if (e.entryId.startsWith("home-conversation-")) {
                    let items = e.content.items;

                    let pushTweets = [];
                    for (let i = 0; i < items.length; i++) {
                        let item = items[i];
                        if (
                            item.entryId.includes("-tweet-") &&
                            !item.entryId.includes("promoted")
                        ) {
                            let res = item.item.itemContent.tweet_results.result;
                            let tweet = parseTweet(res);
                            if (!tweet) continue;
                            if (
                                tweet.source &&
                                (tweet.source.includes("Twitter for Advertisers") ||
                                    tweet.source.includes("advertiser-interface"))
                            )
                                continue;
                            if (tweet.user.blocking || tweet.user.muting) break;
                            if (item.item.feedbackInfo) {
                                tweet.feedback = item.item.feedbackInfo.feedbackKeys
                                    .map(
                                        (f) =>
                                            data.data.home.home_timeline_urt.responseObjects.feedbackActions.find(
                                                (a) => a.key === f
                                            ).value
                                    )
                                    .filter((f) => f);
                                if (tweet.feedback) {
                                    tweet.feedbackMetadata =
                                        item.item.feedbackInfo.feedbackMetadata;
                                }
                            }
                            pushTweets.push(tweet);
                        }
                    }
                    if(!seenHomeTweets[xhr.storage.user_id]) {
                        seenHomeTweets[xhr.storage.user_id] = [];
                    }
                    for(let tweet of pushTweets) {
                        if(xhr.storage.since_id && seenHomeTweets[xhr.storage.user_id].includes(tweet.id_str)) continue;
                        seenHomeTweets[xhr.storage.user_id].push(tweet.id_str);
                        tweets.push(tweet);
                    }
                }
            }

            if (tweets.length === 0) return tweets;

            // i didn't know they return tweets unsorted???
            tweets.sort(
                (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            );
            if(!seenHomeTweets[xhr.storage.user_id]) {
                seenHomeTweets[xhr.storage.user_id] = [];
            }
            for(let tweet of tweets) {
                if(seenHomeTweets[xhr.storage.user_id].includes(tweet.id_str)) continue;
                seenHomeTweets[xhr.storage.user_id].push(tweet.id_str);
            }

            let bottomCursor = findCursor(entries, "bottom");
            if (bottomCursor) {
                cursors[`home-${xhr.storage.user_id}-${tweets[tweets.length - 1].id_str}`] = bottomCursor;
            }
            let topCursor = findCursor(entries, "top");
            if (topCursor) {
                if(tweets[0]) cursors[`home-${xhr.storage.user_id}-${tweets[0].id_str}-top`] = topCursor;
                if(tweets[1]) cursors[`home-${xhr.storage.user_id}-${tweets[1].id_str}-top`] = topCursor;
            }

            xhr.storage.data = tweets;

            return tweets;
        },
    },
    // List timeline
    {
        path: "/1.1/lists/statuses.json",
        method: "GET",
        beforeRequest: (xhr) => {
            try {
                let url = new URL(xhr.modUrl);
                let params = new URLSearchParams(url.search);
                let variables = { count: 40, includePromotedContent: false };
                let features = {"rweb_video_screen_enabled":false,"payments_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"rweb_tipjar_consumption_enabled":true,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":true,"responsive_web_jetfuel_frame":true,"responsive_web_grok_share_attachment_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"tweet_awards_web_tipping_enabled":false,"responsive_web_grok_show_grok_translated_post":true,"responsive_web_grok_analysis_button_from_backend":false,"creator_subscriptions_quote_tweet_preview_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":true,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_grok_community_note_auto_translation_is_enabled":false,"responsive_web_enhance_cards_enabled":false};

                let list_id = params.get("list_id");
                let max_id = params.get("max_id");
                let since_id = params.get("since_id");
                if (max_id) {
                    let bn = BigInt(params.get("max_id"));
                    bn += BigInt(1);
                    if (cursors[`list-${list_id}-${bn}`]) {
                        variables.cursor = cursors[`list-${list_id}-${bn}`];
                        xhr.storage.cursor = true;
                    }
                }
                if (since_id) {
                    let bn = BigInt(params.get("since_id"));
                    if (cursors[`list-${list_id}-${bn}-top`]) {
                        variables.cursor = cursors[`list-${list_id}-${bn}-top`];
                        xhr.storage.cursor = true;
                    }
                }
                variables.listId = list_id;
                xhr.storage.list_id = list_id;
                xhr.modUrl = `${NEW_API}/l411pL-GRg-AKo_a2rmYjg/ListLatestTweetsTimeline?${generateParams(
                    features,
                    variables
                )}`;
            } catch (e) {
                console.error(e);
            }
        },
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] = PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
        },
        openHandler: (xhr, method, url, async, username, password) => {
            const list_id = xhr.storage.list_id;
            if(!timings.list[list_id]) {
                timings.list[list_id] = 0;
            }
            if(Date.now() - timings.list[list_id] < refreshInterval && xhr.storage.cursor) {
                xhr.storage.cancelled = true;
            } else {
                xhr.open(method, url, async, username, password);
                timings.list[list_id] = Date.now();
            }
        },
        sendHandler: (xhr, data) => {
            if(xhr.storage.cancelled) {
                emulateResponse(xhr);
            } else {
                xhr.send(data);
            }
        },
        afterRequest: (xhr) => {
            if(xhr.storage.cancelled) {
                return [];
            }
            let data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                console.error(e);
                return [];
            }
            let list = data?.data?.list?.tweets_timeline?.timeline?.instructions?.find(
                (i) => i.type === "TimelineAddEntries"
            );
            if (!list) return [];
            list = list.entries;
            let tweets = [];
            for (let e of list) {
                if (e.entryId.startsWith("tweet-")) {
                    let res = e.content.itemContent.tweet_results.result;
                    let tweet = parseTweet(res);
                    if (tweet) {
                        tweets.push(tweet);
                    }
                } else if (e.entryId.startsWith("list-conversation-")) {
                    let lt = e.content.items;
                    for (let i = 0; i < lt.length; i++) {
                        let t = lt[i];
                        if (t.entryId.includes("-tweet-")) {
                            let res = t.item.itemContent.tweet_results.result;
                            let tweet = parseTweet(res);
                            if (!tweet) continue;
                            tweets.push(tweet);
                        }
                    }
                }
            }

            if (tweets.length === 0) return tweets;

            tweets = tweets.filter(t => !t.user.muting && !t.user.blocking);

            // i didn't know they return tweets unsorted???
            tweets.sort(
                (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            )

            let bottomCursor = findCursor(list, "bottom");
            if (bottomCursor) {
                cursors[`list-${xhr.storage.list_id}-${tweets[tweets.length - 1].id_str}`] = bottomCursor;
            }
            let topCursor = findCursor(list, "top");
            if (topCursor) {
                if(tweets[0]) cursors[`list-${xhr.storage.list_id}-${tweets[0].id_str}-top`] = topCursor;
                if(tweets[1]) cursors[`list-${xhr.storage.list_id}-${tweets[1].id_str}-top`] = topCursor;
            }

            return tweets;
        },
    },
    // User timeline
    {
        path: "/1.1/statuses/user_timeline.json",
        method: "GET",
        beforeRequest: (xhr) => {
            try {
                let url = new URL(xhr.modUrl);
                let params = new URLSearchParams(url.search);
                let user_id = params.get("user_id");
                let variables = {
                    count: 20,
                    includePromotedContent: false,
                    withCommunity: true,
                    withVoice: true,
                };

                if (!user_id) {
                    variables.userId = getCurrentUserId();
                } else {
                    variables.userId = user_id;
                }
                let since_id = params.get("since_id");
                let max_id = params.get("max_id");
                if (max_id) {
                    let bn = BigInt(params.get("max_id"));
                    bn += BigInt(1);
                    if (cursors[`${variables.userId}-${bn}`]) {
                        variables.cursor = cursors[`${variables.userId}-${bn}`];
                        xhr.storage.cursor = true;
                    }
                }
                if (since_id) {
                    let bn = BigInt(params.get("since_id"));
                    if (cursors[`${variables.userId}-${bn}-top`]) {
                        variables.cursor = cursors[`${variables.userId}-${bn}-top`];
                        xhr.storage.cursor = true;
                    }
                }
                xhr.storage.user_id = variables.userId;

                xhr.modUrl = `${NEW_API}/Yhdsu6wWbof5lwXjYqxXEg/UserTweetsAndReplies?${generateParams(
                    TIMELINE_FEATURES,
                    variables,
                    { withArticlePlainText: false }
                )}`;
            } catch (e) {
                console.error(e);
            }
        },
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] =
                PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
            // delete xhr.modReqHeaders["x-act-as-user-id"];
        },
        openHandler: (xhr, method, url, async, username, password) => {
            const user_id = xhr.storage.user_id;
            if(!timings.user[user_id]) {
                timings.user[user_id] = 0;
            }
            if(Date.now() - timings.user[user_id] < refreshInterval && xhr.storage.cursor) {
                xhr.storage.cancelled = true;
            } else {
                xhr.open(method, url, async, username, password);
                timings.user[user_id] = Date.now();
            }
        },
        sendHandler: (xhr, data) => {
            if(xhr.storage.cancelled) {
                emulateResponse(xhr);
            } else {
                xhr.send(data);
            }
        },
        afterRequest: (xhr) => {
            if(xhr.storage.cancelled) {
                return [];
            }
            let data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                console.error(e);
                return [];
            }
            let timeline = data?.data?.user?.result?.timeline ?? data?.data?.user?.result?.timeline_v2;
            let instructions = timeline?.timeline?.instructions;
            let entries = instructions?.find((e) => e.type === "TimelineAddEntries");
            if (!entries) {
                return [];
            }
            entries = entries.entries;
            let tweets = [];
            for (let entry of entries) {
                if (entry.entryId.startsWith("tweet-")) {
                    let result = entry.content.itemContent.tweet_results.result;
                    let tweet = parseTweet(result);
                    if (tweet) {
                        tweets.push(tweet);
                    }
                } else if (entry.entryId.startsWith("profile-conversation-")) {
                    let items = entry.content.items;
                    for (let i = 0; i < items.length; i++) {
                        let item = items[i];
                        let result = item.item.itemContent.tweet_results.result;
                        if (item.entryId.includes("-tweet-")) {
                            let tweet = parseTweet(result);
                            if (tweet && tweet.user.id_str === xhr.storage.user_id) {
                                tweets.push(tweet);
                            }
                        }
                    }
                }
            }

            if (tweets.length === 0) return tweets;

            // i didn't know they return tweets unsorted???
            tweets.sort(
                (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            );

            let bottomCursor = findCursor(entries, "bottom");
            if (bottomCursor) {
                cursors[`${xhr.storage.user_id}-${tweets[tweets.length - 1].id_str}`] = bottomCursor;
            }
            let topCursor = findCursor(entries, "top");
            if (topCursor) {
                if(tweets[0]) cursors[`${xhr.storage.user_id}-${tweets[0].id_str}-top`] = topCursor;
                if(tweets[1]) cursors[`${xhr.storage.user_id}-${tweets[1].id_str}-top`] = topCursor;
            }

            let pinEntry = instructions.find((e) => e.type === "TimelinePinEntry");
            if (
                pinEntry &&
                pinEntry.entry &&
                pinEntry.entry.content &&
                pinEntry.entry.content.itemContent
            ) {
                let result = pinEntry.entry.content.itemContent.tweet_results.result;
                let pinnedTweet = parseTweet(result);
                if (pinnedTweet) {
                    let tweetTimes = tweets.map((t) => [
                        t.id_str,
                        new Date(t.created_at).getTime(),
                    ]);
                    tweetTimes.push([
                        pinnedTweet.id_str,
                        new Date(pinnedTweet.created_at).getTime(),
                    ]);
                    tweetTimes.sort((a, b) => b[1] - a[1]);
                    let index = tweetTimes.findIndex((t) => t[0] === pinnedTweet.id_str);
                    if (index !== tweets.length) {
                        tweets.splice(index, 0, pinnedTweet);
                    }
                }
            }

            return tweets;
        },
    },
    // Bookmarks timeline
    {
        path: "/1.1/statuses/bookmarks.json",
        method: "GET",
        beforeRequest: (xhr) => {
            try {
                let url = new URL(xhr.modUrl);
                let params = new URLSearchParams(url.search);
                let variables = {
                    "count": 40,
                    "includePromotedContent":false
                };
                let features = {"graphql_timeline_v2_bookmark_timeline":true,"blue_business_profile_image_shape_enabled":true,"responsive_web_graphql_exclude_directive_enabled":true,"verified_phone_label_enabled":false,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"tweetypie_unmention_optimization_enabled":true,"vibe_api_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"responsive_web_grok_show_grok_translated_post":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"tweet_awards_web_tipping_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":false,"interactive_text_enabled":true,"responsive_web_text_conversations_enabled":false,"longform_notetweets_rich_text_read_enabled":true,"responsive_web_enhance_cards_enabled":false};

                let max_id = params.get("max_id");
                if (max_id) {
                    let bn = BigInt(params.get("max_id"));
                    bn += BigInt(1);
                    if (cursors[`bookmarks-${bn}`]) {
                        variables.cursor = cursors[`bookmarks-${bn}`];
                    }
                    if(bookmarkTimes[`${bn}`]) {
                        xhr.storage.time = bookmarkTimes[`${bn}`];
                    }
                }

                xhr.modUrl = `${NEW_API}/3OjEFzT2VjX-X7w4KYBJRg/Bookmarks?${generateParams(
                    features,
                    variables
                )}`;
            } catch (e) {
                console.error(e);
            }
        },
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] =
                PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
            // delete xhr.modReqHeaders["x-act-as-user-id"];
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
        afterRequest: (xhr) => {
            let data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                console.error(e);
                return [];
            }
            // if (data.errors && data.errors[0]) {
            //     return [];
            // }
            let instructions = data?.data?.bookmark_timeline_v2?.timeline?.instructions;
            let entries = instructions?.find((e) => e.type === "TimelineAddEntries");
            if (!entries) {
                return [];
            }
            entries = entries.entries;
            let tweets = [];
            for (let entry of entries) {
                if (entry.entryId.startsWith("tweet-")) {
                    let result = entry.content.itemContent.tweet_results.result;
                    let tweet = parseTweet(result);
                    if (tweet) {
                        tweets.push(tweet);
                    }
                } else if (entry.entryId.startsWith("profile-conversation-")) {
                    let items = entry.content.items;
                    for (let i = 0; i < items.length; i++) {
                        let item = items[i];
                        let result = item.item.itemContent.tweet_results.result;
                        if (item.entryId.includes("-tweet-")) {
                            let tweet = parseTweet(result);
                            if (tweet && tweet.user.id_str === xhr.storage.user_id) {
                                tweets.push(tweet);
                            }
                        }
                    }
                }
            }

            if (tweets.length === 0) return tweets;

            for(let i = 0; i < tweets.length; i++) {
                const tweet = tweets[i];
                tweet.receiveTime = bookmarkTimes[tweet.id_str] ?? ((xhr.storage.time ?? Date.now()) - i);
                bookmarkTimes[tweet.id_str] = tweet.receiveTime;
            }

            let cursor = findCursor(entries, "bottom");
            if (cursor) {
                cursors[`bookmarks-${tweets[tweets.length - 1].id_str}`] = cursor;
            }

            return tweets;
        },
    },
    // Notifications column
    {
        path: "/1.1/activity/about_me.json",
        method: "GET",
        beforeRequest: (xhr) => {
            const params = new URLSearchParams(xhr.modUrl);
            const since_id = params.get("since_id");
            const max_id = params.get("max_id");
            const user_id = xhr.modReqHeaders["x-act-as-user-id"] ?? params.get("user_id") ?? getCurrentUserId();
            let cursor;
            if(since_id && cursors[`notifications-${user_id}-top`]) {
                cursor = cursors[`notifications-${user_id}-top`];
            } else if(max_id && cursors[`notifications-${user_id}-bottom`]) {
                cursor = cursors[`notifications-${user_id}-bottom`];
            }

            xhr.modUrl = `https://${location.hostname}/i/api/2/notifications/all.json?include_profile_interstitial_type=1&include_blocking=1&include_blocked_by=1&include_followed_by=1&include_want_retweets=1&include_mute_edge=1&include_can_dm=1&include_can_media_tag=1&include_ext_has_nft_avatar=1&include_ext_is_blue_verified=1&include_ext_verified_type=1&include_ext_profile_image_shape=1&skip_status=1&cards_platform=Web-12&include_cards=1&include_ext_alt_text=true&include_ext_limited_action_results=true&include_quote_count=true&include_reply_count=1&tweet_mode=extended&include_ext_views=true&include_entities=true&include_user_entities=true&include_ext_media_color=true&include_ext_media_availability=true&include_ext_sensitive_media_warning=true&include_ext_trusted_friends_metadata=true&send_error_codes=true&simple_quoted_tweet=true&count=20&requestContext=launch&ext=mediaStats%2ChighlightedLabel%2ChasNftAvatar%2CvoiceInfo%2CbirdwatchPivot%2CsuperFollowMetadata%2CunmentionInfo%2CeditControl${cursor ? `&cursor=${cursor}` : ''}`;
        },
        beforeSendHeaders: (xhr) => {
            xhr.storage.user_id = xhr.modReqHeaders["x-act-as-user-id"] ?? getCurrentUserId();
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = navigator.language.split("-")[0];
            xhr.modReqHeaders["Authorization"] =
                PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
        },
        afterRequest: (xhr) => {
            if(xhr.storage.notifications) {
                return xhr.storage.notifications;
            }
            try {
                const response = JSON.parse(xhr.responseText);
                const entries = response.timeline.instructions.find((i) => i.addEntries).addEntries.entries;
                const go = response.globalObjects;
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
                xhr.storage.notifications = notifications;
                const cursorTop = entries.find(
                    (e) =>
                        e.entryId.startsWith("sq-cursor-top-") ||
                        e.entryId.startsWith("cursor-top-")
                )?.content?.operation?.cursor?.value;
                if(cursorTop) {
                    cursors[`notifications-${xhr.storage.user_id}-top`] = cursorTop;
                }
                const cursorBottom = entries.find(
                    (e) =>
                        e.entryId.startsWith("sq-cursor-bottom-") ||
                        e.entryId.startsWith("cursor-bottom-")
                )?.content?.operation?.cursor?.value;
                if(cursorBottom) {
                    cursors[`notifications-${xhr.storage.user_id}-bottom`] = cursorBottom;
                }
                return notifications;
            } catch (e) {
                console.error(`Error parsing notifications`, e);
                return [];
            }
        },
    },
    // Mentions timeline
    {
        path: "/1.1/statuses/mentions_timeline.json",
        method: "GET",
        beforeRequest: (xhr) => {
            const params = new URLSearchParams(xhr.modUrl);
            const since_id = params.get("since_id");
            const max_id = params.get("max_id");
            const user_id = xhr.modReqHeaders["x-act-as-user-id"] ?? params.get("user_id") ?? getCurrentUserId();
            xhr.storage.user_id = user_id;
            let cursor;
            if(since_id && cursors[`mentions-${user_id}-top`]) {
                cursor = cursors[`mentions-${user_id}-top`];
            } else if(max_id && cursors[`mentions-${user_id}-bottom`]) {
                cursor = cursors[`mentions-${user_id}-bottom`];
            }

            xhr.modUrl = `https://${location.hostname}/i/api/2/notifications/mentions.json?include_profile_interstitial_type=1&include_blocking=1&include_blocked_by=1&include_followed_by=1&include_want_retweets=1&include_mute_edge=1&include_can_dm=1&include_can_media_tag=1&include_ext_has_nft_avatar=1&include_ext_is_blue_verified=1&include_ext_verified_type=1&include_ext_profile_image_shape=1&skip_status=1&cards_platform=Web-12&include_cards=1&include_ext_alt_text=true&include_ext_limited_action_results=true&include_quote_count=true&include_reply_count=1&tweet_mode=extended&include_ext_views=true&include_entities=true&include_user_entities=true&include_ext_media_color=true&include_ext_media_availability=true&include_ext_sensitive_media_warning=true&include_ext_trusted_friends_metadata=true&send_error_codes=true&simple_quoted_tweet=true&count=20&requestContext=launch&ext=mediaStats%2ChighlightedLabel%2ChasNftAvatar%2CvoiceInfo%2CbirdwatchPivot%2CsuperFollowMetadata%2CunmentionInfo%2CeditControl${cursor ? `&cursor=${cursor}` : ''}`;
        },
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] = PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
        },
        afterRequest: (xhr) => {
            try {
                const response = JSON.parse(xhr.responseText);
                const entries = response.timeline.instructions.find((i) => i.addEntries).addEntries.entries;
                const go = response.globalObjects;
                const tweets = [];
                for(let entry of entries) {
                    if(entry.entryId.startsWith("notification-")) {
                        const sortIndex = entry.sortIndex;
                        const item = entry.content.item;
                        const type = item.clientEventInfo.element;

                        switch(type) {
                            case "user_mentioned_you":
                            case "user_replied_to_your_tweet": 
                            case "user_quoted_your_tweet":{
                                const tweetId = item.content.tweet.id;
                                const tweet = go.tweets[tweetId];
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
                }
                const cursorTop = entries.find(
                    (e) =>
                        e.entryId.startsWith("sq-cursor-top-") ||
                        e.entryId.startsWith("cursor-top-")
                )?.content?.operation?.cursor?.value;
                if(cursorTop) {
                    cursors[`mentions-${xhr.storage.user_id}-top`] = cursorTop;
                }
                const cursorBottom = entries.find(
                    (e) =>
                        e.entryId.startsWith("sq-cursor-bottom-") ||
                        e.entryId.startsWith("cursor-bottom-")
                )?.content?.operation?.cursor?.value;
                if(cursorBottom) {
                    cursors[`mentions-${xhr.storage.user_id}-bottom`] = cursorBottom;
                }
                
                return tweets;
            } catch (e) {
                console.error(`Error parsing mentions`, e);
                return [];
            }
        }
    },
    // User likes timeline
    {
        path: "/1.1/favorites/list.json",
        method: "GET",
        beforeRequest: (xhr) => {
            try {
                let url = new URL(xhr.modUrl);
                let params = new URLSearchParams(url.search);
                let user_id = params.get("user_id") ?? getCurrentUserId();
                let variables = {
                    "userId": user_id,
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
                let features = {
                    "dont_mention_me_view_api_enabled": true,
                    "interactive_text_enabled": true,
                    "responsive_web_uc_gql_enabled": false,
                    "vibe_tweet_context_enabled": false,
                    "responsive_web_edit_tweet_api_enabled": false,
                    "standardized_nudges_misinfo": false,
                    "responsive_web_enhance_cards_enabled": false
                };

                let max_id = params.get("max_id");
                if (max_id) {
                    let bn = BigInt(params.get("max_id"));
                    bn += BigInt(1);
                    if (cursors[`${variables.userId}-${bn}-likes`]) {
                        variables.cursor = cursors[`${variables.userId}-${bn}-likes`];
                    }
                }
                xhr.storage.user_id = variables.userId;

                xhr.modUrl = `${NEW_API}/vni8vUvtZvJoIsl49VPudg/Likes?${generateParams(
                    features,
                    variables
                )}`;
            } catch (e) {
                console.error(e);
            }
        },
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] =
                PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
            // delete xhr.modReqHeaders["x-act-as-user-id"];
        },
        afterRequest: (xhr) => {
            let data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                console.error(e);
                return [];
            }
            // if (data.errors && data.errors[0]) {
            //     return [];
            // }
            let timeline = data?.data?.user?.result?.timeline ?? data?.data?.user?.result?.timeline_v2;
            let instructions = timeline?.timeline?.instructions;
            let entries = instructions?.find((e) => e.type === "TimelineAddEntries");
            if (!entries) {
                return [];
            }
            entries = entries.entries;

            let tweets = entries
                .filter(e => e.entryId.startsWith('tweet-') && e.content.itemContent.tweet_results.result)
                .map(e => parseTweet(e.content.itemContent.tweet_results.result))
                .filter(e => e);

            if (tweets.length === 0) return tweets;

            let cursor = findCursor(entries, "bottom");
            if (cursor) {
                cursors[`${xhr.storage.user_id}-${tweets[tweets.length - 1].id_str}-likes`] = cursor;
            }

            // i didn't know they return tweets unsorted???
            tweets.sort(
                (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            );

            return tweets;
        },
    },
    // Liking / unliking
    {
        path: /\/1\.1\/favorites\/.*\.json/,
        method: "POST",
        beforeRequest: (xhr) => {
            const isFavorite = xhr.modUrl.includes("create.json");
            xhr.storage.isFavorite = isFavorite;

            xhr.modUrl = isFavorite ? 
                `https://${location.hostname}/i/api/graphql/lI07N6Otwv1PhnEgXILM7A/FavoriteTweet` : 
                `https://${location.hostname}/i/api/graphql/ZYKSe-w7KEslx3JhSIk5LA/UnfavoriteTweet`;
        },
        sendHandler: (xhr, data) => {
            const tweet_id = new URLSearchParams(data).get("id");
            xhr.send(JSON.stringify({"variables":{"tweet_id":tweet_id},"queryId":xhr.storage.isFavorite ? "lI07N6Otwv1PhnEgXILM7A" : "ZYKSe-w7KEslx3JhSIk5LA"}));
        },
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] = PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
        },
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
    // User profile
    {
        path: "/1.1/users/show.json",
        method: "GET",
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] = PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
        },
    },
    // Search
    {
        path: "/1.1/search/universal.json",
        method: "GET",
        beforeRequest: (xhr) => {
            try {
                let url = new URL(xhr.modUrl);
                let params = new URLSearchParams(url.search);
                let variables = {
                    rawQuery: params.get("q"),
                    count: 20,
                    querySource: "typed_query",
                    product: "Latest",
                    withGrokTranslatedBio: false,
                    withQuickPromoteEligibilityTweetFields: false,
                };

                xhr.storage.query = variables.rawQuery;
                xhr.storage.cursor = params.get("since_id");
                xhr.modUrl = `${NEW_API}/099UqLkXma7fhT81Jv4n9g/SearchTimeline?${generateParams(
                    TIMELINE_FEATURES,
                    variables
                )}`;
            } catch (e) {
                console.error(e);
            }
        },
        openHandler: (xhr, method, url, async, username, password) => {
            if(!timings.search[xhr.storage.query]) {
                timings.search[xhr.storage.query] = 0;
            }
            if(Date.now() - timings.search[xhr.storage.query] < 60000*1.5 && xhr.storage.cursor) {
                xhr.storage.cancelled = true;
            } else {
                xhr.open(method, url, async, username, password);
                timings.search[xhr.storage.query] = Date.now();
            }
        },
        sendHandler: (xhr, data) => {
            if(xhr.storage.cancelled) {
                emulateResponse(xhr);
            } else {
                xhr.send(data);
            }
        },
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] =
                PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
        },
        afterRequest: (xhr) => {
            const empty = { metadata: { cursor: null, refresh_interval_in_sec: 30 }, modules: [] };
            if(xhr.storage.cancelled) {
                return empty;
            }
            let data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                console.warn("Search response unparseable", { status: xhr.status, body: xhr.responseText?.slice(0, 200) }, e);
                return empty;
            }
            // if (data.errors && data.errors[0]) {
            //     return empty;
            // }
            let instructions = data?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
            let entries = instructions?.find((i) => i.entries);
            if (!entries) {
                return empty;
            }
            entries = entries.entries;
            let res = [];
            for (let entry of entries) {
                if (entry.entryId.startsWith("sq-I-t-") || entry.entryId.startsWith("tweet-")) {
                    let result = entry.content.itemContent.tweet_results.result;

                    if (entry.content.itemContent.promotedMetadata) {
                        continue;
                    }
                    let tweet = parseTweet(result);
                    if (!tweet) {
                        continue;
                    }
                    if (tweet.user.blocking || tweet.user.muting) continue;
                    res.push(tweet);
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

            return {
                metadata: {
                    cursor,
                    refresh_interval_in_sec: 30,
                },
                modules: res.map((t) => ({ status: { data: t } })),
            };
        },
    },
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
                let features = {
                    rweb_lists_timeline_redesign_enabled: false,
                    responsive_web_graphql_exclude_directive_enabled: true,
                    verified_phone_label_enabled: false,
                    creator_subscriptions_tweet_preview_api_enabled: true,
                    responsive_web_graphql_timeline_navigation_enabled: true,
                    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
                    tweetypie_unmention_optimization_enabled: true,
                    responsive_web_edit_tweet_api_enabled: true,
                    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
                    view_counts_everywhere_api_enabled: true,
                    longform_notetweets_consumption_enabled: true,
                    responsive_web_twitter_article_tweet_consumption_enabled: false,
                    tweet_awards_web_tipping_enabled: false,
                    freedom_of_speech_not_reach_fetch_enabled: true,
                    standardized_nudges_misinfo: true,
                    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
                    longform_notetweets_rich_text_read_enabled: true,
                    longform_notetweets_inline_media_enabled: true,
                    responsive_web_media_download_video_enabled: false,
                    responsive_web_enhance_cards_enabled: false,
                };

                xhr.modUrl = `${NEW_API}/nK1dw4oV3k4w5TdtcAdSww/SearchTimeline?${generateParams(
                    features,
                    variables
                )}`;
            } catch (e) {
                console.error(e);
            }
        },
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] =
                PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
        },
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
            xhr.modUrl = `https://${location.hostname}/i/api/graphql/oB-5XsHNAbjvARJEc8CZFw/CreateTweet`;
        },
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] = PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
        },
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

            return JSON.stringify({
                variables,
                features: {"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"tweetypie_unmention_optimization_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"tweet_awards_web_tipping_enabled":false,"creator_subscriptions_quote_tweet_preview_enabled":false,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":true,"articles_preview_enabled":true,"rweb_video_timestamps_enabled":true,"rweb_tipjar_consumption_enabled":true,"responsive_web_graphql_exclude_directive_enabled":true,"verified_phone_label_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"responsive_web_graphql_skip_user_profile_image_extensions_enabled":false,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_enhance_cards_enabled":false},
                queryId: "oB-5XsHNAbjvARJEc8CZFw",
            });
        },
        afterRequest: (xhr) => {
            let data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                console.error(e);
                return {};
            }
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
            xhr.modUrl = `https://${location.hostname}/i/api/graphql/ojPdsZsimiJrUGLR1sjUtA/CreateRetweet`;
        },
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] = PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
            if (xhr.modReqHeaders["x-act-as-user-id"]) {
                xhr.storage.retweeter = xhr.modReqHeaders["x-act-as-user-id"];
            }
        },
        beforeSendBody: (xhr, body) => {
            return JSON.stringify({
                variables: {
                    tweet_id: xhr.storage.tweet_id,
                    dark_request: false,
                },
                queryId: "ojPdsZsimiJrUGLR1sjUtA",
            });
        },
        afterRequest: (xhr) => {
            let data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                console.error(e);
                return {};
            }
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
            xhr.modUrl = `https://${location.hostname}/i/api/graphql/iQtK4dl5hBmXewYZuEOKVw/DeleteRetweet`;
        },
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] =
                PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
            if (xhr.modReqHeaders["x-act-as-user-id"]) {
                xhr.storage.retweeter = xhr.modReqHeaders["x-act-as-user-id"];
            }
        },
        beforeSendBody: (xhr, body) => {
            return JSON.stringify({
                variables: { source_tweet_id: xhr.storage.tweet_id, dark_request: false },
                queryId: "iQtK4dl5hBmXewYZuEOKVw",
            });
        },
        afterRequest: (xhr) => {
            let data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                console.error(e);
                return {};
            }
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
            xhr.modUrl = `https://${location.hostname}/i/api/graphql/KwGBbJZc6DBx8EKmyQSP7g/TweetDetail?variables=${encodeURIComponent(
                JSON.stringify({
                    focalTweetId: xhr.storage.tweet_id,
                    with_rux_injections: false,
                    includePromotedContent: false,
                    withCommunity: true,
                    withQuickPromoteEligibilityTweetFields: true,
                    withBirdwatchNotes: true,
                    withVoice: true,
                    withV2Timeline: true,
                })
            )}&features=${encodeURIComponent(JSON.stringify(TWEET_DETAIL_FEATURES))}`;
        },
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] =
                PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
        },
        afterRequest: (xhr) => {
            let data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                console.error(e);
                return {};
            }
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
            xhr.modUrl = `https://${location.hostname}/i/api/graphql/KwGBbJZc6DBx8EKmyQSP7g/TweetDetail?variables=${encodeURIComponent(
                JSON.stringify({
                    focalTweetId: xhr.storage.tweet_id,
                    with_rux_injections: false,
                    includePromotedContent: false,
                    withCommunity: true,
                    withQuickPromoteEligibilityTweetFields: true,
                    withBirdwatchNotes: true,
                    withVoice: true,
                    withV2Timeline: true,
                })
            )}&features=${encodeURIComponent(JSON.stringify(TWEET_DETAIL_FEATURES))}`;
        },
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] =
                PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
        },
        afterRequest: (xhr) => {
            let data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                console.error(e);
                return {};
            }
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
            xhr.modUrl = `https://${location.hostname}/i/api/graphql/VaenaVgh5q5ih7kvyVjgtg/DeleteTweet`;
        },
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] =
                PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
        },
        beforeSendBody: (xhr, body) => {
            return JSON.stringify({
                variables: { tweet_id: xhr.storage.tweet_id, dark_request: false },
                queryId: "VaenaVgh5q5ih7kvyVjgtg",
            });
        },
    },
    // Tweet replies
    {
        path: /\/2\/timeline\/conversation\/(\d+).json/,
        method: "GET",
        beforeRequest: (xhr) => {
            let originalUrl = new URL(xhr.originalUrl);
            let params = new URLSearchParams(originalUrl.search);

            params.delete("ext");
            params.delete("include_ext_has_nft_avatar");
            params.delete("include_ext_is_blue_verified");
            params.delete("include_ext_verified_type");
            params.delete("include_ext_sensitive_media_warning");
            params.delete("include_ext_media_color");

            originalUrl.search = params.toString();

            xhr.modUrl = originalUrl.toString();
        },
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] =
                PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
        },
        afterRequest: (xhr) => {
            let data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                console.error(e);
                return data;
            }
            if (data.errors && data.errors[0]) {
                return data;
            }
            for (let id in data.globalObjects.tweets) {
                let tweet = data.globalObjects.tweets[id];

                if (!tweet.contributors) tweet.contributors = null;
                if (tweet.conversation_id_str)
                    tweet.conversation_id = parseInt(tweet.conversation_id_str);
                if (!tweet.coordinates) tweet.coordinates = null;
                if (!tweet.conversation_muted) tweet.conversation_muted = false;
                if (!tweet.favorited) tweet.favorited = false;
                if (!tweet.geo) tweet.geo = null;
                if (!tweet.id) tweet.id = parseInt(id);
                if (!tweet.in_reply_to_screen_name) tweet.in_reply_to_screen_name = null;
                if (!tweet.in_reply_to_status_id) tweet.in_reply_to_status_id = null;
                if (!tweet.in_reply_to_status_id_str) tweet.in_reply_to_status_id_str = null;
                if (!tweet.in_reply_to_user_id) tweet.in_reply_to_user_id = null;
                if (!tweet.in_reply_to_user_id_str) tweet.in_reply_to_user_id_str = null;
                if (!tweet.is_quote_status) tweet.is_quote_status = false;
                if (!tweet.place) tweet.place = null;
                if (!tweet.supplemental_language) tweet.supplemental_language = null;
                if (!tweet.retweeted) tweet.retweeted = false;
                if (!tweet.truncated) tweet.truncated = false;
                if (!tweet.user_id) tweet.user_id = parseInt(tweet.user_id_str);
            }

            for (let id in data.globalObjects.users) {
                let user = data.globalObjects.users[id];

                if (!user.default_profile) user.default_profile = false;
                if (!user.default_profile_image) user.default_profile_image = false;
                if (!user.entities.description) user.entities.description = { urls: [] };
                if (!user.entities.description.urls) user.entities.description.urls = [];
                if (!user.entities.url) user.entities.url = { urls: [] };
                if (!user.entities.url.urls) user.entities.url.urls = [];
                if (!user.follow_request_sent) user.follow_request_sent = false;
                if (!user.following) user.following = false;
                if (!user.has_extended_profile) user.has_extended_profile = false;
                if (!user.is_translation_enabled) user.is_translation_enabled = false;
                if (!user.is_translator) user.is_translator = false;
                if (!user.followed_by) user.followed_by = false;
                if (!user.id) user.id = parseInt(id);
                if (!user.lang) user.lang = null;
                if (!user.notifications) user.notifications = false;
                if (!user.profile_background_color) user.profile_background_color = "C0DEED";
                if (!user.profile_background_image_url)
                    user.profile_background_image_url =
                        "http://abs.twimg.com/images/themes/theme1/bg.png";
                if (!user.profile_background_image_url_https)
                    user.profile_background_image_url_https =
                        "https://abs.twimg.com/images/themes/theme1/bg.png";
                if (!user.profile_background_tile) user.profile_background_tile = false;
                if (!user.profile_link_color) user.profile_link_color = "1DA1F2";
                if (!user.profile_image_url && user.profile_image_url_https)
                    user.profile_image_url = user.profile_image_url_https.replace(
                        "https://",
                        "http://"
                    );
                if (!user.profile_sidebar_border_color)
                    user.profile_sidebar_border_color = "000000";
                if (!user.profile_sidebar_fill_color) user.profile_sidebar_fill_color = "DDEEF6";
                if (!user.profile_text_color) user.profile_text_color = "333333";
                if (!user.profile_use_background_image) user.profile_use_background_image = true;
                if (!user.protected) user.protected = false;
                if (!user.require_some_consent) user.require_some_consent = false;
                if (!user.time_zone) user.time_zone = null;
                if (!user.utc_offset) user.utc_offset = null;
                if (!user.verified) user.verified = false;
            }

            let entries = data.timeline.instructions.find((i) => i.addEntries);
            if (entries) {
                entries.addEntries.entries = entries.addEntries.entries.filter(
                    (e) => !e.entryId.startsWith("tweetComposer-")
                );
                for (let entry of entries.addEntries.entries) {
                    if (entry.entryId.startsWith("conversationThread-")) {
                        let newContent = {
                            item: {
                                content: {
                                    conversationThread: {
                                        conversationComponents: [],
                                    },
                                },
                            },
                        };
                        if (entry.content.timelineModule.items)
                            for (let item of entry.content.timelineModule.items) {
                                if (item.item && item.item.content && item.item.content.tweet) {
                                    newContent.item.content.conversationThread.conversationComponents.push(
                                        {
                                            conversationTweetComponent: {
                                                tweet: item.item.content.tweet,
                                            },
                                        }
                                    );
                                }
                            }
                        entry.content = newContent;
                    }
                }
            }

            return data;
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
            // delete xhr.modReqHeaders["Content-Type"];
            // delete xhr.modReqHeaders["X-Twitter-Active-User"];
            // delete xhr.modReqHeaders["X-Twitter-Client-Language"];
            // delete xhr.modReqHeaders["X-Twitter-Auth-Type"];
            // delete xhr.modReqHeaders["Authorization"];
            // delete xhr.modReqHeaders["X-Csrf-Token"];
            xhr.storage.user_id = xhr.modReqHeaders["x-act-as-user-id"];
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = "en";
            xhr.modReqHeaders["Authorization"] =
                PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];

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
        beforeSendHeaders: (xhr) => {
            xhr.modReqHeaders["Content-Type"] = "application/json";
            xhr.modReqHeaders["X-Twitter-Active-User"] = "yes";
            xhr.modReqHeaders["X-Twitter-Client-Language"] = navigator.language.split("-")[0];
            xhr.modReqHeaders["Authorization"] =
                PUBLIC_TOKENS[0];
            delete xhr.modReqHeaders["X-Twitter-Client-Version"];
        },
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
            const state = {
                client: {
                    columns: localStorage.OTDcolumnIds ? JSON.parse(localStorage.OTDcolumnIds) : [],
                    mtime: new Date().toISOString(),
                    name: "blackbird",
                    settings: settings ?? {
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
                    },
                },
                columns: columns ?? {},
                decider: {},
                feeds: feeds ?? {},
                messages: [],
                new: true
            };
            if(!settings) {
                settings = state.client.settings;
                localStorage.OTDsettings = JSON.stringify(settings);
            }
            cleanUp();
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
            if(json.columns) {
                localStorage.OTDcolumnIds = JSON.stringify(json.columns);
            }
            if(json.settings && settings) {
                for(let key in json.settings) {
                    settings[key] = json.settings[key];
                }
                localStorage.OTDsettings = JSON.stringify(settings);
            }
            cleanUp();
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
            let ids = [];
            for(let i = 0; i < json.length; i++) {
                const id = json[i].id ?? generateID();
                ids.push(id);
                feeds[id] = json[i];
            }
            xhr.storage.ids = ids;
            localStorage.OTDfeeds = JSON.stringify(feeds);
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
            let ids = [];
            for(let i = 0; i < json.length; i++) {
                const id = json[i].id ?? generateID();
                ids.push(id);
                columns[id] = json[i];
            }
            xhr.storage.ids = ids;
            localStorage.OTDcolumns = JSON.stringify(columns);
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
            if (xhr.status === 429) {
                showToast("Twitter rate limit hit — slow down or try again in a bit.");
            }
            if (xhr.proxyRoute && xhr.proxyRoute.afterRequest) {
                let out = xhr.proxyRoute.afterRequest(xhr);
                if (typeof out === "object") {
                    return JSON.stringify(out);
                } else {
                    return out;
                }
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
