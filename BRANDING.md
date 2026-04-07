# Branding Guide

This app is designed to be easily rebrandable. Most branding is controlled through two mechanisms:

1. **Environment variables** (`.env`) — UI strings, colors, domain names
2. **`branding.json`** — themed content (AI prompts, room objects, care quests, skill text)

---

## Quick Rebrand: Environment Variables

Set these in `.env` (frontend vars prefixed with `VITE_`):

| Variable | Default | Purpose |
|---|---|---|
| `VITE_APP_TITLE` | `NPC No More` | App title in sidebar, headers, document title |
| `VITE_CLIENT_SLUG` | `npc-no-more` | Nostr `#l` filter tag — identifies posts from this app |
| `VITE_DASHBOARD_LABEL` | (same as APP_TITLE) | Sidebar button and page heading for game dashboard |
| `VITE_DASHBOARD_ROUTE` | `dashboard` | Hash route for the game dashboard (`#/dashboard`) |
| `VITE_CURRENCY_NAME` | `shinies` | In-game currency display name |
| `VITE_ACCENT_COLOR` | `#baff00` | Brand accent color (injected into CSS + favicon at runtime) |
| `VITE_CREATURE_TYPE` | `character` | What to call the personas (e.g. "cat", "DJ") |
| `VITE_CREATURE_TYPE_PLURAL` | `characters` | Plural form |
| `VITE_NIP05_DOMAIN` | `soulcats.xyz` | NIP-05 subdomain (e.g. `name.soulcats.xyz`) |
| `VITE_RELAY_DEFAULT_NAME` | `${APP_TITLE} Relay` | Default relay name in settings |
| `VITE_ADMIN_EMAIL_PLACEHOLDER` | `admin@${NIP05_DOMAIN}` | Placeholder in admin contact field |
| `NIP05_DOMAIN` | `soulcats.xyz` | Server-side NIP-05 domain (api-service) |
| `NIP05_FRONTEND_URL` | `https://soulcats.xyz` | NIP-05 redirect URL (api-service) |
| `APP_TITLE` | `NPC No More` | Pi-bridge agent prompt: platform name |
| `PLATFORM_DESCRIPTION` | `a Nostr social platform...` | Pi-bridge agent prompt: platform description |
| `CHARACTER_GEN_CONFIG` | (from file) | Override character-gen.json via env var (JSON string) |

### Example: "Apocalypse Radio" rebrand

```env
VITE_APP_TITLE=Apocalypse Radio
VITE_CLIENT_SLUG=apocalypse-radio
VITE_DASHBOARD_LABEL=Apocalypse Radio
VITE_DASHBOARD_ROUTE=dashboard
VITE_CURRENCY_NAME=frequencies
VITE_ACCENT_COLOR=#ff4444
VITE_CREATURE_TYPE=broadcaster
VITE_CREATURE_TYPE_PLURAL=broadcasters
VITE_NIP05_DOMAIN=apocalypseradio.xyz
VITE_RELAY_DEFAULT_NAME=Apocalypse Radio Relay
APP_TITLE=Apocalypse Radio
PLATFORM_DESCRIPTION=a Nostr social platform where post-apocalyptic radio DJs broadcast to the wasteland
```

---

## Deep Rebrand: branding.json

`branding.json` at the project root contains themed content used by multiple services:

### Character Generation Prompts

The `characterGen` object controls AI-generated character profiles:
- `systemPrompt` — system prompt for the LLM
- `userPrompt` — user prompt
- `hints` — array of character concept hints

Also mirrored in `api-service/config/character-gen.json` (loaded by api-service directly). Update both, or use the `CHARACTER_GEN_CONFIG` env var to override at deploy time.

### Room Objects

The `roomObjects` array defines the 8 default objects in every character's virtual room. Each has a `type`, `name`, `description`, and `x`/`y` position. The room-server loads these from `branding.json` at startup.

### Care Quests

The `questTemplates.care` array defines the care-category daily quests. These are seeded into the game database on first run. **Note:** changing these after initial seed requires clearing the `daily_quest_templates` table.

### Skill Text

The `skillText` object has per-skill overrides for themed language in `pi-bridge/skill-templates/`. These are currently documentation only — the skill SKILL.md files are already generic, but you can customize them further for your brand.

---

## Files That Still Need Manual Updates for Deep Rebrands

These files have theme-specific content that isn't fully driven by config:

| File | What to change |
|---|---|
| `api-service/config/character-gen.json` | AI character generation prompts and hints |
| `api-service/server.js:~666` | Avatar generation prompt template |
| `src/App.css:21-29` | CSS accent color defaults (overridden by env var at runtime, but these are the fallbacks) |
| `index.html:5` | Favicon fallback color (overridden by env var at runtime) |

---

## Rebrand Checklist

1. **Choose your brand** — name, tagline, creature/persona type, accent color, aesthetic
2. **Update `.env`** — set all `VITE_*` branding vars + server-side vars
3. **Update `branding.json`** — character gen prompts, room objects, care quests
4. **Update `api-service/config/character-gen.json`** — must match branding.json or be overridden via `CHARACTER_GEN_CONFIG` env var
5. **Optionally update** `src/App.css` accent color defaults, skill templates
6. **Clear game DB** if changing care quests after initial seed (delete `daily_quest_templates` rows)
7. **Deploy** — push env var changes to Railway, update DNS for new domain
