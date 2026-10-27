// One owner for the saved deck layout: the four localStorage keys TweetDeck's state routes
// persist (feeds, columns, settings, column ids) and the rolling backup kept in extension
// storage. Every write goes through commit(), which refuses to let a layout with no columns
// replace one that has some — a crashed or half-booted TweetDeck posts empty state, and that
// must never wipe the deck. Injected by injection.js ahead of the backup check and
// interception (window.OTDLayout); exported for the bun tests.
function createLayoutStore(storage, { saveBackup = () => {}, now = Date.now } = {}) {
    const KEYS = { feeds: 'OTDfeeds', columns: 'OTDcolumns', settings: 'OTDsettings', columnIds: 'OTDcolumnIds' };
    const HOUR = 60 * 60 * 1000;
    const read = (k) => { try { return JSON.parse(storage[KEYS[k]]); } catch { return undefined; } };
    const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    const newId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

    let state = {
        feeds: isObj(read('feeds')) ? read('feeds') : {},
        columns: isObj(read('columns')) ? read('columns') : {},
        settings: isObj(read('settings')) ? read('settings') : null,
        columnIds: Array.isArray(read('columnIds')) ? read('columnIds') : [],
    };
    let backup = null;

    // A layout worth keeping: settings, and an id list naming at least one saved column.
    // The one check shared by boot restore, import, restore and every commit.
    const isValid = (s) => !!s && isObj(s.feeds) && isObj(s.columns) && isObj(s.settings) &&
        Array.isArray(s.columnIds) && s.columnIds.some((id) => id in s.columns);

    // The single writer. A change that would leave no usable layout behind is dropped
    // whenever a usable one is already saved; while the deck is still being built it isn't.
    function commit(patch) {
        const next = { ...state, ...patch };
        if (!isValid(next) && isValid(state)) {
            console.warn('OTD: refused a layout write that would wipe the saved deck', patch);
            return false;
        }
        state = next;
        for (const k in patch) storage[KEYS[k]] = JSON.stringify(patch[k]);
        return true;
    }

    // Upserts feed/column objects TweetDeck posts, returning the ids it gets back.
    function put(kind, list) {
        const map = { ...state[kind] };
        const ids = list.map((item) => {
            const id = item.id ?? newId();
            map[id] = item;
            return id;
        });
        commit({ [kind]: map });
        return ids;
    }

    return {
        isValid,
        // Live objects for TweetDeck's state bootstrap.
        get: () => state,
        // Detached copy in the export/backup format.
        snapshot: () => JSON.parse(JSON.stringify(state)),
        // Swap in a whole layout (import, restore, boot recovery); false if it isn't valid.
        replace: (s) => isValid(s) && commit({ feeds: s.feeds, columns: s.columns, settings: s.settings, columnIds: s.columnIds }),
        putFeeds: (list) => put('feeds', list),
        putColumns: (list) => put('columns', list),
        setColumnIds: (ids) => Array.isArray(ids) && ids.length > 0 && commit({ columnIds: ids }),
        ensureSettings(defaults) {
            if (!state.settings) commit({ settings: defaults });
            return state.settings;
        },
        mergeSettings: (partial) => state.settings && commit({ settings: { ...state.settings, ...partial } }),
        // Drop columns TweetDeck no longer lists, then feeds no column references. Never
        // against an empty id list: there's nothing legitimate to prune by.
        prune() {
            if (!state.columnIds.length) return;
            const columns = {};
            for (const id in state.columns) if (state.columnIds.includes(id)) columns[id] = state.columns[id];
            const json = JSON.stringify(columns);
            const feeds = {};
            for (const id in state.feeds) if (json.includes(id)) feeds[id] = state.feeds[id];
            commit({ columns, feeds });
        },

        // The backup in extension storage, loaded by injection.js before interception runs.
        // A deck that got wiped (twitter's boot path can clear this origin, see destroyer.js)
        // comes back from it here. Returns whether it restored.
        get backup() { return backup; },
        adoptBackup(b) {
            backup = b ?? null;
            return !isValid(state) && isValid(backup) && commit({
                feeds: backup.feeds, columns: backup.columns, settings: backup.settings, columnIds: backup.columnIds,
            });
        },
        // Refresh the rolling backup, at most hourly and only from a usable layout.
        backupHourly() {
            if (backup && now() - backup.savedAt < HOUR) return;
            if (!isValid(state)) return;
            backup = { savedAt: now(), ...JSON.parse(JSON.stringify(state)) };
            saveBackup(backup);
        },
    };
}

if (typeof window !== 'undefined') {
    window.OTDLayout = createLayoutStore(localStorage, {
        saveBackup: (state) => window.postMessage({ action: 'otdSaveBackup', state }, '*'),
    });
}
if (typeof module !== 'undefined') module.exports = { createLayoutStore };
