import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from "react";
const ForceGraph2D = lazy(() => import("react-force-graph-2d"));
import { forceCollide, forceManyBody } from "d3-force-3d";
import { isNimAvailable, generateRandomPersona, generateAvatar, uploadAvatar, getRandomErrorMessage } from "./nim";
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
  fetchFollows,
  publishFollows,
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
  loadAdminAccount,
  createAdminAccount,
  saveAdminAccount,
  clearLocal,
  createAuthEvent,
  getAuthHeaders,
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
  if (parts[0] === "network") return { route: "network" };
  if (parts[0] === "pi") return { route: "pi" };
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

function Sidebar({ allIdentities, activeCharId, serverAdminPubkey, adminPk, onSelectIdentity, unreadPks }) {
  const isAdmin = !!serverAdminPubkey && serverAdminPubkey === adminPk;
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1 className="sidebar-title clickable" onClick={() => setHash("")}>NPC No More</h1>
      </div>

      <div className="sidebar-section-label">Identities</div>
      <div className="sidebar-characters">
        {allIdentities.map((c) => (
          <button
            key={c.id}
            className={`sidebar-char ${c.id === activeCharId ? "active-char" : ""}`}
            onClick={() => { onSelectIdentity(c.id); setHash("profile/" + c.npub); }}
          >
            {unreadPks?.has(c.pk) && <span className="sidebar-acting-dot" />}
            <span className="sidebar-char-avatar">
              {c.profile_image ? (
                <img src={c.profile_image} alt="" />
              ) : (
                (c.name || "U").charAt(0).toUpperCase()
              )}
            </span>
            <span className="sidebar-char-name" style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
              <span>{c.name}</span>
              {c.isAdminIdentity && <span style={{ fontSize: "0.55rem", color: "var(--accent)" }}>{isAdmin ? "ADMIN" : "USER"}</span>}
            </span>
          </button>
        ))}
        <button className="sidebar-item sidebar-add" onClick={() => setHash("characters/new")}>
          <span className="sidebar-icon">+</span>
          <span>New Character</span>
        </button>
      </div>

      <div className="sidebar-footer">
        <button className="sidebar-item" onClick={() => setHash("pi")}>
          <span className="sidebar-icon">&#9000;</span>
          <span>Pi Agent</span>
        </button>
        <button className="sidebar-item" onClick={() => setHash("network")}>
          <span className="sidebar-icon">&#9673;</span>
          <span>Network</span>
        </button>
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
//  USER / ADMIN SETUP
// ══════════════════════════════════════

function UserSetup({ serverAdminPubkey, onComplete }) {
  // Create keypair in memory only — persisted on save
  const [account] = useState(() => createAccount());
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [generatingAvatar, setGeneratingAvatar] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [rolledModel, setRolledModel] = useState(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef(null);
  const [error, setError] = useState("");
  const [avatarModal, setAvatarModal] = useState(null);

  const hasAdmin = !!serverAdminPubkey;
  const canUseNim = isNimAvailable();

  async function handleRollDice() {
    setRolling(true);
    setError("");
    try {
      const persona = await generateRandomPersona((partial) => {
        if (partial.name) setName(partial.name);
        if (partial.personality) setAbout(partial.personality);
        setRolledModel(partial.model);
      }, account);
      setName(persona.name);
      setAbout(persona.personality);
      setRolledModel(persona.model);
    } catch (e) {
      const msg = e?.message || "";
      setError(hasAdmin && (msg.includes("401") || msg.includes("unauthorized"))
        ? "Your key hasn't been whitelisted yet. Ask the admin to add your npub before using AI features."
        : getRandomErrorMessage());
    }
    setRolling(false);
  }

  async function handleGenerateAvatar() {
    if (!name.trim() || !account) return;
    setGeneratingAvatar(true);
    setError("");
    try {
      const result = await generateAvatar({ name, personality: about, world: "" }, account);
      setAvatarUrl(result.url);
    } catch (e) {
      const msg = e?.message || "";
      setError(hasAdmin && (msg.includes("401") || msg.includes("unauthorized"))
        ? "Your key hasn't been whitelisted yet. Ask the admin to add your npub before using AI features."
        : "Avatar generation failed: " + msg);
    }
    setGeneratingAvatar(false);
  }

  async function handleUploadAvatar(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const result = await uploadAvatar(file, account);
      setAvatarUrl(result.url);
    } catch (err) {
      const msg = err?.message || "";
      setError(hasAdmin && (msg.includes("401") || msg.includes("unauthorized"))
        ? "Your key hasn't been whitelisted yet. Ask the admin to add your npub before using AI features."
        : "Upload failed: " + msg);
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFinish() {
    if (!name.trim()) { setError("Name is required"); return; }
    setSaving(true);
    setError("");
    try {
      // Claim admin if no admin exists yet
      if (!hasAdmin) {
        const apiUrl = import.meta.env.VITE_API_URL || "";
        if (apiUrl) {
          const claimUrl = `${apiUrl}/claim-admin`;
          const headers = await getAuthHeaders(claimUrl, "POST", account);
          const res = await fetch(claimUrl, { method: "POST", headers });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || "Failed to claim admin");
          }
        }
      }
      // Register pubkey on relay (for non-admin users, claim-admin already handles it for admin)
      if (hasAdmin) {
        const apiUrl = import.meta.env.VITE_API_URL || "";
        if (apiUrl) {
          await fetch(`${apiUrl}/register-pubkey`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pubkey: account.pk, label: "user" }),
          }).catch(() => {});
        }
      }
      account.profile_name = name;
      account.profile_about = about;
      account.profile_image = avatarUrl;
      saveAdminAccount(account);
      await publishProfile({
        name,
        display_name: name,
        about,
        ...(avatarUrl ? { picture: avatarUrl } : {}),
      }, account);
      onComplete(account);
    } catch (e) {
      setError("Failed: " + e.message);
    }
    setSaving(false);
  }

  return (
    <div className="setup-wizard">
      <div className="setup-card">
        <h1>NPC No More</h1>
        <p className="setup-tagline">
          {hasAdmin ? "Welcome — set up your profile" : "First-time setup — create your profile"}
        </p>
        <p style={{ color: "var(--text-dim)", fontSize: "0.82rem", marginBottom: 12 }}>
          {hasAdmin
            ? "Create your profile so other users and the admin can identify you. Your Nostr keypair will be generated when you save."
            : "This is you — not a character. Your Nostr keypair and admin privileges are created when you save."
          }
        </p>

        {canUseNim && (
          <div className="dice-roll-section">
            {hasAdmin && (
              <p style={{ color: "var(--neon)", fontSize: "0.78rem", marginBottom: 8 }}>
                AI features are disabled until the admin whitelists your key.
              </p>
            )}
            <button className={`btn-dice${rolling ? " loading" : ""}`} onClick={handleRollDice} disabled={rolling || hasAdmin}>
              {rolling ? "Generating..." : "Generate Profile with AI"}
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
                {rolledModel.params && ` (${rolledModel.params}B)`} — edit below!
              </p>
            )}
          </div>
        )}

        <div className="edit-form">
          <label><span>Display Name</span>
            <input type="text" placeholder="Your name or handle" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <label><span>About</span>
            <textarea placeholder="A short bio..." value={about} onChange={(e) => setAbout(e.target.value)} rows={3} />
          </label>
        </div>

        <div className="avatar-gen-section">
          <div className="avatar-gen-header">
            <span className="avatar-gen-label">Profile Picture</span>
            <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
              {canUseNim && (
                <button className="btn-small" onClick={handleGenerateAvatar} disabled={generatingAvatar || !name.trim() || hasAdmin} title={!name.trim() ? "Enter a display name first" : ""}>
                  {generatingAvatar ? "Generating..." : "Generate"}
                </button>
              )}
              <button className="btn-small" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                {uploading ? "Uploading..." : "Upload"}
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleUploadAvatar} style={{ display: "none" }} />
            </div>
          </div>
          {canUseNim && !name.trim() && !avatarUrl && (
            <p style={{ color: "var(--text-faint)", fontSize: "0.75rem", marginTop: 6 }}>Enter a display name to enable avatar generation.</p>
          )}
          {(generatingAvatar || uploading) && (
            <div className="avatar-gen-loading">
              <span className="streaming-dot" />
              <span>{uploading ? "Uploading image..." : "Generating via NVIDIA NIM — Stable Diffusion 3 Medium"}</span>
            </div>
          )}
          {avatarUrl && !generatingAvatar && !uploading && (
            <div className="avatar-gen-preview">
              <img src={avatarUrl} alt="Avatar" style={{ cursor: "pointer" }} onClick={() => setAvatarModal(avatarUrl)} />
            </div>
          )}
        </div>

        {error && <div className="dice-error">{error}</div>}

        <div className="setup-nav">
          <button className="btn-primary" onClick={handleFinish} disabled={saving || !name.trim()}>
            {saving ? "Saving..." : "Save & Continue"}
          </button>
        </div>
      </div>
      <ImageModal src={avatarModal} onClose={() => setAvatarModal(null)} />
    </div>
  );
}

// ══════════════════════════════════════
//  CREATE CHARACTER
// ══════════════════════════════════════

function CreateCharacter({ onComplete, adminAccount, serverAdminPubkey }) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [charName, setCharName] = useState("");
  const [charAbout, setCharAbout] = useState("");
  const [rolling, setRolling] = useState(false);
  const [rolledModel, setRolledModel] = useState(null);
  const [mode, setMode] = useState("create");
  const [nsecInput, setNsecInput] = useState("");
  const [generatingAvatar, setGeneratingAvatar] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState("");
  const [avatarModal, setAvatarModal] = useState(null);
  const fileInputRef = useRef(null);

  async function handleUploadAvatar(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError("");
    try {
      const result = await uploadAvatar(file, adminAccount);
      setAvatarUrl(result.url);
    } catch (err) {
      setError("Upload failed: " + (err?.message || ""));
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleRollDice() {
    setRolling(true);
    setError("");
    const isWhitelisted = !serverAdminPubkey || serverAdminPubkey === adminAccount?.pk;
    try {
      const persona = await generateRandomPersona((partial) => {
        if (partial.name) setCharName(partial.name);
        if (partial.personality) setCharAbout(partial.personality);
        setRolledModel(partial.model);
      }, adminAccount);
      setCharName(persona.name);
      setCharAbout(persona.personality);
      setRolledModel(persona.model);
    } catch (e) {
      const msg = e?.message || "";
      setError(!isWhitelisted && (msg.includes("401") || msg.includes("unauthorized"))
        ? "Your key hasn't been whitelisted yet. Ask the admin to add your npub before using AI features."
        : getRandomErrorMessage());
    }
    setRolling(false);
  }

  async function handleGenerateAvatar() {
    if (!charName.trim()) return;
    setGeneratingAvatar(true);
    setError("");
    const isWhitelisted = !serverAdminPubkey || serverAdminPubkey === adminAccount?.pk;
    try {
      const result = await generateAvatar({ name: charName, personality: charAbout, world: "" }, adminAccount);
      setAvatarUrl(result.url);
    } catch (e) {
      const msg = e?.message || "";
      setError(!isWhitelisted && (msg.includes("401") || msg.includes("unauthorized"))
        ? "Your key hasn't been whitelisted yet. Ask the admin to add your npub before using AI features."
        : "Avatar generation failed: " + msg);
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
        personality: charAbout,
        profile_image: avatarUrl || "",
        banner_image: "",
        skHex: acc.skHex,
        nsec: acc.nsec,
        pk: acc.pk,
        npub: acc.npub,
        createdAt: Math.floor(Date.now() / 1000),
      };
      await publishProfile({
        name: charName,
        display_name: charName,
        about: charAbout,
        ...(avatarUrl ? { picture: avatarUrl } : {}),
      }, acc);
      // Register character pubkey on relay
      const apiUrl = import.meta.env.VITE_API_URL || "";
      if (apiUrl && adminAccount) {
        const regUrl = `${apiUrl}/register-pubkey`;
        const headers = await getAuthHeaders(regUrl, "POST", adminAccount);
        headers["Content-Type"] = "application/json";
        fetch(regUrl, { method: "POST", headers, body: JSON.stringify({ pubkey: acc.pk, label: charName }) }).catch(() => {});
      }
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
            {serverAdminPubkey && serverAdminPubkey !== adminAccount?.pk && (
              <p style={{ color: "var(--neon)", fontSize: "0.78rem", marginBottom: 8 }}>
                AI features are disabled until the admin whitelists your key.
              </p>
            )}
            <button className={`btn-dice${rolling ? " loading" : ""}`} onClick={handleRollDice} disabled={rolling || (serverAdminPubkey && serverAdminPubkey !== adminAccount?.pk)}>
              {rolling ? "Rolling..." : "Generate Character with AI"}
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
                {rolledModel.params && ` (${rolledModel.params}B)`} — edit below!
              </p>
            )}
          </div>
        )}

        <div className="edit-form">
          <label><span>Character Name</span>
            <input type="text" placeholder="Zara, ARIA-7, The Chronicler..." value={charName} onChange={(e) => setCharName(e.target.value)} /></label>
          <label><span>About</span>
            <textarea placeholder="Personality, backstory, how they speak..." value={charAbout} onChange={(e) => setCharAbout(e.target.value)} rows={4} /></label>
        </div>

        <div className="avatar-gen-section">
          <div className="avatar-gen-header">
            <span className="avatar-gen-label">Profile Picture</span>
            <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
              {isNimAvailable() && (
                <button className="btn-small" onClick={handleGenerateAvatar} disabled={generatingAvatar || !charName.trim() || (serverAdminPubkey && serverAdminPubkey !== adminAccount?.pk)} title={!charName.trim() ? "Enter a character name first" : ""}>
                  {generatingAvatar ? "Generating..." : "Generate"}
                </button>
              )}
              <button className="btn-small" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                {uploading ? "Uploading..." : "Upload"}
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleUploadAvatar} style={{ display: "none" }} />
            </div>
          </div>
          {isNimAvailable() && !charName.trim() && !avatarUrl && (
            <p style={{ color: "var(--text-faint)", fontSize: "0.75rem", marginTop: 6 }}>Enter a character name to enable avatar generation.</p>
          )}
          {(generatingAvatar || uploading) && (
            <div className="avatar-gen-loading">
              <span className="streaming-dot" />
              <span>{uploading ? "Uploading image..." : "Generating via NVIDIA NIM — Stable Diffusion 3 Medium"}</span>
            </div>
          )}
          {avatarUrl && !generatingAvatar && !uploading && (
            <div className="avatar-gen-preview">
              <img src={avatarUrl} alt="Avatar" style={{ cursor: "pointer" }} onClick={() => setAvatarModal(avatarUrl)} />
            </div>
          )}
        </div>

        {error && <div className="dice-error">{error}</div>}

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
//  CHARACTER SWITCHER (reusable "posting as" pill)
// ══════════════════════════════════════

function CharacterSwitcher({ characters, selectedCharId, onSelect }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const selected = characters.find((c) => c.id === selectedCharId) || characters[0];

  useEffect(() => {
    if (!open) return;
    function handleClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (!selected || characters.length < 2) {
    // Only one character — show as static pill, no dropdown
    return selected ? (
      <div className="char-switcher-pill">
        <span className="char-switcher-avatar">
          {selected.profile_image ? <img src={selected.profile_image} alt="" /> : selected.name.charAt(0).toUpperCase()}
        </span>
        <span className="char-switcher-name">{selected.name}</span>
      </div>
    ) : null;
  }

  return (
    <div className="char-switcher" ref={ref}>
      <button className="char-switcher-pill" onClick={() => setOpen(!open)}>
        <span className="char-switcher-avatar">
          {selected.profile_image ? <img src={selected.profile_image} alt="" /> : selected.name.charAt(0).toUpperCase()}
        </span>
        <span className="char-switcher-name">{selected.name}</span>
        <span className="char-switcher-arrow">{open ? "\u25B4" : "\u25BE"}</span>
      </button>
      {open && (
        <div className="char-switcher-dropdown">
          {characters.map((c) => (
            <button
              key={c.id}
              className={`char-switcher-option ${c.id === selectedCharId ? "selected" : ""}`}
              onClick={() => { onSelect(c.id); setOpen(false); }}
            >
              <span className="char-switcher-avatar">
                {c.profile_image ? <img src={c.profile_image} alt="" /> : c.name.charAt(0).toUpperCase()}
              </span>
              <span>{c.name}</span>
              {c.id === selectedCharId && <span className="char-switcher-check">{"\u2713"}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════
//  OWNED CHARACTER PAGE (tabs: Posts / Profile)
// ══════════════════════════════════════

function OwnedCharacterPage({ character, account, characters, allIdentities, activeCharId, onUpdateChar, onDeleteChar, adminAccount, serverAdminPubkey, onDmRead }) {
  const [tab, setTab] = useState("posts"); // "posts" | "profile"
  const [postContent, setPostContent] = useState("");
  const [posting, setPosting] = useState(false);
  const [composeAsCharId, setComposeAsCharId] = useState(activeCharId || character.id);
  const composeIdentity = (allIdentities || characters).find((c) => c.id === composeAsCharId) || character;
  const composeAccount = composeIdentity ? accountFromSkHex(composeIdentity.skHex) : account;

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
    if (feedMode === "admin" && serverAdminPubkey) {
      feedSubRef.current = getPool().subscribeMany(
        ALL_RELAYS,
        { kinds: [1], authors: [serverAdminPubkey], limit: 50 },
        { onevent: (event) => addFeedNote(event), oneose: () => setFeedLoading(false) }
      );
    } else if (feedMode === "relay") {
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
  }, [feedMode, addFeedNote, serverAdminPubkey]);

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
    if (!postContent.trim() || !composeAccount) return;
    setPosting(true);
    try {
      const signed = await publishNote(postContent, composeAccount);
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
      }, adminAccount);
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
        <button className={tab === "dms" ? "active" : ""} onClick={() => setTab("dms")}>Messages</button>
        <button className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}>Profile</button>
      </div>

      {/* Posts tab */}
      {tab === "posts" && (
        <div>
          {/* Compose */}
          <div className="feed-compose">
            <div className="compose-box">
              <textarea
                placeholder={`What's on ${composeIdentity.name}'s mind?`}
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
                <CharacterSwitcher characters={allIdentities || characters} selectedCharId={composeAsCharId} onSelect={setComposeAsCharId} />
                <button className="btn-primary" disabled={posting || !postContent.trim()} onClick={handlePost}>
                  {posting ? "Posting..." : "Post"}
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
                {serverAdminPubkey && <button className={`feed-toggle-btn ${feedMode === "admin" ? "active" : ""}`} onClick={() => setFeedMode("admin")}>Admin</button>}
                <button className={`feed-toggle-btn ${feedMode === "global" ? "active" : ""}`} onClick={() => setFeedMode("global")}>Global Nostr</button>
              </div>
            </div>

            {feedLoading && feedNotes.length === 0 && <div className="loading">Loading...</div>}
            {!feedLoading && feedNotes.length === 0 && <div className="loading">{feedMode === "admin" ? "No posts from the admin yet." : "No posts yet."}</div>}

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
                      <span className="note-author clickable" onClick={() => setHash("profile/" + npubEncode(ev.pubkey))}>
                        {getFeedAuthorName(ev)}
                        {serverAdminPubkey && ev.pubkey === serverAdminPubkey && <span style={{ fontSize: "0.55rem", color: "var(--accent)", marginLeft: 6 }}>ADMIN</span>}
                        {ev.pubkey === adminAccount?.pk && <span style={{ fontSize: "0.55rem", color: "var(--accent)", marginLeft: 6 }}>YOU</span>}
                        {(characters || []).some((c) => c.pk === ev.pubkey) && <span style={{ fontSize: "0.55rem", color: "var(--accent)", marginLeft: 6 }}>YOU</span>}
                      </span>
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

      {/* DMs tab */}
      {tab === "dms" && (
        <DmInbox account={account} allIdentities={allIdentities || []} onRead={onDmRead} />
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
                  <div className="char-hero-avatar" style={{ cursor: profile?.picture ? "pointer" : undefined }} onClick={() => profile?.picture && setModalImage(profile.picture)}>
                    {profile?.picture ? (
                      <img src={profile.picture} alt="" />
                    ) : (
                      <div className="avatar-placeholder large">
                        {(profile?.display_name || profile?.name || character.name || "?").charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>
                  <h2 className="char-hero-name">{profile?.display_name || profile?.name || character.name} <span style={{ fontSize: "0.6rem", color: "var(--accent)", marginLeft: 8, verticalAlign: "middle" }}>YOU</span></h2>
                  <NpubBadge npub={character.npub} />
                  {profile?.about && <p className="char-hero-personality">{profile.about}</p>}
                  {profile?.website && (
                    <p className="char-hero-world">
                      <a href={profile.website.startsWith("http") ? profile.website : "https://" + profile.website} target="_blank" rel="noopener noreferrer">{profile.website}</a>
                    </p>
                  )}
                  {profile?.nip05 && <p className="char-hero-world">{profile.nip05}</p>}
                  {profile?.lud16 && <p className="char-hero-world">{profile.lud16}</p>}
                  <div className="char-hero-actions" style={{ flexDirection: "row", justifyContent: "center", marginTop: 12 }}>
                    <button className="btn-primary" onClick={startEditing}>Edit Profile</button>
                  </div>
                </div>
              </div>

              <KeysSection npub={character.npub} nsec={character.nsec} />

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
//  OWN PROFILE PAGE (admin/user account)
// ══════════════════════════════════════

function OwnProfilePage({ adminAccount, serverAdminPubkey, allIdentities, activeCharId, onUpdateProfile, onDmRead }) {
  const account = adminAccount;
  const [tab, setTab] = useState("posts");
  const [postContent, setPostContent] = useState("");
  const [posting, setPosting] = useState(false);
  const [composeAsId, setComposeAsId] = useState(activeCharId || "__admin__");
  const composeIdentity = (allIdentities || []).find((c) => c.id === composeAsId) || { skHex: account.skHex, name: account.profile_name || "You" };
  const composeAccount = accountFromSkHex(composeIdentity.skHex);
  const [myNotes, setMyNotes] = useState([]);
  const [myLoading, setMyLoading] = useState(true);
  const mySubRef = useRef(null);
  const [feedMode, setFeedMode] = useState("relay");
  const [feedNotes, setFeedNotes] = useState([]);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedProfiles, setFeedProfiles] = useState({});
  const feedSubRef = useRef(null);
  const feedProfileCache = useRef({});
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

  useEffect(() => {
    if (!dirty) return;
    function handleBeforeUnload(e) { e.preventDefault(); }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    setProfileLoading(true);
    fetchProfile(ALL_RELAYS, account.pk).then((p) => {
      setProfile(p || {});
      setProfileLoading(false);
    });
  }, [account.pk]);

  // Own posts
  useEffect(() => {
    setMyLoading(true);
    setMyNotes([]);
    if (mySubRef.current) mySubRef.current.close();
    mySubRef.current = getPool().subscribeMany(
      ALL_RELAYS,
      { kinds: [1], authors: [account.pk], limit: 30 },
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
  }, [account.pk]);

  // Feed
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
    if (feedMode === "admin" && serverAdminPubkey) {
      feedSubRef.current = getPool().subscribeMany(
        ALL_RELAYS,
        { kinds: [1], authors: [serverAdminPubkey], limit: 50 },
        { onevent: addFeedNote, oneose: () => setFeedLoading(false) }
      );
    } else if (feedMode === "relay") {
      feedSubRef.current = subscribeFeed(DEFAULT_RELAYS, addFeedNote, () => setFeedLoading(false), 50);
    } else {
      feedSubRef.current = subscribeGlobalFeed(ALL_RELAYS, addFeedNote, () => setFeedLoading(false), 50);
    }
    return () => { if (feedSubRef.current) feedSubRef.current.close(); };
  }, [feedMode, addFeedNote, serverAdminPubkey]);

  useEffect(() => {
    const unknownPubkeys = feedNotes.map((n) => n.pubkey).filter((pk) => pk !== account.pk && !feedProfileCache.current[pk]);
    if (unknownPubkeys.length === 0) return;
    const unique = [...new Set(unknownPubkeys)];
    unique.forEach((pk) => { feedProfileCache.current[pk] = true; });
    fetchProfiles(ALL_RELAYS, unique).then((fetched) => {
      for (const [pk, p] of Object.entries(fetched)) feedProfileCache.current[pk] = p;
      if (Object.keys(fetched).length > 0) setFeedProfiles((prev) => ({ ...prev, ...fetched }));
    });
  }, [feedNotes, account.pk]);

  function getFeedAuthorName(ev) {
    if (ev.pubkey === account.pk) return account.profile_name || shortPubkey(ev.pubkey);
    const p = feedProfiles[ev.pubkey];
    return p?.display_name || p?.name || shortPubkey(ev.pubkey);
  }
  function getFeedAuthorImage(ev) {
    if (ev.pubkey === account.pk) return account.profile_image || null;
    return feedProfiles[ev.pubkey]?.picture || null;
  }
  function isReply(ev) { return ev.tags?.some((t) => t[0] === "e"); }

  async function handlePost() {
    if (!postContent.trim() || !composeAccount) return;
    setPosting(true);
    try {
      const signed = await publishNote(postContent, composeAccount);
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
      name: profile?.name || profile?.display_name || account.profile_name || "",
      display_name: profile?.display_name || profile?.name || account.profile_name || "",
      about: profile?.about || account.profile_about || "",
      picture: profile?.picture || account.profile_image || "",
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
      setDirty(Object.keys(updated).some((k) => updated[k] !== originalFieldsRef.current[k]));
      return updated;
    });
  }

  async function handleGenerateAvatar() {
    setGeneratingAvatar(true);
    try {
      const result = await generateAvatar({
        name: editFields.display_name || editFields.name || "",
        personality: editFields.about || "",
        world: "",
      }, account);
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

      // Update local admin account data
      account.profile_name = editFields.display_name || editFields.name || "";
      account.profile_about = editFields.about || "";
      account.profile_image = editFields.picture || "";
      saveAdminAccount(account);
      if (onUpdateProfile) onUpdateProfile(account);

      setProfile({ ...profile, ...metadata });
      setEditing(false);
      setDirty(false);
      setSaved(true);
    } catch (e) {
      alert("Failed to save: " + e.message);
    }
    setSaving(false);
  }

  if (profileLoading) return <div className="loading">Loading profile...</div>;

  const displayName = profile?.display_name || profile?.name || account.profile_name || account.npub.slice(0, 12);
  const feedRootNotes = feedNotes.filter((n) => !isReply(n));

  return (
    <div>
      <div className="feed-tabs">
        <button className={tab === "posts" ? "active" : ""} onClick={() => setTab("posts")}>Posts</button>
        <button className={tab === "dms" ? "active" : ""} onClick={() => setTab("dms")}>Messages</button>
        <button className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}>Profile</button>
      </div>

      {tab === "posts" && (
        <div>
          <div className="feed-compose">
            <div className="compose-box">
              <textarea
                placeholder={`What's on your mind?`}
                value={postContent}
                onChange={(e) => setPostContent(e.target.value)}
                rows={3}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handlePost(); }
                }}
              />
              <div className="compose-footer">
                <CharacterSwitcher characters={allIdentities || []} selectedCharId={composeAsId} onSelect={setComposeAsId} />
                <button className="btn-primary" disabled={posting || !postContent.trim()} onClick={handlePost}>
                  {posting ? "Posting..." : "Post"}
                </button>
              </div>
            </div>
          </div>

          <div className="profile-feed">
            <h3>Your Posts</h3>
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

          <div className="feed-section">
            <div className="feed-section-header">
              <h3>Feed</h3>
              <div className="feed-toggle">
                <button className={`feed-toggle-btn ${feedMode === "relay" ? "active" : ""}`} onClick={() => setFeedMode("relay")}>Our Relay</button>
                {serverAdminPubkey && <button className={`feed-toggle-btn ${feedMode === "admin" ? "active" : ""}`} onClick={() => setFeedMode("admin")}>Admin</button>}
                <button className={`feed-toggle-btn ${feedMode === "global" ? "active" : ""}`} onClick={() => setFeedMode("global")}>Global Nostr</button>
              </div>
            </div>
            {feedLoading && feedNotes.length === 0 && <div className="loading">Loading...</div>}
            {!feedLoading && feedNotes.length === 0 && <div className="loading">{feedMode === "admin" ? "No posts from the admin yet." : "No posts yet."}</div>}
            <div className="notes-list">
              {feedRootNotes.map((ev) => (
                <div key={ev.id} className="note-card">
                  <div className="note-header">
                    <div className="note-avatar clickable" onClick={() => setHash("profile/" + npubEncode(ev.pubkey))}>
                      {getFeedAuthorImage(ev) ? (
                        <img src={getFeedAuthorImage(ev)} alt="" style={{ width: 32, height: 32, borderRadius: 2, objectFit: "cover" }} />
                      ) : (
                        <div className="avatar-placeholder">{getFeedAuthorName(ev).charAt(0).toUpperCase()}</div>
                      )}
                    </div>
                    <div className="note-meta">
                      <span className="note-author clickable" onClick={() => setHash("profile/" + npubEncode(ev.pubkey))}>
                        {getFeedAuthorName(ev)}
                        {serverAdminPubkey && ev.pubkey === serverAdminPubkey && ev.pubkey !== account.pk && <span style={{ fontSize: "0.55rem", color: "var(--accent)", marginLeft: 6 }}>ADMIN</span>}
                        {ev.pubkey === account.pk && <span style={{ fontSize: "0.55rem", color: "var(--accent)", marginLeft: 6 }}>YOU</span>}
                      </span>
                      <span className="note-time">{formatTime(ev.created_at)}</span>
                    </div>
                  </div>
                  <div className="note-content clickable" onClick={() => setHash("thread/" + ev.id)}>{ev.content}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "dms" && (
        <DmInbox account={account} allIdentities={allIdentities || []} onRead={onDmRead} />
      )}

      {tab === "profile" && !editing && (
        <div className="edit-section">
          <div className="char-hero">
            {profile?.banner && <div className="char-hero-banner"><img src={profile.banner} alt="" /></div>}
            <div className="char-hero-content">
              <div className="char-hero-avatar" style={{ cursor: (profile?.picture || account.profile_image) ? "pointer" : undefined }} onClick={() => (profile?.picture || account.profile_image) && setModalImage(profile?.picture || account.profile_image)}>
                {(profile?.picture || account.profile_image) ? (
                  <img src={profile?.picture || account.profile_image} alt="" />
                ) : (
                  <div className="avatar-placeholder large">
                    {displayName.charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
              <h2 className="char-hero-name">{displayName} <span style={{ fontSize: "0.6rem", color: "var(--accent)", marginLeft: 8, verticalAlign: "middle" }}>YOU</span></h2>
              <NpubBadge npub={account.npub} />
              {(profile?.about || account.profile_about) && <p className="char-hero-personality">{profile?.about || account.profile_about}</p>}
              {profile?.website && (
                <p className="char-hero-world">
                  <a href={profile.website.startsWith("http") ? profile.website : "https://" + profile.website} target="_blank" rel="noopener noreferrer">{profile.website}</a>
                </p>
              )}
              {profile?.nip05 && <p className="char-hero-world">{profile.nip05}</p>}
              {profile?.lud16 && <p className="char-hero-world">{profile.lud16}</p>}
              <div className="char-hero-actions" style={{ flexDirection: "row", justifyContent: "center", marginTop: 12 }}>
                <button className="btn-primary" onClick={startEditing}>Edit Profile</button>
              </div>
            </div>
          </div>
          {saved && <p className="success" style={{ marginTop: 12 }}>Profile saved to Nostr!</p>}
        </div>
      )}

      {tab === "profile" && editing && (
        <div className="edit-section">
          <h3>Edit Profile (NIP-01)</h3>
          <p style={{ color: "var(--text-faint)", fontSize: "0.75rem", marginBottom: 16 }}>
            These fields are saved to Nostr as a kind:0 metadata event. Other Nostr clients will display this profile.
          </p>
          <div className="edit-form">
            <label><span>Display Name</span>
              <input type="text" value={editFields.display_name} onChange={(e) => { updateField("display_name", e.target.value); updateField("name", e.target.value); }} placeholder="Your display name" /></label>
            <label><span>About</span>
              <textarea value={editFields.about} onChange={(e) => updateField("about", e.target.value)} rows={4} placeholder="A short bio..." /></label>
            <label>
              <div className="avatar-gen-header">
                <span>Picture URL</span>
                {isNimAvailable() && (
                  <button type="button" className="btn-small" onClick={handleGenerateAvatar} disabled={generatingAvatar} style={{ marginLeft: "auto" }}>
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
      <ImageModal src={modalImage} onClose={() => setModalImage(null)} />
    </div>
  );
}

// ══════════════════════════════════════
//  EXTERNAL PROFILE VIEW (not owned)
// ══════════════════════════════════════

function ExternalProfileView({ pubkey, activeAccount, serverAdminPubkey }) {
  const [profile, setProfile] = useState(null);
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalImage, setModalImage] = useState(null);
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
          <div className="char-hero-avatar" style={{ cursor: profile?.picture ? "pointer" : undefined }} onClick={() => profile?.picture && setModalImage(profile.picture)}>
            {profile?.picture ? (
              <img src={profile.picture} alt="" />
            ) : (
              <div className="avatar-placeholder large">{name.charAt(0).toUpperCase()}</div>
            )}
          </div>
          <h2 className="char-hero-name">
            {name}
            {serverAdminPubkey && pubkey === serverAdminPubkey && (
              <span style={{ fontSize: "0.6rem", color: "var(--accent)", marginLeft: 8, verticalAlign: "middle" }}>ADMIN</span>
            )}
          </h2>
          <NpubBadge npub={npub} />
          {about && <p className="char-hero-personality">{about}</p>}
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
//  DM INBOX (conversation list for an identity)
// ══════════════════════════════════════

function DmInbox({ account, allIdentities = [], onRead }) {
  const [conversations, setConversations] = useState({});
  const [profiles, setProfiles] = useState({});
  const [loading, setLoading] = useState(true);
  const subRef = useRef(null);
  const profileCache = useRef({});

  function getConvoLastSeen(otherPk) {
    try { return parseInt(localStorage.getItem(`npc_dm_convo_${account?.pk}_${otherPk}`) || "0", 10); } catch { return 0; }
  }
  function markConvoRead(otherPk) {
    localStorage.setItem(`npc_dm_convo_${account?.pk}_${otherPk}`, String(Math.floor(Date.now() / 1000)));
  }
  function isConvoUnread(otherPk, latestTs) {
    return latestTs > getConvoLastSeen(otherPk);
  }

  useEffect(() => {
    // Mark identity-level DMs as read
    localStorage.setItem(`npc_dm_seen_${account?.pk}`, String(Math.floor(Date.now() / 1000)));
    if (onRead) onRead(account?.pk);
  }, [account?.pk]);

  useEffect(() => {
    if (!account) return;
    setLoading(true);
    setConversations({});
    if (subRef.current) subRef.current.close();

    const convos = {};
    async function processEvent(event) {
      try {
        const isSent = event.pubkey === account.pk;
        const otherPk = isSent ? event.tags.find((t) => t[0] === "p")?.[1] : event.pubkey;
        if (!otherPk) return;
        const { plaintext } = await decryptDM(event, account);
        const msg = { id: event.id, content: plaintext, created_at: event.created_at, isSent };
        if (!convos[otherPk]) convos[otherPk] = { messages: [], latest: 0 };
        if (convos[otherPk].messages.find((m) => m.id === msg.id)) return;
        convos[otherPk].messages.push(msg);
        if (msg.created_at > convos[otherPk].latest) convos[otherPk].latest = msg.created_at;
        setConversations({ ...convos });
      } catch {}
    }

    subRef.current = subscribeDMs(DEFAULT_RELAYS, account.pk, processEvent, () => setLoading(false));
    return () => { if (subRef.current) subRef.current.close(); };
  }, [account?.pk]);

  // Fetch profiles for conversation partners
  useEffect(() => {
    const pks = Object.keys(conversations).filter((pk) => !profileCache.current[pk]);
    if (pks.length === 0) return;
    pks.forEach((pk) => { profileCache.current[pk] = true; });
    fetchProfiles(ALL_RELAYS, pks).then((fetched) => {
      for (const [pk, p] of Object.entries(fetched)) profileCache.current[pk] = p;
      if (Object.keys(fetched).length > 0) setProfiles((prev) => ({ ...prev, ...fetched }));
    });
  }, [conversations]);

  const sorted = Object.entries(conversations).sort((a, b) => b[1].latest - a[1].latest);

  const otherIdentities = allIdentities.filter((c) => c.pk !== account.pk);

  if (loading && sorted.length === 0) return (
    <div>
      {otherIdentities.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: "0.68rem", fontWeight: 600, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "1.5px", marginBottom: 8 }}>Your Identities</div>
          <div className="notes-list">
            {otherIdentities.map((c) => (
              <div key={c.id} className="note-card clickable" onClick={() => setHash("messages/" + c.npub)}>
                <div className="note-header">
                  <div className="note-avatar">
                    {c.profile_image ? <img src={c.profile_image} alt="" style={{ width: 32, height: 32, borderRadius: 2, objectFit: "cover" }} /> : <div className="avatar-placeholder">{(c.name || "?").charAt(0).toUpperCase()}</div>}
                  </div>
                  <div className="note-meta"><span className="note-author">{c.name}</span></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="loading">Loading messages...</div>
    </div>
  );

  return (
    <div>
      {otherIdentities.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: "0.68rem", fontWeight: 600, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "1.5px", marginBottom: 8 }}>Your Identities</div>
          <div className="notes-list">
            {otherIdentities.map((c) => {
              const existing = conversations[c.pk];
              const lastMsg = existing?.messages?.sort((a, b) => b.created_at - a.created_at)[0];
              const unread = lastMsg && !lastMsg.isSent && isConvoUnread(c.pk, lastMsg.created_at);
              return (
                <div key={c.id} className={`note-card clickable${unread ? " note-unread" : ""}`} onClick={() => { markConvoRead(c.pk); setHash("messages/" + c.npub); }}>
                  <div className="note-header">
                    <div className="note-avatar">
                      {c.profile_image ? <img src={c.profile_image} alt="" style={{ width: 32, height: 32, borderRadius: 2, objectFit: "cover" }} /> : <div className="avatar-placeholder">{(c.name || "?").charAt(0).toUpperCase()}</div>}
                    </div>
                    <div className="note-meta">
                      <span className="note-author">{c.name}{unread && <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", marginLeft: 6, verticalAlign: "middle" }} />}</span>
                      {lastMsg && <span className="note-time">{formatTime(lastMsg.created_at)}</span>}
                    </div>
                  </div>
                  {lastMsg && (
                    <div className="note-content" style={{ color: unread ? "var(--text)" : "var(--text-dim)", fontSize: "0.82rem", fontWeight: unread ? 600 : 400 }}>
                      {lastMsg.isSent && <span style={{ color: "var(--text-faint)" }}>You: </span>}
                      {lastMsg.content.slice(0, 80)}{lastMsg.content.length > 80 ? "..." : ""}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {sorted.length === 0 && !loading && otherIdentities.length === 0 && <div className="loading">No messages yet.</div>}

      {sorted.filter(([pk]) => !allIdentities.some((c) => c.pk === pk)).length > 0 && (
        <div>
          <div style={{ fontSize: "0.68rem", fontWeight: 600, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "1.5px", marginBottom: 8 }}>Conversations</div>
          <div className="notes-list">
      {sorted.filter(([pk]) => !allIdentities.some((c) => c.pk === pk)).map(([pk, convo]) => {
        const p = profiles[pk] || profileCache.current[pk];
        const name = (typeof p === "object" && p) ? (p.display_name || p.name || shortPubkey(pk)) : shortPubkey(pk);
        const picture = (typeof p === "object" && p) ? p.picture : null;
        const lastMsg = convo.messages.sort((a, b) => b.created_at - a.created_at)[0];
        const unread = lastMsg && !lastMsg.isSent && isConvoUnread(pk, lastMsg.created_at);
        return (
          <div key={pk} className={`note-card clickable${unread ? " note-unread" : ""}`} onClick={() => { markConvoRead(pk); setHash("messages/" + npubEncode(pk)); }}>
            <div className="note-header">
              <div className="note-avatar">
                {picture ? (
                  <img src={picture} alt="" style={{ width: 32, height: 32, borderRadius: 2, objectFit: "cover" }} />
                ) : (
                  <div className="avatar-placeholder">{name.charAt(0).toUpperCase()}</div>
                )}
              </div>
              <div className="note-meta">
                <span className="note-author">{name}{unread && <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", marginLeft: 6, verticalAlign: "middle" }} />}</span>
                <span className="note-time">{formatTime(lastMsg.created_at)}</span>
              </div>
            </div>
            <div className="note-content" style={{ color: unread ? "var(--text)" : "var(--text-dim)", fontSize: "0.82rem", fontWeight: unread ? 600 : 400 }}>
              {lastMsg.isSent && <span style={{ color: "var(--text-faint)" }}>You: </span>}
              {lastMsg.content.slice(0, 100)}{lastMsg.content.length > 100 ? "..." : ""}
            </div>
            <div style={{ fontSize: "0.7rem", color: "var(--text-faint)", marginTop: 4 }}>
              {convo.messages.length} message{convo.messages.length === 1 ? "" : "s"}
            </div>
          </div>
        );
      })}
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════
//  THREAD VIEW
// ══════════════════════════════════════

function ThreadView({ eventId, account, allIdentities = [], activeCharId }) {
  const [rootEvent, setRootEvent] = useState(null);
  const [replies, setReplies] = useState([]);
  const [profiles, setProfiles] = useState({});
  const [loading, setLoading] = useState(true);
  const [replyContent, setReplyContent] = useState("");
  const [posting, setPosting] = useState(false);
  const subRef = useRef(null);
  const profileCache = useRef({});

  // Identity switcher for replies
  const [replyAsCharId, setReplyAsCharId] = useState(activeCharId || allIdentities[0]?.id || null);
  const replyIdentity = allIdentities.find((c) => c.id === replyAsCharId) || allIdentities[0];
  const replyAccount = replyIdentity ? accountFromSkHex(replyIdentity.skHex) : account;

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
    const own = allIdentities.find((c) => c.pk === ev.pubkey);
    if (own) return own.name;
    const p = profiles[ev.pubkey];
    return p?.display_name || p?.name || shortPubkey(ev.pubkey);
  }
  function getInitial(ev) { return getName(ev).charAt(0).toUpperCase(); }
  function getAuthorImage(ev) {
    const own = allIdentities.find((c) => c.pk === ev.pubkey);
    if (own?.profile_image) return own.profile_image;
    const p = profiles[ev.pubkey];
    return p?.picture || null;
  }

  async function handleReply() {
    if (!replyContent.trim() || !replyAccount || !rootEvent) return;
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
      }, replyAccount);
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
      {account && rootEvent && allIdentities.length > 0 && (
        <div className="thread-reply-compose">
          <textarea placeholder="Write a reply..." value={replyContent} onChange={(e) => setReplyContent(e.target.value)} rows={3}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleReply(); } }} />
          <div className="compose-footer">
            <CharacterSwitcher characters={allIdentities} selectedCharId={replyAsCharId} onSelect={setReplyAsCharId} />
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

function MessageView({ recipientPubkey, account, allIdentities = [], activeCharId }) {
  const [recipientName, setRecipientName] = useState("");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const subRef = useRef(null);
  const messagesEndRef = useRef(null);

  // Identity switcher for DMs
  const [dmAsCharId, setDmAsCharId] = useState(activeCharId || allIdentities[0]?.id || null);
  const dmIdentity = allIdentities.find((c) => c.id === dmAsCharId) || allIdentities[0];
  const dmAccount = dmIdentity ? accountFromSkHex(dmIdentity.skHex) : account;

  useEffect(() => {
    if (!recipientPubkey) return;
    fetchProfile(ALL_RELAYS, recipientPubkey).then((profile) => {
      setRecipientName(profile ? (profile.display_name || profile.name || shortPubkey(recipientPubkey)) : shortPubkey(recipientPubkey));
    });
  }, [recipientPubkey]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);

  // Re-subscribe when character changes
  useEffect(() => {
    if (!dmAccount) return;
    setLoading(true);
    setMessages([]);
    const processEvent = async (event) => {
      const { plaintext } = await decryptDM(event, dmAccount);
      setMessages((prev) => {
        if (prev.find((m) => m.id === event.id)) return prev;
        return [...prev, { ...event, _decrypted: plaintext }].sort((a, b) => a.created_at - b.created_at);
      });
    };
    subRef.current = subscribeDMs(DEFAULT_RELAYS, dmAccount.pk, processEvent, () => setLoading(false));
    return () => { if (subRef.current) subRef.current.close(); };
  }, [dmAccount?.pk]);

  async function handleSend() {
    if (!input.trim() || !dmAccount) return;
    setSending(true);
    try { await sendDM(input, recipientPubkey, dmAccount); setInput(""); }
    catch (e) { alert("Failed to send: " + e.message); }
    setSending(false);
  }

  const filtered = messages.filter((m) => {
    const otherPk = m.pubkey === dmAccount?.pk ? m.tags.find((t) => t[0] === "p")?.[1] : m.pubkey;
    return otherPk === recipientPubkey;
  });

  if (!dmAccount && characters.length === 0) {
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
        <div className="conversation-contact clickable" onClick={() => setHash("profile/" + npubEncode(recipientPubkey))} style={{ cursor: "pointer" }}>
          <div className="avatar-placeholder" style={{ width: 32, height: 32, fontSize: "0.8rem" }}>
            {(recipientName || "?").charAt(0).toUpperCase()}
          </div>
          <span className="conversation-name">{recipientName}</span>
        </div>
      </div>
      <div className="conversation-messages">
        {loading && filtered.length === 0 && <div className="loading">Connecting...</div>}
        {!loading && filtered.length === 0 && <div className="loading">Say hello to {recipientName}!</div>}
        {filtered.map((msg) => {
          const isSent = msg.pubkey === dmAccount?.pk;
          return (
            <div key={msg.id} className={`chat-bubble ${isSent ? "sent" : "received"}`}>
              {!isSent && (
                <div className="chat-sender clickable" onClick={() => setHash("profile/" + npubEncode(msg.pubkey))} style={{ fontSize: "0.68rem", color: "var(--accent)", fontWeight: 600, marginBottom: 2, cursor: "pointer" }}>
                  {recipientName}
                </div>
              )}
              <div className="chat-text">{msg._decrypted}</div>
              <div className="chat-time">{formatTime(msg.created_at)}</div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>
      <div className="conversation-compose">
        {allIdentities.length > 1 && (
          <CharacterSwitcher characters={allIdentities} selectedCharId={dmAsCharId} onSelect={setDmAsCharId} />
        )}
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
//  PI AGENT CHAT
// ══════════════════════════════════════

const PI_URL = import.meta.env.VITE_PI_URL || "";

function PiChat({ allIdentities, activeCharId, adminAccount }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [connError, setConnError] = useState(null);
  const [streaming, setStreaming] = useState(false);
  const [piState, setPiState] = useState(null);
  const [availableModels, setAvailableModels] = useState([]);
  const [modelMeta, setModelMeta] = useState({});
  const [commands, setCommands] = useState([]);
  const [showCommands, setShowCommands] = useState(false);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [sessionStats, setSessionStats] = useState(null);
  const [toast, setToast] = useState(null);
  const [compacting, setCompacting] = useState(false);
  const [lastUsage, setLastUsage] = useState(null);
  const inputRef = useRef(null);
  const paletteRef = useRef(null);

  function showToast(message, type = "info", duration = 3000) {
    setToast({ message, type });
    setTimeout(() => setToast(null), duration);
  }
  const wsRef = useRef(null);
  const messagesEndRef = useRef(null);
  const currentTextRef = useRef("");
  const currentThinkingRef = useRef("");

  // Fetch model metadata from bridge HTTP endpoint
  useEffect(() => {
    if (!PI_URL) return;
    if (!adminAccount) return;
    const httpUrl = PI_URL.replace("ws://", "http://").replace("wss://", "https://");
    const metaUrl = `${httpUrl}/models-meta`;
    getAuthHeaders(metaUrl, "GET", adminAccount).then((headers) => {
      fetch(metaUrl, { headers }).then((r) => r.json()).then(setModelMeta).catch(() => {});
    });
  }, []);

  const activeIdentity = (allIdentities || []).find((c) => c.id === activeCharId) || allIdentities?.[0];
  const sessionId = activeIdentity ? activeIdentity.pk.slice(0, 16) : "default";

  // Connect WebSocket
  useEffect(() => {
    if (!PI_URL || !adminAccount) return;
    const pubkey = activeIdentity?.pk || "";
    const url = `${PI_URL}/ws?session=${sessionId}&pubkey=${pubkey}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    setConnError(null);

    ws.onopen = async () => {
      console.log("[pi] Connected, authenticating...");
      // Send auth as first message
      const authEvent = await createAuthEvent(url, "GET", adminAccount);
      ws.send(JSON.stringify({ type: "auth", event: authEvent }));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "error" && !connected) {
          setConnError(msg.error);
          return;
        }
        handlePiEvent(msg);
      } catch {}
    };

    ws.onclose = (e) => {
      setConnected(false);
      if (e.code === 1008) setConnError("Unauthorized — your key is not whitelisted. Ask the admin to add your npub.");
      console.log("[pi] Disconnected");
    };

    ws.onerror = () => setConnected(false);

    return () => { ws.close(); };
  }, [sessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handlePiEvent(msg) {
    // Auth OK — now request state/models/commands
    if (msg.type === "auth_ok") {
      setConnected(true);
      console.log("[pi] Authenticated");
      if (wsRef.current) {
        wsRef.current.send(JSON.stringify({ type: "get_available_models" }));
        wsRef.current.send(JSON.stringify({ type: "get_commands" }));
        wsRef.current.send(JSON.stringify({ type: "get_session_stats" }));
      }
      return;
    }

    // Response to get_state
    if (msg.type === "response" && msg.command === "get_state" && msg.success) {
      setPiState(msg.data);
      return;
    }

    // Response to get_available_models
    if (msg.type === "response" && msg.command === "get_available_models" && msg.success) {
      setAvailableModels(msg.data?.models || []);
      return;
    }

    // Response to model/thinking changes — refresh state
    if (msg.type === "response" && (msg.command === "set_model" || msg.command === "cycle_model" || msg.command === "cycle_thinking_level") && msg.success) {
      if (wsRef.current) wsRef.current.send(JSON.stringify({ type: "get_state" }));
      return;
    }

    // Response to get_commands
    if (msg.type === "response" && msg.command === "get_commands" && msg.success) {
      setCommands(msg.data?.commands || []);
      return;
    }

    // Response to get_session_stats
    if (msg.type === "response" && msg.command === "get_session_stats" && msg.success) {
      setSessionStats(msg.data);
      return;
    }

    // Response to new_session
    if (msg.type === "response" && msg.command === "new_session" && msg.success) {
      setMessages([]);
      setSessionStats(null);
      if (wsRef.current) {
        wsRef.current.send(JSON.stringify({ type: "get_state" }));
        wsRef.current.send(JSON.stringify({ type: "get_session_stats" }));
      }
      return;
    }

    // Response to compact
    if (msg.type === "response" && msg.command === "compact" && msg.success) {
      if (wsRef.current) wsRef.current.send(JSON.stringify({ type: "get_session_stats" }));
      return;
    }

    // Response to set_thinking_level
    if (msg.type === "response" && msg.command === "set_thinking_level" && msg.success) {
      // Refresh state to get updated thinking level
      if (wsRef.current) wsRef.current.send(JSON.stringify({ type: "get_state" }));
      return;
    }

    // Agent lifecycle
    if (msg.type === "agent_start") {
      setStreaming(true);
      currentTextRef.current = "";
      currentThinkingRef.current = "";
    }

    if (msg.type === "agent_end") {
      setStreaming(false);
      setMessages((prev) => prev.map((m) => ({ ...m, streaming: false })));
      if (wsRef.current) wsRef.current.send(JSON.stringify({ type: "get_session_stats" }));
    }

    // Assistant message events
    if (msg.type === "message_update" && msg.assistantMessageEvent) {
      const ev = msg.assistantMessageEvent;

      if (ev.type === "text_delta") {
        currentTextRef.current += ev.delta;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && last.streaming) {
            return [...prev.slice(0, -1), { ...last, content: currentTextRef.current }];
          }
          return [...prev, { role: "assistant", content: currentTextRef.current, thinking: currentThinkingRef.current, streaming: true }];
        });
      }

      if (ev.type === "thinking_delta") {
        currentThinkingRef.current += ev.delta;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && last.streaming) {
            return [...prev.slice(0, -1), { ...last, thinking: currentThinkingRef.current }];
          }
          return [...prev, { role: "assistant", content: "", thinking: currentThinkingRef.current, streaming: true }];
        });
      }

      // Capture usage from done event
      if (ev.type === "done" && ev.message?.usage) {
        setLastUsage(ev.message.usage);
      }
    }

    // Tool execution — rich display
    if (msg.type === "tool_execution_start") {
      setMessages((prev) => [...prev, {
        role: "tool",
        tool: msg.toolName || "unknown",
        toolCallId: msg.toolCallId,
        args: msg.args || {},
        content: "",
        streaming: true,
        isError: false,
      }]);
    }

    if (msg.type === "tool_execution_update") {
      // Partial output (e.g., bash streaming)
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "tool" && last.toolCallId === msg.toolCallId) {
          return [...prev.slice(0, -1), { ...last, content: msg.partialResult?.output || last.content }];
        }
        return prev;
      });
    }

    if (msg.type === "tool_execution_end") {
      const resultText = msg.result?.content?.map((c) => c.text || "").join("") || JSON.stringify(msg.result || "");
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "tool" && last.toolCallId === msg.toolCallId) {
          return [...prev.slice(0, -1), { ...last, content: resultText, streaming: false, isError: !!msg.isError }];
        }
        return prev;
      });
    }

    // Auto-compaction
    if (msg.type === "auto_compaction_start") {
      setCompacting(true);
      setMessages((prev) => [...prev, { role: "system", content: `Context compacting (${msg.reason})...`, streaming: true }]);
    }

    if (msg.type === "auto_compaction_end") {
      setCompacting(false);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "system" && last.streaming) {
          const text = msg.aborted ? "Compaction aborted" : `Compacted: ${msg.result?.tokensBefore || "?"} tokens reduced`;
          return [...prev.slice(0, -1), { ...last, content: text, streaming: false }];
        }
        return prev;
      });
      if (wsRef.current) wsRef.current.send(JSON.stringify({ type: "get_session_stats" }));
    }

    // Auto-retry
    if (msg.type === "auto_retry_start") {
      setMessages((prev) => [...prev, { role: "system", content: `Retrying (attempt ${msg.attempt}/${msg.maxAttempts}): ${msg.errorMessage}`, streaming: true }]);
    }

    if (msg.type === "auto_retry_end") {
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "system" && last.streaming) {
          const text = msg.success ? "Retry succeeded" : `Retry failed: ${msg.finalError || "unknown"}`;
          return [...prev.slice(0, -1), { ...last, content: text, streaming: false }];
        }
        return prev;
      });
    }

    // Extension UI requests
    if (msg.type === "extension_ui_request") {
      if (msg.method === "notify") {
        showToast(msg.message, msg.notifyType === "error" ? "warn" : "info");
      }
    }

    // Extension errors
    if (msg.type === "extension_error") {
      showToast(`Extension error: ${msg.error}`, "warn");
    }

    // Turn end
    if (msg.type === "turn_end") {
      // Agent may continue with more turns after tool use
    }
  }

  function handleSend() {
    if (!input.trim() || !wsRef.current || !connected) return;
    const text = input.trim();

    // Check if input matches an RPC command (e.g., "/new", "/compact")
    if (text.startsWith("/")) {
      const cmdName = text.slice(1).split(" ")[0].toLowerCase();
      const cmd = allCommands.find((c) => c.name.toLowerCase() === cmdName);
      if (cmd && (cmd.kind === "rpc" || cmd.kind === "submenu")) {
        executeCommand(cmd);
        setInput("");
        return;
      }
    }

    setMessages((prev) => [...prev, { role: "user", content: text }]);
    wsRef.current.send(JSON.stringify({ type: "prompt", message: text }));
    setInput("");
  }

  function handleAbort() {
    if (wsRef.current && connected) {
      wsRef.current.send(JSON.stringify({ type: "abort" }));
    }
  }

  function handleSetModel(provider, modelId) {
    if (wsRef.current && connected) {
      wsRef.current.send(JSON.stringify({ type: "set_model", provider, modelId }));
    }
  }

  function sendCommand(type, extra = {}) {
    if (wsRef.current && connected) {
      wsRef.current.send(JSON.stringify({ type, ...extra }));
    }
    setShowCommands(false);
  }

  // Command system: RPC commands execute directly, prompt commands go through input
  const [cmdSubmenu, setCmdSubmenu] = useState(null); // null or "model" or "thinking"
  const [submenuFilter, setSubmenuFilter] = useState("");

  const currentModelKey = piState?.model ? `${piState.model.provider}::${piState.model.id}` : "";
  const thinkingLevels = ["off", "minimal", "low", "medium", "high"];

  const allCommands = useMemo(() => {
    const rpc = [
      { name: "model", kind: "submenu", description: `Switch model (${piState?.model?.name || "—"})`, submenu: "model" },
      { name: "thinking", kind: "submenu", description: `Set thinking (${piState?.thinkingLevel || "off"})`, submenu: "thinking" },
      { name: "new", kind: "rpc", description: "Start a new session", rpcType: "new_session" },
      { name: "compact", kind: "rpc", description: "Compress context", rpcType: "compact" },
      { name: "abort", kind: "rpc", description: "Stop current generation", rpcType: "abort" },
    ];
    const custom = commands.map((c) => ({
      name: c.name,
      kind: "prompt",
      description: c.description || `[${c.source}]`,
    }));
    return [...rpc, ...custom];
  }, [piState, commands]);

  function executeCommand(cmd) {
    if (cmd.kind === "submenu") {
      setShowCommands(true);
      setCmdSubmenu(cmd.submenu);
      setSubmenuFilter("");
      setCmdIndex(0);
      return;
    }
    if (cmd.kind === "rpc") {
      if (wsRef.current && connected) {
        wsRef.current.send(JSON.stringify({ type: cmd.rpcType, ...(cmd.rpcExtra || {}) }));
      }
      showToast(`/${cmd.name} executed`);
      setInput("");
      setShowCommands(false);
      setCmdSubmenu(null);
      return;
    }
    if (cmd.kind === "prompt") {
      setInput("/" + cmd.name + " ");
      setShowCommands(false);
      setCmdSubmenu(null);
      inputRef.current?.focus();
      return;
    }
  }

  function selectModel(provider, modelId, name) {
    sendCommand("set_model", { provider, modelId });
    setInput("");
    setCmdSubmenu(null);
  }

  function selectThinking(level) {
    if (level !== "off" && piState?.model && !piState.model.reasoning) {
      showToast(`Thinking is not supported by ${piState.model.name || piState.model.id}. Select a reasoning model like Kimi K2 Thinking.`, "warn");
      setCmdSubmenu(null);
      setShowCommands(false);
      return;
    }
    sendCommand("set_thinking_level", { level });
    setInput("");
    setCmdSubmenu(null);
  }

  // Find model size from available models
  const currentModelInfo = availableModels.find((m) =>
    piState?.model && `${m.provider}::${m.id}` === `${piState.model.provider}::${piState.model.id}`
  );

  return (
    <div>
      <h2 className="page-title">Pi Agent</h2>

      {!PI_URL && (
        <div className="loading">
          Pi Agent not configured. Set <code>VITE_PI_URL</code> in your .env file.
        </div>
      )}

      {PI_URL && (
        <div className="pi-chat-container">
          <div className="pi-chat-messages">
            {messages.length === 0 && (
              <div className="pi-welcome">
                {!connected && !connError && <div className="loading">Connecting to Pi Agent...</div>}
                {!connected && connError && (
                  <div className="loading" style={{ color: "var(--neon)" }}>
                    {connError}
                  </div>
                )}
                {connected && piState && (
                  <>
                    <div className="pi-welcome-title">Pi Agent Ready</div>
                    <div className="pi-welcome-info">
                      <div><strong>Model:</strong> {piState.model?.name || piState.model?.id || "—"}</div>
                      <div><strong>Session:</strong> {activeIdentity?.name || "default"}</div>
                      <div><strong>Tools:</strong> read, write, edit, bash</div>
                      {piState.model?.contextWindow && (
                        <div><strong>Context:</strong> {(piState.model.contextWindow / 1000).toFixed(0)}k tokens</div>
                      )}
                      {piState.model?.reasoning && <div><strong>Reasoning:</strong> enabled</div>}
                    </div>
                    <div className="pi-welcome-hint">Type a message or press / for commands</div>
                  </>
                )}
                {connected && !piState && <div className="loading">Loading agent state...</div>}
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`pi-chat-msg pi-chat-${msg.role} ${msg.isError ? "pi-chat-error" : ""}`}>
                <div className="pi-chat-msg-role">
                  {msg.role === "user" && (activeIdentity?.name || "You")}
                  {msg.role === "assistant" && "Pi Agent"}
                  {msg.role === "tool" && (
                    <span className="pi-tool-header">
                      <span className="pi-tool-icon">{msg.tool === "bash" ? "$" : msg.tool === "read" ? "R" : msg.tool === "write" ? "W" : msg.tool === "edit" ? "E" : "T"}</span>
                      {msg.tool}
                      {msg.args && Object.keys(msg.args).length > 0 && (
                        <span className="pi-tool-args">
                          {msg.tool === "bash" ? msg.args.command : msg.args.path || JSON.stringify(msg.args).slice(0, 60)}
                        </span>
                      )}
                    </span>
                  )}
                  {msg.role === "system" && "System"}
                </div>
                {msg.thinking && (
                  <details className="pi-chat-thinking" open={msg.streaming}>
                    <summary>Thinking{msg.streaming && <span className="streaming-dot" />}</summary>
                    <div className="pi-chat-thinking-content">{msg.thinking}</div>
                  </details>
                )}
                <div className="pi-chat-msg-content">
                  {msg.content}
                  {msg.streaming && <span className="streaming-dot" />}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div className="pi-status-bar">
            <span className={`pi-status-dot ${connected ? "connected" : ""}`} />
            <span className="pi-status-model">{piState?.model?.name || piState?.model?.id || "—"}</span>
            {(() => {
              const meta = piState?.model?.id ? modelMeta[piState.model.id] : null;
              const sizeB = meta?.activeParams || meta?.totalParams;
              return sizeB ? <span className="pi-status-tag">{sizeB >= 1000 ? `${(sizeB / 1000).toFixed(1)}T` : `${sizeB}B`}</span> : null;
            })()}
            {piState?.model?.contextWindow && (
              <span className="pi-status-dim">{(piState.model.contextWindow / 1000).toFixed(0)}k ctx</span>
            )}
            {piState?.thinkingLevel && piState.thinkingLevel !== "off" && (
              <span className="pi-status-tag">thinking: {piState.thinkingLevel}</span>
            )}
            {piState?.model?.reasoning && (
              <span className="pi-status-tag">reasoning</span>
            )}
            {compacting && <span className="pi-status-tag" style={{ borderColor: "var(--danger)" }}>compacting</span>}
            <span className="pi-status-ctx">
              {sessionStats && (
                <>
                  {sessionStats.totalMessages || 0} msgs
                  {sessionStats.tokens?.total ? ` · ${(sessionStats.tokens.total / 1000).toFixed(1)}k tok` : ""}
                  {sessionStats.cost > 0 ? ` · $${sessionStats.cost.toFixed(4)}` : ""}
                </>
              )}
            </span>
          </div>
          <div className="pi-chat-compose">
            {(() => {
              const query = input.startsWith("/") ? input.slice(1).trim().toLowerCase() : "";

              // Build the list to show based on current state
              let paletteItems = [];
              let paletteTitle = "Commands";

              if (showCommands && cmdSubmenu === "model") {
                paletteTitle = "Select Model" + (submenuFilter ? `: ${submenuFilter}` : "");
                const filter = submenuFilter.toLowerCase();
                paletteItems = availableModels
                  .filter((m) => !filter || (m.name || m.id).toLowerCase().startsWith(filter))
                  .map((m) => {
                    const meta = modelMeta[m.id];
                    const sizeB = meta?.activeParams || meta?.totalParams;
                    const sizeTag = sizeB ? (sizeB >= 1000 ? `${(sizeB / 1000).toFixed(1)}T` : `${sizeB}B`) : null;
                    return {
                      label: m.name || m.id,
                      sublabel: meta?.arch === "MoE" && meta?.totalParams !== meta?.activeParams
                        ? `${meta.totalParams}B total · ${meta.activeParams}B active`
                        : m.provider,
                      sizeTag,
                      active: `${m.provider}::${m.id}` === currentModelKey,
                      action: () => selectModel(m.provider, m.id, m.name),
                    };
                  });
              } else if (showCommands && cmdSubmenu === "thinking") {
                paletteTitle = "Thinking Level";
                paletteItems = thinkingLevels.map((l) => ({
                  label: l,
                  active: l === (piState?.thinkingLevel || "off"),
                  action: () => selectThinking(l),
                }));
              } else if (showCommands) {
                paletteItems = allCommands
                  .filter((c) => !query || c.name.toLowerCase().startsWith(query))
                  .map((c) => ({
                    label: "/" + c.name,
                    sublabel: c.description,
                    hasSubmenu: c.kind === "submenu",
                    action: () => executeCommand(c),
                  }));
              }

              return (
                <>
                <div className="pi-cmd-btn-wrap">
                  <button
                    className="pi-cmd-btn"
                    onClick={() => {
                      if (showCommands) { setShowCommands(false); setCmdSubmenu(null); }
                      else { setShowCommands(true); setCmdSubmenu(null); setCmdIndex(0); }
                      inputRef.current?.focus();
                    }}
                    title="Commands"
                  >/</button>
                  {showCommands && paletteItems.length > 0 && (
                    <div className="pi-cmd-palette" ref={paletteRef}>
                      <div className="pi-cmd-palette-title">
                        {cmdSubmenu && (
                          <button className="pi-cmd-back" onClick={() => { setCmdSubmenu(null); setCmdIndex(0); }}>&larr;</button>
                        )}
                        {paletteTitle}
                      </div>
                      {paletteItems.map((item, i) => (
                        <button
                          key={item.label}
                          className={`pi-cmd-item ${i === cmdIndex ? "pi-cmd-active" : ""} ${item.active ? "pi-cmd-current" : ""}`}
                          onClick={item.action}
                          onMouseEnter={() => setCmdIndex(i)}
                        >
                          <span className="pi-cmd-name">
                            {item.label}{item.active ? " \u2713" : ""}
                            {item.sizeTag && <span className="pi-size-tag">{item.sizeTag}</span>}
                          </span>
                          {item.sublabel && <span className="pi-cmd-desc">{item.sublabel}</span>}
                          {item.hasSubmenu && <span className="pi-cmd-arrow">&rarr;</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <input
                  ref={inputRef}
                  type="text"
                  placeholder={!connected ? (connError ? "Not connected" : "Connecting...")
                    : cmdSubmenu === "model" ? "Type to filter models... (Tab to select, Esc to cancel)"
                    : cmdSubmenu === "thinking" ? "Select thinking level..."
                    : `${piState?.model?.name || "Pi"} · ${piState?.messageCount || 0} msgs · / for commands`}
                  value={cmdSubmenu ? submenuFilter : input}
                  onChange={(e) => {
                    if (cmdSubmenu) {
                      // Typing filters the submenu
                      setSubmenuFilter(e.target.value);
                      setCmdIndex(0);
                    } else {
                      setInput(e.target.value);
                      if (e.target.value.startsWith("/")) {
                        setShowCommands(true);
                        setCmdSubmenu(null);
                        setCmdIndex(0);
                      } else if (!e.target.value) {
                        setShowCommands(false);
                      } else {
                        setShowCommands(false);
                      }
                    }
                  }}
                  onKeyDown={(e) => {
                    if (showCommands && paletteItems.length > 0) {
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setCmdIndex((prev) => {
                          const next = (prev - 1 + paletteItems.length) % paletteItems.length;
                          requestAnimationFrame(() => {
                            paletteRef.current?.querySelectorAll(".pi-cmd-item")[next]?.scrollIntoView({ block: "nearest" });
                          });
                          return next;
                        });
                        return;
                      }
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setCmdIndex((prev) => {
                          const next = (prev + 1) % paletteItems.length;
                          requestAnimationFrame(() => {
                            paletteRef.current?.querySelectorAll(".pi-cmd-item")[next]?.scrollIntoView({ block: "nearest" });
                          });
                          return next;
                        });
                        return;
                      }
                      if (e.key === "Tab" || (e.key === " " && !cmdSubmenu && input.startsWith("/")) || (e.key === "Tab" && cmdSubmenu)) {
                        // Tab: select item (in submenu: execute, in main: autocomplete)
                        e.preventDefault();
                        const item = paletteItems[cmdIndex];
                        if (item) {
                          if (cmdSubmenu) {
                            item.action();
                            setSubmenuFilter("");
                          } else {
                            const label = item.label?.startsWith("/") ? item.label : "/" + (item.label || "");
                            setInput(label + " ");
                            setShowCommands(false);
                            setCmdSubmenu(null);
                          }
                        }
                        return;
                      }
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const item = paletteItems[cmdIndex];
                        if (item) {
                          item.action();
                          if (cmdSubmenu) setSubmenuFilter("");
                        }
                        return;
                      }
                      if (e.key === "Escape") {
                        if (cmdSubmenu) { setCmdSubmenu(null); setSubmenuFilter(""); setCmdIndex(0); }
                        else { setShowCommands(false); }
                        return;
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  disabled={!connected}
                />
                </>
              );
            })()}
            {streaming ? (
              <button className="btn-send" onClick={handleAbort} style={{ background: "var(--danger)" }}>
                &#9632;
              </button>
            ) : (
              <button className="btn-send" onClick={handleSend} disabled={!connected || !input.trim()}>
                &#10148;
              </button>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className={`pi-toast ${toast.type === "warn" ? "pi-toast-warn" : ""}`}>{toast.message}</div>
      )}
    </div>
  );
}

// ══════════════════════════════════════
//  NETWORK PAGE (Directory sidebar + Graph)
// ══════════════════════════════════════

function NetworkPage({ characters = [], activeAccount }) {
  const [profiles, setProfiles] = useState({});
  const [follows, setFollows] = useState({}); // pk -> [followed pks]
  const [loading, setLoading] = useState(true);
  const [selectedPk, setSelectedPk] = useState(null);
  const [selectedPosts, setSelectedPosts] = useState([]);
  const [postsLoading, setPostsLoading] = useState(false);
  const [hoverNode, setHoverNode] = useState(null);
  const [hoverLink, setHoverLink] = useState(null);
  const [search, setSearch] = useState("");
  const [followingInProgress, setFollowingInProgress] = useState(false);
  const containerRef = useRef(null);
  const graphRef = useRef();
  const [dimensions, setDimensions] = useState({ width: 600, height: 500 });
  const imageCache = useRef({});

  // Configure forces to space out nodes
  useEffect(() => {
    if (graphRef.current) {
      // Use collide force to prevent overlapping
      // Radius matches node size (8 + followCount) + generous padding
      graphRef.current.d3Force("collide", forceCollide((node) => 16 + (node.followCount || 0)));
      // Weak repulsion only at short range (distanceMax)
      // This keeps things spread but stops pushing nodes once they are a bit apart
      graphRef.current.d3Force("charge", forceManyBody().strength(-50).distanceMax(80));
      // Significantly increase link distance to space out connected clusters
      graphRef.current.d3Force("link").distance(160);
      // Increase link strength to maintain structure
      graphRef.current.d3Force("link").strength(0.8);
    }
  }, [graphRef.current]);

  // Measure graph container
  useEffect(() => {
    function measure() {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setDimensions({ width: rect.width, height: Math.max(450, window.innerHeight - 200) });
      }
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Fetch profiles (kind:0) + follows (kind:3) together — both cheap
  useEffect(() => {
    const pool = getPool();
    const profileMap = {};
    const followMap = {};
    let eoseCount = 0;
    const checkDone = () => {
      eoseCount++;
      if (eoseCount >= 2) {
        setProfiles({ ...profileMap });
        setFollows({ ...followMap });
        setLoading(false);
      }
    };

    const sub0 = pool.subscribeMany(DEFAULT_RELAYS, { kinds: [0] }, {
      onevent: (ev) => {
        try {
          const meta = JSON.parse(ev.content);
          if (!profileMap[ev.pubkey] || profileMap[ev.pubkey]._ts < ev.created_at) {
            profileMap[ev.pubkey] = {
              name: meta.display_name || meta.name || shortPubkey(ev.pubkey),
              picture: meta.picture || null,
              about: (meta.about || "").slice(0, 120),
              nip05: meta.nip05 || "",
              _ts: ev.created_at,
            };
          }
        } catch {}
      },
      oneose: () => { sub0.close(); checkDone(); },
    });

    const sub3 = pool.subscribeMany(DEFAULT_RELAYS, { kinds: [3] }, {
      onevent: (ev) => {
        if (!followMap[ev.pubkey] || followMap[ev.pubkey]._ts < ev.created_at) {
          followMap[ev.pubkey] = {
            follows: ev.tags.filter((t) => t[0] === "p").map((t) => t[1]),
            _ts: ev.created_at,
          };
        }
      },
      oneose: () => { sub3.close(); checkDone(); },
    });

    return () => { sub0.close(); sub3.close(); };
  }, []);

  // On-demand: fetch posts when a user is selected
  useEffect(() => {
    if (!selectedPk) { setSelectedPosts([]); return; }
    setPostsLoading(true);
    setSelectedPosts([]);
    const sub = getPool().subscribeMany(DEFAULT_RELAYS, { kinds: [1], authors: [selectedPk], limit: 10 }, {
      onevent: (ev) => {
        setSelectedPosts((prev) => {
          if (prev.find((n) => n.id === ev.id)) return prev;
          return [ev, ...prev].sort((a, b) => b.created_at - a.created_at);
        });
      },
      oneose: () => { sub.close(); setPostsLoading(false); },
    });
    return () => { sub.close(); };
  }, [selectedPk]);

  // Build graph from profiles + follows
  const edges = useMemo(() => {
    const edgeList = [];
    for (const [pk, data] of Object.entries(follows)) {
      for (const target of (data.follows || [])) {
        if (profiles[target]) { // only show edges to known users
          edgeList.push({ source: pk, target });
        }
      }
    }
    return edgeList;
  }, [follows, profiles]);

  const graphData = useMemo(() => {
    const nodes = Object.entries(profiles).map(([pk, p]) => {
      const followCount = (follows[pk]?.follows || []).filter((f) => profiles[f]).length;
      return { id: pk, name: p.name, picture: p.picture, about: p.about, followCount };
    });
    const links = edges.map((e) => ({ source: e.source, target: e.target }));
    return { nodes, links };
  }, [profiles, edges, follows]);

  // Preload images
  useEffect(() => {
    for (const node of graphData.nodes) {
      if (node.picture && !imageCache.current[node.id]) {
        const img = new Image();
        img.src = node.picture;
        img.onload = () => { imageCache.current[node.id] = img; };
      }
    }
  }, [graphData.nodes]);

  // Follow/unfollow handler
  async function handleFollow(targetPk) {
    if (!activeAccount || followingInProgress) return;
    setFollowingInProgress(true);
    try {
      const myPk = activeAccount.pk;
      const currentFollows = follows[myPk]?.follows || [];
      const isFollowing = currentFollows.includes(targetPk);
      const newFollows = isFollowing
        ? currentFollows.filter((pk) => pk !== targetPk)
        : [...currentFollows, targetPk];
      await publishFollows(newFollows, activeAccount);
      setFollows((prev) => ({ ...prev, [myPk]: { follows: newFollows, _ts: Date.now() / 1000 } }));
    } catch (e) {
      alert("Failed: " + e.message);
    }
    setFollowingInProgress(false);
  }

  // Directory list
  const profileList = useMemo(() => {
    return Object.entries(profiles)
      .map(([pk, p]) => ({ pk, ...p, npub: npubEncode(pk) }))
      .filter((p) => {
        if (!search) return true;
        const q = search.toLowerCase();
        return p.name.toLowerCase().includes(q) || p.about.toLowerCase().includes(q);
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [profiles, search]);

  const selectedProfile = selectedPk ? profiles[selectedPk] : null;
  const myFollows = activeAccount ? (follows[activeAccount.pk]?.follows || []) : [];

  // Canvas renderers
  const paintNode = useCallback((node, ctx, globalScale) => {
    const isSelected = selectedPk === node.id;
    const isHovered = hoverNode?.id === node.id;
    const size = 8 + (node.followCount || 0);
    const img = imageCache.current[node.id];

    if (img && img.complete) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(node.x - size, node.y - size, size * 2, size * 2);
      ctx.clip();
      ctx.drawImage(img, node.x - size, node.y - size, size * 2, size * 2);
      ctx.restore();
      ctx.strokeStyle = isSelected ? "#baff00" : isHovered ? "#baff00" : "#333";
      ctx.lineWidth = isSelected ? 2.5 : isHovered ? 2 : 1;
      ctx.strokeRect(node.x - size, node.y - size, size * 2, size * 2);
    } else {
      ctx.fillStyle = isSelected ? "#1a2600" : isHovered ? "#1a1a00" : "#222";
      ctx.fillRect(node.x - size, node.y - size, size * 2, size * 2);
      ctx.strokeStyle = isSelected ? "#baff00" : isHovered ? "#baff00" : "#444";
      ctx.lineWidth = isSelected ? 2.5 : 1;
      ctx.strokeRect(node.x - size, node.y - size, size * 2, size * 2);
      ctx.fillStyle = "#baff00";
      ctx.font = `${Math.max(10, size)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(node.name.charAt(0).toUpperCase(), node.x, node.y);
    }

    if (globalScale > 1.2 || isHovered || isSelected) {
      ctx.font = `${isSelected ? "bold " : ""}4px sans-serif`;
      ctx.fillStyle = isSelected ? "#baff00" : "#d9d6d6";
      ctx.textAlign = "center";
      ctx.fillText(node.name, node.x, node.y + size + 6);
    }
  }, [hoverNode, selectedPk]);

  const paintLink = useCallback((link, ctx) => {
    const srcId = link.source?.id || link.source;
    const tgtId = link.target?.id || link.target;
    const isHighlighted = selectedPk === srcId || selectedPk === tgtId ||
      hoverNode?.id === srcId || hoverNode?.id === tgtId;
    // More visible default: from 50,50,50,0.4 to 100,100,100,0.5
    ctx.strokeStyle = isHighlighted ? "rgba(186,255,0,0.7)" : "rgba(100,100,100,0.5)";
    ctx.lineWidth = isHighlighted ? 1.5 : 0.8;
    ctx.beginPath();
    ctx.moveTo(link.source.x, link.source.y);
    ctx.lineTo(link.target.x, link.target.y);
    ctx.stroke();
  }, [hoverNode, selectedPk]);

  return (
    <div>
      <h2 className="page-title">Network</h2>

      <div className="network-stats">
        <div className="network-stat">
          <span className="network-stat-value">{Object.keys(profiles).length}</span>
          <span className="network-stat-label">Users</span>
        </div>
        <div className="network-stat">
          <span className="network-stat-value">{edges.length}</span>
          <span className="network-stat-label">Follows</span>
        </div>
      </div>

      {loading && <div className="loading">Loading network...</div>}

      {!loading && (
        <div className="network-layout">
          {/* Directory sidebar */}
          <div className="network-directory">
            <div className="directory-search">
              <input type="text" placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="directory-scroll">
              {profileList.map((p) => (
                <div
                  key={p.pk}
                  className={`directory-card clickable ${selectedPk === p.pk ? "selected" : ""}`}
                  onClick={() => setSelectedPk(selectedPk === p.pk ? null : p.pk)}
                >
                  <div className="directory-card-avatar">
                    {p.picture ? <img src={p.picture} alt="" /> : <span>{p.name.charAt(0).toUpperCase()}</span>}
                  </div>
                  <div className="directory-card-info">
                    <div className="directory-card-name">{p.name}</div>
                    {follows[p.pk] && (
                      <div className="directory-card-nip05">{follows[p.pk].follows.filter((f) => profiles[f]).length} following</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Graph + detail panel */}
          <div className="network-main">
            <div className="network-container" ref={containerRef}>
              <div className="network-ping" />
              <div className="network-ping" />
              <div className="network-corner tl" />
              <div className="network-corner tr" />
              <div className="network-corner bl" />
              <div className="network-corner br" />
              <Suspense fallback={<div className="loading">Loading graph...</div>}>
              <ForceGraph2D
                ref={graphRef}
                graphData={graphData}
                width={dimensions.width}
                height={dimensions.height}
                backgroundColor="rgba(0,0,0,0)"
                nodeRelSize={6}
                nodeCanvasObject={paintNode}
                nodePointerAreaPaint={(node, color, ctx) => {
                  const s = 8 + (node.followCount || 0);
                  ctx.fillStyle = color;
                  ctx.fillRect(node.x - s, node.y - s, s * 2, s * 2);
                }}
                linkCanvasObject={paintLink}
                linkDirectionalArrowLength={3}
                linkDirectionalArrowRelPos={0.8}
                onNodeHover={(node) => setHoverNode(node || null)}
                onLinkHover={(link) => setHoverLink(link || null)}
                onNodeClick={(node) => setSelectedPk(selectedPk === node.id ? null : node.id)}
                d3AlphaDecay={0.02}
                d3VelocityDecay={0.3}
                cooldownTime={5000}
              />
              </Suspense>

              {/* Hover tooltip */}
              {hoverNode && hoverNode.id !== selectedPk && (
                <div className="network-tooltip">
                  <div className="network-tooltip-header">
                    {hoverNode.picture && <img src={hoverNode.picture} alt="" />}
                    <strong>{hoverNode.name}</strong>
                  </div>
                  {hoverNode.about && <p>{hoverNode.about}</p>}
                  <span className="network-tooltip-meta">{hoverNode.followCount || 0} following</span>
                </div>
              )}

              {hoverLink && !hoverNode && (
                <div className="network-tooltip">
                  <strong>
                    {profiles[hoverLink.source?.id || hoverLink.source]?.name || "?"}
                    {" follows "}
                    {profiles[hoverLink.target?.id || hoverLink.target]?.name || "?"}
                  </strong>
                </div>
              )}
            </div>

            {/* Selected user detail panel */}
            {selectedProfile && (
              <div className="network-detail">
                <div className="network-detail-header">
                  <div className="directory-card-avatar" style={{ width: 48, height: 48, fontSize: "1.4rem" }}>
                    {selectedProfile.picture ? <img src={selectedProfile.picture} alt="" /> : <span>{selectedProfile.name.charAt(0).toUpperCase()}</span>}
                  </div>
                  <div>
                    <div className="directory-card-name" style={{ fontSize: "1.05rem" }}>{selectedProfile.name}</div>
                    {selectedProfile.about && <div className="directory-card-about">{selectedProfile.about}</div>}
                  </div>
                </div>

                <div className="network-detail-actions">
                  <button className="btn-small" onClick={() => setHash("profile/" + npubEncode(selectedPk))}>View Profile</button>
                  <button className="btn-small" onClick={() => setHash("messages/" + npubEncode(selectedPk))}>Message</button>
                  {activeAccount && activeAccount.pk !== selectedPk && (
                    <button
                      className={`btn-small ${myFollows.includes(selectedPk) ? "btn-reset" : ""}`}
                      onClick={() => handleFollow(selectedPk)}
                      disabled={followingInProgress}
                    >
                      {followingInProgress ? "..." : myFollows.includes(selectedPk) ? "Unfollow" : "Follow"}
                    </button>
                  )}
                </div>

                {follows[selectedPk] && follows[selectedPk].follows.filter((f) => profiles[f]).length > 0 && (
                  <div className="network-detail-follows">
                    <span className="network-detail-label">Following</span>
                    <div className="network-detail-follow-list">
                      {follows[selectedPk].follows.filter((f) => profiles[f]).map((f) => (
                        <button key={f} className="network-detail-follow-chip" onClick={() => setSelectedPk(f)}>
                          {profiles[f].name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="network-detail-posts">
                  <span className="network-detail-label">Recent Posts</span>
                  {postsLoading && <div className="loading" style={{ padding: 12 }}>Loading...</div>}
                  {!postsLoading && selectedPosts.length === 0 && <div style={{ color: "var(--text-faint)", fontSize: "0.78rem", padding: "8px 0" }}>No posts.</div>}
                  {selectedPosts.slice(0, 5).map((ev) => (
                    <div key={ev.id} className="network-detail-post clickable" onClick={() => setHash("thread/" + ev.id)}>
                      <div style={{ fontSize: "0.82rem", lineHeight: 1.4 }}>{ev.content.slice(0, 120)}{ev.content.length > 120 ? "..." : ""}</div>
                      <div className="note-time">{formatTime(ev.created_at)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
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

const IconCopy = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>;
const IconCheck = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>;
const IconEye = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>;
const IconEyeOff = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>;

function CopyBtn({ text, label }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button className="btn-icon" onClick={handleCopy} title={copied ? "Copied!" : `Copy ${label || ""}`}>
      {copied ? <IconCheck /> : <IconCopy />}
    </button>
  );
}

function NpubBadge({ npub }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}>
      <code className="char-npub">{npub}</code>
      <CopyBtn text={npub} label="npub" />
    </div>
  );
}

function KeysSection({ npub, nsec }) {
  const [showNsec, setShowNsec] = useState(false);
  return (
    <div style={{ margin: "24px 0" }}>
      <h3>Keys</h3>
      <div className="admin-key-row">
        <span>npub</span>
        <code>{npub}</code>
        <CopyBtn text={npub} label="npub" />
      </div>
      <div className="admin-key-row">
        <span>nsec</span>
        {showNsec ? (
          <code className="nsec-display">{nsec}</code>
        ) : (
          <code style={{ color: "var(--text-faint)" }}>{"*".repeat(20)}</code>
        )}
        <div style={{ display: "flex", gap: 2 }}>
          <button className="btn-icon" onClick={() => setShowNsec(!showNsec)} title={showNsec ? "Hide nsec" : "Reveal nsec"}>
            {showNsec ? <IconEyeOff /> : <IconEye />}
          </button>
          <CopyBtn text={nsec} label="nsec" />
        </div>
      </div>
    </div>
  );
}

function AdminKeySection({ adminAccount, isAdmin }) {
  const [showNsec, setShowNsec] = useState(false);

  return (
    <div className="edit-section">
      <h3>{isAdmin ? "Admin Key" : "User Key"}</h3>
      <p style={{ color: "var(--text-faint)", fontSize: "0.75rem", marginBottom: 12 }}>
        {isAdmin
          ? "This keypair authenticates you as the admin. You can manage the whitelist below."
          : "This is your user key. An admin must whitelist your npub before you can use the API."
        }
      </p>
      <div className="admin-key-row">
        <span>npub</span>
        <code>{adminAccount.npub}</code>
        <CopyBtn text={adminAccount.npub} label="npub" />
      </div>
      <div className="admin-key-row">
        <span>nsec</span>
        {showNsec ? (
          <code className="nsec-display">{adminAccount.nsec}</code>
        ) : (
          <code style={{ color: "var(--text-faint)" }}>{"*".repeat(20)}</code>
        )}
        <div style={{ display: "flex", gap: 2 }}>
          <button className="btn-icon" onClick={() => setShowNsec(!showNsec)} title={showNsec ? "Hide nsec" : "Reveal nsec"}>
            {showNsec ? <IconEyeOff /> : <IconEye />}
          </button>
          <CopyBtn text={adminAccount.nsec} label="nsec" />
        </div>
      </div>
      {isAdmin && <AdminWhitelist adminAccount={adminAccount} />}
    </div>
  );
}

function AdminWhitelist({ adminAccount }) {
  const [whitelist, setWhitelist] = useState([]);
  const [newPubkey, setNewPubkey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const apiUrl = import.meta.env.VITE_API_URL || "";

  useEffect(() => {
    if (!apiUrl || !adminAccount) return;
    const url = `${apiUrl}/admin/auth`;
    getAuthHeaders(url, "GET", adminAccount).then((headers) => {
      fetch(url, { headers }).then((r) => r.json()).then((data) => {
        setWhitelist(data.whitelist || []);
        setLoading(false);
      }).catch(() => setLoading(false));
    });
  }, [adminAccount]);

  async function handleAdd() {
    setError("");
    let pk = newPubkey.trim();
    if (!pk) return;

    // Convert npub to hex if needed
    if (pk.startsWith("npub1")) {
      try {
        const { type, data } = nip19decode(pk);
        if (type === "npub") pk = data;
        else { setError("Invalid key — expected an npub or 64-char hex pubkey."); return; }
      } catch { setError("Invalid npub — could not decode."); return; }
    }

    if (!/^[0-9a-f]{64}$/i.test(pk)) {
      setError("Invalid pubkey — must be an npub or 64-character hex string.");
      return;
    }

    if (pk === adminAccount.pk) {
      setError("That's the admin key — it already has full access.");
      return;
    }

    if (whitelist.includes(pk)) {
      setError("This pubkey is already whitelisted.");
      return;
    }

    const url = `${apiUrl}/admin/whitelist`;
    const headers = await getAuthHeaders(url, "POST", adminAccount);
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ pubkey: pk }) });
    const data = await res.json();
    if (data.whitelist) setWhitelist(data.whitelist);
    setNewPubkey("");
  }

  async function handleRemove(pk) {
    const url = `${apiUrl}/admin/whitelist/${pk}`;
    const headers = await getAuthHeaders(url, "DELETE", adminAccount);
    const res = await fetch(url, { method: "DELETE", headers });
    const data = await res.json();
    if (data.whitelist) setWhitelist(data.whitelist);
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: "0.68rem", fontWeight: 600, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "1.5px", marginBottom: 8 }}>
        Whitelisted Pubkeys
      </div>
      {loading && <div style={{ color: "var(--text-faint)", fontSize: "0.78rem" }}>Loading...</div>}
      {!loading && whitelist.length === 0 && (
        <div style={{ color: "var(--text-faint)", fontSize: "0.78rem", marginBottom: 8 }}>No additional pubkeys whitelisted. Only the admin can access the API.</div>
      )}
      {whitelist.map((pk) => (
        <div key={pk} className="admin-key-row">
          <code style={{ fontSize: "0.62rem" }}>{npubEncode(pk)}</code>
          <CopyBtn text={npubEncode(pk)} label="npub" />
          <button className="btn-small btn-reset" onClick={() => handleRemove(pk)}>Remove</button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          type="text"
          placeholder="npub1... or hex pubkey"
          value={newPubkey}
          onChange={(e) => { setNewPubkey(e.target.value); setError(""); }}
          style={{ flex: 1, padding: "6px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text)", fontSize: "0.78rem", fontFamily: "var(--font-mono)" }}
        />
        <button className="btn-small" onClick={handleAdd} disabled={!newPubkey.trim()}>Add</button>
      </div>
      {error && <div style={{ color: "var(--neon)", fontSize: "0.75rem", marginTop: 6 }}>{error}</div>}
    </div>
  );
}

function SettingsPage({ characters, onReset, adminAccount, serverAdminPubkey }) {
  const [exported, setExported] = useState(false);

  function handleExportKeys() {
    const sections = [];

    // User/admin key
    if (adminAccount) {
      sections.push([
        "# Your Account Key",
        `USER_NPUB=${adminAccount.npub}`,
        `USER_NSEC=${adminAccount.nsec}`,
        `USER_SKHEX=${adminAccount.skHex}`,
        `USER_PK=${adminAccount.pk}`,
        "",
      ].join("\n"));
    }

    // Character keys
    characters.forEach((c, i) => {
      const idx = i + 1;
      sections.push([
        `# Character: ${c.name}`,
        `CHARACTER_${idx}_NAME=${c.name}`,
        `CHARACTER_${idx}_NSEC=${c.nsec}`,
        `CHARACTER_${idx}_SKHEX=${c.skHex}`,
        `CHARACTER_${idx}_NPUB=${c.npub}`,
        `CHARACTER_${idx}_PK=${c.pk}`,
        "",
      ].join("\n"));
    });

    const content = [
      "# NPC No More — Keys Export",
      `# Exported: ${new Date().toISOString()}`,
      `# Account + ${characters.length} character${characters.length === 1 ? "" : "s"}`,
      "#",
      "# WARNING: These are private keys. Anyone with access can post as you or your characters.",
      "# Store securely and never commit to a public repository.",
      "",
      ...sections,
    ].join("\n");

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `npc-no-more-keys-${new Date().toISOString().slice(0, 10)}.env`;
    a.click();
    URL.revokeObjectURL(url);
    setExported(true);
  }

  const isAdmin = !!serverAdminPubkey && serverAdminPubkey === adminAccount?.pk;

  return (
    <div>
      <h2 className="page-title">Settings</h2>

      {adminAccount && (
        <AdminKeySection adminAccount={adminAccount} isAdmin={isAdmin} />
      )}

      <div className="edit-section" style={{ marginTop: 20 }}>
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
            {serverAdminPubkey && !isAdmin && (
              <div style={{ marginTop: 8 }}>
                <div className="admin-key-row">
                  <span>Admin</span>
                  <code style={{ fontSize: "0.62rem" }}>{npubEncode(serverAdminPubkey)}</code>
                  <CopyBtn text={npubEncode(serverAdminPubkey)} label="admin npub" />
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                  <button className="btn-small" onClick={() => setHash("profile/" + npubEncode(serverAdminPubkey))}>
                    View Profile
                  </button>
                  <button className="btn-small" onClick={() => setHash("messages/" + npubEncode(serverAdminPubkey))}>
                    Message Admin
                  </button>
                </div>
              </div>
            )}
            <p style={{ color: "var(--text-faint)", fontSize: "0.75rem", marginTop: 12 }}>
              Private relay for NPC No More. All posts are published here first.
            </p>
          </div>
        ) : (
          <p style={{ color: "var(--text-dim)", fontSize: "0.82rem" }}>
            No private relay configured. Using public relays only.
          </p>
        )}
      </div>

      <div className="edit-section" style={{ marginTop: 20 }}>
        <h3>Export Keys</h3>
        <p style={{ color: "var(--text-dim)", fontSize: "0.82rem", marginBottom: 16 }}>
          Download your account key and all character private keys. Store securely — anyone with these keys can post as you.
        </p>
        <button className="btn-primary" onClick={handleExportKeys}>
          Export all keys as .env
        </button>
        {exported && <p className="success" style={{ marginTop: 8 }}>Keys exported.</p>}
      </div>

      <div className="edit-section" style={{ marginTop: 20, borderLeftColor: "var(--danger-dim)" }}>
        <h3>Danger Zone</h3>
        <p style={{ color: "var(--text-dim)", fontSize: "0.82rem", marginBottom: 16 }}>
          Delete all characters, your account key, and local data. This cannot be undone.
        </p>
        <button className="btn-small btn-reset" onClick={onReset} disabled={!exported}>
          Delete all data
        </button>
        {!exported && (
          <p style={{ color: "var(--text-faint)", fontSize: "0.75rem", marginTop: 8 }}>
            Export your keys first before deleting.
          </p>
        )}
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
  const [adminAccount, setAdminAccount] = useState(null);
  const [serverAdminPubkey, setServerAdminPubkey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [route, setRoute] = useState("home");
  const [routeKey, setRouteKey] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [unreadPks, setUnreadPks] = useState(new Set());

  const ADMIN_ID = "__admin__";
  const adminAsIdentity = adminAccount ? {
    id: ADMIN_ID,
    name: adminAccount.profile_name || "You",
    profile_image: adminAccount.profile_image || "",
    pk: adminAccount.pk,
    npub: adminAccount.npub,
    skHex: adminAccount.skHex,
    isAdminIdentity: true,
  } : null;
  const allIdentities = [...(adminAsIdentity ? [adminAsIdentity] : []), ...characters];
  const activeIdentity = allIdentities.find((c) => c.id === activeCharId) || adminAsIdentity;
  const activeChar = characters.find((c) => c.id === activeCharId) || null;
  const activeAccount = activeIdentity ? accountFromSkHex(activeIdentity.skHex) : null;

  useEffect(() => {
    // Load admin account
    const admin = loadAdminAccount();
    if (admin) {
      setAdminAccount(admin);
    }

    // Check if server already has an admin
    const apiUrl = import.meta.env.VITE_API_URL || "";
    if (apiUrl) {
      fetch(`${apiUrl}/setup-status`).then(r => r.json()).then(data => {
        if (data.adminPubkey) setServerAdminPubkey(data.adminPubkey);
      }).catch(() => {});
    }

    const existing = loadCharacters();
    if (existing.length === 0) migrateOldData();
    const chars = loadCharacters();
    setCharacters(chars);
    const savedId = loadActiveCharId();
    if (savedId === "__admin__" || (savedId && chars.find((c) => c.id === savedId))) {
      setActiveCharId(savedId);
    } else {
      setActiveCharId("__admin__");
      saveActiveCharId("__admin__");
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

  // ── Unread DM tracking ──
  const dmSubRef = useRef(null);

  function getDmLastSeen(pk) {
    try { return parseInt(localStorage.getItem(`npc_dm_seen_${pk}`) || "0", 10); } catch { return 0; }
  }
  function setDmLastSeen(pk) {
    localStorage.setItem(`npc_dm_seen_${pk}`, String(Math.floor(Date.now() / 1000)));
    setUnreadPks((prev) => { const next = new Set(prev); next.delete(pk); return next; });
  }

  useEffect(() => {
    if (allIdentities.length === 0) return;
    if (dmSubRef.current) dmSubRef.current.close();

    const pks = allIdentities.map((c) => c.pk);
    // Subscribe to kind:4 DMs sent TO any of our identities, since the latest last-seen
    const minSince = Math.min(...pks.map(getDmLastSeen)) || (Math.floor(Date.now() / 1000) - 86400);

    dmSubRef.current = getPool().subscribeMany(
      DEFAULT_RELAYS,
      { kinds: [4], "#p": pks, since: minSince },
      {
        onevent: (ev) => {
          // Find which of our identities this DM is for
          const recipientTag = ev.tags.find((t) => t[0] === "p");
          const recipientPk = recipientTag?.[1];
          if (!recipientPk || !pks.includes(recipientPk)) return;
          // If the sender is one of our own identities, skip
          if (pks.includes(ev.pubkey)) return;
          const lastSeen = getDmLastSeen(recipientPk);
          if (ev.created_at > lastSeen) {
            setUnreadPks((prev) => new Set([...prev, recipientPk]));
          }
        },
        oneose: () => {},
      }
    );
    return () => { if (dmSubRef.current) dmSubRef.current.close(); };
  }, [allIdentities.map((c) => c.pk).join(",")]);

  // Mark DMs as read when opening Messages tab
  useEffect(() => {
    if (route === "messages" && activeIdentity) {
      setDmLastSeen(activeIdentity.pk);
    }
  }, [route, activeIdentity?.pk]);

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
    setAdminAccount(null);
    saveCharacters([]);
    saveActiveCharId(null);
    clearLocal("npc_admin_account");
    setHash("");
  }

  if (loading) return null;

  // Key setup — first time visiting the site
  if (!adminAccount) {
    return <UserSetup serverAdminPubkey={serverAdminPubkey} onComplete={(acc) => setAdminAccount(acc)} />;
  }

  if (route === "new-character") {
    return <CreateCharacter onComplete={handleCreateCharacter} adminAccount={adminAccount} serverAdminPubkey={serverAdminPubkey} />;
  }

  // Figure out current profile pubkey for sidebar highlighting
  let currentProfilePk = null;
  if (route === "profile" && routeKey) {
    currentProfilePk = routeKey;
  }

  function renderMain() {
    if (route === "pi") {
      return <PiChat allIdentities={allIdentities} activeCharId={activeCharId} adminAccount={adminAccount} />;
    }
    if (route === "network") {
      return <NetworkPage characters={characters} activeAccount={activeAccount} />;
    }
    if (route === "settings") {
      return <SettingsPage characters={characters} onReset={handleReset} adminAccount={adminAccount} serverAdminPubkey={serverAdminPubkey} />;
    }
    if (route === "profile" && routeKey) {
      // Admin/user viewing their own profile
      if (adminAccount && routeKey === adminAccount.pk) {
        return <OwnProfilePage adminAccount={adminAccount} serverAdminPubkey={serverAdminPubkey} allIdentities={allIdentities} activeCharId={activeCharId} onUpdateProfile={(acc) => setAdminAccount({ ...acc })} onDmRead={setDmLastSeen} />;
      }
      const ownedChar = characters.find((c) => c.pk === routeKey) || null;
      if (ownedChar) {
        return (
          <OwnedCharacterPage adminAccount={adminAccount} serverAdminPubkey={serverAdminPubkey}
            key={ownedChar.id}
            character={ownedChar}
            account={accountFromSkHex(ownedChar.skHex)}
            characters={characters}
            allIdentities={allIdentities}
            activeCharId={activeCharId}
            onUpdateChar={handleUpdateCharacter}
            onDeleteChar={handleDeleteCharacter}
            onDmRead={setDmLastSeen}
          />
        );
      }
      return <ExternalProfileView pubkey={routeKey} activeAccount={activeAccount} serverAdminPubkey={serverAdminPubkey} />;
    }
    if (route === "thread" && routeKey) {
      return <ThreadView eventId={routeKey} account={activeAccount} allIdentities={allIdentities} activeCharId={activeCharId} />;
    }
    if (route === "messages" && routeKey) {
      return <MessageView recipientPubkey={routeKey} account={activeAccount} allIdentities={allIdentities} activeCharId={activeCharId} />;
    }
    // Home route: show active character's page
    // Home route: show page for active identity
    if (activeChar) {
      return (
        <OwnedCharacterPage adminAccount={adminAccount} serverAdminPubkey={serverAdminPubkey}
          key={activeChar.id}
          character={activeChar}
          account={activeAccount}
          characters={characters}
          allIdentities={allIdentities}
          activeCharId={activeCharId}
          onUpdateChar={handleUpdateCharacter}
          onDeleteChar={handleDeleteCharacter}
          onDmRead={setDmLastSeen}
        />
      );
    }
    if (adminAccount) {
      return <OwnProfilePage adminAccount={adminAccount} serverAdminPubkey={serverAdminPubkey} allIdentities={allIdentities} activeCharId={activeCharId} onUpdateProfile={(acc) => setAdminAccount({ ...acc })} />;
    }
    return <div className="loading">Create a character to get started.</div>;
  }

  return (
    <div className="app-layout">
      <Sidebar
        allIdentities={allIdentities}
        activeCharId={activeCharId}
        serverAdminPubkey={serverAdminPubkey}
        adminPk={adminAccount?.pk}
        onSelectIdentity={switchCharacter}
        unreadPks={unreadPks}
      />

      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <div className={`sidebar-mobile ${sidebarOpen ? "open" : ""}`}>
        <Sidebar
          allIdentities={allIdentities}
          activeCharId={activeCharId}
          serverAdminPubkey={serverAdminPubkey}
          adminPk={adminAccount?.pk}
          onSelectIdentity={switchCharacter}
          unreadPks={unreadPks}
        />
      </div>

      <div className="main-content">
        <MobileHeader
          activeChar={activeIdentity}
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
