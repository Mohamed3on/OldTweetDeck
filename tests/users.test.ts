import { describe, expect, test } from "bun:test";
import { createUserDirectory } from "../src/users.js";
import { userResultToLegacy } from "../src/tweet.js";

// A fake X request module: UserByScreenName answers from a table, everything is logged.
function fakeRequest(people: Record<string, string> = { jack: "12", NASA: "11348282" }) {
  const calls: { kind: string; op: string; arg: any }[] = [];
  const json = (body: any, ok = true) => Promise.resolve({ ok, json: async () => body });
  return {
    calls,
    gql(op: string, vars: any) {
      calls.push({ kind: "gql", op, arg: vars });
      const name = Object.keys(people).find((n) => n.toLowerCase() === vars.screen_name.toLowerCase());
      const result = name && { __typename: "User", rest_id: people[name], legacy: { screen_name: name, name } };
      return json({ data: { user: { result } } });
    },
    get(path: string) {
      calls.push({ kind: "get", op: path, arg: null });
      return json({ relationship: { source: { following: true } } });
    },
    rest(path: string, params: any) {
      calls.push({ kind: "rest", op: path, arg: params });
      return json({}, true);
    },
  };
}
const make = (request = fakeRequest(), storage: Record<string, string> = {}, cookie = "") =>
  ({ request, storage, dir: createUserDirectory({ request, storage, toLegacy: userResultToLegacy, cookie: () => cookie, fallbackId: () => "999" }) });

describe("user directory", () => {
  test("concurrent lookups share one in-flight request", async () => {
    const { request, dir } = make();
    const [a, b] = await Promise.all([dir.byHandle("jack"), dir.byHandle("jack")]);
    expect(a).toBe(b);
    expect(a.id_str).toBe("12");
    expect(request.calls.filter((c) => c.op === "UserByScreenName")).toHaveLength(1);
  });

  test("handles fold case and a leading @", async () => {
    const { request, dir } = make();
    await dir.byHandle("NASA");
    expect(await dir.byHandle("@nasa")).toBe(await dir.byHandle("nasa"));
    expect(dir.known("Nasa")).toBe("11348282");
    expect(request.calls).toHaveLength(1);
  });

  test("handleFor uses what was learned, then persisted ids", async () => {
    const { dir } = make(fakeRequest(), { xlrUserIds: JSON.stringify({ Paulg: "183749519" }) });
    dir.learn({ 12: "jack" });
    expect(dir.handleFor(12)).toBe("jack");
    expect(dir.handleFor("183749519")).toBe("paulg");
    expect(dir.handleFor("404")).toBeUndefined();
  });

  test("resolved ids persist across sessions", async () => {
    const storage: Record<string, string> = {};
    const first = make(fakeRequest(), storage);
    await first.dir.byHandle("jack");
    const second = make(fakeRequest(), storage);
    expect(second.dir.known("JACK")).toBe("12");
    expect(await second.dir.idFor("jack")).toBe("12");
    expect(second.request.calls).toHaveLength(0);
  });

  test("never resolves by id: unknown ids stay unknown, no request goes out", async () => {
    const { request, dir } = make();
    expect(dir.handleFor("12")).toBeUndefined();
    expect(request.calls).toHaveLength(0);
    await dir.byHandle("jack");
    expect(dir.handleFor("12")).toBe("jack");
    expect(request.calls.every((c) => c.op === "UserByScreenName" && c.arg.screen_name)).toBe(true);
  });

  test("act posts the user id and drops the cached relationship", async () => {
    const { request, dir } = make();
    await dir.relationship("jack");
    await dir.relationship("jack");
    expect(request.calls.filter((c) => c.kind === "get")).toHaveLength(1);
    expect(await dir.act("jack", "mute")).toBe(true);
    expect(request.calls.at(-1)).toEqual({ kind: "rest", op: "/1.1/mutes/users/create.json", arg: { user_id: "12" } });
    await dir.act("jack", "hideRetweets");
    expect(request.calls.at(-1)!.arg).toEqual({ id: "12", retweets: false });
    await dir.relationship("jack");
    expect(request.calls.filter((c) => c.kind === "get")).toHaveLength(2);
    expect(await dir.act("nobody", "follow")).toBe(false);
  });

  test("me prefers the session cookie, then the fallback", () => {
    expect(make(fakeRequest(), {}, "a=1; twid=u%3D42; b=2").dir.me()).toBe("42");
    expect(make().dir.me()).toBe("999");
  });
});
