import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { adaptTweet } from "../src/tweet.js";

// Golden fixtures: a real GraphQL tweet result captured in the page (raw) and what the
// in-page parseTweet made of it at capture time (expected, JSON round-tripped).
const dir = join(import.meta.dir, "fixtures/tweets");
const load = async (name: string) => Bun.file(join(dir, `${name}.json`)).json();
const fixtures = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));

describe("tweet adapter golden fixtures", () => {
  for (const name of fixtures) {
    test(name, async () => {
      const { raw, expected, autoExpand } = await load(name);
      const before = structuredClone(raw);
      const out = adaptTweet(raw, { autoExpand: autoExpand === "1" });
      expect(JSON.parse(JSON.stringify(out.tweet))).toEqual(expected);
      expect(raw).toEqual(before); // pure: the input is never touched
    });
  }
});

describe("tweet adapter facts", () => {
  test("handles cover authors and mentions across retweet and quote", async () => {
    const { raw } = await load("retweet-of-quote");
    const { tweet, facts } = adaptTweet(raw);
    const rt = tweet.retweeted_status;
    expect(facts.handles[tweet.user.id_str]).toBe(tweet.user.screen_name);
    expect(facts.handles[rt.user.id_str]).toBe(rt.user.screen_name);
    expect(tweet.entities.user_mentions.length).toBeGreaterThan(0);
    for (const m of tweet.entities.user_mentions) expect(facts.handles[m.id_str]).toBe(m.screen_name);

    const quote = adaptTweet((await load("quote")).raw);
    const q = quote.tweet.quoted_status;
    expect(quote.facts.handles[q.user.id_str]).toBe(q.user.screen_name);
  });

  test("notes are keyed by tweet id", async () => {
    const { raw } = await load("plain");
    const node = structuredClone(raw.tweet ?? raw);
    node.birdwatch_pivot = { title: "Readers added context" };
    const { facts } = adaptTweet(node);
    expect(facts.notes).toEqual({ [node.legacy.id_str]: { title: "Readers added context" } });
  });

  test("garbage in, null out", () => {
    expect(adaptTweet(undefined)).toBeNull();
    expect(adaptTweet({ __typename: "TweetTombstone" })).toBeNull();
  });
});
