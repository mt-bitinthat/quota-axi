import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boxConfigPath, readBoxConfig } from "../../src/box/config.js";

let directory: string;

function writeConfig(contents: string): string {
  const path = join(directory, "box.json");
  writeFileSync(path, contents);
  return path;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "quota-axi-box-config-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("readBoxConfig", () => {
  it("reads the fx rate and each provider subscription", () => {
    const path = writeConfig(
      JSON.stringify({
        fx: { audPerUsd: 1.401, asOf: "2026-09-21" },
        subscriptions: {
          claude: { renewsDay: 5, amountAud: 305 },
          codex: { renewsDay: 5, amountAud: 35 },
        },
      }),
    );
    expect(readBoxConfig(path)).toEqual({
      fx: { audPerUsd: 1.401, asOf: "2026-09-21" },
      subscriptions: {
        claude: { renewsDay: 5, amountAud: 305 },
        codex: { renewsDay: 5, amountAud: 35 },
      },
    });
  });

  it("resolves undefined for a missing file", () => {
    expect(readBoxConfig(join(directory, "absent.json"))).toBeUndefined();
  });

  it("resolves undefined for malformed JSON rather than throwing", () => {
    const path = writeConfig('{"fx": {"audPerUsd": 1.4},');
    expect(() => readBoxConfig(path)).not.toThrow();
    expect(readBoxConfig(path)).toBeUndefined();
  });

  it("resolves undefined when the file holds nothing usable", () => {
    expect(readBoxConfig(writeConfig("[]"))).toBeUndefined();
    expect(readBoxConfig(writeConfig("{}"))).toBeUndefined();
    expect(
      readBoxConfig(writeConfig(JSON.stringify({ subscriptions: {} }))),
    ).toBeUndefined();
  });

  it("drops only the malformed entries and keeps the rest of the file", () => {
    const path = writeConfig(
      JSON.stringify({
        fx: { audPerUsd: 1.5 },
        subscriptions: {
          claude: { renewsDay: 5, amountAud: 305 },
          codex: { renewsDay: 0, amountAud: 35 },
          cursor: { renewsDay: 32, amountAud: 35 },
          grok: { renewsDay: 5.5, amountAud: 35 },
          kimi: { renewsDay: 5 },
          zai: { renewsDay: 5, amountAud: "35" },
          agy: "monthly",
        },
      }),
    );
    expect(readBoxConfig(path)).toEqual({
      fx: { audPerUsd: 1.5 },
      subscriptions: { claude: { renewsDay: 5, amountAud: 305 } },
    });
  });

  it("keeps a usable subscription when the fx block is unusable", () => {
    const path = writeConfig(
      JSON.stringify({
        fx: { audPerUsd: 0 },
        subscriptions: { claude: { renewsDay: 5, amountAud: 305 } },
      }),
    );
    expect(readBoxConfig(path)).toEqual({
      subscriptions: { claude: { renewsDay: 5, amountAud: 305 } },
    });
  });

  it("locates box.json under the XDG config base", () => {
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = directory;
    try {
      expect(boxConfigPath()).toBe(join(directory, "quota-axi", "box.json"));
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });
});
