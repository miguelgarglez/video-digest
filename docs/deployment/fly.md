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
