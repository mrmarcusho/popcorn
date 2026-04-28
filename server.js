//loading env file so MONGODB_URI works
require("dotenv").config();

//only built-in node modules from here, plus mongo driver and bcrypt for hashing
var http = require("http");
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var bcrypt = require("bcryptjs");
var { MongoClient, ObjectId } = require("mongodb");

var PORT = process.env.PORT || 3001;
var mongoUri = process.env.MONGODB_URI;
var omdbKey = process.env.OMDB_API_KEY;

//mongo client we use for the whole server
var client = new MongoClient(mongoUri);
var db = null;
var dbReadyPromise = null;

function ensureDb() {
  if (db) return Promise.resolve(db);
  if (dbReadyPromise) return dbReadyPromise;
  if (!mongoUri) return Promise.reject(new Error("need MONGODB_URI env var"));
  dbReadyPromise = client.connect().then(async function () {
    db = client.db("popcorn");
    await db.collection("users").createIndex({ username: 1 }, { unique: true });
    await db.collection("user_movies").createIndex({ userId: 1, imdbId: 1 }, { unique: true });
    await db.collection("sessions").createIndex({ token: 1 }, { unique: true });
    await db.collection("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    console.log("mongodb connected");
    return db;
  }).catch(function (err) {
    dbReadyPromise = null;
    throw err;
  });
  return dbReadyPromise;
}

//---------- tiny helpers for raw http ----------

//send json with status code
function sendJson(res, status, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

//collect request body and parse as json
function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var size = 0;
    req.on("data", function (c) {
      size += c.length;
      //hard cap so a giant body cant crash us
      if (size > 1e6) {
        reject(new Error("body too big"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", function () {
      var raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

//cookie header looks like "sid=abc; other=foo"
function parseCookies(req) {
  var out = {};
  var header = req.headers.cookie;
  if (!header) return out;
  var parts = header.split(";");
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    var eq = p.indexOf("=");
    if (eq < 0) continue;
    out[p.slice(0, eq)] = decodeURIComponent(p.slice(eq + 1));
  }
  return out;
}

//build a Set-Cookie header string
function buildSetCookie(name, value, opts) {
  opts = opts || {};
  var s = name + "=" + encodeURIComponent(value);
  s += "; Path=/";
  s += "; HttpOnly";
  s += "; SameSite=Lax";
  if (opts.maxAge != null) s += "; Max-Age=" + opts.maxAge;
  return s;
}

//---------- session helpers ----------

var SESSION_COOKIE = "sid";
var SESSION_DAYS = 7;

async function createSession(userId, username) {
  var token = crypto.randomBytes(32).toString("hex");
  var expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.collection("sessions").insertOne({
    token: token,
    userId: new ObjectId(userId),
    username: username,
    expiresAt: expiresAt,
  });
  return token;
}

async function loadSession(req) {
  var cookies = parseCookies(req);
  var token = cookies[SESSION_COOKIE];
  if (!token) return null;
  var row = await db.collection("sessions").findOne({ token: token });
  if (!row) return null;
  if (row.expiresAt && row.expiresAt < new Date()) {
    await db.collection("sessions").deleteOne({ token: token });
    return null;
  }
  return row;
}

async function destroySession(token) {
  if (!token) return;
  await db.collection("sessions").deleteOne({ token: token });
}

//---------- static file serving ----------

var MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

var PUBLIC_DIR = path.join(__dirname, "public");

function serveStatic(req, res, urlPath) {
  //default to index.html for /
  var rel = urlPath === "/" ? "/index.html" : urlPath;
  //resolve and make sure they didnt try to escape public/
  var filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (filePath.indexOf(PUBLIC_DIR) !== 0) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

//---------- route handlers ----------

async function handleRegister(req, res) {
  var body = await readJsonBody(req);
  var username = (body.username || "").trim();
  var password = body.password || "";
  if (username.length < 2 || password.length < 4) {
    return sendJson(res, 400, { ok: false, error: "username or password too short" });
  }
  var users = db.collection("users");
  var existing = await users.findOne({ username: username });
  if (existing) {
    return sendJson(res, 400, { ok: false, error: "username already taken" });
  }
  var hash = bcrypt.hashSync(password, 10);
  var result = await users.insertOne({ username: username, passwordHash: hash, createdAt: new Date() });
  var token = await createSession(result.insertedId, username);
  res.setHeader("Set-Cookie", buildSetCookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 24 * 60 * 60 }));
  sendJson(res, 200, { ok: true, username: username });
}

async function handleLogin(req, res) {
  var body = await readJsonBody(req);
  var username = (body.username || "").trim();
  var password = body.password || "";
  var users = db.collection("users");
  var user = await users.findOne({ username: username });
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return sendJson(res, 400, { ok: false, error: "wrong username or password" });
  }
  var token = await createSession(user._id, user.username);
  res.setHeader("Set-Cookie", buildSetCookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 24 * 60 * 60 }));
  sendJson(res, 200, { ok: true, username: user.username });
}

async function handleLogout(req, res) {
  var cookies = parseCookies(req);
  await destroySession(cookies[SESSION_COOKIE]);
  res.setHeader("Set-Cookie", buildSetCookie(SESSION_COOKIE, "", { maxAge: 0 }));
  sendJson(res, 200, { ok: true });
}

async function handleMe(req, res, ctx) {
  if (!ctx.session) return sendJson(res, 200, { ok: true, loggedIn: false });
  sendJson(res, 200, { ok: true, loggedIn: true, username: ctx.session.username });
}

async function handleSearch(req, res, ctx, urlObj) {
  if (!omdbKey) return sendJson(res, 500, { ok: false, error: "OMDB_API_KEY missing in .env" });
  var q = (urlObj.searchParams.get("q") || "").trim();
  if (q.length < 1) return sendJson(res, 200, { ok: true, results: [] });
  var url = "https://www.omdbapi.com/?apikey=" + encodeURIComponent(omdbKey) + "&s=" + encodeURIComponent(q);
  var r = await fetch(url);
  var data = await r.json();
  if (data.Response === "False" || !data.Search) {
    return sendJson(res, 200, { ok: true, results: [], message: data.Error || "" });
  }
  var results = data.Search.map(function (item) {
    return {
      imdbId: item.imdbID,
      title: item.Title,
      year: item.Year,
      poster: item.Poster && item.Poster !== "N/A" ? item.Poster : "",
      type: item.Type,
    };
  });
  sendJson(res, 200, { ok: true, results: results });
}

async function handleDetail(req, res, ctx, urlObj) {
  if (!omdbKey) return sendJson(res, 500, { ok: false, error: "OMDB_API_KEY missing in .env" });
  var id = (urlObj.searchParams.get("id") || "").trim();
  if (!id) return sendJson(res, 400, { ok: false, error: "missing id" });
  var url = "https://www.omdbapi.com/?apikey=" + encodeURIComponent(omdbKey) + "&i=" + encodeURIComponent(id) + "&plot=short";
  var r = await fetch(url);
  var data = await r.json();
  if (data.Response === "False") {
    return sendJson(res, 404, { ok: false, error: data.Error || "not found" });
  }
  //genre is a comma string from omdb, split for our recommender later
  var genres = [];
  if (data.Genre && typeof data.Genre === "string") {
    genres = data.Genre.split(",").map(function (g) { return g.trim(); }).filter(Boolean);
  }
  sendJson(res, 200, {
    ok: true,
    movie: {
      imdbId: data.imdbID,
      title: data.Title,
      year: data.Year,
      poster: data.Poster && data.Poster !== "N/A" ? data.Poster : "",
      plot: data.Plot && data.Plot !== "N/A" ? data.Plot : "No description.",
      genres: genres,
    },
  });
}

async function handleListMyMovies(req, res, ctx, urlObj) {
  var userId = new ObjectId(ctx.session.userId);
  var filter = { userId: userId };
  var status = urlObj.searchParams.get("status");
  if (status === "want" || status === "seen") filter.status = status;
  var sortMode = urlObj.searchParams.get("sort") || "added";
  var sortObj = { updatedAt: -1 };
  if (status === "seen") {
    if (sortMode === "rating_high") sortObj = { rating: -1, title: 1 };
    else if (sortMode === "rating_low") sortObj = { rating: 1, title: 1 };
    else if (sortMode === "title") sortObj = { title: 1 };
  } else if (status === "want" && sortMode === "title") {
    sortObj = { title: 1 };
  }
  var docs = await db.collection("user_movies").find(filter).sort(sortObj).toArray();
  sendJson(res, 200, { ok: true, movies: docs });
}

async function handleSaveMyMovie(req, res, ctx) {
  var body = await readJsonBody(req);
  var userId = new ObjectId(ctx.session.userId);
  var imdbId = (body.imdbId || "").trim();
  var title = (body.title || "").trim();
  var poster = body.poster || "";
  var plot = body.plot || "";
  var status = body.status;
  var genres = Array.isArray(body.genres) ? body.genres.filter(function (g) { return typeof g === "string"; }) : [];
  if (!imdbId || !title) return sendJson(res, 400, { ok: false, error: "missing movie info" });
  if (status !== "want" && status !== "seen") return sendJson(res, 400, { ok: false, error: "status should be want or seen" });

  var rating = parseInt(body.rating, 10);
  var reviewText = (body.reviewText || "").trim();
  if (status === "seen") {
    if (isNaN(rating) || rating < 1 || rating > 5) {
      return sendJson(res, 400, { ok: false, error: "rating must be 1-5 for seen movies" });
    }
  } else {
    rating = null;
    reviewText = "";
  }
  var now = new Date();
  await db.collection("user_movies").updateOne(
    { userId: userId, imdbId: imdbId },
    {
      $set: {
        userId: userId,
        imdbId: imdbId,
        title: title,
        poster: poster,
        plot: plot,
        genres: genres,
        status: status,
        rating: status === "seen" ? rating : null,
        reviewText: status === "seen" ? reviewText : "",
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
  sendJson(res, 200, { ok: true });
}

async function handleDeleteMyMovie(req, res, ctx, urlObj, params) {
  var userId = new ObjectId(ctx.session.userId);
  await db.collection("user_movies").deleteOne({ userId: userId, imdbId: params.imdbId });
  sendJson(res, 200, { ok: true });
}

//---------- discover (popular picks for the home page) ----------

//hand-picked timeless titles so the home page has something nice to show
var DISCOVER_IDS = [
  "tt0111161", "tt0068646", "tt0468569", "tt0050083",
  "tt0167260", "tt1375666", "tt0137523", "tt0109830",
  "tt0816692", "tt0133093", "tt0120737", "tt0245429",
];

//cached so we dont hit OMDB on every page load
var discoverCache = null;
var discoverCacheTime = 0;
var DISCOVER_TTL_MS = 60 * 60 * 1000;

async function fetchOneOmdb(id) {
  var url = "https://www.omdbapi.com/?apikey=" + encodeURIComponent(omdbKey) + "&i=" + encodeURIComponent(id) + "&plot=short";
  var r = await fetch(url);
  var data = await r.json();
  if (data.Response === "False") return null;
  var genres = [];
  if (data.Genre && typeof data.Genre === "string") {
    genres = data.Genre.split(",").map(function (g) { return g.trim(); }).filter(Boolean);
  }
  return {
    imdbId: data.imdbID,
    title: data.Title,
    year: data.Year,
    poster: data.Poster && data.Poster !== "N/A" ? data.Poster : "",
    plot: data.Plot && data.Plot !== "N/A" ? data.Plot : "",
    genres: genres,
  };
}

async function handleDiscover(req, res) {
  if (!omdbKey) return sendJson(res, 500, { ok: false, error: "OMDB_API_KEY missing in .env" });
  var now = Date.now();
  if (discoverCache && now - discoverCacheTime < DISCOVER_TTL_MS) {
    return sendJson(res, 200, { ok: true, movies: discoverCache });
  }
  try {
    var results = await Promise.all(DISCOVER_IDS.map(fetchOneOmdb));
    var movies = results.filter(function (m) { return m; });
    discoverCache = movies;
    discoverCacheTime = now;
    sendJson(res, 200, { ok: true, movies: movies });
  } catch (e) {
    console.log("discover error", e);
    sendJson(res, 500, { ok: false, error: "could not load discover" });
  }
}

//---------- recommendations ----------

async function handleRecommendations(req, res, ctx) {
  if (!omdbKey) return sendJson(res, 500, { ok: false, error: "OMDB_API_KEY missing in .env" });
  var userId = new ObjectId(ctx.session.userId);
  var col = db.collection("user_movies");
  var seen = await col.find({ userId: userId, status: "seen" }).toArray();
  if (seen.length === 0) {
    return sendJson(res, 200, { ok: true, recommendations: [], message: "rate a few movies first" });
  }
  //tally genre points = sum of ratings on movies of that genre
  var tally = {};
  for (var i = 0; i < seen.length; i++) {
    var m = seen[i];
    var r = m.rating || 0;
    var gs = m.genres || [];
    for (var j = 0; j < gs.length; j++) {
      tally[gs[j]] = (tally[gs[j]] || 0) + r;
    }
  }
  var ranked = Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; });
  var topGenres = ranked.slice(0, 2);
  if (topGenres.length === 0) {
    return sendJson(res, 200, { ok: true, recommendations: [], message: "no genre data yet" });
  }
  //exclude anything user already saved
  var allMine = await col.find({ userId: userId }).project({ imdbId: 1 }).toArray();
  var excluded = {};
  for (var k = 0; k < allMine.length; k++) excluded[allMine[k].imdbId] = true;

  //OMDB has no discover-by-genre endpoint, so we search the genre name and filter locally
  var picks = [];
  var seenIds = {};
  for (var g = 0; g < topGenres.length; g++) {
    var url = "https://www.omdbapi.com/?apikey=" + encodeURIComponent(omdbKey) + "&s=" + encodeURIComponent(topGenres[g]) + "&type=movie";
    try {
      var r2 = await fetch(url);
      var data = await r2.json();
      if (data.Search) {
        for (var n = 0; n < data.Search.length; n++) {
          var item = data.Search[n];
          if (excluded[item.imdbID] || seenIds[item.imdbID]) continue;
          seenIds[item.imdbID] = true;
          picks.push({
            imdbId: item.imdbID,
            title: item.Title,
            year: item.Year,
            poster: item.Poster && item.Poster !== "N/A" ? item.Poster : "",
            reasonGenre: topGenres[g],
          });
          if (picks.length >= 10) break;
        }
      }
    } catch (e) {
      console.log("rec fetch failed", e);
    }
    if (picks.length >= 10) break;
  }
  sendJson(res, 200, { ok: true, recommendations: picks, topGenres: topGenres });
}

//---------- router ----------

function requireLogin(handler) {
  return async function (req, res, ctx, urlObj, params) {
    if (!ctx.session) return sendJson(res, 401, { ok: false, error: "not logged in" });
    return handler(req, res, ctx, urlObj, params);
  };
}

//table of api routes; path can include :param tokens
var ROUTES = [
  { method: "POST", path: "/api/register", handler: handleRegister },
  { method: "POST", path: "/api/login", handler: handleLogin },
  { method: "POST", path: "/api/logout", handler: handleLogout },
  { method: "GET",  path: "/api/me", handler: handleMe },
  { method: "GET",  path: "/api/discover", handler: handleDiscover },
  { method: "GET",  path: "/api/movies/search", handler: requireLogin(handleSearch) },
  { method: "GET",  path: "/api/movies/detail", handler: requireLogin(handleDetail) },
  { method: "GET",  path: "/api/my-movies", handler: requireLogin(handleListMyMovies) },
  { method: "POST", path: "/api/my-movies", handler: requireLogin(handleSaveMyMovie) },
  { method: "DELETE", path: "/api/my-movies/:imdbId", handler: requireLogin(handleDeleteMyMovie) },
  { method: "GET",  path: "/api/recommendations", handler: requireLogin(handleRecommendations) },
];

//match a request path against a route pattern with :param tokens
function matchRoute(method, pathname) {
  for (var i = 0; i < ROUTES.length; i++) {
    var r = ROUTES[i];
    if (r.method !== method) continue;
    if (r.path.indexOf(":") < 0) {
      if (r.path === pathname) return { route: r, params: {} };
      continue;
    }
    var routeParts = r.path.split("/");
    var pathParts = pathname.split("/");
    if (routeParts.length !== pathParts.length) continue;
    var params = {};
    var ok = true;
    for (var j = 0; j < routeParts.length; j++) {
      if (routeParts[j].startsWith(":")) {
        params[routeParts[j].slice(1)] = decodeURIComponent(pathParts[j]);
      } else if (routeParts[j] !== pathParts[j]) {
        ok = false; break;
      }
    }
    if (ok) return { route: r, params: params };
  }
  return null;
}

async function handleApi(req, res, urlObj) {
  try {
    await ensureDb();
  } catch (e) {
    console.log("db connect error", e);
    return sendJson(res, 500, { ok: false, error: "database not ready" });
  }
  var match = matchRoute(req.method, urlObj.pathname);
  if (!match) return sendJson(res, 404, { ok: false, error: "no such route" });
  var session = await loadSession(req);
  var ctx = { session: session };
  try {
    await match.route.handler(req, res, ctx, urlObj, match.params);
  } catch (e) {
    console.log("handler error", e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: "server error" });
  }
}

async function router(req, res) {
  var urlObj = new URL(req.url, "http://localhost");
  if (urlObj.pathname.startsWith("/api/")) {
    return handleApi(req, res, urlObj);
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405); res.end("method not allowed"); return;
  }
  serveStatic(req, res, urlObj.pathname);
}

//---------- start ----------

async function start() {
  await ensureDb();
  var server = http.createServer(function (req, res) {
    router(req, res).catch(function (err) {
      console.log("router error", err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "server error" });
    });
  });
  server.on("error", function (err) {
    if (err && err.code === "EADDRINUSE") {
      console.log("port " + PORT + " busy, try PORT=3002 npm start");
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, function () {
    console.log("http://localhost:" + PORT);
    if (!omdbKey) console.log("warning: no OMDB_API_KEY in .env");
  });
}

if (require.main === module) {
  start().catch(function (err) {
    console.log("start failed", err);
    process.exit(1);
  });
}
