import { describe, expect, test } from "bun:test";
import { createLayoutStore } from "../src/layout.js";

const KEYS = ["OTDfeeds", "OTDcolumns", "OTDsettings", "OTDcolumnIds"];
const layout = () => ({
  feeds: { f1: { type: "home" } },
  columns: { c1: { feeds: ["f1"] } },
  settings: { theme: "dark" },
  columnIds: ["c1"],
});
const saved = (s = layout()) => ({
  OTDfeeds: JSON.stringify(s.feeds),
  OTDcolumns: JSON.stringify(s.columns),
  OTDsettings: JSON.stringify(s.settings),
  OTDcolumnIds: JSON.stringify(s.columnIds),
});
const pick = (storage: Record<string, string>) => Object.fromEntries(KEYS.map((k) => [k, storage[k]]));
const quiet = () => { console.warn = () => {}; };

describe("layout store", () => {
  test("loads the saved layout and survives corrupt keys", () => {
    expect(createLayoutStore(saved()).get()).toEqual(layout());
    const s = createLayoutStore({ OTDfeeds: "{oops", OTDcolumns: "[]", OTDsettings: "null" }).get();
    expect(s).toEqual({ feeds: {}, columns: {}, settings: null, columnIds: [] });
  });

  test("an empty column-id push never wipes a valid layout", () => {
    const storage = saved();
    const before = pick(storage);
    const store = createLayoutStore(storage);
    expect(store.setColumnIds([])).toBe(false);
    store.prune();
    expect(pick(storage)).toEqual(before);
  });

  test("a prune that would drop every column is refused", () => {
    quiet();
    const storage = saved();
    const before = pick(storage);
    const store = createLayoutStore(storage);
    store.setColumnIds(["gone"]);
    store.prune();
    expect(pick(storage)).toEqual(before);
    expect(store.get().columns).toEqual(layout().columns);
  });

  test("prune drops unlisted columns and their orphaned feeds", () => {
    const s = layout();
    s.columns.c2 = { feeds: ["f2"] };
    s.feeds.f2 = { type: "search" };
    s.columnIds = ["c1"];
    const storage = saved(s);
    createLayoutStore(storage).prune();
    expect(JSON.parse(storage.OTDcolumns)).toEqual({ c1: { feeds: ["f1"] } });
    expect(JSON.parse(storage.OTDfeeds)).toEqual({ f1: { type: "home" } });
  });

  test("replace rejects an invalid layout and accepts a valid one", () => {
    const storage = saved();
    const before = pick(storage);
    const store = createLayoutStore(storage);
    for (const bad of [null, {}, { ...layout(), columns: {} }, { ...layout(), columnIds: [] }, { ...layout(), settings: null }]) {
      expect(store.replace(bad)).toBe(false);
    }
    expect(pick(storage)).toEqual(before);
    const next = { ...layout(), settings: { theme: "light" } };
    expect(store.replace(next)).toBe(true);
    expect(JSON.parse(storage.OTDsettings)).toEqual({ theme: "light" });
  });

  test("a fresh deck builds up from nothing", () => {
    const storage: Record<string, string> = {};
    const store = createLayoutStore(storage);
    store.ensureSettings({ theme: "light" });
    const [f] = store.putFeeds([{ type: "home" }]);
    const [c] = store.putColumns([{ id: "c1", feeds: [f] }]);
    expect(c).toBe("c1");
    expect(store.setColumnIds([c])).toBe(true);
    expect(store.isValid(store.get())).toBe(true);
    expect(JSON.parse(storage.OTDcolumnIds)).toEqual(["c1"]);
  });

  test("mergeSettings only merges into existing settings", () => {
    const storage = saved();
    createLayoutStore(storage).mergeSettings({ navbar_width: "condensed" });
    expect(JSON.parse(storage.OTDsettings)).toEqual({ theme: "dark", navbar_width: "condensed" });
    const fresh = createLayoutStore({});
    expect(fresh.mergeSettings({ theme: "dark" })).toBeFalsy();
    expect(fresh.get().settings).toBeNull();
  });

  test("snapshot/replace round-trips and the snapshot is detached", () => {
    const store = createLayoutStore(saved());
    const snap = store.snapshot();
    snap.columns.c1.feeds.push("x");
    expect(store.get()).toEqual(layout());
    const other = createLayoutStore({});
    expect(other.replace(store.snapshot())).toBe(true);
    expect(other.snapshot()).toEqual(store.snapshot());
  });

  test("adoptBackup restores a wiped deck but never overwrites a valid one", () => {
    const backup = { savedAt: 1, ...layout(), settings: { theme: "backup" } };
    const wiped: Record<string, string> = {};
    const a = createLayoutStore(wiped);
    expect(a.adoptBackup(backup)).toBe(true);
    expect(JSON.parse(wiped.OTDsettings)).toEqual({ theme: "backup" });
    expect(a.backup).toBe(backup);

    const intact = saved();
    const b = createLayoutStore(intact);
    expect(b.adoptBackup(backup)).toBe(false);
    expect(JSON.parse(intact.OTDsettings)).toEqual({ theme: "dark" });
    expect(createLayoutStore({}).adoptBackup({ savedAt: 1, ...layout(), columnIds: [] })).toBe(false);
  });

  test("backupHourly saves at most hourly and only a valid layout", () => {
    let t = 10_000_000;
    const sent: any[] = [];
    const store = createLayoutStore(saved(), { saveBackup: (b: any) => sent.push(b), now: () => t });
    store.adoptBackup({ savedAt: t - 1000, ...layout() });
    store.backupHourly();
    expect(sent).toHaveLength(0);
    t += 60 * 60 * 1000;
    store.backupHourly();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ savedAt: t, ...layout() });
    expect(store.backup).toBe(sent[0]);

    const empty = createLayoutStore({}, { saveBackup: (b: any) => sent.push(b), now: () => t });
    empty.backupHourly();
    expect(sent).toHaveLength(1);
  });
});
