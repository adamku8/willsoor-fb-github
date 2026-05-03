# willsoor-fb

Image hosting for Willsoor.cz Facebook posts (consumed by Buffer via raw URL).

## Layout

```
posts/
  YYYY-MM-DD/
    photo.png       # primary image used in FB post
    meta.json       # source, prompt, archetype (optional)
```

## Public URL pattern

```
https://raw.githubusercontent.com/adamku8/willsoor-fb/main/posts/YYYY-MM-DD/photo.png
```

## Workflow

1. Generate image via nanobanana (`gemini_generate_image` / `gemini_edit_image`)
2. Commit to `posts/YYYY-MM-DD/photo.png` on `main`
3. Pass raw URL to `mcp__buffer__create_post` as `assets.images[0].url` with `altText`
4. Schedule / shareNow on Willsoor.cz FB channel
