(() => {
  const STORAGE = "table-decision-v8";
  const LETTERS = ["أ", "ب", "ج", "د", "هـ"];
  const KAHOOT = ["#e21b3c", "#1368ce", "#d89e00", "#26890c", "#864cbf"];

  const HOST = new URLSearchParams(location.search).get("host") === "1";
  const saved = load();
  const state = {
    slide: 0,
    widgets: saved?.widgets || {},
    muted: Boolean(saved?.muted),
  };
  const app = document.getElementById("app");
  const progress = document.querySelector("[data-progress]");
  const chapter = document.querySelector("[data-chapter]");
  const count = document.querySelector("[data-slide-count]");
  const clock = document.querySelector("[data-clock]");
  const nextBtn = document.querySelector("[data-next]");
  const overlay = document.querySelector("[data-overlay]");
  const mapGrid = document.querySelector("[data-map-grid]");
  const started = Date.now();
  let audio;
  let pollTimer;
  let pollUnsub = null;
  let showUnsub = null;
  let pushing = false;
  let slideDir = 1;

  function liveOn() { return Boolean(window.Live && Live.ready()); }
  function synced() { return liveOn() || Boolean(gasUrl()); }
  function canDrive() { return HOST || !synced(); }
  function roundCount() { return SLIDES.filter((s) => s.type === "round").length; }
  function arDigits(n) {
    return String(n).replace(/[0-9]/g, (d) => "٠١٢٣٤٥٦٧٨٩"[d]);
  }

  function load() {
    try { return JSON.parse(localStorage.getItem(STORAGE) || ""); } catch { return null; }
  }
  function save() { localStorage.setItem(STORAGE, JSON.stringify(state)); }
  function wget(key, fallback) {
    if (state.widgets[key] == null) state.widgets[key] = structuredClone(fallback);
    return state.widgets[key];
  }
  function escapeHtml(v) {
    return String(v ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }
  function current() { return SLIDES[state.slide]; }
  function gasUrl() {
    return (SHOW.vote && SHOW.vote.gasUrl) || localStorage.getItem("vote-gas") || "";
  }
  function joinUrl() {
    // مع Firebase: الجوالات تدخل على vote.html من GitHub Pages (أسرع من GAS)
    if (window.Live && Live.configured()) {
      const base = (SHOW.vote.pagesUrl || `${location.origin}/`).replace(/\/?$/, "/");
      return `${base}vote.html`;
    }
    return gasUrl() || SHOW.vote.pagesUrl || `${location.origin}/vote.html`;
  }
  function qrSrc(url) {
    return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=8&data=${encodeURIComponent(url)}`;
  }

  function ctx() {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
    return audio;
  }
  function tone(freq, dur, type = "sine", vol = 0.035, slide = 0) {
    // تابلت المضيفة صامت دائماً — صوت القاعة من شاشة العرض فقط
    if (HOST || state.muted) return;
    try {
      const a = ctx();
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, a.currentTime);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), a.currentTime + dur);
      g.gain.setValueAtTime(vol, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
      o.connect(g);
      g.connect(a.destination);
      o.start();
      o.stop(a.currentTime + dur);
    } catch { /* ignore */ }
  }
  function soundNext() {
    tone(140, 0.16, "sawtooth", 0.018, 220);
    setTimeout(() => tone(262, 0.1, "triangle", 0.02), 70);
    setTimeout(() => tone(330, 0.12, "sine", 0.024), 130);
    setTimeout(() => tone(392, 0.18, "sine", 0.02), 200);
  }
  function soundReveal() {
    tone(261, 0.14, "sine", 0.03);
    setTimeout(() => tone(329, 0.16, "sine", 0.028), 80);
    setTimeout(() => tone(392, 0.2, "triangle", 0.026), 160);
    setTimeout(() => tone(523, 0.32, "sine", 0.03), 240);
  }
  function soundFinale() {
    tone(196, 0.22); setTimeout(() => tone(247, 0.26), 160); setTimeout(() => tone(330, 0.4), 340);
    setTimeout(() => tone(392, 0.45, "triangle", 0.02), 520);
  }
  function soundVote() { tone(720, 0.05, "triangle", 0.018); setTimeout(() => tone(880, 0.07, "sine", 0.014), 35); }
  function soundWarn() { tone(196, 0.09, "square", 0.03); setTimeout(() => tone(160, 0.1, "square", 0.022), 90); }
  /** نغمة تلفزيونية عند بدء التصويت — أعلى وأطول */
  function soundVoteGo() {
    tone(140, 0.12, "square", 0.085);
    setTimeout(() => tone(180, 0.12, "square", 0.09), 110);
    setTimeout(() => tone(230, 0.14, "square", 0.095), 230);
    setTimeout(() => tone(300, 0.16, "sawtooth", 0.09, 160), 370);
    setTimeout(() => tone(420, 0.28, "sawtooth", 0.1, 220), 540);
    setTimeout(() => tone(560, 0.42, "triangle", 0.1), 760);
    setTimeout(() => tone(780, 0.55, "sine", 0.085), 980);
    setTimeout(() => tone(1040, 0.7, "triangle", 0.07), 1280);
    setTimeout(() => tone(1310, 0.45, "sine", 0.05), 1650);
  }
  let lastVotes = 0;
  let lastRemain = 99;

  function jsonp(url, params) {
    return new Promise((resolve, reject) => {
      const cb = `kcb${Math.random().toString(36).slice(2)}`;
      const q = new URLSearchParams({ ...params, callback: cb });
      const s = document.createElement("script");
      const t = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 8000);
      function cleanup() {
        clearTimeout(t);
        delete window[cb];
        s.remove();
      }
      window[cb] = (data) => { cleanup(); resolve(data); };
      s.onerror = () => { cleanup(); reject(new Error("net")); };
      s.src = `${url}${url.includes("?") ? "&" : "?"}${q}`;
      document.body.appendChild(s);
    });
  }

  function render() {
    const slide = current();
    const last = SLIDES.length - 1;
    progress.style.width = `${(state.slide / last) * 100}%`;
    count.textContent = `${state.slide + 1} من ${SLIDES.length}`;
    chapter.textContent = chapterOf(slide);
    nextBtn.textContent = "التالي";
    document.body.classList.toggle("is-finale", slide.type === "finale");
    document.body.classList.toggle("is-round", slide.type === "round");
    document.body.classList.toggle("is-host", canDrive());
    document.body.classList.toggle("is-follow", !canDrive());
    nextBtn.hidden = slide.type === "finale" || !canDrive();
    const role = document.querySelector("[data-role]");
    if (role) {
      role.hidden = !synced();
      role.textContent = canDrive() ? "قيادة الجلسة" : "عرض مباشر";
    }
    clearInterval(pollTimer);
    if (pollUnsub) { pollUnsub(); pollUnsub = null; }
    app.dataset.dir = slideDir > 0 ? "next" : "prev";
    if (canDrive() && slide.type !== "round" && slide.type !== "finale") clearPoll();

    if (slide.type === "title") app.innerHTML = titleView();
    else if (slide.type === "map") app.innerHTML = mapView();
    else if (slide.type === "round") app.innerHTML = roundView(slide.id);
    else if (slide.type === "finale") app.innerHTML = finaleView();

    bindSlide();
    app.focus({ preventScroll: true });
    save();
    if (canDrive() && synced()) pushShow();
  }

  function chapterOf(slide) {
    if (slide.type === "title") return SHOW.school;
    if (slide.type === "map") return "خريطة اللقاء";
    if (slide.type === "finale") return "سؤال الختام";
    return ROUNDS[slide.id].act;
  }

  function titleView() {
    return `
      <section class="slide hero">
        <div class="hero-side tech">
          <h2>قسم تكنولوجيا المعلومات</h2>
          <p>لغة البنية، الأمن، والتشغيل.</p>
        </div>
        <div class="hero-side admin">
          <h2>الإدارة العامة</h2>
          <p>لغة الاستراتيجية، الميزانية، والحوكمة.</p>
        </div>
        <div class="center-badge">
          <div class="crest"><img src="img/sands-logo.png" alt="أكاديمية ساندس الوطنية" /></div>
          <strong class="school-name">${SHOW.school}</strong>
          <em class="school-en">${SHOW.schoolEn}</em>
          <h1>${SHOW.title}</h1>
          <p class="event-title">${SHOW.event}</p>
          <p class="tag-line">بين لغة الإدارة.. ولغة الأكواد</p>
        </div>
      </section>`;
  }

  function mapView() {
    const vote = joinUrl();
    return `
      <section class="slide panel-page map-photo">
        <div class="map-layout">
          <aside class="join-qr">
            <img src="${qrSrc(vote)}" alt="امسحوا للتصويت" />
            <strong>ضيوف القاعة</strong>
            <span>امسحوا للتصويت</span>
          </aside>
          <div>
            <div class="kicker">${arDigits(roundCount())} جولة</div>
            <h1>خريطة الطاولة</h1>
            <p class="lead">اقفزوا إلى أي محور. الجمهور يصوّت أولاً ثم يتكلم الضيفان.</p>
            <div class="map-page">${ACTS.map((a) => `
              <button type="button" class="map-card" data-jump-round="${a.rounds[0]}">
                <b>${a.rounds.length === 1 ? "جولة واحدة" : `${a.rounds.length} جولات`}</b>
                <h3>${a.name}</h3>
              </button>`).join("")}</div>
          </div>
        </div>
      </section>`;
  }

  function termsHtml(terms = []) {
    return `<div class="terms" aria-hidden="true">${terms.map((t) => `<span>${t}</span>`).join("")}</div>`;
  }

  function traitsBox() {
    return wget("r9-traits", {
      items: [
        { n: "الشخصية والذكاء العاطفي", v: 20 },
        { n: "النزاهة وحفظ الأسرار", v: 20 },
        { n: "الكفاءة التقنية", v: 20 },
        { n: "التفكير القيادي", v: 20 },
        { n: "الاتزان تحت الضغط", v: 20 },
      ],
    });
  }

  function traitsHtml() {
    const box = traitsBox();
    return `<div class="live-traits" data-traits>
      ${box.items.map((it, i) => `
        <div class="lt-col">
          <b data-tv>${it.v}٪</b>
          <div class="lt-shaft"><em style="height:${it.v}%"></em></div>
          <span>${it.n}</span>
          ${canDrive() ? `<input type="range" min="0" max="100" value="${it.v}" data-trait="${i}" />` : ""}
        </div>`).join("")}
    </div>`;
  }

  function paintTraits() {
    const box = traitsBox();
    app.querySelectorAll("[data-traits] .lt-col").forEach((col, i) => {
      const it = box.items[i];
      if (!it) return;
      const val = col.querySelector("[data-tv]");
      const bar = col.querySelector("em");
      const range = col.querySelector("input");
      if (val) val.textContent = `${it.v}٪`;
      if (bar) bar.style.height = `${it.v}%`;
      if (range && Number(range.value) !== it.v) range.value = it.v;
    });
  }

  function pollHtml(id) {
    const poll = POLLS[id];
    if (!poll) return "";
    const n = Math.min(poll.options.length, 5);
    const cols = poll.options.map((opt, i) => `
      <div class="v-col" data-opt="${escapeHtml(opt)}" style="--k:${KAHOOT[i % KAHOOT.length]}">
        <b data-pct data-n="0">٠٪</b>
        <div class="v-shaft">
          <i></i>
          <div class="v-foot"><em>${LETTERS[i]}</em><span>${opt}</span></div>
        </div>
      </div>`).join("");
    return `<div class="kahoot is-ready${n >= 5 ? " has-many" : ""}" data-poll="${id}">
      <div class="k-head">
        <div class="k-clock"><strong data-k-clock>${SHOW.vote.seconds}</strong><small>ثانية</small></div>
        <div>
          <div class="on-air" data-air><i></i> انتظار</div>
          <h3>${poll.q}</h3>
        </div>
        <div class="k-live"><strong data-k-total>٠</strong><small>صوت حي</small></div>
      </div>
      <div class="v-grid" style="--n:${n}">${cols}</div>
      ${canDrive() ? `<button type="button" class="vote-go" data-start-vote>ابدأ التصويت</button>` : ""}
      <p class="k-wait">اقرأوا السؤال أولاً. التصويت لم يبدأ بعد.</p>
    </div>`;
  }

  function roundView(id) {
    const r = ROUNDS[id];
    return `
      <section class="slide studio${id === 9 ? " has-traits" : ""}">
        <div class="round-head">
          <div>
            <div class="axis"><i></i><span>المحور</span><strong>${r.act}</strong></div>
            <h2>${r.title}</h2>
          </div>
          <small>الجولة ${String(SLIDES.filter((s) => s.type === "round").findIndex((s) => s.id === id) + 1).padStart(2, "0")} من ${arDigits(roundCount())}</small>
        </div>
        <div class="split">
          <article class="pane admin">
            <div class="who">الإدارة العامة</div>
            <p class="q">${r.admin.question}</p>
            ${termsHtml(r.admin.terms)}
          </article>
          <div class="spine">مقابل</div>
          <article class="pane tech">
            <div class="who">قسم تكنولوجيا المعلومات</div>
            <p class="q">${r.tech.question}</p>
            ${termsHtml(r.tech.terms)}
          </article>
        </div>
        ${id === 9 ? traitsHtml() : ""}
        ${pollHtml(r.poll)}
      </section>`;
  }

  function finaleView() {
    const poll = POLLS.finale;
    const cols = poll.options.map((opt, i) => `
      <div class="v-col" data-opt="${escapeHtml(opt)}" style="--k:${KAHOOT[i % KAHOOT.length]}">
        <b data-pct data-n="0">٠٪</b>
        <div class="v-shaft">
          <i></i>
          <div class="v-foot"><em>${LETTERS[i]}</em><span>${opt}</span></div>
        </div>
      </div>`).join("");
    return `
      <section class="slide finale finale-vote">
        <div class="finale-photo" aria-hidden="true"></div>
        <div class="finale-top">
          <div class="crest finale-crest"><img src="img/sands-logo.png" alt="أكاديمية ساندس الوطنية" /></div>
          <strong class="school-name">${SHOW.school}</strong>
          <div class="finale-badge">سؤال الختام</div>
        </div>
        <p class="finale-q">${poll.q}</p>
        <div class="kahoot finale-kahoot is-ready" data-poll="finale">
          <div class="k-head">
            <div class="k-clock"><strong data-k-clock>${SHOW.vote.seconds}</strong><small>ثانية</small></div>
            <div>
              <div class="on-air" data-air><i></i> انتظار</div>
              <h3>أين تضعون الثقل الأكبر؟</h3>
            </div>
            <div class="k-live"><strong data-k-total>٠</strong><small>صوت حي</small></div>
          </div>
          <div class="v-grid" style="--n:2">${cols}</div>
          ${canDrive() ? `<button type="button" class="vote-go" data-start-vote>ابدأ التصويت</button>` : ""}
          <p class="k-wait">سؤال الختام للطالبات. اضغطوا ابدأ التصويت عندما تكون القاعة جاهزة.</p>
        </div>
      </section>`;
  }

  function paintPoll(id, counts, total, remaining, open, armed) {
    const poll = POLLS[id];
    const host = app.querySelector(`[data-poll="${id}"]`);
    if (!poll || !host) return;
    const sum = total || Object.values(counts).reduce((s, n) => s + Number(n || 0), 0);
    const liveEl = host.querySelector("[data-k-total]");
    const clockEl = host.querySelector("[data-k-clock]");
    const air = host.querySelector("[data-air]");
    const go = host.querySelector("[data-start-vote]");
    if (liveEl) liveEl.textContent = String(sum);
    const voting = open === true && Number(remaining) > 0;
    const ready = Boolean(armed) && !voting;
    const closed = !ready && !voting;
    if (clockEl) {
      clockEl.textContent = voting || remaining != null
        ? String(Math.max(0, ready ? SHOW.vote.seconds : remaining))
        : String(SHOW.vote.seconds);
      if (ready) clockEl.textContent = String(SHOW.vote.seconds);
    }
    if (sum > lastVotes && voting) soundVote();
    lastVotes = sum;
    const left = remaining == null ? 99 : Math.max(0, remaining);
    if (voting && left <= 3 && left > 0 && left < lastRemain) soundWarn();
    lastRemain = left;
    host.classList.toggle("is-ready", ready);
    host.classList.toggle("is-live", voting);
    host.classList.toggle("is-closed", closed);
    host.classList.toggle("is-danger", voting && left <= 3);
    if (air) air.innerHTML = voting ? "<i></i> مباشر" : ready ? "<i></i> انتظار" : "<i></i> أُغلق";
    if (go) go.hidden = !ready;
    const highs = poll.options.map((o) => {
      const c = Number(counts[o] || 0);
      return sum ? Math.round((c / sum) * 100) : 0;
    });
    const top = Math.max(0, ...highs);
    if (closed) host.classList.add("is-reveal");
    host.querySelectorAll(".v-col").forEach((col) => {
      const n = Number(counts[col.dataset.opt] || 0);
      const pct = sum ? Math.round((n / sum) * 100) : 0;
      const bar = col.querySelector("i");
      if (bar) bar.style.height = ready ? "0%" : `${pct}%`;
      countTo(col.querySelector("[data-pct]"), ready ? 0 : pct);
      col.classList.toggle("is-hot", closed && pct > 0 && pct === top);
    });
  }

  function countTo(el, next) {
    if (!el) return;
    const prev = Number(el.dataset.n || 0);
    if (prev === next) {
      el.textContent = `${next}٪`;
      return;
    }
    el.dataset.n = String(next);
    const start = performance.now();
    const dur = 520;
    const step = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - (1 - p) ** 3;
      el.textContent = `${Math.round(prev + (next - prev) * eased)}٪`;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  async function api(action, extra = {}) {
    const gas = gasUrl();
    if (gas) return jsonp(gas, { action, pin: SHOW.vote.pin, seconds: String(SHOW.vote.seconds), ...extra });
    if (action === "results" || action === "state" || action === "show") {
      const q = new URLSearchParams(extra);
      const res = await fetch(`/api/${action}${q.toString() ? `?${q}` : ""}`, { cache: "no-store" });
      return res.json();
    }
    const res = await fetch(`/api/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: SHOW.vote.pin, seconds: SHOW.vote.seconds, ...extra }),
    });
    return res.json();
  }

  async function pushShow() {
    if (pushing) return;
    pushing = true;
    try {
      if (liveOn()) await Live.pushShow(state.slide, state.widgets);
      else await api("goto", { slide: String(state.slide), widgets: JSON.stringify(state.widgets) });
    } catch { /* rehearsal */ }
    pushing = false;
  }

  function pollPayload(id) {
    const poll = POLLS[id];
    if (!poll) return null;
    return { id, q: poll.q, options: poll.options };
  }

  async function armPoll(id) {
    const poll = pollPayload(id);
    if (!poll) return;
    try {
      if (liveOn()) await Live.armPoll(poll);
      else await api("arm", { payload: JSON.stringify(poll), poll });
    } catch { /* rehearsal */ }
  }

  async function openPoll(id) {
    const poll = pollPayload(id);
    if (!poll) return;
    try {
      if (liveOn()) await Live.openPoll(poll, SHOW.vote.seconds);
      else await api("open", { payload: JSON.stringify(poll), poll });
    } catch { /* rehearsal */ }
  }

  async function closePoll() {
    try {
      if (liveOn()) await Live.closePoll();
      else await api("close");
    } catch { /* ignore */ }
  }

  async function clearPoll() {
    try {
      if (liveOn()) await Live.clearPoll();
      else await api("clear");
    } catch { /* ignore */ }
  }

  function bindPoll() {
    const host = app.querySelector("[data-poll]");
    if (!host) return;
    const id = host.dataset.poll;
    lastVotes = 0;
    lastRemain = 99;
    let wasLive = false;
    let locked = false;
    let started = false;
    let snap = null;
    let heardGo = false;

    const viewOf = (raw) => {
      if (!raw) return null;
      const until = Number(raw.until || 0);
      const left = until > 0 ? Math.max(0, Math.floor((until - Date.now()) / 1000)) : Number(raw.remaining || 0);
      const open = Boolean(raw.active) && until > Date.now();
      const armed = Boolean(raw.armed || (raw.active && raw.active.armed)) && !open;
      return {
        active: raw.active,
        counts: raw.counts || {},
        total: raw.total || 0,
        remaining: open ? left : (armed ? SHOW.vote.seconds : 0),
        open,
        armed,
        until,
      };
    };

    const apply = (raw) => {
      if (!raw) return;
      snap = raw;
      const data = viewOf(raw);
      if (!data) return;
      if (!data.open) {
        heardGo = false;
        window.__voteGoQueued = false;
      }
      if (data.open && data.remaining > 0) {
        if (!heardGo) {
          heardGo = true;
          if (!HOST) {
            if (window.__displayAudioReady) soundVoteGo();
            else window.__voteGoQueued = true;
          }
        }
        wasLive = true;
        started = true;
      }
      const waiting = !started && !wasLive && !data.open;
      paintPoll(id, data.counts, data.total, data.remaining, data.open, waiting || data.armed);
      if (!locked && wasLive && !data.open) {
        locked = true;
        clearInterval(pollTimer);
        if (pollUnsub) { pollUnsub(); pollUnsub = null; }
        if (canDrive()) closePoll();
        if (!HOST) soundReveal();
      }
    };

    const tick = async () => {
      try {
        if (liveOn()) {
          if (snap) apply(snap);
          return;
        }
        const data = gasUrl()
          ? await api("results", { q: id })
          : await (await fetch(`/api/results?q=${encodeURIComponent(id)}`, { cache: "no-store" })).json();
        apply(data);
      } catch { /* keep last bars */ }
    };

    const go = host.querySelector("[data-start-vote]");
    if (go) {
      go.onclick = async () => {
        go.disabled = true;
        started = true;
        lastRemain = 99;
        lastVotes = 0;
        await openPoll(id);
        if (!liveOn()) tick();
      };
    }

    const start = canDrive() ? armPoll(id) : Promise.resolve();
    start.then(() => {
      if (liveOn()) {
        pollUnsub = Live.onPoll((data) => {
          if (data.active && data.active.id !== id) return;
          apply(data);
        });
        // يحرّك العدّاد كل ربع ثانية محلياً بدون طرق السيرفر
        pollTimer = setInterval(() => { if (snap) apply(snap); }, 250);
      } else {
        tick();
        pollTimer = setInterval(tick, 400);
      }
    });
  }

  function bindSlide() {
    bindPoll();
    app.querySelectorAll("[data-jump-round]").forEach((el) => {
      el.onclick = () => { if (canDrive()) jumpToRound(Number(el.dataset.jumpRound)); };
    });
    app.querySelectorAll("[data-trait]").forEach((el) => {
      el.oninput = () => {
        const box = traitsBox();
        const i = Number(el.dataset.trait);
        if (!box.items[i]) return;
        box.items[i].v = Number(el.value);
        paintTraits();
        save();
        if (synced()) pushShow();
      };
    });
  }

  function jumpToRound(id) {
    if (!canDrive()) return;
    const i = SLIDES.findIndex((s) => s.type === "round" && s.id === id);
    if (i >= 0) { slideDir = 1; state.slide = i; closeMap(); soundNext(); render(); }
  }
  function next() {
    if (!canDrive()) return;
    if (state.slide < SLIDES.length - 1) {
      slideDir = 1;
      state.slide += 1;
      if (current().type === "finale") soundFinale();
      else soundNext();
      render();
    }
  }
  function prev() {
    if (!canDrive()) return;
    if (state.slide > 0) { slideDir = -1; state.slide -= 1; soundNext(); render(); }
  }
  function closeMap() {
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
  }

  document.querySelector("[data-next]").onclick = next;
  document.querySelector("[data-prev]").onclick = prev;
  document.querySelector("[data-fs]").onclick = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  };
  function paintMute() {
    const btn = document.querySelector("[data-mute]");
    btn.classList.toggle("is-muted", state.muted);
    btn.setAttribute("aria-label", state.muted ? "تشغيل الصوت" : "كتم الصوت");
    btn.setAttribute("aria-pressed", state.muted ? "true" : "false");
  }
  document.querySelector("[data-mute]").onclick = () => {
    state.muted = !state.muted;
    try { ctx(); } catch { /* unlock */ }
    paintMute();
    save();
  };

  // شاشة العرض فقط: لمسة واحدة تفتح قفل الصوت في المتصفح
  window.__displayAudioReady = false;
  window.__voteGoQueued = false;
  document.body.dataset.device = HOST ? "host" : "display";

  function armDisplayAudio() {
    if (HOST || window.__displayAudioReady) return;
    try {
      state.muted = false;
      paintMute();
      save();
      ctx();
      window.__displayAudioReady = true;
      const tip = document.querySelector("[data-audio-arm]");
      if (tip) tip.remove();
      // تأكيد مسموع: إذا سمعتوا هذي من سماعات القاعة، الصوت جاهز
      tone(660, 0.14, "sine", 0.1);
      setTimeout(() => tone(990, 0.22, "triangle", 0.09), 130);
      if (window.__voteGoQueued) {
        window.__voteGoQueued = false;
        setTimeout(() => soundVoteGo(), 450);
      }
    } catch { /* ignore */ }
  }

  if (!HOST) {
    const tip = document.createElement("button");
    tip.type = "button";
    tip.className = "audio-arm";
    tip.setAttribute("data-audio-arm", "");
    tip.innerHTML = "<b>تفعيل صوت القاعة</b><span>اضغطوا في أي مكان على شاشة العرض مرة واحدة قبل بدء التصويت</span>";
    tip.onclick = (e) => { e.stopPropagation(); armDisplayAudio(); };
    document.body.appendChild(tip);
    window.addEventListener("pointerdown", () => armDisplayAudio(), { passive: true });
  }
  document.querySelector("[data-open-map]").onclick = () => {
    mapGrid.innerHTML = `
      ${ACTS.map((a) => `
      <button type="button" class="map-card" data-jump-round="${a.rounds[0]}">
        <b>${a.rounds.length === 1 ? "جولة واحدة" : `${a.rounds.length} جولات`}</b><h3>${a.name}</h3>
      </button>`).join("")}`;
    mapGrid.querySelectorAll("[data-jump-round]").forEach((el) => {
      el.onclick = () => jumpToRound(Number(el.dataset.jumpRound));
    });
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
  };
  document.querySelector("[data-close-map]").onclick = closeMap;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeMap(); });

  window.addEventListener("keydown", (e) => {
    if (["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
    if (e.key === "ArrowLeft" || e.key === " " || e.key === "PageDown") { e.preventDefault(); next(); }
    if (e.key === "ArrowRight" || e.key === "PageUp") { e.preventDefault(); prev(); }
    if (e.key.toLowerCase() === "m" && canDrive()) document.querySelector("[data-open-map]").click();
    if (e.key.toLowerCase() === "f") document.querySelector("[data-fs]").click();
    if (e.key.toLowerCase() === "v" && canDrive()) {
      const go = app.querySelector("[data-start-vote]");
      if (go && !go.hidden && !go.disabled) { e.preventDefault(); go.click(); }
    }
  });

  function followShow(data) {
    if (!data || data.ok === false) return;
    if (data.widgets && typeof data.widgets === "object") state.widgets = data.widgets;
    if (Number(data.slide) !== state.slide) {
      slideDir = Number(data.slide) > state.slide ? 1 : -1;
      state.slide = Number(data.slide);
      soundNext();
      render();
      return;
    }
    paintTraits();
  }

  function startFollow() {
    if (canDrive()) return;
    if (liveOn()) {
      showUnsub = Live.onShow(followShow);
      return;
    }
    setInterval(async () => {
      if (canDrive()) return;
      try {
        followShow(await api("show"));
      } catch { /* keep last frame */ }
    }, 500);
  }

  setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    clock.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 500);

  paintMute();
  const crest = '<img class="ticker-crest" src="img/sands-logo.png" alt="" />';
  const tickerLine = SHOW.ticker.map((t) => `<span>${t}</span>${crest}`).join("");
  document.querySelector("[data-ticker]").innerHTML = `${tickerLine}${tickerLine}`;

  (async () => {
    if (window.Live) await Live.init();
    startFollow();
    render();
  })();
})();
