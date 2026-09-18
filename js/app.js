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
    cue: {
      open: Boolean(saved?.cue?.open),
      index: Number(saved?.cue?.index) || 0,
    },
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
  function toLatinDigits(s) {
    return String(s ?? "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
  }
  const arDigits = toLatinDigits;

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
  /** تكت العدّ التنازلي — ناعم طول الوقت، وأوضح شوي في آخر 3 ثوانٍ */
  function soundTick(left) {
    if (left <= 3) {
      tone(520, 0.07, "sine", 0.028);
      setTimeout(() => tone(390, 0.09, "triangle", 0.022), 55);
      return;
    }
    tone(880, 0.035, "sine", 0.012);
    setTimeout(() => tone(660, 0.045, "triangle", 0.01), 28);
  }

  // ستينغ بدء التصويت — حجم مخفّف + احتياط ناعم بدل الموجات الحادة
  const voteGoEl = document.getElementById("vote-go-audio");
  const unlockEl = document.getElementById("audio-unlock");
  let lastGoUntil = 0;
  let pendingGoUntil = 0;
  let audioArmed = HOST; // المضيفة عندها لمسة زر «ابدأ»

  function playVoteGoFile() {
    if (state.muted) return false;
    try {
      if (!voteGoEl) return false;
      voteGoEl.muted = false;
      voteGoEl.volume = 0.42;
      voteGoEl.pause();
      voteGoEl.currentTime = 0;
      const p = voteGoEl.play();
      if (p && p.catch) p.catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  function soundVoteGo() {
    if (state.muted) return;
    const played = playVoteGoFile();
    // احتياط ناعم على شاشة القاعة فقط إذا الملف ما اشتغل
    if (HOST || played) return;
    tone(392, 0.14, "sine", 0.028);
    setTimeout(() => tone(523, 0.16, "triangle", 0.026), 110);
    setTimeout(() => tone(659, 0.22, "sine", 0.024), 230);
  }

  /** مرة لكل جولة على شاشة العرض — المضيفة تشغّل من زر ابدأ */
  function triggerVoteGo(until, force) {
    if (HOST) return;
    const key = Number(until || 0);
    if (!key) return;
    if (!force && key === lastGoUntil) return;
    if (!audioArmed) {
      pendingGoUntil = key;
      return;
    }
    lastGoUntil = key;
    pendingGoUntil = 0;
    soundVoteGo();
  }

  /** تفاعلات طافية — حرف ولون الخيار اللي زاد، والموقع عشوائي على الشاشة */
  function burstVoteFx(host, gains) {
    const layer = host.querySelector("[data-vote-fx]");
    if (!layer || !gains || !gains.length) return;
    const cols = [...host.querySelectorAll(".v-col")];
    if (!cols.length) return;
    gains.forEach(({ opt, n }) => {
      const col = cols.find((c) => c.dataset.opt === opt) || cols[0];
      const letter = (col.querySelector("em") || {}).textContent || "•";
      const color = col.style.getPropertyValue("--k") || "#c9a56a";
      const count = Math.min(3, Math.max(1, Number(n) || 1));
      for (let i = 0; i < count; i++) {
        if (layer.childElementCount >= 16) return;
        const el = document.createElement("span");
        el.className = "vote-fx-item";
        el.style.setProperty("--x", `${8 + Math.random() * 84}%`);
        el.style.setProperty("--k", color.trim());
        el.style.setProperty("--drift", `${-48 + Math.random() * 96}px`);
        el.style.setProperty("--dur", `${1.15 + Math.random() * 0.7}s`);
        el.textContent = letter;
        layer.appendChild(el);
        el.addEventListener("animationend", () => el.remove(), { once: true });
      }
    });
  }

  let lastVotes = 0;
  let lastCounts = {};
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
    document.body.classList.toggle("is-finale", slide.type === "finale" || slide.type === "closing");
    document.body.classList.toggle("is-closing", slide.type === "closing");
    document.body.classList.toggle("is-round", slide.type === "round");
    document.body.classList.toggle("is-host", canDrive());
    document.body.classList.toggle("is-follow", !canDrive());
    nextBtn.hidden = slide.type === "closing" || !canDrive();
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
    else if (slide.type === "closing") app.innerHTML = closingView();

    bindSlide();
    app.focus({ preventScroll: true });
    save();
    if (canDrive() && synced()) pushShow();
  }

  function chapterOf(slide) {
    if (slide.type === "title") return SHOW.school;
    if (slide.type === "map") return "خريطة اللقاء";
    if (slide.type === "finale") return "سؤال الختام";
    if (slide.type === "closing") return "كلمة الختام";
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
      <div class="vote-fx" data-vote-fx aria-hidden="true"></div>
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
          <div class="vote-fx" data-vote-fx aria-hidden="true"></div>
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

  function closingView() {
    return `
      <section class="slide finale closing">
        <div class="finale-photo" aria-hidden="true"></div>
        <div class="crest finale-crest"><img src="img/sands-logo.png" alt="أكاديمية ساندس الوطنية" /></div>
        <strong class="school-name">${SHOW.school}</strong>
        <div class="kicker">نغلق الميكروفون ولا نغلق السؤال</div>
        <div class="closing-pair">
          <p class="closing-quote is-admin">
            <span class="role-kicker">للإدارة</span>
            <span>يمكن أن يكون القائد رقمياً دون أن يتقن كل الأدوات.</span>
            <strong>يكون القائد رقمياً عندما يعي أثر ما يوقّع عليه.</strong>
          </p>
          <p class="closing-quote is-tech">
            <span class="role-kicker">تكنولوجيا المعلومات</span>
            <strong>الأداة تشيخ، ولكن العقلية التي تتعلم أسرع من الأداة لا تُستبدل أبداً.</strong>
          </p>
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
    if (sum > lastVotes && voting) {
      soundVote();
      const gains = [];
      Object.keys(counts || {}).forEach((opt) => {
        const next = Number(counts[opt] || 0);
        const prev = Number(lastCounts[opt] || 0);
        if (next > prev) gains.push({ opt, n: next - prev });
      });
      if (gains.length) burstVoteFx(host, gains);
    }
    lastVotes = sum;
    lastCounts = { ...(counts || {}) };
    const left = remaining == null ? 99 : Math.max(0, remaining);
    if (voting && left > 0 && left < lastRemain) soundTick(left);
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
    lastCounts = {};
    lastRemain = 99;
    let wasLive = false;
    let locked = false;
    let started = false;
    let snap = null;

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
      if (data.open && data.remaining > 0) {
        wasLive = true;
        started = true;
        triggerVoteGo(data.until);
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
        lastCounts = {};
        // لمسة المضيفة تفتح قفل الصوت وتشغّل الستينغ فوراً
        audioArmed = true;
        state.muted = false;
        paintMute();
        soundVoteGo();
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
      if (current().type === "closing") soundFinale();
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

  // شاشة العرض: لمسة واحدة تفتح قفل الصوت في المتصفح
  document.body.dataset.device = HOST ? "host" : "display";

  function armDisplayAudio() {
    if (HOST || audioArmed) return;
    try {
      state.muted = false;
      paintMute();
      save();
      ctx();
      if (unlockEl) {
        unlockEl.muted = true;
        const unlock = unlockEl.play();
        if (unlock && unlock.then) {
          unlock.then(() => {
            unlockEl.pause();
            unlockEl.currentTime = 0;
            unlockEl.muted = false;
          }).catch(() => { unlockEl.muted = false; });
        } else {
          unlockEl.muted = false;
        }
      }
      audioArmed = true;
      document.body.dataset.audioReady = "1";
      const tip = document.querySelector("[data-audio-arm]");
      if (tip) tip.remove();
      tone(660, 0.14, "sine", 0.1);
      setTimeout(() => tone(990, 0.22, "triangle", 0.09), 130);
      if (pendingGoUntil) triggerVoteGo(pendingGoUntil, true);
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
    // ====== اختصارات ملاحظات المذيعة (HOST فقط) ======
    if (HOST) {
      if (e.key.toLowerCase() === "c") { e.preventDefault(); toggleCue(); }
      if (state.cue.open) {
        if (e.key === "ArrowDown") { e.preventDefault(); cueNext(); }
        if (e.key === "ArrowUp") { e.preventDefault(); cuePrev(); }
        if (e.key === "Escape") { e.preventDefault(); closeCue(); }
      }
    }
  });

  // ========================================================
  // 🎙️ ملاحظات المذيعة جود — Cue Cards Sidebar (HOST فقط)
  // ========================================================
  const cueSidebar = document.querySelector("[data-cue-sidebar]");
  const cueBody = document.querySelector("[data-cue-side-body]");
  const cueStep = document.querySelector("[data-cue-side-step]");
  const cueProgress = document.querySelector("[data-cue-side-progress]");
  const cueDots = document.querySelector("[data-cue-side-dots]");
  const cueToggleBtn = document.querySelector("[data-toggle-cues]");
  const cueHasData = Boolean(window.CUE_CARDS && Array.isArray(window.CUE_CARDS) && window.CUE_CARDS.length);

  // إخفاء زر ملاحظات المذيعة إذا لم نكن في وضع HOST أو لا توجد بيانات
  if (!HOST || !cueHasData) {
    if (cueToggleBtn) cueToggleBtn.style.display = "none";
    if (cueSidebar) cueSidebar.style.display = "none";
  } else {
    if (cueToggleBtn) cueToggleBtn.style.display = "grid";
  }

  function cueTotal() { return cueHasData ? window.CUE_CARDS.length : 0; }
  function cueCurrent() { return cueHasData ? window.CUE_CARDS[state.cue.index] : null; }

  function cueTypeMeta(type) {
    const map = {
      "opening":           { icon: "🏛️", label: "افتتاحية", cls: "cue-opening" },
      "audience-greeting": { icon: "👋", label: "ترحيب بالحضور", cls: "cue-greeting" },
      "explanation":       { icon: "💡", label: "شرح وآلية", cls: "cue-explain" },
      "vote-call":         { icon: "📊", label: "دعوة للتصويت", cls: "cue-vote" },
      "results-comment":   { icon: "📈", label: "تعليق على النتائج", cls: "cue-results" },
      "admin-intro":       { icon: "🎤", label: "مقدمة سؤال الإدارة", cls: "cue-admin" },
      "transition-to-tolleen": { icon: "🔄", label: "تحويل لتولين", cls: "cue-transition" },
      "finale-intro":      { icon: "🌟", label: "مقدمة الختام", cls: "cue-finale" },
      "closing":           { icon: "✨", label: "كلمة ختام", cls: "cue-closing" },
    };
    return map[type] || { icon: "📝", label: type, cls: "cue-default" };
  }

  function renderCue() {
    if (!HOST || !cueHasData || !cueSidebar) return;
    const total = cueTotal();
    const last = total - 1;
    state.cue.index = Math.max(0, Math.min(state.cue.index, last));
    const card = cueCurrent();
    if (!card) return;

    if (cueStep) cueStep.textContent = `الخطوة ${state.cue.index + 1} من ${total}`;
    if (cueProgress) cueProgress.style.width = `${((state.cue.index + 1) / total) * 100}%`;

    const meta = cueTypeMeta(card.type);
    const contentHtml = Array.isArray(card.content)
      ? card.content.map((line) => line ? `<p>${escapeHtml(line)}</p>` : `<div class="s-cue-gap"></div>`).join("")
      : `<p>${escapeHtml(card.content || "")}</p>`;
    const noteHtml = card.note ? `<div class="s-cue-note">📌 ${escapeHtml(card.note)}</div>` : "";
    const subHtml = card.subtitle ? `<div class="s-cue-sub">${escapeHtml(card.subtitle)}</div>` : "";

    cueBody.innerHTML = `
      <article class="s-cue-card ${meta.cls}">
        <div class="s-cue-head">
          <span class="s-cue-group">${escapeHtml(card.group || "")}</span>
          <span class="s-cue-type">${meta.icon} ${meta.label}</span>
        </div>
        <h3 class="s-cue-title">${escapeHtml(card.title || "")}</h3>
        ${subHtml}
        ${noteHtml}
        <div class="s-cue-body">${contentHtml}</div>
        <div class="s-cue-foot">
          <span class="s-cue-idx">${String(state.cue.index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}</span>
          <span class="s-cue-label">${escapeHtml(card.label || "")}</span>
        </div>
      </article>
    `;

    // النقاط
    if (cueDots) {
      cueDots.innerHTML = window.CUE_CARDS.map((c, i) => {
        const active = i === state.cue.index;
        const gap = i > 0 && window.CUE_CARDS[i].group !== window.CUE_CARDS[i - 1].group;
        return `
          ${gap ? '<span class="s-dot-gap"></span>' : ""}
          <button type="button" class="s-cue-dot ${active ? "is-active" : ""}" data-cue-jump="${i}" title="${escapeHtml(c.label || c.title || "")}">
            ${cueTypeMeta(c.type).icon}
          </button>
        `;
      }).join("");
      cueDots.querySelectorAll("[data-cue-jump]").forEach((el) => {
        el.onclick = () => { state.cue.index = Number(el.dataset.cueJump); save(); renderCue(); };
      });
    }
  }

  function openCue() {
    if (!HOST || !cueHasData || !cueSidebar) return;
    state.cue.open = true;
    cueSidebar.hidden = false;
    cueSidebar.setAttribute("aria-hidden", "false");
    document.body.classList.add("is-cue-open");
    if (cueToggleBtn) cueToggleBtn.classList.add("is-active");
    save();
    renderCue();
    // محاولة إلقاء الضوء على البطاقة المناسبة بناءً على الشريحة الحالية
    autoSuggestCue();
  }
  function closeCue() {
    if (!cueSidebar) return;
    state.cue.open = false;
    cueSidebar.hidden = true;
    cueSidebar.setAttribute("aria-hidden", "true");
    document.body.classList.remove("is-cue-open");
    if (cueToggleBtn) cueToggleBtn.classList.remove("is-active");
    save();
  }
  function toggleCue() {
    if (state.cue.open) closeCue();
    else openCue();
  }
  function cueNext() {
    if (!cueHasData) return;
    if (state.cue.index < cueTotal() - 1) {
      state.cue.index += 1;
      save();
      renderCue();
    }
  }
  function cuePrev() {
    if (!cueHasData) return;
    if (state.cue.index > 0) {
      state.cue.index -= 1;
      save();
      renderCue();
    }
  }

  // اقتراح تلقائي لرقم البطاقة بناءً على شريحة العرض الحالية
  function autoSuggestCue() {
    if (!cueHasData) return;
    const slide = current();
    if (!slide) return;
    let targetIdx = null;
    if (slide.type === "title") targetIdx = 0;
    else if (slide.type === "map") targetIdx = 5;
    else if (slide.type === "finale") targetIdx = cueTotal() - 4;
    else if (slide.type === "closing") targetIdx = cueTotal() - 1;
    else if (slide.type === "round") {
      const rid = slide.id;
      // البحث عن أول بطاقة بهذا الـ roundId وننتقل لها
      const idx = window.CUE_CARDS.findIndex((c) => c.roundId === rid);
      if (idx >= 0) targetIdx = idx;
    }
    if (targetIdx != null && targetIdx !== state.cue.index) {
      state.cue.index = targetIdx;
      save();
      renderCue();
    }
  }

  if (HOST && cueHasData) {
    if (cueToggleBtn) cueToggleBtn.onclick = toggleCue;
    const n = document.querySelector("[data-cue-next]"); if (n) n.onclick = cueNext;
    const p = document.querySelector("[data-cue-prev]"); if (p) p.onclick = cuePrev;
    const x = document.querySelector("[data-cue-close]"); if (x) x.onclick = closeCue;
    // فتح تلقائي إذا كان مفتوحاً في الجلسة السابقة
    if (state.cue.open) openCue();
    else closeCue();
  }

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

  (function sanitizeIndicDigits() {
    const map = { "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9" };
    const fixStr = (s) => String(s ?? "").replace(/[٠-٩]/g, (d) => map[d] || d);
    const walk = (root) => {
      const ni = document.createNodeIterator(root, NodeFilter.SHOW_TEXT, null);
      let n; while ((n = ni.nextNode())) { if (n.nodeValue) n.nodeValue = fixStr(n.nodeValue); }
      root.querySelectorAll && root.querySelectorAll("[data-pct],[data-k-total],[data-slide-count]").forEach((el) => {
        if (el.dataset.n != null) el.dataset.n = fixStr(el.dataset.n);
      });
    };
    walk(document.body);
    const mo = new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => walk(n))));
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  })();

  const crest = '<img class="ticker-crest" src="img/sands-logo.png" alt="" />';
  const tickerLine = SHOW.ticker.map((t) => `<span>${t}</span>${crest}`).join("");
  document.querySelector("[data-ticker]").innerHTML = `${tickerLine}${tickerLine}`;

  (async () => {
    if (window.Live) await Live.init();
    startFollow();
    render();
  })();
})();
