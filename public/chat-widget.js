/*
 * Den Defenders website chat bubble (Phase 1).
 *
 * Loaded on dendefenders.com with one line:
 *   <script src="https://<denny host>/chat-widget.js" data-mode="test" async></script>
 *
 * It draws a round "Chat" button in the bottom-right corner, opens a small
 * chat window, and sends each message (plus the recent history) to
 * /api/website-bot on the same host this script was loaded from.
 *
 * Plain JavaScript on purpose: no framework, nothing to build, works inside
 * WordPress. It stores nothing except the chat history in memory for the page.
 */
(function () {
  "use strict";

  if (window.__denDefendersChatLoaded) return;
  window.__denDefendersChatLoaded = true;

  // --- Where to send messages: same host as this script -------------------
  var scriptEl = document.currentScript ||
    (function () {
      var all = document.getElementsByTagName("script");
      for (var i = all.length - 1; i >= 0; i--) {
        if (/chat-widget\.js/.test(all[i].src || "")) return all[i];
      }
      return null;
    })();

  var scriptSrc = (scriptEl && scriptEl.src) || "";
  var apiBase = scriptSrc ? scriptSrc.replace(/\/chat-widget\.js.*$/, "") : "";
  var apiUrl = apiBase + "/api/website-bot";
  var mode = (scriptEl && scriptEl.getAttribute("data-mode")) || "live";
  // "test" mode is still passed to the server for logging; nothing visual changes.

  // --- State --------------------------------------------------------------
  var history = [];          // [{ role: "user" | "assistant", content: "..." }]
  var sessionId = randomId();
  var open = false;
  var busy = false;

  function randomId() {
    var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    var out = "";
    for (var i = 0; i < 24; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  // --- Styles -------------------------------------------------------------
  var css = [
    "#ddc-bubble{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:60px;height:60px;border-radius:50%;",
    "background:#1f3a5f;color:#fff;border:none;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);",
    "display:flex;align-items:center;justify-content:center;font:600 14px/1 system-ui,Segoe UI,Arial,sans-serif}",
    "#ddc-bubble:hover{background:#17304f}",
    "#ddc-bubble svg{width:28px;height:28px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
    "#ddc-panel{position:fixed;right:20px;bottom:92px;z-index:2147483000;width:360px;max-width:calc(100vw - 32px);",
    "height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);",
    "display:none;flex-direction:column;overflow:hidden;font:15px/1.4 system-ui,Segoe UI,Arial,sans-serif;color:#1b1b1b}",
    "#ddc-panel.ddc-open{display:flex}",
    "#ddc-head{background:#1f3a5f;color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between}",
    "#ddc-head b{font-size:16px;font-weight:600}",
    "#ddc-head small{display:block;opacity:.85;font-size:12px;margin-top:2px}",
    "#ddc-close{background:transparent;border:none;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:4px 6px}",
    "#ddc-test{background:#ffb020;color:#2b1d00;font-size:12px;font-weight:600;text-align:center;padding:4px 8px}",
    "#ddc-log{flex:1;overflow-y:auto;padding:14px 12px;background:#f4f6f9;display:flex;flex-direction:column;gap:10px}",
    ".ddc-msg{max-width:85%;padding:10px 12px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word}",
    ".ddc-user{align-self:flex-end;background:#1f3a5f;color:#fff;border-bottom-right-radius:4px}",
    ".ddc-bot{align-self:flex-start;background:#fff;border:1px solid #dfe4ea;border-bottom-left-radius:4px}",
    ".ddc-typing{align-self:flex-start;color:#6b7280;font-size:13px;padding:4px 12px}",
    "#ddc-form{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff}",
    "#ddc-input{flex:1;border:1px solid #cfd6df;border-radius:10px;padding:10px 12px;font:inherit;resize:none;max-height:90px}",
    "#ddc-input:focus{outline:2px solid #1f3a5f;border-color:#1f3a5f}",
    "#ddc-send{background:#1f3a5f;color:#fff;border:none;border-radius:10px;padding:0 16px;font:inherit;font-weight:600;cursor:pointer}",
    "#ddc-send:disabled{opacity:.5;cursor:default}",
    "#ddc-foot{font-size:11px;color:#6b7280;text-align:center;padding:4px 8px 8px;background:#fff}",
    ".ddc-card{align-self:stretch;background:#fff;border:2px solid #1f3a5f;border-radius:14px;padding:12px 14px}",
    ".ddc-card h4{margin:0 0 8px;font-size:15px;color:#1f3a5f}",
    ".ddc-card dl{margin:0 0 10px;display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:14px}",
    ".ddc-card dt{color:#6b7280}.ddc-card dd{margin:0}",
    ".ddc-card .ddc-actions{display:flex;gap:8px}",
    ".ddc-confirm{flex:1;background:#1f8a4c;color:#fff;border:none;border-radius:10px;padding:10px;font:inherit;font-weight:600;cursor:pointer}",
    ".ddc-confirm:disabled{opacity:.6;cursor:default}",
    ".ddc-change{background:#fff;color:#1f3a5f;border:1px solid #cfd6df;border-radius:10px;padding:10px 12px;font:inherit;cursor:pointer}",
    ".ddc-card .ddc-note{font-size:12px;color:#6b7280;margin-top:8px}",
    "@media (max-width:480px){#ddc-panel{right:8px;left:8px;width:auto;bottom:84px}}"
  ].join("");

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // --- Markup -------------------------------------------------------------
  var bubble = document.createElement("button");
  bubble.id = "ddc-bubble";
  bubble.type = "button";
  bubble.setAttribute("aria-label", "Chat with Den Defenders");
  bubble.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>';

  var panel = document.createElement("div");
  panel.id = "ddc-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Den Defenders chat");
  panel.innerHTML =
    '<div id="ddc-head"><div><b>Den Defenders</b><small>Ask about security doors &amp; open appointment times</small></div>' +
    '<button id="ddc-close" type="button" aria-label="Close chat">&times;</button></div>' +

    '<div id="ddc-log"></div>' +
    '<form id="ddc-form"><textarea id="ddc-input" rows="1" placeholder="Type your question..." maxlength="1000"></textarea>' +
    '<button id="ddc-send" type="submit">Send</button></form>' +
    '<div id="ddc-foot">Powered by Den Coach Denny. Please do not share card numbers here.</div>';

  function mount() {
    document.body.appendChild(bubble);
    document.body.appendChild(panel);

    var log = panel.querySelector("#ddc-log");
    var form = panel.querySelector("#ddc-form");
    var input = panel.querySelector("#ddc-input");
    var send = panel.querySelector("#ddc-send");
    var close = panel.querySelector("#ddc-close");

    function addMessage(role, text) {
      var el = document.createElement("div");
      el.className = "ddc-msg " + (role === "user" ? "ddc-user" : "ddc-bot");
      el.textContent = text;
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return el;
    }

    function setTyping(on) {
      var existing = log.querySelector(".ddc-typing");
      if (on && !existing) {
        var t = document.createElement("div");
        t.className = "ddc-typing";
        t.textContent = "Denny is typing...";
        log.appendChild(t);
        log.scrollTop = log.scrollHeight;
      } else if (!on && existing) {
        existing.parentNode.removeChild(existing);
      }
    }

    // Booking preview card (Phase 2). The server only books when the visitor
    // clicks Confirm here; the token is opaque and expires in 15 minutes.
    function showBookingCard(booking) {
      var old = log.querySelector(".ddc-card");
      if (old) old.parentNode.removeChild(old);

      var p = booking.preview || {};
      var card = document.createElement("div");
      card.className = "ddc-card";

      var title = document.createElement("h4");
      title.textContent = p.returning ? "Welcome back! Please confirm your consultation" : "Please confirm your consultation";
      card.appendChild(title);

      var dl = document.createElement("dl");
      [["When", (p.weekday || "") + ", " + (p.date || "") + " - arrival " + (p.arrivalWindow || "")],
       ["Name", p.name || ""],
       ["Address", p.address || ""],
       ["Phone", p.phoneLast4 ? "ending in " + p.phoneLast4 : ""],
       ["Email", p.email || ""]].forEach(function (row) {
        if (!row[1]) return;
        var dt = document.createElement("dt"); dt.textContent = row[0];
        var dd = document.createElement("dd"); dd.textContent = row[1];
        dl.appendChild(dt); dl.appendChild(dd);
      });
      card.appendChild(dl);

      var actions = document.createElement("div");
      actions.className = "ddc-actions";
      var confirm = document.createElement("button");
      confirm.type = "button"; confirm.className = "ddc-confirm"; confirm.textContent = "Confirm booking";
      var change = document.createElement("button");
      change.type = "button"; change.className = "ddc-change"; change.textContent = "Change";
      actions.appendChild(confirm); actions.appendChild(change);
      card.appendChild(actions);

      var note = document.createElement("div");
      note.className = "ddc-note";
      note.textContent = "Nothing is booked until you press Confirm. Everyone involved in the decision should attend.";
      card.appendChild(note);

      change.addEventListener("click", function () {
        card.parentNode.removeChild(card);
        input.value = "I'd like to change something: ";
        input.focus();
      });

      confirm.addEventListener("click", function () {
        if (busy) return;
        busy = true;
        confirm.disabled = true; change.disabled = true;
        confirm.textContent = "Booking...";
        send.disabled = true;

        fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "confirm", sessionId: sessionId, mode: mode, token: booking.token, messages: history.slice(-80) })
        })
          .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
          .then(function (r) {
            var text = (r.data && (r.data.reply || r.data.error)) || "Sorry, something went wrong. Please give us a call.";
            if (r.data && r.data.booked) {
              card.parentNode.removeChild(card);
            } else {
              confirm.textContent = "Confirm booking";
              confirm.disabled = false; change.disabled = false;
            }
            history.push({ role: "assistant", content: text });
            addMessage("assistant", text);
          })
          .catch(function () {
            confirm.textContent = "Confirm booking";
            confirm.disabled = false; change.disabled = false;
            addMessage("assistant", "Sorry, I couldn't reach our server. Please try again in a moment.");
          })
          .then(function () { busy = false; send.disabled = false; });
      });

      log.appendChild(card);
      log.scrollTop = log.scrollHeight;
    }

    function greetOnce() {
      if (history.length) return;
      var hello = "Hi! I'm Denny with Den Defenders. I can answer questions about our security doors and screens, or check open times for a free in-home consultation. What can I help with?";
      history.push({ role: "assistant", content: hello });
      addMessage("assistant", hello);
    }

    function toggle(force) {
      open = typeof force === "boolean" ? force : !open;
      if (open) {
        panel.classList.add("ddc-open");
        greetOnce();
        setTimeout(function () { input.focus(); }, 50);
      } else {
        panel.classList.remove("ddc-open");
      }
    }

    bubble.addEventListener("click", function () { toggle(); });
    close.addEventListener("click", function () { toggle(false); });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit ? form.requestSubmit() : send.click();
      }
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = (input.value || "").trim();
      if (!text || busy) return;

      input.value = "";
      addMessage("user", text);
      history.push({ role: "user", content: text });

      busy = true;
      send.disabled = true;
      setTyping(true);

      var payload = {
        sessionId: sessionId,
        mode: mode,
        page: location.href,
        messages: history.slice(-80)
      };

      var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, 90000) : null;

      fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined
      })
        .then(function (res) {
          return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; })
            .catch(function () { return { ok: false, status: res.status, data: {} }; });
        })
        .then(function (r) {
          setTyping(false);
          var reply = r.data && r.data.reply;
          if (!r.ok || !reply) {
            reply = (r.data && r.data.error) ||
              "Sorry, I'm having trouble right now. Please try again in a moment or give us a call.";
          }
          history.push({ role: "assistant", content: reply });
          addMessage("assistant", reply);
          if (r.ok && r.data && r.data.booking && r.data.booking.token) {
            showBookingCard(r.data.booking);
          }
        })
        .catch(function () {
          setTyping(false);
          addMessage("assistant", "Sorry, I couldn't reach our server. Please try again in a moment.");
        })
        .then(function () {
          if (timer) clearTimeout(timer);
          busy = false;
          send.disabled = false;
          input.focus();
        });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
