// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Wraps entry-point function bodies in try/catch WITHOUT adding lines:
//   sub Main() : try ' everframe:instrumented
//     ...
//   catch everframe_e : Everframe_OnError(...) : throw everframe_e : end try : end sub
// Keeping every original statement on its original line means a crash
// backtrace still points at the developer's source line numbers.
import { Parser, isFunctionStatement } from 'brighterscript';

export const MARKER = "' everframe:instrumented";

export interface WrapTarget {
  entry: string;
  isTask: boolean;
  crumb?: 'key' | 'init';
}

export interface WrapResult {
  code: string;
  wrapped: string[];
  skipped: Array<{ fn: string; reason: string }>;
}

interface Edit { line: number; col: number; text: string }

const brsQuote = (s: string) => '"' + s.replace(/"/g, '""') + '"';

export function wrapFunctions(source: string, targets: Map<string, WrapTarget>): WrapResult {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(eol);
  const parsed = Parser.parse(source);
  if (parsed.diagnostics.length > 0) {
    return { code: source, wrapped: [], skipped: [{ fn: '*', reason: `parse error: ${parsed.diagnostics[0]!.message}` }] };
  }

  const edits: Edit[] = [];
  const wrapped: string[] = [];
  const skipped: WrapResult['skipped'] = [];

  for (const stmt of parsed.ast.statements) {
    if (!isFunctionStatement(stmt)) continue;
    const name = stmt.name.text;
    const target = targets.get(name.toLowerCase());
    if (!target) continue;
    const func = stmt.func;
    const sigTok = func.returnTypeToken ?? func.rightParen;
    const sigLine = sigTok.range.end.line;
    const sigCol = sigTok.range.end.character;
    const endLine = func.end.range.start.line;
    const endCol = func.end.range.start.character;
    const sigText = lines[sigLine] ?? '';
    const endText = lines[endLine] ?? '';

    if (sigText.includes(MARKER)) continue;
    if (sigLine === endLine) { skipped.push({ fn: name, reason: 'single-line function' }); continue; }
    if (endText.slice(0, endCol).trim() !== '') { skipped.push({ fn: name, reason: 'code before end on the same line' }); continue; }
    const afterSig = sigText.slice(sigCol).trim();
    if (afterSig !== '' && !afterSig.startsWith("'") && !/^rem\b/i.test(afterSig)) {
      skipped.push({ fn: name, reason: 'code after the signature on the same line' });
      continue;
    }

    let open = ' : try';
    if (target.crumb === 'key' && func.parameters.length >= 2) {
      const key = func.parameters[0]!.name.text;
      const press = func.parameters[1]!.name.text;
      // `try : if` is rejected by the bsc parser (colon before `if`) and brs-cli
      // rejects `exit while` on one line, so gate the crumb with a one-shot
      // `while` on a scratch copy of the press flag; it stays on the signature line.
      open += ` : everframe_k = ${press} : while everframe_k : Everframe_Crumb("tap", "key " + ${key}, invalid) : everframe_k = false : end while`;
    } else if (target.crumb === 'init') {
      open += ` : Everframe_Crumb("lifecycle", ${brsQuote('init ' + target.entry)}, invalid)`;
    }
    open += ` ${MARKER}`;
    const close = `catch everframe_e : Everframe_OnError(everframe_e, ${brsQuote(target.entry)}, ${target.isTask}) : throw everframe_e : end try : `;

    edits.push({ line: sigLine, col: sigCol, text: open });
    edits.push({ line: endLine, col: endCol, text: close });
    wrapped.push(name);
  }

  // Apply bottom-up / right-to-left so earlier positions stay valid.
  edits.sort((a, b) => b.line - a.line || b.col - a.col);
  for (const e of edits) {
    const l = lines[e.line]!;
    lines[e.line] = l.slice(0, e.col) + e.text + l.slice(e.col);
  }
  return { code: lines.join(eol), wrapped, skipped };
}
