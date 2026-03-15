import { useState, useEffect, useCallback, useRef } from "react";
import {
  createAccount,
  loginWithNsec,
  loginWithExtension,
  publishNote,
  publishProfile,
  subscribeFeed,
  subscribeUserFeed,
  subscribeDMs,
  sendDM,
  decryptDM,
  fetchProfile,
  fetchProfiles,
  saveAccount,
  loadAccount,
  clearAccount,
  shortPubkey,
  formatTime,
  DEFAULT_RELAYS,
  getPool,
} from "./nostr";
import { npubEncode, decode as nip19decode } from "nostr-tools/nip19";
import "./App.css";

// ── Hash Router Helpers ──

function parseHash() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash) return { route: "feed" };

  const parts = hash.split("/");
  if (parts[0] === "profile" && parts[1]) {
    return { route: "profile", key: parts[1] };
  }
  if (parts[0] === "messages" && parts[1]) {
    return { route: "messages", key: parts[1] };
  }
  if (parts[0] === "messages") {
    return { route: "inbox" };
  }
  return { route: "feed" };
}

function resolvePubkey(key) {
  if (!key) return null;
  // If it starts with npub1, decode it
  if (key.startsWith("npub1")) {
    try {
      const { type, data } = nip19decode(key);
      if (type === "npub") return data;
    } catch {}
    return null;
  }
  // If it looks like hex (64 chars)
  if (/^[0-9a-f]{64}$/i.test(key)) return key;
  return null;
}

function setHash(path) {
  window.history.pushState(null, "", "#/" + path);
}

// ── Auth Screen ──

function AuthScreen({ onLogin }) {
  const [tab, setTab] = useState("create");
  const [nsecInput, setNsecInput] = useState("");
  const [error, setError] = useState("");

  function handleCreate() {
    const acc = createAccount();
    saveAccount(acc);
    onLogin(acc);
  }

  function handleNsecLogin() {
    setError("");
    try {
      const acc = loginWithNsec(nsecInput.trim());
      saveAccount(acc);
      onLogin(acc);
    } catch (e) {
      setError("Invalid key: " + e.message);
    }
  }

  async function handleExtensionLogin() {
    setError("");
    try {
      const acc = await loginWithExtension();
      saveAccount(acc);
      onLogin(acc);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>🟣 NPC No More</h1>
        <p className="subtitle">Your gateway to Nostr</p>

        <div className="auth-tabs">
          <button
            className={tab === "create" ? "active" : ""}
            onClick={() => setTab("create")}
          >
            Create Account
          </button>
          <button
            className={tab === "nsec" ? "active" : ""}
            onClick={() => setTab("nsec")}
          >
            Sign In (nsec)
          </button>
          <button
            className={tab === "extension" ? "active" : ""}
            onClick={() => setTab("extension")}
          >
            Extension (NIP-07)
          </button>
        </div>

        {tab === "create" && (
          <div className="auth-form">
            <p>Generate a new Nostr identity instantly.</p>
            <button className="btn-primary" onClick={handleCreate}>
              ⚡ Create New Account
            </button>
          </div>
        )}

        {tab === "nsec" && (
          <div className="auth-form">
            <p>Paste your nsec or hex private key.</p>
            <input
              type="password"
              placeholder="nsec1... or hex"
              value={nsecInput}
              onChange={(e) => setNsecInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleNsecLogin()}
            />
            <button className="btn-primary" onClick={handleNsecLogin}>
              🔑 Sign In
            </button>
          </div>
        )}

        {tab === "extension" && (
          <div className="auth-form">
            <p>
              Use a NIP-07 browser extension like{" "}
              <a href="https://github.com/nicehash/nos2x" target="_blank">
                nos2x
              </a>{" "}
              or{" "}
              <a href="https://getalby.com" target="_blank">
                Alby
              </a>
              .
            </p>
            <button className="btn-primary" onClick={handleExtensionLogin}>
              🧩 Connect Extension
            </button>
          </div>
        )}

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

// ── Compose Box ──

function ComposeBox({ account, onPosted }) {
  const [content, setContent] = useState("");
  const [posting, setPosting] = useState(false);

  async function handlePost() {
    if (!content.trim()) return;
    setPosting(true);
    try {
      const ev = await publishNote(content, account);
      setContent("");
      onPosted(ev);
    } catch (e) {
      alert("Failed to post: " + e.message);
    }
    setPosting(false);
  }

  return (
    <div className="compose-box">
      <textarea
        placeholder="What's on your mind?"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handlePost();
        }}
      />
      <div className="compose-footer">
        <span className="hint">Ctrl+Enter to post</span>
        <button
          className="btn-primary"
          onClick={handlePost}
          disabled={posting || !content.trim()}
        >
          {posting ? "Posting…" : "Post"}
        </button>
      </div>
    </div>
  );
}

// ── Note Card ──

function NoteCard({ event, profile, onClickProfile }) {
  const meta = profile || {};
  const displayName =
    meta.display_name || meta.name || shortPubkey(event.pubkey);
  const avatar = meta.picture || null;

  return (
    <div className="note-card">
      <div
        className="note-header clickable"
        onClick={() => onClickProfile(event.pubkey)}
      >
        <div className="note-avatar">
          {avatar ? (
            <img src={avatar} alt="" />
          ) : (
            <div className="avatar-placeholder">
              {displayName.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <div className="note-meta">
          <span className="note-author">{displayName}</span>
          <span className="note-time">{formatTime(event.created_at)}</span>
        </div>
      </div>
      <div className="note-content">{event.content}</div>
    </div>
  );
}

// ── Edit Profile Page ──

function EditProfilePage({ account, onBack, onSaved }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [picture, setPicture] = useState("");
  const [banner, setBanner] = useState("");
  const [website, setWebsite] = useState("");
  const [nip05, setNip05] = useState("");
  const [lud16, setLud16] = useState("");

  useEffect(() => {
    setLoading(true);
    fetchProfile(DEFAULT_RELAYS, account.pk)
      .then((profile) => {
        if (profile) {
          setDisplayName(profile.display_name || "");
          setName(profile.name || "");
          setAbout(profile.about || "");
          setPicture(profile.picture || "");
          setBanner(profile.banner || "");
          setWebsite(profile.website || "");
          setNip05(profile.nip05 || "");
          setLud16(profile.lud16 || "");
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [account.pk]);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const metadata = {};
      if (displayName.trim()) metadata.display_name = displayName.trim();
      if (name.trim()) metadata.name = name.trim();
      if (about.trim()) metadata.about = about.trim();
      if (picture.trim()) metadata.picture = picture.trim();
      if (banner.trim()) metadata.banner = banner.trim();
      if (website.trim()) metadata.website = website.trim();
      if (nip05.trim()) metadata.nip05 = nip05.trim();
      if (lud16.trim()) metadata.lud16 = lud16.trim();

      await publishProfile(metadata, account);
      setSaved(true);
      if (onSaved) onSaved(metadata);
    } catch (e) {
      setError("Failed to save: " + e.message);
    }
    setSaving(false);
  }

  if (loading) {
    return (
      <div className="edit-profile-page">
        <button className="btn-back" onClick={onBack}>← Back</button>
        <div className="loading">Loading your profile…</div>
      </div>
    );
  }

  return (
    <div className="edit-profile-page">
      <button className="btn-back" onClick={onBack}>← Back</button>
      <div className="edit-profile-card">
        <h2>Edit Profile</h2>
        <p className="edit-profile-hint">
          Your profile is published to relays as a kind 0 event. All fields are optional.
        </p>
        <div className="edit-preview">
          {banner && (
            <div className="edit-preview-banner"><img src={banner} alt="" /></div>
          )}
          <div className="edit-preview-header">
            <div className="edit-preview-avatar">
              {picture ? (
                <img src={picture} alt="" />
              ) : (
                <div className="avatar-placeholder large">
                  {(displayName || name || "?").charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <div>
              <div className="edit-preview-name">{displayName || name || "Anonymous"}</div>
              {nip05 && <div className="edit-preview-nip05">✅ {nip05}</div>}
            </div>
          </div>
          {about && <p className="edit-preview-about">{about}</p>}
        </div>
        <div className="edit-form">
          <label><span>Display Name</span>
            <input type="text" placeholder="How you want to be known" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label>
          <label><span>Username</span>
            <input type="text" placeholder="short handle (no spaces)" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label><span>About</span>
            <textarea placeholder="Tell the world about yourself…" value={about} onChange={(e) => setAbout(e.target.value)} rows={3} /></label>
          <label><span>Profile Picture URL</span>
            <input type="url" placeholder="https://example.com/avatar.jpg" value={picture} onChange={(e) => setPicture(e.target.value)} /></label>
          <label><span>Banner Image URL</span>
            <input type="url" placeholder="https://example.com/banner.jpg" value={banner} onChange={(e) => setBanner(e.target.value)} /></label>
          <label><span>Website</span>
            <input type="url" placeholder="https://yoursite.com" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
          <label><span>NIP-05 Identifier</span>
            <input type="text" placeholder="you@yoursite.com" value={nip05} onChange={(e) => setNip05(e.target.value)} /></label>
          <label><span>Lightning Address</span>
            <input type="text" placeholder="you@walletofsatoshi.com" value={lud16} onChange={(e) => setLud16(e.target.value)} /></label>
        </div>
        {error && <p className="error">{error}</p>}
        {saved && <p className="success">✅ Profile saved and published to relays!</p>}
        <div className="edit-actions">
          <button className="btn-back" onClick={onBack}>Cancel</button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Publishing…" : "💾 Save Profile"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Conversation View ──

function ConversationView({ account, otherPubkey, messages, profiles, onBack, onClickProfile }) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef(null);

  const otherProfile = profiles[otherPubkey] || {};
  const otherName = otherProfile.display_name || otherProfile.name || shortPubkey(otherPubkey);
  const otherAvatar = otherProfile.picture || null;

  const sorted = [...messages].sort((a, b) => a.created_at - b.created_at);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [sorted.length]);

  async function handleSend() {
    if (!input.trim()) return;
    setSending(true);
    try {
      await sendDM(input, otherPubkey, account);
      setInput("");
    } catch (e) {
      alert("Failed to send: " + e.message);
    }
    setSending(false);
  }

  return (
    <div className="conversation-view">
      <div className="conversation-header">
        <button className="btn-back" onClick={onBack}>←</button>
        <div
          className="conversation-contact clickable"
          onClick={() => onClickProfile(otherPubkey)}
        >
          <div className="note-avatar">
            {otherAvatar ? (
              <img src={otherAvatar} alt="" />
            ) : (
              <div className="avatar-placeholder">
                {otherName.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <span className="conversation-name">{otherName}</span>
        </div>
      </div>

      <div className="conversation-messages">
        {sorted.length === 0 && (
          <div className="loading">No messages yet. Say hello!</div>
        )}
        {sorted.map((msg) => (
          <div
            key={msg.id}
            className={`chat-bubble ${msg.pubkey === account.pk ? "sent" : "received"}`}
          >
            <div className="chat-text">{msg._decrypted || msg.content}</div>
            <div className="chat-time">{formatTime(msg.created_at)}</div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="conversation-compose">
        <input
          type="text"
          placeholder="Type a message…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button
          className="btn-send"
          onClick={handleSend}
          disabled={sending || !input.trim()}
        >
          {sending ? "…" : "➤"}
        </button>
      </div>
    </div>
  );
}

// ── Inbox View ──

function InboxView({ account, initialConversation, onOpenConversation, onClickProfile }) {
  const [conversations, setConversations] = useState({}); // { otherPk: [msgs] }
  const [profiles, setProfiles] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedPk, setSelectedPk] = useState(initialConversation || null);
  const subRef = useRef(null);
  const allMessagesRef = useRef({}); // { eventId: event }
  const conversationsRef = useRef({});
  const profileCacheRef = useRef({});

  // Process a DM event: decrypt and add to conversations
  const processEvent = useCallback(async (event) => {
    // Skip if already processed
    if (allMessagesRef.current[event.id]) return;

    const { plaintext, otherPk } = await decryptDM(event, account);
    const processed = { ...event, _decrypted: plaintext, _otherPk: otherPk };
    allMessagesRef.current[event.id] = processed;

    // Add to conversations grouped by other party
    if (!conversationsRef.current[otherPk]) {
      conversationsRef.current[otherPk] = [];
    }
    conversationsRef.current[otherPk].push(processed);

    // Update state
    setConversations({ ...conversationsRef.current });
  }, [account]);

  // Subscribe to DMs
  useEffect(() => {
    setLoading(true);
    allMessagesRef.current = {};
    conversationsRef.current = {};
    setConversations({});

    subRef.current = subscribeDMs(
      DEFAULT_RELAYS,
      account.pk,
      (event) => processEvent(event),
      () => setLoading(false)
    );

    return () => {
      if (subRef.current) subRef.current.close();
    };
  }, [account.pk, processEvent]);

  // Fetch profiles for conversation partners
  useEffect(() => {
    const interval = setInterval(async () => {
      const unknownPubkeys = Object.keys(conversationsRef.current).filter(
        (pk) => !profileCacheRef.current[pk]
      );
      if (unknownPubkeys.length === 0) return;
      try {
        const fetched = await fetchProfiles(DEFAULT_RELAYS, unknownPubkeys);
        profileCacheRef.current = { ...profileCacheRef.current, ...fetched };
        for (const pk of unknownPubkeys) {
          if (!profileCacheRef.current[pk]) {
            profileCacheRef.current[pk] = { _attempted: true };
          }
        }
        setProfiles({ ...profileCacheRef.current });
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  // If a conversation is selected, show it
  if (selectedPk) {
    return (
      <ConversationView
        account={account}
        otherPubkey={selectedPk}
        messages={conversations[selectedPk] || []}
        profiles={profiles}
        onBack={() => setSelectedPk(null)}
        onClickProfile={onClickProfile}
      />
    );
  }

  // Sort conversations by latest message time
  const sortedConvos = Object.entries(conversations)
    .map(([pk, msgs]) => {
      const sorted = [...msgs].sort((a, b) => b.created_at - a.created_at);
      return { pk, msgs: sorted, latest: sorted[0] };
    })
    .sort((a, b) => b.latest.created_at - a.latest.created_at);

  return (
    <div className="inbox-view">
      <h2 className="inbox-title">✉️ Messages</h2>

      {loading && sortedConvos.length === 0 && (
        <div className="loading">Loading messages…</div>
      )}
      {!loading && sortedConvos.length === 0 && (
        <div className="loading">
          No messages yet. Visit someone's profile and send them a message!
        </div>
      )}

      <div className="inbox-list">
        {sortedConvos.map(({ pk, latest }) => {
          const profile = profiles[pk] || {};
          const name = profile.display_name || profile.name || shortPubkey(pk);
          const avatar = profile.picture || null;
          const preview = latest._decrypted || "";
          const isSent = latest.pubkey === account.pk;

          return (
            <div
              key={pk}
              className="inbox-row clickable"
              onClick={() => {
                setSelectedPk(pk);
                if (onOpenConversation) onOpenConversation(pk);
              }}
            >
              <div className="note-avatar">
                {avatar ? (
                  <img src={avatar} alt="" />
                ) : (
                  <div className="avatar-placeholder">
                    {name.charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
              <div className="inbox-row-content">
                <div className="inbox-row-top">
                  <span className="inbox-row-name">{name}</span>
                  <span className="inbox-row-time">
                    {formatTime(latest.created_at)}
                  </span>
                </div>
                <div className="inbox-row-preview">
                  {isSent ? "You: " : ""}
                  {preview.length > 80 ? preview.slice(0, 80) + "…" : preview}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Profile Page ──

function ProfilePage({ pubkey, isOwnProfile, onBack, onClickProfile, onEditProfile, onSendMessage }) {
  const [profile, setProfile] = useState(null);
  const [notes, setNotes] = useState([]);
  const [profiles, setProfiles] = useState({});
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [loadingNotes, setLoadingNotes] = useState(true);
  const subRef = useRef(null);
  const notesRef = useRef([]);
  const profileCacheRef = useRef({});

  const npub = npubEncode(pubkey);

  useEffect(() => {
    setLoadingProfile(true);
    setProfile(null);
    fetchProfile(DEFAULT_RELAYS, pubkey)
      .then((p) => { setProfile(p); setLoadingProfile(false); })
      .catch(() => setLoadingProfile(false));
  }, [pubkey]);

  const addNote = useCallback((event) => {
    setNotes((prev) => {
      if (prev.find((n) => n.id === event.id)) return prev;
      const updated = [event, ...prev].sort((a, b) => b.created_at - a.created_at);
      notesRef.current = updated;
      return updated;
    });
  }, []);

  useEffect(() => {
    const interval = setInterval(async () => {
      const unknownPubkeys = [...new Set(notesRef.current.map((n) => n.pubkey))].filter(
        (pk) => !profileCacheRef.current[pk]
      );
      if (unknownPubkeys.length === 0) return;
      try {
        const fetched = await fetchProfiles(DEFAULT_RELAYS, unknownPubkeys);
        profileCacheRef.current = { ...profileCacheRef.current, ...fetched };
        for (const pk of unknownPubkeys) {
          if (!profileCacheRef.current[pk]) profileCacheRef.current[pk] = { _attempted: true };
        }
        setProfiles({ ...profileCacheRef.current });
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    setLoadingNotes(true);
    notesRef.current = [];
    setNotes([]);
    if (subRef.current) subRef.current.close();
    subRef.current = subscribeUserFeed(DEFAULT_RELAYS, pubkey, (event) => addNote(event), () => setLoadingNotes(false), 50);
    return () => { if (subRef.current) subRef.current.close(); };
  }, [pubkey, addNote]);

  const meta = profile || {};
  const displayName = meta.display_name || meta.name || shortPubkey(pubkey);
  const avatar = meta.picture || null;
  const banner = meta.banner || null;

  return (
    <div className="profile-page">
      <button className="btn-back" onClick={onBack}>← Back</button>

      {banner && <div className="profile-banner"><img src={banner} alt="" /></div>}

      <div className="profile-card">
        <div className="profile-avatar-large">
          {avatar ? <img src={avatar} alt="" /> : (
            <div className="avatar-placeholder large">{displayName.charAt(0).toUpperCase()}</div>
          )}
        </div>
        <div className="profile-info">
          <div className="profile-name-row">
            <h2 className="profile-name">{displayName}</h2>
            {isOwnProfile && (
              <button className="btn-edit" onClick={onEditProfile}>✏️ Edit Profile</button>
            )}
            {!isOwnProfile && (
              <button className="btn-edit" onClick={() => onSendMessage(pubkey)}>
                ✉️ Message
              </button>
            )}
          </div>
          {meta.nip05 && <span className="profile-nip05">✅ {meta.nip05}</span>}
          <code className="profile-npub">{npub}</code>
          {meta.about && <p className="profile-about">{meta.about}</p>}
          <div className="profile-details">
            {meta.website && (
              <a className="profile-link" href={meta.website.startsWith("http") ? meta.website : "https://" + meta.website} target="_blank" rel="noopener">
                🔗 {meta.website}
              </a>
            )}
            {meta.lud16 && <span className="profile-detail">⚡ {meta.lud16}</span>}
          </div>
        </div>
      </div>

      {loadingProfile && !profile && <div className="loading">Loading profile…</div>}

      <h3 className="profile-posts-heading">Posts</h3>

      {loadingNotes && notes.length === 0 && <div className="loading">Loading notes…</div>}
      {!loadingNotes && notes.length === 0 && <div className="loading">No posts found.</div>}

      <div className="notes-list">
        {notes.map((ev) => (
          <NoteCard key={ev.id} event={ev} profile={ev.pubkey === pubkey ? profile : profiles[ev.pubkey]} onClickProfile={onClickProfile} />
        ))}
      </div>
    </div>
  );
}

// ── Feed ──

function Feed({ account, onClickProfile }) {
  const [tab, setTab] = useState("global");
  const [notes, setNotes] = useState([]);
  const [profiles, setProfiles] = useState({});
  const [loading, setLoading] = useState(true);
  const subRef = useRef(null);
  const notesRef = useRef([]);
  const profileCacheRef = useRef({});

  const addNote = useCallback((event) => {
    setNotes((prev) => {
      if (prev.find((n) => n.id === event.id)) return prev;
      const updated = [event, ...prev].sort((a, b) => b.created_at - a.created_at);
      notesRef.current = updated;
      return updated;
    });
  }, []);

  useEffect(() => {
    const interval = setInterval(async () => {
      const unknownPubkeys = [...new Set(notesRef.current.map((n) => n.pubkey))].filter(
        (pk) => !profileCacheRef.current[pk]
      );
      if (unknownPubkeys.length === 0) return;
      try {
        const fetched = await fetchProfiles(DEFAULT_RELAYS, unknownPubkeys);
        profileCacheRef.current = { ...profileCacheRef.current, ...fetched };
        for (const pk of unknownPubkeys) {
          if (!profileCacheRef.current[pk]) profileCacheRef.current[pk] = { _attempted: true };
        }
        setProfiles({ ...profileCacheRef.current });
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    setLoading(true);
    notesRef.current = [];
    setNotes([]);
    if (subRef.current) subRef.current.close();
    if (tab === "mine") {
      subRef.current = subscribeUserFeed(DEFAULT_RELAYS, account.pk, (event) => addNote(event), () => setLoading(false), 100);
    } else {
      subRef.current = subscribeFeed(DEFAULT_RELAYS, (event) => addNote(event), () => setLoading(false), 100);
    }
    return () => { if (subRef.current) subRef.current.close(); };
  }, [tab, account.pk, addNote]);

  function handlePosted(ev) { addNote(ev); }

  return (
    <div className="feed">
      <ComposeBox account={account} onPosted={handlePosted} />
      <div className="feed-tabs">
        <button className={tab === "global" ? "active" : ""} onClick={() => setTab("global")}>🌍 Global</button>
        <button className={tab === "mine" ? "active" : ""} onClick={() => setTab("mine")}>👤 My Posts</button>
      </div>
      {loading && notes.length === 0 && <div className="loading">Connecting to relays…</div>}
      {!loading && notes.length === 0 && tab === "mine" && (
        <div className="loading">No posts yet. Write your first note above!</div>
      )}
      <div className="notes-list">
        {notes.map((ev) => (
          <NoteCard key={ev.id} event={ev} profile={profiles[ev.pubkey]} onClickProfile={onClickProfile} />
        ))}
      </div>
    </div>
  );
}

// ── Account Info Bar ──

function AccountBar({ account, onLogout, onClickProfile, onOpenMessages }) {
  const [showKey, setShowKey] = useState(false);

  return (
    <div className="account-bar">
      <div className="account-info">
        <button
          className="btn-messages"
          onClick={onOpenMessages}
          title="Messages"
        >
          ✉️
        </button>
        <span
          className="account-npub clickable"
          title="View your profile"
          onClick={() => onClickProfile(account.pk)}
        >
          {account.npub.slice(0, 16)}…
        </span>
        {account.nsec && (
          <button
            className="btn-small"
            onClick={() => setShowKey(!showKey)}
            title="Toggle private key visibility"
          >
            {showKey ? "🙈 Hide nsec" : "👁 Show nsec"}
          </button>
        )}
        {showKey && account.nsec && (
          <code className="nsec-display">{account.nsec}</code>
        )}
      </div>
      <button className="btn-logout" onClick={onLogout}>
        Sign Out
      </button>
    </div>
  );
}

// ── App ──

export default function App() {
  const [account, setAccount] = useState(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState("feed");
  const [viewingProfilePk, setViewingProfilePk] = useState(null);
  const [dmTargetPk, setDmTargetPk] = useState(null);

  // Navigate + update hash
  function navigate(newView, profilePk = null, dmPk = null) {
    setView(newView);
    setViewingProfilePk(profilePk);
    setDmTargetPk(dmPk);

    if (newView === "profile" && profilePk) {
      setHash("profile/" + npubEncode(profilePk));
    } else if (newView === "inbox" && dmPk) {
      setHash("messages/" + npubEncode(dmPk));
    } else if (newView === "inbox") {
      setHash("messages");
    } else if (newView === "editProfile") {
      setHash("edit-profile");
    } else {
      setHash("");
    }
    window.scrollTo(0, 0);
  }

  // Read initial hash on mount + listen for back/forward
  useEffect(() => {
    function applyHash() {
      const { route, key } = parseHash();
      const pk = key ? resolvePubkey(key) : null;
      if (route === "profile" && pk) {
        setView("profile");
        setViewingProfilePk(pk);
        setDmTargetPk(null);
      } else if (route === "messages" && pk) {
        setView("inbox");
        setDmTargetPk(pk);
        setViewingProfilePk(null);
      } else if (route === "inbox") {
        setView("inbox");
        setDmTargetPk(null);
        setViewingProfilePk(null);
      } else {
        setView("feed");
        setViewingProfilePk(null);
        setDmTargetPk(null);
      }
    }

    // Apply on mount
    applyHash();

    // Listen for popstate (back/forward buttons)
    window.addEventListener("popstate", applyHash);
    return () => window.removeEventListener("popstate", applyHash);
  }, []);

  // Load saved account
  useEffect(() => {
    const saved = loadAccount();
    if (saved) {
      if (saved.isExtension) {
        if (window.nostr) {
          window.nostr.getPublicKey()
            .then((pk) => { setAccount({ ...saved, pk }); setReady(true); })
            .catch(() => { clearAccount(); setReady(true); });
          return;
        } else {
          clearAccount();
        }
      } else {
        setAccount(saved);
      }
    }
    setReady(true);
  }, []);

  function handleLogin(acc) { setAccount(acc); }

  function handleLogout() {
    clearAccount();
    setAccount(null);
    navigate("feed");
    try { getPool().close(DEFAULT_RELAYS); } catch {}
  }

  function handleClickProfile(pubkey) {
    navigate("profile", pubkey);
  }

  function handleBackToFeed() {
    navigate("feed");
  }

  function handleEditProfile() {
    navigate("editProfile", viewingProfilePk);
  }

  function handleBackFromEdit() {
    if (viewingProfilePk) {
      navigate("profile", viewingProfilePk);
    } else {
      navigate("feed");
    }
  }

  function handleOpenMessages() {
    navigate("inbox");
  }

  function handleSendMessage(pubkey) {
    navigate("inbox", null, pubkey);
  }

  if (!ready) return null;

  if (!account) {
    return <AuthScreen onLogin={handleLogin} />;
  }

  let content;
  if (view === "editProfile") {
    content = (
      <EditProfilePage account={account} onBack={handleBackFromEdit} onSaved={() => {}} />
    );
  } else if (view === "inbox") {
    content = (
      <InboxView
        account={account}
        initialConversation={dmTargetPk}
        onOpenConversation={(pk) => setDmTargetPk(pk)}
        onClickProfile={handleClickProfile}
      />
    );
  } else if (view === "profile" && viewingProfilePk) {
    content = (
      <ProfilePage
        pubkey={viewingProfilePk}
        isOwnProfile={viewingProfilePk === account.pk}
        onBack={handleBackToFeed}
        onClickProfile={handleClickProfile}
        onEditProfile={handleEditProfile}
        onSendMessage={handleSendMessage}
      />
    );
  } else {
    content = (
      <Feed account={account} onClickProfile={handleClickProfile} />
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="clickable" onClick={() => navigate("feed")}>
          🟣 NPC No More
        </h1>
        <AccountBar
          account={account}
          onLogout={handleLogout}
          onClickProfile={handleClickProfile}
          onOpenMessages={handleOpenMessages}
        />
      </header>
      <main>{content}</main>
    </div>
  );
}
