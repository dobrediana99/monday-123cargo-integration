# monday freight webhook service

Production-oriented Node.js webhook service for monday.com, designed for Google Cloud Run and extensible to multiple freight marketplace integrations.

## Architecture

```text
src/
  index.ts                 # process entrypoint
  server.ts                # express app bootstrap
  routes/
    webhook.ts             # /webhook + /2step endpoints
  services/
    mondayClient.ts        # monday GraphQL API client
    statusRouter.ts        # status -> action routing
    eventProcessor.ts      # async event orchestration/dispatcher
  integrations/
    123cargo.ts            # 123cargo/Bursa business rules + API calls
    cargopedia.ts          # Cargopedia integration module
    transeu.ts             # Trans.eu integration module (OAuth + freight publish)
    types.ts               # integration contracts
  utils/
    config.ts              # env parsing/validation
    logger.ts              # structured logs
```

## Key behavior

- `POST /webhook`:
  - returns `{ challenge }` for monday verification payloads
  - for regular events: returns HTTP 200 immediately and processes asynchronously
- `POST /webhooks/monday` is kept for backwards compatibility.
- `POST /2step` and `POST /internal/2step/confirm` finalize 2-step confirmation flow.
- Publish trigger is a single status label: `De publicat`.
- Target marketplace is selected from monday `Site` column (`color_mm1r535n` by default):
  - `Cargopedia` -> `cargopedia`
  - `Bursa(123cargo)` -> `123cargo`
  - `Timocom` -> `timocom` (placeholder integration)
  - `Trans.eu` -> `transeu`

## Required environment variables

```env
MONDAY_TOKEN=...
BURSA_BASE=https://www.bursatransport.com/api
DEAL_OWNER_COLUMN_ID=deal_owner
ERROR_COLUMN_ID=text_mkyp9v8d
TRIGGER_STATUS_SUCCESS_LABEL=Publicata
TRIGGER_STATUS_ERROR_LABEL=Eroare
```

## Recommended environment variables

```env
PORT=8080
TRIGGER_STATUS_PROCESSING_LABEL=Procesare
ENABLED_INTEGRATIONS=123cargo,cargopedia,transeu
SITE_COLUMN_ID=color_mm1r535n

# 123cargo auth mode
FORCE_TEST_AUTH_MODE=0
TEST_BURSA_USERNAME=
TEST_BURSA_PASSWORD=
USER_MAP_JSON={"96280246":{"basicB64":"..."}}

# Optional monday columns
PRELUAT_DE_COLUMN_ID=multiple_person_mkybbcca
TIP_MARFA_COLUMN_ID=color_mksemxby
OCUPARE_CAMION_COLUMN_ID=color_mkrb3hhk
DEFAULT_LOADING_INTERVAL_DAYS=1
TWO_STEP_LINK_COLUMN_ID=
FLAGS_COLUMN_ID=
PRIVATE_NOTICE_COLUMN_ID=
EXTERNAL_LOAD_ID_COLUMN_ID=

# Legacy only (no longer used by the main publish flow)
TRIGGER_STATUS_ONLY_LABEL=De publicat
STATUS_ACTIONS_JSON={"De publicat":[{"integration":"123cargo","action":"publishLoad"}]}

# 2-step tokenized flow
APP_BASE_URL=https://your-service-url
TWO_STEP_TOKEN_TTL_SECONDS=900
TWO_STEP_TOKEN_SECRET=replace-with-long-random-secret

# Optional Cargopedia
CARGOPEDIA_BASE_URL=
CARGOPEDIA_API_KEY=
CARGOPEDIA_USER_ID=
CARGOPEDIA_API_KEY_SECRET=
CARGOPEDIA_USER_ID_SECRET=

# Optional Trans.eu (required only if `transeu` is enabled in ENABLED_INTEGRATIONS)
TRANSEU_BASE_URL=https://api.platform.trans.eu
TRANSEU_CLIENT_ID=
TRANSEU_CLIENT_SECRET=
TRANSEU_API_KEY=
TRANSEU_REFRESH_TOKEN=
# Optional alternatives for token bootstrap:
TRANSEU_ACCESS_TOKEN=
TRANSEU_AUTH_CODE=
TRANSEU_REDIRECT_URI=
```

### Cargopedia credentials via Google Secret Manager

For Cloud Run, prefer using Secret Manager references:

```env
CARGOPEDIA_BASE_URL=https://www.cargopedia.net
CARGOPEDIA_API_KEY_SECRET=projects/<PROJECT_ID>/secrets/CARGOPEDIA_API_KEY/versions/latest
CARGOPEDIA_USER_ID_SECRET=projects/<PROJECT_ID>/secrets/CARGOPEDIA_USER_ID/versions/latest
```

Supported secret reference formats:

- Full version path: `projects/<PROJECT_ID>/secrets/<SECRET_NAME>/versions/<VERSION>`
- Secret path without version: `projects/<PROJECT_ID>/secrets/<SECRET_NAME>` (auto-uses `latest`)
- Secret name only: `<SECRET_NAME>` (auto-expands with `GOOGLE_CLOUD_PROJECT` and `latest`)

For local development, `CARGOPEDIA_API_KEY` and `CARGOPEDIA_USER_ID` can still be provided directly.

## Local run

```bash
npm install
npm run build
npm start
```

Dev mode:

```bash
npm run dev
```

## Docker / Cloud Run

Build image:

```bash
docker build -t monday-freight-webhook .
```

Run container:

```bash
docker run --rm -p 8080:8080 --env-file .env monday-freight-webhook
```
