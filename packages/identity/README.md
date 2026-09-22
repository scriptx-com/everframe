<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @traceitx/identity

Mint [TraceItX](https://traceitx.com) identity tokens from any runtime.

One `createIdentityHandler` call returns a standard
`(Request) => Promise<Response>` — which is simultaneously a Next App Router
handler, a Cloudflare Worker, a Vercel/Netlify Edge function, a Supabase Edge
Function and a Deno/Bun handler.

```ts
// app/api/traceitx-identity/route.ts
import { createIdentityHandler } from '@traceitx/identity';

const handler = createIdentityHandler({
  secret: process.env.TRACEITX_IDENTITY_SECRET!,
  projectId: process.env.TRACEITX_PROJECT_ID!,
  resolveUser: async (req) => {
    const user = await getSessionUser(req);   // cookie, bearer, anything
    return user ? { id: user.id, email: user.email, name: user.name } : null;
  },
});

// Export for BOTH verbs. A cross-origin request carrying `Authorization` is
// ALWAYS preflighted with an OPTIONS request first — exporting only GET lets
// Next answer that preflight itself with a bare `Allow` header, so the
// handler's CORS headers (see "Cross-origin" below) never reach the browser
// and recognition silently stops working for every cross-origin caller.
export { handler as GET, handler as OPTIONS };
```

Then point the SDK at it:

```tsx
<TraceItXProvider
  config={{ apiKey }}
  identity={{ endpoint: '/api/traceitx-identity', key: user?.id }}
>
```

## Auth is a callback, not a cookie

`resolveUser` receives the `Request`. Cookies are one implementation; a bearer
token is another:

```ts
resolveUser: (req) => verifyAccessToken(req.headers.get('authorization'))
```

On the client, `headers` is re-invoked on **every** mint, so a rotating access
token is never captured stale:

```tsx
identity={{
  endpoint: 'https://api.example.com/traceitx-identity',
  key: user?.id,
  headers: async () => ({ Authorization: `Bearer ${await getAccessToken()}` }),
}}
```

## Cross-origin

Pass `allowedOrigins` to answer preflights and echo matched origins. Absent, the
handler is same-origin only. `'*'` throws — a wildcard origin on an endpoint
that returns identity tokens would expose them to any site.

```ts
createIdentityHandler({ …, allowedOrigins: ['https://app.example.com'] })
```

## Node

```ts
import { toNodeHandler } from '@traceitx/identity/node';
const nodeHandler = (req, res) => void toNodeHandler(handler)(req, res);

// Register for BOTH verbs — or use app.all(...) — for the same reason as the
// Next example above: a cross-origin request carrying `Authorization` is
// ALWAYS preflighted with OPTIONS first. Registering only `.get(...)` means
// Express answers OPTIONS with a 404 before it ever reaches the handler, so
// its CORS headers never appear and recognition silently stops working for
// every cross-origin caller.
app.get('/api/traceitx-identity', nodeHandler);
app.options('/api/traceitx-identity', nodeHandler);
```

## Responses

| Case | Response |
|---|---|
| User resolves | `200 { token, expiresAt }` (`expiresAt` is ms epoch) |
| Nobody signed in | `200 { token: null }` |
| `user.id` empty or >255 chars | `200 { token: null, reason: 'subject_too_long' }` |
| `resolveUser` throws | `500`, empty body |

Every response carries `Cache-Control: no-store`. A signed-out user is a normal
state, not an error — all `token: null` cases read as "anonymous" to the SDK.

## Licence

MIT
