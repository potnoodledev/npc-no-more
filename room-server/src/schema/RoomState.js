const { Schema, defineTypes, MapSchema, ArraySchema } = require("@colyseus/schema");

class PlayerState extends Schema {
  constructor() {
    super();
    this.pubkey = "";
    this.displayName = "";
    this.avatar = "";
    this.x = 0;
    this.y = 0;
    this.targetX = -1;
    this.targetY = -1;
    this.animation = "idle";
    this.activity = "";
    this.isAgent = false;
  }
}
defineTypes(PlayerState, {
  pubkey: "string",
  displayName: "string",
  avatar: "string",
  x: "number",
  y: "number",
  targetX: "number",
  targetY: "number",
  animation: "string",
  activity: "string",
  isAgent: "boolean",
});

class ChatMessage extends Schema {
  constructor() {
    super();
    this.sender = "";
    this.senderName = "";
    this.content = "";
    this.timestamp = 0;
  }
}
defineTypes(ChatMessage, {
  sender: "string",
  senderName: "string",
  content: "string",
  timestamp: "number",
});

class ObjectState extends Schema {
  constructor() {
    super();
    this.id = "";
    this.type = "";
    this.name = "";
    this.description = "";
    this.x = 0;
    this.y = 0;
    this.interactable = true;
  }
}
defineTypes(ObjectState, {
  id: "string",
  type: "string",
  name: "string",
  description: "string",
  x: "number",
  y: "number",
  interactable: "boolean",
});

class RoomState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.objects = new MapSchema();
    this.chat = new ArraySchema();
    this.ownerPubkey = "";
    this.ownerName = "";
    this.scene = "default_studio";
    this.width = 12;
    this.height = 12;
    this.createdAt = 0;
  }
}
defineTypes(RoomState, {
  players: { map: PlayerState },
  objects: { map: ObjectState },
  chat: [ChatMessage],
  ownerPubkey: "string",
  ownerName: "string",
  scene: "string",
  width: "uint8",
  height: "uint8",
  createdAt: "number",
});

module.exports = { PlayerState, ChatMessage, ObjectState, RoomState };
