"use strict";

(() => {
  const storageKey = "little-corner.journal.v1";
  const format = "little-corner-journal";
  const $ = (id) => document.getElementById(id);
  let entries = [];
  let selectedId = null;
  let editingId = null;
  let pendingDeleteId = null;
  let showTrash = false;
  let storageReadable = true;
  let storageRevision = null;
  let editorBaseline = "";
  let toastTimer;

  function localDate(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T12:00:00`);
    return !Number.isNaN(date.getTime()) && localDate(date) === value;
  }
  function validTimestamp(value) {
    return typeof value === "string" && value.length <= 40 && !Number.isNaN(new Date(value).getTime());
  }
  function validEntry(entry) {
    return entry && typeof entry === "object" && !Array.isArray(entry)
      && typeof entry.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(entry.id)
      && validDate(entry.date) && typeof entry.title === "string" && entry.title.length <= 80
      && typeof entry.content === "string" && entry.content.trim().length > 0 && entry.content.length <= 30000
      && validTimestamp(entry.createdAt) && validTimestamp(entry.updatedAt)
      && (entry.deletedAt === null || validTimestamp(entry.deletedAt));
  }
  function validateEntries(value) {
    if (!Array.isArray(value) || value.length > 10000 || !value.every(validEntry)) throw new Error("日志格式不正确。");
    if (new Set(value.map((entry) => entry.id)).size !== value.length) throw new Error("日志编号重复。");
    return value.map(({ id, date, title, content, createdAt, updatedAt, deletedAt }) => ({ id, date, title, content, createdAt, updatedAt, deletedAt }));
  }
  try {
    const raw = localStorage.getItem(storageKey);
    storageRevision = raw;
    if (raw !== null) {
      const saved = JSON.parse(raw);
      if (saved?.version !== 1) throw new Error("日志版本不正确。");
      entries = validateEntries(saved.entries);
    }
  } catch {
    storageReadable = false;
    $("journal-storage-warning").hidden = false;
  }

  function notify(message) {
    const toast = $("toast");
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 4500);
  }
  function commit(nextEntries) {
    if (!storageReadable) {
      notify("原有日志暂时无法读取，已停止写入以保留原数据。");
      return false;
    }
    try {
      if (localStorage.getItem(storageKey) !== storageRevision) {
        notify("日志在另一个页面有更新。请先复制当前正文，刷新后再编辑，避免覆盖新内容。");
        return false;
      }
      if (nextEntries.length > 10000) throw new Error("日志数量达到上限");
      const serialized = JSON.stringify({ version: 1, entries: nextEntries });
      localStorage.setItem(storageKey, serialized);
      storageRevision = serialized;
      entries = nextEntries;
      return true;
    } catch {
      notify("保存失败，可能是浏览器存储不可用或已满。请保留正文并导出已有日志。");
      return false;
    }
  }
  function makeId() {
    return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `entry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  function wordCount(text) { return Array.from(text.replace(/\s/g, "")).length; }
  function titleOf(entry) { return entry.title || `${entry.date} 的日志`; }
  function formatDate(value) {
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(new Date(`${value}T12:00:00`));
  }
  function makeElement(tag, className, text) {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function sorted(list) { return [...list].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)); }
  function visibleEntries() {
    const query = $("journal-search").value.trim().toLocaleLowerCase();
    const month = $("journal-month").value;
    return sorted(entries.filter((entry) => Boolean(entry.deletedAt) === showTrash
      && (!month || entry.date.startsWith(month))
      && (!query || `${entry.title}\n${entry.content}`.toLocaleLowerCase().includes(query))));
  }
  function renderHomePreview() {
    const latest = sorted(entries.filter((entry) => !entry.deletedAt))[0];
    $("journal-preview-title").textContent = latest ? titleOf(latest) : "今天，有什么想留下？";
    $("journal-preview-text").textContent = latest ? latest.content.replace(/\s+/g, " ").slice(0, 100) : "一件小事、一段心情，或者今天做了什么。写下来，以后还能回来看看。";
    $("journal-preview-date").textContent = latest ? `${latest.date} · ${wordCount(latest.content)} 字` : "";
    $("journal-preview-link").firstChild.textContent = latest ? "查看日志 " : "打开日志本 ";
  }
  function render() {
    const visible = visibleEntries();
    if (!visible.some((entry) => entry.id === selectedId)) selectedId = visible[0]?.id ?? null;
    const active = visible.find((entry) => entry.id === selectedId);
    const total = entries.filter((entry) => Boolean(entry.deletedAt) === showTrash).length;
    const filtered = Boolean($("journal-search").value.trim() || $("journal-month").value);
    $("journal-reset").hidden = !filtered;
    $("journal-count").textContent = filtered ? `找到 ${visible.length} 篇 · ${showTrash ? "回收站" : "共"} ${total} 篇` : `${showTrash ? "回收站" : "共"} ${total} 篇日志`;
    $("journal-trash").textContent = showTrash ? "← 返回日志" : `回收站 (${entries.filter((entry) => entry.deletedAt).length})`;
    $("journal-list-label").textContent = showTrash ? "暂时放下的日子" : "留在这里的日子";
    const list = $("journal-list");
    list.replaceChildren();
    for (const entry of visible) {
      const button = makeElement("button", "journal-list-item");
      button.type = "button";
      button.setAttribute("aria-pressed", String(entry.id === selectedId));
      button.append(makeElement("span", "journal-item-date", entry.date), makeElement("span", "journal-item-title", titleOf(entry)), makeElement("span", "journal-item-excerpt", entry.content.replace(/\s+/g, " ").slice(0, 70)));
      button.addEventListener("click", () => { selectedId = entry.id; render(); });
      list.append(button);
    }
    $("journal-list-empty").hidden = visible.length > 0;
    $("journal-list-empty").textContent = filtered ? "没有找到匹配的日志。\n换个关键词或月份试试。" : showTrash ? "回收站是空的。" : "日志本还是空的，\n从今天开始写一篇吧。";
    $("journal-reader").hidden = !active;
    $("journal-empty").hidden = Boolean(active);
    if (active) {
      $("journal-reader-date").textContent = formatDate(active.date);
      $("journal-reader-date").dateTime = active.date;
      $("journal-reader-length").textContent = `${wordCount(active.content)} 字`;
      $("journal-reader-title").textContent = titleOf(active);
      $("journal-reader-content").textContent = active.content;
      const updated = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(active.updatedAt));
      $("journal-reader-updated").textContent = showTrash ? "这篇日志可以随时恢复" : `最后保存于 ${updated}`;
      $("journal-edit").hidden = showTrash;
      $("journal-delete").hidden = showTrash;
      $("journal-restore").hidden = !showTrash;
    } else {
      $("journal-empty-title").textContent = filtered ? "暂时没有找到。" : showTrash ? "这里是空的。" : "第一篇，留给今天。";
      $("journal-empty-text").textContent = filtered ? "试试其他关键词，或者清除月份筛选。" : showTrash ? "被移到这里的日志，会一直保留到你恢复它。" : "想到什么，就写什么。\n这本日志，只需要按你的节奏来。";
      $("journal-first").hidden = filtered || showTrash;
    }
    renderHomePreview();
  }

  function editorValue() {
    return JSON.stringify([$("journal-date-input").value, $("journal-title-input").value, $("journal-content-input").value]);
  }
  function dirty() { return editorValue() !== editorBaseline; }
  function openEditor(entry = null) {
    editingId = entry?.id ?? null;
    $("journal-dialog-title").textContent = entry ? "编辑这篇日志" : "写一篇日志";
    $("journal-date-input").value = entry?.date ?? localDate();
    $("journal-title-input").value = entry?.title ?? "";
    $("journal-content-input").value = entry?.content ?? "";
    $("journal-word-count").textContent = `${wordCount($("journal-content-input").value)} 字`;
    $("journal-form-error").hidden = true;
    editorBaseline = editorValue();
    $("journal-dialog").showModal();
    $("journal-content-input").focus();
  }
  function closeEditor() {
    if (dirty()) $("journal-discard-dialog").showModal();
    else $("journal-dialog").close();
  }
  $("journal-new").addEventListener("click", () => openEditor());
  $("journal-first").addEventListener("click", () => openEditor());
  $("journal-edit").addEventListener("click", () => {
    const entry = entries.find((entry) => entry.id === selectedId && !entry.deletedAt);
    if (entry) openEditor(entry);
  });
  $("journal-close").addEventListener("click", closeEditor);
  $("journal-cancel").addEventListener("click", closeEditor);
  $("journal-dialog").addEventListener("cancel", (event) => { event.preventDefault(); closeEditor(); });
  $("journal-dialog").addEventListener("click", (event) => {
    const dialog = $("journal-dialog");
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeEditor();
  });
  $("journal-discard-confirm").addEventListener("click", () => {
    $("journal-discard-dialog").close();
    $("journal-dialog").close();
  });
  $("journal-content-input").addEventListener("input", () => {
    $("journal-word-count").textContent = `${wordCount($("journal-content-input").value)} 字`;
  });
  window.addEventListener("beforeunload", (event) => {
    if ($("journal-dialog").open && dirty()) { event.preventDefault(); event.returnValue = ""; }
  });
  $("journal-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const date = $("journal-date-input").value;
    const title = $("journal-title-input").value.trim();
    const content = $("journal-content-input").value.trim();
    if (!validDate(date) || !content) {
      $("journal-form-error").textContent = !content ? "先写一点正文，再保存这篇日志。" : "请选择一个有效的记录日期。";
      $("journal-form-error").hidden = false;
      (!content ? $("journal-content-input") : $("journal-date-input")).focus();
      return;
    }
    const previous = entries.find((entry) => entry.id === editingId);
    const now = new Date().toISOString();
    const entry = { id: previous?.id ?? makeId(), date, title, content, createdAt: previous?.createdAt ?? now, updatedAt: now, deletedAt: null };
    const next = previous ? entries.map((item) => item.id === entry.id ? entry : item) : [...entries, entry];
    if (!commit(next)) {
      $("journal-form-error").textContent = "保存未成功，正文仍在这里。请先复制留存，检查浏览器存储后再保存。";
      $("journal-form-error").hidden = false;
      return;
    }
    showTrash = false;
    $("journal-search").value = "";
    $("journal-month").value = "";
    selectedId = entry.id;
    $("journal-dialog").close();
    render();
    notify(previous ? "日志已更新。" : "日志已保存，又留下了一个日子。");
  });
  $("journal-delete").addEventListener("click", () => {
    const entry = entries.find((entry) => entry.id === selectedId && !entry.deletedAt);
    if (!entry) return;
    pendingDeleteId = entry.id;
    $("journal-delete-description").textContent = `「${titleOf(entry)}」会从日志列表中收起。`;
    $("journal-delete-dialog").showModal();
  });
  $("journal-delete-confirm").addEventListener("click", () => {
    if (!entries.some((entry) => entry.id === pendingDeleteId)) return;
    if (!commit(entries.map((entry) => entry.id === pendingDeleteId ? { ...entry, deletedAt: new Date().toISOString() } : entry))) return;
    $("journal-delete-dialog").close();
    pendingDeleteId = null;
    render();
    notify("已移到回收站，可以随时恢复。");
  });
  $("journal-restore").addEventListener("click", () => {
    if (!commit(entries.map((entry) => entry.id === selectedId ? { ...entry, deletedAt: null } : entry))) return;
    showTrash = false;
    render();
    notify("日志已恢复。");
  });
  $("journal-trash").addEventListener("click", () => {
    showTrash = !showTrash;
    $("journal-search").value = "";
    $("journal-month").value = "";
    selectedId = null;
    render();
  });
  $("journal-search").addEventListener("input", render);
  $("journal-preview-link").addEventListener("click", () => {
    showTrash = false;
    selectedId = sorted(entries.filter((entry) => !entry.deletedAt))[0]?.id ?? null;
    $("journal-search").value = "";
    $("journal-month").value = "";
    render();
  });
  $("journal-month").addEventListener("input", render);
  $("journal-reset").addEventListener("click", () => {
    $("journal-search").value = "";
    $("journal-month").value = "";
    render();
  });

  function download(data, filename) {
    const url = URL.createObjectURL(new Blob([data], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  $("journal-export").addEventListener("click", () => {
    if (!storageReadable) {
      try {
        download(localStorage.getItem(storageKey) ?? "null", `日志原始数据-${localDate()}.json`);
        notify("已导出原始数据，请保留这份文件用于恢复。");
      } catch { notify("无法读取日志数据，请检查浏览器存储权限。"); }
      return;
    }
    const backup = { format, version: 1, exportedAt: new Date().toISOString(), entries };
    download(JSON.stringify(backup, null, 2), `日志备份-${localDate()}.json`);
    notify("已导出备份，包含日志和回收站中的内容。");
  });
  $("journal-import").addEventListener("click", () => $("journal-file").click());
  $("journal-file").addEventListener("change", async () => {
    const file = $("journal-file").files[0];
    $("journal-file").value = "";
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { notify("备份文件太大，请选择 10 MB 以内的 JSON 文件。"); return; }
    try {
      const backup = JSON.parse((await file.text()).replace(/^\uFEFF/, ""));
      if (backup?.format !== format || backup.version !== 1) throw new Error("请选择这个小站导出的日志备份文件。");
      const incoming = validateEntries(backup.entries);
      const signature = (entry) => JSON.stringify([entry.date, entry.title, entry.content, entry.deletedAt]);
      const known = new Set(entries.map(signature));
      const ids = new Set(entries.map((entry) => entry.id));
      const next = [...entries];
      let added = 0;
      for (const entry of incoming) {
        const fingerprint = signature(entry);
        if (known.has(fingerprint)) continue;
        const id = ids.has(entry.id) ? makeId() : entry.id;
        next.push({ ...entry, id });
        ids.add(id);
        known.add(fingerprint);
        added++;
      }
      if (next.length > 10000) throw new Error("日志数量过多，本次导入未写入。");
      if (added && !commit(next)) return;
      showTrash = false;
      $("journal-search").value = "";
      $("journal-month").value = "";
      render();
      notify(added ? `已导入 ${added} 篇日志，保留了原有内容。` : "这些日志已经在这里，没有重复导入。");
    } catch (error) {
      notify(error instanceof SyntaxError ? "文件不是有效的 JSON 备份，原有日志未修改。" : `${error.message} 原有日志未修改。`);
    }
  });
  render();
})();
