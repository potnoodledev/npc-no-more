const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || "/data/recordings";
const MAX_RECORDINGS = 100;

// Ensure directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

function saveRecording(recording) {
  try {
    const filename = `${recording.sessionId}.json`;
    const filepath = path.join(DATA_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(recording));
    console.log(`[rec] Saved recording ${recording.sessionId} (${recording.events.length} events, ${(recording.duration / 1000).toFixed(0)}s)`);

    // Prune old recordings if too many
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => ({ name: f, time: fs.statSync(path.join(DATA_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    if (files.length > MAX_RECORDINGS) {
      for (const f of files.slice(MAX_RECORDINGS)) {
        fs.unlinkSync(path.join(DATA_DIR, f.name));
      }
      console.log(`[rec] Pruned ${files.length - MAX_RECORDINGS} old recordings`);
    }
  } catch (e) {
    console.error(`[rec] Failed to save recording:`, e.message);
  }
}

function listRecordings() {
  try {
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf-8"));
          return {
            sessionId: data.sessionId,
            roomOwnerPubkey: data.roomOwnerPubkey,
            roomOwnerName: data.roomOwnerName,
            scene: data.scene,
            startedAt: data.startedAt,
            endedAt: data.endedAt,
            duration: data.duration,
            participantCount: data.participants?.length || 0,
            eventCount: data.events?.length || 0,
            participants: (data.participants || []).map(p => ({ name: p.name, isAgent: p.isAgent })),
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.startedAt - a.startedAt);
    return files;
  } catch {
    return [];
  }
}

function getRecording(sessionId) {
  try {
    const filepath = path.join(DATA_DIR, `${sessionId}.json`);
    if (!fs.existsSync(filepath)) return null;
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch {
    return null;
  }
}

module.exports = { saveRecording, listRecordings, getRecording };
