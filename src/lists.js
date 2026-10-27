// One owner for your lists: the catalog (every list you own, biggest first), which of them a
// user is in, and adding/removing members. Everything comes from ListOwnerships, which lists
// your lists with is_member for one target user, so every membership read also refreshes the
// catalog and a list made elsewhere shows up. Adds and removes apply at once, roll back if X
// refuses, and notify subscribers so every chip row for that user redraws. Keyed by user id;
// xlr.js (TweetDeck) and xprofile.js (x.com profiles) each build one over XApi, sharing the
// x.com origin's cache. Exported for the bun tests.
function createListStore({ request, storage, me, now = Date.now }) {
    const CATALOG_KEY = 'otdLists', MEMBERS_KEY = 'otdListMembers';
    const CATALOG_TTL = 24 * 60 * 60 * 1000, MEMBERS_TTL = 30 * 60 * 1000;
    const load = (k) => { try { return JSON.parse(storage[k]) || null; } catch { return null; } };

    let catalog = load(CATALOG_KEY); // { lists: [{ id, name, size }], ts }
    const members = {};              // user id → { ids: Set<list id>, ts }
    for (const [id, m] of Object.entries(load(MEMBERS_KEY) || {})) members[id] = { ids: new Set(m.ids), ts: m.ts };
    const inflight = {};
    const subs = new Set();

    const saveCatalog = () => { storage[CATALOG_KEY] = JSON.stringify(catalog); };
    const saveMembers = () => {
        const out = {};
        for (const id in members) out[id] = { ids: [...members[id].ids], ts: members[id].ts };
        storage[MEMBERS_KEY] = JSON.stringify(out);
    };
    // userId of the membership that changed, or null for the catalog.
    const notify = (userId) => { for (const fn of subs) fn(userId); };

    // Every list you own with whether target is in it, paged through.
    async function ownerships(target) {
        const lists = [], memberOf = new Set();
        let cursor;
        for (let page = 0; page < 10; page++) {
            const vars = { userId: me(), isListMemberTargetUserId: target, count: 100, includePromotedContent: false };
            if (cursor) vars.cursor = cursor;
            const data = await (await request.gql('ListOwnerships', vars)).json();
            cursor = null;
            let got = 0;
            for (const inst of data?.data?.user?.result?.timeline?.timeline?.instructions || []) {
                for (const entry of inst.entries || []) {
                    const l = entry?.content?.itemContent?.list;
                    if (l) {
                        const id = l.id_str || l.rest_id;
                        lists.push({ id, name: l.name, size: l.member_count });
                        if (l.is_member) memberOf.add(id);
                        got++;
                    } else if (entry?.entryId?.startsWith('cursor-bottom')) cursor = entry.content?.value;
                }
            }
            if (!got || !cursor) break;
        }
        catalog = { lists: lists.sort((a, b) => b.size - a.size), ts: now() };
        saveCatalog();
        notify(null);
        return memberOf;
    }

    function membership(userId) {
        const m = members[userId];
        if (m && now() - m.ts < MEMBERS_TTL) return Promise.resolve(m.ids);
        return inflight[userId] ??= ownerships(userId).then((ids) => {
            members[userId] = { ids, ts: now() };
            saveMembers();
            notify(userId);
            return ids;
        }).finally(() => { delete inflight[userId]; });
    }

    async function setMember(userId, listId, member) {
        const m = members[userId] ??= { ids: new Set(), ts: 0 };
        if (m.ids.has(listId) === member) return true;
        const apply = (on) => { on ? m.ids.add(listId) : m.ids.delete(listId); saveMembers(); notify(userId); };
        apply(member);
        let ok = false;
        try { ok = (await request.gql(member ? 'ListAddMember' : 'ListRemoveMember', { listId, userId })).ok; } catch {}
        if (!ok) apply(!member);
        return ok;
    }

    return {
        // Resolves once a catalog is known: the cached one while fresh, else fetched.
        ready: catalog && now() - catalog.ts < CATALOG_TTL ? Promise.resolve() : ownerships(me()).then(() => {}, () => {}),
        catalog: () => catalog?.lists ?? null,
        name: (listId) => catalog?.lists.find((l) => l.id === listId)?.name,
        // What we know now (possibly stale), or undefined for a user never fetched.
        memberOf: (userId) => members[userId]?.ids,
        // Fresh within the TTL, otherwise refetched; concurrent callers share one request.
        membership,
        add: (userId, listId) => setMember(userId, listId, true),
        remove: (userId, listId) => setMember(userId, listId, false),
        subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    };
}

if (typeof module !== 'undefined') module.exports = { createListStore };
