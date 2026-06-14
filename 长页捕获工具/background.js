const CAPTURE_DELAY = 350;
const MIN_CAPTURE_INTERVAL = 700;
let lastCaptureAt = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START_CAPTURE") {
    startCapture(message)
      .catch((error) => {
        notifyPopup(error.message || "捕获失败", true);
      });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "DOWNLOAD_FILE") {
    chrome.downloads.download(
      {
        url: message.dataUrl,
        filename: message.filename,
        saveAs: false
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn(chrome.runtime.lastError.message);
        }
      }
    );
  }

  return false;
});

async function startCapture(options) {
  const tabId = options.tabId;
  const tab = await chrome.tabs.get(tabId);

  if (!isCaptureAllowed(tab.url)) {
    throw new Error("当前页面不支持截图");
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });

  notifyPopup("正在读取页面尺寸...");
  const metrics = await sendToTab(tabId, {
    type: "LPC_INIT",
    chunkHeight: options.chunkHeight
  });

  const positions = buildScrollPositions(metrics.scrollHeight, metrics.innerHeight);
  const captures = [];

  for (let index = 0; index < positions.length; index += 1) {
    const y = positions[index];
    notifyPopup(`正在截图 ${index + 1}/${positions.length}`);

    const viewport = await sendToTab(tabId, {
      type: "LPC_SCROLL_TO",
      y,
      delay: CAPTURE_DELAY
    });

    const captureOptions = { format: options.format === "pdf" ? "jpeg" : "png" };
    if (options.format === "pdf") {
      captureOptions.quality = 92;
    }

    const dataUrl = await captureVisibleTabSafely(tab.windowId, captureOptions);

    captures.push({
      dataUrl,
      y: viewport.scrollY,
      innerWidth: viewport.innerWidth,
      innerHeight: viewport.innerHeight
    });
  }

  notifyPopup("正在合成文件...");
  const result = await sendToTab(tabId, {
    type: "LPC_BUILD",
    format: options.format,
    captures,
    chunkHeight: options.chunkHeight,
    title: tab.title || "网页截图"
  });

  if (result?.error) {
    throw new Error(result.error);
  }

  notifyPopup(`已保存 ${result.count} 个文件`, true);
}

function buildScrollPositions(scrollHeight, innerHeight) {
  const maxScroll = Math.max(0, scrollHeight - innerHeight);
  const step = Math.max(1, innerHeight);
  const positions = [];

  for (let y = 0; y < maxScroll; y += step) {
    positions.push(y);
  }

  if (!positions.length || positions[positions.length - 1] !== maxScroll) {
    positions.push(maxScroll);
  }

  return positions;
}

function isCaptureAllowed(url) {
  return /^https?:\/\//i.test(url || "") || /^file:\/\//i.test(url || "");
}

function sendToTab(tabId, payload) {
  return chrome.tabs.sendMessage(tabId, payload);
}

async function captureVisibleTabSafely(windowId, options) {
  const elapsed = Date.now() - lastCaptureAt;
  if (elapsed < MIN_CAPTURE_INTERVAL) {
    await wait(MIN_CAPTURE_INTERVAL - elapsed);
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, options);
  lastCaptureAt = Date.now();
  return dataUrl;
}

function notifyPopup(text, done = false) {
  chrome.runtime.sendMessage({
    type: "CAPTURE_STATUS",
    text,
    done
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
