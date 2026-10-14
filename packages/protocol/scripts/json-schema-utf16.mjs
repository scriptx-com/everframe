// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// JSON Schema maxLength counts code points; producers cap UTF-16 code units.
export function utf16Limits(node) {
  if (!node || typeof node !== 'object') return;
  for (const child of Object.values(node)) utf16Limits(child);
  if (node.type !== 'string' || typeof node.maxLength !== 'number') return;
  const max = node.maxLength;
  node.allOf = [
    {
      anyOf: Array.from({ length: Math.floor(max / 2) + 1 }, (_, extra) => ({
        maxLength: max - extra,
        pattern: `^(?:[\\u0000-\\uFFFF]*[^\\u0000-\\uFFFF]){0,${extra}}[\\u0000-\\uFFFF]*$`,
      })),
    },
  ];
}
