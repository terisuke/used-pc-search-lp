/* 中古PCサーチ — クライアントサイド描画・ソート・フィルタ (依存なし) */
(() => {
  "use strict";

  const RANK_ORDER = { S: 0, A: 1, B: 2, C: 3, D: 4 };
  const STATUS_LABEL = {
    verified: "✅ 確認済み",
    partial: "⚠️ 一部不一致",
    mismatch: "❌ 条件外/不一致",
    missing: "❌ リンク切れ",
    unchecked: "― 未照合",
  };
  const STATUS_RANK = { verified: 0, partial: 1, unchecked: 2, mismatch: 3, missing: 4 };
  const SORT_LABEL = {
    price_yen: "価格", gpu: "GPU", ram_gb: "メモリ", rank: "ランク",
    updated_at: "更新", status: "ステータス", shop: "店舗",
  };

  const state = {
    items: [],
    loaded: false,
    sortKey: "price_yen",
    sortDir: "asc",
    selectedId: null,
    detailTrigger: null,
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    generatedAt: $("generated-at"),
    itemsBody: $("items-body"),
    status: $("result-status"),
    filterForm: $("filter-form"),
    detailPanel: $("detail-panel"),
    detailList: $("detail-list"),
    detailClose: $("detail-close"),
    rtForm: $("rt-form"),
    rtSubmit: $("rt-submit"),
  };

  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  /* 外部URLは http/https のみ許可(それ以外はリンク無効化) */
  const safeUrl = (raw) => {
    try {
      const u = new URL(String(raw), location.href);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : "#";
    } catch {
      return "#";
    }
  };

  const fmtYen = (n) =>
    Number.isFinite(n) ? `${Math.round(n).toLocaleString("ja-JP")}円` : "—";

  const fmtDate = (iso) => {
    if (!iso) return "—";
    const s = String(iso);
    if (!s.includes("T")) return s; // 日付のみは時間を捏造しない
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(
      d.getDate(),
    ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes(),
    ).padStart(2, "0")}`;
  };

  function statusOf(item) {
    const fc = item.factcheck || {};
    if (fc.http_status === 404) return "missing";
    if (fc.verdict === "verified") return "verified";
    if (fc.verdict === "partial") return "partial";
    if (fc.verdict === "mismatch") return "mismatch";
    return "unchecked";
  }

  const BADGE_LABEL = {
    new: ["NEW", "badge-new"],
    price_down: ["値下げ", "badge-price-down"],
    sold_out: ["在庫切れ", "badge-sold-out"],
  };

  /* --- フィルタ --- */
  function rankOk(item, min) {
    if (!min) return true;
    const r = RANK_ORDER[item.rank];
    if (r === undefined) return true; // ランク不明(マーケットプレイス等)は除外しない
    return r <= RANK_ORDER[min];
  }

  function gpuOk(item, cond) {
    if (!cond) return true;
    const name = `${item.gpu || ""} ${item.title || ""}`.toLowerCase().replace(/[\s\u00a0\-]/g, "");
    const vram = item.gpu_vram_gb || null;
    const is3060 =
      name.includes("rtx3060") &&
      !name.includes("3060ti") &&
      !name.includes("30608gb") &&
      !name.includes("30606gb") &&
      (vram == null || vram >= 12);
    if (cond === "rtx3060-12") return is3060;
    if (cond === "vram12") return vram != null ? vram >= 12 : is3060 || /1[2-9]gb|2\dgb/.test(name);
    if (cond === "vram16") return vram != null ? vram >= 16 : /1[6-9]gb|2\dgb/.test(name);
    return true;
  }

  function applyFilters(items) {
    const fd = new FormData(els.filterForm);
    const gpu = fd.get("f-gpu") || "";
    const price = Number(fd.get("f-price")) || 0;
    const ram = Number(fd.get("f-ram")) || 0;
    const rank = fd.get("f-rank") || "";
    const kw = (fd.get("f-keyword") || "").trim().toLowerCase();
    return items.filter((it) => {
      if (!gpuOk(it, gpu)) return false;
      if (price && !(it.price_yen <= price)) return false;
      if (ram && !((it.ram_gb || 0) >= ram)) return false;
      if (!rankOk(it, rank)) return false;
      if (kw) {
        const hay = [it.title, it.shop, it.cpu, it.gpu, it.storage]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }

  /* --- ソート --- */
  function cmp(a, b) {
    const k = state.sortKey;
    const nullsLast = (x, y) => (x == null) - (y == null);
    let d = 0;
    if (k === "price_yen" || k === "ram_gb") {
      d = nullsLast(a[k], b[k]) || (a[k] ?? 0) - (b[k] ?? 0);
    } else if (k === "rank") {
      d = nullsLast(a.rank, b.rank) || (RANK_ORDER[a.rank] ?? 9) - (RANK_ORDER[b.rank] ?? 9);
    } else if (k === "updated_at") {
      d = nullsLast(a[k], b[k]) || String(a[k]).localeCompare(String(b[k]));
    } else if (k === "status") {
      d = (STATUS_RANK[statusOf(a)] ?? 9) - (STATUS_RANK[statusOf(b)] ?? 9);
    } else if (k === "shop") {
      d = nullsLast(a.shop, b.shop) || String(a.shop ?? "").localeCompare(String(b.shop ?? ""), "ja");
    } else {
      d = nullsLast(a[k], b[k]) || String(a[k] ?? "").localeCompare(String(b[k] ?? ""), "ja");
    }
    return state.sortDir === "asc" ? d : -d;
  }

  function updateAriaSort(active = true) {
    for (const btn of document.querySelectorAll(".sort-btn")) {
      const th = btn.closest("th");
      const arrow = btn.querySelector(".arrow");
      if (!active) {
        th.setAttribute("aria-sort", "none");
        if (arrow) arrow.textContent = "";
        continue;
      }
      if (btn.dataset.key === state.sortKey) {
        th.setAttribute("aria-sort", state.sortDir === "asc" ? "ascending" : "descending");
        if (arrow) arrow.textContent = state.sortDir === "asc" ? "▲" : "▼";
      } else {
        th.setAttribute("aria-sort", "none");
        if (arrow) arrow.textContent = "";
      }
    }
  }

  /* --- 描画 --- */
  function rowHtml(it) {
    const st = statusOf(it);
    const badge = it.history && it.history.badge ? BADGE_LABEL[it.history.badge] : null;
    const badgeHtml = badge
      ? ` <span class="badge ${badge[1]}">${badge[0]}</span>`
      : "";
    const fc = it.factcheck || {};
    const issues = (fc.issues || []).map((s) => esc(s)).join("・");
    const title = esc(it.title || "(商品名不明)");
    const href = esc(safeUrl(it.url || "#"));
    return `<tr class="${st === "missing" ? "row-sold-out" : ""}" data-id="${esc(it.id)}">
      <td>${STATUS_LABEL[st]}</td>
      <td>${fmtYen(it.price_yen)}</td>
      <td>${esc(it.gpu || "—")}${it.gpu_vram_gb ? ` <small>(${esc(it.gpu_vram_gb)}GB)</small>` : ""}</td>
      <td>${it.ram_gb ? `${esc(it.ram_gb)}GB` : "—"}</td>
      <td>${esc(it.rank || "—")}</td>
      <td><time datetime="${esc(it.updated_at || "")}">${fmtDate(it.updated_at)}</time></td>
      <td class="cell-item">
        <a href="${href}" target="_blank" rel="noopener noreferrer">${title}</a>${badgeHtml}<br>
        <small>${esc(it.shop || "")}</small>
        <button type="button" class="outline secondary detail-btn min-target" data-id="${esc(
          it.id,
        )}" aria-expanded="false">詳細</button>
        ${issues ? `<br><small>${issues}</small>` : ""}
      </td>
    </tr>`;
  }

  function render() {
    if (!state.loaded) return;
    const shown = applyFilters(state.items).sort(cmp);
    els.itemsBody.innerHTML = shown.length
      ? shown.map(rowHtml).join("")
      : '<tr><td colspan="7">条件に合う候補がありません。条件を緩めるか「リセット」を押してください。</td></tr>';
    const sortText = `並び替え: ${SORT_LABEL[state.sortKey] || state.sortKey} ${state.sortDir === "asc" ? "昇順" : "降順"}`;
    els.status.textContent = shown.length === state.items.length
      ? `全 ${state.items.length} 件を表示中（${sortText}）— 条件で絞り込めます`
      : `${shown.length} / ${state.items.length} 件を表示中（フィルタ適用中・${sortText}）`;
    updateAriaSort();
    /* 再描画後に詳細パネルと行状態を整合させる */
    if (state.selectedId && !shown.some((it) => it.id === state.selectedId)) {
      closeDetail(false);
    } else if (state.selectedId) {
      for (const btn of document.querySelectorAll(".detail-btn")) {
        btn.setAttribute("aria-expanded", btn.dataset.id === state.selectedId ? "true" : "false");
      }
    }
  }

  /* --- 詳細パネル --- */
  function showDetail(id, triggerBtn) {
    const it = state.items.find((x) => x.id === id);
    if (!it) return;
    state.detailTrigger = triggerBtn || state.detailTrigger;
    const st = statusOf(it);
    const fc = it.factcheck || {};
    const h = it.history || {};
    const href = esc(safeUrl(it.url || "#"));
    const rows = [
      ["ショップ", esc(it.shop || "—")],
      ["商品名", esc(it.title || "—")],
      ["価格", fmtYen(it.price_yen)],
      ["CPU", esc(it.cpu || "—")],
      ["GPU", esc(it.gpu ? `${it.gpu}${it.gpu_vram_gb ? ` (${it.gpu_vram_gb}GB)` : ""}` : "—")],
      ["メモリ", it.ram_gb ? `${esc(it.ram_gb)}GB` : "—"],
      ["ストレージ", esc(it.storage || "—")],
      ["ランク", esc(it.rank || "—")],
      ["ステータス", STATUS_LABEL[st]],
      ["照合メモ", esc((fc.issues || []).join("／") || "—")],
      ["HTTP確認", esc(fc.http_status ? String(fc.http_status) : "—")],
      ["ページ上の価格", fc.page_price_yen != null ? fmtYen(fc.page_price_yen) : "—"],
      ["最終照合", esc(fmtDate(fc.checked_at))],
      ["初出 / 最終確認", esc(`${fmtDate(h.first_seen)} / ${fmtDate(h.last_seen)}`)],
      ["前回価格", h.prev_price_yen ? fmtYen(h.prev_price_yen) : "—"],
    ];
    els.detailList.innerHTML =
      rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("") +
      (it.url
        ? `<dt>商品ページ</dt><dd><a href="${href}" target="_blank" rel="noopener noreferrer">開く（新しいタブ）</a></dd>`
        : "<dt>商品ページ</dt><dd>—</dd>");
    els.detailPanel.hidden = false;
    state.selectedId = id;
    for (const btn of document.querySelectorAll(".detail-btn")) {
      btn.setAttribute("aria-expanded", btn.dataset.id === id ? "true" : "false");
    }
    $("detail-heading").focus();
  }

  function closeDetail(returnFocus = true) {
    els.detailPanel.hidden = true;
    state.selectedId = null;
    for (const btn of document.querySelectorAll(".detail-btn")) {
      btn.setAttribute("aria-expanded", "false");
    }
    if (returnFocus && state.detailTrigger && document.contains(state.detailTrigger)) {
      state.detailTrigger.focus();
    }
    state.detailTrigger = null;
  }

  /* --- イベント --- */
  els.filterForm.addEventListener("submit", (e) => {
    e.preventDefault();
    render();
  });
  els.filterForm.addEventListener("reset", () => setTimeout(render, 0));
  els.itemsBody.addEventListener("click", (e) => {
    const btn = e.target.closest(".detail-btn");
    if (!btn) return;
    if (state.selectedId === btn.dataset.id) {
      closeDetail();
    } else {
      showDetail(btn.dataset.id, btn);
    }
  });
  els.detailClose.addEventListener("click", () => closeDetail());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.detailPanel.hidden) {
      closeDetail();
    }
  });
  for (const btn of document.querySelectorAll(".sort-btn")) {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = key === "updated_at" ? "desc" : "asc";
      }
      render();
    });
  }

  /* --- リアルタイム検索 (Worker構成で有効化) --- */
  let WORKER_URL = null;
  const autoItems = () => state.autoItems || state.items;

  function setRtReady(ready) {
    els.rtSubmit.disabled = !ready;
    if (ready) {
      els.rtSubmit.removeAttribute("aria-disabled");
      $("rt-note").textContent = "条件を指定して検索すると、最新の候補をリアルタイムに取得します(30秒程度かかることがあります)。";
    }
  }

  async function loadWorkerConfig() {
    try {
      const res = await fetch("data/worker-config.json", { cache: "no-store" });
      if (!res.ok) return;
      const cfg = await res.json();
      if (cfg && typeof cfg.worker_url === "string" && /^https:\/\//.test(cfg.worker_url)) {
        WORKER_URL = cfg.worker_url;
        setRtReady(true);
      }
    } catch {
      /* 構成ファイル無し — 準備中のまま */
    }
  }

  async function doRealtimeSearch() {
    const progress = $("rt-progress");
    const errorBox = $("rt-error");
    errorBox.hidden = true;
    progress.hidden = false;
    const fd = new FormData(els.rtForm);
    progress.textContent = "検索中…(一次検索に最大30秒程度)";
    els.rtSubmit.disabled = true;
    try {
      const res = await fetch(`${WORKER_URL}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gpu: fd.get("rt-gpu") || "",
          price: Number(fd.get("rt-price")) || null,
          free: fd.get("rt-free") || "",
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.autoItems = state.autoItems || state.items;
      state.items = (data.items || []).map((it) => ({
        ...it,
        updated_at: data.generated_at || new Date().toISOString(),
        history: it.history || { first_seen: null, last_seen: null, prev_price_yen: null, badge: null },
      }));
      $("rt-restore").hidden = false;
      els.generatedAt.textContent = `リアルタイム(${fmtDate(data.generated_at)})`;
      render();
      progress.textContent = `リアルタイム検索完了: ${state.items.length} 件。上位行から順にスペック照合中…`;
      lazyVerifyTop(5, progress);
    } catch (err) {
      errorBox.hidden = false;
      errorBox.textContent = `リアルタイム検索に失敗しました: ${err.message}。少し待って再試行してください。`;
      progress.hidden = true;
    } finally {
      if (WORKER_URL) els.rtSubmit.disabled = false;
    }
  }

  /* リアルタイム結果の上位数行を裏で照合し、価格・ステータスを補完(要件4.6の非同期ファクトチェック) */
  async function lazyVerifyTop(n, progressEl) {
    const targets = state.items
      .filter((it) => it.factcheck && it.factcheck.http_status === 200 && it.url)
      .slice(0, n);
    let done = 0;
    for (const it of targets) {
      try {
        const res = await fetch(`${WORKER_URL}/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: it.url }),
          signal: AbortSignal.timeout(90_000),
        });
        if (res.ok) {
          const out = await res.json();
          if (out.factcheck) it.factcheck = { ...it.factcheck, ...out.factcheck };
          if (out.specs) Object.assign(it, pickDefined(out.specs));
          if (it.price_yen == null && out.factcheck?.page_price_yen != null) {
            it.price_yen = out.factcheck.page_price_yen;
            it.factcheck.price_filled_from_page = true;
          }
        }
      } catch {
        /* 個別照合の失敗は無視(次サイクルで補完) */
      }
      done++;
      if (progressEl) progressEl.textContent = `リアルタイム検索完了: ${state.items.length} 件。照合 ${done}/${targets.length}…`;
      render();
    }
    if (progressEl) progressEl.textContent = `リアルタイム検索完了: ${state.items.length} 件(照合 ${done} 件)。「定期データに戻す」で復帰できます。`;
  }

  const pickDefined = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v != null));

  function restoreAuto() {
    if (!state.autoItems) return;
    state.items = state.autoItems;
    state.autoItems = null;
    $("rt-restore").hidden = true;
    $("rt-progress").hidden = true;
    init(); // 定期データを再取得
  }

  $("rt-restore").addEventListener("click", restoreAuto);

  els.rtForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (WORKER_URL) doRealtimeSearch();
  });
  setRtReady(false);

  /* --- ターゲットスペックボックス --- */
  async function loadSpecBox() {
    const box = $("spec-box");
    try {
      const res = await fetch("data/spec-review-latest.json", { cache: "no-store" });
      if (!res.ok) return;
      const spec = await res.json();
      if (!spec || !Array.isArray(spec.profiles) || !spec.profiles.length) return;
      const reviewed = typeof spec.reviewed_at === "string" && spec.reviewed_at.length <= 10
        ? spec.reviewed_at
        : fmtDate(spec.reviewed_at);
      $("spec-reviewed-at").textContent = `最終見直し ${reviewed}`;
      $("spec-profiles").innerHTML = spec.profiles.map((p) => `
        <div class="spec-card">
          <h3>${esc(p.label)}</h3>
          <dl>
            <dt>VRAM</dt><dd>最小${esc(p.min_vram_gb)}GB / 推奨${esc(p.preferred_vram_gb)}GB</dd>
            <dt>RAM</dt><dd>最小${esc(p.min_ram_gb)}GB</dd>
            <dt>CPU</dt><dd>${esc(p.min_cpu_cores)}コア以上</dd>
            <dt>想定</dt><dd>${esc(p.target_models)}</dd>
          </dl>
        </div>`).join("");
      box.hidden = false;
    } catch {
      /* specボックスは任意 — 失敗時は非表示のまま */
    }
  }

  /* --- 初期化 --- */
  async function init() {
    try {
      const res = await fetch("data/latest.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.items = Array.isArray(data.items) ? data.items : [];
      state.loaded = true;
      if (data.generated_at) {
        els.generatedAt.textContent = fmtDate(data.generated_at);
        els.generatedAt.setAttribute("datetime", data.generated_at);
      } else {
        els.generatedAt.textContent = "不明";
      }
      render();
    } catch (err) {
      state.loaded = true;
      els.status.textContent = "データの読み込みに失敗しました。ページを再読み込みしてください。";
      els.generatedAt.textContent = "不明";
      els.itemsBody.innerHTML = '<tr><td colspan="7">データ取得エラー</td></tr>';
      updateAriaSort(false);
      console.error(err);
    }
  }

  loadSpecBox();
  loadWorkerConfig();
  init();
})();
