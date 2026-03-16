# CLAUDE.md

## Project Overview

NPC No More is a Nostr client for managing fictional character personas. Users create characters, post on Nostr as them, and generate AI avatars. The app has a React frontend, an Express API service, a strfry Nostr relay, and Railway S3 for image storage.

## Commands

```bash
npm run dev              # Start Vite dev server (port 5173)
npm run build            # Production build to dist/
docker compose up -d     # Start relay (7777) + api service (3456)
docker compose down      # Stop containers
node tests/two-char-convo.js     # Test: two characters chat
node tests/update-profiles.js    # Test: generate avatars + profiles
```

## Architecture

- `src/` — React frontend (Vite, no API keys in client)
- `api-service/` — Express server (NVIDIA NIM proxy, image gen, S3 upload)
- `docker-compose.yml` — local dev: strfry relay + api-service
- `.github/workflows/deploy.yml` — GitHub Pages deploy for frontend

## Key Files

- `src/App.jsx` — all UI components in one file (sidebar, feed, profiles, threads, DMs, settings)
- `src/nostr.js` — Nostr protocol layer (keys, publishing, subscriptions, persistence)
- `src/nim.js` — client-side NIM integration (calls API service, not NVIDIA directly)
- `api-service/server.js` — Express server with NIM streaming, Stable Diffusion 3, S3

## Gotchas

### Railway

- **Railway CLI token** — the `RAILWAY_TOKEN` in `.env` works with the GraphQL API (`https://backboard.railway.app/graphql/v2`) but NOT with the Railway CLI. The CLI needs a different auth flow (`railway login`). Always use GraphQL for automation.

- **Storage Buckets** — Railway's GraphQL `bucketCreate` mutation creates a database record but does NOT provision the actual S3 instance. You MUST create buckets through the Railway dashboard UI. Once created there, you can query credentials via GraphQL: `bucketS3Credentials(bucketId, environmentId, projectId)`.

- **Deploying api-service** — use `serviceInstanceDeployV2` with a `commitSha` to trigger builds. The plain `serviceInstanceDeploy` often fails silently. Always pass the commit SHA:
  ```graphql
  mutation { serviceInstanceDeployV2(serviceId: "...", environmentId: "...", commitSha: "abc123") }
  ```

- **S3 bucket is private** — Railway buckets don't support public access. Images are served through the api-service as a proxy (`GET /images/:filename` → S3 GetObject → pipe to response). Image URLs in Nostr profiles point to the api-service, not directly to S3.

- **Railway service IDs** — stored in `.env` as `RELAY_SERVICE_ID`, `API_SERVICE_ID`, etc. The project ID is `RELAY_PROJECT_ID` and environment is `RELAY_ENV_ID`.

### Nostr

- **`#l` tag filter** — we use `["l", "npc-no-more"]` as a single-letter tag for relay-compatible filtering (NIP-01 only supports `#<single-char>` generic tag queries). The human-readable `["client", "npc-no-more"]` tag is also added but can't be filtered on by relays.

- **Profile data** — character profiles are stored on Nostr (kind:0 events), NOT in localStorage. The only things in localStorage are the private keys and character IDs. Profile editing fetches from relays, edits publish new kind:0 events.

- **Character keys in localStorage** — stored under `npc_characters` as an array. Each has `skHex`, `nsec`, `pk`, `npub`. The `accountFromSkHex()` function reconstructs the full account object from the hex secret key.

### API Service

- **No API keys on client** — `VITE_NVIDIA_NIM_API_KEY` was removed. The frontend calls the api-service which holds the keys. Only `VITE_RELAY_URL` and `VITE_API_URL` are exposed to the client.

- **NIM streaming** — character generation uses SSE (Server-Sent Events). The api-service streams chunks from NVIDIA's API to the client. The client parses partial JSON to show live updates.

- **Image generation** — uses NVIDIA NIM Stable Diffusion 3 Medium (`stabilityai/stable-diffusion-3-medium`). Returns base64 PNG which is uploaded to S3, then served via the proxy.

### Frontend

- **Single-file components** — everything is in `App.jsx`. Components are: Sidebar, MobileHeader, CreateCharacter, OwnedCharacterPage, ExternalProfileView, ThreadView, MessageView, ImageModal, RelayStatus, SettingsPage.

- **Hash routing** — uses `window.location.hash` for routing. `parseHash()` at the top of App.jsx. Routes: `#/`, `#/profile/:npub`, `#/thread/:eventId`, `#/messages/:npub`, `#/characters/new`, `#/settings`.

- **Vite proxy removed** — the old `/nim-api` proxy in vite.config.js was removed since all AI calls go through the api-service now.

## Railway GraphQL Cheatsheet

```bash
# Auth header for all requests
RAILWAY_TOKEN=$(grep RAILWAY_TOKEN .env | cut -d= -f2)
AUTH="Authorization: Bearer $RAILWAY_TOKEN"

# List services
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"{ project(id: \"PROJECT_ID\") { services { edges { node { id name } } } } }"}' \
  https://backboard.railway.app/graphql/v2

# Deploy with commit SHA
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"mutation { serviceInstanceDeployV2(serviceId: \"...\", environmentId: \"...\", commitSha: \"...\") }"}' \
  https://backboard.railway.app/graphql/v2

# Set env vars
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"mutation { variableCollectionUpsert(input: { projectId: \"...\", environmentId: \"...\", serviceId: \"...\", variables: { KEY: \"value\" } }) }"}' \
  https://backboard.railway.app/graphql/v2

# Get bucket S3 credentials
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"{ bucketS3Credentials(bucketId: \"...\", environmentId: \"...\", projectId: \"...\") { accessKeyId secretAccessKey endpoint bucketName region } }"}' \
  https://backboard.railway.app/graphql/v2

# Check deploy status
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"{ deployments(input: { serviceId: \"...\", environmentId: \"...\" }, first: 1) { edges { node { id status } } } }"}' \
  https://backboard.railway.app/graphql/v2
```
