import { useState, useEffect, useCallback, useRef } from "react";
import {
  createAccount,
  loginWithNsec,
  loginWithExtension,
  publishNote,
  publishProfile,
  subscribeFeed,
  subscribeUserFeed,
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
import { npubEncode } from "nostr-tools/nip19";
import "./App.css";

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

  // Load existing profile
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
        <button className="btn-back" onClick={onBack}>
          ← Back
        </button>
        <div className="loading">Loading your profile…</div>
      </div>
    );
  }

  return (
    <div className="edit-profile-page">
      <button className="btn-back" onClick={onBack}>
        ← Back
      </button>

      <div className="edit-profile-card">
        <h2>Edit Profile</h2>
        <p className="edit-profile-hint">
          Your profile is published to relays as a kind 0 event. All fields are
          optional.
        </p>

        {/* Preview */}
        <div className="edit-preview">
          {banner && (
            <div className="edit-preview-banner">
              <img src={banner} alt="" />
            </div>
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
              <div className="edit-preview-name">
                {displayName || name || "Anonymous"}
              </div>
              {nip05 && (
                <div className="edit-preview-nip05">✅ {nip05}</div>
              )}
            </div>
          </div>
          {about && <p className="edit-preview-about">{about}</p>}
        </div>

        {/* Form */}
        <div className="edit-form">
          <label>
            <span>Display Name</span>
            <input
              type="text"
              placeholder="How you want to be known"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>

          <label>
            <span>Username</span>
            <input
              type="text"
              placeholder="short handle (no spaces)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label>
            <span>About</span>
            <textarea
              placeholder="Tell the world about yourself…"
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              rows={3}
            />
          </label>

          <label>
            <span>Profile Picture URL</span>
            <input
              type="url"
              placeholder="https://example.com/avatar.jpg"
              value={picture}
              onChange={(e) => setPicture(e.target.value)}
            />
          </label>

          <label>
            <span>Banner Image URL</span>
            <input
              type="url"
              placeholder="https://example.com/banner.jpg"
              value={banner}
              onChange={(e) => setBanner(e.target.value)}
            />
          </label>

          <label>
            <span>Website</span>
            <input
              type="url"
              placeholder="https://yoursite.com"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </label>

          <label>
            <span>NIP-05 Identifier</span>
            <input
              type="text"
              placeholder="you@yoursite.com"
              value={nip05}
              onChange={(e) => setNip05(e.target.value)}
            />
          </label>

          <label>
            <span>Lightning Address</span>
            <input
              type="text"
              placeholder="you@walletofsatoshi.com"
              value={lud16}
              onChange={(e) => setLud16(e.target.value)}
            />
          </label>
        </div>

        {error && <p className="error">{error}</p>}
        {saved && (
          <p className="success">✅ Profile saved and published to relays!</p>
        )}

        <div className="edit-actions">
          <button className="btn-back" onClick={onBack}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Publishing…" : "💾 Save Profile"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Profile Page ──

function ProfilePage({ pubkey, isOwnProfile, onBack, onClickProfile, onEditProfile }) {
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
      .then((p) => {
        setProfile(p);
        setLoadingProfile(false);
      })
      .catch(() => setLoadingProfile(false));
  }, [pubkey]);

  const addNote = useCallback((event) => {
    setNotes((prev) => {
      if (prev.find((n) => n.id === event.id)) return prev;
      const updated = [event, ...prev].sort(
        (a, b) => b.created_at - a.created_at
      );
      notesRef.current = updated;
      return updated;
    });
  }, []);

  useEffect(() => {
    const interval = setInterval(async () => {
      const unknownPubkeys = [
        ...new Set(notesRef.current.map((n) => n.pubkey)),
      ].filter((pk) => !profileCacheRef.current[pk]);
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

  useEffect(() => {
    setLoadingNotes(true);
    notesRef.current = [];
    setNotes([]);
    if (subRef.current) subRef.current.close();
    subRef.current = subscribeUserFeed(
      DEFAULT_RELAYS,
      pubkey,
      (event) => addNote(event),
      () => setLoadingNotes(false),
      50
    );
    return () => {
      if (subRef.current) subRef.current.close();
    };
  }, [pubkey, addNote]);

  const meta = profile || {};
  const displayName = meta.display_name || meta.name || shortPubkey(pubkey);
  const avatar = meta.picture || null;
  const banner = meta.banner || null;

  return (
    <div className="profile-page">
      <button className="btn-back" onClick={onBack}>
        ← Back
      </button>

      {banner && (
        <div className="profile-banner">
          <img src={banner} alt="" />
        </div>
      )}

      <div className="profile-card">
        <div className="profile-avatar-large">
          {avatar ? (
            <img src={avatar} alt="" />
          ) : (
            <div className="avatar-placeholder large">
              {displayName.charAt(0).toUpperCase()}
            </div>
          )}
        </div>

        <div className="profile-info">
          <div className="profile-name-row">
            <h2 className="profile-name">{displayName}</h2>
            {isOwnProfile && (
              <button className="btn-edit" onClick={onEditProfile}>
                ✏️ Edit Profile
              </button>
            )}
          </div>
          {meta.nip05 && (
            <span className="profile-nip05">✅ {meta.nip05}</span>
          )}
          <code className="profile-npub">{npub}</code>
          {meta.about && <p className="profile-about">{meta.about}</p>}

          <div className="profile-details">
            {meta.website && (
              <a
                className="profile-link"
                href={
                  meta.website.startsWith("http")
                    ? meta.website
                    : "https://" + meta.website
                }
                target="_blank"
                rel="noopener"
              >
                🔗 {meta.website}
              </a>
            )}
            {meta.lud16 && (
              <span className="profile-detail">⚡ {meta.lud16}</span>
            )}
          </div>
        </div>
      </div>

      {loadingProfile && !profile && (
        <div className="loading">Loading profile…</div>
      )}

      <h3 className="profile-posts-heading">Posts</h3>

      {loadingNotes && notes.length === 0 && (
        <div className="loading">Loading notes…</div>
      )}
      {!loadingNotes && notes.length === 0 && (
        <div className="loading">No posts found.</div>
      )}

      <div className="notes-list">
        {notes.map((ev) => (
          <NoteCard
            key={ev.id}
            event={ev}
            profile={
              ev.pubkey === pubkey ? profile : profiles[ev.pubkey]
            }
            onClickProfile={onClickProfile}
          />
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
      const updated = [event, ...prev].sort(
        (a, b) => b.created_at - a.created_at
      );
      notesRef.current = updated;
      return updated;
    });
  }, []);

  useEffect(() => {
    const interval = setInterval(async () => {
      const unknownPubkeys = [
        ...new Set(notesRef.current.map((n) => n.pubkey)),
      ].filter((pk) => !profileCacheRef.current[pk]);
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

  useEffect(() => {
    setLoading(true);
    notesRef.current = [];
    setNotes([]);
    if (subRef.current) subRef.current.close();
    if (tab === "mine") {
      subRef.current = subscribeUserFeed(
        DEFAULT_RELAYS,
        account.pk,
        (event) => addNote(event),
        () => setLoading(false),
        100
      );
    } else {
      subRef.current = subscribeFeed(
        DEFAULT_RELAYS,
        (event) => addNote(event),
        () => setLoading(false),
        100
      );
    }
    return () => {
      if (subRef.current) subRef.current.close();
    };
  }, [tab, account.pk, addNote]);

  function handlePosted(ev) {
    addNote(ev);
  }

  return (
    <div className="feed">
      <ComposeBox account={account} onPosted={handlePosted} />

      <div className="feed-tabs">
        <button
          className={tab === "global" ? "active" : ""}
          onClick={() => setTab("global")}
        >
          🌍 Global
        </button>
        <button
          className={tab === "mine" ? "active" : ""}
          onClick={() => setTab("mine")}
        >
          👤 My Posts
        </button>
      </div>

      {loading && notes.length === 0 && (
        <div className="loading">Connecting to relays…</div>
      )}
      {!loading && notes.length === 0 && tab === "mine" && (
        <div className="loading">
          No posts yet. Write your first note above!
        </div>
      )}
      <div className="notes-list">
        {notes.map((ev) => (
          <NoteCard
            key={ev.id}
            event={ev}
            profile={profiles[ev.pubkey]}
            onClickProfile={onClickProfile}
          />
        ))}
      </div>
    </div>
  );
}

// ── Account Info Bar ──

function AccountBar({ account, onLogout, onClickProfile }) {
  const [showKey, setShowKey] = useState(false);

  return (
    <div className="account-bar">
      <div className="account-info">
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
  // view: "feed" | "profile" | "editProfile"
  const [view, setView] = useState("feed");
  const [viewingProfilePk, setViewingProfilePk] = useState(null);

  useEffect(() => {
    const saved = loadAccount();
    if (saved) {
      if (saved.isExtension) {
        if (window.nostr) {
          window.nostr
            .getPublicKey()
            .then((pk) => {
              setAccount({ ...saved, pk });
              setReady(true);
            })
            .catch(() => {
              clearAccount();
              setReady(true);
            });
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

  function handleLogin(acc) {
    setAccount(acc);
  }

  function handleLogout() {
    clearAccount();
    setAccount(null);
    setView("feed");
    setViewingProfilePk(null);
    try {
      getPool().close(DEFAULT_RELAYS);
    } catch {}
  }

  function handleClickProfile(pubkey) {
    setViewingProfilePk(pubkey);
    setView("profile");
    window.scrollTo(0, 0);
  }

  function handleBackToFeed() {
    setView("feed");
    setViewingProfilePk(null);
  }

  function handleEditProfile() {
    setView("editProfile");
    window.scrollTo(0, 0);
  }

  function handleProfileSaved() {
    // After saving, go back to own profile to see changes
  }

  function handleBackFromEdit() {
    // Go back to profile view
    if (viewingProfilePk) {
      setView("profile");
    } else {
      setView("feed");
    }
    window.scrollTo(0, 0);
  }

  if (!ready) return null;

  if (!account) {
    return <AuthScreen onLogin={handleLogin} />;
  }

  let content;
  if (view === "editProfile") {
    content = (
      <EditProfilePage
        account={account}
        onBack={handleBackFromEdit}
        onSaved={handleProfileSaved}
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
        <h1
          className="clickable"
          onClick={() => {
            setView("feed");
            setViewingProfilePk(null);
          }}
        >
          🟣 NPC No More
        </h1>
        <AccountBar
          account={account}
          onLogout={handleLogout}
          onClickProfile={handleClickProfile}
        />
      </header>
      <main>{content}</main>
    </div>
  );
}
