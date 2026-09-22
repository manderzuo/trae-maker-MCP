# Runner contract

The runner maps to the AI Work gateway as follows:

| Runner action | Gateway request | Side effect |
|---|---|---|
| `doctor` | `GET /health` and authenticated `GET /v1/models` | none |
| `upload` | `POST /v1/assets` | stores one explicitly selected asset |
| `submit` | `POST /v1/videos/generations` with `Idempotency-Key` | creates one video task |
| `status` | `GET /v1/videos/{task_id}` | none |
| `wait` | repeated `status` requests | none |
| `download` | `GET /v1/videos/{task_id}/content` | writes an MP4 to `Downloads` by default |

Asset uploads are limited by the gateway (currently 32 MiB per file). A local
path is read only when the user supplied it. Returned media URLs are untrusted;
downloads use the configured gateway's authenticated content route and do not
follow redirects with the user's API Key.
