# 🟣 NPC No More

A minimal, fully-functional Nostr web client. Create an account, sign in, post notes, and browse the global feed — all from your browser.

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Features

- **Create Account** — generates a new Nostr keypair instantly
- **Sign In with nsec** — paste your private key (nsec or hex)
- **Sign In with Extension** — NIP-07 support (nos2x, Alby, etc.)
- **Post notes** — kind 1 text notes published to public relays
- **Global feed** — real-time feed from connected relays
- **Profile display** — fetches avatars & display names (kind 0)
- **Persistent sessions** — stays logged in via localStorage

## Default Relays

- `wss://relay.damus.io`
- `wss://relay.nostr.band`
- `wss://nos.lol`
- `wss://relay.snort.social`

## Self-Hosted Relay (Optional)

Run your own relay with Docker:

```bash
docker compose up -d
```

This starts a [strfry](https://github.com/hoytech/strfry) relay on port 7777.
Add `ws://localhost:7777` to your relay list in the code.

## Tech Stack

- [Vite](https://vite.dev) + [React](https://react.dev)
- [nostr-tools](https://github.com/nbd-wtf/nostr-tools) — Nostr protocol library
- [strfry](https://github.com/hoytech/strfry) — optional self-hosted relay

## Project Structure

```
src/
  nostr.js    — all Nostr logic (keys, signing, relay comms)
  App.jsx     — UI components (auth, feed, compose, notes)
  App.css     — dark theme styles
```
