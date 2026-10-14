"use strict";
(async () => {
  await window.SiteAccount.ready;
  const $ = (id) => document.getElementById(id);
  const api = window.SiteAccount.api;
  const root = $("library");
  if (!window.SiteAccount.isDisk) {
    $("library-startup").hidden = false;
    $("library-layout").hidden = true;
    $("library-import").disabled = true;
    return;
  }
  let papers = [];
  let selected = null;
  let pdf = null;
  let loading = null;
  let pdfjs = null;
  let pageNumber = 1;
  let rotation = 0;
  let renderTask = null;
  let textLayer = null;
  let renderQueue = Promise.resolve();
  let progressQueue = Promise.resolve();
  let sequence = 0;
  let renderSequence = 0;
  let dirty = false;
  let importing = false;
  let saving = false;
  let switchDecision = null;
  let passwordCallback = null;
  let loadError = false;
  let lastSelected = "";
  try { lastSelected = localStorage.getItem("little-corner.library.selected.v1") || ""; } catch {}
  const current = () => papers.find((paper) => paper.id === selected);
  const formatSize = (bytes) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  function message(text, error = false) {
    $("library-status").textContent = text;
    $("library-status").hidden = !text;
    $("library-status").setAttribute("role", error ? "alert" : "status");
  }
  function element(tag, className, text = "") {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }
  function replacePaper(paper) {
    const index = papers.findIndex((entry) => entry.id === paper.id);
    if (index < 0) papers.unshift(paper);
    else papers[index] = paper;
  }
  function renderShelf() {
    const active = papers.filter((paper) => !paper.deletedAt);
    $("library-stats").textContent = `${active.length} 篇文献 · ${active.filter((paper) => paper.starred).length} 篇收藏`;
    const filter = $("library-filter").value;
    const search = $("library-search").value.trim().toLocaleLowerCase();
    const list = papers.filter((paper) => (filter === "trash" ? paper.deletedAt : !paper.deletedAt) && (filter !== "starred" || paper.starred) && (!search || [paper.title, paper.filename, paper.authors, paper.year, ...paper.tags].join(" ").toLocaleLowerCase().includes(search)));
    const fragment = document.createDocumentFragment();
    for (const paper of list) {
      const wrapper = document.createElement("div");
      const card = element("button", "paper-card");
      card.type = "button";
      card.setAttribute("aria-current", String(paper.id === selected));
      const top = element("span", "paper-card-top");
      top.append(element("span", "", "PDF / 文献"), element("span", "", paper.starred ? "★" : "↗"));
      card.append(top, element("span", "paper-card-title", paper.title));
      if (paper.authors || paper.year) card.append(element("span", "paper-card-author", [paper.authors, paper.year].filter(Boolean).join(" · ")));
      if (paper.tags.length) {
        const tags = element("span", "paper-card-tags");
        paper.tags.slice(0, 4).forEach((tag) => tags.append(element("span", "paper-card-tag", tag)));
        card.append(tags);
      }
      const bottom = element("span", "paper-card-bottom");
      bottom.append(element("span", "", paper.deletedAt ? "已移到回收站" : paper.pages ? `读至 ${paper.currentPage} / ${paper.pages} 页` : "待阅读"), element("span", "", formatSize(paper.size)));
      card.append(bottom);
      card.addEventListener("click", () => { if (paper.deletedAt) message("请先恢复这份文献，再打开阅读。"); else openPaper(paper.id); });
      wrapper.append(card);
      if (paper.deletedAt) {
        const restore = element("button", "paper-restore", "恢复到文献库");
        restore.type = "button";
        restore.addEventListener("click", async () => {
          restore.disabled = true;
          try { replacePaper((await api(`/api/library/${paper.id}`, { method: "PATCH", body: JSON.stringify({ revision: paper.revision, trashed: false }) })).paper); renderShelf(); message("文献已恢复，原 PDF 和笔记都还在。"); }
          catch (error) { message(error.message, true); }
          finally { restore.disabled = false; }
        });
        wrapper.append(restore);
      }
      fragment.append(wrapper);
    }
    if (!list.length) fragment.append(element("p", "library-no-results", search ? "没有找到匹配的文献。" : filter === "trash" ? "回收站还是空的。" : filter === "starred" ? "阅读时点亮星标，就能在这里找到。" : "书架还是空的，导入一份 PDF 吧。"));
    $("library-list").replaceChildren(fragment);
  }
  function populate(paper) {
    $("paper-title").textContent = paper.title;
    $("paper-info").textContent = [paper.authors, paper.year, ...paper.tags].filter(Boolean).join(" · ") || paper.filename;
    $("paper-file-info").textContent = `${formatSize(paper.size)} · 原 PDF 保留`;
    $("paper-star").textContent = paper.starred ? "★" : "☆";
    $("paper-star").setAttribute("aria-pressed", String(paper.starred));
    $("paper-star").setAttribute("aria-label", paper.starred ? "取消收藏" : "收藏文献");
    $("pdf-download").href = `/api/library/${paper.id}/file`;
    $("pdf-download").download = paper.filename;
    $("paper-title-input").value = paper.title;
    $("paper-authors").value = paper.authors;
    $("paper-year").value = paper.year;
    $("paper-tags").value = paper.tags.join("，");
    $("paper-notes").value = paper.notes;
    $("paper-note-hint").textContent = "笔记保存在这台电脑，不会修改原 PDF。";
    dirty = false;
  }
  function allowSwitch() {
    if (saving) { message("正在保存，请完成后再切换文献。"); return Promise.resolve(false); }
    if (!dirty) return Promise.resolve(true);
    if (switchDecision) return Promise.resolve(false);
    $("paper-discard-dialog").showModal();
    return new Promise((resolve) => { switchDecision = resolve; });
  }
  function finishDecision(value) {
    const resolve = switchDecision;
    switchDecision = null;
    $("paper-discard-dialog").close();
    resolve?.(value);
  }
  $("paper-discard").addEventListener("click", () => finishDecision(true));
  $("paper-keep").addEventListener("click", () => finishDecision(false));
  $("paper-discard-dialog").addEventListener("close", () => { const resolve = switchDecision; switchDecision = null; resolve?.(false); });
  async function library() {
    if (!pdfjs) {
      pdfjs = await import("./vendor/pdfjs/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
    }
    return pdfjs;
  }
  function readerStatus(text) { $("pdf-status").textContent = text; $("pdf-status").hidden = false; }
  function updatePages() {
    $("pdf-page").value = pageNumber;
    $("pdf-page").max = pdf?.numPages || 1;
    $("pdf-total").textContent = `/ ${pdf?.numPages || "—"}`;
    $("pdf-prev").disabled = !pdf || pageNumber <= 1;
    $("pdf-next").disabled = !pdf || pageNumber >= pdf.numPages;
    $("pdf-page").disabled = !pdf;
  }
  function saveProgress(id, page, pages) {
    progressQueue = progressQueue.catch(() => {}).then(async () => {
      try {
        const saved = (await api(`/api/library/${id}/progress`, { method: "PUT", keepalive: true, body: JSON.stringify({ page, pages }) })).paper;
        const item = papers.find((paper) => paper.id === id);
        if (item) { item.pages = saved.pages; item.currentPage = saved.currentPage; }
        renderShelf();
        if (id === selected) $("pdf-progress").textContent = `已记住：第 ${page} / ${pages} 页`;
      } catch (error) { if (id === selected) $("pdf-progress").textContent = `阅读位置未保存：${error.message}`; }
    });
  }
  function renderPage(number = pageNumber, resetScroll = true) {
    if (!pdf) return Promise.resolve();
    pageNumber = Math.max(1, Math.min(pdf.numPages, Number(number) || 1));
    updatePages();
    const thisRender = ++renderSequence;
    const thisFile = sequence;
    const document = pdf;
    renderTask?.cancel();
    textLayer?.cancel();
    renderQueue = renderQueue.catch(() => {}).then(async () => {
      if (thisRender !== renderSequence || thisFile !== sequence) return;
      readerStatus("正在绘制页面…");
      const page = await document.getPage(pageNumber);
      if (thisRender !== renderSequence || thisFile !== sequence) return;
      const baseline = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
      const available = Math.max(100, $("pdf-viewport").clientWidth - (innerWidth <= 480 ? 32 : 48));
      const scale = $("pdf-zoom").value === "fit" ? available / baseline.width : Number($("pdf-zoom").value);
      const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
      const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(16000000 / (viewport.width * viewport.height)));
      const canvas = $("pdf-canvas");
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      $("pdf-page-wrap").style.width = `${viewport.width}px`;
      $("pdf-page-wrap").style.height = `${viewport.height}px`;
      $("pdf-page-wrap").style.setProperty("--total-scale-factor", scale * (page.userUnit || 1));
      $("pdf-text-layer").replaceChildren();
      $("pdf-page-wrap").hidden = false;
      renderTask = page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
      renderTask = null;
      if (thisRender !== renderSequence || thisFile !== sequence) return;
      textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: $("pdf-text-layer"), viewport });
      try { await textLayer.render(); } catch (error) { if (error.name !== "AbortException") console.warn("这页的文字层暂时无法显示。", error.name); }
      if (thisRender !== renderSequence || thisFile !== sequence) return;
      $("pdf-status").hidden = true;
      if (resetScroll) { $("pdf-viewport").scrollTop = 0; $("pdf-viewport").scrollLeft = 0; }
      saveProgress(selected, pageNumber, document.numPages);
    }).catch((error) => { if (!["RenderingCancelledException", "AbortException"].includes(error.name) && thisFile === sequence) readerStatus("这一页暂时无法显示。可以重新打开文献，或下载原文件检查。"); });
    return renderQueue;
  }
  async function openPaper(id) {
    if (id === selected && pdf) { $("library-reader").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    if (!(await allowSwitch())) return;
    const paper = papers.find((entry) => entry.id === id && !entry.deletedAt);
    if (!paper) return;
    const thisFile = ++sequence;
    ++renderSequence;
    renderTask?.cancel();
    textLayer?.cancel();
    const previous = loading;
    loading = null;
    pdf = null;
    selected = id;
    lastSelected = id;
    rotation = 0;
    populate(paper);
    renderShelf();
    $("library-empty").hidden = true;
    $("library-reader").hidden = false;
    $("pdf-page-wrap").hidden = true;
    updatePages();
    readerStatus("正在打开 PDF…");
    try { localStorage.setItem("little-corner.library.selected.v1", id); } catch {}
    if (innerWidth <= 760 && location.hash === "#library") $("library-reader").scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      await previous?.destroy();
      const lib = await library();
      if (thisFile !== sequence) return;
      loading = lib.getDocument({ url: `/api/library/${id}/file`, cMapUrl: "/vendor/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/vendor/pdfjs/standard_fonts/", wasmUrl: "/vendor/pdfjs/wasm/", isEvalSupported: false, enableXfa: false });
      loading.onPassword = (callback, reason) => {
        passwordCallback = callback;
        $("pdf-password-hint").textContent = reason === 2 ? "密码不正确，请再试一次。" : "密码仅用于本次阅读，不会保存到文献库。";
        $("pdf-password").value = "";
        if (!$("pdf-password-dialog").open) $("pdf-password-dialog").showModal();
        $("pdf-password").focus();
      };
      const loaded = await loading.promise;
      if (thisFile !== sequence) { await loaded.destroy(); return; }
      pdf = loaded;
      pageNumber = Math.min(paper.currentPage || 1, pdf.numPages);
      await renderPage(pageNumber);
    } catch (error) {
      if (thisFile === sequence) { $("pdf-page-wrap").hidden = true; readerStatus(error.name === "PasswordException" ? "尚未解锁这份 PDF。重新点击文献即可输入密码。" : "PDF 暂时无法打开。原文件仍在文献库中，可以下载检查，或用另一份有效的 PDF 重新导入。"); }
    }
  }
  $("pdf-password-form").addEventListener("submit", (event) => { event.preventDefault(); const password = $("pdf-password").value; $("pdf-password").value = ""; const callback = passwordCallback; passwordCallback = null; $("pdf-password-dialog").close(); callback?.(password); });
  function cancelPassword() { const callback = passwordCallback; passwordCallback = null; $("pdf-password").value = ""; $("pdf-password-dialog").close(); callback?.(new Error("阅读已取消")); }
  $("pdf-password-cancel").addEventListener("click", cancelPassword);
  $("pdf-password-dialog").addEventListener("cancel", (event) => { event.preventDefault(); cancelPassword(); });
  $("pdf-password-dialog").addEventListener("close", () => { if (passwordCallback) cancelPassword(); });
  $("pdf-prev").addEventListener("click", () => renderPage(pageNumber - 1));
  $("pdf-next").addEventListener("click", () => renderPage(pageNumber + 1));
  $("pdf-page").addEventListener("change", () => renderPage(Number($("pdf-page").value)));
  $("pdf-zoom").addEventListener("change", () => renderPage());
  $("pdf-rotate").addEventListener("click", () => { rotation = (rotation + 90) % 360; renderPage(); });
  function expand(value) {
    $("library-reader").classList.toggle("is-expanded", value);
    document.body.style.overflow = value ? "hidden" : "";
    $("pdf-fullscreen").setAttribute("aria-label", value ? "退出展开阅读" : "展开阅读器");
    requestAnimationFrame(() => renderPage(pageNumber, false));
  }
  $("pdf-fullscreen").addEventListener("click", () => expand(!$("library-reader").classList.contains("is-expanded")));
  window.addEventListener("keydown", (event) => {
    if (location.hash !== "#library" || document.querySelector("dialog[open]")) return;
    if (event.key === "Escape" && $("library-reader").classList.contains("is-expanded")) { expand(false); return; }
    if (!pdf || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || /INPUT|TEXTAREA|SELECT|BUTTON/.test(event.target.tagName) || !event.target.closest("#library-reader")) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); renderPage(pageNumber + (event.key === "ArrowRight" ? 1 : -1)); }
  });
  $("pdf-viewport").tabIndex = 0;
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (location.hash === "#library" && pdf) renderPage(pageNumber, false); }, 200); });
  $("paper-form").addEventListener("input", () => { dirty = true; $("paper-note-hint").textContent = "还有未保存的修改"; });
  $("paper-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    const paper = current();
    if (!paper) return;
    const save = $("paper-save");
    saving = true;
    const fields = [...$("paper-form").querySelectorAll("input,textarea")];
    save.disabled = true;
    fields.forEach((field) => { field.readOnly = true; });
    try {
      const body = { revision: paper.revision, title: $("paper-title-input").value, authors: $("paper-authors").value, year: $("paper-year").value, tags: $("paper-tags").value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean), notes: $("paper-notes").value };
      const saved = (await api(`/api/library/${paper.id}`, { method: "PATCH", body: JSON.stringify(body) })).paper;
      replacePaper(saved);
      populate(saved);
      renderShelf();
      $("paper-note-hint").textContent = "信息与笔记已保存到本地电脑。";
    } catch (error) { $("paper-note-hint").textContent = error.message; }
    finally { saving = false; save.disabled = false; fields.forEach((field) => { field.readOnly = false; }); }
  });
  $("paper-star").addEventListener("click", async () => {
    if (saving) return;
    const paper = current();
    if (!paper) return;
    saving = true;
    $("paper-star").disabled = true;
    try {
      const saved = (await api(`/api/library/${paper.id}`, { method: "PATCH", body: JSON.stringify({ revision: paper.revision, starred: !paper.starred }) })).paper;
      replacePaper(saved);
      $("paper-star").textContent = saved.starred ? "★" : "☆";
      $("paper-star").setAttribute("aria-pressed", String(saved.starred));
      $("paper-star").setAttribute("aria-label", saved.starred ? "取消收藏" : "收藏文献");
      renderShelf();
    } catch (error) { message(error.message, true); }
    finally { saving = false; $("paper-star").disabled = false; }
  });
  $("paper-trash").addEventListener("click", async () => {
    if (!(await allowSwitch())) return;
    const paper = current();
    if (!paper) return;
    saving = true;
    $("paper-trash").disabled = true;
    try {
      await progressQueue;
      replacePaper((await api(`/api/library/${paper.id}`, { method: "PATCH", body: JSON.stringify({ revision: paper.revision, trashed: true }) })).paper);
      ++sequence; ++renderSequence; renderTask?.cancel(); textLayer?.cancel(); await loading?.destroy(); loading = null; pdf = null; selected = null; dirty = false;
      expand(false);
      $("library-reader").hidden = true;
      $("library-empty").hidden = false;
      renderShelf();
      message("已移到回收站，PDF 和笔记都可以恢复。");
    } catch (error) { message(error.message, true); }
    finally { saving = false; $("paper-trash").disabled = false; }
  });
  async function importFiles(files) {
    if (importing || !files.length) return;
    importing = true;
    $("library-import").disabled = true;
    $("library-import-empty").disabled = true;
    let added = 0;
    let duplicates = 0;
    let first = null;
    const failures = [];
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      message(`正在存入本地文献库（${index + 1}/${files.length}）：${file.name}`);
      try {
        if (!/\.pdf$/i.test(file.name)) throw new Error("只支持 PDF 文件。");
        if (file.size > 80 * 1024 * 1024) throw new Error("超过 80 MB 上限。");
        const result = await api("/api/library", { method: "POST", headers: { "Content-Type": "application/pdf", "X-File-Name": encodeURIComponent(file.name) }, body: file });
        replacePaper(result.paper);
        if (result.duplicate) duplicates++; else added++;
        first ??= result.paper.id;
      } catch (error) { failures.push(`${file.name}：${error.message}`); }
    }
    importing = false;
    $("library-import").disabled = false;
    $("library-import-empty").disabled = false;
    $("library-files").value = "";
    $("library-filter").value = "all";
    $("library-search").value = "";
    renderShelf();
    message([added ? `已保存 ${added} 份 PDF。` : "", duplicates ? `${duplicates} 份重复文件已保留原记录。` : "", ...failures].filter(Boolean).join(" "), Boolean(failures.length));
    if (first && !dirty && location.hash === "#library") await openPaper(first);
    else if (first) lastSelected = first;
  }
  ["library-import", "library-import-empty"].forEach((id) => $(id).addEventListener("click", () => $("library-files").click()));
  $("library-files").addEventListener("change", () => importFiles([...$("library-files").files]));
  root.addEventListener("dragover", (event) => { if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; root.classList.add("is-dragging"); } });
  root.addEventListener("dragleave", (event) => { if (!root.contains(event.relatedTarget)) root.classList.remove("is-dragging"); });
  root.addEventListener("drop", (event) => { event.preventDefault(); root.classList.remove("is-dragging"); importFiles([...event.dataTransfer.files]); });
  $("library-search").addEventListener("input", renderShelf);
  $("library-filter").addEventListener("change", renderShelf);
  window.addEventListener("beforeunload", (event) => { if (dirty || importing) { event.preventDefault(); event.returnValue = ""; } });
  window.addEventListener("site:viewchange", (event) => {
    if (event.detail.view !== "library") { if ($("library-reader").classList.contains("is-expanded")) expand(false); return; }
    if (!selected && !loadError) { const entry = papers.find((paper) => paper.id === lastSelected && !paper.deletedAt) || papers.find((paper) => !paper.deletedAt); if (entry) openPaper(entry.id); }
    else if (pdf && $("pdf-zoom").value === "fit") renderPage(pageNumber, false);
  });
  try {
    papers = (await api("/api/library")).papers;
    renderShelf();
    if (location.hash === "#library") { const entry = papers.find((paper) => paper.id === lastSelected && !paper.deletedAt) || papers.find((paper) => !paper.deletedAt); if (entry) await openPaper(entry.id); }
  } catch (error) { loadError = true; message(error.message, true); }
})();
