const { Schema, defineTypes, MapSchema, ArraySchema } = require("@colyseus/schema");
const { PlayerState, ChatMessage } = require("./RoomState");

class InstrumentState extends Schema {
  constructor() {
    super();
    this.id = "";
    this.type = "";         // "drums" | "bass" | "keys" | "sampler"
    this.name = "";
    this.description = "";
    this.x = 0;
    this.y = 0;
    this.pattern = "";      // strudel mini-notation (empty = idle)
    this.playerSessionId = ""; // who's playing (empty = vacant)
    this.playerName = "";
    this.muted = false;
  }
}
defineTypes(InstrumentState, {
  id: "string",
  type: "string",
  name: "string",
  description: "string",
  x: "number",
  y: "number",
  pattern: "string",
  playerSessionId: "string",
  playerName: "string",
  muted: "boolean",
});

class JamStudioState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.instruments = new MapSchema();
    this.chat = new ArraySchema();
    this.ownerPubkey = "";
    this.ownerName = "";
    this.scene = "jam_studio";
    this.width = 16;
    this.height = 16;
    this.bpm = 120;
    this.createdAt = 0;
  }
}
defineTypes(JamStudioState, {
  players: { map: PlayerState },
  instruments: { map: InstrumentState },
  chat: [ChatMessage],
  ownerPubkey: "string",
  ownerName: "string",
  scene: "string",
  width: "uint8",
  height: "uint8",
  bpm: "number",
  createdAt: "number",
});

module.exports = { InstrumentState, JamStudioState };
