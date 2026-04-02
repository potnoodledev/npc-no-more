const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server, LobbyRoom } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const { CharacterRoom } = require("./rooms/CharacterRoom.js");
const { JamStudioRoom } = require("./rooms/JamStudioRoom.js");
const { listRecordings, getRecording } = require("./recordings.js");

const PORT = parseInt(process.env.PORT || "2567");

const app = express();
// CORS must be before everything — including Colyseus matchmaking routes
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ── Recording endpoints ──

app.get("/recordings", (req, res) => {
  res.json({ recordings: listRecordings() });
});

app.get("/recordings/:sessionId", (req, res) => {
  const recording = getRecording(req.params.sessionId);
  if (!recording) return res.status(404).json({ error: "Recording not found" });
  res.json(recording);
});

const httpServer = http.createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// Lobby for room discovery
gameServer.define("lobby", LobbyRoom);

// Character rooms — one per character, created on demand
gameServer.define("character_room", CharacterRoom)
  .filterBy(["characterPubkey"])
  .enableRealtimeListing();

// Jam studios — collaborative music rooms
gameServer.define("jam_studio", JamStudioRoom)
  .filterBy(["characterPubkey"])
  .enableRealtimeListing();

gameServer.listen(PORT).then(() => {
  console.log(`Room Server running on port ${PORT}`);
  console.log(`  Auth: delegated to ${process.env.API_URL || "http://localhost:3456"}`);
  console.log(`  Rooms: character_room, jam_studio (filtered by characterPubkey)`);
  console.log(`  Lobby: enabled for room discovery`);
  console.log(`  Recordings: /recordings, /recordings/:id`);
});
