# Answer Everything on Cloudflare

One Worker (`answer-everything`) fronts two Containers on a single origin:

| Path                           | Container      | Image                         | Runs                                                                                                               |
| ------------------------------ | -------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/v1/*`, `/health`, `/metrics` | `ApiContainer` | `infra/docker/api.Dockerfile` | migrations → registry seed → Fastify API with the embedded job runner and (outside prod) the labelled dev provider |
| everything else                | `WebContainer` | `infra/docker/web.Dockerfile` | Next.js standalone, built with `NEXT_PUBLIC_API_URL=""` so the browser talks to the API on the same origin         |

The database is an external PostgreSQL with `vector` (Neon, Supabase, or any managed Postgres 16). Containers connect to it directly over TLS; Hyperdrive is not required.

## Deploy with Workers Builds (no local tooling needed)

1. Push this repository to GitHub.
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository** → pick the repo.
3. Build settings: **Root directory** `apps/cloudflare`, **Build command** empty, **Deploy command** `npx wrangler deploy`. Production branch `main`.
4. Before (or right after) the first build, add runtime secrets under the Worker's **Settings → Variables and Secrets** (type _Secret_):
   - `DATABASE_URL` — the admin connection string of your Postgres (include `?sslmode=require`)
   - `AE_DB_APP_PASSWORD`, `AE_DB_IDENTITY_PASSWORD` — any two long random strings; the migration runner creates the roles with them
   - `AE_SESSION_SECRET` — 32+ random characters
   - optional: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `PERPLEXITY_API_KEY`, `PRIVATE_INFERENCE_BASE_URL`, `PRIVATE_INFERENCE_API_KEY`
5. Push (or retry the build). The first deploy takes several minutes while images build and provision. Open `https://answer-everything.<your-subdomain>.workers.dev`.

Non-secret settings live in `wrangler.jsonc` → `vars`. `AE_ENV` is `uat` here on purpose: the labelled local stub stays available until real provider keys exist. For production set `AE_ENV=prod`, `AE_EMBEDDED_DEV_PROVIDER=false`, `AE_DEFAULT_ALLOW_EXPERIMENTAL=false` and point `AE_EMBEDDING_MODEL` at a real embedding model.

## Notes

- Containers sleep after 30 minutes idle; the first request afterwards waits for a cold start (migrations run on every start and are no-ops when already applied).
- The API container is pinned to one instance (`getContainer(env.API, "primary")`) so the in-process job runner is the only worker. Scale out later by moving the runner to its own container.
- Secrets are forwarded from Worker bindings to the container at start; they are never in this repository or in the image.
