# willsoor-fb-github

Image hosting for Willsoor.cz Facebook posts (consumed by Buffer via raw URL).

## Layout

```
posts/
  YYYY-MM-DD/
    photo.jpg       # primary image used in FB post (downscaled to ~540w, q≈85)
    photo_hi.jpg    # optional archive copy at full resolution
    meta.json       # source, prompt, archetype (optional)
```

## Public URL pattern

```
https://raw.githubusercontent.com/adamku8/willsoor-fb-github/main/posts/YYYY-MM-DD/photo.jpg
```

This URL is logged into the Google Sheet `WILLSOOR FB log` (column `lifestyle_photo_url`) and consumed by:

- **Buffer** — `mcp__buffer__create_post` as `assets.images[0].url` with `altText`
- **Approval artifact** — `<img src="...">` preview in the schvalovací panel
- **iMessage / Slack previews** — direct link

## Workflow

1. Generate image via nanobanana (`gemini_edit_image` with product as reference)
2. Compress to ~540w q≈85 JPEG (FB feed-optimized, keeps file ≤250 KB)
3. Push to `posts/YYYY-MM-DD/photo.jpg` on `main` (curl + GitHub API with PAT in `~/.config/willsoor/.env`)
4. Write raw URL into `lifestyle_photo_url` column of the Sheet log
5. After Adam approval (`/run-willsoor-publish-gate ANO` or artifact button), pass URL to Buffer with `assets.images[0].url`

## Repo policy

- **Public** — required for raw.githubusercontent.com URLs to work without auth
- **No PII / no source files** — only generated lifestyle photos + small `meta.json`
- **Retention** — keep all `posts/YYYY-MM-DD/` entries for 90 days; older can be pruned (or moved to `archive/`)
