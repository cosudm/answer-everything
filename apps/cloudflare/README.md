# Answer Everything on Cloudflare

One Worker (`answer-everything`) fronts two Containers on a single origin:

| Path               | Container      | Image                         | Runs                                                                                                                      |
| ------------------ | -------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/v1/*`, `/health` | `ApiContainer` | `infra/docker/api.Dockerfile` | migrations, registry seed, then the Fastify API with the embedded job runner and (outside prod) the labelled dev provider |
| everything else    | `WebContainer` | `infra/docker/web.Dockerfile` | Next.js standalone, built so the browser calls the API on the same origin                                                 |

`/metrics` is not routed: it is unauthenticated operational data and this Worker is the public edge.

## Deploy with Workers Builds

1. Cloudflare dashboard, **Workers & Pages**, **Create**, **Import a repository**, pick this repository.
2. Build settings: **Root directory** `apps/cloudflare`, **Build command** empty, **Deploy command** `npx wrangler deploy`, production branch `main`. Preview builds off.
3. Deploy. The first build takes several minutes: it builds both images and provisions the containers.
4. Open `https://answer-everything.<your-subdomain>.workers.dev`.

No secrets are needed for that first deploy. Every push to `main` redeploys.

## Storage: demo first, durable when you are ready

**Demo storage (default).** With no `DATABASE_URL`, the API container starts its own PostgreSQL with pgvector. It is real PostgreSQL with the real schema and row-level security, but it lives inside the container: accounts, conversations and knowledge are erased whenever the container restarts, which happens after about 30 minutes without requests, on every deploy, and whenever a secret changes. The interface says so on the sign-in pages and in the navigation, and `/health` reports `"storage": "ephemeral"`. It is refused when `AE_ENV=prod`.

**Durable storage.** Create a PostgreSQL 16 database that offers the `vector`, `pgcrypto` and `pg_trgm` extensions, for example on Neon or Supabase. The connecting role must be able to create roles, including one with `BYPASSRLS`; CI exercises this path against stock PostgreSQL with pgvector, so watch the container log on the first start against a managed provider. Then, in the Worker's **Settings, Variables and Secrets**, add one value of type **Secret**:

| Secret         | Value                                                                |
| -------------- | -------------------------------------------------------------------- |
| `DATABASE_URL` | the connection string of that database, ending in `?sslmode=require` |

That is enough outside production. The session secret and the two database role passwords are derived from `DATABASE_URL` (HMAC-SHA256, one per purpose), so they are stable across restarts and never stored anywhere. Saving the secret starts a fresh API container against the new database within a request or two; nothing needs redeploying.

Use type **Secret**, not **Text**: a deploy replaces plain-text variables with the ones in `wrangler.jsonc` and keeps secrets.

## Real models

Until a provider key exists, answers come from the labelled local stub. Add any of these as secrets and the registry marks the matching models as configured:

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `PERPLEXITY_API_KEY`, `PRIVATE_INFERENCE_BASE_URL`, `PRIVATE_INFERENCE_API_KEY`

On demo storage, adding a key restarts the API container and therefore clears the demo data.

## Restrict sign-up before adding a paid key

The site is public and anyone can create an account. That is harmless on the stub model. With a paid provider key it is not: each new workspace gets its own monthly model budget. Before adding a key, do one of these:

- Add a secret `AE_SIGNUP_ALLOWLIST` with the addresses and domains that may register, comma-separated, for example `ada@example.com, @yourcompany.com`. Everyone else gets a clear "invited addresses only" message.
- Or put Cloudflare Access in front of the Worker (**Settings, Domains & Routes**), which also keeps stray traffic from waking the containers.

## What it costs

Containers bill for the time they are awake: two `basic` instances are about 2 cents per hour together, and they sleep after 30 minutes without requests. Scanner traffic that every public hostname receives is answered by the Worker itself (see `isProbePath`), and `robots.txt` disallows crawling outside prod, so neither wakes a container.

## Going to production on Cloudflare

Set these in `wrangler.jsonc` under `vars`: `AE_ENV=prod`, `AE_EMBEDDED_DEV_PROVIDER=false`, `AE_EMBEDDED_DATABASE=false`, `AE_DEFAULT_ALLOW_EXPERIMENTAL=false`, and point `AE_EMBEDDING_MODEL` at a real embedding model. In prod nothing is derived: `DATABASE_URL`, `AE_SESSION_SECRET`, `AE_DB_APP_PASSWORD` and `AE_DB_IDENTITY_PASSWORD` must all be set as secrets, and the Worker answers `503 NOT_CONFIGURED` naming whichever is missing.

## How it behaves

- **Cold starts.** Containers sleep after 30 minutes idle. The next visitor sees a short "starting" page that reloads itself, and the first API call waits while migrations and the registry seed run. A browser opening any page starts waking the API in the background; scripts and crawlers do not.
- **Configuration changes.** The API container instance is named after a hash of its environment, so a changed secret gets a new instance instead of one still running with the old values. The previous instance sleeps on its own.
- **One API instance.** The in-process job runner is the only worker. To scale out, move the runner to its own container (`infra/docker/worker.Dockerfile`).
- **Client addresses.** The Worker passes Cloudflare's `CF-Connecting-IP` to the API as `X-Forwarded-For`, overwriting anything the visitor sent, so rate limits and audit records see the real address.
- **Logs.** Worker and container logs are in the dashboard under the Worker's **Observability** tab.

## Files

- `wrangler.jsonc`: containers, bindings and non-secret variables
- `src/index.ts`: routing, container start, the "starting" page
- `src/config.ts`: variables and secrets to container environment (unit tested in `src/config.test.ts`)
