# Deployment

How to host UnoCode yourself. The repository began as a fork of the tldraw monorepo, so parts of
the deployment tooling still point at tldraw's own accounts and domains; where that is true this
document says so and says what to change.

Read [Choosing a shape](#choosing-a-shape) first. The standalone shape is a static site and one
worker. The full shape adds Postgres, a sync service and an identity provider, and is considerably
more to run.

## Choosing a shape

The app has two modes, and they have very different hosting requirements.

|                              | Standalone                        | Full                                            |
| ---------------------------- | --------------------------------- | ----------------------------------------------- |
| Accounts                     | None                              | Clerk                                           |
| Board storage                | The visitor's own IndexedDB       | IndexedDB, with rows in Postgres                |
| Sidebar, workspaces, sharing | Absent                            | Present                                         |
| Voice chat and presence      | Yes                               | Yes                                             |
| Infrastructure               | Static host + 1 Cloudflare worker | Static host + 4 workers + Postgres + zero-cache |

Standalone is what `VITE_DISABLE_AUTH` selects: `@clerk/clerk-react` is swapped for a shim that
reports "signed out" (see `apps/dotcom/client/scripts/clerk-signed-out-shim.tsx`), and you get the
local scratch canvas with presence and voice on it. If what you want is a shared canvas people
reach by link, this is the whole of it.

Everything below covers both. Steps that only apply to the full shape are marked **(full only)**.

## What you are deploying

| Component                              | Where it runs                 | What it does                                                                  |
| -------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| `apps/dotcom/client`                   | Any static host               | The SPA. Built with Vite, output in `dist`                                    |
| `apps/dotcom/sync-worker`              | Cloudflare Workers            | Presence and WebRTC signalling, TURN credentials, board documents, storage GC |
| `apps/dotcom/asset-upload-worker`      | Cloudflare Workers            | Accepts uploads into R2 **(full only)**                                       |
| `apps/dotcom/tldrawusercontent-worker` | Cloudflare Workers            | Serves uploads back out of R2 **(full only)**                                 |
| `apps/dotcom/image-resize-worker`      | Cloudflare Workers            | Resizes images on the way out **(full only)**                                 |
| `apps/dotcom/zero-cache`               | Fly.io, or any container host | Replicates Postgres to browsers **(full only)**                               |
| Postgres 16 with `wal2json`            | Anywhere                      | Board, workspace and asset rows **(full only)**                               |
| coturn                                 | A VM with a public IP         | TURN relay for voice chat                                                     |

Board contents themselves never reach the server in either shape: they live in the browser's
IndexedDB. What the backend holds is the roster, the metadata rows, and the uploaded files.

## Prerequisites

- Node `>=22.12.0` and Corepack: `npm i -g corepack && yarn`
- A Cloudflare account with Workers, Durable Objects and R2 enabled. Durable Objects with SQLite
  storage need a paid plan.
- `wrangler` (comes with the repo's dependencies: `yarn workspace @tldraw/dotcom-worker exec wrangler ...`)
- A static host for the SPA. Vercel is what the bundled script uses; any host that serves a SPA
  with a catch-all rewrite to `index.html` works.
- **(full only)** A Clerk application, a Postgres 16 instance with logical replication, and a host
  for zero-cache.
- A TURN relay, unless you accept that voice is silent for some visitors. See
  [Voice chat and TURN](#voice-chat-and-turn).

## Cloudflare resources

Create these once per environment. The names below are the ones in the `wrangler.toml` files;
change the files if you want different ones.

R2 buckets:

```bash
wrangler r2 bucket create rooms
wrangler r2 bucket create rooms-preview
wrangler r2 bucket create uploads
wrangler r2 bucket create uploads-preview
```

Durable Objects need no creation step — the migrations in `apps/dotcom/sync-worker/wrangler.toml`
declare them, and the first deploy applies them. `UnoBoardPresenceDurableObject` (migration `v13`)
is the one voice chat depends on.

The rate limiter bindings under `[[env.*.unsafe.bindings]]` are Cloudflare's own rate limiting API.
The `namespace_id` values are arbitrary per account; keep them distinct per environment, which the
committed values already are.

## Routes and domains

**This is the step a fork most often skips.** `apps/dotcom/sync-worker/wrangler.toml` still routes
staging and production at `tldraw.com` and `tldraw.xyz`:

```toml
[[env.production.routes]]
zone_name = "tldraw.com"
pattern = "www.tldraw.com/api/*"

[[env.production.routes]]
custom_domain = true
pattern = "sync.tldraw.xyz"
```

Those zones are not yours, so the deploy fails or the routes never bind. Replace `zone_name` and
`pattern` in every `[[env.*.routes]]` block with your own domain, in the sync worker and in the
asset upload and user content workers. The same goes for the `MCP_*` vars under
`[env.production.vars]`, which name `www.tldraw.com`.

The SPA and the sync worker must share an origin in staging and production: the client hardcodes
`window.location.origin + '/api'` for the socket there and ignores `MULTIPLAYER_SERVER`
(`apps/dotcom/client/src/utils/config.ts`). So the worker takes `/api/*` on your domain and the
static host takes everything else. Splitting them across two origins means changing that file.

## Client build

The client reads its backend URLs from the environment **at build time**, not at runtime. Missing
ones throw during the build (`apps/dotcom/client/src/utils/config.ts`), so a misconfigured deploy
fails loudly rather than silently pointing at localhost.

| Variable                     | Example                       | Notes                                                                                                       |
| ---------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `MULTIPLAYER_SERVER`         | `https://example.com`         | The sync worker's origin. In staging and production the client ignores it and uses `location.origin + /api` |
| `USER_CONTENT_URL`           | `https://content.example.com` | The user content worker's origin                                                                            |
| `ZERO_SERVER`                | `https://zero.example.com`    | zero-cache's origin. Required by the build even in the standalone shape                                     |
| `VITE_CLERK_PUBLISHABLE_KEY` | `pk_live_...`                 | **(full only)**                                                                                             |
| `VITE_DISABLE_AUTH`          | `1`                           | Standalone shape. Omit for the full shape                                                                   |
| `TLDRAW_LICENSE`             | —                             | Optional. Removes the tldraw watermark; see [Licensing](#licensing)                                         |

Build and deploy:

```bash
yarn build-app
```

The output is `apps/dotcom/client/dist`. `apps/dotcom/client/scripts/build.ts` then copies it to
`.vercel/output/static` and, since this fork's source is not public, deletes the `.js.map` files
before deploy — Sentry still receives its own copy from the upload step. If you serve `dist`
directly with another host, delete the maps yourself or accept that the full source is readable
from devtools.

Serve it with a catch-all rewrite to `index.html`; every board URL is a client-side route.

## Sync worker

Deploy per environment:

```bash
yarn workspace @tldraw/dotcom-worker exec wrangler deploy --env production
```

Secrets go in with `wrangler secret put`, never in `wrangler.toml` — that file is committed.

| Secret                                      | Required           | What it is                                                                                           |
| ------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `TURN_URLS`                                 | For reliable voice | Comma separated relay URLs. Include a `turns:` URL on 443                                            |
| `TURN_AUTH`                                 | With `TURN_URLS`   | `secret:<shared secret>` for coturn in `--use-auth-secret` mode, or `static:<username>:<credential>` |
| `STUN_URLS`                                 | No                 | Overrides the default Cloudflare STUN servers                                                        |
| `ASSET_UPLOAD_SECRET`                       | Full               | Shared with the asset upload worker, which accepts POSTs from nobody else                            |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Full               | From the Clerk dashboard                                                                             |
| `BOTCOM_POSTGRES_CONNECTION_STRING`         | Full               | Direct connection                                                                                    |
| `BOTCOM_POSTGRES_POOLED_CONNECTION_STRING`  | Full               | Through pgbouncer                                                                                    |
| `SENTRY_DSN`                                | No                 | Error reporting                                                                                      |

Locally, the same variables go in `apps/dotcom/sync-worker/.dev.vars`, which is gitignored.

### Storage GC

The worker's `scheduled()` handler purges soft-deleted boards and workspaces past their grace
period, plus uploads no board references any more. The cron is declared for staging and production
only:

```toml
[env.production.triggers]
crons = ["*/15 * * * *"]
```

Preview deploys deliberately have none — they share buckets, and a cron on each would have them all
sweeping the same storage at once. A pass is capped, so a backlog drains over several passes and
the interval is what bounds how fast. Trigger it by hand with a POST to `/app/admin/storage_gc`,
or locally with `wrangler dev --test-scheduled`.

## Voice chat and TURN

Voice is a peer-to-peer WebRTC mesh. The server relays offers, answers and ICE candidates and hands
out ICE configuration; the audio itself never passes through it.

Without `TURN_URLS` the app falls back to STUN only. That connects an ordinary home router and
nothing behind symmetric NAT, a UDP-blocking firewall, or most VPNs — mobile carriers using CGNAT
are the common case. **The failure is silence, not an error message**, which is why the deploy
script treats `TURN_URLS` as required rather than optional.

A coturn in shared-secret mode is the cheapest relay to run:

```bash
turnserver \
  --use-auth-secret \
  --static-auth-secret=<the same secret as TURN_AUTH> \
  --realm=example.com \
  --listening-port=3478 \
  --tls-listening-port=443 \
  --cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem \
  --pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem \
  --no-cli
```

Then:

```bash
wrangler secret put TURN_URLS   # turn:turn.example.com:3478,turns:turn.example.com:443
wrangler secret put TURN_AUTH   # secret:<the same secret>
```

Port 443 over TLS matters: it is the one route that survives a genuinely restrictive network. The
worker mints per-session credentials with a 12 hour TTL (`utils/iceServers.ts`), so nothing
long-lived is handed to a browser and a leaked credential expires on its own.

A hosted relay works too — pass its long-term credentials as `static:<username>:<credential>`.

Two more things the browser requires, independent of TURN:

- **A secure context.** `getUserMedia` needs HTTPS or `localhost`. A plain `http://` LAN address
  gets no microphone.
- **The mesh is lazy.** Nothing connects until someone turns a microphone on, so an idle board
  showing no peer connections is working as intended.

Mesh topology means each participant uploads their audio once per peer. Comfortable to about six
people on a board; past that it wants an SFU, which this project does not have.

## The full shape

Skip this section entirely for the standalone shape.

### Postgres

Postgres 16 with logical replication and the `wal2json` output plugin, fronted by pgbouncer. The
local stack (`apps/dotcom/zero-cache/docker/docker-compose.yml`) is the reference for the settings
that matter:

```
-c wal_level=logical
-c max_wal_senders=10
-c max_replication_slots=5
```

Apply migrations before the first zero-cache start:

```bash
yarn workspace @tldraw/zero-cache migrate
```

### zero-cache

The replication service between Postgres and the browsers. `apps/dotcom/zero-cache` holds a
`Dockerfile.template` and Fly.io templates for a single-node and a multi-node deployment. It needs
`ZERO_UPSTREAM_DB`, `ZERO_CVR_DB`, `ZERO_CHANGE_DB`, `ZERO_REPLICA_FILE`, and `ZERO_MUTATE_URL` /
`ZERO_QUERY_URL` pointing at the sync worker's `/app/zero/mutate` and `/app/zero/query`. The
process-compose file lists the full development set.

### Clerk

Create an application, then put the publishable key in the client build environment and both keys
in the sync worker's secrets. Without them the full shape has no way to identify anyone and the
sidebar, workspaces and sharing do not work.

## The bundled deploy script

`internal/scripts/deploy-dotcom.ts` is tldraw's own CI pipeline, kept because it documents the
correct deploy order. It is **not** a general-purpose deploy tool:

- It requires around sixty environment variables, including Discord webhooks, Sentry, Plain,
  Supabase and analytics tokens that have nothing to do with running the app.
- The Fly.io organisation (`tldraw-gb-ltd`) and the Vercel project are hardcoded.
- It creates GitHub deployments and posts to Discord.

For your own hosting, deploy the pieces directly — `wrangler deploy --env <env>` per worker, then
the static build — and read the script only for the ordering it enforces: workers before the SPA,
and zero-cache before the sync worker that talks to it.

## Verifying a deploy

1. Open the app on two devices on **different** networks, not two tabs on one machine. Same-machine
   tabs connect over loopback and prove nothing about NAT traversal.
2. Turn on a microphone in both. The speaking indicator on the avatar is the signal that the gate
   is passing audio.
3. Check `chrome://webrtc-internals` for the selected candidate pair. `relay` means TURN is
   carrying it; `srflx` or `host` means the peers went direct.
4. Test from a phone on mobile data with Wi-Fi off. This is the case that fails without a working
   relay, and the one that is easiest to forget.
5. **(full only)** Create a board, reload, and confirm it is still in the sidebar — that is the
   Postgres and zero-cache path, separate from the IndexedDB one.

## Licensing

The canvas is the tldraw SDK, used under the [tldraw license](./LICENSE.md). The watermark it
renders is part of that license. It is removed with a license key from
[tldraw.dev](https://tldraw.dev), set as `TLDRAW_LICENSE` at build time — not by editing it out.
