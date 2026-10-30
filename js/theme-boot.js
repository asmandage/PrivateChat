// Classic (non-module) script loaded in <head> so the saved theme is applied before first paint.
(function () {
  // Anti-clickjacking: GitHub Pages cannot send X-Frame-Options / frame-ancestors
  // headers, so refuse to render inside a frame on another site.
  if (window.top !== window.self) {
    document.documentElement.style.display = 'none';
    try { window.top.location = window.self.location; } catch (e) { /* cross-origin: stay hidden */ }
    return;
  }

  var theme = 'system';
  try {
    var prefs = JSON.parse(localStorage.getItem('privatechat.prefs') || '{}');
    if (prefs && typeof prefs.theme === 'string') theme = prefs.theme;
  } catch (e) { /* storage unavailable: fall back to system theme */ }
  var dark = theme === 'dark' ||
    (theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
