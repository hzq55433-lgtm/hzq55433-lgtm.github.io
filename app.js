"use strict";

(() => {
  const key = "little-corner.home.v1";
  const defaults = {
    name: "一隅",
    intro: "还没想好这里要变成什么，也没关系。\n先有一个自己的小角落，再慢慢放进喜欢的东西。",
    note: "",
    updatedAt: "",
  };
  let state = { ...defaults };
  const $ = (id) => document.getElementById(id);
  let storageWarning = false;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      for (const field of Object.keys(defaults)) {
        if (typeof saved[field] === "string") state[field] = saved[field];
      }
      state.name = state.name.trim().slice(0, 12) || defaults.name;
      state.intro = state.intro.trim().slice(0, 180) || defaults.intro;
      state.note = state.note.slice(0, 2000);
    }
  } catch { storageWarning = true; }

  let toastTimer;
  function toast(message) {
    const el = $("toast");
    clearTimeout(toastTimer);
    el.textContent = message;
    el.classList.add("is-visible");
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), 3600);
  }

  function persist() {
    try {
      localStorage.setItem(key, JSON.stringify(state));
      toast("已保存。让这个小角落慢慢长成你的样子。");
    } catch {
      toast("当前浏览器无法保存，刷新后这些修改会消失。");
    }
  }

  function render() {
    document.title = `${state.name} · 我的小站`;
    $("brand-name").replaceChildren(document.createTextNode(state.name));
    const subtitle = document.createElement("span");
    subtitle.className = "brand-subtitle";
    subtitle.textContent = "我的小站";
    $("brand-name").append(subtitle);
    $("footer-name").textContent = `${state.name} · 一个自己的小角落`;
    $("site-description").textContent = state.intro;
    const note = $("note-content");
    note.textContent = state.note || "如果脑海里刚好闪过一个念头，\n就先把它留在这里。";
    note.classList.toggle("is-empty", !state.note);
    $("write-note").firstChild.textContent = state.note ? "再写一点想法 " : "写下第一个想法 ";
    $("edit-note").firstChild.textContent = state.note ? "改一笔 " : "写一笔 ";
    const date = new Date(state.updatedAt);
    $("note-meta").textContent = state.note && !Number.isNaN(date.getTime())
      ? `记于 ${new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(date)}`
      : "等你的第一笔";
  }

  function renderDate() {
    const now = new Date();
    $("date-day").textContent = String(now.getDate()).padStart(2, "0");
    $("date-month").textContent = new Intl.DateTimeFormat("en", { month: "long" }).format(now).toUpperCase();
    $("date-year").textContent = `${now.getFullYear()} · ${new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(now)}`;
  }

  function openNote() {
    $("note-input").value = state.note;
    $("note-dialog").showModal();
    $("note-input").focus();
  }
  $("write-note").addEventListener("click", openNote);
  $("edit-note").addEventListener("click", openNote);
  $("note-form").addEventListener("submit", (event) => {
    event.preventDefault();
    state.note = $("note-input").value.trim();
    state.updatedAt = state.note ? new Date().toISOString() : "";
    persist();
    render();
    $("note-dialog").close();
  });
  $("customize").addEventListener("click", () => {
    $("name-input").value = state.name;
    $("intro-input").value = state.intro;
    $("settings-dialog").showModal();
    $("name-input").focus();
  });
  $("settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("name-input").value.trim();
    const intro = $("intro-input").value.trim();
    if (!name || !intro) {
      toast("名字和介绍需要留一点内容。");
      (!name ? $("name-input") : $("intro-input")).focus();
      return;
    }
    state.name = name;
    state.intro = intro;
    persist();
    render();
    $("settings-dialog").close();
  });
  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => $(button.dataset.close).close());
  });
  document.querySelectorAll("dialog:not(#journal-dialog)").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
    });
  });
  const links = [...document.querySelectorAll(".nav-link")];
  const pages = new Map([["#journal", $("journal")], ["#games", $("games")]]);
  const homeLinks = links.filter((link) => !pages.has(link.getAttribute("href")));
  const sections = homeLinks.map((link) => document.querySelector(link.getAttribute("href")));
  function updateNavigation() {
    const current = sections.reduce((active, section, index) => section.getBoundingClientRect().top <= 150 ? index : active, 0);
    const activePage = [...pages].find(([, page]) => !page.hidden);
    const activeLink = activePage ? links.find((link) => link.getAttribute("href") === activePage[0]) : homeLinks[current];
    links.forEach((link) => {
      if (link === activeLink) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }
  function updateView() {
    const activePage = pages.get(location.hash) ?? null;
    const previousPage = [...pages.values()].find((page) => !page.hidden);
    $("home-page").hidden = Boolean(activePage);
    pages.forEach((page) => { page.hidden = page !== activePage; });
    if (activePage && activePage !== previousPage) window.scrollTo({ top: 0, behavior: "instant" });
    if (!activePage && previousPage) {
      const target = sections.find((section) => `#${section.id}` === location.hash);
      if (target?.id === "home") window.scrollTo({ top: 0, behavior: "instant" });
      else target?.scrollIntoView({ behavior: "instant" });
    }
    updateNavigation();
    window.dispatchEvent(new CustomEvent("site:viewchange", { detail: { view: activePage?.id ?? "home" } }));
  }
  window.addEventListener("hashchange", updateView);
  let framePending = false;
  window.addEventListener("scroll", () => {
    if (!framePending) {
      framePending = true;
      requestAnimationFrame(() => { updateNavigation(); framePending = false; });
    }
  }, { passive: true });
  render();
  renderDate();
  updateView();
  window.addEventListener("focus", renderDate);
  if (storageWarning) toast("浏览器未能读取保存内容，已显示默认首页。");
})();
