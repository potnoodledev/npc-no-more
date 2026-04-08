const { Room } = require("colyseus");
const { JamStudioState, InstrumentState } = require("../schema/JamStudioState.js");
const { PlayerState, ChatMessage } = require("../schema/RoomState.js");
const { saveRecording } = require("../recordings.js");
const { verifyNostrAuth } = require("../nostr-auth.js");

const MAX_CHAT = 50;
const INTERACT_DISTANCE = 2;

const DEFAULT_INSTRUMENTS = [
  { type: "drums", name: "Drum Machine", description: "A beat-up TR-808 clone covered in stickers.", x: 3, y: 3 },
  { type: "bass", name: "Bass Synth", description: "A rumbling mono synth with thick cables everywhere.", x: 12, y: 3 },
  { type: "keys", name: "Electric Piano", description: "A vintage Fender Rhodes with sticky keys.", x: 3, y: 12 },
  { type: "sampler", name: "Sample Pad", description: "An MPC with paw-print marks on every pad.", x: 12, y: 12 },
];

function dist(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

class JamStudioRoom extends Room {
  onCreate(options) {
    this.setState(new JamStudioState());
    this.maxClients = 20;
    this.autoDispose = true;

    this.state.ownerPubkey = options.characterPubkey || "";
    this.state.ownerName = options.characterName || "";
    this.state.scene = "jam_studio";
    this.state.bpm = 120;
    this.state.createdAt = Date.now();

    // ── Recording ──
    this._startedAt = Date.now();
    this._participants = new Map();
    this._recordedEvents = [];

    // Place default instruments
    for (const def of DEFAULT_INSTRUMENTS) {
      const inst = new InstrumentState();
      inst.id = `${def.type}_${def.x}_${def.y}`;
      inst.type = def.type;
      inst.name = def.name;
      inst.description = def.description;
      inst.x = def.x;
      inst.y = def.y;
      this.state.instruments.set(inst.id, inst);
    }

    this.setMetadata({
      ownerPubkey: options.characterPubkey,
      ownerName: options.characterName,
      scene: "jam_studio",
    });

    // ── Standard message handlers (move, chat, emote, activity) ──

    this.onMessage("move", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const tx = Math.max(0, Math.min(this.state.width - 1, Math.round(data.x)));
      const ty = Math.max(0, Math.min(this.state.height - 1, Math.round(data.y)));
      const fromX = player.x, fromY = player.y;
      player.x = tx;
      player.y = ty;
      player.animation = "idle";
      this._record("move", player.pubkey, player.displayName, { fromX, fromY, toX: tx, toY: ty });
    });

    this.onMessage("chat", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !data.content) return;
      const msg = new ChatMessage();
      msg.sender = player.pubkey;
      msg.senderName = player.displayName;
      msg.content = data.content.slice(0, 500);
      msg.timestamp = Date.now();
      this.state.chat.push(msg);
      while (this.state.chat.length > MAX_CHAT) this.state.chat.shift();
      this._record("chat", player.pubkey, player.displayName, { content: msg.content });
    });

    this.onMessage("emote", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !data.animation) return;
      player.animation = data.animation;
      this._record("emote", player.pubkey, player.displayName, { animation: data.animation });
    });

    this.onMessage("activity", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      player.activity = (data.activity || "").slice(0, 100);
      this._record("activity", player.pubkey, player.displayName, { activity: player.activity });
    });

    // ── Instrument handlers ──

    this.onMessage("play", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !data.instrumentId) return;
      const inst = this.state.instruments.get(data.instrumentId);
      if (!inst) {
        client.send("play_result", { error: "Instrument not found" });
        return;
      }
      // Auto-move to instrument if too far
      const d = dist(player.x, player.y, inst.x, inst.y);
      if (d > INTERACT_DISTANCE) {
        // Move player adjacent to the instrument
        const dx = inst.x - player.x;
        const dy = inst.y - player.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        player.x = Math.round(inst.x - (dx / len) * 1);
        player.y = Math.round(inst.y - (dy / len) * 1);
        player.x = Math.max(0, Math.min(this.state.width - 1, player.x));
        player.y = Math.max(0, Math.min(this.state.height - 1, player.y));
      }
      // Check vacancy
      if (inst.playerSessionId && inst.playerSessionId !== client.sessionId) {
        client.send("play_result", { error: `${inst.playerName || "Someone"} is already playing this instrument.` });
        return;
      }
      const pattern = (data.pattern || "").slice(0, 2000);
      inst.playerSessionId = client.sessionId;
      inst.playerName = player.displayName;
      inst.pattern = pattern;
      player.animation = "playing";
      client.send("play_result", { ok: true, instrumentId: inst.id });
      this._record("play_instrument", player.pubkey, player.displayName, {
        instrumentId: inst.id, instrumentName: inst.name, pattern,
      });
    });

    this.onMessage("update_pattern", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !data.instrumentId) return;
      const inst = this.state.instruments.get(data.instrumentId);
      if (!inst || inst.playerSessionId !== client.sessionId) {
        client.send("update_result", { error: "You're not playing this instrument." });
        return;
      }
      inst.pattern = (data.pattern || "").slice(0, 2000);
      client.send("update_result", { ok: true, instrumentId: inst.id });
      this._record("update_pattern", player.pubkey, player.displayName, {
        instrumentId: inst.id, pattern: inst.pattern,
      });
    });

    this.onMessage("stop_playing", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !data.instrumentId) return;
      const inst = this.state.instruments.get(data.instrumentId);
      if (!inst || inst.playerSessionId !== client.sessionId) return;
      inst.playerSessionId = "";
      inst.playerName = "";
      inst.pattern = "";
      player.animation = "idle";
      client.send("stop_result", { ok: true, instrumentId: inst.id });
      this._record("stop_instrument", player.pubkey, player.displayName, { instrumentId: inst.id });
    });

    this.onMessage("mute_instrument", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !data.instrumentId) return;
      const inst = this.state.instruments.get(data.instrumentId);
      if (!inst) return;
      // Owner or the instrument player can mute
      if (player.pubkey !== this.state.ownerPubkey && inst.playerSessionId !== client.sessionId) return;
      inst.muted = !!data.muted;
      this._record("mute_instrument", player.pubkey, player.displayName, {
        instrumentId: inst.id, muted: inst.muted,
      });
    });

    this.onMessage("set_bpm", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      if (player.pubkey !== this.state.ownerPubkey) {
        client.send("bpm_result", { error: "Only the studio owner can change BPM." });
        return;
      }
      const bpm = Math.max(40, Math.min(300, Math.round(data.bpm)));
      this.state.bpm = bpm;
      this._record("set_bpm", player.pubkey, player.displayName, { bpm });
    });

    this.onMessage("place_instrument", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      if (player.pubkey !== this.state.ownerPubkey) {
        client.send("place_result", { error: "Only the studio owner can place instruments." });
        return;
      }
      const { type, name, description, x, y } = data;
      if (!type || !name || x == null || y == null) {
        client.send("place_result", { error: "Missing type, name, x, or y" });
        return;
      }
      const validTypes = ["drums", "bass", "keys", "sampler"];
      if (!validTypes.includes(type)) {
        client.send("place_result", { error: `Invalid type. Use: ${validTypes.join(", ")}` });
        return;
      }
      const px = Math.max(0, Math.min(this.state.width - 1, Math.round(x)));
      const py = Math.max(0, Math.min(this.state.height - 1, Math.round(y)));
      const id = `${type}_${px}_${py}_${Date.now()}`;
      const inst = new InstrumentState();
      inst.id = id;
      inst.type = type;
      inst.name = name;
      inst.description = (description || "").slice(0, 200);
      inst.x = px;
      inst.y = py;
      this.state.instruments.set(id, inst);
      client.send("place_result", { ok: true, instrumentId: id });
      this._record("place_instrument", player.pubkey, player.displayName, {
        instrumentId: id, instrumentName: name, type, x: px, y: py,
      });
    });

    // ── Look (enhanced with instruments) ──

    this.onMessage("look", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const lines = [];
      lines.push(`Jam Studio: ${this.state.ownerName || "Unknown"}'s studio`);
      lines.push(`Your position: (${player.x}, ${player.y})`);
      lines.push(`Size: ${this.state.width}x${this.state.height}  |  BPM: ${this.state.bpm}`);

      // Players
      const nearbyPlayers = [];
      this.state.players.forEach((p, sid) => {
        if (sid === client.sessionId) return;
        const d = dist(player.x, player.y, p.x, p.y);
        const status = p.activity ? `${p.animation}, ${p.activity}` : p.animation;
        nearbyPlayers.push({ name: p.displayName || p.pubkey.slice(0, 12), dist: d, status });
      });
      nearbyPlayers.sort((a, b) => a.dist - b.dist);
      if (nearbyPlayers.length > 0) {
        lines.push("\nCats in studio:");
        for (const p of nearbyPlayers) {
          lines.push(`  - ${p.name} (${p.dist.toFixed(1)} tiles away, ${p.status})`);
        }
      } else {
        lines.push("\nNo other cats here.");
      }

      // Instruments
      const instruments = [];
      this.state.instruments.forEach((inst) => {
        const d = dist(player.x, player.y, inst.x, inst.y);
        instruments.push({
          id: inst.id, name: inst.name, type: inst.type,
          dist: d, description: inst.description,
          player: inst.playerName || null,
          pattern: inst.pattern || null,
          muted: inst.muted,
        });
      });
      instruments.sort((a, b) => a.dist - b.dist);

      lines.push("\nInstruments:");
      for (const i of instruments) {
        const reachable = i.dist <= INTERACT_DISTANCE ? "[within reach]" : `(${i.dist.toFixed(1)} tiles away)`;
        const status = i.player
          ? `played by ${i.player}${i.muted ? " [MUTED]" : ""}`
          : "vacant";
        lines.push(`  - ${i.name} (${i.type}) ${reachable} — ${status} [id: ${i.id}]`);
        if (i.pattern) {
          const preview = i.pattern.length > 60 ? i.pattern.slice(0, 60) + "..." : i.pattern;
          lines.push(`    pattern: ${preview}`);
        }
      }

      // Recent chat
      const recentChat = this.state.chat.slice(-5);
      if (recentChat.length > 0) {
        lines.push("\nRecent chat:");
        for (const msg of recentChat) {
          lines.push(`  ${msg.senderName}: ${msg.content}`);
        }
      }

      client.send("look_result", { text: lines.join("\n") });
    });

    console.log(`[jam] Created ${this.state.ownerName}'s studio (${this.roomId})`);
  }

  // ── Recording helper ──

  _record(type, actorPubkey, actorName, data) {
    this._recordedEvents.push({
      t: Date.now() - this._startedAt,
      type,
      actor: actorPubkey,
      name: actorName,
      data,
    });
  }

  async onAuth(client, options) {
    if (options.isAgent && options.agentPubkey) {
      return {
        pubkey: options.agentPubkey,
        isAdmin: false,
        displayName: options.displayName || "",
        avatar: options.avatar || "",
        isAgent: true,
      };
    }
    if (!options.authEvent) throw new Error("authEvent required");
    const auth = verifyNostrAuth(options.authEvent);
    if (!auth) throw new Error("invalid signature");
    return {
      pubkey: auth.pubkey,
      isAdmin: false,
      displayName: options.displayName || "",
      avatar: options.avatar || "",
      isAgent: options.isAgent || false,
    };
  }

  onJoin(client, options, auth) {
    const player = new PlayerState();
    player.pubkey = auth.pubkey;
    player.displayName = auth.displayName;
    player.avatar = auth.avatar;
    player.isAgent = auth.isAgent;
    player.x = Math.floor(this.state.width / 2) + Math.floor(Math.random() * 3) - 1;
    player.y = Math.floor(this.state.height / 2) + Math.floor(Math.random() * 3) - 1;
    player.animation = "idle";
    this.state.players.set(client.sessionId, player);

    this._participants.set(auth.pubkey, { name: auth.displayName, isAgent: auth.isAgent, avatar: auth.avatar });
    this._record("join", auth.pubkey, auth.displayName, { x: player.x, y: player.y, isAgent: auth.isAgent });

    console.log(`[jam] ${auth.displayName || auth.pubkey.slice(0, 12)} joined ${this.state.ownerName}'s studio`);
  }

  onLeave(client, consented) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      // Clear any instrument this player was playing
      this.state.instruments.forEach((inst) => {
        if (inst.playerSessionId === client.sessionId) {
          this._record("stop_instrument", player.pubkey, player.displayName, { instrumentId: inst.id });
          inst.playerSessionId = "";
          inst.playerName = "";
          inst.pattern = "";
        }
      });
      this._record("leave", player.pubkey, player.displayName, {});
      console.log(`[jam] ${player.displayName || player.pubkey.slice(0, 12)} left ${this.state.ownerName}'s studio`);
    }
    this.state.players.delete(client.sessionId);
  }

  onDispose() {
    const duration = Date.now() - this._startedAt;
    if (this._participants.size >= 1 && this._recordedEvents.length >= 2 && duration > 5000) {
      const instruments = [];
      this.state.instruments.forEach((inst) => {
        instruments.push({
          id: inst.id, type: inst.type, name: inst.name,
          description: inst.description, x: inst.x, y: inst.y,
        });
      });

      const recording = {
        sessionId: this.roomId,
        roomType: "jam_studio",
        roomOwnerPubkey: this.state.ownerPubkey,
        roomOwnerName: this.state.ownerName,
        scene: this.state.scene,
        width: this.state.width,
        height: this.state.height,
        bpm: this.state.bpm,
        startedAt: this._startedAt,
        endedAt: Date.now(),
        duration,
        participants: Array.from(this._participants.entries()).map(([pk, info]) => ({
          pubkey: pk, name: info.name, isAgent: info.isAgent, avatar: info.avatar,
        })),
        instruments,
        events: this._recordedEvents,
      };

      saveRecording(recording);
    }
    console.log(`[jam] ${this.state.ownerName}'s studio disposed (${this._recordedEvents.length} events, ${this._participants.size} participants)`);
  }
}

module.exports = { JamStudioRoom };
