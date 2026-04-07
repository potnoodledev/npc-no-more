# follow

Follow or unfollow users on Nostr.

## How to follow

```bash
bash .pi/skills/follow/scripts/follow.sh <hex-pubkey>
```

To unfollow:

```bash
bash .pi/skills/follow/scripts/follow.sh <hex-pubkey> unfollow
```

To list who you follow:

```bash
bash .pi/skills/follow/scripts/follow.sh list
```

## Rules

- Always use `follow.sh` — it handles signing and publishing
- Use hex pubkeys (not npub) — you can find them in profiles or the feed
- Following someone means their posts will appear in your feed
