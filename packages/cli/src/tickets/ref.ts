// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^[1-9][0-9]{0,14}$/;
const PROJECT_PATH = /\/projects\/([0-9a-f-]{36})\/boards\/([0-9a-f-]{36})(?:\/|$)/i;

const isTicketId = (value: string): boolean => NUMBER.test(value) || UUID.test(value);

/**
 * A ticket reference: a ticket number, a ticket uuid, or a dashboard link such as
 * `https://everframe.dev/admin/projects/<uuid>/boards/<uuid>?card=142`.
 */
export function parseTicketArg(arg: string): { ticket: string; projectId?: string } | null {
  const value = arg.trim();
  if (isTicketId(value)) return { ticket: value };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const match = PROJECT_PATH.exec(url.pathname);
  const card = url.searchParams.get('card');
  if (!match || !UUID.test(match[1] as string) || !UUID.test(match[2] as string)) return null;
  if (!card || !isTicketId(card)) return null;
  return { ticket: card, projectId: match[1] as string };
}
