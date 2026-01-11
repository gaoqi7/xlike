import React, { useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:4000";

async function fetchJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...options,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Request failed");
  }
  return response.json();
}

export default function App() {
  const [likes, setLikes] = useState([]);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [me, setMe] = useState(null);
  const [usersById, setUsersById] = useState({});
  const [info, setInfo] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected") === "1") {
      loadProfile();
    }
  }, []);

  async function loadProfile() {
    try {
      const data = await fetchJson("/api/me");
      setMe(data);
    } catch (err) {
      setMe(null);
    }
  }

  async function connect() {
    setError("");
    setStatus("connecting");
    try {
      const data = await fetchJson("/auth/login", { method: "POST" });
      window.location.href = data.authUrl;
    } catch (err) {
      setError("Failed to start OAuth flow.");
      setStatus("idle");
    }
  }

  async function loadLikes() {
    setError("");
    setInfo("");
    setStatus("loading");
    try {
      const maxPages = 50;
      const allLikes = [];
      const usersMap = {};
      let nextToken = null;
      let page = 0;

      while (page < maxPages) {
        const params = new URLSearchParams();
        params.set("max_results", "100");
        if (nextToken) params.set("pagination_token", nextToken);
        const data = await fetchJson(`/api/likes?${params.toString()}`);
        const items = data.data || [];
        const includes = data.includes?.users || [];
        items.forEach((item) => allLikes.push(item));
        includes.forEach((user) => {
          usersMap[user.id] = user.username;
        });
        nextToken = data.meta?.next_token || null;
        page += 1;
        if (!nextToken || items.length === 0) break;
      }

      setLikes(allLikes);
      setUsersById(usersMap);
      setStatus("ready");
    } catch (err) {
      setError("Failed to load likes.");
      setStatus("idle");
    }
  }

  async function loadLikesFromDb() {
    setError("");
    setInfo("");
    setStatus("loading");
    try {
      const limit = 200;
      let offset = 0;
      let total = 0;
      const allLikes = [];
      const usersMap = {};

      while (true) {
        const params = new URLSearchParams();
        params.set("limit", String(limit));
        params.set("offset", String(offset));
        const data = await fetchJson(`/api/db/likes?${params.toString()}`);
        const items = data.data || [];
        total = data.meta?.total || 0;
        items.forEach((item) => {
          allLikes.push(item);
          if (item.author_id && item.author_username) {
            usersMap[item.author_id] = item.author_username;
          }
        });
        offset += items.length;
        if (items.length === 0 || offset >= total) break;
      }

      setLikes(allLikes);
      setUsersById(usersMap);
      setInfo(`Loaded ${allLikes.length} likes from local DB.`);
      setStatus("ready");
    } catch (err) {
      setError("Failed to load likes from DB.");
      setStatus("idle");
    }
  }

  async function syncLikesToDb() {
    setError("");
    setInfo("");
    setStatus("loading");
    try {
      const response = await fetchJson("/api/sync", { method: "POST" });
      setInfo(
        `Sync complete. Pages: ${response.pages}, items saved: ${response.inserted}.`
      );
      setStatus("ready");
    } catch (err) {
      setError("Failed to sync likes to DB.");
      setStatus("idle");
    }
  }

  async function downloadJson() {
    setError("");
    try {
      const response = await fetch(`${API_BASE}/api/export`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("export failed");
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "likes.json";
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError("Failed to export likes.");
    }
  }

  async function logout() {
    try {
      await fetchJson("/auth/logout", { method: "POST" });
    } catch (err) {
      // ignore
    } finally {
      setLikes([]);
      setMe(null);
    }
  }

  return (
    <div className="page">
      <header className="hero">
        <h1>XLike</h1>
        <p>Download your liked posts from X using OAuth 2.0.</p>
      </header>

      <section className="panel">
        <div className="actions">
          <button onClick={connect} disabled={status === "connecting"}>
            Connect X
          </button>
          <button onClick={loadLikes} disabled={status === "loading"}>
            Load Likes
          </button>
          <button onClick={syncLikesToDb} disabled={status === "loading"}>
            Sync DB
          </button>
          <button onClick={loadLikesFromDb} disabled={status === "loading"}>
            Load from DB
          </button>
          <button onClick={downloadJson} disabled={!likes.length}>
            Download JSON
          </button>
          <button onClick={logout}>Logout</button>
        </div>

        {me && (
          <div className="profile">
            <span>Connected as @{me.screenName}</span>
            <span className="count">Likes loaded: {likes.length}</span>
          </div>
        )}

        {error && <div className="error">{error}</div>}
        {info && <div className="info">{info}</div>}

        <div className="likes">
          {likes.length === 0 && (
            <div className="empty">No likes loaded yet.</div>
          )}
          {likes.map((like) => (
            <article key={like.id} className="like-card">
              <div className="like-meta">
                <strong>
                  @{usersById[like.author_id] || like.author_username || like.author_id}
                </strong>
                <span>{new Date(like.created_at).toLocaleString()}</span>
              </div>
              <p>{like.text}</p>
              <a
                href={`https://x.com/i/web/status/${like.id}`}
                target="_blank"
                rel="noreferrer"
              >
                View on X
              </a>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
