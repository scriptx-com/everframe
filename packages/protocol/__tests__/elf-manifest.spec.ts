// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from "vitest";
import { artifactKind, parseManifest } from "../src/build-artifacts.js";
const sha = "a".repeat(64);
const input = {
  version: 5,
  runtime: "android-native",
  platform: "android",
  buildId: "elf:" + sha,
  artifacts: [
    { url: "elf://android/library", mapSha256: sha, mapBytes: 64 * 1024 * 1024 },
  ],
};
describe("raw ELF upload manifest", () => {
  it("accepts a single digest-bound artifact at the native64MiB ceiling", () => {
    expect(parseManifest(input)).toEqual(input);
    expect(artifactKind(parseManifest(input))).toBe("elf");
  });
  it.each([
    { buildId: "release-1" },
    { buildId: "elf:" + "b".repeat(64) },
    { runtime: "hermes" },
    { platform: "ios" },
    { version: 4 },
    { extra: true },
    { artifacts: [] },
    { artifacts: [input.artifacts[0], input.artifacts[0]] },
    ...[
      { url: "elf://android/other" },
      { generatedSha256: sha },
      { mapBytes: 0 },
      { mapBytes: 64 * 1024 * 1024 + 1 },
      { mapSha256: sha + "\n" },
      { extra: true },
    ].map((change) => ({ artifacts: [{ ...input.artifacts[0], ...change }] })),
  ])("rejects incompatible or ambiguous declaration %j", (change) => {
    expect(() => parseManifest({ ...input, ...change })).toThrow();
  });
  it("does not widen legacy map sizes", () => {
    expect(() =>
      parseManifest({
        version: 3,
        runtime: "r8",
        platform: "android",
        buildId: "ci-1",
        artifacts: [
          {
            url: "r8://android/mapping.txt",
            mapSha256: sha,
            mapBytes: 32 * 1024 * 1024 + 1,
          },
        ],
      })
    ).toThrow();
    expect(() =>
      parseManifest({
        version: 1,
        buildId: "web",
        artifacts: [
          {
            url: "~/app.js",
            generatedSha256: sha,
            mapSha256: sha,
            mapBytes: 32 * 1024 * 1024 + 1,
          },
        ],
      })
    ).toThrow();
  });
});
