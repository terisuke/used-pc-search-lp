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

  const state = {
    items: [],
    sortKey: "price_yen",
    sortDir: "asc",
    selectedId: null,
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

  const fmtYen = (n) =>
    Number.isFinite(n) ? `${Math.round(n).toLocaleString("ja-JP")}円` : "—";

  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
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
    const is3060 = name.includes("rtx3060") && !name.includes("3060ti");
    if (cond === "rtx3060-12") return is3060; // RTX 3060 desktop は常に12GB
    if (cond === "vram12") return vram != null ? vram >= 12 : is3060;
    if (cond === "vram16") return vram != null ? vram >= 16 : false;
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
    } else {
      d = String(a[k] ?? "").localeCompare(String(b[k] ?? ""), "ja");
    }
    return state.sortDir === "asc" ? d : -d;
  }

  function updateAriaSort() {
    for (const btn of document.querySelectorAll(".sort-btn")) {
      const th = btn.closest("th");
      if (btn.dataset.key === state.sortKey) {
        th.setAttribute("aria-sort", state.sortDir === "asc" ? "ascending" : "descending");
        btn.querySelector(".arrow")?.remove();
        btn.insertAdjacentHTML(
          "beforeend",
          state.sortDir === "asc"
            ? ' <span class="arrow" aria-hidden="true">▲</span>'
            : ' <span class="arrow" aria-hidden="true">▼</span>',
        );
      } else {
        th.setAttribute("aria-sort", "none");
        btn.querySelector(".arrow")?.remove();
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
    return `<tr class="${st === "missing" ? "row-sold-out" : ""}" data-id="${esc(it.id)}">
      <td>${STATUS_LABEL[st]}</td>
      <td>${fmtYen(it.price_yen)}</td>
      <td>${esc(it.gpu || "—")}${it.gpu_vram_gb ? ` <small>(${esc(it.gpu_vram_gb)}GB)</small>` : ""}</td>
      <td>${it.ram_gb ? `${esc(it.ram_gb)}GB` : "—"}</td>
      <td>${esc(it.rank || "—")}</td>
      <td><time datetime="${esc(it.updated_at || "")}">${fmtDate(it.updated_at)}</time></td>
      <td class="cell-item">
        <a href="${esc(it.url || "#")}" target="_blank" rel="noopener">${title}</a>${badgeHtml}<br>
        <small>${esc(it.shop || "")}</small>
        <button type="button" class="outline secondary detail-btn min-target" data-id="${esc(
          it.id,
        )}" aria-expanded="false">詳細</button>
        ${issues ? `<br><small>${issues}</small>` : ""}
      </td>
    </tr>`;
  }

  function render() {
    const shown = applyFilters(state.items).sort(cmp);
    els.itemsBody.innerHTML = shown.length
      ? shown.map(rowHtml).join("")
      : '<tr><td colspan="7">条件に合う候補がありません。条件を緩めてください。</td></tr>';
    els.status.textContent = `自動取得データから ${shown.length} / ${state.items.length} 件を表示中（並び替え: ${
      state.sortKey === "price_yen" ? "価格" : state.sortKey
    } ${state.sortDir === "asc" ? "昇順" : "降順"}）`;
    updateAriaSort();
  }

  /* --- 詳細パネル --- */
  function showDetail(id) {
    const it = state.items.find((x) => x.id === id);
    if (!it) return;
    const st = statusOf(it);
    const fc = it.factcheck || {};
    const h = it.history || {};
    const rows = [
      ["ショップ", it.shop || "—"],
      ["商品名", it.title || "—"],
      ["価格", fmtYen(it.price_yen)],
      ["CPU", it.cpu || "—"],
      ["GPU", it.gpu ? `${it.gpu}${it.gpu_vram_gb ? ` (${it.gpu_vram_gb}GB)` : ""}` : "—"],
      ["メモリ", it.ram_gb ? `${it.ram_gb}GB` : "—"],
      ["ストレージ", it.storage || "—"],
      ["ランク", it.rank || "—"],
      ["ステータス", STATUS_LABEL[st]],
      ["照合メモ", (fc.issues || []).join("／") || "—"],
      ["HTTP確認", fc.http_status ? String(fc.http_status) : "—"],
      ["最終照合", fmtDate(fc.checked_at)],
      ["初出 / 最終確認", `${fmtDate(h.first_seen)} / ${fmtDate(h.last_seen)}`],
      ["前回価格", h.prev_price_yen ? fmtYen(h.prev_price_yen) : "—"],
      ["商品ページ", it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">開く（新しいタブ）</a>` : "—"],
    ];
    els.detailList.innerHTML = rows
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
      .join("");
    els.detailPanel.hidden = false;
    state.selectedId = id;
    for (const btn of document.querySelectorAll(".detail-btn")) {
      btn.setAttribute("aria-expanded", btn.dataset.id === id ? "true" : "false");
    }
    $("detail-heading").focus();
  }

  function closeDetail() {
    els.detailPanel.hidden = true;
    state.selectedId = null;
    for (const btn of document.querySelectorAll(".detail-btn")) {
      btn.setAttribute("aria-expanded", "false");
    }
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
      showDetail(btn.dataset.id);
    }
  });
  els.detailClose.addEventListener("click", closeDetail);
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

  /* --- リアルタイム検索 (Phase 3 で有効化) --- */
  const WORKER_URL = null; // Phase 3 で差し込み
  if (!WORKER_URL) {
    els.rtSubmit.setAttribute("aria-disabled", "true");
  } else {
    els.rtSubmit.removeAttribute("aria-disabled");
  }

  /* --- 初期化 --- */
  async function init() {
    try {
      const res = await fetch("data/latest.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.items = Array.isArray(data.items) ? data.items : [];
      if (data.generated_at) {
        els.generatedAt.textContent = fmtDate(data.generated_at);
        els.generatedAt.setAttribute("datetime", data.generated_at);
      } else {
        els.generatedAt.textContent = "不明";
      }
      render();
    } catch (err) {
      els.status.textContent = "データの読み込みに失敗しました。ページを再読み込みしてください。";
      els.itemsBody.innerHTML =
        '<tr><td colspan="7">データ取得エラー</td></tr>';
      console.error(err);
    }
  }

  init();
})();
