require("dotenv").config();

var http = require("http");
var fs = require("fs");
var path = require("path");
var bcrypt = require("bcryptjs");
var { MongoClient, ObjectId } = require("mongodb");

var PORT = process.env.PORT || 3001;
var mongoUri = process.env.MONGODB_URI;
var omdbKey = process.env.OMDB_API_KEY;

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
    console.log("mongodb connected");
    return db;
  }).catch(function (err) {
    dbReadyPromise = null;
    throw err;
  });
  return dbReadyPromise;
}

function sendJson(res, status, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var size = 0;
    req.on("data", function (c) {
      size += c.length;
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

function buildSetCookie(name, value, opts) {
  opts = opts || {};
  var s = name + "=" + encodeURIComponent(value);
  s += "; Path=/";
  s += "; HttpOnly";
  s += "; SameSite=Lax";
  if (opts.maxAge != null) s += "; Max-Age=" + opts.maxAge;
  return s;
}

var USER_COOKIE = "user";
var LOGIN_DAYS = 7;

async function getUserFromRequest(req) {
  var cookies = parseCookies(req);
  var username = (cookies[USER_COOKIE] || "").trim();
  if (!username) return null;
  return db.collection("users").findOne({ username: username });
}

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
  var rel = urlPath === "/" ? "/index.html" : urlPath;
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
  await users.insertOne({ username: username, passwordHash: hash, createdAt: new Date() });
  res.setHeader("Set-Cookie", buildSetCookie(USER_COOKIE, username, { maxAge: LOGIN_DAYS * 24 * 60 * 60 }));
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
  res.setHeader("Set-Cookie", buildSetCookie(USER_COOKIE, user.username, { maxAge: LOGIN_DAYS * 24 * 60 * 60 }));
  sendJson(res, 200, { ok: true, username: user.username });
}

async function handleLogout(req, res) {
  res.setHeader("Set-Cookie", buildSetCookie(USER_COOKIE, "", { maxAge: 0 }));
  sendJson(res, 200, { ok: true });
}

async function handleMe(req, res, ctx) {
  if (!ctx.user) return sendJson(res, 200, { ok: true, loggedIn: false });
  sendJson(res, 200, { ok: true, loggedIn: true, username: ctx.user.username });
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
  var userId = new ObjectId(ctx.user._id);
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
  var userId = new ObjectId(ctx.user._id);
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
  var userId = new ObjectId(ctx.user._id);
  await db.collection("user_movies").deleteOne({ userId: userId, imdbId: params.imdbId });
  sendJson(res, 200, { ok: true });
}

var DISCOVER_IDS = [
  "tt0111161", "tt0068646", "tt0468569", "tt0050083",
  "tt0167260", "tt1375666", "tt0137523", "tt0109830",
  "tt0816692", "tt0133093", "tt0120737", "tt0245429",
];

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

async function handleRecommendations(req, res, ctx) {
  if (!omdbKey) return sendJson(res, 500, { ok: false, error: "OMDB_API_KEY missing in .env" });
  var userId = new ObjectId(ctx.user._id);
  var moviesCol = db.collection("user_movies");
  var watched = await moviesCol.find({ userId: userId, status: "seen" }).toArray();
  if (watched.length === 0) {
    return sendJson(res, 200, { ok: true, recommendations: [], message: "No watched movies yet." });
  }

  var i, j;
  var genreCounts = {};
  for (i = 0; i < watched.length; i++) {
    var genres = watched[i].genres || [];
    for (j = 0; j < genres.length; j++) {
      genreCounts[genres[j]] = (genreCounts[genres[j]] || 0) + 1;
    }
  }

  var topGenres = Object.keys(genreCounts).sort(function (a, b) {
    return genreCounts[b] - genreCounts[a];
  });

  if (topGenres.length === 0) {
    return sendJson(res, 200, { ok: true, recommendations: [], message: "We could not find genres in your watched movies yet." });
  }

  var myMovies = await moviesCol.find({ userId: userId }).project({ imdbId: 1 }).toArray();
  var skipIds = {};
  for (i = 0; i < myMovies.length; i++) {
    skipIds[myMovies[i].imdbId] = true;
  }

  var picks = [];
  var topGenre = topGenres[0];
  var url = "https://www.omdbapi.com/?apikey=" + encodeURIComponent(omdbKey) + "&s=" + encodeURIComponent(topGenre) + "&type=movie";
  try {
    var res = await fetch(url);
    var data = await res.json();
    if (data.Search) {
      for (j = 0; j < data.Search.length; j++) {
        var movie = data.Search[j];
        if (skipIds[movie.imdbID]) continue;
        picks.push({
          imdbId: movie.imdbID,
          title: movie.Title,
          year: movie.Year,
          poster: movie.Poster && movie.Poster !== "N/A" ? movie.Poster : "",
          reasonGenre: topGenre,
        });
        if (picks.length >= 10) break;
      }
    }
  } catch (e) {
    console.log("rec fetch failed", e);
  }
  sendJson(res, 200, { ok: true, recommendations: picks, topGenres: topGenres });
}

async function requireSession(req, res) {
  var user = await getUserFromRequest(req);
  if (!user) {
    sendJson(res, 401, { ok: false, error: "not logged in" });
    return null;
  }
  return user;
}

async function handleApi(req, res, urlObj) {
  try {
    await ensureDb();
  } catch (e) {
    console.log("db connect error", e);
    return sendJson(res, 500, { ok: false, error: "database not ready" });
  }

  var method = req.method;
  var pathname = urlObj.pathname;

  try {
    if (method === "POST" && pathname === "/api/register") {
      return handleRegister(req, res);
    } else if (method === "POST" && pathname === "/api/login") {
      return handleLogin(req, res);
    } else if (method === "POST" && pathname === "/api/logout") {
      return handleLogout(req, res);
    } else if (method === "GET" && pathname === "/api/me") {
      var meUser = await getUserFromRequest(req);
      return handleMe(req, res, { user: meUser });
    } else if (method === "GET" && pathname === "/api/discover") {
      return handleDiscover(req, res);
    } else if (method === "GET" && pathname === "/api/movies/search") {
      var searchUser = await requireSession(req, res);
      if (!searchUser) return;
      return handleSearch(req, res, { user: searchUser }, urlObj);
    } else if (method === "GET" && pathname === "/api/movies/detail") {
      var detailUser = await requireSession(req, res);
      if (!detailUser) return;
      return handleDetail(req, res, { user: detailUser }, urlObj);
    } else if (method === "GET" && pathname === "/api/my-movies") {
      var listUser = await requireSession(req, res);
      if (!listUser) return;
      return handleListMyMovies(req, res, { user: listUser }, urlObj);
    } else if (method === "POST" && pathname === "/api/my-movies") {
      var saveUser = await requireSession(req, res);
      if (!saveUser) return;
      return handleSaveMyMovie(req, res, { user: saveUser });
    } else if (method === "DELETE" && pathname.indexOf("/api/my-movies/") === 0) {
      var removeUser = await requireSession(req, res);
      if (!removeUser) return;
      var imdbId = decodeURIComponent(pathname.slice("/api/my-movies/".length));
      if (!imdbId) return sendJson(res, 404, { ok: false, error: "no such route" });
      return handleDeleteMyMovie(req, res, { user: removeUser }, urlObj, { imdbId: imdbId });
    } else if (method === "GET" && pathname === "/api/recommendations") {
      var recUser = await requireSession(req, res);
      if (!recUser) return;
      return handleRecommendations(req, res, { user: recUser });
    }
    return sendJson(res, 404, { ok: false, error: "no such route" });
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

module.exports = function (req, res) {
  router(req, res).catch(function (err) {
    console.log("router error", err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: "server error" });
  });
};
