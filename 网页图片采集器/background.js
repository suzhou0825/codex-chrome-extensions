chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "START_IMAGE_COLLECT") {
    return false;
  }

  startCollect(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      notifyPopup(error.message || "保存失败", true);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

async function startCollect(options) {
  const tab = await chrome.tabs.get(options.tabId);
  if (!isAllowedPage(tab.url)) {
    throw new Error("当前页面不支持采集图片");
  }

  await chrome.scripting.executeScript({
    target: { tabId: options.tabId },
    files: ["content.js"]
  });

  const result = await chrome.tabs.sendMessage(options.tabId, {
    type: "PIC_COLLECT",
    minWidth: options.minWidth,
    includeBackgrounds: options.includeBackgrounds
  });

  const images = Array.isArray(result?.images) ? result.images : [];
  if (!images.length) {
    notifyPopup("没有找到可保存的图片", true);
    return { count: 0 };
  }

  const folder = buildFolderName(tab.title || "网页图片");
  notifyPopup(`找到 ${images.length} 张图片，开始下载...`);

  let success = 0;
  for (let index = 0; index < images.length; index += 1) {
    const item = images[index];
    notifyPopup(`正在下载 ${index + 1}/${images.length}`);

    try {
      await downloadImage(item.url, `${folder}/${buildFilename(item, index + 1)}`);
      success += 1;
    } catch (error) {
      console.warn("download failed", item.url, error);
    }

    await wait(80);
  }

  notifyPopup(`完成：已下载 ${success}/${images.length} 张图片`, true);
  return { count: success };
}

function downloadImage(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          reject(new Error(chrome.runtime.lastError?.message || "下载失败"));
          return;
        }

        resolve(downloadId);
      }
    );
  });
}

function buildFolderName(title) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `网页图片/${sanitizeFilename(title).slice(0, 70)}-${stamp}`;
}

function buildFilename(item, index) {
  const urlName = filenameFromUrl(item.url);
  const ext = getExtension(urlName) || extensionFromType(item.type) || "jpg";
  const base = sanitizeFilename(removeExtension(urlName) || item.alt || `image-${index}`);
  return `${String(index).padStart(3, "0")}-${base.slice(0, 80)}.${ext}`;
}

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const lastPart = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(lastPart);
  } catch (error) {
    return "";
  }
}

function getExtension(filename) {
  const match = filename.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  const ext = match?.[1] || "";
  return ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "svg"].includes(ext) ? ext : "";
}

function extensionFromType(type) {
  if (!type) {
    return "";
  }

  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  if (type.includes("svg")) return "svg";
  if (type.includes("avif")) return "avif";
  return "jpg";
}

function removeExtension(filename) {
  return filename.replace(/\.[a-z0-9]{2,5}$/i, "");
}

function sanitizeFilename(value) {
  return (value || "网页图片")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "网页图片";
}

function isAllowedPage(url) {
  return /^https?:\/\//i.test(url || "") || /^file:\/\//i.test(url || "");
}

function notifyPopup(text, done = false) {
  chrome.runtime.sendMessage({
    type: "IMAGE_COLLECT_STATUS",
    text,
    done
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
