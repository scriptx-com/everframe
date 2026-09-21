// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const checker = fileURLToPath(new URL('../scripts/check-crash-model-compat.mjs', import.meta.url));
const scratch: string[] = [];

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixture(candidateHasLegacy = true) {
  const directory = mkdtempSync(join(tmpdir(), 'traceitx-crash-compat-'));
  scratch.push(directory);
  const baseline = join(directory, 'baseline.javap');
  const candidate = join(directory, 'candidate.javap');
  const caller = join(directory, 'OldCaller.class');
  const legacy = `  public com.traceitx.protocol.generated.Crash(java.lang.String);\n    descriptor: (Ljava/lang/String;)V\n`;
  writeFileSync(baseline, `public final class com.traceitx.protocol.generated.Crash {\n${legacy}}\n`);
  writeFileSync(candidate, `public final class com.traceitx.protocol.generated.Crash {\n${candidateHasLegacy ? legacy : ''}  public final java.lang.String getCauseChain();\n    descriptor: ()Ljava/lang/String;\n}\n`);
  const callerBytes = Buffer.from('unchanged-old-caller');
  writeFileSync(caller, callerBytes);
  return { baseline, candidate, caller, callerHash: sha256(callerBytes) };
}

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Crash model compatibility checker', () => {
  it('accepts a descriptor superset and unchanged caller bytes', () => {
    const input = fixture();
    const result = spawnSync(process.execPath, [checker,
      '--baseline-javap', input.baseline,
      '--candidate-javap', input.candidate,
      '--caller', `${input.caller}=${input.callerHash}`,
    ], { encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('CRASH_MODEL_COMPAT_OK descriptors=1 callers=1');
  });

  it('rejects a missing supported descriptor', () => {
    const input = fixture(false);
    const result = spawnSync(process.execPath, [checker,
      '--baseline-javap', input.baseline,
      '--candidate-javap', input.candidate,
      '--caller', `${input.caller}=${input.callerHash}`,
    ], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('candidate lost supported Crash descriptors');
  });

  it('rejects changed saved caller bytes', () => {
    const input = fixture();
    const result = spawnSync(process.execPath, [checker,
      '--baseline-javap', input.baseline,
      '--candidate-javap', input.candidate,
      '--caller', `${input.caller}=${'0'.repeat(64)}`,
    ], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('saved caller hash changed');
  });
});
