/* ============ reviewer.js — assignment queue, bidding, review forms ============ */

const ReviewerViews = {

  queue() {
    return {
      title: "Reviewing Queue",
      subtitle: "Papers assigned to you",
      html: `<div id="rev-queue"><div class="empty">Loading…</div></div>`,
      async init(root) {
        const wrap = root.querySelector("#rev-queue");
        const data = await API.get("/api/reviewer/queue");
        const s = data.settings;
        const queue = data.queue;
        const done = queue.filter((q) => q.my_review && q.my_review.state === "submitted").length;
        wrap.innerHTML = `
          <div class="flex wrap between mb3">
            <div class="flex wrap">${UI.deadlineChip("Reviews due", s.review_deadline)}</div>
            <div class="flex wrap">
              <div style="min-width:180px">
                <div class="muted small" style="margin-bottom:4px">${done}/${queue.length} reviews submitted</div>
                <div class="progress green"><div style="width:${queue.length ? (100 * done / queue.length) : 0}%"></div></div>
              </div>
              <button class="btn subtle" id="go-bids">Bidding</button>
            </div>
          </div>
          ${!queue.length ? `<div class="empty"><div class="big">🎯</div><h3>No assignments yet</h3>
            <p>Head to <b>Bidding</b> to express interest in papers, or wait for the chairs to assign you.</p></div>` : ""}
          ${queue.map((q) => {
            const sub = q.submission, rev = q.my_review;
            return `
            <div class="card paper-card">
              <div class="flex between wrap">
                <div style="flex:1;min-width:280px">
                  <div class="flex wrap mb2">
                    <span class="badge accent">Paper #${sub.id}</span>
                    ${rev ? UI.reviewStateBadge(rev.state) : `<span class="badge outline">Not started</span>`}
                    ${UI.topicChips(sub.topics)}
                  </div>
                  <h3>${UI.esc(sub.title)}</h3>
                  <div class="meta-line">👥 ${UI.esc(sub.authors.map((a) => a.name).join(", "))}</div>
                  <div class="abstract-preview">${UI.esc(sub.abstract)}</div>
                </div>
                <div class="btn-row" style="flex-direction:column">
                  <button class="btn ${rev && rev.state === "submitted" ? "ghost" : "primary"}" data-review="${sub.id}">
                    ${rev ? (rev.state === "submitted" ? "View / update review" : "Continue review") : "Write review"}
                  </button>
                  <button class="btn ghost small" data-open="${sub.id}">Paper details</button>
                </div>
              </div>
            </div>`;
          }).join("")}`;
        wrap.querySelector("#go-bids").onclick = () => go("#/bids");
        wrap.querySelectorAll("[data-open]").forEach((b) => b.onclick = () => go(`#/submission/${b.dataset.open}`));
        wrap.querySelectorAll("[data-review]").forEach((b) => b.onclick = () => go(`#/review/${b.dataset.review}`));
      },
    };
  },

  reviewForm(sid) {
    return {
      title: `Review · Paper #${sid}`,
      subtitle: "Scores use the conference review scale",
      html: `<div id="rev-form"><div class="empty">Loading…</div></div>`,
      async init(root) {
        const wrap = root.querySelector("#rev-form");
        let data;
        try {
          data = await API.get(`/api/submissions/${sid}`);
        } catch (err) {
          wrap.innerHTML = `<div class="empty"><div class="big">🔒</div><h3>${UI.esc(err.message)}</h3></div>`;
          return;
        }
        const sub = data.submission;
        const s = data.settings;
        // fetch queue entry for my review
        const queueData = await API.get("/api/reviewer/queue");
        const entry = queueData.queue.find((q) => q.submission.id === sub.id);
        const rev = (entry && entry.my_review) || {};
        const scale = s.review_scale || {};
        const optList = (arr, sel, off = 1) =>
          `<option value="0">—</option>` + (arr || []).map((label, i) =>
            `<option value="${i + off}" ${Number(sel) === i + off ? "selected" : ""}>${i + off} · ${UI.esc(label)}</option>`).join("");

        wrap.innerHTML = `
          <div class="card">
            <div class="card-head"><h2>${UI.esc(sub.title)}</h2></div>
            <div class="card-body">
              <div class="flex wrap mb3">
                <span class="badge accent">Paper #${sub.id}</span>
                ${UI.topicChips(sub.topics)}
                ${UI.reviewStateBadge(rev.state || "draft")}
                ${UI.deadlineChip("Reviews due", s.review_deadline)}
              </div>
              <div class="muted" style="white-space:pre-wrap;max-height:150px;overflow:auto">${UI.esc(sub.abstract)}</div>
              <div class="mt2">
                ${sub.pdf_filename ? `<button class="btn ghost small" id="dl-pdf">⬇ Download PDF</button>` : ""}
                <button class="btn ghost small" id="open-sub">Full paper page</button>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><h3>Your review</h3>
              <div class="right muted small">${s.reviewing_open ? "" : "Reviewing is closed — chairs only"}</div>
            </div>
            <div class="card-body">
              <div class="form-row cols-3">
                <label class="field"><span class="lbl">Overall recommendation</span>
                  <select class="select" id="r-overall">${optList(scale.overall || ["Strong reject", "Reject", "Weak reject", "Borderline", "Weak accept", "Accept", "Strong accept"], rev.overall, 1)}</select>
                  <span class="hint">${UI.esc(UI.overallLabel(rev.overall))}</span>
                </label>
                <label class="field"><span class="lbl">Confidence</span>
                  <select class="select" id="r-confidence">${optList(scale.confidence || ["None", "Low", "Medium", "High", "Expert"], rev.confidence, 1)}</select>
                </label>
                <label class="field"><span class="lbl">Status</span>
                  <div style="padding-top:8px">${UI.reviewStateBadge(rev.state || "draft")}</div>
                </label>
              </div>
              <div class="form-row cols-3">
                <label class="field"><span class="lbl">Soundness (1–3)</span>
                  <select class="select" id="r-soundness">
                    ${[0, 1, 2, 3].map((i) => `<option value="${i}" ${Number(rev.soundness) === i ? "selected" : ""}>${i || "—"}</option>`).join("")}
                  </select></label>
                <label class="field"><span class="lbl">Presentation (1–3)</span>
                  <select class="select" id="r-presentation">
                    ${[0, 1, 2, 3].map((i) => `<option value="${i}" ${Number(rev.presentation) === i ? "selected" : ""}>${i || "—"}</option>`).join("")}
                  </select></label>
                <label class="field"><span class="lbl">Contribution (1–3)</span>
                  <select class="select" id="r-contribution">
                    ${[0, 1, 2, 3].map((i) => `<option value="${i}" ${Number(rev.contribution) === i ? "selected" : ""}>${i || "—"}</option>`).join("")}
                  </select></label>
              </div>
              <label class="field"><span class="lbl">Strengths *</span>
                <textarea class="textarea" id="r-strengths">${UI.esc(rev.strengths || "")}</textarea></label>
              <label class="field"><span class="lbl">Weaknesses *</span>
                <textarea class="textarea" id="r-weaknesses">${UI.esc(rev.weaknesses || "")}</textarea></label>
              <label class="field"><span class="lbl">Questions for the authors</span>
                <textarea class="textarea" id="r-questions">${UI.esc(rev.questions || "")}</textarea></label>
            </div>
            <div class="card-foot">
              <button class="btn ghost" id="r-draft">Save draft</button>
              <button class="btn primary" id="r-submit">Submit review</button>
              <div class="spacer"></div>
              <span class="muted small">Submitting requires an overall score and both strengths & weaknesses.</span>
            </div>
          </div>`;

        const collect = () => ({
          overall: Number(wrap.querySelector("#r-overall").value),
          confidence: Number(wrap.querySelector("#r-confidence").value),
          soundness: Number(wrap.querySelector("#r-soundness").value),
          presentation: Number(wrap.querySelector("#r-presentation").value),
          contribution: Number(wrap.querySelector("#r-contribution").value),
          strengths: wrap.querySelector("#r-strengths").value,
          weaknesses: wrap.querySelector("#r-weaknesses").value,
          questions: wrap.querySelector("#r-questions").value,
        });
        wrap.querySelector("#open-sub").onclick = () => go(`#/submission/${sid}`);
        const dl = wrap.querySelector("#dl-pdf");
        if (dl) dl.onclick = () => API.download(`/api/submissions/${sid}/pdf`, sub.pdf_filename);
        wrap.querySelector("#r-draft").onclick = async () => {
          try {
            await API.put(`/api/reviewer/reviews/${sid}`, { ...collect(), state: "draft" });
            UI.toast("Draft saved", "success");
            render();
          } catch (err) { UI.toast(err.message, "error"); }
        };
        wrap.querySelector("#r-submit").onclick = async () => {
          try {
            await API.put(`/api/reviewer/reviews/${sid}`, { ...collect(), state: "submitted" });
            UI.toast("Review submitted — thank you!", "success");
            go("#/reviews");
          } catch (err) { UI.toast(err.message, "error"); }
        };
      },
    };
  },

  bids() {
    return {
      title: "Bidding",
      subtitle: "Tell the chairs which papers you want to review",
      html: `<div id="bid-wrap"><div class="empty">Loading…</div></div>`,
      async init(root) {
        const wrap = root.querySelector("#bid-wrap");
        const [subsData, bidsData, queueData] = await Promise.all([
          API.get("/api/submissions"),
          API.get("/api/reviewer/bids"),
          API.get("/api/reviewer/queue"),
        ]);
        const s = subsData.settings;
        const bids = bidsData.bids;
        const assignedIds = new Set(queueData.queue.map((q) => q.submission.id));
        // papers visible to this reviewer: all active papers minus their conflicts
        const allData = await API.get("/api/reviewer/all-papers").catch(() => null);
        const papers = allData ? allData.papers : [];
        wrap.innerHTML = `
          <div class="flex between wrap mb3">
            <div class="flex wrap">
              ${UI.deadlineChip("Bidding", s.submission_deadline)}
              <span class="badge ${s.bidding_open ? "green" : "red"}">${s.bidding_open ? "Bidding open" : "Bidding closed"}</span>
            </div>
            <button class="btn primary" id="save-bids">Save my bids</button>
          </div>
          <div class="alert info">
            <b>How bidding works:</b> mark papers as <b>Want to review</b>, <b>Maybe</b>, <b>No</b>, or <b>Conflict</b>.
            The chairs use bids when auto-assigning. Marking <b>Conflict</b> removes you from that paper.
          </div>
          <div class="card"><div class="table-wrap">
            <table class="table">
              <thead><tr><th>#</th><th>Paper</th><th>Topics</th><th>Your bid</th><th>Assignment</th></tr></thead>
              <tbody>
                ${papers.map((p) => `
                  <tr>
                    <td class="num">${p.id}</td>
                    <td class="title-cell">
                      <a href="#/submission/${p.id}">${UI.esc(p.title)}</a>
                      <div class="muted small">${UI.esc(p.authors.map((a) => a.name).join(", "))}</div>
                    </td>
                    <td>${UI.topicChips(p.topics)}</td>
                    <td>
                      <div class="bib-toggle" data-bid="${p.id}">
                        <button data-score="2" class="${bids[p.id] === 2 ? "on" : ""}">Want</button>
                        <button data-score="1" class="${bids[p.id] === 1 ? "on" : ""}">Maybe</button>
                        <button data-score="0" class="${Number(bids[p.id]) === 0 || bids[p.id] === undefined ? "on" : ""}">No</button>
                        <button data-score="-1" class="${bids[p.id] === -1 ? "on" : ""}" style="color:var(--red)">Conflict</button>
                      </div>
                    </td>
                    <td>${assignedIds.has(p.id) ? `<span class="badge blue">Assigned</span>` : `<span class="badge outline">—</span>`}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div></div>
          ${!papers.length ? `<div class="empty"><div class="big">🏷</div><h3>No papers available for bidding</h3>
            <p>Papers appear here once submitted. If you are an author, your own papers are hidden to avoid conflicts.</p></div>` : ""}`;
        wrap.querySelectorAll("[data-bid] .bib-toggle button, .bib-toggle button").forEach((btn) => {
          btn.onclick = () => {
            const group = btn.closest("[data-bid]");
            group.querySelectorAll("button").forEach((b) => b.classList.remove("on"));
            btn.classList.add("on");
          };
        });
        wrap.querySelector("#save-bids").onclick = async () => {
          const out = {};
          wrap.querySelectorAll("[data-bid]").forEach((group) => {
            const on = group.querySelector("button.on");
            if (on) out[group.dataset.bid] = Number(on.dataset.score);
          });
          try {
            await API.put("/api/reviewer/bids", { bids: out });
            UI.toast("Bids saved", "success");
          } catch (err) { UI.toast(err.message, "error"); }
        };
      },
    };
  },
};

Object.assign(window.Views, {
  reviewerQueue: ReviewerViews.queue,
  reviewForm: ReviewerViews.reviewForm,
  reviewerBids: ReviewerViews.bids,
});
