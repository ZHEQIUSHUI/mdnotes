"use strict";
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
const state = { editor: false, mode: "edit", needUser: false, articles: [], folders: [], dirty: false };
const VIDEO = /\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const short = (t) => (t || "").slice(0, 16);

// ---------- api ----------
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  if (r.status === 401) {
    state.editor = false; renderWho();
    if (state.mode === "all" && $("#modal").classList.contains("hidden")) login();
    throw new Error("need-login");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || r.statusText);
  return data;
}

const ICON = {
  all: '<svg viewBox="0 0 16 16"><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5zM5 5.5h6M5 8h6M5 10.5h4"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h3l1.5 1.75h5c.83 0 1.5.67 1.5 1.5v5.75c0 .83-.67 1.5-1.5 1.5h-9.5c-.83 0-1.5-.67-1.5-1.5z"/></svg>',
  edit: '<svg viewBox="0 0 16 16"><path d="M11 2.5l2.5 2.5L6 12.5H3.5V10z"/></svg>',
  note: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>',
  down: '<svg viewBox="0 0 16 16"><path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10"/></svg>',
  empty: '<svg viewBox="0 0 16 16" class="big"><path d="M3 2h7l3 3v9H3zM10 2v3h3"/></svg>',
};
function toast(msg, ms = 2200) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add("hidden"), ms);
}

// ---------- modal ----------
function modal(title, html, onOk, cancelable = true) {
  return new Promise((resolve) => {
    $("#mTitle").textContent = title; $("#mBody").innerHTML = html + '<div class="err"></div>';
    $("#modal").classList.remove("hidden"); $("#mCancel").classList.toggle("hidden", !cancelable);
    const first = $("#mBody input, #mBody select"); if (first) setTimeout(() => first.focus(), 0);
    const close = (v) => { $("#modal").classList.add("hidden"); $("#mOk").onclick = $("#mCancel").onclick = null; document.removeEventListener("keydown", key); resolve(v); };
    const ok = async () => {
      try { const v = await onOk($("#mBody")); close(v === undefined ? true : v); }
      catch (e) { $("#mBody .err").textContent = e.message === "need-login" ? "需要先登录" : e.message; }
    };
    const key = (e) => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") ok(); if (e.key === "Escape" && cancelable) close(null); };
    document.addEventListener("keydown", key);
    $("#mOk").onclick = ok; $("#mCancel").onclick = () => close(null);
  });
}

async function login() {
  const all = state.mode === "all";
  const html = `<label>${all ? "本站需要登录后才能查看" : "只有修改文章需要登录，阅读不需要"}</label>`
    + (state.needUser ? '<input id="user" placeholder="账号" autocomplete="username">' : "")
    + `<input id="pw" type="password" placeholder="${state.needUser ? "密码" : "口令"}" autocomplete="current-password">`;
  const ok = await modal(all ? "登录" : "登录后编辑", html, async (b) => {
    await api("POST", "/api/login", { user: $("#user", b)?.value || "", password: $("#pw", b).value });
    state.editor = true; renderWho();
  }, !all);
  if (ok && all) route();
  return ok;
}

async function needEditor() {
  if (state.editor) return true;
  return !!(await login());
}

function renderWho() {
  const w = $("#who");
  w.classList.toggle("hidden", state.mode === "none");
  w.innerHTML = state.editor ? "<i></i><span class=\"wt\">可编辑</span>" : "<i></i><span class=\"wt\">只读 · 点此登录</span>";
  w.classList.toggle("on", state.editor);
}
$("#who").onclick = () => { if (!state.editor) login(); };

// ---------- markdown ----------
function dirOf(p) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
function resolvePath(base, rel) {
  const out = base ? base.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop(); else out.push(seg);
  }
  return out.join("/");
}
const isRel = (u) => u && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(u);

marked.use({
  gfm: true,
  renderer: {
    code(code, info) {
      const lang = (info || "").trim().split(/\s+/)[0];
      if (lang === "mermaid") return `<pre class="mermaid">${esc(code)}</pre>`;
      let html;
      try { html = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : hljs.highlightAuto(code).value; }
      catch { html = esc(code); }
      return `<pre><code class="hljs">${html}</code></pre>`;
    },
    image(href, title, text) {
      if (VIDEO.test(href || "")) return `<video controls preload="metadata" src="${esc(href)}"${title ? ` title="${esc(title)}"` : ""}></video>`;
      return false;
    },
  },
});

function stripFront(md) { return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""); }

let mermaidSeq = 0, mermaidReady = null;
function loadMermaid() {  // 3 MB; only fetched when a page actually has a diagram
  return mermaidReady ||= new Promise((ok, fail) => {
    const s = document.createElement("script"); s.src = "vendor/mermaid.min.js";
    s.onload = () => { mermaid.initialize({ startOnLoad: false, securityLevel: "strict",
      theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" }); ok(); };
    s.onerror = () => { mermaidReady = null; fail(new Error("流程图组件加载失败")); };
    document.head.appendChild(s);
  });
}

async function renderMd(el, md, articlePath) {
  const html = DOMPurify.sanitize(marked.parse(stripFront(md)), {
    ADD_TAGS: ["video", "source"], ADD_ATTR: ["controls", "preload", "target"] });
  el.innerHTML = html;
  const base = dirOf(articlePath);
  el.querySelectorAll("img[src], video[src], source[src]").forEach((n) => {
    const s = n.getAttribute("src");
    if (isRel(s)) n.setAttribute("src", "/files/" + enc(resolvePath(base, decodeURI(s))));
  });
  el.querySelectorAll("a[href]").forEach((a) => {
    const h = a.getAttribute("href");
    if (!isRel(h)) { if (/^https?:/i.test(h)) a.target = "_blank"; return; }
    const [p, hash] = h.split("#");
    const target = resolvePath(base, decodeURI(p));
    if (/\.md$/i.test(target)) a.setAttribute("href", "#/a/" + enc(target));
    else if (p) a.setAttribute("href", "/files/" + enc(target) + (hash ? "#" + hash : ""));
  });
  el.querySelectorAll("img").forEach((img) => img.addEventListener("click", () => {
    $("#lightbox img").src = img.src; $("#lightbox").classList.remove("hidden");
  }));
  const used = {};
  el.querySelectorAll("h1,h2,h3,h4").forEach((h) => {
    let id = h.textContent.trim().toLowerCase().replace(/[^\w一-鿿]+/g, "-").replace(/^-|-$/g, "") || "h";
    if (used[id]) id += "-" + used[id]++; else used[id] = 1;
    h.id = id;
  });
  const nodes = [...el.querySelectorAll("pre.mermaid")];
  if (nodes.length) {
    try { await loadMermaid(); }
    catch (e) { nodes.forEach((n) => n.insertAdjacentHTML("afterbegin", `<code style="color:var(--danger)">${esc(e.message)}</code>\n`)); return; }
  }
  for (const n of nodes) {
    const src = n.textContent;
    try { const { svg } = await mermaid.render("mmd" + ++mermaidSeq, src); n.innerHTML = svg; }
    catch (e) { n.innerHTML = `<code style="color:var(--danger)">流程图语法错误：${esc(e.message || e)}</code>`; }
  }
}
$("#lightbox").onclick = () => $("#lightbox").classList.add("hidden");

// ---------- routing ----------
window.addEventListener("hashchange", () => route());
window.addEventListener("beforeunload", (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ""; } });

async function route() {
  hidePop();
  const h = decodeURIComponent(location.hash.slice(1) || "/");
  if (state.leaveGuard && !state.leaveGuard()) return;
  state.leaveGuard = null; state.dirty = false;
  if (h.startsWith("/a/")) return viewArticle(h.slice(3));
  if (h.startsWith("/e/")) return editArticle(h.slice(3));
  if (h.startsWith("/f/")) return listPage(h.slice(3));
  return listPage(null);
}

// ---------- list ----------
async function loadAll(q = "") {
  [state.articles, state.folders] = await Promise.all([
    api("GET", "/api/articles?q=" + encodeURIComponent(q)), api("GET", "/api/folders")]);
}

async function listPage(folder, q = $("#search").value.trim()) {
  await loadAll(q);
  const all = q ? state.articles : state.articles;
  const counts = {};
  for (const a of all) {
    const parts = a.folder ? a.folder.split("/") : [];
    for (let i = 1; i <= parts.length; i++) { const k = parts.slice(0, i).join("/"); counts[k] = (counts[k] || 0) + 1; }
  }
  const fset = new Set(state.folders);
  for (const k of Object.keys(counts)) fset.add(k);
  const flist = [...fset].sort();
  const items = folder === null ? all : all.filter((a) => a.folder === folder || a.folder.startsWith(folder + "/"));

  const side = [`<a class="f ${folder === null ? "cur" : ""}" href="#/"><span class="fl">${ICON.all}<span>全部文章</span></span><span class="n">${all.length}</span></a>`]
    .concat(flist.map((f) => {
      const depth = f.split("/").length - 1, name = f.split("/").pop();
      return `<a class="f ${folder === f ? "cur" : ""}" href="#/f/${enc(f)}" style="padding-left:${10 + depth * 16}px">
        <span class="fl">${ICON.folder}<span>${esc(name)}</span></span><span class="fr"><span class="n">${counts[f] || 0}</span>
        <span class="del ${counts[f] ? "" : "can"}" data-del="${esc(f)}" title="删除空文件夹">✕</span></span></a>`;
    })).join("");

  const rows = items.map((a) => `<a class="card" href="#/a/${enc(a.path)}">
      <div class="ct">${esc(a.title)}</div>
      ${a.snippet ? `<div class="snip">…${esc(a.snippet)}…</div>` : ""}
      <div class="cm">${a.folder ? `<span class="chip">${ICON.folder}${esc(a.folder)}</span>` : ""}
        <span title="创建时间">创建 ${esc(short(a.created))}</span><span class="dot">·</span><span title="最后修改时间">修改 ${esc(short(a.updated))}</span></div>
    </a>`).join("");

  const heading = q ? `搜索 “${esc(q)}”` : folder ? esc(folder.split("/").pop()) : "全部文章";
  app.innerHTML = `<div class="layout"><nav class="side"><div class="side-h">文件夹</div>${side}
      <button class="btn small side-new">新建文件夹</button></nav><div class="side-mask"></div><section class="content">
    <button class="btn small fold-btn">${ICON.folder}<span>${folder ? esc(folder) : "全部文章"}</span><b>▾</b></button>
    <div class="list-h"><h2>${heading}</h2><span class="cnt">${items.length} 篇 · 按最后修改排序</span></div>
    ${folder && !q ? `<div class="crumb"><a href="#/">全部</a> / ${esc(folder)}</div>` : ""}
    ${items.length ? `<div class="cards">${rows}</div>`
      : `<div class="empty">${ICON.empty}<div>${q ? "没有匹配的文章" : "这里还没有文章"}</div></div>`}
  </section></div>`;
  state.curFolder = folder;
  const lay = $(".layout", app), toggle = (on) => lay.classList.toggle("side-open", on);
  $(".fold-btn", app).onclick = () => toggle(true);
  $(".side-mask", app).onclick = () => toggle(false);
  $(".side-new", app).onclick = () => { toggle(false); $("#btnFolder").click(); };
  app.querySelectorAll("[data-del]").forEach((x) => x.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!(await needEditor())) return;
    try { await api("DELETE", "/api/folder?path=" + encodeURIComponent(x.dataset.del)); toast("已删除文件夹"); location.hash = "#/"; route(); }
    catch (err) { toast(err.message); }
  }));
}

let searchTimer;
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (!location.hash.startsWith("#/f/") && location.hash !== "#/" && location.hash !== "") location.hash = "#/";
    else listPage(state.curFolder ?? null);
  }, 250);
});

// ---------- view ----------
async function viewArticle(path) {
  const a = await api("GET", "/api/article?path=" + encodeURIComponent(path)).catch((e) => { app.innerHTML = `<div class="empty">打不开：${esc(e.message)}</div>`; });
  if (!a) return;
  const folder = folderOf(path);
  app.innerHTML = `<div class="article-wrap"><article class="article">
    <div class="ahead">
      <div class="crumb"><a href="#/">全部</a>${folder ? ` / <a href="#/f/${enc(folder)}">${esc(folder)}</a>` : ""}</div>
      <h1>${esc(a.title)}</h1>
      <div class="meta"><span>创建 ${esc(a.meta.created || "-")}</span><span class="dot">·</span><span>最后修改 ${esc(a.meta.updated || "-")}</span><span class="sp"></span>
        <button class="btn small primary" id="aEdit">${ICON.edit}编辑</button><a class="btn small" href="/api/download?path=${encodeURIComponent(path)}" download title="下载 Markdown 和文中用到的图片、视频（zip）">${ICON.down}下载</a><button class="btn small" id="aRen">重命名</button>
        <button class="btn small" id="aMove">移动</button><button class="btn small danger" id="aDel">删除</button></div>
    </div><div class="md" id="body"></div><section class="cmts" id="cmts"></section></article><aside class="toc" id="toc"></aside></div>`;
  document.title = a.title + " - 文档";
  const body = $("#body");
  await renderMd(body, a.content.replace(/^\s*#\s+.+\n?/, ""), path);
  const hs = [...body.querySelectorAll("h2,h3,h4")];
  $("#toc").innerHTML = hs.length > 2 ? "<div class=\"toc-h\">目录</div>" + hs.map((h) => `<a class="l${h.tagName[1]}" href="javascript:void(0)" data-id="${h.id}">${esc(h.textContent)}</a>`).join("") : "";
  $("#toc").querySelectorAll("a").forEach((x) => x.onclick = () => document.getElementById(x.dataset.id).scrollIntoView({ behavior: "smooth" }));
  $("#aEdit").onclick = async () => { if (await needEditor()) location.hash = "#/e/" + enc(path); };
  $("#aRen").onclick = () => renameDlg(path, a.title);
  $("#aMove").onclick = () => moveDlg(path);
  $("#aDel").onclick = () => deleteDlg(path, a.title);
  await setupComments(path, body);
}

function folderOf(path) {
  const parts = path.split("/");
  if (parts[parts.length - 1] === "index.md") parts.pop();
  parts.pop();
  return parts.join("/");
}

async function folderOptions(selected) {
  const fs = await api("GET", "/api/folders");
  return ['<option value="">（根目录）</option>'].concat(fs.map((f) => `<option value="${esc(f)}" ${f === selected ? "selected" : ""}>${esc(f)}</option>`)).join("");
}

async function renameDlg(path, title) {
  if (!(await needEditor())) return;
  const ok = await modal("重命名", `<label>新标题</label><input id="nt" value="${esc(title)}">`, async (b) => {
    const t = $("#nt", b).value.trim(); if (!t) throw new Error("标题不能为空");
    await api("POST", "/api/rename", { path, title: t });
  });
  if (ok) { toast("已重命名"); route(); }
}

async function moveDlg(path) {
  if (!(await needEditor())) return;
  const opts = await folderOptions(folderOf(path));
  const res = await modal("移动到文件夹", `<label>目标文件夹</label><select id="mf">${opts}</select>`, async (b) =>
    api("POST", "/api/move", { path, folder: $("#mf", b).value }));
  if (res && res.path) { toast("已移动"); location.hash = "#/a/" + enc(res.path); }
}

async function deleteDlg(path, title) {
  if (!(await needEditor())) return;
  const ok = await modal("删除文章", `<p>确定删除「${esc(title)}」？<br><small>会移到回收站（.trash），可以找回。</small></p>`, async () =>
    api("DELETE", "/api/article?path=" + encodeURIComponent(path)));
  if (ok) { toast("已移到回收站"); location.hash = "#/"; }
}

$("#btnNew").onclick = async () => {
  if (!(await needEditor())) return;
  const opts = await folderOptions(state.curFolder || "");
  const res = await modal("新建文章", `<label>标题</label><input id="nt"><label>文件夹</label><select id="nf">${opts}</select>`, async (b) => {
    const t = $("#nt", b).value.trim(); if (!t) throw new Error("标题不能为空");
    return api("POST", "/api/article", { title: t, folder: $("#nf", b).value });
  });
  if (res && res.path) location.hash = "#/e/" + enc(res.path);
};

$("#btnFolder").onclick = async () => {
  if (!(await needEditor())) return;
  const opts = await folderOptions(state.curFolder || "");
  const res = await modal("新建文件夹", `<label>放在</label><select id="pf">${opts}</select><label>文件夹名</label><input id="fn">`, async (b) => {
    const n = $("#fn", b).value.trim(); if (!n) throw new Error("名字不能为空");
    const parent = $("#pf", b).value;
    return api("POST", "/api/folder", { path: parent ? parent + "/" + n : n });
  });
  if (res && res.path) { toast("已创建"); location.hash = "#/f/" + enc(res.path); route(); }
};

// ---------- edit: preview left, source right ----------
async function editArticle(path) {
  if (!(await needEditor())) { location.hash = "#/a/" + enc(path); return; }
  const a = await api("GET", "/api/article?path=" + encodeURIComponent(path));
  let base = a.meta.updated || "";
  app.innerHTML = `<div class="editor">
    <div class="etool"><span class="name">${esc(a.title)}</span>
      <button class="btn primary" id="eSave">保存 (Ctrl+S)</button>
      <button class="btn" id="eUp">插入图片/视频</button><input id="eFile" type="file" multiple accept="image/*,video/*" class="hidden">
      <button class="btn" id="eMmd">插入流程图</button>
      <button class="btn" id="eBack">退出编辑</button><span class="st" id="eSt">左边预览，右边源码；图片/视频可直接拖进或粘贴到右侧</span></div>
    <div class="plabels"><span>预览</span><span>源码 · Markdown</span></div>
    <div class="panes"><div class="pane preview md" id="ePrev"></div>
      <div class="pane src" id="eSrc"><textarea id="eTxt" spellcheck="false"></textarea></div></div></div>`;
  const ta = $("#eTxt"), prev = $("#ePrev"), st = $("#eSt");
  ta.value = a.content;
  let t;
  const refresh = () => { clearTimeout(t); t = setTimeout(() => renderMd(prev, ta.value, path), 250); };
  refresh();
  ta.addEventListener("input", () => { state.dirty = true; st.textContent = "未保存"; refresh(); });
  ta.addEventListener("scroll", () => {
    const r = ta.scrollTop / Math.max(1, ta.scrollHeight - ta.clientHeight);
    prev.scrollTop = r * (prev.scrollHeight - prev.clientHeight);
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") { e.preventDefault(); insert("  "); }
  });
  const insert = (text) => {
    const s = ta.selectionStart, e = ta.selectionEnd;
    ta.setRangeText(text, s, e, "end"); ta.focus(); ta.dispatchEvent(new Event("input"));
  };
  const save = async () => {
    try {
      st.textContent = "保存中…";
      const { anchors, moved, lost } = await reanchor(path, ta.value);
      const r = await api("PUT", "/api/article", { path, content: ta.value, base_updated: base, anchors });
      base = r.meta.updated; state.dirty = false;
      st.textContent = "已保存 " + base.slice(11) + (moved ? `；${moved} 条注释已跟随修改后的文字` : "") + (lost ? `；${lost} 条注释的原文已删除` : "");
      if (lost) toast(`有 ${lost} 条注释对应的文字被删掉了，它们会列在文章下方的“注释”里`, 5000);
    } catch (e) { st.textContent = "保存失败"; toast(e.message === "need-login" ? "登录已过期，请重新登录" : e.message, 5000); if (e.message === "need-login") login(); }
  };
  const upload = async (files) => {
    for (const f of files) {
      const ph = `![上传中 ${f.name}…]()`; insert(ph);
      try {
        const fd = new FormData(); fd.append("path", path); fd.append("file", f);
        st.textContent = `上传 ${f.name}…`;
        const r = await api("POST", "/api/upload", fd);
        ta.value = ta.value.replace(ph, `![${f.name.replace(/\.[^.]+$/, "")}](${encodeURI(r.name)})`);
        ta.dispatchEvent(new Event("input")); st.textContent = "已上传 " + r.name;
      } catch (e) { ta.value = ta.value.replace(ph, ""); toast("上传失败：" + e.message, 5000); }
    }
  };
  $("#eSave").onclick = save;
  $("#eBack").onclick = () => { location.hash = "#/a/" + enc(path); };
  $("#eUp").onclick = () => $("#eFile").click();
  $("#eFile").onchange = (e) => { upload([...e.target.files]); e.target.value = ""; };
  $("#eMmd").onclick = () => insert("\n```mermaid\nflowchart LR\n    A[开始] --> B{判断}\n    B -->|是| C[处理]\n    B -->|否| D[结束]\n```\n");
  const src = $("#eSrc");
  src.addEventListener("dragover", (e) => { e.preventDefault(); src.classList.add("drag"); });
  src.addEventListener("dragleave", () => src.classList.remove("drag"));
  src.addEventListener("drop", (e) => { e.preventDefault(); src.classList.remove("drag"); if (e.dataTransfer.files.length) upload([...e.dataTransfer.files]); });
  ta.addEventListener("paste", (e) => {
    const fs = [...(e.clipboardData?.files || [])];
    if (fs.length) { e.preventDefault(); upload(fs); }
  });
  const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); } };
  document.addEventListener("keydown", onKey);
  state.leaveGuard = () => {
    if (state.dirty && !confirm("还有未保存的修改，确定离开？")) { history.replaceState(null, "", "#/e/" + enc(path)); return false; }
    document.removeEventListener("keydown", onKey); return true;
  };
}

// ---------- comments & annotations ----------
// Open to everyone. An annotation is a comment anchored to the rendered text by {exact, prefix, suffix}
// (exact "" = a point); it is re-located on every render, so small edits elsewhere don't lose it.
const CTX = 32;
const ls = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const cm = { path: "", root: null, items: [] };
const mdLite = (md) => DOMPurify.sanitize(marked.parse(md));

function textIndex(root) {
  const nodes = []; let text = "";
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) =>
    n.parentElement.closest("svg, .anno-pt") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  for (let n; (n = w.nextNode());) { nodes.push({ n, start: text.length }); text += n.data; }
  return { nodes, text };
}

function offsetOf(root, idx, container, off) {
  if (container.nodeType === 3) { const hit = idx.nodes.find((x) => x.n === container); if (hit) return hit.start + off; }
  const r = document.createRange(); r.setStart(root, 0); r.setEnd(container, off);
  let total = 0;
  for (const { n } of idx.nodes) { if (!r.intersectsNode(n)) break; total += n.data.length; }
  return total;
}

// Find where an anchor sits in the current text. Order of attempts:
//   exact  - the quoted text is still there (context picks the right copy if it repeats)
//   context- quote was edited, but the text right before / after it survives: take what lies between
//   fuzzy  - quote edited and moved: best window by character-bigram similarity (>= 0.5)
// Anything else is "lost" and only listed below the article.
function bigrams(s) { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.substr(i, 2); m.set(k, (m.get(k) || 0) + 1); } return m; }
function dice(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a), B = bigrams(b); let hit = 0;
  for (const [k, v] of A) hit += Math.min(v, B.get(k) || 0);
  return (2 * hit) / (a.length + b.length - 2);
}
function allIndex(text, key) { const out = []; if (key) for (let i = text.indexOf(key); i >= 0 && out.length < 200; i = text.indexOf(key, i + 1)) out.push(i); return out; }

function locate(text, a) {
  const p = a.prefix || "", q = a.suffix || "", ex = a.exact || "";
  const ctx = (s, e) => {
    let k = 0, j = 0;
    while (k < p.length && text[s - 1 - k] === p[p.length - 1 - k]) k++;
    while (j < q.length && text[e + j] === q[j]) j++;
    return k + j;
  };
  let best = null;
  const take = (s, e, sc, how) => { if (!best || sc > best.sc) best = { s, e, sc, how }; };
  if (ex) {
    for (const i of allIndex(text, ex)) take(i, i + ex.length, ctx(i, i + ex.length), "exact");
    if (best) return best;
  }
  // context: where the prefix ends and where the suffix starts
  const pk = p.slice(-12), qk = q.slice(0, 12);
  const pEnds = allIndex(text, pk).map((i) => i + pk.length), qStarts = allIndex(text, qk);
  if (!ex) {  // a point: just needs its surroundings
    for (const at of pEnds) take(at, at, ctx(at, at), "exact");
    for (const at of qStarts) take(at, at, ctx(at, at), "exact");
    return best && best.sc >= Math.min(12, p.length + q.length) ? best : null;
  }
  const maxGap = Math.max(2 * ex.length, ex.length + 200);
  for (const s of pEnds) for (const e of qStarts) {
    if (e >= s && e - s <= maxGap && text.slice(s, e).trim()) take(s, e, ctx(s, e) + 100 * dice(ex, text.slice(s, e)), "context");
  }
  if (best) return best;
  // fuzzy: seed windows from pieces of the old quote and from one-sided context
  const L = ex.length, seeds = new Set();
  for (const s of pEnds) seeds.add(s);
  for (const e of qStarts) seeds.add(Math.max(0, e - L));
  const piece = Math.min(8, Math.max(2, Math.floor(L / 3)));
  for (const off of [0, Math.floor((L - piece) / 2), L - piece]) for (const i of allIndex(text, ex.substr(off, piece))) seeds.add(Math.max(0, i - off));
  for (const s0 of seeds) {
    for (const s of [s0 - 4, s0, s0 + 4]) for (const len of [L, Math.round(L * 0.75), Math.round(L * 1.25)]) {
      if (s < 0 || len < 1) continue;
      const d = dice(ex, text.slice(s, s + len));
      if (d >= 0.5) take(s, s + len, 100 * d + ctx(s, s + len), "fuzzy");
    }
  }
  return best;
}

function wrapRange(root, s, e, id, changed) {
  for (const { n, start } of textIndex(root).nodes) {
    const end = start + n.data.length;
    if (end <= s || start >= e) continue;
    let node = n;
    const a = Math.max(s, start) - start, b = Math.min(e, end) - start;
    if (b < node.data.length) node.splitText(b);
    if (a > 0) node = node.splitText(a);
    if (!node.data.trim()) continue;
    const m = document.createElement("mark"); m.className = changed ? "anno changed" : "anno"; m.dataset.id = id;
    node.replaceWith(m); m.appendChild(node);
  }
}

function insertPoint(root, o, id, num) {
  const nodes = textIndex(root).nodes;
  const hit = nodes.find((x) => o > x.start && o <= x.start + x.n.data.length) || nodes[0];
  if (!hit) return;
  const pt = document.createElement("sup"); pt.className = "anno-pt"; pt.dataset.id = id; pt.textContent = num;
  const off = Math.max(0, o - hit.start);
  if (off >= hit.n.data.length) hit.n.after(pt); else if (off === 0) hit.n.before(pt); else hit.n.splitText(off).before(pt);
}

function clearAnnos(root) {
  root.querySelectorAll(".anno-pt").forEach((x) => x.remove());
  root.querySelectorAll("mark.anno").forEach((m) => m.replaceWith(...m.childNodes));
  root.normalize();
}

const annos = () => cm.items.filter((c) => c.anchor && !c.parent);
const repliesOf = (id) => cm.items.filter((c) => c.parent === id);

function applyAnnos() {
  const root = cm.root; clearAnnos(root);
  const { text } = textIndex(root);
  const list = annos().map((c, i) => ({ c, num: i + 1, at: locate(text, c.anchor) }));
  for (const x of list) x.c._num = x.num, x.c._lost = !x.at, x.c._how = x.at?.how, x.c._now = x.at ? text.slice(x.at.s, x.at.e) : "";
  // wrap later spans first so earlier offsets stay valid even when points add elements
  for (const x of list.filter((x) => x.at).sort((a, b) => b.at.s - a.at.s)) {
    if (x.c.anchor.exact) wrapRange(root, x.at.s, x.at.e, x.c.id, x.at.how !== "exact"); else insertPoint(root, x.at.s, x.c.id, x.num);
  }
}

function canDelete(c) { return state.editor || !!ls.get("mdn-ckeys", {})[c.id]; }

function commentHtml(c, withReply = true) {
  const reps = withReply ? repliesOf(c.id) : [];
  return `<div class="cmt" data-id="${c.id}">
    <div class="cmt-h"><span class="who-n">${esc(c.name || "匿名")}</span><span class="t">${esc(short(c.created))}</span>
      <span class="sp"></span>${withReply ? `<a class="lnk" data-reply="${c.id}">回复</a>` : ""}
      ${canDelete(c) ? `<a class="lnk del" data-cdel="${c.id}">删除</a>` : ""}</div>
    <div class="md cmt-b">${mdLite(c.body)}</div>
    ${reps.length ? `<div class="reps">${reps.map((r) => commentHtml(r, false)).join("")}</div>` : ""}
    <div class="rform" id="rf-${c.id}"></div>
  </div>`;
}

function formHtml(ph = "写点什么…支持 Markdown，Ctrl+Enter 发表") {
  return `<div class="cform"><textarea placeholder="${ph}"></textarea>
    <div class="row"><input class="cname" placeholder="昵称（可不填）" maxlength="32" value="${esc(ls.get("mdn-cname", ""))}">
    <span class="sp"></span><button class="btn small cancel hidden">取消</button><button class="btn small primary send">发表</button></div></div>`;
}

function bindForm(box, { parent = "", anchor = null, onCancel = null, focus = true }) {
  const ta = $("textarea", box), send = $(".send", box), cancel = $(".cancel", box);
  if (onCancel) { cancel.classList.remove("hidden"); cancel.onclick = onCancel; }
  const go = async () => {
    const body = ta.value.trim(); if (!body) { ta.focus(); return; }
    const name = $(".cname", box).value.trim(); ls.set("mdn-cname", name);
    send.disabled = true;
    try {
      const c = await api("POST", "/api/comments", { path: cm.path, body, name, parent, anchor });
      ls.set("mdn-ckeys", { ...ls.get("mdn-ckeys", {}), [c.id]: c.key });
      hidePop(); await refreshComments(); toast(anchor ? "注释已添加" : "已发表");
    } catch (e) { toast(e.message === "need-login" ? "需要先登录" : e.message, 4000); send.disabled = false; }
  };
  send.onclick = go;
  ta.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") go(); });
  if (focus) setTimeout(() => ta.focus(), 0);
}

async function delComment(id) {
  if (!confirm("删除这条？它下面的回复也会一起删掉。")) return;
  const key = ls.get("mdn-ckeys", {})[id] || "";
  try {
    await api("DELETE", `/api/comments?path=${encodeURIComponent(cm.path)}&id=${id}&key=${encodeURIComponent(key)}`);
  } catch (e) {
    if (e.message !== "need-login" || !(await login())) return toast(e.message === "need-login" ? "只有作者或编辑者能删除" : e.message);
    await api("DELETE", `/api/comments?path=${encodeURIComponent(cm.path)}&id=${id}`);
  }
  hidePop(); await refreshComments(); toast("已删除");
}

function bindActions(el) {
  el.querySelectorAll("[data-reply]").forEach((a) => a.onclick = () => {
    const box = $("#rf-" + a.dataset.reply, el);
    if (box.innerHTML) { box.innerHTML = ""; return; }
    box.innerHTML = formHtml("回复…"); bindForm(box, { parent: a.dataset.reply, onCancel: () => (box.innerHTML = "") });
  });
  el.querySelectorAll("[data-cdel]").forEach((a) => a.onclick = () => delComment(a.dataset.cdel));
}

function quoteOf(c) {
  const a = c.anchor, cut = (x, n = 160) => esc(x.length > n ? x.slice(0, n) + "…" : x);
  const flat = (x) => esc(x.replace(/\s+/g, " "));
  if (!a.exact) return `<div class="qw"><div class="q pt">…${flat(a.prefix.slice(-20))}<b>▍</b>${flat(a.suffix.slice(0, 20))}…</div></div>`;
  const now = c._how && c._how !== "exact" ? c._now : a.exact;   // relocated in this render
  const was = c.orig && c.orig !== now ? c.orig : (now !== a.exact ? a.exact : "");
  return `<div class="qw"><div class="q">${cut(now)}</div>${was ? `<div class="was">原文已修改，注释时是：「${cut(was, 120)}」</div>` : ""}</div>`;
}

function renderCommentList() {
  const box = $("#cmts"); if (!box) return;
  const tops = cm.items.filter((c) => !c.parent && !c.anchor), an = annos();
  box.innerHTML = `
    <h2 class="cmts-h">注释 <span>${an.length}</span></h2>
    <div class="hint">在正文里<b>选中一段文字</b>，或<b>点一下任意位置</b>，就能在那里插入注释。不用登录。</div>
    <div class="alist">${an.map((c) => `<div class="aitem${c._lost ? " lost" : ""}" data-aid="${c.id}">
      <div class="ah"><span class="num">${c._num}</span>${quoteOf(c)}</div>
      ${c._lost ? `<div class="lostn">注释的那段文字已被删除或大幅改写，找不到原来的位置</div>` : ""}
      ${commentHtml(c)}</div>`).join("")}</div>
    <h2 class="cmts-h">评论 <span>${tops.length}</span></h2>
    <div id="cnew">${formHtml()}</div>
    <div class="clist">${tops.length ? tops.slice().reverse().map((c) => commentHtml(c)).join("") : `<div class="none">还没有评论</div>`}</div>`;
  bindForm($("#cnew"), { focus: false });
  bindActions(box);
  box.querySelectorAll(".aitem:not(.lost) .ah").forEach((h) => h.onclick = () => {
    const id = h.parentElement.dataset.aid, el = cm.root.querySelector(`[data-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => showThread(id, el), 400);
  });
}

async function refreshComments() {
  cm.items = await api("GET", "/api/comments?path=" + encodeURIComponent(cm.path)).catch(() => []);
  applyAnnos(); renderCommentList();
}

// ---- floating popover: "add annotation" button, annotation form, annotation thread ----
const pop = document.createElement("div"); pop.className = "apop hidden"; document.body.appendChild(pop);
function placePop(rect) {
  pop.classList.remove("hidden");
  const w = pop.offsetWidth, x = Math.min(Math.max(8, rect.left), document.documentElement.clientWidth - w - 8);
  pop.style.left = x + scrollX + "px"; pop.style.top = rect.bottom + scrollY + 8 + "px";
}
function hidePop() { pop.classList.add("hidden"); pop.innerHTML = ""; pop.dataset.kind = ""; }
document.addEventListener("mousedown", (e) => { if (!pop.contains(e.target) && pop.dataset.kind !== "form") hidePop(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal:not(.hidden)")) hidePop(); });

function rectOf(range) {
  const rs = range.getClientRects();
  if (rs.length) return rs[rs.length - 1];
  const r = range.getBoundingClientRect();
  if (r.width || r.height) return r;
  const el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  return el.getBoundingClientRect();
}

function showThread(id, el) {
  const c = cm.items.find((x) => x.id === id); if (!c) return;
  pop.dataset.kind = "thread";
  pop.innerHTML = `<div class="ph">注释 ${c._num}</div>${commentHtml(c)}`;
  bindActions(pop); placePop(el.getBoundingClientRect());
}

function onPick(e) {
  if (pop.contains(e.target) || pop.dataset.kind === "form") return;
  const hitAnno = e.target.closest(".anno, .anno-pt");
  const sel = getSelection();
  if (hitAnno && (!sel.rangeCount || sel.isCollapsed)) return showThread(hitAnno.dataset.id, hitAnno);
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!cm.root.contains(range.commonAncestorContainer)) return;
  if (range.collapsed) {
    if (e.target.closest("a, img, video, button, svg, input, textarea")) return hidePop();
  }
  const idx = textIndex(cm.root);
  const s = offsetOf(cm.root, idx, range.startContainer, range.startOffset);
  const t = range.collapsed ? s : offsetOf(cm.root, idx, range.endContainer, range.endOffset);
  const exact = idx.text.slice(s, t);
  if (!range.collapsed && !exact.trim()) return hidePop();
  const anchor = { exact, prefix: idx.text.slice(Math.max(0, s - CTX), s), suffix: idx.text.slice(t, t + CTX) };
  const rect = rectOf(range);
  pop.dataset.kind = "btn";
  pop.innerHTML = `<button class="btn small primary">${ICON.note}${exact ? "注释选中文字" : "在此处插入注释"}</button>`;
  placePop(rect);
  $("button", pop).onclick = () => {
    pop.dataset.kind = "form";
    pop.innerHTML = `<div class="ph">${exact ? "给选中文字加注释" : "在此处插入注释"}</div>${quoteOf({ anchor })}${formHtml()}`;
    bindForm(pop, { anchor, onCancel: hidePop });
    placePop(rect);
  };
}

// Called on save: move annotations to where their text now lives, so the next edit is compared
// against the latest wording instead of the original one.
async function reanchor(path, content) {
  const list = (await api("GET", "/api/comments?path=" + encodeURIComponent(path)).catch(() => [])).filter((c) => c.anchor && !c.parent);
  if (!list.length) return { anchors: {}, moved: 0, lost: 0 };
  const tmp = document.createElement("div");
  await renderMd(tmp, content.replace(/^\s*#\s+.+\n?/, ""), path);
  const { text } = textIndex(tmp);
  const anchors = {}; let moved = 0, lost = 0;
  for (const c of list) {
    const at = locate(text, c.anchor);
    if (!at) { if (!c.lost) anchors[c.id] = null; lost++; continue; }
    const n = { exact: c.anchor.exact ? text.slice(at.s, at.e) : "", prefix: text.slice(Math.max(0, at.s - CTX), at.s), suffix: text.slice(at.e, at.e + CTX) };
    if (n.exact !== c.anchor.exact || n.prefix !== c.anchor.prefix || n.suffix !== c.anchor.suffix || c.lost) {
      anchors[c.id] = n; if (n.exact !== c.anchor.exact) moved++;
    }
  }
  return { anchors, moved, lost };
}

async function setupComments(path, root) {
  cm.path = path; cm.root = root; cm.items = []; hidePop();
  root.addEventListener("mouseup", (e) => setTimeout(() => onPick(e), 0));
  await refreshComments();
}

// ---------- boot ----------
(async () => {
  try { const me = await api("GET", "/api/me"); state.editor = me.editor; state.mode = me.mode; state.needUser = me.need_user; } catch {}
  renderWho();
  if (state.mode === "all" && !state.editor) login(); else route();
})();
