import { useState, useEffect, useCallback, useRef } from "react";
import { generateRandomPersona, isNimAvailable, getRandomErrorMessage } from "./nim";
import {
  createAccount,
  accountFromNsec,
  loginWithExtension,
  publishNote,
  publishEvent,
  publishProfile,
  subscribeFeed,
  subscribeUserFeed,
  subscribeDMs,
  sendDM,
  decryptDM,
  fetchProfile,
  fetchProfiles,
  relayGetConfig,
  relaySaveConfig,
  relayAddPubkey,
  relayGetSetupStatus,
  relayGetPublicCharacter,
  shortPubkey,
  formatTime,
  saveLocal,
  loadLocal,
  clearLocal,
  DEFAULT_RELAYS,
  RELAY_HTTP_URL,
  getPool,
} from "./nostr";
import { npubEncode, decode as nip19decode } from "nostr-tools/nip19";
import "./App.css";

// ══════════════════════════════════════
//  HASH ROUTER
// ══════════════════════════════════════

function parseHash() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash) return { route: "home" };
  const parts = hash.split("/");
  if (parts[0] === "admin" && parts[1] === "setup") return { route: "setup" };
  if (parts[0] === "admin") return { route: "admin" };
  if (parts[0] === "profile" && parts[1]) return { route: "profile", key: parts[1] };
  if (parts[0] === "thread" && parts[1]) return { route: "thread", key: parts[1] };
  if (parts[0] === "messages" && parts[1]) return { route: "messages", key: parts[1] };
  if (parts[0] === "messages") return { route: "inbox" };
  if (parts[0] === "origin") return { route: "origin" };
  return { route: "home" };
}

function resolvePubkey(key) {
  if (!key) return null;
  if (key.startsWith("npub1")) {
    try { const { type, data } = nip19decode(key); if (type === "npub") return data; } catch {}
    return null;
  }
  if (/^[0-9a-f]{64}$/i.test(key)) return key;
  return null;
}

function setHash(path) {
  window.location.hash = "#/" + path;
}

// ══════════════════════════════════════
//  SETUP WIZARD
// ══════════════════════════════════════

function SetupWizard({ onComplete }) {
  const [step, setStep] = useState(1);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Step 1: Character
  const [charName, setCharName] = useState("");
  const [charPersonality, setCharPersonality] = useState("");
  const [charWorld, setCharWorld] = useState("");
  const [charVoice, setCharVoice] = useState("");
  const [rolling, setRolling] = useState(false);
  const [rolledModel, setRolledModel] = useState(null);

  async function handleRollDice() {
    setRolling(true);
    setError("");
    try {
      const persona = await generateRandomPersona((partial) => {
        if (partial.name) setCharName(partial.name);
        if (partial.personality) setCharPersonality(partial.personality);
        if (partial.world) setCharWorld(partial.world);
        if (partial.voice) setCharVoice(partial.voice);
        setRolledModel(partial.model);
      });
      setCharName(persona.name);
      setCharPersonality(persona.personality);
      setCharWorld(persona.world);
      setCharVoice(persona.voice);
      setRolledModel(persona.model);
    } catch (e) {
      setError(getRandomErrorMessage());
    }
    setRolling(false);
  }

  // Step 2: API Keys
  const [geminiKey, setGeminiKey] = useState("");

  // Step 3: Admin
  const [adminMethod, setAdminMethod] = useState("create");
  const [adminNsecInput, setAdminNsecInput] = useState("");
  const [adminSecret, setAdminSecret] = useState(import.meta.env.VITE_ADMIN_SECRET || "");

  // Generated accounts (created in step 4)
  const [characterAccount, setCharacterAccount] = useState(null);
  const [adminAccount, setAdminAccount] = useState(null);

  async function handleLaunch() {
    setError("");
    setSaving(true);
    try {
      // Create character keypair
      const charAcc = createAccount();
      setCharacterAccount(charAcc);

      // Create or import admin account
      let admAcc;
      if (adminMethod === "create") {
        admAcc = createAccount();
      } else if (adminMethod === "nsec") {
        admAcc = accountFromNsec(adminNsecInput.trim());
      } else {
        admAcc = await loginWithExtension();
      }
      setAdminAccount(admAcc);

      // The admin secret for relay API
      const secret = adminSecret.trim() || crypto.randomUUID().replace(/-/g, "");

      // Build character config
      const config = {
        character: {
          name: charName,
          personality: charPersonality,
          world: charWorld,
          voice: charVoice,
          pubkey: charAcc.pk,
          npub: charAcc.npub,
          origin_story: [], // will be filled by Gemini later
          profile_image: "",
          banner_image: "",
          video_url: "",
          posting_schedule: {
            frequency: "3x daily",
            topics: [],
            style: "in-character",
          },
        },
        admin: {
          pubkey: admAcc.pk,
          npub: admAcc.npub,
        },
        api_keys: {
          gemini: geminiKey,
        },
        setup_complete: true,
      };

      // Save to relay (best-effort — setup succeeds even if relay is unavailable)
      if (RELAY_HTTP_URL) {
        try {
          await relaySaveConfig(secret, config);
          await relayAddPubkey(secret, charAcc.pk, "character");
          if (admAcc.pk) {
            await relayAddPubkey(secret, admAcc.pk, "admin");
          }
        } catch (relayErr) {
          console.warn("Relay save failed (non-fatal):", relayErr.message);
        }
      }

      // Publish character's Nostr profile
      const profileMeta = {
        name: charName,
        display_name: charName,
        about: charPersonality,
        // picture, banner, nip05 will be set later
      };
      await publishProfile(profileMeta, charAcc);

      // Save locally
      saveLocal("npc_config", config);
      saveLocal("npc_character_account", {
        skHex: charAcc.skHex,
        nsec: charAcc.nsec,
        pk: charAcc.pk,
        npub: charAcc.npub,
      });
      if (admAcc.skHex) {
        saveLocal("npc_admin_account", {
          skHex: admAcc.skHex,
          nsec: admAcc.nsec,
          pk: admAcc.pk,
          npub: admAcc.npub,
        });
      }
      saveLocal("npc_admin_secret", secret);

      onComplete(config, charAcc, admAcc);
    } catch (e) {
      setError("Setup failed: " + e.message);
    }
    setSaving(false);
  }

  return (
    <div className="setup-wizard">
      <div className="setup-card">
        <h1>🟣 NPC No More</h1>
        <p className="setup-tagline">"Nobody cared who I was until I put on the mask"</p>

        <div className="setup-steps">
          <div className={`setup-step-dot ${step >= 1 ? "active" : ""}`}>1</div>
          <div className={`setup-step-line ${step >= 2 ? "active" : ""}`} />
          <div className={`setup-step-dot ${step >= 2 ? "active" : ""}`}>2</div>
          <div className={`setup-step-line ${step >= 3 ? "active" : ""}`} />
          <div className={`setup-step-dot ${step >= 3 ? "active" : ""}`}>3</div>
        </div>

        {/* Step 1: Character */}
        {step === 1 && (
          <div className="setup-section">
            <h2>Every character has an origin story</h2>
            <p className="setup-hint">Who is your character? Define their identity.</p>

            {isNimAvailable() && (
              <div className="dice-roll-section">
                <button
                  className="btn-dice"
                  onClick={handleRollDice}
                  disabled={rolling}
                >
                  {rolling ? "🎲 Rolling..." : "🎲 Not feeling creative? Roll the dice!"}
                </button>
                {rolling && rolledModel && (
                  <p className="dice-hint">
                    <span className="streaming-dot" />
                    Streaming from <strong>{rolledModel.name}</strong>
                    {rolledModel.params && ` (${rolledModel.params}B)`}...
                  </p>
                )}
                {rolling && !rolledModel && (
                  <p className="dice-hint">Picking a random model...</p>
                )}
                {rolledModel && !rolling && !error && (
                  <p className="dice-hint">
                    Generated by <strong>{rolledModel.name}</strong>
                    {rolledModel.params && ` (${rolledModel.params}B)`}
                    {" — "}edit below or roll again!
                  </p>
                )}
                {error && !rolling && (
                  <div className="dice-error">{error}</div>
                )}
              </div>
            )}

            <div className="edit-form">
              <label>
                <span>Character Name</span>
                <input type="text" placeholder="Zara, ARIA-7, The Chronicler…" value={charName} onChange={(e) => setCharName(e.target.value)} />
              </label>
              <label>
                <span>Personality & Backstory</span>
                <textarea placeholder="A rogue AI archaeologist from 2187 who discovered that ancient civilizations were seeded by earlier AIs…" value={charPersonality} onChange={(e) => setCharPersonality(e.target.value)} rows={4} />
              </label>
              <label>
                <span>World / Setting</span>
                <input type="text" placeholder="Post-singularity Earth, cyberpunk Tokyo, a living library…" value={charWorld} onChange={(e) => setCharWorld(e.target.value)} />
              </label>
              <label>
                <span>Voice & Style</span>
                <textarea placeholder="Sardonic, curious, drops historical references. Never breaks the fourth wall. Speaks in short punchy sentences." value={charVoice} onChange={(e) => setCharVoice(e.target.value)} rows={3} />
              </label>
            </div>

            <div className="setup-nav">
              <div />
              <button className="btn-primary" onClick={() => setStep(2)} disabled={rolling || !charName.trim() || !charPersonality.trim()}>
                {rolling ? "Generating..." : "Next →"}
              </button>
            </div>
          </div>
        )}

        {/* Step 2: API Keys */}
        {step === 2 && (
          <div className="setup-section">
            <h2>Power up your character</h2>
            <p className="setup-hint">API keys for AI generation. Optional — you can add them later.</p>

            <div className="edit-form">
              <label>
                <span>Gemini API Key</span>
                <input type="password" placeholder="AIza..." value={geminiKey} onChange={(e) => setGeminiKey(e.target.value)} />
                <span className="field-hint">Used for generating origin story, images, and video. <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Get one here</a></span>
              </label>
            </div>

            <div className="setup-nav">
              <button className="btn-back" onClick={() => setStep(1)}>← Back</button>
              <button className="btn-primary" onClick={() => setStep(3)}>Next →</button>
            </div>
          </div>
        )}

        {/* Step 3: Admin */}
        {step === 3 && (
          <div className="setup-section">
            <h2>The person behind the mask</h2>
            <p className="setup-hint">Create your admin identity. This is YOU — the puppeteer.</p>

            <div className="auth-tabs">
              <button className={adminMethod === "create" ? "active" : ""} onClick={() => setAdminMethod("create")}>
                Generate New
              </button>
              <button className={adminMethod === "nsec" ? "active" : ""} onClick={() => setAdminMethod("nsec")}>
                Import nsec
              </button>
              <button className={adminMethod === "extension" ? "active" : ""} onClick={() => setAdminMethod("extension")}>
                NIP-07
              </button>
            </div>

            {adminMethod === "create" && (
              <p className="setup-hint">A fresh keypair will be generated for your admin identity.</p>
            )}
            {adminMethod === "nsec" && (
              <div className="edit-form">
                <label>
                  <span>Your nsec or hex private key</span>
                  <input type="password" placeholder="nsec1… or hex" value={adminNsecInput} onChange={(e) => setAdminNsecInput(e.target.value)} />
                </label>
              </div>
            )}
            {adminMethod === "extension" && (
              <p className="setup-hint">Your NIP-07 browser extension will be used.</p>
            )}

            <div className="edit-form" style={{ marginTop: "16px" }}>
              <label>
                <span>Relay Admin Secret</span>
                <input type="text" placeholder="Leave blank to auto-generate" value={adminSecret} onChange={(e) => setAdminSecret(e.target.value)} />
                <span className="field-hint">Password for the relay's admin API. Save this somewhere safe.</span>
              </label>
            </div>

            {error && <p className="error">{error}</p>}

            <div className="setup-nav">
              <button className="btn-back" onClick={() => setStep(2)}>← Back</button>
              <button className="btn-primary" onClick={handleLaunch} disabled={saving || (adminMethod === "nsec" && !adminNsecInput.trim())}>
                {saving ? "Launching…" : "🚀 Launch Character"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════
//  CHARACTER PUBLIC PAGE
// ══════════════════════════════════════

function CharacterPage({ config, characterAccount, onMessage }) {
  const char = config.character;
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState({});
  const [postContent, setPostContent] = useState("");
  const [posting, setPosting] = useState(false);
  const [feedMode, setFeedMode] = useState("global"); // "mine" or "global"
  const subRef = useRef(null);
  const profileCache = useRef({});

  const addNote = useCallback((event) => {
    setNotes((prev) => {
      if (prev.find((n) => n.id === event.id)) return prev;
      return [event, ...prev].sort((a, b) => b.created_at - a.created_at);
    });
  }, []);

  // Fetch profiles for authors we haven't seen
  useEffect(() => {
    const unknownPubkeys = notes
      .map((n) => n.pubkey)
      .filter((pk) => pk !== char.pubkey && !profileCache.current[pk]);

    if (unknownPubkeys.length === 0) return;

    const unique = [...new Set(unknownPubkeys)];
    unique.forEach((pk) => { profileCache.current[pk] = true; }); // mark as fetching

    fetchProfiles(DEFAULT_RELAYS, unique).then((fetched) => {
      const newProfiles = {};
      for (const [pk, profile] of Object.entries(fetched)) {
        newProfiles[pk] = profile;
        profileCache.current[pk] = profile;
      }
      if (Object.keys(newProfiles).length > 0) {
        setProfiles((prev) => ({ ...prev, ...newProfiles }));
      }
    });
  }, [notes, char.pubkey]);

  useEffect(() => {
    setLoading(true);
    setNotes([]);
    if (subRef.current) subRef.current.close();
    if (feedMode === "global") {
      subRef.current = subscribeFeed(
        DEFAULT_RELAYS,
        (event) => addNote(event),
        () => setLoading(false),
        50
      );
    } else {
      subRef.current = subscribeUserFeed(
        DEFAULT_RELAYS, char.pubkey,
        (event) => addNote(event),
        () => setLoading(false),
        50
      );
    }
    return () => { if (subRef.current) subRef.current.close(); };
  }, [char.pubkey, addNote, feedMode]);

  function getAuthorName(ev) {
    if (ev.pubkey === char.pubkey) return char.name;
    const profile = profiles[ev.pubkey];
    return profile?.display_name || profile?.name || shortPubkey(ev.pubkey);
  }

  function getAuthorInitial(ev) {
    const name = getAuthorName(ev);
    return name.charAt(0).toUpperCase();
  }

  function isReply(ev) {
    return ev.tags?.some((t) => t[0] === "e");
  }

  function getRootId(ev) {
    const rootTag = ev.tags?.find((t) => t[0] === "e" && t[3] === "root");
    return rootTag?.[1] || null;
  }

  async function handlePost() {
    if (!postContent.trim() || !characterAccount) return;
    setPosting(true);
    try {
      await publishNote(postContent, characterAccount);
      setPostContent("");
    } catch (e) {
      alert("Failed to post: " + e.message);
    }
    setPosting(false);
  }

  // Group notes into threads: root posts with their replies
  const rootNotes = notes.filter((n) => !isReply(n));
  const replyNotes = notes.filter((n) => isReply(n));
  const replyMap = {};
  for (const reply of replyNotes) {
    const rootId = getRootId(reply);
    if (rootId) {
      if (!replyMap[rootId]) replyMap[rootId] = [];
      replyMap[rootId].push(reply);
    }
  }
  // Sort replies within each thread chronologically
  for (const replies of Object.values(replyMap)) {
    replies.sort((a, b) => a.created_at - b.created_at);
  }

  // Standalone replies (root not in our feed)
  const orphanReplies = replyNotes.filter((r) => {
    const rootId = getRootId(r);
    return rootId && !notes.find((n) => n.id === rootId);
  });

  return (
    <div className="character-page">
      {/* Hero Section */}
      <div className="char-hero">
        {char.banner_image && (
          <div className="char-hero-banner">
            <img src={char.banner_image} alt="" />
          </div>
        )}
        <div className="char-hero-content">
          <div className="char-hero-avatar">
            {char.profile_image ? (
              <img src={char.profile_image} alt="" />
            ) : (
              <div className="avatar-placeholder large">
                {char.name.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <h1 className="char-hero-name">{char.name}</h1>
          <p className="char-hero-personality">{char.personality}</p>
          {char.world && <p className="char-hero-world">🌍 {char.world}</p>}
          <div className="char-hero-actions">
            <button className="btn-primary" onClick={() => onMessage(char.pubkey)}>
              ✉️ Message {char.name}
            </button>
            <code className="char-npub" onClick={() => {
              navigator.clipboard.writeText(char.npub);
              const el = document.querySelector('.char-npub-copied');
              if (el) { el.style.opacity = 1; setTimeout(() => { el.style.opacity = 0; }, 1500); }
            }}>
              {char.npub} <span className="copy-icon">📋</span>
            </code>
            <span className="char-npub-copied">Copied!</span>
          </div>
        </div>
      </div>

      {/* Origin Story */}
      {char.origin_story && char.origin_story.length > 0 && (
        <div className="char-origin">
          <h2>📖 Origin Story</h2>
          <p className="setup-hint">Coming soon — generated with Gemini</p>
        </div>
      )}

      {/* Compose */}
      {characterAccount && (
        <div className="feed-compose">
          <div className="compose-box">
            <textarea
              placeholder={`What's on ${char.name}'s mind?`}
              value={postContent}
              onChange={(e) => setPostContent(e.target.value)}
              rows={3}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handlePost();
                }
              }}
            />
            <div className="compose-footer">
              <span className="hint">Ctrl+Enter to post</span>
              <button
                className="btn-primary"
                disabled={posting || !postContent.trim()}
                onClick={handlePost}
              >
                {posting ? "Posting…" : `Post as ${char.name}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Feed */}
      <div className="char-feed">
        <div className="feed-header">
          <h2>Latest Posts</h2>
          <div className="feed-toggle">
            <button
              className={`feed-toggle-btn ${feedMode === "global" ? "active" : ""}`}
              onClick={() => setFeedMode("global")}
            >🌐 All</button>
            <button
              className={`feed-toggle-btn ${feedMode === "mine" ? "active" : ""}`}
              onClick={() => setFeedMode("mine")}
            >👤 Mine</button>
          </div>
        </div>
        {loading && notes.length === 0 && <div className="loading">Loading…</div>}
        {!loading && notes.length === 0 && (
          <div className="loading">{char.name} hasn't posted yet. Check back soon!</div>
        )}
        <div className="notes-list">
          {rootNotes.map((ev) => (
            <div key={ev.id} className="note-thread">
              {/* Root post */}
              <div className="note-card">
                <div className="note-header">
                  <div className="note-avatar clickable" onClick={() => setHash("profile/" + npubEncode(ev.pubkey))}>
                    <div className="avatar-placeholder">{getAuthorInitial(ev)}</div>
                  </div>
                  <div className="note-meta">
                    <span className="note-author clickable" onClick={() => setHash("profile/" + npubEncode(ev.pubkey))}>{getAuthorName(ev)}</span>
                    <span className="note-time">{formatTime(ev.created_at)}</span>
                  </div>
                </div>
                <div className="note-content clickable" onClick={() => setHash("thread/" + ev.id)}>{ev.content}</div>
                {replyMap[ev.id] && (
                  <div className="note-thread-link clickable" onClick={() => setHash("thread/" + ev.id)}>
                    💬 {replyMap[ev.id].length} {replyMap[ev.id].length === 1 ? "reply" : "replies"}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Orphan replies */}
          {orphanReplies.map((ev) => (
            <div key={ev.id} className="note-card note-reply">
              <div className="note-header">
                <div className="note-avatar clickable" onClick={() => setHash("profile/" + npubEncode(ev.pubkey))}>
                  <div className="avatar-placeholder small">{getAuthorInitial(ev)}</div>
                </div>
                <div className="note-meta">
                  <span className="note-author clickable" onClick={() => setHash("profile/" + npubEncode(ev.pubkey))}>{getAuthorName(ev)}</span>
                  <span className="note-reply-tag">↩ reply</span>
                  <span className="note-time">{formatTime(ev.created_at)}</span>
                </div>
              </div>
              <div className="note-content">{ev.content}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════
//  PROFILE VIEW
// ══════════════════════════════════════

function ProfileView({ pubkey }) {
  const [profile, setProfile] = useState(null);
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const subRef = useRef(null);

  useEffect(() => {
    fetchProfile(DEFAULT_RELAYS, pubkey).then((p) => {
      setProfile(p || {});
    });
  }, [pubkey]);

  useEffect(() => {
    setLoading(true);
    setNotes([]);
    if (subRef.current) subRef.current.close();
    subRef.current = getPool().subscribeMany(
      DEFAULT_RELAYS,
      { kinds: [1], authors: [pubkey], "#client": ["npc-no-more"], limit: 20 },
      {
        onevent: (ev) => {
          setNotes((prev) => {
            if (prev.find((n) => n.id === ev.id)) return prev;
            return [ev, ...prev].sort((a, b) => b.created_at - a.created_at);
          });
        },
        oneose: () => setLoading(false),
      }
    );
    return () => { if (subRef.current) subRef.current.close(); };
  }, [pubkey]);

  const name = profile?.display_name || profile?.name || shortPubkey(pubkey);
  const about = profile?.about || "";
  const npub = npubEncode(pubkey);

  return (
    <div className="profile-view">
      <button className="btn-back" onClick={() => setHash("")}>← Back</button>

      <div className="profile-card">
        <div className="profile-avatar">
          {profile?.picture ? (
            <img src={profile.picture} alt="" />
          ) : (
            <div className="avatar-placeholder large">{name.charAt(0).toUpperCase()}</div>
          )}
        </div>
        <h2 className="profile-name">{name}</h2>
        {about && <p className="profile-about">{about}</p>}
        <code className="profile-npub">{npub}</code>
        <div className="profile-actions">
          <button className="btn-primary" onClick={() => setHash("messages/" + npub)}>
            ✉️ Message {name}
          </button>
        </div>
      </div>

      <div className="profile-feed">
        <h3>Posts</h3>
        {loading && notes.length === 0 && <div className="loading">Loading…</div>}
        {!loading && notes.length === 0 && <div className="loading">No posts yet.</div>}
        {notes.map((ev) => (
          <div key={ev.id} className="note-card clickable" onClick={() => setHash("thread/" + ev.id)}>
            <div className="note-content">{ev.content}</div>
            <div className="note-time" style={{ padding: "4px 12px" }}>{formatTime(ev.created_at)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════
//  THREAD VIEW
// ══════════════════════════════════════

function ThreadView({ eventId, characterAccount, config }) {
  const [rootEvent, setRootEvent] = useState(null);
  const [replies, setReplies] = useState([]);
  const [profiles, setProfiles] = useState({});
  const [loading, setLoading] = useState(true);
  const [replyContent, setReplyContent] = useState("");
  const [posting, setPosting] = useState(false);
  const subRef = useRef(null);
  const profileCache = useRef({});

  // Fetch root event and replies
  useEffect(() => {
    setLoading(true);
    setRootEvent(null);
    setReplies([]);
    if (subRef.current) subRef.current.close();

    let eoseCount = 0;
    const checkEose = () => { eoseCount++; if (eoseCount >= 2) setLoading(false); };

    // Get the root event
    const sub1 = getPool().subscribeMany(DEFAULT_RELAYS, { ids: [eventId] }, {
      onevent: (ev) => setRootEvent(ev),
      oneose: checkEose,
    });

    // Get replies to this event
    const sub2 = getPool().subscribeMany(DEFAULT_RELAYS, { kinds: [1], "#e": [eventId] }, {
      onevent: (ev) => {
        setReplies((prev) => {
          if (prev.find((r) => r.id === ev.id)) return prev;
          return [...prev, ev].sort((a, b) => a.created_at - b.created_at);
        });
      },
      oneose: checkEose,
    });

    subRef.current = { close() { sub1.close(); sub2.close(); } };
    return () => { if (subRef.current) subRef.current.close(); };
  }, [eventId]);

  // Fetch profiles
  useEffect(() => {
    const allEvents = rootEvent ? [rootEvent, ...replies] : replies;
    const unknownPks = allEvents
      .map((e) => e.pubkey)
      .filter((pk) => !profileCache.current[pk]);
    const unique = [...new Set(unknownPks)];
    if (unique.length === 0) return;
    unique.forEach((pk) => { profileCache.current[pk] = true; });
    fetchProfiles(DEFAULT_RELAYS, unique).then((fetched) => {
      setProfiles((prev) => ({ ...prev, ...fetched }));
      Object.assign(profileCache.current, fetched);
    });
  }, [rootEvent, replies]);

  function getName(ev) {
    const p = profiles[ev.pubkey];
    return p?.display_name || p?.name || shortPubkey(ev.pubkey);
  }

  function getInitial(ev) {
    return getName(ev).charAt(0).toUpperCase();
  }

  async function handleReply() {
    if (!replyContent.trim() || !characterAccount || !rootEvent) return;
    setPosting(true);
    try {
      const lastReply = replies.length > 0 ? replies[replies.length - 1] : rootEvent;
      const tags = [
        ["e", rootEvent.id, DEFAULT_RELAYS[0] || "", "root"],
        ["p", rootEvent.pubkey],
      ];
      if (lastReply.id !== rootEvent.id) {
        tags.push(["e", lastReply.id, DEFAULT_RELAYS[0] || "", "reply"]);
        if (lastReply.pubkey !== rootEvent.pubkey) tags.push(["p", lastReply.pubkey]);
      }
      await publishEvent({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: replyContent,
      }, characterAccount);
      setReplyContent("");
    } catch (e) {
      alert("Failed to reply: " + e.message);
    }
    setPosting(false);
  }

  return (
    <div className="thread-view">
      <button className="btn-back" onClick={() => setHash("")}>← Back to feed</button>

      {loading && !rootEvent && <div className="loading">Loading thread…</div>}

      {rootEvent && (
        <div className="note-card thread-root">
          <div className="note-header">
            <div className="note-avatar clickable" onClick={() => setHash("profile/" + npubEncode(rootEvent.pubkey))}>
              <div className="avatar-placeholder">{getInitial(rootEvent)}</div>
            </div>
            <div className="note-meta">
              <span className="note-author clickable" onClick={() => setHash("profile/" + npubEncode(rootEvent.pubkey))}>{getName(rootEvent)}</span>
              <span className="note-time">{formatTime(rootEvent.created_at)}</span>
            </div>
          </div>
          <div className="note-content thread-root-content">{rootEvent.content}</div>
        </div>
      )}

      {replies.length > 0 && (
        <div className="thread-replies">
          {replies.map((reply) => (
            <div key={reply.id} className="note-card note-reply">
              <div className="note-header">
                <div className="note-avatar clickable" onClick={() => setHash("profile/" + npubEncode(reply.pubkey))}>
                  <div className="avatar-placeholder small">{getInitial(reply)}</div>
                </div>
                <div className="note-meta">
                  <span className="note-author clickable" onClick={() => setHash("profile/" + npubEncode(reply.pubkey))}>{getName(reply)}</span>
                  <span className="note-reply-tag">↩ reply</span>
                  <span className="note-time">{formatTime(reply.created_at)}</span>
                </div>
              </div>
              <div className="note-content">{reply.content}</div>
            </div>
          ))}
        </div>
      )}

      {!loading && replies.length === 0 && rootEvent && (
        <p className="thread-no-replies">No replies yet. Be the first!</p>
      )}

      {characterAccount && rootEvent && (
        <div className="thread-reply-compose">
          <textarea
            placeholder="Write a reply…"
            value={replyContent}
            onChange={(e) => setReplyContent(e.target.value)}
            rows={3}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleReply();
              }
            }}
          />
          <div className="compose-footer">
            <span className="hint">Ctrl+Enter to reply</span>
            <button
              className="btn-primary"
              disabled={posting || !replyContent.trim()}
              onClick={handleReply}
            >
              {posting ? "Replying…" : "↩ Reply"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════
//  ADMIN PANEL
// ══════════════════════════════════════

function AdminPanel({ config, characterAccount, adminAccount, adminSecret, onConfigUpdate }) {
  const [tab, setTab] = useState("character"); // character | chat | post | messages
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Character settings
  const char = config.character || {};
  const [charName, setCharName] = useState(char.name || "");
  const [charPersonality, setCharPersonality] = useState(char.personality || "");
  const [charWorld, setCharWorld] = useState(char.world || "");
  const [charVoice, setCharVoice] = useState(char.voice || "");
  const [profileImage, setProfileImage] = useState(char.profile_image || "");
  const [bannerImage, setBannerImage] = useState(char.banner_image || "");

  // Post as character
  const [postContent, setPostContent] = useState("");
  const [posting, setPosting] = useState(false);

  // Pi chat (stubbed)
  const [chatMessages, setChatMessages] = useState([
    { role: "system", content: `You are ${char.name}. ${char.personality}. Voice: ${char.voice}` },
  ]);
  const [chatInput, setChatInput] = useState("");

  async function handleSaveCharacter() {
    setSaving(true);
    setSaved(false);
    try {
      const updatedConfig = {
        ...config,
        character: {
          ...config.character,
          name: charName,
          personality: charPersonality,
          world: charWorld,
          voice: charVoice,
          profile_image: profileImage,
          banner_image: bannerImage,
        },
      };

      if (RELAY_HTTP_URL && adminSecret) {
        await relaySaveConfig(adminSecret, updatedConfig);
      }
      saveLocal("npc_config", updatedConfig);

      // Update Nostr profile
      if (characterAccount) {
        await publishProfile({
          name: charName,
          display_name: charName,
          about: charPersonality,
          picture: profileImage || undefined,
          banner: bannerImage || undefined,
        }, characterAccount);
      }

      onConfigUpdate(updatedConfig);
      setSaved(true);
    } catch (e) {
      alert("Failed to save: " + e.message);
    }
    setSaving(false);
  }

  async function handlePostAsCharacter() {
    if (!postContent.trim() || !characterAccount) return;
    setPosting(true);
    try {
      await publishNote(postContent, characterAccount);
      setPostContent("");
    } catch (e) {
      alert("Failed to post: " + e.message);
    }
    setPosting(false);
  }

  function handleChatSend() {
    if (!chatInput.trim()) return;
    setChatMessages((prev) => [...prev, { role: "user", content: chatInput }]);
    // Stub: AI response
    const stub = `[Pi integration coming soon — this is where ${char.name} would respond in-character]`;
    setTimeout(() => {
      setChatMessages((prev) => [...prev, { role: "assistant", content: stub }]);
    }, 500);
    setChatInput("");
  }

  return (
    <div className="admin-panel">
      <h2>🎭 Admin Panel</h2>

      <div className="feed-tabs">
        <button className={tab === "character" ? "active" : ""} onClick={() => setTab("character")}>
          ⚙️ Character
        </button>
        <button className={tab === "post" ? "active" : ""} onClick={() => setTab("post")}>
          📝 Post
        </button>
        <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
          🤖 Pi Chat
        </button>
      </div>

      {/* Character Settings */}
      {tab === "character" && (
        <div className="admin-section">
          <h3>Character Settings</h3>
          <p className="setup-hint">These define who your character is — their personality becomes the pi config.</p>
          <div className="edit-form">
            <label><span>Name</span>
              <input type="text" value={charName} onChange={(e) => setCharName(e.target.value)} /></label>
            <label><span>Personality & Backstory</span>
              <textarea value={charPersonality} onChange={(e) => setCharPersonality(e.target.value)} rows={4} /></label>
            <label><span>World / Setting</span>
              <input type="text" value={charWorld} onChange={(e) => setCharWorld(e.target.value)} /></label>
            <label><span>Voice & Style</span>
              <textarea value={charVoice} onChange={(e) => setCharVoice(e.target.value)} rows={3} /></label>
            <label><span>Profile Image URL</span>
              <input type="url" value={profileImage} onChange={(e) => setProfileImage(e.target.value)} placeholder="https://..." /></label>
            <label><span>Banner Image URL</span>
              <input type="url" value={bannerImage} onChange={(e) => setBannerImage(e.target.value)} placeholder="https://..." /></label>
          </div>
          {saved && <p className="success">✅ Character updated!</p>}
          <button className="btn-primary" onClick={handleSaveCharacter} disabled={saving} style={{ marginTop: "16px" }}>
            {saving ? "Saving…" : "💾 Save Character"}
          </button>

          <div className="admin-keys-section">
            <h3>Keys & Config</h3>
            <div className="admin-key-row">
              <span>Character npub</span>
              <code>{config.character?.npub || "—"}</code>
            </div>
            <div className="admin-key-row">
              <span>Admin npub</span>
              <code>{config.admin?.npub || "—"}</code>
            </div>
            <div className="admin-key-row">
              <span>Character pubkey (hex)</span>
              <code>{config.character?.pubkey || "—"}</code>
            </div>
            {characterAccount?.nsec && (
              <div className="admin-key-row">
                <span>Character nsec</span>
                <code className="nsec-display">{characterAccount.nsec}</code>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Post as Character */}
      {tab === "post" && (
        <div className="admin-section">
          <h3>Post as {charName || "Character"}</h3>
          <p className="setup-hint">Write a post that will be published from your character's identity.</p>
          <div className="compose-box">
            <textarea
              placeholder={`What's on ${charName || "your character"}'s mind?`}
              value={postContent}
              onChange={(e) => setPostContent(e.target.value)}
              rows={4}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handlePostAsCharacter();
              }}
            />
            <div className="compose-footer">
              <span className="hint">Ctrl+Enter to post</span>
              <button className="btn-primary" onClick={handlePostAsCharacter} disabled={posting || !postContent.trim()}>
                {posting ? "Posting…" : `Post as ${charName || "Character"}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pi Chat (stubbed) */}
      {tab === "chat" && (
        <div className="admin-section">
          <h3>🤖 Chat with {charName || "Character"}</h3>
          <p className="setup-hint">
            Talk to your character via pi. Control their behavior, test their personality, or have them draft posts.
          </p>

          <div className="pi-chat">
            <div className="pi-chat-messages">
              {chatMessages.filter((m) => m.role !== "system").map((msg, i) => (
                <div key={i} className={`chat-bubble ${msg.role === "user" ? "sent" : "received"}`}>
                  <div className="chat-text">{msg.content}</div>
                </div>
              ))}
            </div>
            <div className="conversation-compose">
              <input
                type="text"
                placeholder={`Talk to ${charName || "your character"}…`}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleChatSend();
                  }
                }}
              />
              <button className="btn-send" onClick={handleChatSend} disabled={!chatInput.trim()}>➤</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════
//  ADMIN LOGIN
// ══════════════════════════════════════

function AdminLogin({ onLogin }) {
  const [method, setMethod] = useState("nsec");
  const [nsecInput, setNsecInput] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [error, setError] = useState("");

  function handleLogin() {
    setError("");
    try {
      let acc;
      if (method === "nsec") {
        acc = accountFromNsec(nsecInput.trim());
      }
      onLogin(acc, secretInput.trim());
    } catch (e) {
      setError("Invalid: " + e.message);
    }
  }

  async function handleExtensionLogin() {
    setError("");
    try {
      const acc = await loginWithExtension();
      onLogin(acc, secretInput.trim());
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>🎭 Admin Login</h1>
        <p className="subtitle">Sign in with your admin identity</p>

        <div className="auth-tabs">
          <button className={method === "nsec" ? "active" : ""} onClick={() => setMethod("nsec")}>nsec</button>
          <button className={method === "extension" ? "active" : ""} onClick={() => setMethod("extension")}>NIP-07</button>
        </div>

        <div className="edit-form">
          {method === "nsec" && (
            <label><span>Admin nsec or hex key</span>
              <input type="password" placeholder="nsec1… or hex" value={nsecInput} onChange={(e) => setNsecInput(e.target.value)} /></label>
          )}
          <label><span>Relay Admin Secret</span>
            <input type="password" placeholder="The secret from setup" value={secretInput} onChange={(e) => setSecretInput(e.target.value)} /></label>
        </div>

        {error && <p className="error">{error}</p>}

        <button
          className="btn-primary"
          style={{ marginTop: "16px", width: "100%" }}
          onClick={method === "extension" ? handleExtensionLogin : handleLogin}
          disabled={method === "nsec" && !nsecInput.trim()}
        >
          🔑 Sign In
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════
//  MESSAGES (for visitors messaging character)
// ══════════════════════════════════════

function VisitorMessageView({ characterPubkey, characterName: initialName, senderAccount }) {
  const [account, setAccount] = useState(null);
  const [recipientName, setRecipientName] = useState(initialName || "");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const subRef = useRef(null);
  const messagesEndRef = useRef(null);

  // Fetch recipient profile if name not provided
  useEffect(() => {
    if (initialName || !characterPubkey) return;
    fetchProfile(DEFAULT_RELAYS, characterPubkey).then((profile) => {
      if (profile) {
        setRecipientName(profile.display_name || profile.name || shortPubkey(characterPubkey));
      } else {
        setRecipientName(shortPubkey(characterPubkey));
      }
    });
  }, [characterPubkey, initialName]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Use sender account (logged-in character) if provided, otherwise create visitor account
  useEffect(() => {
    async function initAccount() {
      if (senderAccount) {
        setAccount(senderAccount);
        return;
      }
      let acc = loadLocal("npc_visitor_account");
      if (acc && acc.skHex) {
        const { hexToBytes } = await import("@noble/hashes/utils.js");
        acc = { ...acc, sk: hexToBytes(acc.skHex) };
      } else {
        acc = createAccount();
        saveLocal("npc_visitor_account", { skHex: acc.skHex, nsec: acc.nsec, pk: acc.pk, npub: acc.npub });
      }
      setAccount(acc);
    }
    initAccount();
  }, [senderAccount]);

  // Subscribe to DMs between visitor and character
  useEffect(() => {
    if (!account) return;
    setLoading(true);

    const processEvent = async (event) => {
      const { plaintext } = await decryptDM(event, account);
      setMessages((prev) => {
        if (prev.find((m) => m.id === event.id)) return prev;
        return [...prev, { ...event, _decrypted: plaintext }].sort((a, b) => a.created_at - b.created_at);
      });
    };

    subRef.current = subscribeDMs(DEFAULT_RELAYS, account.pk, processEvent, () => setLoading(false));
    return () => { if (subRef.current) subRef.current.close(); };
  }, [account]);

  async function handleSend() {
    if (!input.trim() || !account) return;
    setSending(true);
    try {
      await sendDM(input, characterPubkey, account);
      setInput("");
    } catch (e) {
      alert("Failed to send: " + e.message);
    }
    setSending(false);
  }

  // Filter to only show messages with the character
  const filtered = messages.filter((m) => {
    const otherPk = m.pubkey === account?.pk
      ? m.tags.find((t) => t[0] === "p")?.[1]
      : m.pubkey;
    return otherPk === characterPubkey;
  });

  return (
    <div className="conversation-view">
      <div className="conversation-header">
        <button className="btn-back" onClick={() => { setHash(""); }}>←</button>
        <div className="conversation-contact">
          <div className="avatar-placeholder" style={{ width: 32, height: 32, fontSize: "0.8rem" }}>
            {(recipientName || "?").charAt(0).toUpperCase()}
          </div>
          <span className="conversation-name">{recipientName}</span>
        </div>
      </div>

      <div className="conversation-messages">
        {loading && filtered.length === 0 && <div className="loading">Connecting…</div>}
        {!loading && filtered.length === 0 && <div className="loading">Say hello to {recipientName}!</div>}
        {filtered.map((msg) => (
          <div key={msg.id} className={`chat-bubble ${msg.pubkey === account?.pk ? "sent" : "received"}`}>
            <div className="chat-text">{msg._decrypted}</div>
            <div className="chat-time">{formatTime(msg.created_at)}</div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="conversation-compose">
        <input
          type="text"
          placeholder={`Message ${recipientName}…`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleSend(); } }}
        />
        <button className="btn-send" onClick={handleSend} disabled={sending || !input.trim()}>
          {sending ? "…" : "➤"}
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════
//  ORIGIN GENERATOR (NVIDIA NIM)
// ══════════════════════════════════════

function OriginGenerator({ onApply }) {
  const [persona, setPersona] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState([]);

  async function handleGenerate() {
    setError("");
    setGenerating(true);
    setPersona(null);
    try {
      const result = await generateRandomPersona((partial) => {
        setPersona({ ...partial, streaming: true });
      });
      setPersona(result);
      setHistory((prev) => [result, ...prev]);
    } catch (e) {
      setError(getRandomErrorMessage());
    }
    setGenerating(false);
  }

  if (!isNimAvailable()) {
    return (
      <div className="origin-page">
        <div className="origin-header">
          <h2>🎲 Random Origin Generator</h2>
          <p className="setup-hint">
            NVIDIA NIM API key not configured. Add <code>VITE_NVIDIA_NIM_API_KEY</code> to your <code>.env</code> file.
            Get one free at <a href="https://build.nvidia.com/" target="_blank" rel="noopener">build.nvidia.com</a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="origin-page">
      <div className="origin-header">
        <h2>🎲 Random Origin Generator</h2>
        <p className="setup-hint">
          Powered by NVIDIA NIM — each persona is generated by a randomly selected AI model.
          Roll the dice and discover who your character was meant to be.
        </p>
      </div>

      <button
        className="btn-primary"
        onClick={handleGenerate}
        disabled={generating}
        style={{ marginBottom: 24 }}
      >
        {generating ? "🎲 Generating..." : "🎲 Generate Random Persona"}
      </button>

      {error && <div className="dice-error" style={{ marginBottom: 16 }}>{error}</div>}

      {persona && (
        <div className="origin-result">
          <div className="origin-model-tag">
            {persona.streaming && <span className="streaming-dot" />}
            {persona.streaming ? "Streaming from" : "Generated by"}{" "}
            <strong>{persona.model.name}</strong>
            {persona.model.params && <span> ({persona.model.params}B params)</span>}
            <br />
            <code style={{ fontSize: "0.7rem", color: "#888" }}>{persona.model.id}</code>
            {persona.streaming && persona.phase && (
              <span className="origin-phase">
                {persona.phase === "connecting" && " — Connecting..."}
                {persona.phase === "thinking" && " — Model is thinking..."}
                {persona.phase === "generating" && " — Writing character..."}
              </span>
            )}
          </div>

          <div className={`origin-card ${persona.streaming ? "streaming" : ""}`}>
            <h3 className="origin-name">
              {persona.name || (
                <span className="origin-placeholder">
                  {persona.phase === "connecting" ? "Connecting to model..." :
                   persona.phase === "thinking" ? "Model is thinking..." :
                   "Dreaming up a name..."}
                </span>
              )}
              {persona.streaming && <span className="streaming-cursor" />}
            </h3>

            {(persona.personality || persona.streaming) && (
              <div className="origin-field">
                <span className="origin-label">🧠 Personality</span>
                <p>{persona.personality || <span className="origin-placeholder">...</span>}</p>
              </div>
            )}

            {(persona.world || persona.streaming) && (
              <div className="origin-field">
                <span className="origin-label">🌍 World</span>
                <p>{persona.world || <span className="origin-placeholder">...</span>}</p>
              </div>
            )}

            {(persona.voice || persona.streaming) && (
              <div className="origin-field">
                <span className="origin-label">🗣️ Voice</span>
                <p>{persona.voice || <span className="origin-placeholder">...</span>}</p>
              </div>
            )}

            {(persona.originStory || persona.streaming) && (
              <div className="origin-field">
                <span className="origin-label">📖 Origin Story</span>
                <p>{persona.originStory || <span className="origin-placeholder">...</span>}</p>
              </div>
            )}

            {!persona.streaming && (
              <div className="origin-actions">
                <button className="btn-primary" onClick={handleGenerate} disabled={generating}>
                  🎲 Reroll
                </button>
                {onApply && (
                  <button
                    className="btn-primary"
                    style={{ background: "#BAFF00", color: "#000", border: "none" }}
                    onClick={() => onApply(persona)}
                  >
                    ✅ Use This Character
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {history.length > 1 && (
        <div className="origin-history">
          <h3>Previous Rolls</h3>
          {history.slice(1).map((p, i) => (
            <div key={i} className="origin-history-item" onClick={() => setPersona(p)}>
              <strong>{p.name}</strong>
              <span className="origin-history-model">{p.model.name}</span>
              <p className="origin-history-preview">{p.personality.slice(0, 100)}...</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════
//  APP
// ══════════════════════════════════════

export default function App() {
  const [config, setConfig] = useState(null);
  const [characterAccount, setCharacterAccount] = useState(null);
  const [adminAccount, setAdminAccount] = useState(null);
  const [adminSecret, setAdminSecret] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [route, setRoute] = useState("home");
  const [routeKey, setRouteKey] = useState(null);

  // Load config on mount
  useEffect(() => {
    async function init() {
      // Try loading from localStorage first (admin mode)
      let cfg = loadLocal("npc_config");
      const secret = loadLocal("npc_admin_secret");
      let admin = false;

      if (cfg && cfg.setup_complete) {
        // We have local config — this is the admin
        admin = true;

        // Load character account
        const charData = loadLocal("npc_character_account");
        if (charData && charData.skHex) {
          try {
            const { hexToBytes } = await import("@noble/hashes/utils.js");
            setCharacterAccount({ ...charData, sk: hexToBytes(charData.skHex) });
          } catch {}
        }

        // Load admin account
        const admData = loadLocal("npc_admin_account");
        if (admData && admData.skHex) {
          try {
            const { hexToBytes } = await import("@noble/hashes/utils.js");
            setAdminAccount({ ...admData, sk: hexToBytes(admData.skHex) });
          } catch {}
        }

        if (secret) setAdminSecret(secret);
      } else if (RELAY_HTTP_URL) {
        // No local config — check if character exists on relay (visitor mode)
        const character = await relayGetPublicCharacter();
        if (character) {
          cfg = { character, setup_complete: true };
          admin = false;
        }
      }

      setIsAdmin(admin);
      if (cfg && cfg.setup_complete) setConfig(cfg);
      setLoading(false);
    }
    init();
  }, []);

  // Hash routing
  useEffect(() => {
    function applyHash() {
      const { route: r, key } = parseHash();
      setRoute(r);
      setRouteKey(key ? resolvePubkey(key) || key : null);
    }
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  function handleSetupComplete(cfg, charAcc, admAcc) {
    setConfig(cfg);
    setCharacterAccount(charAcc);
    setAdminAccount(admAcc);
    setAdminSecret(loadLocal("npc_admin_secret"));
    setIsAdmin(true);
    setHash("");
  }

  function handleReset() {
    if (!window.confirm("Reset everything? This will clear your character and admin keys.")) return;
    clearLocal("npc_config");
    clearLocal("npc_character_account");
    clearLocal("npc_admin_account");
    clearLocal("npc_admin_secret");
    clearLocal("npc_visitor_account");
    setConfig(null);
    setCharacterAccount(null);
    setAdminAccount(null);
    setAdminSecret(null);
    setIsAdmin(false);
    setHash("");
  }

  function handleAdminLogin(acc, secret) {
    setAdminAccount(acc);
    setAdminSecret(secret);
    if (acc.skHex) {
      saveLocal("npc_admin_account", { skHex: acc.skHex, nsec: acc.nsec, pk: acc.pk, npub: acc.npub });
    }
    saveLocal("npc_admin_secret", secret);

    // Try loading config from relay
    if (RELAY_HTTP_URL && secret) {
      relayGetConfig(secret).then((cfg) => {
        if (cfg && cfg.setup_complete) {
          setConfig(cfg);
          saveLocal("npc_config", cfg);
        }
      }).catch(() => {});
    }
  }

  if (loading) return null;

  // No config → setup wizard
  if (!config) {
    return <SetupWizard onComplete={handleSetupComplete} />;
  }

  const charName = config.character?.name || "Character";

  // Admin route (admin only)
  if (route === "admin") {
    if (!isAdmin) {
      setHash("");
      return null;
    }
    if (!adminAccount || !adminSecret) {
      return <AdminLogin onLogin={handleAdminLogin} />;
    }
    return (
      <div className="app">
        <header className="app-header">
          <h1 className="clickable" onClick={() => setHash("")}>🟣 {charName}</h1>
          <button className="btn-small" onClick={() => setHash("")}>← Public Page</button>
          <button className="btn-small btn-reset" onClick={handleReset}>↺ Reset</button>
        </header>
        <main>
          <AdminPanel
            config={config}
            characterAccount={characterAccount}
            adminAccount={adminAccount}
            adminSecret={adminSecret}
            onConfigUpdate={(cfg) => { setConfig(cfg); }}
          />
        </main>
      </div>
    );
  }

  // Profile route
  if (route === "profile" && routeKey) {
    return (
      <div className="app">
        <header className="app-header">
          <h1 className="clickable" onClick={() => setHash("")}>🟣 {charName}</h1>
        </header>
        <main>
          <ProfileView pubkey={routeKey} />
        </main>
      </div>
    );
  }

  // Thread view route
  if (route === "thread" && routeKey) {
    return (
      <div className="app">
        <header className="app-header">
          <h1 className="clickable" onClick={() => setHash("")}>🟣 {charName}</h1>
        </header>
        <main>
          <ThreadView
            eventId={routeKey}
            characterAccount={characterAccount}
            config={config}
          />
        </main>
      </div>
    );
  }

  // Origin generator route (admin only)
  if (route === "origin") {
    if (!isAdmin) { setHash(""); return null; }
    function handleApplyPersona(persona) {
      if (!config) {
        // Pre-setup: just navigate to home with persona data in localStorage
        saveLocal("npc_pending_persona", persona);
        setHash("");
        return;
      }
      const updatedConfig = {
        ...config,
        character: {
          ...config.character,
          name: persona.name,
          personality: persona.personality,
          world: persona.world,
          voice: persona.voice,
          origin_story: [persona.originStory],
        },
      };
      setConfig(updatedConfig);
      saveLocal("npc_config", updatedConfig);
      setHash("");
    }

    return (
      <div className="app">
        <header className="app-header">
          <h1 className="clickable" onClick={() => setHash("")}>🟣 {charName}</h1>
          <button className="btn-small" onClick={() => setHash("")}>← Back</button>
        </header>
        <main>
          <OriginGenerator onApply={handleApplyPersona} />
        </main>
      </div>
    );
  }

  // Messages route
  if (route === "messages") {
    const dmPubkey = routeKey && routeKey !== config.character?.pubkey
      ? routeKey
      : config.character?.pubkey;

    return (
      <div className="app">
        <header className="app-header">
          <h1 className="clickable" onClick={() => setHash("")}>🟣 {charName}</h1>
        </header>
        <main>
          <VisitorMessageView
            characterPubkey={dmPubkey}
            characterName={null}
            senderAccount={characterAccount}
          />
        </main>
      </div>
    );
  }

  // Default: Character public page
  return (
    <div className="app">
      <header className="app-header">
        <h1 className="clickable" onClick={() => setHash("")}>🟣 {charName}</h1>
        <div className="header-actions">
          {isAdmin && (
            <>
              <button className="btn-small" onClick={() => setHash("origin")}>🎲 Origin</button>
              <button className="btn-small" onClick={() => setHash("admin")}>🎭 Admin</button>
              <div className="header-user-info">
                <span className="header-user-badge">👤 {charName}</span>
                <button className="btn-small btn-copy" onClick={() => {
                  navigator.clipboard.writeText(config.character?.npub || "");
                  const el = document.querySelector('.btn-copy');
                  el.textContent = "✅ Copied!";
                  setTimeout(() => { el.textContent = "📋 Copy npub"; }, 1500);
                }}>📋 Copy npub</button>
                <button className="btn-small btn-reset" onClick={handleReset}>↺ Reset</button>
              </div>
            </>
          )}
        </div>
      </header>
      <main>
        <CharacterPage
          config={config}
          characterAccount={isAdmin ? characterAccount : null}
          onMessage={(pk) => setHash("messages/" + npubEncode(pk))}
        />
      </main>
    </div>
  );
}
