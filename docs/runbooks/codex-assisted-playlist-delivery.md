# Codex-Assisted Playlist Delivery Runbook

Status: draft  
Last validated: 2026-06-12

## Purpose

Use Codex as an assisted **Trigger** and **Delivery** operator for Miguel's private YouTube **Source Playlist**.

This is intentionally an agent-assisted workflow, not the production polling architecture. The CLI remains the durable local **Ingestion** surface.

## Source Playlist

```text
Name: Resumir
URL: https://www.youtube.com/playlist?list=PLzfARYkgMjXqzneFV-50u3lYT8K7Mzvdw
Playlist ID: PLzfARYkgMjXqzneFV-50u3lYT8K7Mzvdw
Expected sort: Fecha de inclusión (más recientes)
```

The playlist URL is expected to stay stable while the playlist exists. Renaming the playlist, changing privacy, or adding/removing videos should not change the `list` ID. Deleting and recreating the playlist would create a new ID.

## Browser Extraction Contract

When using the Codex in-app browser:

1. Navigate directly to the playlist URL.
2. Verify the page title or heading is `Resumir`.
3. Verify the visible sort says `Fecha de inclusión (más recientes)` when possible.
4. Extract videos only from playlist rows, not from all page links.

Use playlist row elements as the stable container:

```text
ytd-playlist-video-renderer
```

Within each row, use the title link:

```text
a#video-title
```

Do not use a global `a[href*="/watch?v="]` extraction. YouTube may keep recommendation, sidebar, or cached links in the DOM that are not part of the **Source Playlist**.

Normalize playlist video URLs to a canonical **Video** URL before calling the CLI:

```text
https://www.youtube.com/watch?v=<videoId>
```

Strip `list`, `index`, `pp`, and other tracking parameters.

## CLI Contract

For normal automated digest generation:

```sh
video-digest ingest '<youtube-url>' --email-preview --json
```

For a premium Codex-authored digest:

```sh
video-digest transcript '<youtube-url>' --json
```

Then Codex can read the **Transcript Artifact** and write a richer digest manually before **Delivery**.

Use `--json` for agent workflows. Do not parse human progress output.

## Delivery Contract

The current target is Gmail delivery to Miguel, but the exact recipient must be confirmed before first send because two addresses have appeared in the conversation:

```text
miguel.garglez@gmail.com
miguel.garles@gmail.com
```

At action time, sending an email is an external side effect. Only send when the user has clearly confirmed the exact recipient and content policy for that run or automation.

Recommended initial subject format:

```text
Video Digest: <digest title>
```

Recommended body source:

1. `emailPreviewPath` from `video-digest ingest --email-preview --json`, or
2. a Codex-authored digest derived from `video-digest transcript --json`.

## Duplicate Avoidance

Before recurring use, add a small state mechanism so the same **Video** is not sent repeatedly.

Initial local state can be a JSON file ignored by git:

```text
.local/processed-playlist-videos.json
```

Minimum shape:

```json
{
  "PLzfARYkgMjXqzneFV-50u3lYT8K7Mzvdw": {
    "ngBraLDqzdI": {
      "processedAt": "2026-06-12T00:00:00.000Z",
      "delivery": "gmail"
    }
  }
}
```

## Recommended First Smoke

1. Read the first playlist row.
2. Extract and normalize its URL.
3. Run:

   ```sh
   video-digest ingest '<url>' --email-preview --json
   ```

4. Inspect the generated `emailPreviewPath`.
5. Ask for one-time confirmation of the exact Gmail recipient.
6. Send the email.
7. Record the **Video** ID as processed.

## Known Risks

- YouTube UI and DOM can change.
- The playlist must remain accessible in the in-app browser session.
- Sort state should be verified; otherwise the first row may not be the newest addition.
- Private playlist access depends on Miguel's browser session.
- Gmail delivery depends on the connected Gmail app and explicit user authorization.
- Codex-authored premium digests cost more time and may include external research only when explicitly requested.
