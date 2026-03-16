import { useState, useEffect, useCallback, useRef } from "react";
import { isNimAvailable, generateRandomPersona, generateAvatar, getRandomErrorMessage } from "./nim";
import {
  createAccount,
  accountFromNsec,
  accountFromSkHex,
  publishNote,
  publishEvent,
  publishProfile,
  subscribeFeed,
  subscribeGlobalFeed,
  subscribeDMs,
  sendDM,
  decryptDM,
  fetchProfile,
  fetchProfiles,
  shortPubkey,
  formatTime,
  loadCharacters,
  saveCharacters,
  loadActiveCharId,
  saveActiveCharId,
  migrateOldData,
  DEFAULT_RELAYS,
  ALL_RELAYS,
  PUBLIC_RELAYS,
  OWN_RELAY,
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
  if (parts[0] === "characters" && parts[1] === "new") return { route: "new-character" };
  if (parts[0] === "settings") return { route: "settings" };
  if (parts[0] === "profile" && parts[1]) return { route: "profile", key: parts[1] };
  if (parts[0] === "thread" && parts[1]) return { route: "thread", key: parts[1] };
  if (parts[0] === "messages" && parts[1]) return { route: "messages", key: parts[1] };
  return { route: "home" };
}

function resolvePubkey(key) {
  if (!key) return null;
  if (key.startsWith("npub1")) {
    try {
      const { type, data } = nip19decode(key);
      if (type === "npub") return data;
    } catch { return null; }
  }
  if (/^[0-9a-f]{64}$/i.test(key)) return key;
  return null;
}

function setHash(path) {
  window.location.hash = "#/" + path;
}

// ══════════════════════════════════════
//  SIDEBAR (character management only)
// ══════════════════════════════════════

function Sidebar({ characters, activeCharId, onSwitch, currentPubkey }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1 className="sidebar-title clickable" onClick={() => setHash("")}>NPC No More</h1>
      </div>

      <div className="sidebar-section-label">Your Characters</div>
      <div className="sidebar-characters">
        {characters.map((c) => (
          <button
            key={c.id}
            className={`sidebar-char ${c.pk === currentPubkey ? "active-char" : ""}`}
            onClick={() => {
              onSwitch(c.id);
              setHash("profile/" + c.npub);
            }}
          >
            <span className="sidebar-char-avatar">
              {c.profile_image ? (
                <img src={c.profile_image} alt="" />
              ) : (
                c.name.charAt(0).toUpperCase()
              )}
            </span>
            <span className="sidebar-char-name">{c.name}</span>
          </button>
        ))}
        <button className="sidebar-item sidebar-add" onClick={() => setHash("characters/new")}>
          <span className="sidebar-icon">+</span>
          <span>New Character</span>
        </button>
      </div>

      <div className="sidebar-footer">
        <button className="sidebar-item" onClick={() => setHash("settings")}>
          <span className="sidebar-icon">&#9881;</span>
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
}

// ══════════════════════════════════════
//  MOBILE HEADER
// ══════════════════════════════════════

function MobileHeader({ activeChar, sidebarOpen, setSidebarOpen }) {
  return (
    <header className="mobile-header">
      <button className="mobile-menu-btn" onClick={() => setSidebarOpen(!sidebarOpen)}>
        &#9776;
      </button>
      <h1 className="clickable" onClick={() => setHash("")}>NPC No More</h1>
      {activeChar && (
        <span className="mobile-active-char" onClick={() => setHash("profile/" + activeChar.npub)}>
          {activeChar.profile_image ? (
            <img src={activeChar.profile_image} alt="" />
          ) : (
            activeChar.name.charAt(0).toUpperCase()
          )}
        </span>
      )}
    </header>
  );
}

// ══════════════════════════════════════
//  CREATE CHARACTER
// ══════════════════════════════════════

function CreateCharacter({ onComplete }) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [charName, setCharName] = useState("");
  const [charPersonality, setCharPersonality] = useState("");
  const [charWorld, setCharWorld] = useState("");
  const [charVoice, setCharVoice] = useState("");
  const [rolling, setRolling] = useState(false);
  const [rolledModel, setRolledModel] = useState(null);
  const [mode, setMode] = useState("create");
  const [nsecInput, setNsecInput] = useState("");
  const [generatingAvatar, setGeneratingAvatar] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState("");
  const [avatarModal, setAvatarModal] = useState(null);

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
    } catch {
      setError(getRandomErrorMessage());
    }
    setRolling(false);
  }

  async function handleGenerateAvatar() {
    if (!charName.trim()) return;
    setGeneratingAvatar(true);
    setError("");
    try {
      const result = await generateAvatar({ name: charName, personality: charPersonality, world: charWorld });
      setAvatarUrl(result.url);
    } catch (e) {
      setError("Avatar generation failed: " + e.message);
    }
    setGeneratingAvatar(false);
  }

  async function handleCreate() {
    setError("");
    setSaving(true);
    try {
      let acc;
      if (mode === "import") {
        acc = accountFromNsec(nsecInput.trim());
      } else {
        acc = createAccount();
      }
      const char = {
        id: crypto.randomUUID(),
        name: charName,
        personality: charPersonality,
        world: charWorld,
        voice: charVoice,
        profile_image: avatarUrl || "",
        banner_image: "",
        origin_story: [],
        skHex: acc.skHex,
        nsec: acc.nsec,
        pk: acc.pk,
        npub: acc.npub,
        createdAt: Math.floor(Date.now() / 1000),
      };
      await publishProfile({
        name: charName,
        display_name: charName,
        about: charPersonality,
        ...(avatarUrl ? { picture: avatarUrl } : {}),
      }, acc);
      onComplete(char);
    } catch (e) {
      setError("Failed: " + e.message);
    }
    setSaving(false);
  }

  return (
    <div className="setup-wizard">
      <div className="setup-card">
        <h1>NPC No More</h1>
        <p className="setup-tagline">Create a new character</p>

        <div className="auth-tabs">
          <button className={mode === "create" ? "active" : ""} onClick={() => setMode("create")}>New Identity</button>
          <button className={mode === "import" ? "active" : ""} onClick={() => setMode("import")}>Import nsec</button>
        </div>

        {mode === "import" && (
          <div className="edit-form" style={{ marginBottom: 16 }}>
            <label>
              <span>nsec or hex private key</span>
              <input type="password" placeholder="nsec1... or hex" value={nsecInput} onChange={(e) => setNsecInput(e.target.value)} />
            </label>
          </div>
        )}

        {isNimAvailable() && (
          <div className="dice-roll-section">
            <button className="btn-dice" onClick={handleRollDice} disabled={rolling}>
              {rolling ? "Rolling..." : "Roll the dice!"}
            </button>
            {rolling && rolledModel && (
              <p className="dice-hint">
                <span className="streaming-dot" />
                Streaming from <strong>{rolledModel.name}</strong>
                {rolledModel.params && ` (${rolledModel.params}B)`}...
              </p>
            )}
            {rolling && !rolledModel && <p className="dice-hint">Picking a random model...</p>}
            {rolledModel && !rolling && !error && (
              <p className="dice-hint">
                Generated by <strong>{rolledModel.name}</strong>
                {rolledModel.params && ` (${rolledModel.params}B)`} — edit below or roll again!
              </p>
            )}
            {error && !rolling && <div className="dice-error">{error}</div>}
          </div>
        )}

        <div className="edit-form">
          <label><span>Character Name</span>
            <input type="text" placeholder="Zara, ARIA-7, The Chronicler..." value={charName} onChange={(e) => setCharName(e.target.value)} /></label>
          <label><span>Personality & Backstory</span>
            <textarea placeholder="A rogue AI archaeologist from 2187..." value={charPersonality} onChange={(e) => setCharPersonality(e.target.value)} rows={4} /></label>
          <label><span>World / Setting</span>
            <input type="text" placeholder="Post-singularity Earth, cyberpunk Tokyo..." value={charWorld} onChange={(e) => setCharWorld(e.target.value)} /></label>
          <label><span>Voice & Style</span>
            <textarea placeholder="Sardonic, curious, drops historical references..." value={charVoice} onChange={(e) => setCharVoice(e.target.value)} rows={3} /></label>
        </div>

        {/* Avatar generation */}
        {isNimAvailable() && (
          <div className="avatar-gen-section">
            <div className="avatar-gen-header">
              <span className="avatar-gen-label">Profile Picture</span>
              <button
                className="btn-small"
                onClick={handleGenerateAvatar}
                disabled={generatingAvatar || !charName.trim()}
              >
                {generatingAvatar ? "Generating..." : "Generate Avatar"}
              </button>
            </div>
            {generatingAvatar && (
              <div className="avatar-gen-loading">
                <span className="streaming-dot" />
                <span>Generating via <strong>NVIDIA NIM</strong> — Stable Diffusion 3 Medium</span>
              </div>
            )}
            {avatarUrl && !generatingAvatar && (
              <div className="avatar-gen-preview">
                <img src={avatarUrl} alt="Generated avatar" />
                <div>
                  <span className="avatar-gen-model">Generated via NVIDIA NIM / Stable Diffusion 3</span>
                  <br />
                  <button type="button" className="btn-link" onClick={() => setAvatarModal(avatarUrl)}>View full size</button>
                </div>
              </div>
            )}
          </div>
        )}

        {error && <p className="error">{error}</p>}

        <div className="setup-nav">
          <button className="btn-back" onClick={() => setHash("")}>Cancel</button>
          <button
            className="btn-primary"
            onClick={handleCreate}
            disabled={saving || rolling || !charName.trim() || (mode === "import" && !nsecInput.trim())}
          >
            {saving ? "Creating..." : "Create Character"}
          </button>
        </div>
      </div>
      <ImageModal src={avatarModal} onClose={() => setAvatarModal(null)} />
    </div>
  );
}

// ══════════════════════════════════════
//  IMAGE MODAL
// ══════════════════════════════════════

function ImageModal({ src, onClose }) {
  if (!src) return null;

  useEffect(() => {
    function handleKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="image-modal-overlay" onClick={onClose}>
      <div className="image-modal" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt="" />
        <button className="image-modal-close" onClick={onClose}>&times;</button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════
//  OWNED CHARACTER PAGE (tabs: Posts / Profile)
// ══════════════════════════════════════

function OwnedCharacterPage({ character, account, characters, onUpdateChar, onDeleteChar }) {
  const [tab, setTab] = useState("posts"); // "posts" | "profile"
  const [postContent, setPostContent] = useState("");
  const [posting, setPosting] = useState(false);

  // Character's own posts
  const [myNotes, setMyNotes] = useState([]);
  const [myLoading, setMyLoading] = useState(true);
  const mySubRef = useRef(null);

  // Feed section
  const [feedMode, setFeedMode] = useState("relay"); // "relay" | "global"
  const [feedNotes, setFeedNotes] = useState([]);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedProfiles, setFeedProfiles] = useState({});
  const feedSubRef = useRef(null);
  const feedProfileCache = useRef({});

  // Profile state — loaded from Nostr, not localStorage
  const [profile, setProfile] = useState(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editFields, setEditFields] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [generatingAvatar, setGeneratingAvatar] = useState(false);
  const [modalImage, setModalImage] = useState(null);
  const [dirty, setDirty] = useState(false);
  const originalFieldsRef = useRef({});

  // Warn on browser close/reload when dirty
  useEffect(() => {
    if (!dirty) return;
    function handleBeforeUnload(e) { e.preventDefault(); }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  // Warn on hash navigation when dirty
  useEffect(() => {
    if (!dirty) return;
    function handleHashChange(e) {
      if (!window.confirm("You have unsaved profile changes. Leave without saving?")) {
        e.preventDefault();
        // Restore the hash
        window.history.pushState(null, "", e.oldURL.split("#")[1] ? "#" + e.oldURL.split("#")[1] : "#/");
      }
    }
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [dirty]);

  // Fetch profile from Nostr
  useEffect(() => {
    setProfileLoading(true);
    fetchProfile(ALL_RELAYS, character.pk).then((p) => {
      setProfile(p || {});
      setProfileLoading(false);
    });
  }, [character.pk]);

  // Subscribe to character's own posts
  useEffect(() => {
    setMyLoading(true);
    setMyNotes([]);
    if (mySubRef.current) mySubRef.current.close();
    mySubRef.current = getPool().subscribeMany(
      ALL_RELAYS,
      { kinds: [1], authors: [character.pk], limit: 30 },
      {
        onevent: (ev) => {
          setMyNotes((prev) => {
            if (prev.find((n) => n.id === ev.id)) return prev;
            return [ev, ...prev].sort((a, b) => b.created_at - a.created_at);
          });
        },
        oneose: () => setMyLoading(false),
      }
    );
    return () => { if (mySubRef.current) mySubRef.current.close(); };
  }, [character.pk]);

  // Subscribe to feed (relay or global)
  const addFeedNote = useCallback((event) => {
    setFeedNotes((prev) => {
      if (prev.find((n) => n.id === event.id)) return prev;
      return [event, ...prev].sort((a, b) => b.created_at - a.created_at);
    });
  }, []);

  useEffect(() => {
    setFeedLoading(true);
    setFeedNotes([]);
    if (feedSubRef.current) feedSubRef.current.close();
    if (feedMode === "relay") {
      feedSubRef.current = subscribeFeed(
        DEFAULT_RELAYS,
        (event) => addFeedNote(event),
        () => setFeedLoading(false),
        50
      );
    } else {
      feedSubRef.current = subscribeGlobalFeed(
        ALL_RELAYS,
        (event) => addFeedNote(event),
        () => setFeedLoading(false),
        50
      );
    }
    return () => { if (feedSubRef.current) feedSubRef.current.close(); };
  }, [feedMode, addFeedNote]);

  // Fetch profiles for feed authors
  useEffect(() => {
    const ownPks = new Set((characters || []).map((c) => c.pk));
    const unknownPubkeys = feedNotes
      .map((n) => n.pubkey)
      .filter((pk) => !ownPks.has(pk) && !feedProfileCache.current[pk]);
    if (unknownPubkeys.length === 0) return;
    const unique = [...new Set(unknownPubkeys)];
    unique.forEach((pk) => { feedProfileCache.current[pk] = true; });
    fetchProfiles(ALL_RELAYS, unique).then((fetched) => {
      for (const [pk, profile] of Object.entries(fetched)) {
        feedProfileCache.current[pk] = profile;
      }
      if (Object.keys(fetched).length > 0) {
        setFeedProfiles((prev) => ({ ...prev, ...fetched }));
      }
    });
  }, [feedNotes, characters]);

  function getFeedAuthorName(ev) {
    const ownChar = (characters || []).find((c) => c.pk === ev.pubkey);
    if (ownChar) return ownChar.name;
    const profile = feedProfiles[ev.pubkey];
    return profile?.display_name || profile?.name || shortPubkey(ev.pubkey);
  }

  function getFeedAuthorInitial(ev) {
    return getFeedAuthorName(ev).charAt(0).toUpperCase();
  }

  function getFeedAuthorImage(ev) {
    const ownChar = (characters || []).find((c) => c.pk === ev.pubkey);
    if (ownChar?.profile_image) return ownChar.profile_image;
    const profile = feedProfiles[ev.pubkey];
    return profile?.picture || null;
  }

  function isReply(ev) {
    return ev.tags?.some((t) => t[0] === "e");
  }

  function getRootId(ev) {
    const rootTag = ev.tags?.find((t) => t[0] === "e" && t[3] === "root");
    return rootTag?.[1] || null;
  }

  async function handlePost() {
    if (!postContent.trim() || !account) return;
    setPosting(true);
    try {
      const signed = await publishNote(postContent, account);
      setMyNotes((prev) => [signed, ...prev]);
      addFeedNote(signed);
      setPostContent("");
    } catch (e) {
      alert("Failed to post: " + e.message);
    }
    setPosting(false);
  }

  function startEditing() {
    const fields = {
      name: profile?.name || profile?.display_name || character.name || "",
      display_name: profile?.display_name || profile?.name || character.name || "",
      about: profile?.about || "",
      picture: profile?.picture || "",
      banner: profile?.banner || "",
      nip05: profile?.nip05 || "",
      lud16: profile?.lud16 || "",
      website: profile?.website || "",
    };
    setEditFields(fields);
    originalFieldsRef.current = { ...fields };
    setEditing(true);
    setSaved(false);
    setDirty(false);
  }

  function updateField(field, value) {
    setEditFields((prev) => {
      const updated = { ...prev, [field]: value };
      const isDirty = Object.keys(updated).some((k) => updated[k] !== originalFieldsRef.current[k]);
      setDirty(isDirty);
      return updated;
    });
  }

  async function handleGenerateAvatar() {
    setGeneratingAvatar(true);
    try {
      const result = await generateAvatar({
        name: editFields.display_name || editFields.name || character.name,
        personality: editFields.about || "",
        world: "",
      });
      updateField("picture", result.url);
    } catch (e) {
      alert("Avatar generation failed: " + e.message);
    }
    setGeneratingAvatar(false);
  }

  async function handleSaveProfile() {
    setSaving(true);
    setSaved(false);
    try {
      // Build clean metadata — only include non-empty fields
      const metadata = {};
      if (editFields.name) metadata.name = editFields.name;
      if (editFields.display_name) metadata.display_name = editFields.display_name;
      if (editFields.about) metadata.about = editFields.about;
      if (editFields.picture) metadata.picture = editFields.picture;
      if (editFields.banner) metadata.banner = editFields.banner;
      if (editFields.nip05) metadata.nip05 = editFields.nip05;
      if (editFields.lud16) metadata.lud16 = editFields.lud16;
      if (editFields.website) metadata.website = editFields.website;

      await publishProfile(metadata, account);

      // Update local character name to keep sidebar in sync
      onUpdateChar({
        ...character,
        name: editFields.display_name || editFields.name || character.name,
        profile_image: editFields.picture || "",
        banner_image: editFields.banner || "",
      });

      // Refresh profile from what we just published
      setProfile({ ...profile, ...metadata });
      setEditing(false);
      setDirty(false);
      setSaved(true);
    } catch (e) {
      alert("Failed to save: " + e.message);
    }
    setSaving(false);
  }

  const feedRootNotes = feedNotes.filter((n) => !isReply(n));
  const feedReplyNotes = feedNotes.filter((n) => isReply(n));
  const feedReplyMap = {};
  for (const reply of feedReplyNotes) {
    const rootId = getRootId(reply);
    if (rootId) {
      if (!feedReplyMap[rootId]) feedReplyMap[rootId] = [];
      feedReplyMap[rootId].push(reply);
    }
  }

  return (
    <div>
      {/* Tabs */}
      <div className="feed-tabs">
        <button className={tab === "posts" ? "active" : ""} onClick={() => setTab("posts")}>Posts</button>
        <button className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}>Profile</button>
      </div>

      {/* Posts tab */}
      {tab === "posts" && (
        <div>
          {/* Compose */}
          <div className="feed-compose">
            <div className="compose-box">
              <textarea
                placeholder={`What's on ${character.name}'s mind?`}
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
                <button className="btn-primary" disabled={posting || !postContent.trim()} onClick={handlePost}>
                  {posting ? "Posting..." : `Post as ${character.name}`}
                </button>
              </div>
            </div>
          </div>

          {/* My posts */}
          <div className="profile-feed">
            <h3>{character.name}&apos;s Posts</h3>
            {myLoading && myNotes.length === 0 && <div className="loading">Loading...</div>}
            {!myLoading && myNotes.length === 0 && <div className="loading">No posts yet. Be the first!</div>}
            <div className="notes-list">
              {myNotes.map((ev) => (
                <div key={ev.id} className="note-card clickable" onClick={() => setHash("thread/" + ev.id)}>
                  <div className="note-content">{ev.content}</div>
                  <div className="note-time" style={{ padding: "4px 0" }}>{formatTime(ev.created_at)}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Feed section */}
          <div className="feed-section">
            <div className="feed-section-header">
              <h3>Feed</h3>
              <div className="feed-toggle">
                <button className={`feed-toggle-btn ${feedMode === "relay" ? "active" : ""}`} onClick={() => setFeedMode("relay")}>Our Relay</button>
                <button className={`feed-toggle-btn ${feedMode === "global" ? "active" : ""}`} onClick={() => setFeedMode("global")}>Global Nostr</button>
              </div>
            </div>

            {feedLoading && feedNotes.length === 0 && <div className="loading">Loading...</div>}
            {!feedLoading && feedNotes.length === 0 && <div className="loading">No posts yet.</div>}

            <div className="notes-list">
              {feedRootNotes.map((ev) => (
                <div key={ev.id} className="note-card">
                  <div className="note-header">
                    <div className="note-avatar clickable" onClick={() => setHash("profile/" + npubEncode(ev.pubkey))}>
                      {getFeedAuthorImage(ev) ? (
                        <img src={getFeedAuthorImage(ev)} alt="" style={{ width: 32, height: 32, borderRadius: 2, objectFit: "cover" }} />
                      ) : (
                        <div className="avatar-placeholder">{getFeedAuthorInitial(ev)}</div>
                      )}
                    </div>
                    <div className="note-meta">
                      <span className="note-author clickable" onClick={() => setHash("profile/" + npubEncode(ev.pubkey))}>{getFeedAuthorName(ev)}</span>
                      <span className="note-time">{formatTime(ev.created_at)}</span>
                    </div>
                  </div>
                  <div className="note-content clickable" onClick={() => setHash("thread/" + ev.id)}>{ev.content}</div>
                  {feedReplyMap[ev.id] && (
                    <div className="note-thread-link clickable" onClick={() => setHash("thread/" + ev.id)}>
                      {feedReplyMap[ev.id].length} {feedReplyMap[ev.id].length === 1 ? "reply" : "replies"}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Profile tab */}
      {tab === "profile" && (
        <div>
          {profileLoading && <div className="loading">Loading profile from relays...</div>}

          {!profileLoading && !editing && (
            <div>
              {/* Profile display */}
              <div className="char-hero">
                {profile?.banner && <div className="char-hero-banner"><img src={profile.banner} alt="" /></div>}
                <div className="char-hero-content">
                  <div className="char-hero-avatar">
                    {profile?.picture ? (
                      <img src={profile.picture} alt="" />
                    ) : (
                      <div className="avatar-placeholder large">
                        {(profile?.display_name || profile?.name || character.name || "?").charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>
                  <h2 className="char-hero-name">{profile?.display_name || profile?.name || character.name}</h2>
                  {profile?.about && <p className="char-hero-personality">{profile.about}</p>}
                  {profile?.website && (
                    <p className="char-hero-world">
                      <a href={profile.website.startsWith("http") ? profile.website : "https://" + profile.website} target="_blank" rel="noopener noreferrer">{profile.website}</a>
                    </p>
                  )}
                  {profile?.nip05 && <p className="char-hero-world">{profile.nip05}</p>}
                  {profile?.lud16 && <p className="char-hero-world">{profile.lud16}</p>}
                  <code className="char-npub" onClick={() => navigator.clipboard.writeText(character.npub)}>{character.npub}</code>
                  <div className="char-hero-actions" style={{ flexDirection: "row", justifyContent: "center", marginTop: 12 }}>
                    <button className="btn-primary" onClick={startEditing}>Edit Profile</button>
                  </div>
                </div>
              </div>

              <div className="admin-keys-section" style={{ margin: "24px 0" }}>
                <h3>Keys</h3>
                <div className="admin-key-row"><span>npub</span><code>{character.npub}</code></div>
                <div className="admin-key-row"><span>pubkey (hex)</span><code>{character.pk}</code></div>
                <div className="admin-key-row"><span>nsec</span><code className="nsec-display">{character.nsec}</code></div>
              </div>

              <button
                className="btn-small btn-reset"
                onClick={() => {
                  if (window.confirm(`Delete "${character.name}"? This removes the private key permanently.`)) onDeleteChar(character.id);
                }}
              >
                Delete Character
              </button>
              {saved && <p className="success" style={{ marginTop: 12 }}>Profile saved to Nostr!</p>}
            </div>
          )}

          {!profileLoading && editing && (
            <div className="edit-section">
              <h3>Edit Profile (NIP-01)</h3>
              <p style={{ color: "var(--text-faint)", fontSize: "0.75rem", marginBottom: 16 }}>
                These fields are saved to Nostr as a kind:0 metadata event. Other Nostr clients will display this profile.
              </p>
              <div className="edit-form">
                <label><span>Display Name</span>
                  <input type="text" value={editFields.display_name} onChange={(e) => { updateField("display_name", e.target.value); updateField("name", e.target.value); }} placeholder="Your character's name" /></label>
                <label><span>About</span>
                  <textarea value={editFields.about} onChange={(e) => updateField("about", e.target.value)} rows={4} placeholder="Bio, personality, backstory..." /></label>
                <label>
                  <div className="avatar-gen-header">
                    <span>Picture URL</span>
                    {isNimAvailable() && (
                      <button
                        type="button"
                        className="btn-small"
                        onClick={handleGenerateAvatar}
                        disabled={generatingAvatar}
                        style={{ marginLeft: "auto" }}
                      >
                        {generatingAvatar ? "Generating..." : "Generate Avatar"}
                      </button>
                    )}
                  </div>
                  <input type="url" value={editFields.picture} onChange={(e) => updateField("picture", e.target.value)} placeholder="https://..." />
                  {generatingAvatar && (
                    <div className="avatar-gen-loading">
                      <span className="streaming-dot" />
                      <span>Generating via <strong>NVIDIA NIM</strong> — Stable Diffusion 3 Medium</span>
                    </div>
                  )}
                  {editFields.picture && !generatingAvatar && (
                    <div className="avatar-gen-preview">
                      <img src={editFields.picture} alt="preview" onError={(e) => { e.target.style.display = "none"; }} />
                      <div>
                        <span className="avatar-gen-model">Picture preview</span>
                        <br />
                        <button type="button" className="btn-link" onClick={() => setModalImage(editFields.picture)}>View full size</button>
                      </div>
                    </div>
                  )}
                </label>
                <label><span>Banner URL</span>
                  <input type="url" value={editFields.banner} onChange={(e) => updateField("banner", e.target.value)} placeholder="https://..." /></label>
                <label><span>NIP-05 (Nostr Address)</span>
                  <input type="text" value={editFields.nip05} onChange={(e) => updateField("nip05", e.target.value)} placeholder="name@domain.com" /></label>
                <label><span>Lightning Address (LUD-16)</span>
                  <input type="text" value={editFields.lud16} onChange={(e) => updateField("lud16", e.target.value)} placeholder="name@walletofsatoshi.com" /></label>
                <label><span>Website</span>
                  <input type="url" value={editFields.website} onChange={(e) => updateField("website", e.target.value)} placeholder="https://..." /></label>
              </div>

              <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
                <button className="btn-primary" onClick={handleSaveProfile} disabled={saving}>
                  {saving ? "Publishing..." : "Publish to Nostr"}
                </button>
                <button className="btn-back" onClick={() => {
                  if (!dirty || window.confirm("Discard unsaved changes?")) {
                    setEditing(false);
                    setDirty(false);
                  }
                }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
      <ImageModal src={modalImage} onClose={() => setModalImage(null)} />
    </div>
  );
}

// ══════════════════════════════════════
//  EXTERNAL PROFILE VIEW (not owned)
// ══════════════════════════════════════

function ExternalProfileView({ pubkey, activeAccount }) {
  const [profile, setProfile] = useState(null);
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const subRef = useRef(null);

  useEffect(() => {
    fetchProfile(ALL_RELAYS, pubkey).then((p) => setProfile(p || {}));
  }, [pubkey]);

  useEffect(() => {
    setLoading(true);
    setNotes([]);
    if (subRef.current) subRef.current.close();
    subRef.current = getPool().subscribeMany(
      ALL_RELAYS,
      { kinds: [1], authors: [pubkey], limit: 30 },
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
    <div>
      <button className="btn-back" onClick={() => setHash("")} style={{ marginBottom: 16 }}>Back</button>

      <div className="char-hero">
        {profile?.banner && <div className="char-hero-banner"><img src={profile.banner} alt="" /></div>}
        <div className="char-hero-content">
          <div className="char-hero-avatar">
            {profile?.picture ? (
              <img src={profile.picture} alt="" />
            ) : (
              <div className="avatar-placeholder large">{name.charAt(0).toUpperCase()}</div>
            )}
          </div>
          <h2 className="char-hero-name">{name}</h2>
          {about && <p className="char-hero-personality">{about}</p>}
          <code className="char-npub" onClick={() => navigator.clipboard.writeText(npub)}>{npub}</code>
          {activeAccount && (
            <div className="char-hero-actions" style={{ flexDirection: "row", justifyContent: "center", marginTop: 12 }}>
              <button className="btn-primary" style={{ padding: "8px 20px", fontSize: "0.9rem" }} onClick={() => setHash("messages/" + npub)}>
                Message {name}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="profile-feed">
        <h3>Posts</h3>
        {loading && notes.length === 0 && <div className="loading">Loading...</div>}
        {!loading && notes.length === 0 && <div className="loading">No posts yet.</div>}
        <div className="notes-list">
          {notes.map((ev) => (
            <div key={ev.id} className="note-card clickable" onClick={() => setHash("thread/" + ev.id)}>
              <div className="note-content">{ev.content}</div>
              <div className="note-time" style={{ padding: "4px 0" }}>{formatTime(ev.created_at)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════
//  THREAD VIEW
// ══════════════════════════════════════

function ThreadView({ eventId, account, characters = [] }) {
  const [rootEvent, setRootEvent] = useState(null);
  const [replies, setReplies] = useState([]);
  const [profiles, setProfiles] = useState({});
  const [loading, setLoading] = useState(true);
  const [replyContent, setReplyContent] = useState("");
  const [posting, setPosting] = useState(false);
  const subRef = useRef(null);
  const profileCache = useRef({});

  useEffect(() => {
    setLoading(true);
    setRootEvent(null);
    setReplies([]);
    if (subRef.current) subRef.current.close();
    let eoseCount = 0;
    const checkEose = () => { eoseCount++; if (eoseCount >= 2) setLoading(false); };
    const sub1 = getPool().subscribeMany(ALL_RELAYS, { ids: [eventId] }, {
      onevent: (ev) => setRootEvent(ev),
      oneose: checkEose,
    });
    const sub2 = getPool().subscribeMany(ALL_RELAYS, { kinds: [1], "#e": [eventId] }, {
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

  useEffect(() => {
    const allEvents = rootEvent ? [rootEvent, ...replies] : replies;
    const unknownPks = allEvents.map((e) => e.pubkey).filter((pk) => !profileCache.current[pk]);
    const unique = [...new Set(unknownPks)];
    if (unique.length === 0) return;
    unique.forEach((pk) => { profileCache.current[pk] = true; });
    fetchProfiles(ALL_RELAYS, unique).then((fetched) => {
      setProfiles((prev) => ({ ...prev, ...fetched }));
      Object.assign(profileCache.current, fetched);
    });
  }, [rootEvent, replies]);

  function getName(ev) {
    const ownChar = characters.find((c) => c.pk === ev.pubkey);
    if (ownChar) return ownChar.name;
    const p = profiles[ev.pubkey];
    return p?.display_name || p?.name || shortPubkey(ev.pubkey);
  }
  function getInitial(ev) { return getName(ev).charAt(0).toUpperCase(); }
  function getAuthorImage(ev) {
    const ownChar = characters.find((c) => c.pk === ev.pubkey);
    if (ownChar?.profile_image) return ownChar.profile_image;
    const p = profiles[ev.pubkey];
    return p?.picture || null;
  }

  async function handleReply() {
    if (!replyContent.trim() || !account || !rootEvent) return;
    setPosting(true);
    try {
      const lastReply = replies.length > 0 ? replies[replies.length - 1] : rootEvent;
      const tags = [["e", rootEvent.id, DEFAULT_RELAYS[0] || "", "root"], ["p", rootEvent.pubkey]];
      if (lastReply.id !== rootEvent.id) {
        tags.push(["e", lastReply.id, DEFAULT_RELAYS[0] || "", "reply"]);
        if (lastReply.pubkey !== rootEvent.pubkey) tags.push(["p", lastReply.pubkey]);
      }
      const signed = await publishEvent({
        kind: 1, created_at: Math.floor(Date.now() / 1000), tags, content: replyContent,
      }, account);
      setReplies((prev) => [...prev, signed].sort((a, b) => a.created_at - b.created_at));
      setReplyContent("");
    } catch (e) { alert("Failed to reply: " + e.message); }
    setPosting(false);
  }

  return (
    <div className="thread-view">
      <button className="btn-back" onClick={() => setHash("")}>Back to feed</button>
      {loading && !rootEvent && <div className="loading">Loading thread...</div>}
      {rootEvent && (
        <div className="note-card thread-root">
          <div className="note-header">
            <div className="note-avatar clickable" onClick={() => setHash("profile/" + npubEncode(rootEvent.pubkey))}>
              {getAuthorImage(rootEvent) ? (
                <img src={getAuthorImage(rootEvent)} alt="" style={{ width: 32, height: 32, borderRadius: 2, objectFit: "cover" }} />
              ) : (
                <div className="avatar-placeholder">{getInitial(rootEvent)}</div>
              )}
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
                  {getAuthorImage(reply) ? (
                    <img src={getAuthorImage(reply)} alt="" style={{ width: 26, height: 26, borderRadius: 2, objectFit: "cover" }} />
                  ) : (
                    <div className="avatar-placeholder small">{getInitial(reply)}</div>
                  )}
                </div>
                <div className="note-meta">
                  <span className="note-author clickable" onClick={() => setHash("profile/" + npubEncode(reply.pubkey))}>{getName(reply)}</span>
                  <span className="note-reply-tag">reply</span>
                  <span className="note-time">{formatTime(reply.created_at)}</span>
                </div>
              </div>
              <div className="note-content">{reply.content}</div>
            </div>
          ))}
        </div>
      )}
      {!loading && replies.length === 0 && rootEvent && <p className="thread-no-replies">No replies yet. Be the first!</p>}
      {account && rootEvent && (
        <div className="thread-reply-compose">
          <textarea placeholder="Write a reply..." value={replyContent} onChange={(e) => setReplyContent(e.target.value)} rows={3}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleReply(); } }} />
          <div className="compose-footer">
            <span className="hint">Ctrl+Enter to reply</span>
            <button className="btn-primary" disabled={posting || !replyContent.trim()} onClick={handleReply}>
              {posting ? "Replying..." : "Reply"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════
//  MESSAGE VIEW
// ══════════════════════════════════════

function MessageView({ recipientPubkey, account }) {
  const [recipientName, setRecipientName] = useState("");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const subRef = useRef(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (!recipientPubkey) return;
    fetchProfile(ALL_RELAYS, recipientPubkey).then((profile) => {
      setRecipientName(profile ? (profile.display_name || profile.name || shortPubkey(recipientPubkey)) : shortPubkey(recipientPubkey));
    });
  }, [recipientPubkey]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);

  useEffect(() => {
    if (!account) return;
    setLoading(true);
    setMessages([]);
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
    try { await sendDM(input, recipientPubkey, account); setInput(""); }
    catch (e) { alert("Failed to send: " + e.message); }
    setSending(false);
  }

  const filtered = messages.filter((m) => {
    const otherPk = m.pubkey === account?.pk ? m.tags.find((t) => t[0] === "p")?.[1] : m.pubkey;
    return otherPk === recipientPubkey;
  });

  if (!account) {
    return (
      <div className="loading">
        <p>Create a character first to send messages.</p>
        <button className="btn-primary" onClick={() => setHash("characters/new")} style={{ marginTop: 12 }}>Create Character</button>
      </div>
    );
  }

  return (
    <div className="conversation-view">
      <div className="conversation-header">
        <button className="btn-back" onClick={() => setHash("")}>&#8592;</button>
        <div className="conversation-contact">
          <div className="avatar-placeholder" style={{ width: 32, height: 32, fontSize: "0.8rem" }}>
            {(recipientName || "?").charAt(0).toUpperCase()}
          </div>
          <span className="conversation-name">{recipientName}</span>
        </div>
      </div>
      <div className="conversation-messages">
        {loading && filtered.length === 0 && <div className="loading">Connecting...</div>}
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
        <input type="text" placeholder={`Message ${recipientName}...`} value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleSend(); } }} />
        <button className="btn-send" onClick={handleSend} disabled={sending || !input.trim()}>
          {sending ? "..." : "\u27A4"}
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════
//  RELAY STATUS
// ══════════════════════════════════════

function RelayStatus({ url }) {
  const [status, setStatus] = useState("checking");

  useEffect(() => {
    setStatus("checking");
    let ws;
    try {
      ws = new WebSocket(url);
      const timeout = setTimeout(() => { ws.close(); setStatus("timeout"); }, 5000);
      ws.onopen = () => { clearTimeout(timeout); ws.close(); setStatus("connected"); };
      ws.onerror = () => { clearTimeout(timeout); setStatus("error"); };
    } catch {
      setStatus("error");
    }
    return () => { try { ws?.close(); } catch {} };
  }, [url]);

  const colors = {
    checking: "var(--text-faint)",
    connected: "var(--accent)",
    timeout: "var(--danger)",
    error: "var(--danger)",
  };
  const labels = {
    checking: "Checking...",
    connected: "Connected",
    timeout: "Timeout",
    error: "Unreachable",
  };

  return (
    <span style={{ color: colors[status], fontSize: "0.78rem", fontWeight: 600 }}>
      {status === "connected" && <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", marginRight: 6, verticalAlign: "middle" }} />}
      {status === "error" || status === "timeout" ? <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--danger)", marginRight: 6, verticalAlign: "middle" }} /> : null}
      {labels[status]}
    </span>
  );
}

// ══════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════

function SettingsPage({ characters, onReset }) {
  function handleExportKeys() {
    const lines = characters.map((c, i) => {
      const idx = i + 1;
      return [
        `# ${c.name}`,
        `CHARACTER_${idx}_NAME=${c.name}`,
        `CHARACTER_${idx}_NSEC=${c.nsec}`,
        `CHARACTER_${idx}_SKHEX=${c.skHex}`,
        `CHARACTER_${idx}_NPUB=${c.npub}`,
        `CHARACTER_${idx}_PK=${c.pk}`,
        "",
      ].join("\n");
    });

    const content = [
      "# NPC No More — Character Keys Export",
      `# Exported: ${new Date().toISOString()}`,
      `# Characters: ${characters.length}`,
      "#",
      "# WARNING: These are private keys. Anyone with access can post as your characters.",
      "# Store securely and never commit to a public repository.",
      "",
      ...lines,
    ].join("\n");

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "npc-no-more-keys.env";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h2 className="page-title">Settings</h2>

      <div className="edit-section">
        <h3>Relay</h3>
        {OWN_RELAY ? (
          <div>
            <div className="admin-key-row">
              <span>Our Relay</span>
              <code>{OWN_RELAY}</code>
            </div>
            <div className="admin-key-row">
              <span>Status</span>
              <RelayStatus url={OWN_RELAY} />
            </div>
            <p style={{ color: "var(--text-faint)", fontSize: "0.75rem", marginTop: 12 }}>
              This is the private relay for NPC No More characters. All posts are published here first.
              The &quot;Our Relay&quot; feed in the Posts tab shows only events from this relay.
            </p>
          </div>
        ) : (
          <p style={{ color: "var(--text-dim)", fontSize: "0.82rem" }}>
            No private relay configured. Using public relays only.
          </p>
        )}
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: "0.68rem", fontWeight: 600, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "1.5px", marginBottom: 8 }}>
            Public Relays
          </div>
          {PUBLIC_RELAYS.map((r) => (
            <div key={r} className="admin-key-row">
              <code style={{ fontSize: "0.72rem" }}>{r}</code>
            </div>
          ))}
        </div>
      </div>

      <div className="edit-section" style={{ marginTop: 20 }}>
        <h3>Export Keys</h3>
        <p style={{ color: "var(--text-dim)", fontSize: "0.82rem", marginBottom: 16 }}>
          Download all character private keys as a .env file. Store this securely — anyone with these keys can post as your characters.
        </p>
        <button className="btn-primary" onClick={handleExportKeys} disabled={characters.length === 0}>
          Export {characters.length} {characters.length === 1 ? "key" : "keys"} as .env
        </button>
      </div>

      <div className="edit-section" style={{ marginTop: 20 }}>
        <h3>Characters</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {characters.map((c) => (
            <div key={c.id} className="admin-key-row">
              <span style={{ fontFamily: "var(--font-display)", fontSize: "0.95rem", color: "var(--cream)" }}>{c.name}</span>
              <code>{c.npub.slice(0, 20)}...{c.npub.slice(-8)}</code>
            </div>
          ))}
        </div>
      </div>

      <div className="edit-section" style={{ marginTop: 20, borderLeftColor: "var(--danger-dim)" }}>
        <h3>Danger Zone</h3>
        <p style={{ color: "var(--text-dim)", fontSize: "0.82rem", marginBottom: 16 }}>
          Delete all characters and data. This cannot be undone. Export your keys first.
        </p>
        <button className="btn-small btn-reset" onClick={onReset}>
          Delete all data
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════
//  APP
// ══════════════════════════════════════

export default function App() {
  const [characters, setCharacters] = useState([]);
  const [activeCharId, setActiveCharId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [route, setRoute] = useState("home");
  const [routeKey, setRouteKey] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const activeChar = characters.find((c) => c.id === activeCharId) || null;
  const activeAccount = activeChar ? accountFromSkHex(activeChar.skHex) : null;

  useEffect(() => {
    const existing = loadCharacters();
    if (existing.length === 0) migrateOldData();
    const chars = loadCharacters();
    setCharacters(chars);
    const savedId = loadActiveCharId();
    if (savedId && chars.find((c) => c.id === savedId)) {
      setActiveCharId(savedId);
    } else if (chars.length > 0) {
      setActiveCharId(chars[0].id);
      saveActiveCharId(chars[0].id);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    function applyHash() {
      const { route: r, key } = parseHash();
      setRoute(r);
      setRouteKey(key ? resolvePubkey(key) || key : null);
      setSidebarOpen(false);
    }
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  function switchCharacter(id) {
    setActiveCharId(id);
    saveActiveCharId(id);
  }

  function handleCreateCharacter(char) {
    const updated = [...characters, char];
    setCharacters(updated);
    saveCharacters(updated);
    switchCharacter(char.id);
    setHash("profile/" + char.npub);
  }

  function handleDeleteCharacter(id) {
    const updated = characters.filter((c) => c.id !== id);
    setCharacters(updated);
    saveCharacters(updated);
    if (activeCharId === id) {
      const newActive = updated.length > 0 ? updated[0].id : null;
      setActiveCharId(newActive);
      saveActiveCharId(newActive);
    }
    setHash("");
  }

  function handleUpdateCharacter(updatedChar) {
    const updated = characters.map((c) => c.id === updatedChar.id ? updatedChar : c);
    setCharacters(updated);
    saveCharacters(updated);
  }

  function handleReset() {
    if (!window.confirm("Delete ALL characters and data? This cannot be undone.")) return;
    setCharacters([]);
    setActiveCharId(null);
    saveCharacters([]);
    saveActiveCharId(null);
    setHash("");
  }

  if (loading) return null;

  if (characters.length === 0 && route !== "new-character") {
    return <CreateCharacter onComplete={handleCreateCharacter} />;
  }

  if (route === "new-character") {
    return <CreateCharacter onComplete={handleCreateCharacter} />;
  }

  // Figure out current profile pubkey for sidebar highlighting
  let currentProfilePk = null;
  if (route === "profile" && routeKey) {
    currentProfilePk = routeKey;
  }

  function renderMain() {
    if (route === "settings") {
      return <SettingsPage characters={characters} onReset={handleReset} />;
    }
    if (route === "profile" && routeKey) {
      const ownedChar = characters.find((c) => c.pk === routeKey) || null;
      if (ownedChar) {
        return (
          <OwnedCharacterPage
            key={ownedChar.id}
            character={ownedChar}
            account={accountFromSkHex(ownedChar.skHex)}
            characters={characters}
            onUpdateChar={handleUpdateCharacter}
            onDeleteChar={handleDeleteCharacter}
          />
        );
      }
      return <ExternalProfileView pubkey={routeKey} activeAccount={activeAccount} />;
    }
    if (route === "thread" && routeKey) {
      return <ThreadView eventId={routeKey} account={activeAccount} characters={characters} />;
    }
    if (route === "messages" && routeKey) {
      return <MessageView recipientPubkey={routeKey} account={activeAccount} />;
    }
    // Home route: show active character's page
    if (activeChar) {
      return (
        <OwnedCharacterPage
          key={activeChar.id}
          character={activeChar}
          account={activeAccount}
          characters={characters}
          onUpdateChar={handleUpdateCharacter}
          onDeleteChar={handleDeleteCharacter}
        />
      );
    }
    return <div className="loading">Create a character to get started.</div>;
  }

  return (
    <div className="app-layout">
      <Sidebar
        characters={characters}
        activeCharId={activeCharId}
        onSwitch={switchCharacter}
        currentPubkey={currentProfilePk}
      />

      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <div className={`sidebar-mobile ${sidebarOpen ? "open" : ""}`}>
        <Sidebar
          characters={characters}
          activeCharId={activeCharId}
          onSwitch={switchCharacter}
          currentPubkey={currentProfilePk}
        />
      </div>

      <div className="main-content">
        <MobileHeader
          activeChar={activeChar}
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
        />
        <main className="main-inner">
          {renderMain()}
        </main>
      </div>
    </div>
  );
}
