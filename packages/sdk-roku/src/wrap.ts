// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Wraps entry-point function bodies in try/catch WITHOUT adding lines:
//   sub Main() : try ' everframe:instrumented
//     ...
//   catch everframe_e : Everframe_OnError(...) : throw everframe_e : end try : end sub
// Keeping every original statement on its original line means a crash
// backtrace still points at the developer's source line numbers.
import { Parser, WalkMode, createVisitor, isFunctionStatement, type FunctionExpression } from 'brighterscript';

export const MARKER = "' everframe:instrumented";

export interface WrapTarget {
  entry: string;
  isTask: boolean;
  crumb?: 'key' | 'init';
  /** 'recordExit': call Everframe_RecordLastExit() before any host code (Main only). */
  prelude?: 'recordExit';
  /** BrightScript expression passed to Everframe_Screen(...) (init of a screen component): `m.top.subtype()`. */
  screen?: string;
  /** Matched name (the component or an ancestor) that made this a screen; for reporting. */
  screenVia?: string;
  /**
   * Guarded screen for an init() that screen components inherit from a base
   * that is not itself a screen: `Everframe_ScreenIf(expr, "A,B")` sets the
   * screen only when the running component's type is one of `names`.
   */
  screenIf?: { expr: string; names: string[] };
  /** Components that share this script but disagree on the screen; no automatic screen. */
  screenConflict?: string[];
  /** Component this init target came from (to name both sides of a conflict). */
  screenOwner?: string;
}

export interface WrapResult {
  code: string;
  wrapped: string[];
  skipped: Array<{ fn: string; reason: string }>;
}

interface Edit { line: number; col: number; text: string }

const brsQuote = (s: string) => '"' + s.replace(/"/g, '""') + '"';

/** Any label statement in the body, nested blocks included: BrightScript rejects labels inside a TRY clause. */
function hasLabel(func: FunctionExpression): boolean {
  let found = false;
  func.body.walk(createVisitor({ LabelStatement: () => { found = true; } }), { walkMode: WalkMode.visitStatementsRecursive });
  return found;
}

export function wrapFunctions(source: string, targets: Map<string, WrapTarget>): WrapResult {
  // [line0, eol0, line1, eol1, ...]: each line keeps its own terminator; the
  // lexer's three newline forms, so line i (at 2i) is the parser's line i.
  const parts = source.split(/(\r\n|\r|\n)/);
  const lines = parts.filter((_, i) => i % 2 === 0);
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
    // Labels in a nested function expression are counted too: conservative, never a compile error.
    if (hasLabel(func)) { skipped.push({ fn: name, reason: 'contains a label (labels are illegal inside try)' }); continue; }

    let open = ' : try';
    if (target.prelude === 'recordExit') open += ' : Everframe_RecordLastExit()';
    if (target.crumb === 'key') {
      if (func.parameters.length >= 2) {
        const key = func.parameters[0]!.name.text;
        const press = func.parameters[1]!.name.text;
        open += ` : Everframe_KeyCrumb(${key}, ${press})`;
      } else {
        skipped.push({ fn: name, reason: 'onKeyEvent has fewer than 2 parameters; no key breadcrumb' });
      }
    } else if (target.crumb === 'init') {
      open += ` : Everframe_Crumb("lifecycle", ${brsQuote('init ' + target.entry)}, invalid)`;
    }
    if (target.screen) open += ` : Everframe_Screen(${target.screen})`;
    else if (target.screenConflict) {
      skipped.push({ fn: name, reason: `shared by components ${target.screenConflict.join(', ')}; no automatic screen` });
    } else if (target.screenIf && target.screenIf.names.length > 0) {
      open += ` : Everframe_ScreenIf(${target.screenIf.expr}, ${brsQuote(target.screenIf.names.join(','))})`;
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
    const l = parts[e.line * 2]!;
    parts[e.line * 2] = l.slice(0, e.col) + e.text + l.slice(e.col);
  }
  return { code: parts.join(''), wrapped, skipped };
}
