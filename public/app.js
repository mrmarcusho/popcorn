var currentUser = null;
var selectedMovie = null;
var activeTab = "discover";

function $(id) { return document.getElementById(id); }

function showMsg(el, text, isError) {
  el.textContent = text || "";
  el.style.color = isError ? "#a12a2a" : "#2b5c2b";
}

//wrapper for fetch so we always send cookies and parse json
async function api(path, options) {
  var opts = options || {};
  opts.credentials = "include";
  opts.headers = opts.headers || {};
  if (opts.body && typeof opts.body === "object" && !(opts.body instanceof FormData)) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  var res = await fetch(path, opts);
  var data = {};
  try { data = await res.json(); }
  catch (e) { data = { ok: false, error: "bad response" }; }
  if (!res.ok && !data.error) data.error = "request failed";
  return data;
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function stars(n) {
  var s = "";
  for (var i = 0; i < n; i++) s += "★";
  for (var j = n; j < 5; j++) s += "☆";
  return s;
}

//---------- auth UI ----------

function setLoggedInUi(loggedIn, username) {
  var authArea = $("authArea");
  var loginSection = $("loginSection");
  var registerSection = $("registerSection");
  var appSection = $("appSection");

  if (loggedIn) {
    currentUser = username;
    authArea.innerHTML =
      '<span class="pill">' + escapeHtml(username) + '</span> ' +
      '<button type="button" id="btnLogout">log out</button>';
    $("btnLogout").onclick = doLogout;
    loginSection.classList.add("hidden");
    registerSection.classList.add("hidden");
    appSection.classList.remove("hidden");
    loadDiscover();
    loadLists();
  } else {
    currentUser = null;
    authArea.innerHTML =
      '<button type="button" id="btnShowLogin">log in</button> ' +
      '<button type="button" id="btnShowRegister">register</button>';
    $("btnShowLogin").onclick = showLoginPanel;
    $("btnShowRegister").onclick = showRegisterPanel;
    appSection.classList.add("hidden");
    loginSection.classList.remove("hidden");
    registerSection.classList.add("hidden");
  }
}

function showLoginPanel() {
  $("loginSection").classList.remove("hidden");
  $("registerSection").classList.add("hidden");
}

function showRegisterPanel() {
  $("registerSection").classList.remove("hidden");
  $("loginSection").classList.add("hidden");
}

async function checkSession() {
  var data = await api("/api/me");
  if (data.ok && data.loggedIn && data.username) setLoggedInUi(true, data.username);
  else setLoggedInUi(false);
}

async function doLogout() {
  await api("/api/logout", { method: "POST" });
  setLoggedInUi(false);
}

async function doLogin() {
  var u = $("loginUser").value.trim();
  var p = $("loginPass").value;
  showMsg($("loginMsg"), "wait...", false);
  var data = await api("/api/login", { method: "POST", body: { username: u, password: p } });
  if (data.ok) {
    showMsg($("loginMsg"), "", false);
    $("loginPass").value = "";
    setLoggedInUi(true, data.username);
  } else {
    showMsg($("loginMsg"), data.error || "nope", true);
  }
}

async function doRegister() {
  var u = $("regUser").value.trim();
  var p = $("regPass").value;
  showMsg($("regMsg"), "wait...", false);
  var data = await api("/api/register", { method: "POST", body: { username: u, password: p } });
  if (data.ok) {
    showMsg($("regMsg"), "", false);
    $("regPass").value = "";
    setLoggedInUi(true, data.username);
  } else {
    showMsg($("regMsg"), data.error || "nope", true);
  }
}

//---------- tabs ----------

function switchTab(name) {
  activeTab = name;
  var tabs = document.querySelectorAll(".tab");
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle("active", tabs[i].getAttribute("data-tab") === name);
  }
  var panels = document.querySelectorAll(".tab-panel");
  for (var j = 0; j < panels.length; j++) {
    panels[j].classList.toggle("active", panels[j].getAttribute("data-tab") === name);
  }
  if (name === "recs") loadRecs();
}

//---------- card render helpers ----------

//a poster tile in a grid (clickable to open detail)
function posterTile(m, extraLine) {
  var img = m.poster
    ? "<img src='" + escapeHtml(m.poster) + "' alt='' />"
    : "<div class='poster-placeholder'>no image</div>";
  var sub = extraLine ? "<div class='small'>" + escapeHtml(extraLine) + "</div>" : "";
  return (
    "<div class='tile' data-imdb='" + escapeHtml(m.imdbId) + "'>" +
    img +
    "<div class='tile-body'><div class='tile-title'>" + escapeHtml(m.title) + "</div>" +
    "<div class='small'>" + escapeHtml(m.year || "") + "</div>" +
    sub +
    "</div></div>"
  );
}

//wire any .tile inside a container to open detail on click
function wireTiles(container) {
  var tiles = container.querySelectorAll(".tile");
  for (var i = 0; i < tiles.length; i++) {
    tiles[i].onclick = function () {
      loadDetail(this.getAttribute("data-imdb"));
    };
  }
}

//---------- discover (home page popular movies) ----------

async function loadDiscover() {
  var box = $("listDiscover");
  if (!box) return;
  box.innerHTML = "<p class='small'>loading popular picks...</p>";
  var data = await api("/api/discover");
  if (!data.ok) {
    box.innerHTML = "<p class='small'>" + escapeHtml(data.error || "error") + "</p>";
    return;
  }
  var html = "";
  for (var i = 0; i < data.movies.length; i++) html += posterTile(data.movies[i]);
  box.innerHTML = html;
  wireTiles(box);
}

//---------- search ----------

async function runSearch() {
  var q = $("searchInput").value.trim();
  var card = $("searchResultsCard");
  var box = $("searchResults");
  if (!q) {
    showMsg($("searchMsg"), "type a name", true);
    return;
  }
  card.classList.remove("hidden");
  box.innerHTML = "<p class='small'>searching...</p>";
  showMsg($("searchMsg"), "", false);
  var data = await api("/api/movies/search?q=" + encodeURIComponent(q));
  if (!data.ok) {
    box.innerHTML = "<p class='small'>" + escapeHtml(data.error || "error") + "</p>";
    return;
  }
  if (!data.results.length) {
    box.innerHTML = "<p class='small'>nothing found</p>";
    return;
  }
  var html = "";
  for (var i = 0; i < data.results.length; i++) html += posterTile(data.results[i], data.results[i].type);
  box.innerHTML = html;
  wireTiles(box);
  card.scrollIntoView({ behavior: "smooth", block: "start" });
}

function clearSearch() {
  $("searchInput").value = "";
  $("searchResultsCard").classList.add("hidden");
  $("searchResults").innerHTML = "";
}

//---------- movie detail panel ----------

async function loadDetail(imdbId) {
  selectedMovie = null;
  var card = $("detailCard");
  var box = $("detailBox");
  card.classList.remove("hidden");
  box.innerHTML = "<p class='small'>loading...</p>";
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  var data = await api("/api/movies/detail?id=" + encodeURIComponent(imdbId));
  if (!data.ok || !data.movie) {
    box.innerHTML = "<p class='small'>could not load</p>";
    return;
  }
  selectedMovie = data.movie;
  var m = data.movie;
  var poster = m.poster
    ? "<img src='" + escapeHtml(m.poster) + "' alt='poster' />"
    : "<div class='poster-placeholder big'>no image</div>";
  var genreLine = (m.genres || []).length ? "<p class='small'>" + escapeHtml(m.genres.join(" · ")) + "</p>" : "";
  var html = poster + "<div class='detail-meta'>" +
    "<div class='detail-header'>" +
      "<h3>" + escapeHtml(m.title) + " <span class='year'>(" + escapeHtml(m.year || "") + ")</span></h3>" +
      "<button type='button' class='secondary close-btn' id='btnCloseDetail'>×</button>" +
    "</div>" +
    genreLine +
    "<p>" + escapeHtml(m.plot) + "</p>" +
    "<div class='inline-btns'>" +
      "<button type='button' id='btnAddWant'>+ watchlist</button>" +
      "<button type='button' class='secondary' id='btnSeenForm'>watched + rate</button>" +
    "</div>" +
    "<div id='seenFormWrap' class='hidden seen-form'>" +
      "<label>stars <select id='rateSelect'>" +
        "<option value='5'>5</option><option value='4'>4</option>" +
        "<option value='3'>3</option><option value='2'>2</option><option value='1'>1</option>" +
      "</select></label>" +
      "<label>review <textarea id='reviewText' placeholder='your thoughts...'></textarea></label>" +
      "<button type='button' id='btnSaveSeen'>save review</button>" +
    "</div>" +
    "<p id='detailMsg' class='msg'></p>" +
  "</div>";
  box.innerHTML = html;
  $("btnAddWant").onclick = addWant;
  $("btnSeenForm").onclick = function () { $("seenFormWrap").classList.toggle("hidden"); };
  $("btnSaveSeen").onclick = saveSeen;
  $("btnCloseDetail").onclick = function () {
    $("detailCard").classList.add("hidden");
    selectedMovie = null;
  };
}

async function addWant() {
  if (!selectedMovie) return;
  var data = await api("/api/my-movies", {
    method: "POST",
    body: {
      imdbId: selectedMovie.imdbId,
      title: selectedMovie.title,
      poster: selectedMovie.poster,
      plot: selectedMovie.plot,
      genres: selectedMovie.genres || [],
      status: "want",
    },
  });
  if (!data.ok) { showMsg($("detailMsg"), data.error || "error", true); return; }
  showMsg($("detailMsg"), "added to watchlist", false);
  loadLists();
}

async function saveSeen() {
  if (!selectedMovie) return;
  var rating = parseInt($("rateSelect").value, 10);
  var reviewText = $("reviewText").value;
  var data = await api("/api/my-movies", {
    method: "POST",
    body: {
      imdbId: selectedMovie.imdbId,
      title: selectedMovie.title,
      poster: selectedMovie.poster,
      plot: selectedMovie.plot,
      genres: selectedMovie.genres || [],
      status: "seen",
      rating: rating,
      reviewText: reviewText,
    },
  });
  if (!data.ok) { showMsg($("detailMsg"), data.error || "error", true); return; }
  showMsg($("detailMsg"), "review saved", false);
  loadLists();
}

//---------- watchlist + reviews lists ----------

async function loadLists() {
  if (!currentUser) return;
  var sortWant = $("sortWant").value;
  var sortSeen = $("sortSeen").value;
  var wantData = await api("/api/my-movies?status=want&sort=" + encodeURIComponent(sortWant));
  var seenData = await api("/api/my-movies?status=seen&sort=" + encodeURIComponent(sortSeen));
  renderList($("listWant"), wantData.movies || [], "want");
  renderList($("listSeen"), seenData.movies || [], "seen");
}

function renderList(container, movies, kind) {
  container.innerHTML = "";
  if (!movies.length) {
    container.innerHTML = "<p class='small'>empty — add some movies!</p>";
    return;
  }
  for (var i = 0; i < movies.length; i++) {
    var m = movies[i];
    var row = document.createElement("div");
    row.className = "movie-row";
    var img = m.poster
      ? "<img src='" + escapeHtml(m.poster) + "' alt='' />"
      : "<div class='poster-placeholder small-poster'>no image</div>";
    var extra = "";
    if (kind === "seen") {
      extra +=
        "<div class='stars'>" + stars(m.rating || 0) + "</div>" +
        "<p class='small'>" + escapeHtml(m.reviewText || "(no review)") + "</p>";
    }
    row.innerHTML =
      img +
      "<div class='body'>" +
        "<strong class='clickable' data-imdb='" + escapeHtml(m.imdbId) + "'>" + escapeHtml(m.title) + "</strong>" +
        extra +
        "<button type='button' class='secondary' data-remove='" + escapeHtml(m.imdbId) + "'>remove</button>" +
      "</div>";
    container.appendChild(row);
  }
  //wire title clicks to open detail
  var titles = container.querySelectorAll(".clickable[data-imdb]");
  for (var t = 0; t < titles.length; t++) {
    titles[t].onclick = function () { loadDetail(this.getAttribute("data-imdb")); };
  }
  var removes = container.querySelectorAll("[data-remove]");
  for (var r = 0; r < removes.length; r++) {
    removes[r].onclick = function () { removeMovie(this.getAttribute("data-remove")); };
  }
}

async function removeMovie(imdbId) {
  if (!confirm("remove this movie?")) return;
  var data = await api("/api/my-movies/" + encodeURIComponent(imdbId), { method: "DELETE" });
  if (!data.ok) { alert(data.error || "error"); return; }
  loadLists();
}

//---------- recommendations ----------

async function loadRecs() {
  var box = $("listRecs");
  if (!box) return;
  box.innerHTML = "<p class='small'>loading...</p>";
  var data = await api("/api/recommendations");
  if (!data.ok) {
    box.innerHTML = "<p class='small'>" + escapeHtml(data.error || "error") + "</p>";
    return;
  }
  var recs = data.recommendations || [];
  if (!recs.length) {
    box.innerHTML = "<p class='small'>" + escapeHtml(data.message || "rate some movies first to get picks") + "</p>";
    return;
  }
  var topLine = "";
  if (data.topGenres && data.topGenres.length) {
    topLine = "<p class='small'>based on your taste: " + escapeHtml(data.topGenres.join(", ")) + "</p>";
  }
  var html = topLine + "<div class='grid'>";
  for (var i = 0; i < recs.length; i++) {
    html += posterTile(recs[i], "because you like " + (recs[i].reasonGenre || ""));
  }
  html += "</div>";
  box.innerHTML = html;
  wireTiles(box);
}

//---------- boot ----------

window.onload = function () {
  checkSession();

  $("btnLogin").onclick = doLogin;
  $("btnRegister").onclick = doRegister;
  $("linkShowRegister").onclick = function (e) { e.preventDefault(); showRegisterPanel(); };
  $("linkShowLogin").onclick = function (e) { e.preventDefault(); showLoginPanel(); };

  $("btnSearch").onclick = runSearch;
  $("searchInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") runSearch();
  });
  $("btnClearSearch").onclick = clearSearch;

  $("sortWant").onchange = loadLists;
  $("sortSeen").onchange = loadLists;
  $("btnRefreshWant").onclick = loadLists;
  $("btnRefreshSeen").onclick = loadLists;

  var tabBtns = document.querySelectorAll(".tab");
  for (var i = 0; i < tabBtns.length; i++) {
    tabBtns[i].onclick = function () { switchTab(this.getAttribute("data-tab")); };
  }
};
