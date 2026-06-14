(function () {
  "use strict";

  if (window.__pageImageCollectorReady) {
    return;
  }

  window.__pageImageCollectorReady = true;

  const ORIGINAL_ATTRS = [
    "data-original",
    "data-origin",
    "data-large",
    "data-large-src",
    "data-full",
    "data-full-src",
    "data-zoom",
    "data-zoom-src",
    "data-hires",
    "data-src",
    "data-lazy-src",
    "data-url",
    "data-image"
  ];
  const MAIN_SELECTORS = [
    "article",
    "main",
    '[role="main"]',
    ".article",
    ".article-content",
    ".article-body",
    ".post",
    ".post-content",
    ".entry",
    ".entry-content",
    ".content",
    ".main-content",
    "#content",
    "#main"
  ];
  const EXCLUDE_SELECTOR = [
    "header",
    "footer",
    "nav",
    "aside",
    ".sidebar",
    ".side",
    ".recommend",
    ".recommended",
    ".related",
    ".related-posts",
    ".news-list",
    ".hot",
    ".popular",
    ".rank",
    ".ranking",
    ".ad",
    ".ads",
    ".advert",
    ".advertisement",
    ".share",
    ".social",
    ".comment",
    ".comments",
    ".appendix",
    ".annex",
    ".reference",
    ".references",
    ".avatar",
    ".icon",
    ".logo",
    "[class*='comment']",
    "[class*='appendix']",
    "[class*='annex']",
    "[class*='reference']",
    "[class*='recommend']",
    "[class*='related']",
    "[class*='sidebar']",
    "[class*='footer']",
    "[class*='header']",
    "[class*='nav']",
    "[class*='ad-']",
    "[id*='comment']",
    "[id*='appendix']",
    "[id*='annex']",
    "[id*='reference']",
    "[id*='recommend']",
    "[id*='related']",
    "[id*='sidebar']",
    "[id*='footer']",
    "[id*='header']",
    "[id*='nav']",
    "[id*='ad-']"
  ].join(",");

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "PIC_COLLECT") {
      return false;
    }

    sendResponse({
      images: collectImages({
        minWidth: Number(message.minWidth) || 0,
        includeBackgrounds: Boolean(message.includeBackgrounds)
      })
    });

    return false;
  });

  function collectImages(options) {
    const map = new Map();
    const roots = getContentRoots();

    collectImgTags(map, options, roots);
    collectPictureSources(map, roots);
    collectImageLinks(map, roots);

    if (options.includeBackgrounds) {
      collectBackgroundImages(map, roots);
    }

    return Array.from(map.values());
  }

  function collectImgTags(map, options, roots) {
    queryInRoots(roots, "img").forEach((img) => {
      if (isExcludedElement(img) || isInsideArticleCardLink(img) || isLikelyIcon(img)) {
        return;
      }

      if (options.minWidth && img.naturalWidth && img.naturalWidth < options.minWidth) {
        return;
      }

      const candidates = [];
      const linkedOriginal = findLinkedImage(img);
      if (linkedOriginal) candidates.push(linkedOriginal);

      for (const attr of ORIGINAL_ATTRS) {
        candidates.push(img.getAttribute(attr));
      }

      candidates.push(bestFromSrcset(img.getAttribute("srcset")));
      candidates.push(img.currentSrc);
      candidates.push(img.src);

      addBestCandidate(map, candidates, {
        alt: img.alt || img.title || "",
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
        source: "img"
      });
    });
  }

  function collectPictureSources(map, roots) {
    queryInRoots(roots, "picture source[srcset], source[srcset]").forEach((source) => {
      if (isExcludedElement(source) || isInsideArticleCardLink(source)) {
        return;
      }

      addBestCandidate(map, [bestFromSrcset(source.getAttribute("srcset"))], {
        alt: "",
        width: 0,
        height: 0,
        source: "srcset",
        type: source.type || ""
      });
    });
  }

  function collectImageLinks(map, roots) {
    queryInRoots(roots, "a[href]").forEach((link) => {
      if (isExcludedElement(link)) {
        return;
      }

      const href = link.getAttribute("href");
      if (!looksLikeImageUrl(href)) {
        return;
      }

      addBestCandidate(map, [href], {
        alt: link.textContent.trim(),
        width: 0,
        height: 0,
        source: "link"
      });
    });
  }

  function collectBackgroundImages(map, roots) {
    queryInRoots(roots, "*").forEach((element) => {
      if (isExcludedElement(element) || isInsideArticleCardLink(element) || isLikelyBackgroundDecoration(element)) {
        return;
      }

      const value = getComputedStyle(element).backgroundImage;
      if (!value || value === "none") {
        return;
      }

      for (const url of extractCssUrls(value)) {
        addBestCandidate(map, [url], {
          alt: "",
          width: element.clientWidth || 0,
          height: element.clientHeight || 0,
          source: "background"
        });
      }
    });
  }

  function addBestCandidate(map, candidates, meta) {
    const url = candidates.map(normalizeUrl).find(Boolean);
    if (!url || shouldSkip(url) || shouldSkipByMeta(url, meta)) {
      return;
    }

    const key = stripTracking(url);
    if (map.has(key)) {
      return;
    }

    map.set(key, {
      url,
      alt: meta.alt || "",
      width: meta.width || 0,
      height: meta.height || 0,
      source: meta.source || "",
      type: meta.type || ""
    });
  }

  function getContentRoots() {
    const candidates = MAIN_SELECTORS
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => !isExcludedElement(element))
      .map((element) => ({
        element,
        score: scoreContentRoot(element)
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    if (candidates.length) {
      const bestScore = candidates[0].score;
      return candidates
        .filter((item) => item.score >= bestScore * 0.7)
        .slice(0, 1)
        .map((item) => item.element);
    }

    return [document.body || document.documentElement];
  }

  function scoreContentRoot(element) {
    const rect = element.getBoundingClientRect();
    const textLength = (element.innerText || "").trim().length;
    const imageCount = element.querySelectorAll("img").length;
    const linkCount = element.querySelectorAll("a").length;
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);

    if (area < 20000 && imageCount < 2) {
      return 0;
    }

    return textLength + imageCount * 800 - linkCount * 80 + Math.min(area / 1000, 2000);
  }

  function queryInRoots(roots, selector) {
    const seen = new Set();
    const results = [];

    roots.forEach((root) => {
      root.querySelectorAll(selector).forEach((element) => {
        if (seen.has(element)) {
          return;
        }

        seen.add(element);
        results.push(element);
      });
    });

    return results;
  }

  function isExcludedElement(element) {
    return Boolean(element.closest(EXCLUDE_SELECTOR)) || isAfterNonContentMarker(element);
  }

  function isInsideArticleCardLink(element) {
    const link = element.closest("a[href]");
    if (!link) {
      return false;
    }

    const href = link.getAttribute("href") || "";
    if (looksLikeImageUrl(href)) {
      return false;
    }

    const normalizedHref = normalizeUrl(href);
    const text = getBriefText(link);
    const samePageHash = normalizedHref && normalizedHref.split("#")[0] === location.href.split("#")[0];
    const articleLikeHref = /\/(?:article|news|item|post|video|group|a)\/?\d|[?&](?:article_id|item_id|group_id)=/i.test(
      normalizedHref
    );

    return !samePageHash && (articleLikeHref || text.length >= 6);
  }

  function isAfterNonContentMarker(element) {
    const markerPattern =
      /(附录|附图|延伸阅读|相关阅读|推荐阅读|相关推荐|更多推荐|更多阅读|相关链接|参考资料|资料来源|免责声明|版权声明|热门评论|全部评论)/;
    let current = element;
    let depth = 0;

    while (current && current !== document.body && depth < 8) {
      let sibling = current.previousElementSibling;

      while (sibling) {
        if (markerPattern.test(getBriefText(sibling))) {
          return true;
        }

        sibling = sibling.previousElementSibling;
      }

      current = current.parentElement;
      depth += 1;
    }

    return false;
  }

  function getBriefText(element) {
    const text = (element.innerText || element.textContent || "").replace(/\s+/g, "");
    return text.slice(0, 80);
  }

  function isLikelyIcon(img) {
    const width = img.naturalWidth || img.width || img.clientWidth || 0;
    const height = img.naturalHeight || img.height || img.clientHeight || 0;
    const src = img.currentSrc || img.src || "";
    const text = `${img.className || ""} ${img.id || ""} ${img.alt || ""}`.toLowerCase();

    return (
      (width > 0 && height > 0 && (width < 120 || height < 80)) ||
      /\.(?:svg|ico)(?:[?#].*)?$/i.test(src) ||
      /(icon|logo|avatar|face|badge|sprite|qr|qrcode|loading|placeholder)/i.test(src) ||
      /(icon|logo|avatar|badge|sprite|qrcode)/i.test(text)
    );
  }

  function isLikelyBackgroundDecoration(element) {
    const width = element.clientWidth || 0;
    const height = element.clientHeight || 0;
    const text = `${element.className || ""} ${element.id || ""}`.toLowerCase();

    return (
      width < 240 ||
      height < 120 ||
      /(icon|logo|avatar|sprite|button|btn|share|qrcode|banner|ad)/i.test(text)
    );
  }

  function findLinkedImage(img) {
    const link = img.closest("a[href]");
    if (!link) {
      return "";
    }

    const href = link.getAttribute("href");
    return looksLikeImageUrl(href) ? href : "";
  }

  function bestFromSrcset(srcset) {
    if (!srcset) {
      return "";
    }

    return srcset
      .split(",")
      .map((item) => {
        const parts = item.trim().split(/\s+/);
        const url = parts[0];
        const descriptor = parts[1] || "";
        const score = descriptor.endsWith("w")
          ? Number(descriptor.slice(0, -1))
          : descriptor.endsWith("x")
            ? Number(descriptor.slice(0, -1)) * 1000
            : 0;

        return { url, score: Number.isFinite(score) ? score : 0 };
      })
      .sort((a, b) => b.score - a.score)[0]?.url || "";
  }

  function extractCssUrls(value) {
    const urls = [];
    const pattern = /url\((["']?)(.*?)\1\)/g;
    let match;

    while ((match = pattern.exec(value))) {
      urls.push(match[2]);
    }

    return urls;
  }

  function normalizeUrl(value) {
    if (!value || value.startsWith("data:")) {
      return "";
    }

    try {
      return new URL(value.replace(/&amp;/g, "&"), location.href).href;
    } catch (error) {
      return "";
    }
  }

  function looksLikeImageUrl(value) {
    if (!value) {
      return false;
    }

    return /\.(?:jpe?g|png|webp|gif|avif|bmp|svg)(?:[?#].*)?$/i.test(value);
  }

  function shouldSkip(url) {
    return (
      url.startsWith("blob:") ||
      url.startsWith("chrome:") ||
      /\.(?:svg|ico)(?:[?#].*)?$/i.test(url) ||
      /(icon|logo|avatar|sprite|qrcode|placeholder|loading|blank|spacer|pixel|transparent)/i.test(url) ||
      /\/(?:blank|spacer|pixel|transparent)\.(?:gif|png|jpg)(?:[?#].*)?$/i.test(url)
    );
  }

  function shouldSkipByMeta(url, meta) {
    const host = location.hostname;
    if (!/(^|\.)toutiao\.com$/i.test(host) || !/~tplv-tt-post/i.test(url)) {
      return false;
    }

    const width = Number(meta.width) || 0;
    const height = Number(meta.height) || 0;
    const hasSize = width > 0 && height > 0;
    const ratio = hasSize ? width / height : 0;
    const smallSquareCard = hasSize && width <= 450 && height <= 450;
    const horizontalCard = hasSize && ratio > 1.35 && height <= 520;

    return smallSquareCard || horizontalCard;
  }

  function stripTracking(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      return parsed.href;
    } catch (error) {
      return url;
    }
  }
})();
