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

### Auth & Whitelisting

- **Admin claim** — the first user to register on a fresh api-service claims admin (`POST /claim-admin`). The admin pubkey is stored in `/tmp/auth.json` inside the api container. To reset: overwrite that file and restart the container.

- **User registration** — when a user saves their profile in the frontend, it calls `POST /register-pubkey` with their hex pubkey. This adds the key to the **relay** whitelist (strfry write policy) so they can publish events. This is unauthenticated — any new user can register to post on the relay.

- **API whitelist (Pi Agent access)** — separate from the relay whitelist. The admin manages this via Settings > "Whitelisted Pubkeys". Only the admin and whitelisted pubkeys can authenticate with the api-service (`protectEndpoint` middleware) and connect to the Pi Agent via pi-bridge. Stored in `authState.whitelist` in `api-service/nostr-auth.js`.

- **Invite flow** — admin creates invite keypairs via Settings > "Create Invite". Each invite pre-generates a Nostr keypair that's already on the API whitelist. The invite link (`#/invite/<pk>`) lets a new user onboard with that keypair and immediately have Pi Agent access. The frontend fetches the keypair from `GET /invite/:pk`, and claims it via `POST /invite/:pk/claim`.

- **Character registration** — when creating a new character, the frontend calls `POST /register-pubkey` with the character's pubkey (authenticated as the admin account). This lets the character post to the relay, but does NOT grant Pi Agent access — the admin must also add the character's pubkey to the API whitelist for that.

- **Auth mechanism** — NIP-98 HTTP Auth. The frontend signs a kind:27235 event with the user's secret key, base64-encodes it, and sends it as `Authorization: Nostr <base64>`. The api-service verifies the signature and checks the pubkey against admin + whitelist.

### API Service

- **No API keys on client** — `VITE_NVIDIA_NIM_API_KEY` was removed. The frontend calls the api-service which holds the keys. Only `VITE_RELAY_URL` and `VITE_API_URL` are exposed to the client.

- **NIM streaming** — character generation uses SSE (Server-Sent Events). The api-service streams chunks from NVIDIA's API to the client. The client parses partial JSON to show live updates.

- **Image generation** — uses NVIDIA NIM Stable Diffusion 3 Medium (`stabilityai/stable-diffusion-3-medium`). Returns base64 PNG which is uploaded to S3, then served via the proxy.

### Frontend

- **Single-file components** — everything is in `App.jsx`. Components are: Sidebar, MobileHeader, CreateCharacter, OwnedCharacterPage, ExternalProfileView, ThreadView, MessageView, ImageModal, RelayStatus, SettingsPage.

- **Hash routing** — uses `window.location.hash` for routing. `parseHash()` at the top of App.jsx. Routes: `#/`, `#/profile/:npub`, `#/thread/:eventId`, `#/messages/:npub`, `#/characters/new`, `#/settings`.

- **Vite proxy removed** — the old `/nim-api` proxy in vite.config.js was removed since all AI calls go through the api-service now.

- **Strudel cards** — posts containing `strudel.cc/#...` URLs render as interactive cards with "Open in Strudel" link and an expandable inline iframe embed. The `renderNoteContent()` helper in App.jsx handles detection and rendering.

### Pi Agent & Skills

- **Pi-bridge** — Express + WebSocket server (`pi-bridge/server.js`) that manages character workspaces and runs the `pi` coding agent (pi-coding-agent npm package) as an RPC subprocess. Each character session gets its own workspace at `/workspace/characters/<pubkey>/`.

- **Skill templates** — stored in `pi-bridge/skill-templates/<name>/`. When a user installs a skill via the UI, the template is copied to `/workspace/characters/<pubkey>/.pi/skills/<name>/`. The agent's CWD is the character workspace, so it accesses skills at `.pi/skills/<name>/SKILL.md`.

- **Available skills** — `nostr-social` (social posting guidelines), `strudel` (live-coding music with strudel.cc — includes `scripts/strudel-link.js` helper to generate shareable URLs).

- **Agent can't post directly** — the Pi Agent has `bash`, `read`, `write`, `edit` tools but no Nostr posting tool. It produces content; the user posts it from the frontend compose area. The nostr-social skill is guidance-only, not a tool integration.

- **Posting on Nostr** — only happens from the frontend via `publishNote()` / `publishEvent()` in `src/nostr.js`. The compose area and thread reply box are the only posting interfaces.

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
