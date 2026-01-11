XLike
=====

Hostable web app to download your liked posts from X using OAuth 2.0 and export as JSON.

Structure
---------
- `server/` Node + Express API (OAuth flow + likes export)
- `client/` React frontend (connect, preview, download JSON)

Setup
-----
1) Copy env file and fill values:

```sh
cp server/.env.example server/.env
```

2) Install dependencies:

```sh
cd server && npm install
cd ../client && npm install
```

3) Start both:

```sh
cd server && npm run dev
cd ../client && npm run dev
```

Notes
-----
- Set `X_CALLBACK_URL` to your public HTTPS callback URL (X does not allow localhost).
- If the X API base changes, set `X_API_BASE` in `.env` (default `https://api.x.com`).
- For production, replace the in-memory session store with Redis or another persistent store.
- For cross-site cookies (different frontend/backend domains), set `SESSION_SAMESITE=none` and `SESSION_SECURE=true`.
- The server stores likes in a local SQLite database (`server/xlike.db` by default). Set `DB_PATH` to change it.

Database Sync
-------------
- `POST /api/sync` fetches likes from X and upserts them into SQLite.
- `GET /api/db/likes?limit=200&offset=0` returns stored likes (paginated).

TODO
----
- Include media expansions (images/videos) in likes export.
