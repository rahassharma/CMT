/* ============ app.js — router, shell, auth, home ============ */

/* ------------------------------------------------ login / register */
function LoginView() {
  const s = State.settings || {};
  let mode = "login";
  const deadlines = [
    ["Submissions due", s.submission_deadline],
    ["Reviews due", s.review_deadline],
    ["Rebuttals due", s.rebuttal_deadline],
    ["Decisions", s.decision_deadline],
    ["Camera-ready due", s.camera_ready_deadline],
  ];
  return {
    bare: true,
    html: `
      <div class="login-wrap">
        <div class="login-hero">
          <div class="inner">
            <div class="kicker">● ${UI.esc(s.conference_name || "Conference Toolkit")}</div>
            <h1>Everything the program runs on — one workspace.</h1>
            <p class="lead">${UI.esc(s.conference_description || "")}</p>
            <div class="timeline">
              ${deadlines.map(([label, when], i) => `
                <div class="tl-item">
                  <div class="tl-dot ${i === 0 ? "done" : ""}"></div>
                  <div>
                    <div class="what">${label}</div>
                    <div class="when">${UI.fmtDate(when)}</div>
                  </div>
                </div>`).join("")}
            </div>
          </div>
        </div>
        <div class="login-pane">
          <div class="login-card">
            <div class="flex mb3">
              <div class="brand-mark">C</div>
              <div>
                <div style="font-weight:800;font-size:16px">Conference Toolkit</div>
                <div class="muted small">Author · Reviewer · Chair portals</div>
              </div>
            </div>
            <div class="login-tabs">
              <button id="tab-login" class="${mode === "login" ? "on" : ""}">Sign in</button>
              <button id="tab-reg" class="${mode === "register" ? "on" : ""}">Create account</button>
            </div>
            <div id="auth-form">
              <label class="field"><span class="lbl">Email</span>
                <input class="input" id="a-email" type="email" placeholder="you@lab.edu"></label>
              <div id="reg-extra" class="hidden">
                <label class="field"><span class="lbl">Full name</span>
                  <input class="input" id="a-name" placeholder="Your name"></label>
                <label class="field"><span class="lbl">Affiliation</span>
                  <input class="input" id="a-aff" placeholder="University / lab / company"></label>
              </div>
              <label class="field"><span class="lbl">Password</span>
                <input class="input" id="a-pwd" type="password" placeholder="••••••••"></label>
              <button class="btn primary large block" id="a-go">Sign in</button>
            </div>
            ${s.demo ? `
            <div class="demo-box">
              <div class="t">One-click demo accounts · password demo123</div>
              <div class="demo-grid">
                <button class="demo-btn" data-demo="chair@aicon.demo">CHAIR<br><span class="muted">control room</span></button>
                <button class="demo-btn" data-demo="priya@aicon.demo">AUTHOR<br><span class="muted">3 papers</span></button>
                <button class="demo-btn" data-demo="rev1@aicon.demo">REVIEWER<br><span class="muted">panel</span></button>
              </div>
            </div>` : ""}
          </div>
        </div>
      </div>`,
    init(root) {
      const setMode = (m) => {
        mode = m;
        root.querySelector("#tab-login").classList.toggle("on", m === "login");
        root.querySelector("#tab-reg").classList.toggle("on", m === "register");
        root.querySelector("#reg-extra").classList.toggle("hidden", m === "login");
        root.querySelector("#a-go").textContent = m === "login" ? "Sign in" : "Create account";
      };
      root.querySelector("#tab-login").onclick = () => setMode("login");
      root.querySelector("#tab-reg").onclick = () => setMode("register");
      const doAuth = async () => {
        const email = root.querySelector("#a-email").value.trim();
        const password = root.querySelector("#a-pwd").value;
        try {
          let data;
          if (mode === "login") {
            data = await API.post("/api/auth/login", { email, password });
          } else {
            data = await API.post("/api/auth/register", {
              email, password,
              name: root.querySelector("#a-name").value.trim(),
              affiliation: root.querySelector("#a-aff").value.trim(),
            });
          }
          API.setToken(data.token);
          State.user = data.user;
          UI.toast(`Welcome, ${data.user.name.split(" ")[0]}!`, "success");
          await refreshMe();
          go("#/home");
        } catch (err) {
          UI.toast(err.message, "error");
        }
      };
      root.querySelector("#a-go").onclick = doAuth;
      root.querySelectorAll("#a-pwd").forEach((el) =>
        el.addEventListener("keydown", (e) => { if (e.key === "Enter") doAuth(); }));
      root.querySelectorAll("[data-demo]").forEach((b) => b.onclick = async () => {
        try {
          const data = await API.post("/api/auth/login", { email: b.dataset.demo, password: "demo123" });
          API.setToken(data.token);
          State.user = data.user;
          await refreshMe();
          UI.toast(`Signed in as ${data.user.name}`, "success");
          go("#/home");
        } catch (err) { UI.toast(err.message, "error"); }
      });
    },
  };
}

/* ------------------------------------------------ home (role-aware) */
function HomeView() {
  const s = State.settings || {};
  return {
    title: `Welcome, ${State.user.name.split(" ")[0]}`,
    subtitle: s.conference_name,
    html: `<div id="home"><div class="empty">Loading…</div></div>`,
    async init(root) {
      const wrap = root.querySelector("#home");
      const deadlineCards = `
        <div class="flex wrap mb3">
          ${UI.deadlineChip("Submissions", s.submission_deadline)}
          ${UI.deadlineChip("Reviews", s.review_deadline)}
          ${UI.deadlineChip("Rebuttals", s.rebuttal_deadline)}
          ${UI.deadlineChip("Camera-ready", s.camera_ready_deadline)}
        </div>`;
      let body = "";

      if (State.isChair()) {
        const st = await API.get("/api/chair/stats");
        const S = st.stats;
        body = `
          ${deadlineCards}
          <div class="grid cols-4">
            <div class="stat"><div class="accent-bar"></div><div class="label">Active papers</div>
              <div class="value">${S.active_submissions}</div><div class="hint">${S.total_submissions} total</div></div>
            <div class="stat green"><div class="accent-bar"></div><div class="label">Reviews in</div>
              <div class="value">${S.reviews_submitted}</div><div class="hint">${S.reviews_draft} drafts pending</div></div>
            <div class="stat amber"><div class="accent-bar"></div><div class="label">Undecided</div>
              <div class="value">${S.undecided}</div><div class="hint">${S.accepted} accepted · ${S.rejected} rejected</div></div>
            <div class="stat blue"><div class="accent-bar"></div><div class="label">Papers w/o reviews</div>
              <div class="value">${S.papers_without_reviews}</div><div class="hint">need attention</div></div>
          </div>
          <div class="card mt3">
            <div class="card-head"><h3>Jump into the control room</h3></div>
            <div class="card-body">
              <div class="btn-row">
                <button class="btn primary" data-go="#/chair">Chair dashboard</button>
                <button class="btn subtle" data-go="#/chair/submissions">All submissions</button>
                <button class="btn subtle" data-go="#/chair/assignments">Assignments</button>
                <button class="btn subtle" data-go="#/chair/decisions">Decision queue</button>
                <button class="btn subtle" data-go="#/chair/users">People & roles</button>
                <button class="btn subtle" data-go="#/chair/settings">Settings</button>
                <button class="btn subtle" data-go="#/chair/notify">Announcements</button>
                <button class="btn subtle" data-go="#/chair/export">Export & audit</button>
              </div>
            </div>
          </div>`;
      }

      if (State.has("author") || !State.isChair()) {
        const data = await API.get("/api/submissions");
        const mine = data.submissions;
        const withDecision = mine.filter((x) => x.decision && !x.decision_pending);
        body += `
          <div class="card mt3">
            <div class="card-head"><h3>Your submissions</h3>
              <div class="right"><button class="btn primary small" data-go="#/submit">+ New submission</button></div>
            </div>
            <div class="card-body">
              ${mine.length ? mine.slice(0, 4).map((sub) => `
                <div class="flex wrap between" style="padding:9px 0;border-bottom:1px solid var(--line-2)">
                  <div style="flex:1;min-width:220px">
                    <a href="#/submission/${sub.id}" style="font-weight:700">#${sub.id} · ${UI.esc(sub.title)}</a>
                    <div class="muted small">${UI.esc(sub.authors.map((a) => a.name).join(", "))}</div>
                  </div>
                  <div class="flex wrap">
                    ${UI.statusBadge(sub.status)}
                    ${UI.decisionBadge(sub.decision, sub.decision_pending)}
                    ${sub.avg_overall ? `<span class="badge purple">avg ${sub.avg_overall}</span>` : ""}
                  </div>
                </div>`).join("") : `
                <div class="empty"><div class="big">📝</div><h3>No submissions yet</h3>
                  <p>Submit a paper to get started.</p>
                  <button class="btn primary" data-go="#/submit">New submission</button></div>`}
              ${withDecision.length ? `<div class="alert success mt3"><b>Decisions released:</b> check your papers above.</div>` : ""}
            </div>
          </div>`;
      }

      if (State.has("reviewer")) {
        const q = await API.get("/api/reviewer/queue");
        const done = q.queue.filter((x) => x.my_review && x.my_review.state === "submitted").length;
        body += `
          <div class="card">
            <div class="card-head"><h3>Your reviewing</h3>
              <div class="right"><button class="btn subtle small" data-go="#/reviews">Open queue</button>
              <button class="btn ghost small" data-go="#/bids">Bidding</button></div>
            </div>
            <div class="card-body">
              <div class="flex wrap">
                <div style="flex:1;min-width:200px">
                  <div class="muted small mb2">${done}/${q.queue.length} reviews submitted ${q.settings.reviewing_open ? "" : "· reviewing closed"}</div>
                  <div class="progress green"><div style="width:${q.queue.length ? 100 * done / q.queue.length : 0}%"></div></div>
                </div>
                ${UI.deadlineChip("Reviews due", q.settings.review_deadline)}
              </div>
            </div>
          </div>`;
      }

      wrap.innerHTML = body;
      wrap.querySelectorAll("[data-go]").forEach((b) => b.onclick = () => go(b.dataset.go));
    },
  };
}

/* ------------------------------------------------ notifications */
function NotificationsView() {
  return {
    title: "Notifications",
    subtitle: "Decisions, assignments and announcements",
    html: `<div id="notif-list"><div class="empty">Loading…</div></div>`,
    async init(root) {
      const wrap = root.querySelector("#notif-list");
      const data = await API.get("/api/notifications");
      const list = data.notifications;
      if (!list.length) {
        wrap.innerHTML = `<div class="empty"><div class="big">🔔</div><h3>Nothing here yet</h3>
          <p>Decisions, review assignments and chair announcements will appear here.</p></div>`;
        return;
      }
      wrap.innerHTML = `
        <div class="flex between mb3">
          <div class="muted">${list.filter((n) => !n.read).length} unread</div>
          <button class="btn ghost small" id="n-all">Mark all read</button>
        </div>
        <div class="card">
          ${list.map((n) => `
            <div class="notif-row ${n.read ? "" : "unread"}" data-id="${n.id}">
              <div class="avatar ${n.read ? "" : "green"}">${n.read ? "✓" : "●"}</div>
              <div style="flex:1">
                <div class="subject">${UI.esc(n.subject)}</div>
                <div class="body">${UI.esc(n.body)}</div>
                <div class="muted small mt2">${UI.fmtDate(n.created_at)}</div>
              </div>
            </div>`).join("")}
        </div>`;
      wrap.querySelector("#n-all").onclick = async () => {
        await API.post("/api/notifications/read", { all: true });
        render();
      };
      wrap.querySelectorAll(".notif-row").forEach((row) => row.onclick = async () => {
        await API.post("/api/notifications/read", { id: Number(row.dataset.id) });
        row.classList.remove("unread");
      });
    },
  };
}

/* ------------------------------------------------ profile */
function ProfileView() {
  return {
    title: "Profile",
    subtitle: "Your account",
    html: `
      <div class="card" style="max-width:640px">
        <div class="card-head"><h3>Account details</h3></div>
        <div class="card-body">
          <div class="flex mb3">
            <div class="avatar" style="width:52px;height:52px;font-size:18px">${UI.initials(State.user.name)}</div>
            <div>
              <div style="font-weight:800;font-size:16px">${UI.esc(State.user.name)}</div>
              <div class="muted">${UI.esc(State.user.email)}</div>
              <div class="mt2">${UI.roleChips(State.user.roles)}</div>
            </div>
          </div>
          <label class="field"><span class="lbl">Display name</span>
            <input class="input" id="p-name" value="${UI.esc(State.user.name)}"></label>
          <label class="field"><span class="lbl">Affiliation</span>
            <input class="input" id="p-aff" value="${UI.esc(State.user.affiliation || "")}"></label>
          <label class="field"><span class="lbl">New password (leave blank to keep current)</span>
            <input class="input" id="p-pwd" type="password" placeholder="••••••••"></label>
          <button class="btn primary" id="p-save">Save profile</button>
        </div>
      </div>`,
    init(root) {
      root.querySelector("#p-save").onclick = async () => {
        try {
          const data = await API.put("/api/auth/profile", {
            name: root.querySelector("#p-name").value,
            affiliation: root.querySelector("#p-aff").value,
            password: root.querySelector("#p-pwd").value,
          });
          State.user = data.user;
          UI.toast("Profile updated", "success");
          render();
        } catch (err) { UI.toast(err.message, "error"); }
      };
    },
  };
}

/* ------------------------------------------------ chair decision queue */
function DecisionsQueueView() {
  return {
    title: "Decision Queue",
    subtitle: "Papers awaiting a decision",
    html: `<div id="dq"><div class="empty">Loading…</div></div>`,
    async init(root) {
      const wrap = root.querySelector("#dq");
      const data = await API.get("/api/chair/submissions");
      const pending = data.submissions.filter((p) => p.status === "submitted" && !p.decision);
      const decided = data.submissions.filter((p) => p.decision);
      wrap.innerHTML = `
        <div class="alert info">Quick decisions below notify authors immediately. Use the dashboard toggles to <b>release decisions</b> formally.</div>
        <div class="card">
          <div class="card-head"><h3>Undecided · ${pending.length}</h3>
            <div class="right"><button class="btn ghost small" id="sel-all">Select all</button>
            <button class="btn primary small" id="bulk">Bulk decide…</button></div>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th></th><th>#</th><th>Paper</th><th>Avg score</th><th>Reviews</th><th>Quick actions</th></tr></thead>
              <tbody>
                ${pending.map((p) => `
                  <tr>
                    <td><input type="checkbox" class="dq-check" data-id="${p.id}"></td>
                    <td class="num">${p.id}</td>
                    <td class="title-cell"><a href="#/submission/${p.id}">${UI.esc(p.title)}</a>
                      <div class="muted small">${UI.esc(p.authors.map((a) => a.name).join(", "))}</div></td>
                    <td class="num">${p.avg_score ?? "–"}</td>
                    <td>${p.n_reviews_submitted}/${p.reviewers.length}</td>
                    <td>
                      <div class="btn-row">
                        <button class="btn success small" data-q="accept" data-id="${p.id}">Accept</button>
                        <button class="btn warning small" data-q="accept_poster" data-id="${p.id}">Poster</button>
                        <button class="btn danger small" data-q="reject" data-id="${p.id}">Reject</button>
                        <button class="btn ghost small" data-more="${p.id}">Details…</button>
                      </div>
                    </td>
                  </tr>`).join("") || `<tr><td colspan="6"><div class="muted">Every paper has a decision 🎉</div></td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Decided · ${decided.length}</h3></div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>#</th><th>Paper</th><th>Decision</th><th></th></tr></thead>
              <tbody>
                ${decided.map((p) => `
                  <tr>
                    <td class="num">${p.id}</td>
                    <td class="title-cell"><a href="#/submission/${p.id}">${UI.esc(p.title)}</a></td>
                    <td>${UI.decisionBadge(p.decision, p.decision_pending)}</td>
                    <td class="text-right"><button class="btn ghost small" data-more="${p.id}">Change…</button></td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>
        </div>`;
      wrap.querySelector("#sel-all").onclick = () =>
        wrap.querySelectorAll(".dq-check").forEach((c) => { c.checked = true; });
      wrap.querySelector("#bulk").onclick = () => {
        const ids = [...wrap.querySelectorAll(".dq-check:checked")].map((c) => Number(c.dataset.id));
        if (!ids.length) return UI.toast("Select papers first", "warn");
        ChairViews.openDecisionModal(data.submissions.filter((p) => ids.includes(p.id)), render);
      };
      wrap.querySelectorAll("[data-q]").forEach((b) => b.onclick = async () => {
        const p = data.submissions.find((x) => x.id === Number(b.dataset.id));
        if (!(await UI.confirm(
          `Mark paper #${p.id} as <b>${b.dataset.q === "reject" ? "rejected" : b.dataset.q === "accept_poster" ? "accepted (poster)" : "accepted"}</b>?`,
          "Confirm decision", b.dataset.q === "reject"))) return;
        await API.post("/api/chair/decide", { decisions: [{ id: p.id, decision: b.dataset.q, comment: "" }] });
        UI.toast("Decision saved", "success");
        render();
      });
      wrap.querySelectorAll("[data-more]").forEach((b) => b.onclick = () => {
        const p = data.submissions.find((x) => x.id === Number(b.dataset.more));
        ChairViews.openDecisionModal([p], render);
      });
    },
  };
}

/* ------------------------------------------------ router & shell */
function navItem(hash, ico, label, active, count) {
  return `<a class="nav-item ${active ? "active" : ""}" href="${hash}">
    <span class="ico">${ico}</span><span>${label}</span>
    ${count ? `<span class="nav-count">${count}</span>` : ""}</a>`;
}

function renderShell(view, route) {
  const s = State.settings || {};
  const unread = 0; // filled async below
  const chair = State.isChair();
  const html = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">${UI.esc((s.conference_short || "C")[0])}</div>
          <div>
            <div class="brand-name">${UI.esc(s.conference_name || "Conference")}</div>
            <div class="brand-sub">Management Toolkit</div>
          </div>
        </div>
        <nav class="nav">
          <div class="nav-label">Workspace</div>
          ${navItem("#/home", "🏠", "Home", route === "#/home")}
          ${navItem("#/notifications", "🔔", "Notifications", route === "#/notifications", unread)}
          ${State.has("author") ? `
            <div class="nav-label">Author</div>
            ${navItem("#/submissions", "📄", "My submissions", route.startsWith("#/submissions") || route.startsWith("#/submission/"))}
            ${navItem("#/submit", "➕", "New submission", route === "#/submit")}` : ""}
          ${State.has("reviewer") ? `
            <div class="nav-label">Reviewer</div>
            ${navItem("#/reviews", "📝", "My reviews", route.startsWith("#/reviews") || route.startsWith("#/review/"))}
            ${navItem("#/bids", "🏷", "Bidding", route === "#/bids")}` : ""}
          ${chair ? `
            <div class="nav-label">Chair</div>
            ${navItem("#/chair", "📊", "Dashboard", route === "#/chair")}
            ${navItem("#/chair/submissions", "🗂", "All submissions", route === "#/chair/submissions")}
            ${navItem("#/chair/decisions", "⚖️", "Decision queue", route === "#/chair/decisions")}
            ${navItem("#/chair/assignments", "🤝", "Assignments", route === "#/chair/assignments")}
            ${navItem("#/chair/users", "👥", "People & roles", route === "#/chair/users")}
            ${navItem("#/chair/settings", "⚙️", "Settings", route === "#/chair/settings")}
            ${navItem("#/chair/notify", "📣", "Announcements", route === "#/chair/notify")}
            ${navItem("#/chair/export", "📦", "Export & audit", route === "#/chair/export")}` : ""}
          <div class="nav-label">Account</div>
          ${navItem("#/profile", "👤", "Profile", route === "#/profile")}
        </nav>
        <div class="side-user">
          <div class="flex">
            <div class="avatar">${UI.initials(State.user.name)}</div>
            <div style="min-width:0">
              <div class="name">${UI.esc(State.user.name)}</div>
              <div class="mail">${UI.esc(State.user.email)}</div>
            </div>
          </div>
          <div class="row">
            <button class="btn ghost small" id="nav-profile">Profile</button>
            <button class="btn small" id="nav-logout" style="background:rgba(239,68,68,.9)">Sign out</button>
          </div>
        </div>
      </aside>
      <div class="main">
        <div class="topbar">
          <div>
            <h1>${UI.esc(view.title || "")}</h1>
            <div class="sub">${UI.esc(view.subtitle || "")}</div>
          </div>
          <div class="topbar-right">
            ${UI.deadlineChip("Submissions", s.submission_deadline)}
            <button class="btn-icon" id="top-bell" title="Notifications">🔔</button>
          </div>
        </div>
        <div class="content" id="content"></div>
      </div>
    </div>`;
  document.getElementById("app").innerHTML = html;
  document.getElementById("nav-logout").onclick = async () => {
    await API.post("/api/auth/logout");
    API.setToken("");
    State.user = null;
    go("#/login");
    render();
  };
  document.getElementById("nav-profile").onclick = () => go("#/profile");
  document.getElementById("top-bell").onclick = () => go("#/notifications");
  return document.getElementById("content");
}

async function render() {
  const route = location.hash || "#/home";
  if (!State.settings) {
    try {
      const data = await API.get("/api/conference");
      State.settings = data.settings;
    } catch { /* server down */ }
  }

  let view = null;
  const authed = await (State.user ? Promise.resolve(true) : refreshMe());

  if (!authed) {
    if (route !== "#/login") {
      // fall through to login
    }
    view = LoginView();
  } else {
    const r = route.replace(/\/$/, "");
    if (r === "#/login" || r === "#/" || r === "#/home") view = HomeView();
    else if (r === "#/submit") view = Views.authorForm(false);
    else if (r === "#/submissions") view = Views.authorList();
    else if (/^#\/submission\/\d+\/edit$/.test(r)) {
      const id = Number(r.split("/")[2]);
      let existing = null;
      try {
        const data = await API.get(`/api/submissions/${id}`);
        existing = data.submission;
      } catch (err) { UI.toast(err.message, "error"); }
      view = existing ? Views.authorForm(true, existing) : Views.authorList();
    }
    else if (/^#\/submission\/\d+$/.test(r)) view = Views.submissionDetail(Number(r.split("/")[2]));
    else if (r === "#/reviews") view = Views.reviewerQueue();
    else if (/^#\/review\/\d+$/.test(r)) view = Views.reviewForm(Number(r.split("/")[2]));
    else if (r === "#/bids") view = Views.reviewerBids();
    else if (r === "#/chair") view = Views.chairDashboard();
    else if (r === "#/chair/submissions") view = Views.chairSubmissions();
    else if (r === "#/chair/decisions") view = DecisionsQueueView();
    else if (r === "#/chair/assignments") view = Views.chairAssignments();
    else if (r === "#/chair/users") view = Views.chairUsers();
    else if (r === "#/chair/settings") view = Views.chairSettings();
    else if (r === "#/chair/notify") view = Views.chairNotify();
    else if (r === "#/chair/export") view = Views.chairExportAudit();
    else if (r === "#/notifications") view = NotificationsView();
    else if (r === "#/profile") view = ProfileView();
    else view = HomeView();
  }

  document.title = `${view.title || "Conference Toolkit"} · ${State.settings?.conference_name || "CTK"}`;

  let contentRoot;
  if (view.bare) {
    document.getElementById("app").innerHTML = view.html;
    contentRoot = document.getElementById("app");
  } else {
    contentRoot = renderShell(view, route.replace(/\/$/, ""));
    contentRoot.innerHTML = view.html;
  }
  // notification badge
  if (State.user && !view.bare) {
    API.get("/api/notifications").then((data) => {
      const n = data.notifications.filter((x) => !x.read).length;
      const chip = document.querySelector('a[href="#/notifications"] .nav-count');
      if (n > 0) {
        if (chip) chip.textContent = n;
        else {
          const nav = document.querySelector('a[href="#/notifications"]');
          if (nav) nav.insertAdjacentHTML("beforeend", `<span class="nav-count">${n}</span>`);
        }
      } else if (chip) chip.remove();
    }).catch(() => {});
  }
  if (view.init) {
    try { await view.init(contentRoot); }
    catch (err) {
      contentRoot.innerHTML = `<div class="empty"><div class="big">⚠️</div><h3>${UI.esc(err.message)}</h3></div>`;
    }
  }
}

window.addEventListener("hashchange", render);
window.addEventListener("DOMContentLoaded", render);
render();
