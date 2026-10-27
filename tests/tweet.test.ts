import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseTweet } from "../src/tweet.js";

// Golden fixtures: a real GraphQL tweet result captured in the page (raw) and what the
// in-page parseTweet made of it at capture time (expected, JSON round-tripped).
const dir = join(import.meta.dir, "fixtures/tweets");
const fixtures = readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("tweet adapter golden fixtures", () => {
  for (const file of fixtures) {
    test(file.replace(".json", ""), async () => {
      const { raw, expected, autoExpand } = await Bun.file(join(dir, file)).json();
      (globalThis as any).localStorage = { OTDenableAutoExpand: autoExpand };
      expect(JSON.parse(JSON.stringify(parseTweet(structuredClone(raw))))).toEqual(expected);
    });
  }
});
