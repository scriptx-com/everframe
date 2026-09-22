#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(RN_ROOT, "../..");
const DIST_ROOT = join(RN_ROOT, "dist");
const FIXTURE = join(
  RN_ROOT,
  "__tests__/fixtures/error-details-public-consumer.ts",
);
const CONSUMER_ROOT = join(
  REPO_ROOT,
  ".superpowers/artifacts/sdk-react-native/error-details-public-consumer",
);
const TSC_BIN = join(REPO_ROOT, "node_modules/typescript/bin/tsc");
const NODE_BUILTINS = new Set(
  builtinModules.flatMap((specifier) => [specifier, `node:${specifier}`]),
);

function importedSpecifiers(source) {
  const specifiers = [];
  const pattern = /(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  return specifiers;
}

function runPnpm(args) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : "pnpm";
  const commandArgs = npmExecPath ? [npmExecPath, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `pnpm ${args.join(" ")} exited ${result.status}`,
  );
}

function filesUnder(root, include) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (include(entry.name)) files.push(path);
    }
  };
  visit(root);
  return files;
}

function linkPackage(name, target) {
  const destination = join(CONSUMER_ROOT, "node_modules", ...name.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  symlinkSync(target, destination, "dir");
}

runPnpm([
  "exec",
  "turbo",
  "run",
  "build",
  "--filter=@traceitx/react-native...",
  "--force",
]);

const artifacts = filesUnder(DIST_ROOT, () => true);
const declarations = artifacts.filter((path) =>
  /\.d\.(?:ts|mts|cts)$/.test(path),
);
assert.ok(
  declarations.length > 0,
  "the forced RN build emitted no declaration files",
);
for (const artifact of artifacts) {
  const source = readFileSync(artifact, "utf8");
  assert.equal(
    /@traceitx\/(?:sdk-core|protocol)(?:\/|['"])/.test(source),
    false,
    `${relative(DIST_ROOT, artifact)} leaks a private workspace package module specifier`,
  );
  if (artifact.endsWith(".js")) {
    const leakedBuiltins = importedSpecifiers(source).filter((specifier) =>
      NODE_BUILTINS.has(specifier),
    );
    assert.deepEqual(
      leakedBuiltins,
      [],
      `${relative(DIST_ROOT, artifact)} imports Node built-ins that Metro cannot resolve`,
    );
  }
}

rmSync(CONSUMER_ROOT, { recursive: true, force: true });
mkdirSync(CONSUMER_ROOT, { recursive: true });
writeFileSync(
  join(CONSUMER_ROOT, "package.json"),
  JSON.stringify({ private: true, type: "module" }, null, 2),
);
writeFileSync(
  join(CONSUMER_ROOT, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2022",
        lib: ["ES2022"],
        types: ["react"],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      files: ["consumer.ts"],
    },
    null,
    2,
  ),
);
cpSync(FIXTURE, join(CONSUMER_ROOT, "consumer.ts"));

linkPackage("@traceitx/react-native", RN_ROOT);
for (const name of ["react", "react-native", "zod", "bippy", "@types/react"]) {
  linkPackage(name, resolve(REPO_ROOT, "node_modules", name));
}

const checked = spawnSync(
  process.execPath,
  [TSC_BIN, "--project", join(CONSUMER_ROOT, "tsconfig.json")],
  {
    cwd: CONSUMER_ROOT,
    encoding: "utf8",
  },
);
if (checked.error) throw checked.error;
if (checked.stdout) process.stdout.write(checked.stdout);
if (checked.stderr) process.stderr.write(checked.stderr);
assert.equal(
  checked.status,
  0,
  `public consumer TypeScript compiler exited ${checked.status}`,
);

console.log(
  `[error-details-public] ${artifacts.length} artifacts (${declarations.length} declarations) ` +
    "have no private package or Node built-in module specifiers; " +
    "public consumer TypeScript compiler exit 0 (skipLibCheck:false)",
);
