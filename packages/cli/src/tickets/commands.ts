// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_API_URL, redact } from '../defaults.js';
import { createTicketClient, TicketApiError } from './client.js';
import { MAX_FILES, validateFiles } from './files.js';
import { parseTicketArg } from './ref.js';

export interface TicketDeps {
  env: NodeJS.ProcessEnv;
  out: (s: string) => void;
  err: (s: string) => void;
  client?: ReturnType<typeof createTicketClient>;
  newKey?: () => string;
}

const MISSING_TICKET_TOKEN =
  'missing_api_token: set EVERFRAME_API_TOKEN to a token with the tickets:write scope.';

const COMMON = {
  project: { type: 'string' },
  'idempotency-key': { type: 'string' },
  json: { type: 'boolean' },
} as const;

const OPTIONS = {
  create: {
    ...COMMON,
    title: { type: 'string' },
    description: { type: 'string' },
    'description-file': { type: 'string' },
    board: { type: 'string' },
    column: { type: 'string' },
    attach: { type: 'string', multiple: true },
  },
  attach: { ...COMMON },
  comment: {
    ...COMMON,
    body: { type: 'string' },
    'body-file': { type: 'string' },
    attach: { type: 'string', multiple: true },
  },
} as const;

class BadInput extends Error {}

async function textFrom(inline: string | undefined, file: string | undefined, what: string) {
  if (inline !== undefined && file !== undefined)
    throw new BadInput(`pass only one of --${what} and --${what}-file`);
  if (file === undefined) return inline;
  try {
    return await readFile(file, 'utf8');
  } catch {
    throw new BadInput(`${file}: cannot be read`);
  }
}

/** `everframe ticket create | attach | comment`. Exit: 0 ok, 2 bad input, 1 API or network failure. */
export async function ticketCommand(argv: string[], deps: TicketDeps): Promise<number> {
  const { env } = deps;
  const sub = argv[0];
  if (sub !== 'create' && sub !== 'attach' && sub !== 'comment') {
    deps.err('everframe: ticket needs create, attach or comment');
    return 2;
  }
  // Redact at the sink: the token must never reach output, whatever produced the text.
  const out = (s: string) => deps.out(redact(s, env.EVERFRAME_API_TOKEN));
  const err = (s: string) => deps.err(redact(s, env.EVERFRAME_API_TOKEN));

  let values: Record<string, string | string[] | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv.slice(1),
      strict: true,
      allowPositionals: sub !== 'create',
      options: OPTIONS[sub],
    }) as { values: typeof values; positionals: string[] });
  } catch {
    err(`everframe: ticket ${sub}: invalid arguments`);
    return 2;
  }
  const str = (k: string) => values[k] as string | undefined;
  const list = (k: string) => (values[k] as string[] | undefined) ?? [];

  try {
    let ref: { ticket: string; projectId?: string } | undefined;
    let filePaths = list('attach');
    if (sub !== 'create') {
      const [arg, ...rest] = positionals;
      const parsed = arg === undefined ? null : parseTicketArg(arg);
      if (!parsed) throw new BadInput('give a ticket number, uuid or dashboard link');
      ref = parsed;
      if (sub === 'attach') {
        if (rest.length === 0) throw new BadInput('attach needs at least one file');
        filePaths = rest;
      } else if (rest.length > 0) {
        throw new BadInput('unexpected argument; use --attach for files');
      }
    }

    let description: string | undefined;
    let body: string | undefined;
    if (sub === 'create') {
      if (!str('title')?.trim()) throw new BadInput('--title is required');
      description = await textFrom(str('description'), str('description-file'), 'description');
    }
    if (sub === 'comment') {
      body = await textFrom(str('body'), str('body-file'), 'body');
      if (str('body') === undefined && str('body-file') === undefined)
        throw new BadInput('pass exactly one of --body and --body-file');
      if (!body?.trim()) throw new BadInput('the comment body is empty');
    }

    const checked = await validateFiles(filePaths, MAX_FILES);
    if (!checked.ok) throw new BadInput(checked.message);

    const token = env.EVERFRAME_API_TOKEN;
    if (!deps.client && !token) {
      err(`everframe: ${MISSING_TICKET_TOKEN}`);
      return 1;
    }
    const client =
      deps.client ??
      createTicketClient({ apiUrl: env.EVERFRAME_API_URL ?? DEFAULT_API_URL, token: token ?? '' });
    const projectId = str('project') ?? ref?.projectId ?? (env.EVERFRAME_PROJECT_ID || undefined);
    const key = str('idempotency-key') ?? (deps.newKey ?? randomUUID)();

    let step: string = 'upload';
    let currentFile = '';
    try {
      const ids: string[] = [];
      for (const file of checked.files) {
        currentFile = file.name;
        ids.push((await client.upload(file, projectId)).id);
      }
      currentFile = '';
      let result: Record<string, unknown>;
      if (sub === 'create') {
        step = 'create';
        result = (await client.createTicket(
          {
            title: str('title'),
            ...(description !== undefined ? { description } : {}),
            ...(projectId ? { projectId } : {}),
            ...(str('board') ? { boardId: str('board') } : {}),
            ...(str('column') ? { columnId: str('column') } : {}),
            ...(ids.length ? { attachmentIds: ids } : {}),
          },
          key,
        )) as unknown as Record<string, unknown>;
      } else if (sub === 'attach') {
        step = 'attach';
        result = (await client.attach(
          (ref as { ticket: string }).ticket,
          ids,
          projectId,
          key,
        )) as unknown as Record<string, unknown>;
      } else {
        step = 'comment';
        result = (await client.comment(
          (ref as { ticket: string }).ticket,
          { body: body as string, ...(ids.length ? { attachmentIds: ids } : {}) },
          projectId,
          key,
        )) as unknown as Record<string, unknown>;
      }
      if (values.json) out(JSON.stringify(result));
      else out(typeof result.url === 'string' ? result.url : String(result.id ?? 'ok'));
      return 0;
    } catch (error) {
      const code = error instanceof TicketApiError ? error.code : 'network_error';
      const failed = error instanceof TicketApiError ? error.step : step;
      err(`everframe: ${failed} failed: ${code}${currentFile ? ` (${currentFile})` : ''}`);
      if (code === 'project_required')
        err('pass --project, set EVERFRAME_PROJECT_ID, or use the ticket link');
      return 1;
    }
  } catch (error) {
    if (error instanceof BadInput) {
      err(`everframe: ticket ${sub}: ${error.message}`);
      return 2;
    }
    err(`everframe: ticket failed`);
    return 1;
  }
}
