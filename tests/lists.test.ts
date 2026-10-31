import { describe, expect, test } from "bun:test";
import { createListStore } from "../src/lists.js";

// A fake X: lists you own (id → { name, size, members }), answering ListOwnerships for one
// target and applying ListAddMember / ListRemoveMember unless told to fail.
function fakeX(lists: Record<string, { name: string; size: number; members: string[] }>) {
  const calls: string[] = [];
  let fail = false, applyAnyway = false, stale = 0, before: Record<string, string[]> = {}, readsFail = false;
  const json = (body: any, ok = true) => Promise.resolve({ ok, json: async () => body });
  return {
    calls, lists,
    // X's errors array: a refusal, or (applied) an error on a change it made anyway.
    failNext(applied = false) { fail = true; applyAnyway = applied; },
    // The next n ListOwnerships reads still show the members as they were before the next change.
    lagNext(n: number) { stale = n; before = Object.fromEntries(Object.entries(lists).map(([id, l]) => [id, [...l.members]])); },
    // ListOwnerships answers with an errors array (rate limited) until turned off.
    failReads(on = true) { readsFail = on; },
    gql(op: string, vars: any) {
      calls.push(op);
      if (op === "ListOwnerships") {
        if (readsFail) return json({ errors: [{ code: 88, message: "Rate limit exceeded" }] }, false);
        const lag = stale > 0 && stale-- > 0;
        const entries = Object.entries(lists).map(([id, l]) => ({
          entryId: `list-${id}`,
          content: { itemContent: { list: { id_str: id, name: l.name, member_count: l.size, is_member: (lag ? before[id] : l.members).includes(vars.isListMemberTargetUserId) } } },
        }));
        return json({ data: { user: { result: { timeline: { timeline: { instructions: [{ type: "TimelineAddEntries", entries }] } } } } } });
      }
      const errored = fail;
      fail = false;
      if (errored && !applyAnyway) return json({ data: {}, errors: [{ code: 37, message: "Authorization: You aren't allowed to remove this user from lists." }] });
      const m = lists[vars.listId].members;
      if (op === "ListAddMember") m.push(vars.userId);
      else m.splice(m.indexOf(vars.userId), 1);
      return json(errored ? { data: {}, errors: [{ message: "BadRequest: com.twitter.strato.serialization.DecodeException" }] } : {});
    },
  };
}
const setup = (storage: Record<string, string> = {}, clock = { t: 1_000_000 }) => {
  const x = fakeX({ a: { name: "Small", size: 2, members: [] }, b: { name: "Big", size: 9, members: ["u1"] } });
  const store = createListStore({ request: x, storage, me: () => "me", now: () => clock.t, sleep: async () => {} });
  return { x, store, storage, clock };
};

describe("list store", () => {
  test("catalog comes from ListOwnerships, biggest first", async () => {
    const { store, x } = setup();
    await store.ready;
    expect(store.catalog()!.map((l) => l.name)).toEqual(["Big", "Small"]);
    expect(store.name("a")).toBe("Small");
    expect(x.calls).toEqual(["ListOwnerships"]);
  });

  test("a new list appears in the catalog on the next membership read", async () => {
    const { store, x } = setup();
    await store.ready;
    x.lists.c = { name: "New", size: 50, members: ["u2"] };
    expect([...await store.membership("u2")]).toEqual(["c"]);
    expect(store.catalog()![0].name).toBe("New");
  });

  test("add and remove apply optimistically and notify", async () => {
    const { store, x } = setup();
    await store.membership("u1");
    const seen: (string | null)[] = [];
    store.subscribe((id) => seen.push(id));
    const pending = store.add("u1", "a");
    expect(store.memberOf("u1")!.has("a")).toBe(true); // before X answers
    expect(await pending).toBe(true);
    expect(x.lists.a.members).toContain("u1");
    expect(await store.remove("u1", "b")).toBe(true);
    expect([...store.memberOf("u1")!]).toEqual(["a"]);
    expect(seen).toEqual(["u1", "u1"]);
  });

  test("removing a user never read reaches X", async () => {
    const { store, x } = setup();
    await store.ready;
    expect(await store.remove("u1", "b")).toBe(true);
    expect(x.calls).toContain("ListRemoveMember");
    expect(x.lists.b.members).not.toContain("u1");
  });

  test("a refused change rolls back", async () => {
    const { store, x } = setup();
    await store.membership("u1");
    const seen: boolean[] = [];
    store.subscribe((id) => id && seen.push(store.memberOf("u1")!.has("a")));
    x.failNext();
    expect(await store.add("u1", "a")).toBe(false);
    expect(store.memberOf("u1")!.has("a")).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  test("an error on a change X applied anyway keeps it", async () => {
    const { store, x } = setup();
    await store.membership("u1");
    x.failNext(true);
    expect(await store.remove("u1", "b")).toBe(true);
    expect(store.memberOf("u1")!.has("b")).toBe(false);
    expect(x.lists.b.members).not.toContain("u1");
  });

  test("an applied change keeps while X's re-read still lags", async () => {
    const { store, x } = setup();
    await store.membership("u1");
    x.lagNext(2);
    x.failNext(true);
    expect(await store.add("u1", "a")).toBe(true);
    expect(store.memberOf("u1")!.has("a")).toBe(true);
  });

  test("a failed read never confirms a refused remove", async () => {
    const { store, x } = setup();
    await store.membership("u1");
    x.failNext();
    x.failReads();
    expect(await store.remove("u1", "b")).toBe(false);
    expect(store.memberOf("u1")!.has("b")).toBe(true);
    expect(store.catalog()!.length).toBe(2); // and doesn't wipe the catalog
  });

  test("a failed read isn't cached as no lists", async () => {
    const { store, x } = setup();
    await store.ready;
    x.failReads();
    await store.membership("u1").catch(() => {});
    expect(store.memberOf("u1")).toBeUndefined();
  });

  test("remove reaches X even when the cache says they're not on the list", async () => {
    const { store, x } = setup();
    await store.membership("u1");
    x.lists.a.members.push("u1"); // added outside OTD
    expect(await store.remove("u1", "a")).toBe(true);
    expect(x.calls).toContain("ListRemoveMember");
    expect(x.lists.a.members).not.toContain("u1");
  });

  test("memberships refetch after the TTL and dedupe in flight", async () => {
    const { store, x, clock } = setup();
    await Promise.all([store.membership("u1"), store.membership("u1")]);
    await store.membership("u1");
    const reads = () => x.calls.filter((c) => c === "ListOwnerships").length;
    expect(reads()).toBe(2); // catalog + one membership read
    x.lists.a.members.push("u1"); // changed outside OTD
    clock.t += 31 * 60 * 1000;
    expect([...await store.membership("u1")].sort()).toEqual(["a", "b"]);
    expect(reads()).toBe(3);
  });

  test("memberships and catalog persist across sessions", async () => {
    const first = setup();
    await first.store.membership("u1");
    const second = setup(first.storage, first.clock);
    expect([...second.store.memberOf("u1")!]).toEqual(["b"]);
    expect(second.store.catalog()!.length).toBe(2);
    await second.store.membership("u1");
    expect(second.x.calls).toEqual([]); // fresh cache: no requests at all
  });
});
