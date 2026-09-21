// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { TypeScriptParser } = require(
  "@react-native/codegen/lib/parsers/typescript/parser",
);

describe("React Native codegen type compatibility", () => {
  it("parses local UnsafeObject aliases without a React Native deep type import", () => {
    const source = readFileSync(
      new URL("../src/NativeTraceItX.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('from "./codegen-types"');
    expect(source).not.toContain(
      'from "react-native/Libraries/Types/CodegenTypes"',
    );

    const schema = new TypeScriptParser().parseString(
      source,
      "NativeTraceItX.ts",
    );
    const encoded = JSON.stringify(schema);

    expect(Object.keys(schema.modules)).toEqual(["NativeTraceItX"]);
    expect(encoded.match(/GenericObjectTypeAnnotation/g)?.length).toBe(6);
  });
});

