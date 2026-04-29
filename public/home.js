function escapeHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function featureTile(movie) {
  var img = movie.poster
    ? "<img src='" + escapeHtml(movie.poster) + "' alt='movie poster'>"
    : "<div class='poster-placeholder'>No image</div>";
  return (
    "<div class='tile'>" +
      img +
      "<div class='tile-body'>" +
        "<div class='tile-title'>" + escapeHtml(movie.title || "") + "</div>" +
        "<div class='small'>" + escapeHtml(movie.year || "") + "</div>" +
      "</div>" +
    "</div>"
  );
}

function loadFeaturedMovies() {
  var grid = document.getElementById("featuredGrid");
  if (!grid) return;
  grid.innerHTML = "<p class='small'>Loading movies...</p>";

  fetch("/api/discover")
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (!data.ok || !data.movies || !data.movies.length) {
        grid.innerHTML = "<p class='small'>Could not load featured movies right now.</p>";
        return;
      }
      var html = "";
      var limit = Math.min(data.movies.length, 6);
      var i;
      for (i = 0; i < limit; i++) {
        html += featureTile(data.movies[i]);
      }
      grid.innerHTML = html;
    })
    .catch(function () {
      grid.innerHTML = "<p class='small'>Could not load featured movies right now.</p>";
    });
}

window.onload = function () {
  loadFeaturedMovies();
};
