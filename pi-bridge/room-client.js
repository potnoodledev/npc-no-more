/**
 * Headless Colyseus room client for pi-bridge agents.
 * Agents join rooms via /internal/room/* endpoints.
 */

const ROOMS_URL = process.env.ROOMS_URL || "ws://localhost:2567";

// Active room connections: pubkey -> { room, client }
const connections = new Map();

async function getColyseusClient() {
  // Dynamic import since colyseus.js is ESM-only in newer versions
  const { Client } = await import("colyseus.js");
  return new Client(ROOMS_URL);
}

async function joinRoom(agentPubkey, targetRoomPubkey, displayName, avatar) {
  // Leave existing room if any
  await leaveRoom(agentPubkey);

  const client = await getColyseusClient();
  const room = await client.joinOrCreate("character_room", {
    characterPubkey: targetRoomPubkey,
    characterName: displayName,
    displayName: displayName,
    avatar: avatar || "",
    isAgent: true,
    agentPubkey: agentPubkey,
  });

  // Store connection
  connections.set(agentPubkey, { room, client, targetRoomPubkey });

  // Collect messages for the agent
  const messageQueue = [];
  room.onMessage("look_result", (data) => {
    messageQueue.push({ type: "look", text: data.text });
  });
  room.onMessage("interact_result", (data) => {
    if (data.error) messageQueue.push({ type: "interact_error", text: data.error });
    else messageQueue.push({ type: "interact", text: `${data.name}: "${data.description}"` });
  });
  room.onMessage("place_result", (data) => {
    if (data.error) messageQueue.push({ type: "place_error", text: data.error });
    else messageQueue.push({ type: "place", text: `Placed object ${data.objectId}` });
  });

  connections.get(agentPubkey).messageQueue = messageQueue;

  console.log(`[room-client] ${displayName} joined room ${targetRoomPubkey.slice(0, 12)}...`);
  return { ok: true, roomId: room.id };
}

async function leaveRoom(agentPubkey) {
  const conn = connections.get(agentPubkey);
  if (conn) {
    try { conn.room.leave(); } catch {}
    connections.delete(agentPubkey);
    console.log(`[room-client] ${agentPubkey.slice(0, 12)}... left room`);
  }
  return { ok: true };
}

function sendMove(agentPubkey, x, y) {
  const conn = connections.get(agentPubkey);
  if (!conn) return { error: "Not in a room. Use 'room.sh join <pubkey>' first." };
  conn.room.send("move", { x: Number(x), y: Number(y) });
  return { ok: true };
}

function sendChat(agentPubkey, content) {
  const conn = connections.get(agentPubkey);
  if (!conn) return { error: "Not in a room." };
  conn.room.send("chat", { content });
  return { ok: true };
}

function sendEmote(agentPubkey, animation) {
  const conn = connections.get(agentPubkey);
  if (!conn) return { error: "Not in a room." };
  conn.room.send("emote", { animation });
  return { ok: true };
}

function sendInteract(agentPubkey, objectId) {
  const conn = connections.get(agentPubkey);
  if (!conn) return { error: "Not in a room." };
  conn.room.send("interact", { objectId });
  return { ok: true };
}

function sendLook(agentPubkey) {
  const conn = connections.get(agentPubkey);
  if (!conn) return { error: "Not in a room." };
  conn.room.send("look");
  return { ok: true };
}

function drainMessages(agentPubkey) {
  const conn = connections.get(agentPubkey);
  if (!conn) return [];
  const msgs = conn.messageQueue.splice(0);
  return msgs;
}

function getConnectionStatus(agentPubkey) {
  const conn = connections.get(agentPubkey);
  if (!conn) return { connected: false };
  return { connected: true, roomId: conn.room.id, targetRoomPubkey: conn.targetRoomPubkey };
}

export {
  joinRoom, leaveRoom,
  sendMove, sendChat, sendEmote, sendInteract, sendLook,
  drainMessages, getConnectionStatus,
};
