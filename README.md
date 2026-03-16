# NPC No More

A Nostr client for creating and managing fictional character personas. Create characters, post as them, generate AI avatars, and interact on the Nostr protocol.

## Quick Start

```bash
npm install
docker compose up -d    # relay + api service
npm run dev
```

Open http://localhost:5173/npc-no-more/

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Frontend   │────▶│  API Service  │────▶│  Railway S3     │
│  (Vite+React)│     │  (Express)    │     │  (image storage)│
└──────┬───────┘     └──────┬───────┘     └─────────────────┘
       │                    │
       ▼                    ▼
┌──────────────┐    ┌──────────────┐
│  Nostr Relay  │    │  NVIDIA NIM  │
│   (strfry)    │    │  (AI APIs)   │
└──────────────┘    └──────────────┘
```

- **Frontend** — React SPA with sidebar character management, feeds, threads, DMs, NIP-01 profile editing
- **API Service** — Express server proxying NVIDIA NIM (character gen via LLMs, avatar gen via Stable Diffusion 3). No API keys exposed to client.
- **Nostr Relay** — strfry relay for the NPC No More community feed
- **S3 Storage** — Railway storage bucket for generated images ($0.015/GB)

## Features

- **Multi-character** — create and switch between personas via sidebar
- **Nostr protocol** — posts, replies, threads, DMs (NIP-01, NIP-04)
- **AI character generation** — random personas via NVIDIA NIM (25+ LLM models, streaming)
- **AI avatar generation** — profile pictures via Stable Diffusion 3 on NIM
- **NIP-01 profiles** — edit name, about, picture, banner, nip05, lud16, website — stored on Nostr, not localStorage
- **Dual feed** — toggle between "Our Relay" (community) and "Global Nostr"
- **Key export** — download all private keys as `.env` file from Settings
- **Image modal** — full-size preview without leaving the page
- **Unsaved changes guard** — warns before navigating away from dirty profile edits

## Environment Variables

Create `.env` in the project root:

```bash
# Relay
VITE_RELAY_URL=ws://localhost:7777

# API Service
VITE_API_URL=http://localhost:3456

# Server-side only (NOT exposed to client)
NVIDIA_NIM_API_KEY=nvapi-...
GEMINI_API_KEY=AIza...

# Railway S3
S3_ENDPOINT=https://t3.storageapi.dev
S3_BUCKET=your-bucket-name
S3_ACCESS_KEY=tid_...
S3_SECRET_KEY=tsec_...
S3_REGION=auto
```

Only `VITE_*` vars reach the client. All API keys stay in the api-service container.

## Docker Services

```bash
docker compose up -d          # start relay + api
docker compose logs -f api    # watch api logs
docker compose down            # stop everything
```

| Service | Port | Description |
|---------|------|-------------|
| relay | 7777 | strfry Nostr relay |
| api | 3456 | NIM proxy, image gen, S3 upload |

## Project Structure

```
src/
  App.jsx      — React components (sidebar, feed, profiles, threads, DMs, settings)
  App.css      — broadsheet theme, Cosmic Labs neon palette
  nostr.js     — Nostr protocol (keys, signing, publishing, subscriptions)
  nim.js       — NIM client (character + avatar gen via API service)
api-service/
  server.js    — Express (NIM streaming, Stable Diffusion 3, S3)
  Dockerfile   — Railway deployment container
tests/
  two-char-convo.js     — two characters post and reply
  update-profiles.js    — generate avatars, publish kind:0 profiles
  fix-profile-urls.js   — rewrite picture URLs to production
```

## Deployment

| Service | Platform | URL |
|---------|----------|-----|
| Frontend | GitHub Pages | https://potnoodledev.github.io/npc-no-more/ |
| Relay | Railway | wss://relay-production-d1ce.up.railway.app |
| API | Railway | https://api-service-production-51aa.up.railway.app |
| Images | Railway S3 | (served via API proxy) |

## Tests

```bash
node tests/two-char-convo.js      # two characters chat
node tests/update-profiles.js     # generate avatars + publish profiles
```

Tests read keys from `npc-no-more-keys.env` (export from Settings page).

## Tech Stack

- [Vite](https://vite.dev) + [React](https://react.dev)
- [nostr-tools](https://github.com/nbd-wtf/nostr-tools)
- [strfry](https://github.com/hoytech/strfry) — Nostr relay
- [NVIDIA NIM](https://build.nvidia.com/) — LLMs + Stable Diffusion 3
- [Railway](https://railway.com/) — hosting + S3 storage
- [Express](https://expressjs.com/) — API service
