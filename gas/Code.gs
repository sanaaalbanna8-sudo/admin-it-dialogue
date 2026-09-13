const PROPS = PropertiesService.getScriptProperties();
const PIN_DEFAULT = "4826";
const SECONDS_DEFAULT = 12;

function doGet(e) {
  e = e || { parameter: {} };
  const action = e.parameter.action || "";
  if (!action) {
    return HtmlService.createHtmlOutput(votePageHtml())
      .setTitle("طاولة القرار")
      .addMetaTag("viewport", "width=device-width, initial-scale=1, maximum-scale=1")
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  return pack(route(e.parameter), e.parameter.callback);
}

function pack(data, cb) {
  const text = JSON.stringify(data);
  if (cb && /^[A-Za-z_][A-Za-z0-9_]*$/.test(cb)) {
    return ContentService.createTextOutput(cb + "(" + text + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function route(p) {
  if (p.action === "state") return getState();
  if (p.action === "show") return getShow();
  if (p.action === "goto") return gotoSlide(p);
  if (p.action === "arm") return armPoll(p);
  if (p.action === "open") return openPoll(p);
  if (p.action === "clear") return clearPoll();
  if (p.action === "close") return closePoll();
  if (p.action === "vote") return castVote(p);
  if (p.action === "results") return resultsOf(p.q);
  if (p.action === "reset") return resetPoll(p.q);
  return { ok: false };
}

function readJson(key, fallback) {
  try {
    const cache = CacheService.getScriptCache().get(key);
    return JSON.parse(cache || PROPS.getProperty(key) || "");
  } catch (err) {
    return fallback;
  }
}

function writeJson(key, value) {
  const text = JSON.stringify(value);
  CacheService.getScriptCache().put(key, text, 21600);
  try { PROPS.setProperty(key, text); } catch (err) { /* cache holds the live show */ }
}

function nowMs() { return Date.now(); }

function refreshActive(active) {
  if (!active) return null;
  if (active.armed && !active.open) return active;
  if (nowMs() >= Number(active.until || 0)) {
    active.open = false;
    active.armed = false;
  }
  return active;
}

function getShow() {
  const show = readJson("show", { slide: 0, widgets: {} });
  return {
    ok: true,
    slide: Number(show.slide || 0),
    widgets: show.widgets || {},
  };
}

function gotoSlide(p) {
  const show = readJson("show", { slide: 0, widgets: {} });
  show.slide = Number(p.slide || 0);
  if (p.widgets) {
    try { show.widgets = JSON.parse(p.widgets); } catch (err) { /* keep */ }
  }
  writeJson("show", show);
  return getShow();
}

function getState() {
  const active = refreshActive(readJson("active", null));
  if (active) writeJson("active", active);
  const votes = readJson("votes", {});
  const box = active && votes[active.id] ? votes[active.id] : { counts: {}, voters: [] };
  const counts = box.counts || {};
  return {
    ok: true,
    pin: PROPS.getProperty("pin") || PIN_DEFAULT,
    active: active,
    counts: counts,
    total: sumCounts(counts),
    remaining: active && active.open ? Math.max(0, Math.floor((Number(active.until || 0) - nowMs()) / 1000)) : 0,
    open: Boolean(active && active.open),
    armed: Boolean(active && active.armed && !active.open),
  };
}

function parsePoll(p) {
  try { return JSON.parse(p.payload || "{}"); } catch (err) { return {}; }
}

function armPoll(p) {
  const poll = parsePoll(p);
  if (!poll.id || !poll.q || !poll.options) return { ok: false };
  const votes = readJson("votes", {});
  delete votes[String(poll.id)];
  writeJson("votes", votes);
  writeJson("active", {
    id: String(poll.id),
    q: String(poll.q),
    options: poll.options.map(String),
    open: false,
    armed: true,
    until: 0,
  });
  if (p.pin) PROPS.setProperty("pin", String(p.pin));
  return getState();
}

function openPoll(p) {
  const poll = parsePoll(p);
  if (!poll.id || !poll.q || !poll.options) return { ok: false };
  const seconds = Number(p.seconds || SECONDS_DEFAULT);
  const votes = readJson("votes", {});
  delete votes[String(poll.id)];
  writeJson("votes", votes);
  writeJson("active", {
    id: String(poll.id),
    q: String(poll.q),
    options: poll.options.map(String),
    open: true,
    armed: false,
    until: nowMs() + seconds * 1000,
  });
  if (p.pin) PROPS.setProperty("pin", String(p.pin));
  return getState();
}

function clearPoll() {
  writeJson("active", null);
  return getState();
}

function closePoll() {
  const active = readJson("active", null);
  if (active) {
    active.open = false;
    active.armed = false;
    active.until = nowMs();
    writeJson("active", active);
  }
  return getState();
}

function castVote(p) {
  const state = getState();
  if (!state.active || state.active.id !== p.q || !state.open) return { ok: false, err: "closed" };
  const votes = readJson("votes", {});
  const box = votes[p.q] || { counts: {}, voters: [] };
  if (box.voters.indexOf(p.voter) !== -1) return { ok: true, dup: true, counts: box.counts, total: sumCounts(box.counts) };
  if (state.active.options.indexOf(p.choice) === -1) return { ok: false, err: "choice" };
  box.voters.push(String(p.voter));
  box.counts[p.choice] = Number(box.counts[p.choice] || 0) + 1;
  votes[p.q] = box;
  writeJson("votes", votes);
  return { ok: true, counts: box.counts, total: sumCounts(box.counts) };
}

function resultsOf(id) {
  const state = getState();
  const votes = readJson("votes", {});
  const box = votes[id] || { counts: {} };
  const live = state.active && state.active.id === id;
  return {
    ok: true,
    counts: box.counts || {},
    total: sumCounts(box.counts || {}),
    remaining: live ? state.remaining : 0,
    open: live ? state.open : false,
    armed: live ? Boolean(state.armed) : false,
  };
}

function resetPoll(id) {
  const votes = readJson("votes", {});
  if (id) delete votes[id];
  else Object.keys(votes).forEach(function (k) { delete votes[k]; });
  writeJson("votes", votes);
  return getState();
}

function sumCounts(counts) {
  let total = 0;
  Object.keys(counts || {}).forEach(function (k) { total += Number(counts[k] || 0); });
  return total;
}

function clientState() { return getState(); }
function clientVote(q, choice, voter) {
  return castVote({ q: q, choice: choice, voter: voter });
}

function votePageHtml() {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
  <title>صوّت | طاولة القرار</title>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@700;800;900&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100dvh; font-family: Cairo, sans-serif;
      background:
        radial-gradient(80% 50% at 80% 0%, rgba(201,165,106,.18), transparent 50%),
        linear-gradient(180deg, #10151e, #07090e);
      color: #fff8ea; padding: 22px 16px 28px;
    }
    .top { text-align: center; margin-bottom: 10px; }
    .crest {
      width: 92px; height: 92px; margin: 0 auto 10px; border-radius: 50%;
      display: grid; place-items: center; background: #fff;
      border: 3px solid #d4a017;
      box-shadow: 0 0 0 5px rgba(15, 44, 89, 0.45), 0 8px 20px rgba(0,0,0,.35);
    }
    .crest img { width: 58px; height: auto; display: block; }
    .brand { color: #c9a56a; letter-spacing: .16em; font-weight: 900; font-size: .78rem; }
    h1 { margin: 8px 0 6px; font-size: 1.15rem; font-weight: 800; }
    .q { font-size: 1.32rem; line-height: 1.65; font-weight: 900; margin: 10px 0 18px; }
    .wait, .ok, .closed { text-align: center; padding: 56px 12px; font-weight: 800; font-size: 1.2rem; }
    .wait, .ok { color: #8fd4d8; }
    .closed { color: #ffb4a8; }
    .clock { font-size: 3rem; color: #ff6b5a; margin-bottom: 8px; font-weight: 900; }
    .grid { display: grid; gap: 12px; }
    button.opt {
      display: grid; grid-template-columns: 52px 1fr; gap: 12px; align-items: center;
      min-height: 78px; padding: 14px 16px; border: 0; border-radius: 18px;
      color: #fff; font: inherit; font-weight: 800; text-align: right; cursor: pointer;
    }
    button.opt b {
      width: 52px; height: 52px; border-radius: 14px; background: rgba(0,0,0,.22);
      display: grid; place-items: center; font-size: 1.35rem;
    }
    .meta { color: #c9b89a; font-size: .85rem; margin-top: 16px; text-align: center; }
  </style>
</head>
<body>
  <div class="top">
    <div class="crest"><img src="data:image/png;base64,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" alt="أكاديمية ساندس الوطنية" /></div>
    <div class="brand">طاولة القرار</div>
    <h1>أكاديمية ساندس الوطنية</h1>
  </div>
  <div id="app"></div>
  <script>
    const LETTERS = ["أ", "ب", "ج", "د", "هـ"];
    const COLORS = ["#e21b3c", "#1368ce", "#d89e00", "#26890c", "#864cbf"];
    const app = document.getElementById("app");
    const voter = localStorage.getItem("mng-voter") || (localStorage.setItem("mng-voter", uid()), localStorage.getItem("mng-voter"));
    let lastId = "";
    let votedFor = "";
    let screen = "";

    function uid() { return "v-" + Math.random().toString(36).slice(2) + Date.now().toString(36); }
    function run(name, args, cb) {
      google.script.run.withSuccessHandler(cb).withFailureHandler(function () { cb(null); })[name].apply(null, args);
    }
    function isOpen(state) {
      return Boolean(state.active && state.open && Number(state.remaining || 0) > 0);
    }
    function isArmed(state) {
      return Boolean(state.active && (state.armed || state.active.armed) && !isOpen(state));
    }
    function paint(state) {
      if (!state) { app.innerHTML = '<div class="wait">نحاول الاتصال…</div>'; return; }
      if (!state.active) {
        lastId = "";
        votedFor = "";
        if (screen === "wait") return;
        screen = "wait";
        app.innerHTML = '<div class="wait">انتظروا هنا.<br>السؤال يظهر لوحده عند بدء الجولة.</div><p class="meta">افتحوا الرابط مرة واحدة وابقوا على الصفحة.</p>';
        return;
      }
      if (state.active.id !== lastId) { lastId = state.active.id; votedFor = ""; screen = ""; }
      if (votedFor === state.active.id) {
        if (screen === "ok") return;
        screen = "ok";
        app.innerHTML = '<div class="ok">وُسِم صوتكم.<br>شاهدوا النسب وهي تتحرك على الشاشة.</div>';
        return;
      }
      if (isArmed(state)) {
        var readyKey = "ready:" + state.active.id;
        if (screen === readyKey) return;
        screen = readyKey;
        app.innerHTML = '<p class="q"></p><div class="wait">انتظروا إشارة المضيفة.<br>سيبدأ التصويت بعد قليل.</div>';
        app.querySelector(".q").textContent = state.active.q;
        return;
      }
      if (!isOpen(state)) {
        if (screen === "closed") return;
        screen = "closed";
        app.innerHTML = '<div class="closed">انتهى التصويت.<br>ارفعوا عيونكم إلى الشاشة.</div>';
        return;
      }
      var key = "q:" + state.active.id;
      if (screen !== key) {
        screen = key;
        app.innerHTML = '<div class="clock" id="left"></div><p class="q"></p><div class="grid" id="opts"></div>';
        app.querySelector(".q").textContent = state.active.q;
        state.active.options.forEach(function (label, i) {
          var b = document.createElement("button");
          b.className = "opt";
          b.style.background = COLORS[i % COLORS.length];
          b.innerHTML = "<b>" + LETTERS[i] + "</b><span></span>";
          b.querySelector("span").textContent = label;
          b.onclick = function () {
            votedFor = state.active.id;
            run("clientVote", [state.active.id, label, voter], function () { paint(state); });
            paint(Object.assign({}, state, { open: true, remaining: 1 }));
          };
          document.getElementById("opts").appendChild(b);
        });
      }
      var clock = document.getElementById("left");
      if (clock) clock.textContent = state.remaining;
    }
    function tick() { run("clientState", [], paint); }
    tick();
    setInterval(tick, 700);
  </script>
</body>
</html>`;
}
