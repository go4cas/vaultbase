---
title: Files & storage
description: File fields, local and S3 storage backends, protected downloads with access tokens, and cached image transforms.
sidebar:
  order: 8
---

## Files & storage

Two backends, selected by the `storage.driver` setting: local disk (default) or S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2 — via Bun's native S3 client, no SDK).

| Setting | Meaning |
| --- | --- |
| `storage.driver` | `local` or `s3` |
| `s3.endpoint` / `s3.bucket` / `s3.region` | Object-store target |
| `s3.access_key_id` / `s3.secret_access_key` | Credentials (encrypted at rest) |
| `s3.public_url` | Optional CDN prefix — when set, downloads redirect instead of proxying bytes |

## File fields

A `file` field stores one or more uploaded filenames on the record. Options control validation and, for private files, exactly who can download them.

| Option | Effect |
| --- | --- |
| `multiple` | Store an array of files instead of a single one |
| `maxSize` | Max bytes per file (`0` = unlimited). Oversize → `422` |
| `mimeTypes` | Allowed types (exact or `type/*`). Global allowlist violation → `415`; field violation → `422` |
| `viewRule` | Per-field download rule, AND-combined with the collection's `view_rule`. `""` = admin-only |
| `requireAuth` | Require an authenticated caller even on an otherwise-public collection |
| `protected` | When access is denied with no token present, return `401` (a signal to mint a download token) instead of `403` |
| `oneTimeToken` | Download tokens are single-use — a replay returns `410 Gone` |
| `bindTokenIp` | Bind the download token to the requester's IP — a different IP gets `403` |
| `auditDownloads` | Write a `files.download` audit row per successful fetch (records who / when / `via` rule vs token) |

Upload authorization uses the collection's `create_rule` for a new record or its `update_rule` for an existing one; both DELETE routes use `update_rule`. Admins bypass.

## Upload & download

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/files/:collection/:recordId/:field` | Upload (multipart, field name `file`) |
| `GET` | `/files/:filename` | Download (`?token=`, `?thumb=`) |
| `POST` | `/files/:collection/:recordId/:field/:filename/token` | Mint an access token |
| `DELETE` | `/files/:collection/:recordId/:field/:filename` | Delete one file (+ its thumbs) |
| `DELETE` | `/files/:collection/:recordId/:field` | Delete all files on the field → `{ deleted: n }` |

Upload as `multipart/form-data` with the form field named `file` (repeat it for a multi-file field). Uploads require auth and are authorized by the collection's create/update rule; validation (size, MIME) runs before anything is written. The stored name is `<uuid>.<ext>`.

```bash title="Upload → download"
curl -X POST .../api/v1/files/documents/rec_42/attachment \
  -H "authorization: Bearer <user-jwt>" \
  -F "file=@invoice.pdf"

→ { "data": { "id": "fil_3", "filename": "7f3c…e1.pdf",
             "originalName": "invoice.pdf", "size": 20481, "mimeType": "application/pdf" } }
# (a multi-file field returns "data": [ …fileObjects ])

# public download
GET /api/v1/files/7f3c…e1.pdf
```

Validation errors: `422` for over-size or a field-`mimeTypes` mismatch, `415` for a globally-disallowed MIME, `400` for a second file on a single-file field.

### Protected files

File download access is the collection `view_rule` AND the field's `viewRule`, plus the field flags. For gated files, mint a short-lived, file-audience token and pass it as `?token=`:

```http title="Mint a download token → fetch with it"
POST /api/v1/files/documents/rec_42/attachment/7f3c…e1.pdf/token
Authorization: Bearer <user-jwt>
→ { "data": { "token": "<file-jwt>", "expires_at": 1751503600 } }

GET /api/v1/files/7f3c…e1.pdf?token=<file-jwt>
# 401 "Token required" (protected, no token) · 403 (rule) · 410 (one-time token reused)
```

| Field flag | Effect on the download token |
| --- | --- |
| `requireAuth` | A signed-in principal is required even on public collections |
| `oneTimeToken` | Token is single-use — replay returns `410 Gone` |
| `bindTokenIp` | Token is bound to the requester's IP |
| `auditDownloads` | Each fetch writes a `files.download` audit row |

### Offloading downloads (S3)

By default the server streams file bytes through itself. On the S3 driver you can opt into `storage.redirect_downloads`: instead of proxying, the download endpoint returns a **302 redirect** to a CDN URL (when `s3.public_url` is set) or a short-lived **presigned** URL — so the transfer never touches the app process. Access checks and the `auditDownloads` row are still enforced _before_ the redirect is issued. It is deliberately skipped for `oneTimeToken` / `bindTokenIp` fields (a handed-out URL can't honour per-fetch, single-use, or IP-bound enforcement) and for server-generated thumbnails.

## Image transforms

Append `?thumb=` to any image download to get a cached, resized variant (PNG, JPEG, GIF, WebP, AVIF). Thumbnails are generated once and cached on local disk.

```bash title="Thumbnails"
/api/v1/files/<name>.jpg?thumb=200x200          # fit within (contain)
/api/v1/files/<name>.jpg?thumb=400x300_cover    # center-crop to cover
/api/v1/files/<name>.jpg?thumb=800x600&fit=crop
```

Fit modes: `contain` (default — scale to fit, may be smaller on one axis), `cover`, and `crop` (an alias of cover — center-crop to the exact box). Use either the `_mode` suffix _or_ `&fit=`, not both.

The output format always matches the source (_webp in → webp out_) — there's no format or quality override. JPEG is encoded at quality 85, animated GIF at 95, and a single-frame GIF comes back as PNG. Dimensions clamp to 1–4096; a malformed or out-of-range `thumb` spec is ignored and the full file is served. A decompression-bomb guard probes header dimensions without decoding — sources declaring more than 40 megapixels are served as-is rather than thumbnailed. Variants are generated once and cached on local disk (even when primary storage is S3) and are deleted alongside their source.
