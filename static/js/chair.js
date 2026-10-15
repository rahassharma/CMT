/* ============ chair.js — full program-chair control room ============ */

const ChairViews = {

  /* ------------------------------------------------ decision modal (shared) */
  openDecisionModal(subs, onDone) {
    const multi = subs.length > 1;
    UI.modal(
      multi ? `Decide on ${subs.length} papers` : `Decision · Paper #${subs[0].id}`,
      `
        ${subs.map((s) => `
          <div class="mb3">
            <div class="muted small">#${s.id}</div>
            <div style="font-weight:700">${UI.esc(s.title)}</div>
          </div>`).join("")}
        <label class="field"><span class="lbl">Decision</span>
          <select class="select" id="d-decision">
            <option value="accept">Accept (oral / full paper)</option>
            <option value="accept_poster">Accept as poster</option>
            <option value="reject">Reject</option>
            <option value="">Clear decision</option>
          </select>
        </label>
        <label class="field"><span class="lbl">Comment to the authors (included in the notification)</span>
          <textarea class="textarea" id="d-comment" placeholder="Meta-review summary, conditions for acceptance, or encouragement…"></textarea>
        </label>
        <div class="alert info">Authors are notified by email + in-app notification immediately. Use <b>Release decisions</b> on the dashboard to control when formal decision letters are visible.</div>
      `,
      `<button class="btn ghost" data-close>Cancel</button>
       <button class="btn primary" id="d-save">Save decision</button>`
    );
    document.getElementById("d-save").onclick = async () => {
      const decision = document.getElementById("d-decision").value;
      const comment = document.getElementById("d-comment").value;
      try {
        await API.post("/api/chair/decide", {
          decisions: subs.map((s) => ({ id: s.id, decision, comment })),
        });
        UI.closeModal();
        UI.toast(`Decision saved for ${subs.length} paper${subs.length > 1 ? "s" : ""}`, "success");
        onDone && onDone();
      } catch (err) { UI.toast(err.message, "error"); }
    };
  },

  /* ------------------------------------------------ dashboard */
  dashboard() {
    return {
      title: "Chair Dashboard",
      subtitle: "Conference health at a glance",
      html: `<div id="dash"><div class="empty">Loading…</div></div>`,
      async init(root) {
        const wrap = root.querySelector("#dash");
        const [st, subsData] = await Promise.all([
          API.get("/api/chair/stats"),
          API.get("/api/chair/submissions"),
        ]);
        const S = st.stats;
        const s = subsData.settings;
        const maxScore = Math.max(1, ...Object.values(S.score_distribution));
        const maxTopic = Math.max(1, ...Object.values(S.topic_counts));
        const needAttention = subsData.submissions.filter(
          (x) => x.status === "submitted" && (x.reviewers.length < s.reviews_per_paper || x.n_reviews_submitted < x.reviewers.length)
        );
        wrap.innerHTML = `
          <div class="flex wrap between mb3">
            <div class="flex wrap">
              ${UI.deadlineChip("Submission", s.submission_deadline)}
              ${UI.deadlineChip("Reviewing", s.review_deadline)}
              ${UI.deadlineChip("Decisions", s.decision_deadline)}
            </div>
            <div class="btn-row">
              <button class="btn subtle" id="t-reviews">${s.reviews_visible ? "Hide reviews" : "Release reviews"}</button>
              <button class="btn ${s.decisions_released ? "ghost" : "primary"}" id="t-decisions">${s.decisions_released ? "Un-release decisions" : "Release decisions"}</button>
            </div>
          </div>

          <div class="grid cols-4">
            <div class="stat"><div class="accent-bar"></div>
              <div class="label">Active papers</div><div class="value">${S.active_submissions}</div>
              <div class="hint">${S.total_submissions} total · ${S.withdrawn} withdrawn</div></div>
            <div class="stat green"><div class="accent-bar"></div>
              <div class="label">Reviews submitted</div><div class="value">${S.reviews_submitted}</div>
              <div class="hint">${S.reviews_draft} drafts · ${S.assignments} assignments</div></div>
            <div class="stat amber"><div class="accent-bar"></div>
              <div class="label">Acceptance rate</div><div class="value">${S.acceptance_rate}%</div>
              <div class="hint">${S.accepted} accepted · ${S.rejected} rejected · ${S.undecided} undecided</div></div>
            <div class="stat blue"><div class="accent-bar"></div>
              <div class="label">People</div><div class="value">${S.users}</div>
              <div class="hint">${S.reviewers} with reviewer role</div></div>
          </div>

          ${S.papers_without_reviews ? `<div class="alert warn mt3"><b>${S.papers_without_reviews} assigned paper(s)</b> have no submitted reviews yet.</div>` : ""}

          <div class="grid cols-2 mt3">
            <div class="card">
              <div class="card-head"><h3>Score distribution</h3>
                <div class="right muted small">submitted reviews</div></div>
              <div class="card-body">
                ${Object.keys(S.score_distribution).length ? Object.entries(S.score_distribution).sort().map(([k, v]) => `
                  <div class="bar-row">
                    <div class="name">${k} · ${UI.esc(UI.overallLabel(k))}</div>
                    <div class="track"><div style="width:${100 * v / maxScore}%"></div></div>
                    <div class="count">${v}</div>
                  </div>`).join("") : `<div class="muted">No submitted reviews yet.</div>`}
              </div>
            </div>
            <div class="card">
              <div class="card-head"><h3>Papers by topic</h3></div>
              <div class="card-body">
                ${Object.entries(S.topic_counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `
                  <div class="bar-row">
                    <div class="name">${UI.esc(k)}</div>
                    <div class="track"><div style="width:${100 * v / maxTopic}%"></div></div>
                    <div class="count">${v}</div>
                  </div>`).join("") || `<div class="muted">No topics yet.</div>`}
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>Needs attention</h3>
              <div class="right"><button class="btn ghost small" id="go-assign">Open assignments</button></div>
            </div>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>#</th><th>Paper</th><th>Reviewers</th><th>Submitted</th><th></th></tr></thead>
                <tbody>
                  ${needAttention.slice(0, 10).map((p) => `
                    <tr>
                      <td class="num">${p.id}</td>
                      <td class="title-cell"><a href="#/submission/${p.id}">${UI.esc(p.title)}</a></td>
                      <td>${p.reviewers.map((r) => `<span class="badge outline">${UI.esc(r.name)}</span>`).join(" ") || `<span class="badge red">unassigned</span>`}</td>
                      <td><span class="badge ${p.n_reviews_submitted ? "green" : "amber"}">${p.n_reviews_submitted}/${p.reviewers.length || s.reviews_per_paper}</span></td>
                      <td class="text-right"><button class="btn ghost small" data-decide="${p.id}">Decide…</button></td>
                    </tr>`).join("") || `<tr><td colspan="5"><div class="muted">Everything looks in order 🎉</div></td></tr>`}
                </tbody>
              </table>
            </div>
          </div>`;

        wrap.querySelector("#go-assign").onclick = () => go("#/chair/assignments");
        wrap.querySelector("#t-reviews").onclick = async () => {
          await API.post("/api/chair/release", { what: "reviews_visible", value: !s.reviews_visible });
          UI.toast(s.reviews_visible ? "Reviews hidden from authors" : "Reviews released to authors", "success");
          render();
        };
        wrap.querySelector("#t-decisions").onclick = async () => {
          await API.post("/api/chair/release", { what: "decisions_released", value: !s.decisions_released });
          UI.toast(s.decisions_released ? "Decisions un-released" : "Decisions released to authors", "success");
          render();
        };
        wrap.querySelectorAll("[data-decide]").forEach((b) => b.onclick = (e) => {
          e.stopPropagation();
          const p = subsData.submissions.find((x) => x.id === Number(b.dataset.decide));
          ChairViews.openDecisionModal([p], render);
        });
      },
    };
  },

  /* ------------------------------------------------ submissions table */
  submissions() {
    return {
      title: "All Submissions",
      subtitle: "Filter, inspect and batch-decide every paper",
      html: `<div id="chair-subs"><div class="empty">Loading…</div></div>`,
      async init(root) {
        const wrap = root.querySelector("#chair-subs");
        const data = await API.get("/api/chair/submissions");
        const s = data.settings;
        let rows = data.submissions;
        let filters = { q: "", status: "", decision: "", topic: "" };

        const draw = () => {
          const f = rows.filter((p) => {
            if (filters.q && !(`${p.title} ${p.abstract} ${p.authors.map((a) => a.name).join(" ")}`.toLowerCase().includes(filters.q.toLowerCase()))) return false;
            if (filters.status && p.status !== filters.status) return false;
            if (filters.decision === "none" && p.decision) return false;
            if (filters.decision && filters.decision !== "none" && p.decision !== filters.decision) return false;
            if (filters.topic && !p.topics.includes(filters.topic)) return false;
            return true;
          });
          wrap.innerHTML = `
            <div class="card card-pad">
              <div class="form-row cols-3">
                <input class="input" id="fl-q" placeholder="Search title, abstract, author…" value="${UI.esc(filters.q)}">
                <select class="select" id="fl-status">
                  <option value="">All statuses</option>
                  <option value="submitted" ${filters.status === "submitted" ? "selected" : ""}>Under review</option>
                  <option value="withdrawn" ${filters.status === "withdrawn" ? "selected" : ""}>Withdrawn</option>
                </select>
                <select class="select" id="fl-decision">
                  <option value="">All decisions</option>
                  <option value="none" ${filters.decision === "none" ? "selected" : ""}>Undecided</option>
                  <option value="accept" ${filters.decision === "accept" ? "selected" : ""}>Accept</option>
                  <option value="accept_poster" ${filters.decision === "accept_poster" ? "selected" : ""}>Accept poster</option>
                  <option value="reject" ${filters.decision === "reject" ? "selected" : ""}>Reject</option>
                </select>
              </div>
              <div class="form-row cols-3 mt3">
                <select class="select" id="fl-topic">
                  <option value="">All topics</option>
                  ${(s.topics || []).map((t) => `<option ${filters.topic === t ? "selected" : ""}>${UI.esc(t)}</option>`).join("")}
                </select>
                <div class="flex">
                  <button class="btn ghost small" id="fl-reset">Reset filters</button>
                  <span class="muted small">${f.length} of ${rows.length} papers</span>
                </div>
              </div>
            </div>
            <div class="card">
              <div class="card-head">
                <h3>Papers</h3>
                <div class="right">
                  <button class="btn ghost small" id="bulk-select-all">Select all shown</button>
                  <button class="btn primary small" id="bulk-decide">Bulk decide…</button>
                </div>
              </div>
              <div class="table-wrap">
                <table class="table">
                  <thead><tr>
                    <th></th><th>#</th><th>Paper</th><th>Authors</th><th>Reviews</th>
                    <th>Avg</th><th>Status</th><th>Decision</th><th></th>
                  </tr></thead>
                  <tbody>
                    ${f.map((p) => `
                      <tr>
                        <td><input type="checkbox" class="row-check" data-id="${p.id}"></td>
                        <td class="num">${p.id}</td>
                        <td class="title-cell">
                          <a href="#/submission/${p.id}">${UI.esc(p.title)}</a>
                          <div class="muted small">${UI.topicChips(p.topics)}</div>
                        </td>
                        <td class="small">${UI.esc(p.authors.map((a) => a.name).join(", "))}</td>
                        <td>
                          <div class="flex" style="gap:4px;flex-wrap:wrap">
                            ${p.reviewers.length ? p.reviewers.map((r) =>
                              `<span class="badge ${r.review_state === "submitted" ? "green" : "amber"}" title="${UI.esc(r.name)}">${UI.initials(r.name)}</span>`).join("")
                              : `<span class="badge red">none</span>`}
                          </div>
                        </td>
                        <td class="num">${p.avg_score ?? "–"}</td>
                        <td>${UI.statusBadge(p.status)}</td>
                        <td>${UI.decisionBadge(p.decision, p.decision_pending)}</td>
                        <td class="text-right">
                          <button class="btn ghost small" data-decide="${p.id}">Decide…</button>
                        </td>
                      </tr>`).join("")}
                  </tbody>
                </table>
              </div>
            </div>`;
          const on = (sel, ev, fn) => { const el = wrap.querySelector(sel); if (el) el.addEventListener(ev, fn); };
          on("#fl-q", "input", (e) => { filters.q = e.target.value; draw(); wrap.querySelector("#fl-q").focus(); });
          on("#fl-status", "change", (e) => { filters.status = e.target.value; draw(); });
          on("#fl-decision", "change", (e) => { filters.decision = e.target.value; draw(); });
          on("#fl-topic", "change", (e) => { filters.topic = e.target.value; draw(); });
          on("#fl-reset", "click", () => { filters = { q: "", status: "", decision: "", topic: "" }; draw(); });
          on("#bulk-select-all", "click", () => {
            wrap.querySelectorAll(".row-check").forEach((c) => { c.checked = true; });
          });
          on("#bulk-decide", "click", () => {
            const ids = [...wrap.querySelectorAll(".row-check:checked")].map((c) => Number(c.dataset.id));
            if (!ids.length) return UI.toast("Select at least one paper", "warn");
            ChairViews.openDecisionModal(
              rows.filter((p) => ids.includes(p.id)), () => { render(); }
            );
          });
          wrap.querySelectorAll("[data-decide]").forEach((b) => b.onclick = () => {
            const p = rows.find((x) => x.id === Number(b.dataset.decide));
            ChairViews.openDecisionModal([p], render);
          });
        };
        draw();
      },
    };
  },

  /* ------------------------------------------------ assignments */
  assignments() {
    return {
      title: "Reviewer Assignments",
      subtitle: "Auto-assign with conflict avoidance, or fine-tune by hand",
      html: `<div id="assign-wrap"><div class="empty">Loading…</div></div>`,
      async init(root) {
        const wrap = root.querySelector("#assign-wrap");

        const draw = async () => {
          const [subsData, usersData, stData] = await Promise.all([
            API.get("/api/chair/submissions"),
            API.get("/api/chair/users"),
            API.get("/api/chair/stats"),
          ]);
          const s = subsData.settings;
          const reviewers = usersData.users.filter((u) => u.roles.includes("reviewer") && !u.disabled);
          const loads = {};
          usersData.users.forEach((u) => { loads[u.id] = u.stats.assignments; });

          wrap.innerHTML = `
            <div class="grid cols-2">
              <div class="card">
                <div class="card-head"><h3>Auto-assignment</h3></div>
                <div class="card-body">
                  <div class="alert info">
                    Greedy auto-assignment: honours <b>bids</b>, skips <b>conflicts</b> (paper authors),
                    and balances reviewer load until each paper has
                    <b>${s.reviews_per_paper}</b> reviewers.
                  </div>
                  <div class="flex wrap">
                    <label class="field" style="flex:1;min-width:180px">
                      <span class="lbl">Target reviewers per paper</span>
                      <select class="select" id="ar-target">
                        ${[1, 2, 3, 4, 5].map((n) => `<option ${s.reviews_per_paper === n ? "selected" : ""}>${n}</option>`).join("")}
                      </select>
                    </label>
                    <button class="btn primary" id="ar-run" style="margin-top:22px">⚡ Run auto-assignment</button>
                  </div>
                  <div class="divider"></div>
                  <h3>Reviewer loads</h3>
                  ${reviewers.map((r) => `
                    <div class="bar-row">
                      <div class="name">${UI.esc(r.name)}</div>
                      <div class="track"><div style="width:${Math.min(100, (loads[r.id] || 0) * 14)}%"></div></div>
                      <div class="count">${loads[r.id] || 0}</div>
                    </div>`).join("")}
                </div>
              </div>
              <div class="card">
                <div class="card-head"><h3>Manual assignment</h3></div>
                <div class="card-body">
                  <label class="field"><span class="lbl">Paper</span>
                    <select class="select" id="ma-paper">
                      ${subsData.submissions.filter((p) => p.status === "submitted").map((p) =>
                        `<option value="${p.id}">#${p.id} · ${UI.esc(p.title.slice(0, 70))}</option>`).join("")}
                    </select></label>
                  <label class="field"><span class="lbl">Reviewer</span>
                    <select class="select" id="ma-reviewer">
                      ${reviewers.map((r) => `<option value="${r.id}">${UI.esc(r.name)} (load ${loads[r.id] || 0})</option>`).join("")}
                    </select></label>
                  <div class="btn-row">
                    <button class="btn primary" id="ma-add">Assign reviewer</button>
                  </div>
                  <div class="divider"></div>
                  <p class="muted small">Tip: open a paper below to see its current panel and remove reviewers inline.</p>
                </div>
              </div>
            </div>

            <div class="card">
              <div class="card-head"><h3>Panels</h3>
                <div class="right muted small">${subsData.submissions.length} papers</div>
              </div>
              <div class="table-wrap">
                <table class="table">
                  <thead><tr><th>#</th><th>Paper</th><th>Panel</th><th>Reviews in</th></tr></thead>
                  <tbody>
                    ${subsData.submissions.map((p) => `
                      <tr>
                        <td class="num">${p.id}</td>
                        <td class="title-cell"><a href="#/submission/${p.id}">${UI.esc(p.title)}</a></td>
                        <td>
                          <div class="flex wrap" style="gap:6px">
                            ${p.reviewers.map((r) => `
                              <span class="badge ${r.review_state === "submitted" ? "green" : "outline"}">
                                ${UI.esc(r.name)}
                                <a href="#" data-rm="${p.id}:${r.reviewer_id}" style="color:var(--red);font-weight:800">✕</a>
                              </span>`).join("")}
                            <button class="btn ghost small" data-add="${p.id}">+ Add</button>
                          </div>
                        </td>
                        <td><span class="badge ${p.n_reviews_submitted >= (p.reviewers.length || 1) ? "green" : "amber"}">${p.n_reviews_submitted}/${p.reviewers.length || 0}</span></td>
                      </tr>`).join("")}
                  </tbody>
                </table>
              </div>
            </div>`;

          wrap.querySelector("#ar-run").onclick = async () => {
            const target = Number(wrap.querySelector("#ar-target").value);
            await API.put("/api/chair/settings", { reviews_per_paper: target });
            try {
              const res = await API.post("/api/chair/assign/auto");
              UI.toast(`Auto-assignment complete — ${res.added} new assignments`, "success");
              draw();
            } catch (err) { UI.toast(err.message, "error"); }
          };
          wrap.querySelector("#ma-add").onclick = async () => {
            await API.post("/api/chair/assign", {
              submission_id: Number(wrap.querySelector("#ma-paper").value),
              reviewer_id: Number(wrap.querySelector("#ma-reviewer").value),
            });
            UI.toast("Reviewer assigned", "success");
            draw();
          };
          wrap.querySelectorAll("[data-rm]").forEach((a) => a.onclick = async (e) => {
            e.preventDefault();
            const [sid, rid] = a.dataset.rm.split(":").map(Number);
            await API.del("/api/chair/assign", { submission_id: sid, reviewer_id: rid });
            UI.toast("Reviewer removed", "success");
            draw();
          });
          wrap.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => {
            const sid = b.dataset.add;
            UI.modal(`Add reviewer · Paper #${sid}`, `
              <label class="field"><span class="lbl">Reviewer</span>
                <select class="select" id="pm-reviewer">
                  ${reviewers.map((r) => `<option value="${r.id}">${UI.esc(r.name)} (load ${loads[r.id] || 0})</option>`).join("")}
                </select></label>`,
              `<button class="btn ghost" data-close>Cancel</button>
               <button class="btn primary" id="pm-save">Assign</button>`);
            document.getElementById("pm-save").onclick = async () => {
              await API.post("/api/chair/assign", {
                submission_id: sid, reviewer_id: Number(document.getElementById("pm-reviewer").value),
              });
              UI.closeModal();
              UI.toast("Reviewer assigned", "success");
              draw();
            };
          });
        };
        draw();
      },
    };
  },

  /* ------------------------------------------------ users */
  users() {
    return {
      title: "People & Roles",
      subtitle: "Accounts, roles, and reviewer readiness",
      html: `<div id="users-wrap"><div class="empty">Loading…</div></div>`,
      async init(root) {
        const wrap = root.querySelector("#users-wrap");
        const draw = async () => {
          const data = await API.get("/api/chair/users");
          wrap.innerHTML = `
            <div class="flex between wrap mb3">
              <div class="muted">${data.users.length} accounts</div>
              <button class="btn primary" id="u-new">+ Create account</button>
            </div>
            <div class="card"><div class="table-wrap">
              <table class="table">
                <thead><tr><th>Name</th><th>Email</th><th>Affiliation</th><th>Roles</th><th>Papers</th><th>Reviews</th><th></th></tr></thead>
                <tbody>
                  ${data.users.map((u) => `
                    <tr style="${u.disabled ? "opacity:.5" : ""}">
                      <td>
                        <div class="flex">
                          <div class="avatar">${UI.initials(u.name)}</div>
                          <div>
                            <div style="font-weight:700">${UI.esc(u.name)}</div>
                            ${u.disabled ? `<span class="badge red">disabled</span>` : ""}
                          </div>
                        </div>
                      </td>
                      <td class="small">${UI.esc(u.email)}</td>
                      <td class="small">${UI.esc(u.affiliation || "—")}</td>
                      <td>${UI.roleChips(u.roles)}</td>
                      <td class="num">${u.stats.submissions}</td>
                      <td class="num">${u.stats.reviews_done}/${u.stats.assignments}</td>
                      <td class="text-right">
                        <button class="btn ghost small" data-edit="${u.id}">Edit</button>
                      </td>
                    </tr>`).join("")}
                </tbody>
              </table>
            </div></div>`;
          wrap.querySelector("#u-new").onclick = () => {
            UI.modal("Create account", `
              <div class="form-row">
                <label class="field"><span class="lbl">Name</span><input class="input" id="cu-name"></label>
                <label class="field"><span class="lbl">Email</span><input class="input" id="cu-email" type="email"></label>
              </div>
              <div class="form-row">
                <label class="field"><span class="lbl">Affiliation</span><input class="input" id="cu-aff"></label>
                <label class="field"><span class="lbl">Initial password</span><input class="input" id="cu-pwd" value="welcome123"></label>
              </div>
              <label class="field"><span class="lbl">Roles</span>
                <div class="flex wrap">
                  <label class="checkbox-row"><input type="checkbox" id="cu-author" checked> Author</label>
                  <label class="checkbox-row"><input type="checkbox" id="cu-rev"> Reviewer</label>
                  <label class="checkbox-row"><input type="checkbox" id="cu-chair"> Chair</label>
                </div>
              </label>
              <div class="alert info">An email is recorded in the simulated outbox with the credentials.</div>`,
              `<button class="btn ghost" data-close>Cancel</button>
               <button class="btn primary" id="cu-save">Create</button>`);
            document.getElementById("cu-save").onclick = async () => {
              const roles = [];
              if (document.getElementById("cu-author").checked) roles.push("author");
              if (document.getElementById("cu-rev").checked) roles.push("reviewer");
              if (document.getElementById("cu-chair").checked) roles.push("chair");
              try {
                await API.post("/api/chair/users", {
                  name: document.getElementById("cu-name").value,
                  email: document.getElementById("cu-email").value,
                  affiliation: document.getElementById("cu-aff").value,
                  password: document.getElementById("cu-pwd").value,
                  roles: roles.length ? roles : ["author"],
                });
                UI.closeModal();
                UI.toast("Account created", "success");
                draw();
              } catch (err) { UI.toast(err.message, "error"); }
            };
          };
          wrap.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => {
            const u = data.users.find((x) => x.id === Number(b.dataset.edit));
            UI.modal(`Edit · ${UI.esc(u.name)}`, `
              <label class="field"><span class="lbl">Roles</span>
                <div class="flex wrap">
                  <label class="checkbox-row"><input type="checkbox" id="eu-author" ${u.roles.includes("author") ? "checked" : ""}> Author</label>
                  <label class="checkbox-row"><input type="checkbox" id="eu-rev" ${u.roles.includes("reviewer") ? "checked" : ""}> Reviewer</label>
                  <label class="checkbox-row"><input type="checkbox" id="eu-chair" ${u.roles.includes("chair") ? "checked" : ""}> Chair</label>
                </div>
              </label>
              <label class="field"><span class="lbl">Reset password (leave blank to keep)</span>
                <input class="input" id="eu-pwd" placeholder="new password"></label>
              <label class="checkbox-row"><input type="checkbox" id="eu-dis" ${u.disabled ? "checked" : ""}> Disable this account</label>`,
              `<button class="btn ghost" data-close>Cancel</button>
               <button class="btn primary" id="eu-save">Save</button>`);
            document.getElementById("eu-save").onclick = async () => {
              const roles = [];
              if (document.getElementById("eu-author").checked) roles.push("author");
              if (document.getElementById("eu-rev").checked) roles.push("reviewer");
              if (document.getElementById("eu-chair").checked) roles.push("chair");
              try {
                await API.put(`/api/chair/users/${u.id}`, {
                  roles: roles.length ? roles : ["author"],
                  password: document.getElementById("eu-pwd").value,
                  disabled: document.getElementById("eu-dis").checked,
                });
                UI.closeModal();
                UI.toast("User updated", "success");
                draw();
              } catch (err) { UI.toast(err.message, "error"); }
            };
          });
        };
        draw();
      },
    };
  },

  /* ------------------------------------------------ settings */
  settings() {
    return {
      title: "Conference Settings",
      subtitle: "Deadlines, policy switches, topics and review scale",
      html: `<div id="set-wrap"><div class="empty">Loading…</div></div>`,
      async init(root) {
        const wrap = root.querySelector("#set-wrap");
        const s = { ...State.settings };
        const dt = (v) => (v || "").slice(0, 16);
        const toggles = [
          ["submissions_open", "Submissions open", "Authors can create and edit submissions"],
          ["reviewing_open", "Reviewing open", "Reviewers can write and submit reviews"],
          ["bidding_open", "Bidding open", "Reviewers can bid on papers"],
          ["camera_ready_open", "Camera-ready open", "Accepted authors can upload final PDFs"],
          ["reviews_visible", "Reviews visible to authors", "Authors can read released reviews"],
          ["decisions_released", "Decisions released", "Authors can see accept/reject decisions"],
          ["blind_reviewing", "Double-blind reviewing", "Hide author identities from reviewers"],
          ["author_see_reviewer_names", "Show reviewer names to authors", "Otherwise reviews stay anonymous"],
        ];
        wrap.innerHTML = `
          <div class="grid cols-2">
            <div class="card">
              <div class="card-head"><h3>Identity & description</h3></div>
              <div class="card-body">
                <div class="form-row">
                  <label class="field"><span class="lbl">Conference name</span>
                    <input class="input" id="s-name" value="${UI.esc(s.conference_name)}"></label>
                  <label class="field"><span class="lbl">Short name</span>
                    <input class="input" id="s-short" value="${UI.esc(s.conference_short)}"></label>
                </div>
                <label class="field"><span class="lbl">Description</span>
                  <textarea class="textarea" id="s-desc">${UI.esc(s.conference_description)}</textarea></label>
              </div>
            </div>
            <div class="card">
              <div class="card-head"><h3>Deadlines</h3></div>
              <div class="card-body">
                <div class="form-row">
                  <label class="field"><span class="lbl">Submissions due</span>
                    <input class="input" type="datetime-local" id="s-sub" value="${dt(s.submission_deadline)}"></label>
                  <label class="field"><span class="lbl">Reviews due</span>
                    <input class="input" type="datetime-local" id="s-rev" value="${dt(s.review_deadline)}"></label>
                </div>
                <div class="form-row">
                  <label class="field"><span class="lbl">Rebuttal due</span>
                    <input class="input" type="datetime-local" id="s-reb" value="${dt(s.rebuttal_deadline)}"></label>
                  <label class="field"><span class="lbl">Decisions released by</span>
                    <input class="input" type="datetime-local" id="s-dec" value="${dt(s.decision_deadline)}"></label>
                </div>
                <label class="field"><span class="lbl">Camera-ready due</span>
                  <input class="input" type="datetime-local" id="s-cr" value="${dt(s.camera_ready_deadline)}"></label>
              </div>
            </div>
          </div>

          <div class="grid cols-2">
            <div class="card">
              <div class="card-head"><h3>Policy switches</h3></div>
              <div class="card-body">
                ${toggles.map(([key, label, hint]) => `
                  <label class="switch">
                    <input type="checkbox" id="tg-${key}" ${s[key] ? "checked" : ""}>
                    <span class="track"></span>
                    <span class="txt">${label}<small>${hint}</small></span>
                  </label>`).join("")}
                <div class="form-row mt3">
                  <label class="field"><span class="lbl">Max papers per author</span>
                    <input class="input" type="number" id="s-max" min="1" max="20" value="${s.max_papers_per_author}"></label>
                  <label class="field"><span class="lbl">Reviewers per paper</span>
                    <input class="input" type="number" id="s-rpp" min="1" max="6" value="${s.reviews_per_paper}"></label>
                </div>
              </div>
            </div>
            <div class="card">
              <div class="card-head"><h3>Topics</h3>
                <div class="right"><button class="btn ghost small" id="t-add">+ Add topic</button></div>
              </div>
              <div class="card-body">
                <div class="chip-select" id="topic-list">
                  ${(s.topics || []).map((t, i) => `
                    <span class="chip on" data-topic-idx="${i}">${UI.esc(t)}
                      <a href="#" data-topic-rm="${i}" style="color:#fff;margin-left:6px;font-weight:800">✕</a>
                    </span>`).join("")}
                </div>
                <div class="divider"></div>
                <p class="muted small">Topics appear on submission forms and drive bidding & auto-assignment.</p>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-foot" style="justify-content:flex-end">
              <button class="btn ghost" id="s-reset">Reset changes</button>
              <button class="btn primary large" id="s-save">Save all settings</button>
            </div>
          </div>`;

        wrap.querySelector("#t-add").onclick = () => {
          UI.modal("Add topic", `<label class="field"><span class="lbl">Topic name</span>
            <input class="input" id="topic-name"></label>`,
            `<button class="btn ghost" data-close>Cancel</button>
             <button class="btn primary" id="topic-save">Add</button>`);
          document.getElementById("topic-save").onclick = () => {
            const name = document.getElementById("topic-name").value.trim();
            if (!name) return;
            if (!s.topics.includes(name)) s.topics.push(name);
            UI.closeModal();
            render();
          };
        };
        wrap.querySelectorAll("[data-topic-rm]").forEach((a) => a.onclick = (e) => {
          e.preventDefault();
          s.topics.splice(Number(a.dataset.topicRm), 1);
          render();
        });
        wrap.querySelector("#s-reset").onclick = () => render();
        wrap.querySelector("#s-save").onclick = async () => {
          const payload = {
            conference_name: wrap.querySelector("#s-name").value,
            conference_short: wrap.querySelector("#s-short").value,
            conference_description: wrap.querySelector("#s-desc").value,
            submission_deadline: wrap.querySelector("#s-sub").value,
            review_deadline: wrap.querySelector("#s-rev").value,
            rebuttal_deadline: wrap.querySelector("#s-reb").value,
            decision_deadline: wrap.querySelector("#s-dec").value,
            camera_ready_deadline: wrap.querySelector("#s-cr").value,
            max_papers_per_author: Number(wrap.querySelector("#s-max").value),
            reviews_per_paper: Number(wrap.querySelector("#s-rpp").value),
            topics: s.topics,
          };
          toggles.forEach(([key]) => {
            payload[key] = wrap.querySelector(`#tg-${key}`).checked ? 1 : 0;
          });
          try {
            const res = await API.put("/api/chair/settings", payload);
            State.settings = res.settings;
            UI.toast("Settings saved", "success");
            render();
          } catch (err) { UI.toast(err.message, "error"); }
        };
      },
    };
  },

  /* ------------------------------------------------ notify */
  notify() {
    return {
      title: "Announcements",
      subtitle: "Email + in-app notifications to any audience",
      html: `
        <div class="grid cols-2">
          <div class="card">
            <div class="card-head"><h3>Send announcement</h3></div>
            <div class="card-body">
              <label class="field"><span class="lbl">Audience</span>
                <select class="select" id="n-aud">
                  <option value="all">Everyone</option>
                  <option value="authors">All submitting authors</option>
                  <option value="reviewers">All reviewers</option>
                  <option value="accepted">Authors of accepted papers</option>
                </select></label>
              <label class="field"><span class="lbl">Subject</span>
                <input class="input" id="n-subject" placeholder="e.g. Reviewing deadline extended"></label>
              <label class="field"><span class="lbl">Message</span>
                <textarea class="textarea tall" id="n-body" placeholder="Write the announcement…"></textarea></label>
              <button class="btn primary" id="n-send">Send announcement</button>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><h3>Simulated email outbox</h3>
              <div class="right"><button class="btn ghost small" id="n-refresh">Refresh</button></div>
            </div>
            <div class="card-body" style="max-height:520px;overflow:auto" id="outbox">
              <div class="muted">Loading…</div>
            </div>
          </div>
        </div>`,
      async init(root) {
        const loadOutbox = async () => {
          const data = await API.get("/api/chair/outbox");
          const box = root.querySelector("#outbox");
          box.innerHTML = data.outbox.length ? data.outbox.map((m) => `
            <div class="comment-item" style="border-color:var(--blue);background:var(--blue-soft)">
              <div class="who" style="color:var(--blue)">✉ ${UI.esc(m.to_email)} · ${UI.fmtDate(m.created_at)}</div>
              <div style="font-weight:700">${UI.esc(m.subject)}</div>
              <div class="small" style="white-space:pre-wrap">${UI.esc(m.body)}</div>
            </div>`).join("") : `<div class="muted">No emails sent yet.</div>`;
        };
        loadOutbox();
        root.querySelector("#n-refresh").onclick = loadOutbox;
        root.querySelector("#n-send").onclick = async () => {
          try {
            const res = await API.post("/api/chair/notify", {
              audience: root.querySelector("#n-aud").value,
              subject: root.querySelector("#n-subject").value,
              body: root.querySelector("#n-body").value,
            });
            UI.toast(`Announcement sent to ${res.sent} recipients`, "success");
            root.querySelector("#n-body").value = "";
            loadOutbox();
          } catch (err) { UI.toast(err.message, "error"); }
        };
      },
    };
  },

  /* ------------------------------------------------ export & audit */
  exportAudit() {
    return {
      title: "Export & Audit",
      subtitle: "Take the data with you; review every action taken",
      html: `
        <div class="grid cols-2">
          <div class="card">
            <div class="card-head"><h3>Exports</h3></div>
            <div class="card-body">
              <p class="muted">Download conference data for proceedings, reporting, or archival.</p>
              <div class="btn-row">
                <button class="btn subtle" data-exp="submissions.csv">📄 submissions.csv</button>
                <button class="btn subtle" data-exp="reviews.csv">📊 reviews.csv</button>
                <button class="btn subtle" data-exp="users.csv">👥 users.csv</button>
                <button class="btn primary" data-exp="all.json">🗄 full dump (JSON)</button>
              </div>
              <div class="divider"></div>
              <h3>What each export contains</h3>
              <div class="kv">
                <div class="k">submissions.csv</div><div class="v">Paper metadata, authors, topics, decisions, average scores</div>
                <div class="k">reviews.csv</div><div class="v">Every review with scores and reviewer names</div>
                <div class="k">users.csv</div><div class="v">Accounts, affiliations, roles</div>
                <div class="k">all.json</div><div class="v">Complete archive: settings, papers, reviews, bids, audit log</div>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><h3>Audit log</h3>
              <div class="right"><button class="btn ghost small" id="a-refresh">Refresh</button></div>
            </div>
            <div class="card-body" style="max-height:520px;overflow:auto" id="audit">
              <div class="muted">Loading…</div>
            </div>
          </div>
        </div>`,
      async init(root) {
        root.querySelectorAll("[data-exp]").forEach((b) => b.onclick = () => {
          API.download(`/api/chair/export/${b.dataset.exp}`, b.dataset.exp);
          UI.toast(`Downloading ${b.dataset.exp}`, "success");
        });
        const loadAudit = async () => {
          const data = await API.get("/api/chair/audit");
          const box = root.querySelector("#audit");
          box.innerHTML = data.log.length ? data.log.map((l) => `
            <div class="flex" style="padding:7px 0;border-bottom:1px solid var(--line-2)">
              <span class="tag-soft">${UI.esc(l.action)}</span>
              <div style="min-width:0">
                <div class="small">${UI.esc(l.detail || "")}</div>
                <div class="muted small">${UI.esc(l.user_name || "system")} · ${UI.fmtDate(l.created_at)}</div>
              </div>
            </div>`).join("") : `<div class="muted">No activity yet.</div>`;
        };
        loadAudit();
        root.querySelector("#a-refresh").onclick = loadAudit;
      },
    };
  },
};

Object.assign(window.Views, {
  chairDashboard: ChairViews.dashboard,
  chairSubmissions: ChairViews.submissions,
  chairAssignments: ChairViews.assignments,
  chairUsers: ChairViews.users,
  chairSettings: ChairViews.settings,
  chairNotify: ChairViews.notify,
  chairExportAudit: ChairViews.exportAudit,
});
