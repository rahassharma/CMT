/* ============ core.js — API client, state, UI helpers ============ */

const API = {
  token: localStorage.getItem("cmt_token") || "",
  setToken(t) { this.token = t; localStorage.setItem("cmt_token", t || ""); },
  async req(method, url, body, isForm) {
    const headers = { "X-Token": this.token };
    let payload = body;
    if (body && !isForm) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers, body: payload });
    let data = null;
    try { data = await res.json(); } catch { /* non-json */ }
    if (!res.ok) {
      const msg = (data && data.error) || `Request failed (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },
  get(url) { return this.req("GET", url); },
  post(url, body, isForm) { return this.req("POST", url, body, isForm); },
  put(url, body) { return this.req("PUT", url, body); },
  del(url, body) { return this.req("DELETE", url, body); },
  async download(url, filename) {
    const res = await fetch(url, { headers: { "X-Token": this.token } });
    if (!res.ok) { UI.toast("Download failed", "error"); return; }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  },
};

const State = {
  user: null,
  settings: null,
  has(role) {
    return !!(this.user && (this.user.roles || []).includes(role));
  },
  isChair() { return this.has("chair"); },
};

const UI = {
  esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  },
  toast(msg, type = "") {
    const root = document.getElementById("toasts");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = ".3s"; }, 3200);
    setTimeout(() => el.remove(), 3600);
  },
  modal(title, bodyHtml, footHtml, opts = {}) {
    const root = document.getElementById("modal-root");
    root.innerHTML = `
      <div class="modal-backdrop" data-close-bg>
        <div class="modal ${opts.wide ? "wide" : ""}" role="dialog">
          <div class="modal-head">
            <h3>${title}</h3>
            <button class="modal-close" data-close>✕</button>
          </div>
          <div class="modal-body">${bodyHtml}</div>
          ${footHtml !== null ? `<div class="modal-foot">${footHtml || ""}</div>` : ""}
        </div>
      </div>`;
    const backdrop = root.querySelector(".modal-backdrop");
    backdrop.addEventListener("click", (e) => {
      if (e.target.matches("[data-close-bg]") || e.target.closest("[data-close]")) UI.closeModal();
    });
    return root.querySelector(".modal");
  },
  closeModal() { document.getElementById("modal-root").innerHTML = ""; },
  async confirm(message, okLabel = "Confirm", danger = false) {
    return new Promise((resolve) => {
      UI.modal("Please confirm",
        `<p class="mb0">${message}</p>`,
        `<button class="btn ghost" data-close>Cancel</button>
         <button class="btn ${danger ? "danger" : "primary"}" id="confirm-ok">${okLabel}</button>`);
      document.getElementById("confirm-ok").onclick = () => { UI.closeModal(); resolve(true); };
      document.querySelector("#modal-root .modal-close").addEventListener("click", () => resolve(false));
    });
  },
  daysUntil(isoStr) {
    const d = new Date(isoStr);
    if (isNaN(d)) return null;
    return Math.ceil((d - Date.now()) / 86400000);
  },
  fmtDate(isoStr, withTime = true) {
    if (!isoStr) return "—";
    const d = new Date(isoStr);
    if (isNaN(d)) return isoStr;
    return d.toLocaleString(undefined, {
      day: "numeric", month: "short", year: "numeric",
      hour: withTime ? "2-digit" : undefined, minute: withTime ? "2-digit" : undefined,
    });
  },
  deadlineChip(label, isoStr) {
    const days = this.daysUntil(isoStr);
    let cls = "", txt = "";
    if (days === null) return "";
    if (days < 0) { cls = "over"; txt = "passed"; }
    else if (days === 0) { cls = "soon"; txt = "today"; }
    else if (days <= 5) { cls = "soon"; txt = `in ${days}d`; }
    else txt = `in ${days}d`;
    return `<span class="deadline-chip ${cls}"><span class="dot"></span>${this.esc(label)} · ${this.fmtDate(isoStr, false)} · ${txt}</span>`;
  },
  statusBadge(status) {
    const map = {
      submitted: ["blue", "Under review"],
      withdrawn: ["outline", "Withdrawn"],
      desk_rejected: ["red", "Desk rejected"],
    };
    const [c, t] = map[status] || ["outline", status];
    return `<span class="badge ${c}">${t}</span>`;
  },
  decisionBadge(decision, pending) {
    if (!decision && pending) return `<span class="badge amber">Decision made · awaiting release</span>`;
    if (!decision) return `<span class="badge outline">No decision</span>`;
    if (pending) return `<span class="badge amber">Decision pending release</span>`;
    const map = {
      accept: ["green", "Accepted"],
      accept_poster: ["green", "Accepted · poster"],
      reject: ["red", "Rejected"],
    };
    const [c, t] = map[decision] || ["outline", decision];
    return `<span class="badge ${c}">${t}</span>`;
  },
  reviewStateBadge(state) {
    return state === "submitted"
      ? `<span class="badge green">Review submitted</span>`
      : `<span class="badge amber">Review draft</span>`;
  },
  scorePill(label, value, max) {
    const cls = max ? (value / max >= 0.7 ? "green" : value / max >= 0.45 ? "amber" : "red") : "";
    return `<div class="score-pill ${cls}"><div class="n">${value ?? "–"}</div><div class="l">${this.esc(label)}</div></div>`;
  },
  initials(name) {
    return String(name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  },
  roleChips(roles) {
    return (roles || []).map((r) => `<span class="role-chip ${r}">${r}</span>`).join(" ");
  },
  topicChips(topics) {
    return (topics || []).map((t) => `<span class="tag-soft">${this.esc(t)}</span>`).join(" ");
  },
  overallLabel(v) {
    const labels = ["", "Strong reject", "Reject", "Weak reject", "Borderline", "Weak accept", "Accept", "Strong accept"];
    return labels[v] || "";
  },
};

/** Load conference settings + current user into State. Returns false when logged out. */
async function refreshMe() {
  try {
    const data = await API.get("/api/auth/me");
    State.user = data.user;
    State.settings = data.settings;
    return true;
  } catch {
    State.user = null;
    State.settings = null;
    return false;
  }
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}
