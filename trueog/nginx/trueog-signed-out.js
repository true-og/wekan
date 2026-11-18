/* TrueOG (2026-11-15): WeKan's version of Gitea's "Signed out of Staff-Auth" page.
 *
 * Served by nginx at /trueog-signed-out.js (live copy /var/www/trueog-wekan/signed-out.js) and loaded on every WeKan
 * page through the sub_filter in wekan.conf. WeKan signs in only through Staff-Auth; when that sign-in ends
 * (Staff-Auth logout, staff access changed), trueog-wekan-authwatch ends the WeKan sessions and the open tab falls
 * back to WeKan's sign-in page. This script remembers that the browser was signed in and, the first time the sign-in
 * page appears after that, explains what happened, once. Afterwards the signed-out site behaves normally.
 *
 * Detection: Meteor keeps the session in localStorage "Meteor.loginToken". While it is there this script sets
 * "trueog.wekan.signedIn"; when the sign-in page (.auth-layout) shows without a token and that marker is set, the
 * marker is cleared (so the message shows only once) and the message is shown. WeKan would redirect to Staff-Auth on
 * its own (one automatic try per tab, flag "wekan-oidc-auto-redirect-pending" in sessionStorage); setting that flag
 * keeps the message on screen. "Sign in with Staff-Auth" clears the flag and reloads, so WeKan's own redirect runs.
 */
(function () {
  "use strict";
  var MARKER = "trueog.wekan.signedIn";
  var REDIRECT_FLAG = "wekan-oidc-auto-redirect-pending";
  var shown = false;

  function get(store, key) { try { return store.getItem(key); } catch (e) { return null; } }
  function set(store, key, value) { try { store.setItem(key, value); } catch (e) { /* storage blocked */ } }
  function del(store, key) { try { store.removeItem(key); } catch (e) { /* storage blocked */ } }

  function hasLoginToken() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf("Meteor.loginToken") === 0 && k.indexOf("Expires") < 0 && localStorage.getItem(k)) return true;
      }
    } catch (e) { /* storage blocked */ }
    return false;
  }

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text) n.textContent = text;
    return n;
  }

  function showMessage() {
    shown = true;
    var overlay = el("div", { id: "trueog-signed-out", role: "dialog", "aria-modal": "true", "aria-labelledby": "trueog-signed-out-title" });
    var card = el("div", { "class": "trueog-so-card" });
    card.appendChild(el("h2", { id: "trueog-signed-out-title" }, "Signed out of Staff-Auth"));
    card.appendChild(el("p", {}, "Your Staff-Auth sign-in has ended: you logged out of Staff-Auth or another TrueOG app, or your staff access changed. Sign in with Staff-Auth again to continue."));
    var actions = el("p", { "class": "trueog-so-actions" });
    var signIn = el("button", { type: "button", "class": "trueog-so-primary" }, "Sign in with Staff-Auth");
    signIn.addEventListener("click", function () { del(sessionStorage, REDIRECT_FLAG); location.reload(); });
    var dismiss = el("button", { type: "button", "class": "trueog-so-secondary" }, "Continue without signing in");
    dismiss.addEventListener("click", function () { overlay.remove(); });
    actions.appendChild(signIn);
    actions.appendChild(dismiss);
    card.appendChild(actions);
    card.appendChild(el("p", { "class": "trueog-so-small" }, "If Staff-Auth does not let you back in, your staff access was removed. Contact a TrueOG administrator."));
    overlay.appendChild(card);
    var style = el("style", {});
    style.textContent =
      "#trueog-signed-out{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(0,0,0,.55);padding:16px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
      "#trueog-signed-out .trueog-so-card{background:#fff;color:#1f2328;max-width:36rem;width:100%;border-radius:8px;" +
      "padding:24px;box-shadow:0 10px 30px rgba(0,0,0,.3)}" +
      "#trueog-signed-out h2{margin:0 0 12px;font-size:1.35rem}" +
      "#trueog-signed-out p{margin:0 0 14px;line-height:1.5}" +
      "#trueog-signed-out .trueog-so-actions{display:flex;flex-wrap:wrap;gap:10px}" +
      "#trueog-signed-out button{font:inherit;padding:8px 14px;border-radius:6px;cursor:pointer}" +
      "#trueog-signed-out .trueog-so-primary{background:#2185d0;border:1px solid #2185d0;color:#fff}" +
      "#trueog-signed-out .trueog-so-secondary{background:transparent;border:1px solid #8c959f;color:inherit}" +
      "#trueog-signed-out .trueog-so-small{font-size:.875rem;opacity:.8;margin:0}" +
      "@media (prefers-color-scheme:dark){#trueog-signed-out .trueog-so-card{background:#22272e;color:#e6edf3}}";
    document.head.appendChild(style);
    document.body.appendChild(overlay);
    signIn.focus();
  }

  function check() {
    if (hasLoginToken()) { set(localStorage, MARKER, "1"); return; }
    if (shown || get(localStorage, MARKER) !== "1" || !document.querySelector(".auth-layout")) return;
    del(localStorage, MARKER);        // once: the next signed-out visit behaves normally
    set(sessionStorage, REDIRECT_FLAG, "1");  // keep WeKan from redirecting away from the message
    showMessage();
  }

  function start() {
    check();
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
    // Meteor drops a rejected token from localStorage without touching the page; poll briefly so the message
    // appears before WeKan's own redirect (which waits for a server round trip) can take the tab away.
    setInterval(check, 250);
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
