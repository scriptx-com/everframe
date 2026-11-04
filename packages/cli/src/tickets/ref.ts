// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^[1-9][0-9]{0,14}$/;
const PROJECT_PATH = /\/projects\/([^/]+)\/boards\/([^/]+)(?:\/|$)/;

const isTicketId = (value: string): boolean => NUMBER.test(value) || UUID.test(value);

/**
 * A ticket reference: a ticket number, a ticket uuid, or a dashboard link such as
 * `https://everframe.dev/admin/projects/<uuid|slug>/boards/<uuid|slug>?card=142`.
 */
export function parseTicketArg(
  arg: string,
): { ticket: string; projectId?: string; projectSlug?: string } | null {
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
  if (!match || !card || !isTicketId(card)) return null;
  // Browser links address projects by slug; the API only accepts a uuid project id.
  const project = match[1] as string;
  return UUID.test(project)
    ? { ticket: card, projectId: project }
    : { ticket: card, projectSlug: project };
}
