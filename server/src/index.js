import crypto from "crypto";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import session from "express-session";
import { getDb, initDb, upsertLike, upsertUser } from "./db.js";

dotenv.config();

const {
  PORT = 4000,
  SESSION_SECRET = "dev_secret",
  X_CALLBACK_URL,
  X_CLIENT_ID,
  X_CLIENT_SECRET,
  FRONTEND_URL = "http://localhost:5173",
  X_API_BASE = "https://api.x.com",
  X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize",
  X_TOKEN_URL = "https://api.x.com/2/oauth2/token",
  X_SCOPES = "tweet.read users.read like.read offline.access",
  SESSION_SAMESITE = "lax",
  SESSION_SECURE = "false",
} = process.env;

if (!X_CLIENT_ID || !X_CLIENT_SECRET || !X_CALLBACK_URL) {
  console.warn(
    "Missing X OAuth2 credentials. Set X_CLIENT_ID, X_CLIENT_SECRET, X_CALLBACK_URL."
  );
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
const allowedOrigins = new Set(
  [FRONTEND_URL, "http://localhost:5173"].filter(Boolean)
);
if (process.env.EXTRA_CORS_ORIGINS) {
  process.env.EXTRA_CORS_ORIGINS.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((value) => allowedOrigins.add(value));
}

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
      httpOnly: true,
      sameSite: SESSION_SAMESITE,
      secure: SESSION_SECURE === "true",
    },
  })
);

function toFormUrlEncoded(params) {
  return new URLSearchParams(params).toString();
}

function base64UrlEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function createCodeVerifier() {
  return base64UrlEncode(crypto.randomBytes(32));
}

function createCodeChallenge(verifier) {
  return base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
}

function requireAuth(req, res, next) {
  if (!req.session?.accessToken) {
    console.warn("Auth check failed:", {
      sessionId: req.sessionID,
      hasAccessToken: Boolean(req.session?.accessToken),
      hasUserId: Boolean(req.session?.userId),
    });
    return res.status(401).json({ error: "Not authenticated." });
  }
  return next();
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/auth/login", async (req, res) => {
  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  const state = base64UrlEncode(crypto.randomBytes(16));

  req.session.oauthState = state;
  req.session.codeVerifier = verifier;
  console.log("OAuth login: session", req.sessionID, "state", state);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: X_CLIENT_ID || "",
    redirect_uri: X_CALLBACK_URL || "",
    scope: X_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  res.json({ authUrl: `${X_AUTHORIZE_URL}?${params.toString()}` });
});

app.get("/auth/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.status(400).send("Missing authorization code or state.");
  }

  console.log("OAuth callback: session", req.sessionID, "state", state);
  if (state !== req.session.oauthState) {
    return res.status(400).send("State mismatch.");
  }

  const codeVerifier = req.session.codeVerifier;
  if (!codeVerifier) {
    return res.status(400).send("Missing code verifier.");
  }

  try {
    const body = toFormUrlEncoded({
      grant_type: "authorization_code",
      client_id: X_CLIENT_ID,
      redirect_uri: X_CALLBACK_URL,
      code,
      code_verifier: codeVerifier,
    });
    const basicAuth = Buffer.from(
      `${X_CLIENT_ID}:${X_CLIENT_SECRET}`
    ).toString("base64");
    const response = await axios.post(X_TOKEN_URL, body, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
    });

    req.session.accessToken = response.data.access_token;
    req.session.refreshToken = response.data.refresh_token;

    try {
      const meResponse = await axios.get(`${X_API_BASE}/2/users/me`, {
        headers: { Authorization: `Bearer ${req.session.accessToken}` },
      });
      const me = meResponse.data?.data;
      req.session.userId = me?.id;
      req.session.screenName = me?.username;
      if (me?.id && me?.username) {
        const db = await getDb();
        await upsertUser(db, me);
      }
    } catch (error) {
      const status = error?.response?.status;
      const data = error?.response?.data;
      console.error("OAuth me lookup failed:", status, data || error.message);
    }

    req.session.save(() => {
      res.redirect(`${FRONTEND_URL}/?connected=1`);
    });
  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data;
    console.error("OAuth token exchange failed:", status, data || error.message);
    res.redirect(`${FRONTEND_URL}/?connected=0`);
  }
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({
    userId: req.session.userId,
    screenName: req.session.screenName,
  });
});

app.get("/api/db/likes", requireAuth, async (req, res) => {
  const db = await getDb();
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const userId = req.session.userId;
  const totalRow = await db.get(
    "SELECT COUNT(*) AS count FROM likes WHERE user_id = ?",
    [userId]
  );
  const rows = await db.all(
    `
      SELECT likes.id,
             likes.user_id,
             likes.author_id,
             likes.text,
             likes.created_at,
             users.username AS author_username
      FROM likes
      LEFT JOIN users ON users.id = likes.author_id
      WHERE user_id = ?
      ORDER BY datetime(created_at) DESC
      LIMIT ? OFFSET ?
    `,
    [userId, limit, offset]
  );
  res.json({ data: rows, meta: { total: totalRow.count, limit, offset } });
});

app.get("/api/likes", requireAuth, async (req, res) => {
  const maxResults = Math.min(Number(req.query.max_results) || 25, 100);
  const paginationToken = req.query.pagination_token;
  const userId = req.session.userId;
  if (!userId) {
    return res.status(400).json({ error: "Missing user id." });
  }

  const params = {
    max_results: maxResults,
    "tweet.fields": "created_at,author_id",
    "user.fields": "username,name",
    expansions: "author_id",
  };
  if (paginationToken) params.pagination_token = paginationToken;

  try {
    const response = await axios.get(
      `${X_API_BASE}/2/users/${userId}/liked_tweets`,
      {
        params,
        headers: { Authorization: `Bearer ${req.session.accessToken}` },
      }
    );
    res.json(response.data);
  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data;
    console.error("Likes fetch failed:", status, data || error.message);
    res.status(500).json({ error: "Failed to fetch likes." });
  }
});

app.post("/api/sync", requireAuth, async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(400).json({ error: "Missing user id." });
  }

  const maxResults = 100;
  const baseParams = {
    max_results: maxResults,
    "tweet.fields": "created_at,author_id",
    "user.fields": "username,name",
    expansions: "author_id",
  };

  const db = await getDb();
  const maxPages = Number(req.query.max_pages) || 50;
  let paginationToken = null;
  let pageCount = 0;
  let inserted = 0;

  try {
    while (pageCount < maxPages) {
      const params = { ...baseParams };
      if (paginationToken) params.pagination_token = paginationToken;
      const response = await axios.get(
        `${X_API_BASE}/2/users/${userId}/liked_tweets`,
        {
          params,
          headers: { Authorization: `Bearer ${req.session.accessToken}` },
        }
      );
      const data = response.data?.data || [];
      const users = response.data?.includes?.users || [];

      for (const user of users) {
        await upsertUser(db, user);
      }

      for (const like of data) {
        await upsertLike(db, like, userId);
        inserted += 1;
      }

      paginationToken = response.data?.meta?.next_token || null;
      pageCount += 1;
      if (!paginationToken || data.length === 0) break;
    }

    res.json({ ok: true, inserted, pages: pageCount });
  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data;
    console.error("Sync failed:", status, data || error.message);
    res.status(500).json({ error: "Failed to sync likes." });
  }
});

app.get("/api/export", requireAuth, async (req, res) => {
  const userId = req.session.userId;
  if (!userId) {
    return res.status(400).json({ error: "Missing user id." });
  }

  try {
    const maxResults = 100;
    const baseParams = {
      max_results: maxResults,
      "tweet.fields": "created_at,author_id",
      "user.fields": "username,name",
      expansions: "author_id",
    };
    const allLikes = [];
    const usersById = new Map();
    let paginationToken = null;
    let pageCount = 0;
    const maxPages = Number(req.query.max_pages) || 50;

    while (pageCount < maxPages) {
      const params = { ...baseParams };
      if (paginationToken) params.pagination_token = paginationToken;
      const response = await axios.get(
        `${X_API_BASE}/2/users/${userId}/liked_tweets`,
        {
          params,
          headers: { Authorization: `Bearer ${req.session.accessToken}` },
        }
      );
      const data = response.data?.data || [];
      const users = response.data?.includes?.users || [];

      data.forEach((item) => allLikes.push(item));
      users.forEach((user) => usersById.set(user.id, user));

      paginationToken = response.data?.meta?.next_token || null;
      pageCount += 1;
      if (!paginationToken || data.length === 0) break;
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", "attachment; filename=likes.json");
    res.send(
      JSON.stringify(
        {
          data: allLikes,
          includes: { users: Array.from(usersById.values()) },
          meta: { total: allLikes.length },
        },
        null,
        2
      )
    );
  } catch (error) {
    const status = error?.response?.status;
    const data = error?.response?.data;
    console.error("Export failed:", status, data || error.message);
    res.status(500).json({ error: "Failed to export likes." });
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

await initDb();

app.listen(PORT, () => {
  console.log(`XLike server listening on ${PORT}`);
});
