// One owner for who users are: the signed-in account (me), handle ↔ id, user lookups,
// relationships and the actions you take on a user. Users resolve only through
// UserByScreenName: X Cloudflare-blocks every by-id lookup (users/show by id,
// users/lookup, UserByRestId), so an id becomes a handle from what we've already seen
// (learn) or resolved, never from a fetch. interception.js builds one (OTD.users) with
// XApi; exported for the bun tests with a fake request module.
function createUserDirectory({ request, storage, toLegacy, cookie = () => document.cookie, fallbackId = () => null }) {
    const ID_KEY = 'xlrUserIds';
    const fold = (h) => String(h).replace(/^@/, '').toLowerCase();
    let ids = {}; // folded handle → id, persisted so a user's id is known at once next session
    try {
        for (const [h, id] of Object.entries(JSON.parse(storage[ID_KEY]) || {})) ids[fold(h)] = id;
    } catch {}
    const handles = {}; // id → handle, as last seen
    const persist = () => { storage[ID_KEY] = JSON.stringify(ids); };
    const users = {}; // folded handle → Promise<legacy user | null>, shared by concurrent callers
    const rels = {};  // folded handle → Promise<friendships/show source>

    const ACTIONS = {
        mute: ['/1.1/mutes/users/create.json', (id) => ({ user_id: id })],
        unmute: ['/1.1/mutes/users/destroy.json', (id) => ({ user_id: id })],
        follow: ['/1.1/friendships/create.json', (id) => ({ user_id: id })],
        unfollow: ['/1.1/friendships/destroy.json', (id) => ({ user_id: id })],
        block: ['/1.1/blocks/create.json', (id) => ({ user_id: id })],
        unblock: ['/1.1/blocks/destroy.json', (id) => ({ user_id: id })],
        // The per-user "show Retweets" preference (want_retweets in friendships/show).
        showRetweets: ['/1.1/friendships/update.json', (id) => ({ id, retweets: true })],
        hideRetweets: ['/1.1/friendships/update.json', (id) => ({ id, retweets: false })],
    };

    function byHandle(handle) {
        const key = fold(handle);
        if (users[key]) return users[key];
        const p = (async () => {
            const data = await (await request.gql('UserByScreenName', { screen_name: handle })).json();
            const user = toLegacy(data?.data?.user?.result);
            if (user?.id_str) {
                handles[user.id_str] = user.screen_name;
                if (ids[key] !== user.id_str) { ids[key] = user.id_str; persist(); }
            }
            return user;
        })();
        p.catch(() => { delete users[key]; });
        return users[key] = p;
    }
    const idFor = async (handle) => ids[fold(handle)] ?? (await byHandle(handle).catch(() => null))?.id_str;

    return {
        // The account requests run as: the session cookie's. TweetDeck acts as Teams accounts
        // through x-act-as-user-id per request, which callers read off the request itself.
        me: () => cookie().match(/twid=u%3D(\d+)/)?.[1] ?? fallbackId() ?? undefined,
        byHandle,
        // Sync id for a handle we've already seen; undefined if we haven't.
        known: (handle) => ids[fold(handle)],
        idFor,
        // Handle for an id we've seen in a tweet or resolved before (persisted ids included).
        handleFor(id) {
            id = String(id);
            if (handles[id]) return handles[id];
            for (const h in ids) if (ids[h] === id) return h;
        },
        // Record id → handle pairs seen elsewhere (the tweet adapter's facts, DOM user ids).
        learn(pairs) {
            for (const [id, handle] of Object.entries(pairs)) {
                handles[String(id)] = handle;
                ids[fold(handle)] ??= String(id);
            }
        },
        // friendships/show source (following, followed_by, muting, blocking, want_retweets…),
        // kept until an action on that user or a fresh read.
        relationship(handle, { fresh = false } = {}) {
            const key = fold(handle);
            if (fresh || !rels[key]) {
                rels[key] = (async () => {
                    try {
                        const r = await request.get(`/1.1/friendships/show.json?target_screen_name=${encodeURIComponent(handle)}`);
                        return (await r.json())?.relationship?.source || {};
                    } catch { return {}; }
                })();
            }
            return rels[key];
        },
        // act(handle, 'mute' | 'unmute' | 'follow' | 'unfollow' | 'block' | 'unblock' |
        // 'showRetweets' | 'hideRetweets') → whether X accepted it.
        async act(handle, action) {
            const [path, params] = ACTIONS[action];
            const id = await idFor(handle);
            if (!id) return false;
            delete rels[fold(handle)];
            return (await request.rest(path, params(id))).ok;
        },
    };
}

if (typeof module !== 'undefined') module.exports = { createUserDirectory };
