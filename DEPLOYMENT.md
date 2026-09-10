# Deployment

How to host UnoCode yourself, on your own infrastructure, with no Cloudflare account.

Everything here covers the standalone shape: invite-only access with one administrator, boards
stored in each visitor's own browser, presence and voice chat on top. That is the whole of the
app — the full shape (Clerk accounts, Postgres, zero-cache) is not part of this deployment and its
Cloudflare workers are not used by it.

## What you are deploying

| Component | What it does                                                        | Image                      |
| --------- | ------------------------------------------------------------------- | -------------------------- |
| `web`     | TLS, serves the SPA, proxies `/api` to the API                      | `deploy/Dockerfile.web`    |
| `api`     | The invite directory, presence and WebRTC signalling, asset storage | `deploy/Dockerfile.server` |
| `storage` | S3-compatible object storage for images, audio and video on boards  | MinIO                      |
| `turn`    | Relays voice when two browsers cannot reach each other directly     | coturn                     |

Board contents never reach the server. They live in the browser's IndexedDB; what the backend holds
is the roster, the directory around the boards, and the files people drop onto them.

## Decide where the relay runs first

**This is the one choice that shapes everything else.** A TURN relay needs a public IP address and
a wide UDP port range (`49152–65535`) reachable from the internet, plus port 443 for TLS. Container
platforms often publish individual ports only, and sixteen thousand of them through a userland
proxy does not work.

So, before anything else, find out whether your platform can give one container a public address
and that port range:

- **Yes** — deploy all four services together, as `deploy/docker-compose.yml` does.
- **No** — deploy `web`, `api` and `storage` on the platform, and put coturn on a small plain VM of
  its own. Nothing else changes: the relay is reached by the browser directly, and the API only
  needs to know its URL and shared secret.

Skipping the relay entirely is a supported configuration and a bad one. Voice then falls back to
STUN, which connects an ordinary home router and nothing behind symmetric NAT, a UDP-blocking
firewall, or a VPN — mobile networks are the common case. **The failure is silence, not an error
message.**

## Prerequisites

- A domain name, pointed at the host that will run `web`. Caddy obtains its certificate on first
  start, which needs the name to already resolve and ports 80 and 443 to be reachable.
- Docker with Compose, or a container platform that builds from a Dockerfile.
- **HTTPS. Not optional.** `getUserMedia` hands out no microphone outside a secure context, so
  voice cannot work over plain `http://` on anything but `localhost`.

## Configure

```bash
cp deploy/.env.example deploy/.env
```

Then fill it in. Every value is commented in the file itself; these three are the ones that most
often go wrong:

- **`UNO_ADMIN_SECRET`** — generate it, don't invent it: `openssl rand -hex 32`. Unset, nobody can
  sign in as admin and therefore nobody can be invited: the service starts and is unusable.
- **`PUBLIC_ORIGIN`** — baked into the client bundle at build time, not read at runtime. Changing
  the domain later means rebuilding the `web` image, not restarting it.
- **`TURN_AUTH`** — `secret:<value>`, where `<value>` is character-for-character the
  `static-auth-secret` in `deploy/turnserver.conf`. A mismatch produces credentials the relay
  rejects, which again presents as silence.

Also edit `deploy/turnserver.conf`: the shared secret, your `realm`, the public IP in
`external-ip`, and the certificate paths.

## Deploy on one host

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

The first build takes a few minutes — it installs the workspace and builds the SPA. After that:

```bash
docker compose -f deploy/docker-compose.yml logs -f api
curl https://board.example.com/api/health
```

`/api/health` reports `{"ok":true,...}` and the number of live boards and participants.

## Deploy on a container platform

A platform that builds one image per service (Dockhost and most others) wants the same four
services, configured individually rather than through Compose.

**`api`** — build `deploy/Dockerfile.server` with the repository root as the build context.

| Setting           | Value                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port              | `8787`                                                                                                                                                |
| Persistent volume | `/data` — **required**. Without it every restart begins with an empty directory                                                                       |
| Environment       | `UNO_ADMIN_SECRET`, `TRUST_PROXY=true`, `TURN_URLS`, `TURN_AUTH`, `STUN_URLS`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |

**Run exactly one instance.** Presence rosters live in this process's memory; a second replica
would put the people on one board into two rosters that cannot see or hear each other. There is no
setting that makes two instances safe — see [Limits](#limits).

**`storage`** — MinIO, or any S3-compatible server. Give it a persistent volume for its data and
create the bucket named in `S3_BUCKET` once:

```bash
mc alias set local http://storage:9000 <user> <password>
mc mb local/unocode-uploads
```

**`web`** — build `deploy/Dockerfile.web` with the repository root as the build context and
`--build-arg PUBLIC_ORIGIN=https://board.example.com`. Publish ports 80 and 443, and give it a
persistent volume on `/data` so Caddy's certificates survive a restart — without one it re-issues
on every start and will meet Let's Encrypt's rate limit.

If the platform terminates TLS itself and gives you an internal HTTP port instead, set
`SITE_ADDRESS=:80` and let it handle certificates. Keep `TRUST_PROXY=true` on the API either way.

**`turn`** — see [the relay decision above](#decide-where-the-relay-runs-first). On a plain VM:

```bash
docker run -d --network host \
  -v /etc/coturn/turnserver.conf:/etc/coturn/turnserver.conf:ro \
  -v /etc/letsencrypt:/etc/letsencrypt:ro \
  coturn/coturn:latest -c /etc/coturn/turnserver.conf
```

`web` reaches `api` at whatever hostname the platform gives it. `deploy/Caddyfile` proxies to
`api:8787`; if the platform names it differently, change that one line before building.

## The administrator, and letting people in

The app is invite-only, and one account hands out the invites. Its name and email are fixed in
`packages/dotcom-shared/src/unoDirectory.ts` (`Mikhail`, `mpm@unocode.ru`); what proves it is
`UNO_ADMIN_SECRET`, not the address — anyone can type an email, so the address alone would be no
check. Editing those constants renames the account; do it before the first sign-in rather than
after, since the previous row keeps its admin flag until it is removed.

Sign in at `/admin-login`, create a workspace and a board, then copy an invite link from the
workspace switcher in the header — one link for a whole workspace, one for a single board. The
People panel, next to the theme toggle, lists everyone who has joined and is where access is taken
away again; removing someone ends the call they are on, rather than waiting for their next reload.

A visitor without an invite sees an "invite only" screen and nothing else.

If the secret is lost, replace it in the environment and restart the API. Existing sessions stay
valid, so a lost secret locks out new admin sign-ins rather than the running service.

## Migrating from the Cloudflare deployment

Skip this for a fresh install. Durable Object storage cannot be copied off Cloudflare any other
way, so if the old deployment has real accounts and invite links, export them **before** turning it
off.

Sign in as admin on the old deployment, then:

```bash
curl -H "authorization: Bearer <admin session token>" \
  https://old.example.com/api/uno/admin/export > directory.json
```

Copy the file into the API container and load it:

```bash
docker compose -f deploy/docker-compose.yml cp directory.json api:/data/directory.json
docker compose -f deploy/docker-compose.yml exec api node import-directory.js /data/directory.json
```

Everyone's session tokens, memberships and invite links keep working; nobody has to join again. The
import refuses to run against a directory that already has accounts in it, because merging two
would silently produce duplicates for anyone in both.

Board contents are not migrated and do not need to be: they are in each person's own browser and
were never on the server.

Uploaded assets are not migrated by this. If the old R2 bucket holds files that boards still point
at, copy them across with `rclone` before switching the domain over — the URLs are the same paths
under the new origin.

## Verifying a deploy

1. Open the app on two devices on **different** networks. Two tabs on one machine connect over
   loopback and prove nothing about NAT traversal.
2. Turn on a microphone in both. The speaking indicator on the avatar is the signal that audio is
   flowing.
3. Check `chrome://webrtc-internals` for the selected candidate pair. `relay` means TURN is
   carrying it; `srflx` or `host` means the peers went direct.
4. **Test from a phone on mobile data with Wi-Fi off.** This is the case that fails without a
   working relay, and the one that is easiest to forget.
5. Drop an image and an audio file onto a board, reload, and confirm both are still there. That is
   the object storage path, separate from everything else.
6. Restart the API and confirm the sidebar still lists the same boards. That is the volume; if it
   is missing, this is where you find out rather than in a month.

## Backups

One thing needs backing up and one thing is nice to have:

- **The directory** — `/data/directory.sqlite` in the API container. Every account, membership and
  invite link. Its loss cannot be recovered from anywhere; everyone would have to be invited again.
  It is a SQLite file, so a copy is a backup: `sqlite3 directory.sqlite ".backup /backup/dir.db"`
  takes a consistent one without stopping the service.
- **The bucket** — the uploaded images and audio. Boards referencing a missing asset still open,
  with the asset blank.

Caddy's certificate store is not worth backing up; it re-issues.

## Limits

- **One API instance.** Presence is in-memory. Scaling out needs a shared bus and sticky routing by
  board id, which this deployment does not have.
- **Sixteen people per board**, and comfortably about six on a voice call. The mesh is O(n²) — each
  participant sends their audio once per peer. Past that it wants an SFU, which this project does
  not have.
- **25MB per uploaded asset**, above the editor's own 10MB limit so a legitimate upload never meets
  it.

## Licensing

Everything you install is free software: Node (MIT), Caddy (Apache 2.0), coturn (BSD), MinIO
(AGPL v3 — swap in Garage or SeaweedFS if AGPL does not suit you), and the server's own
dependencies (MIT).

The canvas itself is the tldraw SDK, used under the [tldraw license](./LICENSE.md). The watermark
it renders is part of that license. It is removed with a key from [tldraw.dev](https://tldraw.dev),
set as `TLDRAW_LICENSE` at build time — not by editing it out.
