# pulsenet-customer-vercel

PulseNet Customer Portal — standalone Vite + React SPA, extracted from the
`pulsenet` monorepo (`artifacts/customer-portal`) so it can be deployed to
Vercel on its own, independent of the backend and of the admin dashboard.

Includes: customer login and OTP authentication, package selection, STK
push (M-Pesa) payment flow, dashboard, active/session history, wallet and
loyalty ("Bonga") points, subscription status, payment history, and
customer profile management. The MikroTik hotspot captive-portal HTML
(`mikrotik-hotspot/hotspot/`) is a separate static asset served directly by
the router, not part of this React app, and is unaffected by this
extraction — see the note at the bottom.

## What changed vs. the monorepo copy

Same three structural changes as `pulsenet-admin-vercel` (this app shares
the same shell/tooling as the admin app in the source repo):

1. **`@workspace/api-client-react` vendored in** unchanged at
   `src/lib/api-client/` (it had no dependency on any other workspace
   package — only `@tanstack/react-query`). All imports rewritten from
   `@workspace/api-client-react` to `@/lib/api-client`.
2. **`main.tsx` now calls `setBaseUrl(import.meta.env.VITE_API_BASE_URL)`**
   at startup, using the client's existing (previously unused) base-URL
   support. `src/lib/auth.tsx` already called `getBaseUrl()` for its token
   refresh `fetch()` call — that code was untouched and now resolves
   correctly since `setBaseUrl` is actually called at boot.
3. **`vite.config.ts` / `tsconfig.json` / `package.json`** de-monorepo'd the
   same way as the admin app: no required `PORT`/`BASE_PATH`/`REPL_ID`,
   Replit-only dev plugins and the unused `@assets` alias dropped, no
   `tsconfig.base.json` extends, `catalog:` versions resolved to pinned
   semver ranges, `@workspace/api-client-react: workspace:*` removed.

Nothing in `src/pages`, `src/components`, `src/hooks`, or business logic was
changed.

## Install & build (verified)

```bash
npm install
npm run build      # -> dist/
npm run typecheck  # optional; see note below
```

`npm run build` was run end-to-end during extraction. `npm run typecheck`
surfaces a few pre-existing type mismatches between `@tanstack/react-query`
hook call sites and the orval-generated query option types (missing
`queryKey` on inline option objects in `dashboard.tsx`, `packages.tsx`,
`sessions.tsx`). These predate this extraction (Vite's build doesn't
type-check, so they never blocked a build before either).

## Environment variables

See `.env.example`.

| Variable | Required | Description |
|---|---|---|
| `VITE_API_BASE_URL` | Recommended | Base URL of the deployed `pulsenet-api` backend, e.g. `https://api.pulsenet.example.co.ke`. Omit only if this app and the API share an origin. |

## Deploying to Vercel

1. Push this folder to its own git repo (or set it as Vercel's root
   directory).
2. Import in Vercel → Framework Preset: **Vite**.
3. Build command `npm run build`, output directory `dist` (both already set
   in `vercel.json`).
4. Add `VITE_API_BASE_URL`.
5. Add this deployment's URL to `CORS_ORIGINS` on the `pulsenet-api`
   backend.
6. Deploy.

`vercel.json` includes a catch-all rewrite to `index.html` for client-side
routing.

## About the MikroTik captive-portal login page

`mikrotik-hotspot/hotspot/login.html` (in the original repo, not part of
this package) is a separate, self-contained HTML page RouterOS itself serves
to devices joining the hotspot — it's not built by Vite and doesn't import
anything from this React app. It calls the same backend
(`pulsenet-api`'s public portal endpoints) directly via `fetch()`, which is
why `CORS_ORIGINS` in the backend's `.env.example` includes an
`http://login.pulsenet.test`-style entry. No action needed here; flagged so
it isn't mistaken for a missing piece of this portal.

## Known blockers / follow-ups

- No original lockfile shipped with the source monorepo; `package-lock.json`
  here was generated fresh from the declared semver ranges. Review
  `npm audit` before first production deploy.
- The pre-existing type mismatches noted above are cosmetic and don't affect
  the built bundle.
