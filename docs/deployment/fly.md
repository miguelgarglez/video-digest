# Fly Deployment

## App

- Fly app: `personal-video-digest`
- Public URL: `https://personal-video-digest.fly.dev/`
- Primary region: `cdg`
- Runtime data volume: `video_digest_data` mounted at `/data`

The app runs as a single Bun process with a Python/uv sidecar available inside the
same container. SQLite and generated artifacts live on the Fly volume:

```text
/data/ingestions.sqlite
/data/outputs/
```

## Runtime Secrets

The Fly app needs:

```text
OPENCODE_API_KEY
```

Set or rotate it with:

```sh
flyctl secrets set OPENCODE_API_KEY=... --app personal-video-digest
```

## Transcript Provider Proxy

YouTube often blocks transcript requests from cloud-provider IPs. When that happens,
`youtube-transcript-api` returns an IP-blocking error even for videos that work
locally. The app supports proxy configuration through Fly secrets.

Preferred option for `youtube-transcript-api` is Webshare residential proxies:

```sh
flyctl secrets set \
  YOUTUBE_TRANSCRIPT_WEBSHARE_USERNAME=... \
  YOUTUBE_TRANSCRIPT_WEBSHARE_PASSWORD=... \
  YOUTUBE_TRANSCRIPT_WEBSHARE_LOCATIONS=fr,de,es \
  --app personal-video-digest
```

Generic HTTP/HTTPS proxy URLs are also supported:

```sh
flyctl secrets set \
  YOUTUBE_TRANSCRIPT_PROXY_HTTP_URL=http://user:pass@host:port \
  YOUTUBE_TRANSCRIPT_PROXY_HTTPS_URL=https://user:pass@host:port \
  --app personal-video-digest
```

## Logs

Tail production logs with:

```sh
flyctl logs --app personal-video-digest
```

The web ingestion flow emits JSON lines with `source = "personal-video-digest"` and
events such as:

```text
ingestion.transcript_unavailable
```

For one-off debugging inside the running machine:

```sh
flyctl ssh console --app personal-video-digest
```

## Manual Deploy

Use the root `fly.toml` and build remotely:

```sh
flyctl deploy --remote-only --app personal-video-digest --config fly.toml
```

Useful verification commands:

```sh
flyctl status --app personal-video-digest
flyctl logs --app personal-video-digest --no-tail
curl -fsS https://personal-video-digest.fly.dev/ | rg "Personal Video Digest"
```

## GitHub Actions Deploy

`.github/workflows/fly-deploy.yml` deploys on pushes to `main` when product web or
runtime files change. Documentation-only changes do not trigger a deploy.

The workflow requires the repository secret:

```text
FLY_API_TOKEN
```

Use a Fly deploy token scoped to this app:

```sh
flyctl tokens create deploy --app personal-video-digest --name github-actions-main --expiry 8760h
```

Then store the full token value as the GitHub Actions secret `FLY_API_TOKEN`.
