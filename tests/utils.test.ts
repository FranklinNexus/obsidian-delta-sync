import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  conflictPath,
  gitBlobSha,
  shouldExclude,
} from "../src/utils";

describe("utilities", () => {
  it("computes the canonical Git blob SHA", async () => {
    expect(await gitBlobSha(new TextEncoder().encode("test content\n"))).toBe(
      "d670460b4b4aece5915caf5c68d12f560a9fe3e4",
    );
  });

  it("round trips binary base64", () => {
    const input = new Uint8Array([0, 1, 127, 128, 255]);
    expect(base64ToBytes(bytesToBase64(input))).toEqual(input);
  });

  it("always excludes Obsidian state and supports user globs", () => {
    expect(shouldExclude(".obsidian/workspace.json", [])).toBe(true);
    expect(shouldExclude("Private/note.md", ["Private/**"])).toBe(true);
    expect(shouldExclude("Notes/note.md", ["Private/**"])).toBe(false);
  });

  it("preserves an extension in conflict filenames", () => {
    expect(
      conflictPath("Folder/note.md", "github-abcd", new Date("2026-07-23T01:02:03.000Z")),
    ).toBe("Folder/note.sync-conflict-github-abcd-2026-07-23T01-02-03-000Z.md");
  });
});
