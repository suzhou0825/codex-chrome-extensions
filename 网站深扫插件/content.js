(function () {
  "use strict";

  const SITE_ORIGIN = "https://bbs.fuyuan6.com";
  const CACHE_PREFIX = "fy:first-image:";
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
  const MAX_THREADS_PER_PAGE = 50;
  const CONCURRENCY = 3;
  const IMAGE_ATTRS = ["zoomfile", "file", "src", "data-src"];
  const POPUP_ID = "fy-detail-popup";

  if (!isForumListPage()) {
    return;
  }

  boot();

  function isForumListPage() {
    const path = location.pathname;
    const search = location.search;

    return (
      document.body?.classList.contains("pg_forumdisplay") ||
      /^\/forum-\d+(?:-[\w]+)*-\d+\.html$/i.test(path) ||
      (path.endsWith("/forum.php") && /(?:^|[?&])mod=forumdisplay(?:&|$)/.test(search))
    );
  }

  async function boot() {
    setupDetailPopup();

    const items = collectThreadItems().slice(0, MAX_THREADS_PER_PAGE);
    if (!items.length) {
      return;
    }

    await runQueue(items, CONCURRENCY, hydrateThread);
  }

  function collectThreadItems() {
    return Array.from(
      document.querySelectorAll(
        '#threadlisttableid tbody[id^="normalthread_"], #threadlisttableid tbody[id^="stickthread_"]'
      )
    )
      .map((row) => {
        const link = row.querySelector('th a.xst[href*="thread-"]');
        const titleCell = row.querySelector("th");
        const tid = getThreadId(row.id, link?.href);

        if (!link || !titleCell || !tid || row.querySelector(".fy-thread-thumb")) {
          return null;
        }

        return {
          row,
          link,
          titleCell,
          tid,
          detailUrl: normalizeThreadUrl(link.href)
        };
      })
      .filter(Boolean);
  }

  async function hydrateThread(item) {
    const thumb = createThumb(item.link.href);
    item.titleCell.insertBefore(thumb, item.titleCell.firstChild);

    try {
      const cached = await readCache(item.tid);
      const imageUrl = cached ?? (await fetchFirstImage(item.detailUrl));

      await writeCache(item.tid, imageUrl);
      renderThumb(thumb, imageUrl, item.link.textContent.trim());
    } catch (error) {
      thumb.className = "fy-thread-thumb is-error";
      thumb.title = "首图加载失败";
      console.debug("[fy-first-image] failed:", item.detailUrl, error);
    }
  }

  function createThumb(href) {
    const thumb = document.createElement("a");
    thumb.className = "fy-thread-thumb is-loading";
    thumb.href = href;
    thumb.target = "_blank";
    thumb.rel = "noopener noreferrer";
    thumb.title = "正在加载首图";
    return thumb;
  }

  function renderThumb(thumb, imageUrl, title) {
    thumb.classList.remove("is-loading", "is-error");

    if (!imageUrl) {
      thumb.classList.add("is-empty");
      thumb.title = "未找到首图";
      return;
    }

    const img = document.createElement("img");
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer-when-downgrade";
    img.src = imageUrl;
    img.alt = title ? `${title} 首图` : "帖子首图";

    thumb.textContent = "";
    thumb.title = title || "帖子首图";
    thumb.appendChild(img);
  }

  function setupDetailPopup() {
    const table = document.querySelector("#threadlisttableid");
    if (!table || table.dataset.fyPopupReady === "1") {
      return;
    }

    table.dataset.fyPopupReady = "1";
    table.addEventListener(
      "click",
      (event) => {
        if (shouldKeepNativeClick(event)) {
          return;
        }

        const link = event.target.closest('a.xst[href*="thread-"], .fy-thread-thumb[href*="thread-"]');
        if (!link || !table.contains(link)) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        openDetailPopup(normalizeThreadUrl(link.href), link.textContent.trim() || link.title || "帖子详情");
      },
      true
    );
  }

  function shouldKeepNativeClick(event) {
    return (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.defaultPrevented
    );
  }

  function openDetailPopup(url, title) {
    const popup = getOrCreatePopup();
    const frame = popup.querySelector(".fy-detail-popup-frame");
    const titleNode = popup.querySelector(".fy-detail-popup-title");
    const openLink = popup.querySelector(".fy-detail-popup-open");

    titleNode.textContent = title;
    openLink.href = url;
    frame.src = url;
    popup.classList.add("is-open", "is-loading");
    document.documentElement.classList.add("fy-popup-lock");

    frame.onload = () => {
      popup.classList.remove("is-loading");
    };
  }

  function getOrCreatePopup() {
    const existing = document.getElementById(POPUP_ID);
    if (existing) {
      return existing;
    }

    const popup = document.createElement("div");
    popup.id = POPUP_ID;
    popup.className = "fy-detail-popup";
    popup.innerHTML = [
      '<div class="fy-detail-popup-backdrop" data-fy-close="1"></div>',
      '<section class="fy-detail-popup-panel" role="dialog" aria-modal="true">',
      '<header class="fy-detail-popup-header">',
      '<strong class="fy-detail-popup-title">帖子详情</strong>',
      '<div class="fy-detail-popup-actions">',
      '<a class="fy-detail-popup-open" target="_blank" rel="noopener noreferrer">新标签打开</a>',
      '<button type="button" class="fy-detail-popup-close" data-fy-close="1" aria-label="关闭">×</button>',
      "</div>",
      "</header>",
      '<div class="fy-detail-popup-loading">加载中</div>',
      '<iframe class="fy-detail-popup-frame" title="帖子详情"></iframe>',
      "</section>"
    ].join("");

    popup.addEventListener("click", (event) => {
      if (event.target.dataset.fyClose === "1") {
        closeDetailPopup();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && popup.classList.contains("is-open")) {
        closeDetailPopup();
      }
    });

    document.body.appendChild(popup);
    return popup;
  }

  function closeDetailPopup() {
    const popup = document.getElementById(POPUP_ID);
    if (!popup) {
      return;
    }

    const frame = popup.querySelector(".fy-detail-popup-frame");
    popup.classList.remove("is-open", "is-loading");
    document.documentElement.classList.remove("fy-popup-lock");
    frame.src = "about:blank";
  }

  async function fetchFirstImage(detailUrl) {
    const response = await fetch(detailUrl, {
      credentials: "same-origin",
      cache: "force-cache"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    const html = decodeHtml(buffer);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const baseUrl = getBaseUrl(doc, detailUrl);
    const firstPost = doc.querySelector('[id^="postmessage_"]');

    if (!firstPost) {
      return "";
    }

    const image = Array.from(firstPost.querySelectorAll("img"))
      .map((img) => pickImageUrl(img, baseUrl))
      .find(Boolean);

    return image || "";
  }

  function decodeHtml(buffer) {
    try {
      return new TextDecoder("gbk").decode(buffer);
    } catch (error) {
      return new TextDecoder("utf-8").decode(buffer);
    }
  }

  function getBaseUrl(doc, fallbackUrl) {
    const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
    try {
      return new URL(baseHref || fallbackUrl, fallbackUrl).href;
    } catch (error) {
      return fallbackUrl;
    }
  }

  function pickImageUrl(img, baseUrl) {
    for (const attr of IMAGE_ATTRS) {
      const raw = img.getAttribute(attr);
      if (!raw || shouldSkipImage(raw)) {
        continue;
      }

      try {
        return new URL(raw.replace(/&amp;/g, "&"), baseUrl).href;
      } catch (error) {
        continue;
      }
    }

    return "";
  }

  function shouldSkipImage(url) {
    const value = url.toLowerCase();
    return (
      value.includes("static/image/common/") ||
      value.includes("static/image/smiley/") ||
      value.includes("uc_server/avatar.php") ||
      value.includes("source/plugin/") ||
      value.endsWith("/none.gif")
    );
  }

  function normalizeThreadUrl(url) {
    const parsed = new URL(url, location.href);
    const tid = getThreadId("", parsed.href);

    if (tid) {
      return `${SITE_ORIGIN}/thread-${tid}-1-1.html`;
    }

    return parsed.href;
  }

  function getThreadId(rowId, href) {
    const rowMatch = rowId?.match(/(?:normal|stick)thread_(\d+)/);
    if (rowMatch) {
      return rowMatch[1];
    }

    const hrefMatch = href?.match(/thread-(\d+)-/);
    return hrefMatch?.[1] || "";
  }

  async function readCache(tid) {
    const key = CACHE_PREFIX + tid;
    const data = await chrome.storage.local.get(key);
    const entry = data[key];

    if (!entry || Date.now() - entry.time > CACHE_TTL) {
      return null;
    }

    return entry.imageUrl || "";
  }

  async function writeCache(tid, imageUrl) {
    await chrome.storage.local.set({
      [CACHE_PREFIX + tid]: {
        imageUrl,
        time: Date.now()
      }
    });
  }

  async function runQueue(items, concurrency, worker) {
    let index = 0;
    const runners = Array.from({ length: concurrency }, async () => {
      while (index < items.length) {
        const item = items[index++];
        await worker(item);
      }
    });

    await Promise.all(runners);
  }
})();
