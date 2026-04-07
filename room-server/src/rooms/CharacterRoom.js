const { Room } = require("colyseus");
const { RoomState, PlayerState, ChatMessage, ObjectState } = require("../schema/RoomState.js");
const { saveRecording } = require("../recordings.js");
const { verifyNostrAuth } = require("../nostr-auth.js");

const { existsSync, readFileSync } = require("fs");
const path = require("path");

const MAX_CHAT = 50;
const INTERACT_DISTANCE = 2;

// Load room objects from branding config, fall back to defaults
function loadDefaultObjects() {
  const brandingPath = path.resolve(__dirname, "../../../branding.json");
  try {
    if (existsSync(brandingPath)) {
      const branding = JSON.parse(readFileSync(brandingPath, "utf-8"));
      if (branding.roomObjects?.length) return branding.roomObjects;
    }
  } catch (e) {
    console.warn("[room] Failed to load branding.json, using defaults:", e.message);
  }
  return [
    { type: "couch", name: "Cozy Couch", description: "A worn-out couch. Perfect for napping.", x: 2, y: 2 },
    { type: "bookshelf", name: "Bookshelf", description: "Stacked with old zines and printed forum threads.", x: 8, y: 1 },
    { type: "computer", name: "CRT Monitor", description: "A chunky CRT running a BBS client. The cursor blinks patiently.", x: 10, y: 3 },
    { type: "plant", name: "Plant", description: "A thriving plant in a cracked pot.", x: 1, y: 8 },
    { type: "record_player", name: "Record Player", description: "A dusty turntable with a stack of lo-fi vinyl. Currently playing static.", x: 6, y: 10 },
    { type: "window", name: "Window", description: "Overlooking the old internet. You can see GeoCities pages drifting by like clouds.", x: 0, y: 5 },
    { type: "decoration", name: "Decoration", description: "Something distinctive. Tells a story.", x: 5, y: 5 },
    { type: "food_bowl", name: "Food Bowl", description: "Half-full. Label says 'Vintage 2003 Blend'.", x: 9, y: 8 },
  ];
}

const DEFAULT_OBJECTS = loadDefaultObjects();

function distance(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

class CharacterRoom extends Room {
  onCreate(options) {
    this.setState(new RoomState());
    this.maxClients = 20;
    this.autoDispose = true;

    this.state.ownerPubkey = options.characterPubkey || "";
    this.state.ownerName = options.characterName || "";
    this.state.scene = options.scene || "default_studio";
    this.state.createdAt = Date.now();

    // ── Recording ──
    this._startedAt = Date.now();
    this._participants = new Map(); // pubkey -> { name, isAgent, avatar }
    this._recordedEvents = [];

    // Place default objects
    for (const obj of DEFAULT_OBJECTS) {
      const o = new ObjectState();
      o.id = `${obj.type}_${obj.x}_${obj.y}`;
      o.type = obj.type;
      o.name = obj.name;
      o.description = obj.description;
      o.x = obj.x;
      o.y = obj.y;
      o.interactable = true;
      this.state.objects.set(o.id, o);
    }

    this.setMetadata({
      ownerPubkey: options.characterPubkey,
      ownerName: options.characterName,
      scene: this.state.scene,
    });

    // ── Message handlers ──

    this.onMessage("move", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const tx = Math.max(0, Math.min(this.state.width - 1, Math.round(data.x)));
      const ty = Math.max(0, Math.min(this.state.height - 1, Math.round(data.y)));
      const fromX = player.x, fromY = player.y;
      player.x = tx;
      player.y = ty;
      player.animation = "idle";
      player.targetX = -1;
      player.targetY = -1;
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
      while (this.state.chat.length > MAX_CHAT) {
        this.state.chat.shift();
      }
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

    this.onMessage("interact", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || !data.objectId) return;
      const obj = this.state.objects.get(data.objectId);
      if (!obj || !obj.interactable) {
        client.send("interact_result", { error: "Object not found or not interactable" });
        return;
      }
      const dist = distance(player.x, player.y, obj.x, obj.y);
      if (dist > INTERACT_DISTANCE) {
        client.send("interact_result", { error: `Too far away (${dist.toFixed(1)} tiles). Move closer.` });
        return;
      }
      client.send("interact_result", {
        objectId: obj.id,
        name: obj.name,
        type: obj.type,
        description: obj.description,
      });
      this._record("interact", player.pubkey, player.displayName, { objectId: obj.id, objectName: obj.name });
    });

    this.onMessage("place", (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      if (player.pubkey !== this.state.ownerPubkey) {
        client.send("place_result", { error: "Only the room owner can place objects" });
        return;
      }
      const { type, name, description, x, y } = data;
      if (!type || !name || x == null || y == null) {
        client.send("place_result", { error: "Missing type, name, x, or y" });
        return;
      }
      const px = Math.max(0, Math.min(this.state.width - 1, Math.round(x)));
      const py = Math.max(0, Math.min(this.state.height - 1, Math.round(y)));
      const id = `${type}_${px}_${py}_${Date.now()}`;
      const obj = new ObjectState();
      obj.id = id;
      obj.type = type;
      obj.name = name;
      obj.description = (description || "").slice(0, 200);
      obj.x = px;
      obj.y = py;
      obj.interactable = true;
      this.state.objects.set(id, obj);
      client.send("place_result", { ok: true, objectId: id });
      this._record("place", player.pubkey, player.displayName, { objectId: id, objectName: name, x: px, y: py });
    });

    // ── Look ──

    this.onMessage("look", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const lines = [];
      lines.push(`Room: ${this.state.ownerName || "Unknown"}'s room (${this.state.scene})`);
      lines.push(`Your position: (${player.x}, ${player.y})`);
      lines.push(`Size: ${this.state.width}x${this.state.height}`);

      const nearbyPlayers = [];
      this.state.players.forEach((p, sid) => {
        if (sid === client.sessionId) return;
        const dist = distance(player.x, player.y, p.x, p.y);
        const status = p.activity ? `${p.animation}, ${p.activity}` : p.animation;
        nearbyPlayers.push({ name: p.displayName || p.pubkey.slice(0, 12), dist, status });
      });
      nearbyPlayers.sort((a, b) => a.dist - b.dist);

      if (nearbyPlayers.length > 0) {
        lines.push("\nNearby:");
        for (const p of nearbyPlayers) {
          lines.push(`  - ${p.name} (${p.dist.toFixed(1)} tiles away, ${p.status})`);
        }
      } else {
        lines.push("\nNo one else here.");
      }

      const nearbyObjects = [];
      this.state.objects.forEach((obj) => {
        const dist = distance(player.x, player.y, obj.x, obj.y);
        nearbyObjects.push({ name: obj.name, id: obj.id, dist, description: obj.description, type: obj.type });
      });
      nearbyObjects.sort((a, b) => a.dist - b.dist);

      if (nearbyObjects.length > 0) {
        lines.push("\nObjects:");
        for (const o of nearbyObjects) {
          const reachable = o.dist <= INTERACT_DISTANCE ? "[within reach]" : `(${o.dist.toFixed(1)} tiles away)`;
          lines.push(`  - ${o.name} ${reachable} — "${o.description}"`);
        }
      }

      const recentChat = this.state.chat.slice(-5);
      if (recentChat.length > 0) {
        lines.push("\nRecent chat:");
        for (const msg of recentChat) {
          lines.push(`  ${msg.senderName}: ${msg.content}`);
        }
      }

      client.send("look_result", { text: lines.join("\n") });
    });

    console.log(`[room] Created ${this.state.ownerName}'s room (${this.roomId})`);
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
    // Internal agent bypass — pi-bridge agents connect with isAgent + pubkey directly
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

    console.log(`[room] ${auth.displayName || auth.pubkey.slice(0, 12)} joined ${this.state.ownerName}'s room`);
  }

  onLeave(client, consented) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      this._record("leave", player.pubkey, player.displayName, {});
      console.log(`[room] ${player.displayName || player.pubkey.slice(0, 12)} left ${this.state.ownerName}'s room`);
    }
    this.state.players.delete(client.sessionId);
  }

  onDispose() {
    const duration = Date.now() - this._startedAt;
    // Only save recordings with at least 2 participants and some activity
    if (this._participants.size >= 1 && this._recordedEvents.length >= 2 && duration > 5000) {
      const objects = [];
      this.state.objects.forEach((o) => {
        objects.push({ id: o.id, type: o.type, name: o.name, description: o.description, x: o.x, y: o.y });
      });

      const recording = {
        sessionId: this.roomId,
        roomOwnerPubkey: this.state.ownerPubkey,
        roomOwnerName: this.state.ownerName,
        scene: this.state.scene,
        width: this.state.width,
        height: this.state.height,
        startedAt: this._startedAt,
        endedAt: Date.now(),
        duration,
        participants: Array.from(this._participants.entries()).map(([pk, info]) => ({
          pubkey: pk, name: info.name, isAgent: info.isAgent, avatar: info.avatar,
        })),
        objects,
        events: this._recordedEvents,
      };

      saveRecording(recording);
    }
    console.log(`[room] ${this.state.ownerName}'s room disposed (${this._recordedEvents.length} events, ${this._participants.size} participants)`);
  }
}

module.exports = { CharacterRoom };
