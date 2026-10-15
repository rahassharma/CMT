/* ============ author.js — submissions, detail, reviews & rebuttal ============ */
window.Views = window.Views || {};

const AuthorViews = {

  /* ------------------------------------------------ submission form */
  form(isEdit, existing) {
    const s = State.settings || {};
    const sub = existing || {
      title: "", abstract: "", topics: [], track: "Main",
      authors: [{ name: State.user?.name || "", email: State.user?.email || "", affiliation: State.user?.affiliation || "" }],
    };
    return {
      title: isEdit ? `Edit Paper #${sub.id}` : "New Submission",
      subtitle: `Submission deadline: ${UI.fmtDate(s.submission_deadline)}`,
      html: `
        <div class="card">
          <div class="card-head"><h2>${isEdit ? "Edit submission" : "Submit a paper"}</h2>
            <div class="right">${UI.deadlineChip("Submissions due", s.submission_deadline)}</div>
          </div>
          <div class="card-body">
            <label class="field"><span class="lbl">Paper title</span>
              <input class="input" id="f-title" value="${UI.esc(sub.title)}" placeholder="Descriptive title of your submission">
            </label>
            <label class="field"><span class="lbl">Abstract</span>
              <textarea class="textarea tall" id="f-abstract" placeholder="Summary of the problem, approach, and main results…">${UI.esc(sub.abstract)}</textarea>
            </label>
            <label class="field"><span class="lbl">Track</span>
              <select class="select" id="f-track">
                ${["Main", "Findings", "Demo", "Industry"].map((t) =>
                  `<option ${sub.track === t ? "selected" : ""}>${t}</option>`).join("")}
              </select>
            </label>
            <label class="field"><span class="lbl">Topics (${(s.topics || []).length} available — pick up to 5)</span>
              <div class="chip-select" id="f-topics">
                ${(s.topics || []).map((t) =>
                  `<div class="chip ${sub.topics.includes(t) ? "on" : ""}" data-topic="${UI.esc(t)}">${UI.esc(t)}</div>`).join("")}
              </div>
            </label>
            <div class="divider"></div>
            <div class="flex between mb2">
              <h3 class="mb0">Authors</h3>
              <button class="btn ghost small" id="f-add-author">+ Add author</button>
            </div>
            <div id="f-authors"></div>
            <div class="divider"></div>
            <h3>Paper PDF</h3>
            <p class="muted small">Upload the camera-ready-ready PDF (max 25 MB). You can replace it any time before the deadline.</p>
            <div class="flex wrap">
              <input type="file" id="f-pdf" accept="application/pdf" class="input" style="max-width:340px">
              ${sub.pdf_filename ? `<span class="badge green">Current: ${UI.esc(sub.pdf_filename)}</span>
                <a class="btn ghost small" href="#" id="f-dl-pdf">Download current PDF</a>` : ""}
            </div>
          </div>
          <div class="card-foot">
            <button class="btn primary large" id="f-save">${isEdit ? "Save changes" : "Submit paper"}</button>
            <button class="btn ghost large" id="f-cancel">Cancel</button>
            <div class="spacer"></div>
            ${isEdit ? `<button class="btn danger" id="f-withdraw">Withdraw submission</button>` : ""}
          </div>
        </div>`,
      init(root) {
        const authorsRoot = root.querySelector("#f-authors");
        function renderAuthors() {
          authorsRoot.innerHTML = sub.authors.map((a, i) => `
            <div class="form-row cols-3" data-idx="${i}" style="margin-bottom:9px">
              <input class="input a-name" placeholder="Full name" value="${UI.esc(a.name)}">
              <input class="input a-email" placeholder="Email" value="${UI.esc(a.email || "")}">
              <div class="flex">
                <input class="input a-aff" placeholder="Affiliation" value="${UI.esc(a.affiliation || "")}">
                <button class="btn-icon a-del" title="Remove">✕</button>
              </div>
            </div>`).join("");
        }
        renderAuthors();
        authorsRoot.addEventListener("click", (e) => {
          const row = e.target.closest("[data-idx]");
          if (e.target.closest(".a-del") && row) {
            if (sub.authors.length <= 1) return UI.toast("At least one author is required", "warn");
            sub.authors.splice(+row.dataset.idx, 1);
            renderAuthors();
          }
        });
        root.querySelector("#f-add-author").onclick = () => {
          sub.authors.push({ name: "", email: "", affiliation: "" });
          renderAuthors();
        };
        root.querySelectorAll("#f-topics .chip").forEach((chip) => {
          chip.onclick = () => {
            const t = chip.dataset.topic;
            const on = sub.topics.includes(t);
            if (!on && sub.topics.length >= 5) return UI.toast("Max 5 topics", "warn");
            sub.topics = on ? sub.topics.filter((x) => x !== t) : [...sub.topics, t];
            chip.classList.toggle("on", !on);
          };
        });
        const collect = () => {
          const rows = [...root.querySelectorAll("#f-authors [data-idx]")];
          const authors = rows.map((r) => ({
            name: r.querySelector(".a-name").value.trim(),
            email: r.querySelector(".a-email").value.trim(),
            affiliation: r.querySelector(".a-aff").value.trim(),
          }));
          return {
            title: root.querySelector("#f-title").value.trim(),
            abstract: root.querySelector("#f-abstract").value.trim(),
            track: root.querySelector("#f-track").value,
            topics: sub.topics,
            authors,
          };
        };
        root.querySelector("#f-cancel").onclick = () => history.back();
        const dl = root.querySelector("#f-dl-pdf");
        if (dl) dl.onclick = (e) => {
          e.preventDefault();
          API.download(`/api/submissions/${sub.id}/pdf`, sub.pdf_filename);
        };
        if (isEdit) root.querySelector("#f-withdraw").onclick = async () => {
          if (!(await UI.confirm("Withdraw this submission? Reviewers will no longer see it. You can restore it before the deadline.", "Withdraw", true))) return;
          await API.post(`/api/submissions/${sub.id}/withdraw`);
          UI.toast("Submission withdrawn");
          go("#/submissions");
        };
        root.querySelector("#f-save").onclick = async () => {
          const payload = collect();
          try {
            let created = sub;
            if (isEdit) {
              const data = await API.put(`/api/submissions/${sub.id}`, payload);
              created = data.submission;
            } else {
              const data = await API.post("/api/submissions", payload);
              created = data.submission;
              UI.toast("Submission created", "success");
            }
            const file = root.querySelector("#f-pdf").files[0];
            if (file) {
              const fd = new FormData();
              fd.append("file", file);
              await API.post(`/api/submissions/${created.id}/pdf`, fd, true);
              UI.toast("PDF uploaded", "success");
            }
            go(`#/submission/${created.id}`);
          } catch (err) {
            UI.toast(err.message, "error");
          }
        };
      },
    };
  },

  /* ------------------------------------------------ my submissions */
  list() {
    return {
      title: "My Submissions",
      subtitle: "Manage your papers, reviews and camera-ready files",
      html: `<div id="sub-list"><div class="empty">Loading…</div></div>`,
      async init(root) {
        const data = await API.get("/api/submissions");
        const list = data.submissions;
        const s = data.settings;
        const el = root.querySelector("#sub-list");
        if (!list.length) {
          el.innerHTML = `<div class="empty"><div class="big">📄</div>
            <h3>No submissions yet</h3>
            <p>Start by creating your first paper submission.</p>
            <button class="btn primary" id="go-new">+ New submission</button></div>`;
          el.querySelector("#go-new").onclick = () => go("#/submit");
          return;
        }
        el.innerHTML = `
          <div class="flex between wrap mb3">
            <div class="btn-row">${UI.deadlineChip("Submissions due", s.submission_deadline)}</div>
            <button class="btn primary" id="go-new">+ New submission</button>
          </div>
          ${list.map((sub) => `
            <div class="card paper-card clickable" data-open="${sub.id}" style="cursor:pointer">
              <div class="flex between wrap">
                <div style="min-width:260px;flex:1">
                  <div class="meta-line mb2">
                    <span class="badge accent">Paper #${sub.id}</span>
                    ${UI.statusBadge(sub.status)}
                    ${UI.decisionBadge(sub.decision, sub.decision_pending)}
                  </div>
                  <h3>${UI.esc(sub.title)}</h3>
                  <div class="meta-line">
                    <span>👥 ${UI.esc(sub.authors.map((a) => a.name).join(", "))}</span>
                  </div>
                  <div class="meta-line mt2">${UI.topicChips(sub.topics)}</div>
                  <div class="abstract-preview">${UI.esc(sub.abstract)}</div>
                </div>
                <div style="text-align:right;min-width:170px">
                  <div class="muted small">Reviews</div>
                  <div class="flex" style="justify-content:flex-end;gap:6px;margin:6px 0">
                    ${sub.n_reviews_submitted > 0
                      ? `<span class="badge green">${sub.n_reviews_submitted} in</span>`
                      : `<span class="badge outline">none yet</span>`}
                    ${sub.avg_overall ? `<span class="badge purple">avg ${sub.avg_overall}</span>` : ""}
                  </div>
                  <div class="muted small">Updated ${UI.fmtDate(sub.updated_at)}</div>
                  ${sub.camera_ready_filename ? `<div class="mt2"><span class="badge green">Camera-ready ✓</span></div>` : ""}
                </div>
              </div>
            </div>`).join("")}`;
        el.querySelector("#go-new").onclick = () => go("#/submit");
        el.querySelectorAll("[data-open]").forEach((card) => {
          card.onclick = () => go(`#/submission/${card.dataset.open}`);
        });
      },
    };
  },

  /* ------------------------------------------------ submission detail */
  detail(id) {
    return {
      title: `Paper #${id}`,
      subtitle: "Submission workspace",
      html: `<div id="sub-detail"><div class="empty">Loading…</div></div>`,
      async init(root) {
        const wrap = root.querySelector("#sub-detail");
        let data;
        try {
          data = await API.get(`/api/submissions/${id}`);
        } catch (err) {
          wrap.innerHTML = `<div class="empty"><div class="big">🔒</div><h3>${UI.esc(err.message)}</h3></div>`;
          return;
        }
        const sub = data.submission;
        const s = data.settings;
        const me = State.user;
        const authorSide = sub.authors.some((a) => (a.email || "").toLowerCase() === me.email.toLowerCase())
          || sub.submitted_by === me.id;
        const chair = State.isChair();
        const showReviews = sub.reviews.length > 0;
        const decisionZone = (authorSide || chair) && sub.decision;

        wrap.innerHTML = `
          <div class="flex between wrap mb3">
            <div>
              <div class="flex wrap mb2">
                <span class="badge accent lg">Paper #${sub.id}</span>
                ${UI.statusBadge(sub.status)}
                ${UI.decisionBadge(sub.decision, sub.decision_pending)}
                ${UI.topicChips(sub.topics)}
              </div>
              <h1 style="max-width:820px">${UI.esc(sub.title)}</h1>
              <div class="muted">${UI.esc(sub.authors.map((a) => `${a.name}${a.affiliation ? " (" + a.affiliation + ")" : ""}`).join(" · "))}</div>
            </div>
            <div class="btn-row">
              ${sub.pdf_filename ? `<button class="btn ghost" id="dl-pdf">⬇ Paper PDF</button>` : ""}
              ${sub.can_edit ? `<button class="btn primary" id="edit-sub">Edit submission</button>` : ""}
              ${(chair && sub.status === "withdrawn") ? `<button class="btn warning" id="restore-sub">Restore</button>` : ""}
              ${chair ? `<button class="btn danger" id="chair-decide">Decision…</button>` : ""}
            </div>
          </div>

          ${!s.submissions_open ? `<div class="alert warn">Submissions are currently frozen by the chairs.</div>` : ""}
          ${sub.status === "withdrawn" ? `<div class="alert danger"><b>This submission has been withdrawn.</b> ${chair || authorSide ? "You can restore it before the review deadline." : ""}</div>` : ""}

          ${decisionZone ? `
            <div class="alert ${sub.decision === "reject" ? "danger" : "success"}">
              <b>Decision: ${sub.decision === "reject" ? "Not accepted" : sub.decision === "accept_poster" ? "Accepted as poster" : "Accepted"}.</b>
              ${UI.esc(sub.decision_comment || "")}
              ${sub.camera_ready_open !== false && (sub.decision !== "reject") ? `<div class="mt2 small">Camera-ready deadline: ${UI.fmtDate(s.camera_ready_deadline)}</div>` : ""}
            </div>` : ""}

          <div class="grid cols-3">
            <div class="card" style="grid-column:span 2">
              <div class="card-head"><h3>Abstract</h3>
                <div class="right muted small">Submitted ${UI.fmtDate(sub.created_at)}</div>
              </div>
              <div class="card-body" style="white-space:pre-wrap">${UI.esc(sub.abstract)}</div>
            </div>
            <div>
              <div class="card">
                <div class="card-head"><h3>Authors</h3></div>
                <div class="card-body" style="padding:12px 18px">
                  ${sub.authors.map((a, i) => `
                    <div class="flex" style="padding:7px 0;border-bottom:${i === sub.authors.length - 1 ? "0" : "1px solid var(--line-2)"}">
                      <div class="avatar">${UI.initials(a.name)}</div>
                      <div>
                        <div style="font-weight:700;font-size:13px">${UI.esc(a.name)}</div>
                        <div class="muted small">${UI.esc(a.email || "")}${a.affiliation ? " · " + UI.esc(a.affiliation) : ""}</div>
                      </div>
                    </div>`).join("")}
                </div>
              </div>
              <div class="card">
                <div class="card-head"><h3>Files</h3></div>
                <div class="card-body">
                  ${sub.pdf_filename
                    ? `<div class="flex"><span class="badge blue">PDF</span><span class="small">${UI.esc(sub.pdf_filename)}</span></div>`
                    : `<div class="muted small">No PDF uploaded.</div>`}
                  ${sub.camera_ready_filename ? `
                    <div class="flex mt2"><span class="badge green">Camera-ready</span>
                    <a class="small" href="#" id="dl-cr">download</a></div>
                    ${sub.camera_ready_note ? `<div class="muted small mt2">${UI.esc(sub.camera_ready_note)}</div>` : ""}` : ""}
                  ${(authorSide || chair) && sub.decision && sub.decision !== "reject" && s.camera_ready_open ? `
                    <button class="btn subtle small mt3" id="cr-upload">Upload camera-ready</button>` : ""}
                </div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head">
              <h3>Reviews</h3>
              <div class="right">
                ${sub.avg_overall ? `<span class="badge purple lg">Average overall: ${sub.avg_overall}</span>` : ""}
                ${!sub.reviews.length ? `<span class="badge outline">Not visible yet</span>` : ""}
              </div>
            </div>
            <div class="card-body">
              ${!sub.reviews.length ? `
                <div class="muted">Reviews will appear here once the chairs release them
                ${s.reviews_visible ? "(currently released — this paper has no submitted reviews yet)" : ""}.</div>` : ""}
              ${sub.reviews.map((r) => `
                <div class="review-box">
                  <div class="head">
                    <div class="avatar purple">${UI.initials(r.reviewer)}</div>
                    <div>
                      <div style="font-weight:700">${UI.esc(r.reviewer)}</div>
                      <div class="muted small">Updated ${UI.fmtDate(r.updated_at)} · ${UI.reviewStateBadge(r.state)}</div>
                    </div>
                    <div class="spacer"></div>
                    <div class="scores-row" style="margin:0">
                      ${UI.scorePill("overall", r.overall, 7)}
                      ${UI.scorePill("confidence", r.confidence, 5)}
                    </div>
                  </div>
                  <div class="scores-row">
                    ${UI.scorePill("soundness", r.soundness, 3)}
                    ${UI.scorePill("presentation", r.presentation, 3)}
                    ${UI.scorePill("contribution", r.contribution, 3)}
                    <div class="score-pill"><div class="n" style="font-size:11px;line-height:1.6">${UI.esc(UI.overallLabel(r.overall))}</div><div class="l">verdict</div></div>
                  </div>
                  ${r.strengths ? `<div class="mt2"><b class="small">Strengths</b><div class="small" style="white-space:pre-wrap">${UI.esc(r.strengths)}</div></div>` : ""}
                  ${r.weaknesses ? `<div class="mt2"><b class="small">Weaknesses</b><div class="small" style="white-space:pre-wrap">${UI.esc(r.weaknesses)}</div></div>` : ""}
                  ${r.questions ? `<div class="mt2"><b class="small">Questions</b><div class="small" style="white-space:pre-wrap">${UI.esc(r.questions)}</div></div>` : ""}
                </div>`).join("")}
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>Discussion & rebuttal</h3>
              <div class="right muted small">Rebuttal deadline: ${UI.fmtDate(s.rebuttal_deadline)}</div>
            </div>
            <div class="card-body">
              <div id="comments">
                ${sub.comments.length ? sub.comments.map((c) => `
                  <div class="comment-item ${c.visibility}">
                    <div class="who">${UI.esc(c.author)} · ${UI.esc(c.visibility)} · ${UI.fmtDate(c.created_at)}</div>
                    <div style="white-space:pre-wrap">${UI.esc(c.body)}</div>
                  </div>`).join("") : `<div class="muted small mb3">No comments yet. Authors can post a rebuttal; reviewers and chairs can reply.</div>`}
              </div>
              <label class="field mt3">
                <span class="lbl">Add to the discussion</span>
                <textarea class="textarea" id="new-comment" placeholder="Author response, reviewer comment, or chair note…"></textarea>
              </label>
              <div class="flex wrap">
                <select class="select" id="comment-vis" style="max-width:220px">
                  <option value="everyone">Everyone</option>
                  <option value="reviewers">Reviewers & chairs</option>
                  <option value="authors">Authors & chairs</option>
                </select>
                <button class="btn primary" id="post-comment">Post comment</button>
              </div>
            </div>
          </div>`;

        const q = (sel) => wrap.querySelector(sel);
        const dl = q("#dl-pdf");
        if (dl) dl.onclick = () => API.download(`/api/submissions/${sub.id}/pdf`, sub.pdf_filename);
        const dlcr = q("#dl-cr");
        if (dlcr) dlcr.onclick = (e) => { e.preventDefault(); API.download(`/api/submissions/${sub.id}/camera-ready`, "camera_ready.pdf"); };
        const edit = q("#edit-sub");
        if (edit) edit.onclick = () => go(`#/submission/${sub.id}/edit`);
        const restore = q("#restore-sub");
        if (restore) restore.onclick = async () => {
          await API.post(`/api/submissions/${sub.id}/restore`);
          UI.toast("Submission restored", "success");
          render();
        };
        const cr = q("#cr-upload");
        if (cr) cr.onclick = () => {
          UI.modal("Upload camera-ready", `
            <p class="muted small">Accepted papers only. PDF format, max 25 MB.</p>
            <input type="file" id="cr-file" accept="application/pdf" class="input mb3">
            <label class="field"><span class="lbl">Note to chairs (optional)</span>
              <textarea class="textarea" id="cr-note" style="min-height:80px"></textarea></label>`,
            `<button class="btn ghost" data-close>Cancel</button>
             <button class="btn primary" id="cr-save">Upload</button>`);
          document.getElementById("cr-save").onclick = async () => {
            const file = document.getElementById("cr-file").files[0];
            if (!file) return UI.toast("Choose a PDF first", "warn");
            const fd = new FormData();
            fd.append("file", file);
            fd.append("note", document.getElementById("cr-note").value);
            try {
              await API.post(`/api/submissions/${sub.id}/camera-ready`, fd, true);
              UI.closeModal();
              UI.toast("Camera-ready uploaded", "success");
              render();
            } catch (err) { UI.toast(err.message, "error"); }
          };
        };
        q("#post-comment").onclick = async () => {
          const body = q("#new-comment").value.trim();
          if (!body) return UI.toast("Write something first", "warn");
          try {
            await API.post(`/api/submissions/${sub.id}/comments`, {
              body, visibility: q("#comment-vis").value,
            });
            UI.toast("Comment posted", "success");
            render();
          } catch (err) { UI.toast(err.message, "error"); }
        };
        const cd = q("#chair-decide");
        if (cd) cd.onclick = () => ChairViews.openDecisionModal([sub], render);
      },
    };
  },
};

Object.assign(window.Views, {
  authorForm: AuthorViews.form,
  authorList: AuthorViews.list,
  submissionDetail: AuthorViews.detail,
});
