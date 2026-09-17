/* مزامنة لحظية عبر Firebase Realtime Database
   - المضيفة تكتب رقم الشريحة وحالة التصويت
   - الشاشات والجوالات تستمع للتغيير فوراً (WebSocket) بدون Polling */
(() => {
  const ROOT = "tableDecision";
  let db = null;
  let ok = false;
  const unsubs = [];

  function configured() {
    const c = window.FIREBASE_CONFIG;
    return Boolean(c && c.apiKey && !String(c.apiKey).includes("PASTE") && c.databaseURL && !String(c.databaseURL).includes("PASTE"));
  }

  function ready() { return ok; }

  async function init() {
    if (!configured()) return false;
    if (typeof firebase === "undefined") return false;
    try {
      if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
      db = firebase.database();
      ok = true;
      return true;
    } catch (err) {
      console.error("Firebase init failed", err);
      ok = false;
      return false;
    }
  }

  function path(p) { return db.ref(`${ROOT}/${p}`); }

  function emptyCounts(options) {
    const counts = {};
    (options || []).forEach((_, i) => { counts[String(i)] = 0; });
    return counts;
  }

  function countsByLabel(raw) {
    const out = {};
    (raw.options || []).forEach((opt, i) => {
      out[opt] = Number((raw.counts && raw.counts[String(i)]) || 0);
    });
    return out;
  }

  function toState(raw) {
    if (!raw || !raw.id) {
      return { ok: true, active: null, counts: {}, total: 0, remaining: 0, open: false, armed: false };
    }
    const now = Date.now();
    let open = Boolean(raw.open);
    let remaining = 0;
    if (open && Number(raw.until || 0) > 0) {
      remaining = Math.max(0, Math.floor((Number(raw.until) - now) / 1000));
      if (remaining <= 0) open = false;
    }
    const counts = countsByLabel(raw);
    const total = Object.values(counts).reduce((s, n) => s + Number(n || 0), 0);
    const armed = Boolean(raw.armed) && !open;
    return {
      ok: true,
      active: {
        id: String(raw.id),
        q: String(raw.q || ""),
        options: raw.options || [],
        armed,
        open,
      },
      counts,
      total,
      remaining,
      open,
      armed,
      until: Number(raw.until || 0),
    };
  }

  function pushShow(slide, widgets) {
    if (!ok) return Promise.resolve();
    return path("show").update({
      slide: Number(slide || 0),
      widgets: widgets || {},
      ts: firebase.database.ServerValue.TIMESTAMP,
    });
  }

  function onShow(cb) {
    if (!ok) return () => {};
    const ref = path("show");
    const handler = (snap) => {
      const v = snap.val() || { slide: 0, widgets: {} };
      cb({
        ok: true,
        slide: Number(v.slide || 0),
        widgets: v.widgets || {},
      });
    };
    ref.on("value", handler);
    unsubs.push(() => ref.off("value", handler));
    return () => ref.off("value", handler);
  }

  function armPoll(poll) {
    if (!ok || !poll) return Promise.resolve();
    return path("poll").set({
      id: String(poll.id),
      q: String(poll.q),
      options: poll.options.map(String),
      open: false,
      armed: true,
      until: 0,
      counts: emptyCounts(poll.options),
      voters: {},
      ts: firebase.database.ServerValue.TIMESTAMP,
    });
  }

  function openPoll(poll, seconds) {
    if (!ok || !poll) return Promise.resolve();
    const sec = Number(seconds || 12);
    return path("poll").set({
      id: String(poll.id),
      q: String(poll.q),
      options: poll.options.map(String),
      open: true,
      armed: false,
      until: Date.now() + sec * 1000,
      counts: emptyCounts(poll.options),
      voters: {},
      ts: firebase.database.ServerValue.TIMESTAMP,
    });
  }

  function clearPoll() {
    if (!ok) return Promise.resolve();
    return path("poll").set(null);
  }

  function closePoll() {
    if (!ok) return Promise.resolve();
    return path("poll").transaction((cur) => {
      if (!cur) return cur;
      return Object.assign({}, cur, {
        open: false,
        armed: false,
        until: Date.now(),
      });
    });
  }

  function onPoll(cb) {
    if (!ok) return () => {};
    const ref = path("poll");
    const handler = (snap) => cb(toState(snap.val()));
    ref.on("value", handler);
    unsubs.push(() => ref.off("value", handler));
    return () => ref.off("value", handler);
  }

  async function castVote(pollId, choice, voterId) {
    if (!ok) return { ok: false, err: "offline" };
    const snap = await path("poll").once("value");
    const raw = snap.val();
    if (!raw || String(raw.id) !== String(pollId)) return { ok: false, err: "closed" };
    if (!raw.open || Date.now() >= Number(raw.until || 0)) return { ok: false, err: "closed" };
    const idx = (raw.options || []).indexOf(choice);
    if (idx < 0) return { ok: false, err: "choice" };

    const voterKey = String(voterId || "").replace(/[.#$/\[\]]/g, "_");
    const voteTr = await path(`poll/voters/${voterKey}`).transaction((cur) => {
      if (cur != null) return; // abort: already voted
      return String(choice);
    });
    if (!voteTr.committed) return { ok: true, dup: true };

    await path(`poll/counts/${idx}`).transaction((n) => Number(n || 0) + 1);
    return { ok: true };
  }

  function lockDevice(id) {
    if (!ok || !id) return Promise.resolve();
    return path(`deviceLocks/${id}`).set({
      locked: true,
      ts: firebase.database.ServerValue.TIMESTAMP,
    });
  }

  function unlockDevice(id) {
    if (!ok || !id) return Promise.resolve();
    return path(`deviceLocks/${id}`).remove();
  }

  async function isDeviceLocked(id) {
    if (!ok || !id) return false;
    try {
      const snap = await path(`deviceLocks/${id}`).once("value");
      const v = snap.val();
      return Boolean(v && v.locked);
    } catch {
      return false;
    }
  }

  window.Live = {
    configured,
    ready,
    init,
    pushShow,
    onShow,
    armPoll,
    openPoll,
    clearPoll,
    closePoll,
    onPoll,
    castVote,
    toState,
    lockDevice,
    unlockDevice,
    isDeviceLocked,
  };
})();