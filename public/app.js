var currentUser = null;
var selectedMovie = null;

function $(id) {
  return document.getElementById(id);
}

function showMsg(el, text, isError) {
  if (!el) return;
  el.textContent = text || "";
  el.style.color = isError ? "#a12a2a" : "#2b5c2b";
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stars(n) {
  var out = "";
  var i;
  for (i = 0; i < n; i++) out += "★";
  for (i = n; i < 5; i++) out += "☆";
  return out;
}

function api(path, options, done) {
  var opts = options || {};
  var method = opts.method || "GET";
  var body = null;
  var headers = opts.headers || {};

  if (opts.body && typeof opts.body === "object" && !(opts.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  } else if (opts.body) {
    body = opts.body;
  }

  var reqOpts = {
    method: method,
    headers: headers,
    credentials: "include",
  };
  if (body != null) reqOpts.body = body;

  fetch(path, reqOpts)
    .then(function (res) {
      return res.json()
        .then(function (data) {
          if (!res.ok && !data.error) data.error = "request failed";
          done(data || { ok: false, error: "bad response" });
        })
        .catch(function () {
          done({ ok: false, error: "bad response" });
        });
    })
    .catch(function () {
      done({ ok: false, error: "network error" });
    });
}

function setLoggedInUi(loggedIn, username) {
  var authArea = $("authArea");
  var loginSection = $("loginSection");
  var registerSection = $("registerSection");
  var appSection = $("appSection");

  if (loggedIn) {
    currentUser = username;
    authArea.innerHTML =
      '<span class="pill">' + escapeHtml(username) + "</span> " +
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

function checkSession() {
  api("/api/me", {}, function (data) {
    if (data.ok && data.loggedIn && data.username) {
      setLoggedInUi(true, data.username);
    } else {
      setLoggedInUi(false);
    }
  });
}

function doLogout() {
  api("/api/logout", { method: "POST" }, function () {
    setLoggedInUi(false);
  });
}

function doLogin() {
  var u = $("loginUser").value.trim();
  var p = $("loginPass").value;
  showMsg($("loginMsg"), "wait...", false);
  api("/api/login", { method: "POST", body: { username: u, password: p } }, function (data) {
    if (data.ok) {
      showMsg($("loginMsg"), "", false);
      $("loginPass").value = "";
      setLoggedInUi(true, data.username);
    } else {
      showMsg($("loginMsg"), data.error || "Login failed.", true);
    }
  });
}

function doRegister() {
  var u = $("regUser").value.trim();
  var p = $("regPass").value;
  showMsg($("regMsg"), "wait...", false);
  api("/api/register", { method: "POST", body: { username: u, password: p } }, function (data) {
    if (data.ok) {
      showMsg($("regMsg"), "", false);
      $("regPass").value = "";
      setLoggedInUi(true, data.username);
    } else {
      showMsg($("regMsg"), data.error || "Registration failed.", true);
    }
  });
}

function switchTab(name) {
  var tabs = document.querySelectorAll(".tab");
  var panels = document.querySelectorAll(".tab-panel");
  var i;

  for (i = 0; i < tabs.length; i++) {
    if (tabs[i].getAttribute("data-tab") === name) tabs[i].classList.add("active");
    else tabs[i].classList.remove("active");
  }
  for (i = 0; i < panels.length; i++) {
    if (panels[i].getAttribute("data-tab") === name) panels[i].classList.add("active");
    else panels[i].classList.remove("active");
  }
  if (name === "recs") loadRecs();
}

function posterTile(m, extraLine) {
  var img = m.poster
    ? "<img src='" + escapeHtml(m.poster) + "' alt=''>"
    : "<div class='poster-placeholder'>no image</div>";
  var sub = extraLine ? "<div class='small'>" + escapeHtml(extraLine) + "</div>" : "";
  return "<div class='tile' data-imdb='" + escapeHtml(m.imdbId) + "'>" +
    img +
    "<div class='tile-body'><div class='tile-title'>" + escapeHtml(m.title) + "</div>" +
    "<div class='small'>" + escapeHtml(m.year || "") + "</div>" +
    sub +
    "</div></div>";
}

function wireTiles(container) {
  var tiles = container.querySelectorAll(".tile");
  var i;
  for (i = 0; i < tiles.length; i++) {
    tiles[i].onclick = function () {
      loadDetail(this.getAttribute("data-imdb"));
    };
  }
}

function loadDiscover() {
  var box = $("listDiscover");
  var i;
  var html = "";
  if (!box) return;
  box.innerHTML = "<p class='small'>loading popular picks...</p>";
  api("/api/discover", {}, function (data) {
    if (!data.ok) {
      box.innerHTML = "<p class='small'>" + escapeHtml(data.error || "error") + "</p>";
      return;
    }
    for (i = 0; i < data.movies.length; i++) html += posterTile(data.movies[i]);
    box.innerHTML = html;
    wireTiles(box);
  });
}

function runSearch() {
  var q = $("searchInput").value.trim();
  var card = $("searchResultsCard");
  var box = $("searchResults");
  var i;
  var html = "";

  if (!q) {
    showMsg($("searchMsg"), "Please enter a movie title.", true);
    return;
  }

  card.classList.remove("hidden");
  box.innerHTML = "<p class='small'>searching...</p>";
  showMsg($("searchMsg"), "", false);

  api("/api/movies/search?q=" + encodeURIComponent(q), {}, function (data) {
    if (!data.ok) {
      box.innerHTML = "<p class='small'>" + escapeHtml(data.error || "error") + "</p>";
      return;
    }
    if (!data.results || !data.results.length) {
      box.innerHTML = "<p class='small'>No results found.</p>";
      return;
    }
    for (i = 0; i < data.results.length; i++) {
      html += posterTile(data.results[i], data.results[i].type);
    }
    box.innerHTML = html;
    wireTiles(box);
    card.scrollIntoView(true);
  });
}

function clearSearch() {
  $("searchInput").value = "";
  $("searchResultsCard").classList.add("hidden");
  $("searchResults").innerHTML = "";
}

function loadDetail(imdbId) {
  var card = $("detailCard");
  var box = $("detailBox");
  var html, m, poster, genreLine;

  selectedMovie = null;
  card.classList.remove("hidden");
  box.innerHTML = "<p class='small'>loading...</p>";
  card.scrollIntoView(true);

  api("/api/movies/detail?id=" + encodeURIComponent(imdbId), {}, function (data) {
    if (!data.ok || !data.movie) {
      box.innerHTML = "<p class='small'>could not load</p>";
      return;
    }

    selectedMovie = data.movie;
    m = data.movie;
    poster = m.poster
      ? "<img src='" + escapeHtml(m.poster) + "' alt='poster'>"
      : "<div class='poster-placeholder big'>No image</div>";
    genreLine = (m.genres || []).length
      ? "<p class='small'>" + escapeHtml(m.genres.join(" - ")) + "</p>"
      : "";

    html = poster + "<div class='detail-meta'>" +
      "<div class='detail-header'>" +
      "<h3>" + escapeHtml(m.title) + " <span class='year'>(" + escapeHtml(m.year || "") + ")</span></h3>" +
      "<button type='button' class='secondary close-btn' id='btnCloseDetail'>x</button>" +
      "</div>" +
      genreLine +
      "<p>" + escapeHtml(m.plot) + "</p>" +
      "<div class='inline-btns'>" +
      "<button type='button' id='btnAddWant'>+ watchlist</button>" +
      "<button type='button' class='secondary' id='btnSeenForm'>Watched + Rate</button>" +
      "</div>" +
      "<div id='seenFormWrap' class='hidden seen-form'>" +
      "<label>Stars <select id='rateSelect'>" +
      "<option value='5'>5</option><option value='4'>4</option>" +
      "<option value='3'>3</option><option value='2'>2</option><option value='1'>1</option>" +
      "</select></label>" +
      "<label>Review <textarea id='reviewText' placeholder='Share your thoughts...'></textarea></label>" +
      "<button type='button' id='btnSaveSeen'>Save Review</button>" +
      "</div>" +
      "<p id='detailMsg' class='msg'></p>" +
      "</div>";

    box.innerHTML = html;
    $("btnAddWant").onclick = addWant;
    $("btnSeenForm").onclick = function () {
      $("seenFormWrap").classList.toggle("hidden");
    };
    $("btnSaveSeen").onclick = saveSeen;
    $("btnCloseDetail").onclick = function () {
      $("detailCard").classList.add("hidden");
      selectedMovie = null;
    };
  });
}

function addWant() {
  if (!selectedMovie) return;
  api("/api/my-movies", {
    method: "POST",
    body: {
      imdbId: selectedMovie.imdbId,
      title: selectedMovie.title,
      poster: selectedMovie.poster,
      plot: selectedMovie.plot,
      genres: selectedMovie.genres || [],
      status: "want"
    }
  }, function (data) {
    if (!data.ok) {
      showMsg($("detailMsg"), data.error || "error", true);
      return;
    }
    showMsg($("detailMsg"), "Added to watchlist.", false);
    loadLists();
  });
}

function saveSeen() {
  var rating, reviewText;
  if (!selectedMovie) return;
  rating = parseInt($("rateSelect").value, 10);
  reviewText = $("reviewText").value;
  api("/api/my-movies", {
    method: "POST",
    body: {
      imdbId: selectedMovie.imdbId,
      title: selectedMovie.title,
      poster: selectedMovie.poster,
      plot: selectedMovie.plot,
      genres: selectedMovie.genres || [],
      status: "seen",
      rating: rating,
      reviewText: reviewText
    }
  }, function (data) {
    if (!data.ok) {
      showMsg($("detailMsg"), data.error || "error", true);
      return;
    }
    showMsg($("detailMsg"), "Review saved.", false);
    loadLists();
  });
}

function loadLists() {
  var sortWant, sortSeen;
  if (!currentUser) return;
  sortWant = $("sortWant").value;
  sortSeen = $("sortSeen").value;

  api("/api/my-movies?status=want&sort=" + encodeURIComponent(sortWant), {}, function (wantData) {
    renderList($("listWant"), wantData.movies || [], "want");
  });

  api("/api/my-movies?status=seen&sort=" + encodeURIComponent(sortSeen), {}, function (seenData) {
    renderList($("listSeen"), seenData.movies || [], "seen");
  });
}

function renderList(container, movies, kind) {
  var i, m, row, img, extra;
  var titles, removes, t, r;
  container.innerHTML = "";
  if (!movies.length) {
    container.innerHTML = "<p class='small'>No movies yet. Add some to get started.</p>";
    return;
  }
  for (i = 0; i < movies.length; i++) {
    m = movies[i];
    row = document.createElement("div");
    row.className = "movie-row";
    img = m.poster
      ? "<img src='" + escapeHtml(m.poster) + "' alt=''>"
      : "<div class='poster-placeholder small-poster'>No image</div>";
    extra = "";
    if (kind === "seen") {
      extra +=
        "<div class='stars'>" + stars(m.rating || 0) + "</div>" +
        "<p class='small'>" + escapeHtml(m.reviewText || "(No review)") + "</p>";
    }
    row.innerHTML =
      img +
      "<div class='body'>" +
      "<strong class='clickable' data-imdb='" + escapeHtml(m.imdbId) + "'>" + escapeHtml(m.title) + "</strong>" +
      extra +
      "<button type='button' class='secondary' data-remove='" + escapeHtml(m.imdbId) + "'>Remove</button>" +
      "</div>";
    container.appendChild(row);
  }

  titles = container.querySelectorAll(".clickable[data-imdb]");
  for (t = 0; t < titles.length; t++) {
    titles[t].onclick = function () {
      loadDetail(this.getAttribute("data-imdb"));
    };
  }

  removes = container.querySelectorAll("[data-remove]");
  for (r = 0; r < removes.length; r++) {
    removes[r].onclick = function () {
      removeMovie(this.getAttribute("data-remove"));
    };
  }
}

function removeMovie(imdbId) {
  if (!confirm("Remove this movie?")) return;
  api("/api/my-movies/" + encodeURIComponent(imdbId), { method: "DELETE" }, function (data) {
    if (!data.ok) {
      alert(data.error || "error");
      return;
    }
    loadLists();
  });
}

function loadRecs() {
  var box = $("listRecs");
  var recs, topLine, html, i;
  if (!box) return;
  box.innerHTML = "<p class='small'>loading...</p>";
  api("/api/recommendations", {}, function (data) {
    if (!data.ok) {
      box.innerHTML = "<p class='small'>" + escapeHtml(data.error || "error") + "</p>";
      return;
    }
    recs = data.recommendations || [];
    if (!recs.length) {
      var msg = data.message || "Rate a few movies first to get recommendations.";
      if (msg === "no genre data yet") {
        msg = "We need genre data first. Open a movie and save it as Watched + Rate.";
      } else if (msg === "rate a few movies first") {
        msg = "No recommendations yet. Add and rate a few watched movies first.";
      }
      box.innerHTML = "<p class='small'>" + escapeHtml(msg) + "</p>";
      return;
    }
    topLine = "";
    if (data.topGenres && data.topGenres.length) {
      topLine = "<p class='small'>Based on your taste: " + escapeHtml(data.topGenres.join(", ")) + "</p>";
    }
    html = topLine + "<div class='grid'>";
    for (i = 0; i < recs.length; i++) {
      html += posterTile(recs[i], "Because you like " + (recs[i].reasonGenre || ""));
    }
    html += "</div>";
    box.innerHTML = html;
    wireTiles(box);
  });
}

window.onload = function () {
  var tabBtns;
  var i;
  checkSession();

  $("btnLogin").onclick = doLogin;
  $("btnRegister").onclick = doRegister;
  $("linkShowRegister").onclick = function (e) {
    e.preventDefault();
    showRegisterPanel();
  };
  $("linkShowLogin").onclick = function (e) {
    e.preventDefault();
    showLoginPanel();
  };

  $("btnSearch").onclick = runSearch;
  $("searchInput").onkeydown = function (e) {
    if (e.key === "Enter") runSearch();
  };
  $("btnClearSearch").onclick = clearSearch;

  $("sortWant").onchange = loadLists;
  $("sortSeen").onchange = loadLists;
  $("btnRefreshWant").onclick = loadLists;
  $("btnRefreshSeen").onclick = loadLists;

  tabBtns = document.querySelectorAll(".tab");
  for (i = 0; i < tabBtns.length; i++) {
    tabBtns[i].onclick = function () {
      switchTab(this.getAttribute("data-tab"));
    };
  }
};
