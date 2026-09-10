# dotcom

## Development

Two processes: the client, and the server that carries the directory, presence and voice
signalling. From the repo root:

```bash
yarn dev
```

That runs both. To start them separately — which is what you want when only one of them is being
worked on:

```bash
yarn workspace dotcom dev
```

```bash
UNO_ADMIN_SECRET=dev-secret yarn workspace @tldraw/dotcom-server dev
```

The app is at [localhost:3000](http://localhost:3000). The client's dev server proxies `/api` to
the server on port 8787, so both have to be up for anything past the invite wall to work.

Sign in at `/admin-login` with whatever `UNO_ADMIN_SECRET` you set, then create a workspace and a
board and invite yourself from the workspace switcher.

### Server state

The directory is a SQLite file at `apps/dotcom/server/.data/directory.sqlite`. Deleting it resets
every account, invite and board back to empty; there is nothing else server-side to reset.

Assets need object storage, which local dev has none of by default — the server says so at startup
and refuses uploads with a 503. To exercise that path, run MinIO and point the server at it:

```bash
docker run -d -p 9000:9000 -e MINIO_ROOT_USER=dev -e MINIO_ROOT_PASSWORD=devdevdev \
  quay.io/minio/minio server /data
```

```bash
S3_ENDPOINT=http://localhost:9000 S3_BUCKET=uploads \
S3_ACCESS_KEY_ID=dev S3_SECRET_ACCESS_KEY=devdevdev \
UNO_ADMIN_SECRET=dev-secret yarn workspace @tldraw/dotcom-server dev
```

Voice needs a secure context: `localhost` counts, a plain `http://` address on the local network
does not, so testing with someone on another machine needs an https tunnel. Without `TURN_URLS`
voice is STUN-only, which is enough for two machines on one network and not enough across a VPN.

Browser-side state is separate: visit `http://localhost:3000/dev/reset-local-state` to clear local
storage, IndexedDB, caches, service workers and accessible cookies for the current origin.

To host this somewhere other than your own machine, see [DEPLOYMENT.md](../../DEPLOYMENT.md).
