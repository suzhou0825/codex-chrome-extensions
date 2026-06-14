const startButton = document.getElementById("start");
const statusNode = document.getElementById("status");
const minWidthNode = document.getElementById("minWidth");
const includeBackgroundsNode = document.getElementById("includeBackgrounds");

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  statusNode.textContent = "正在扫描当前页面...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("没有找到当前标签页");
    }

    const response = await chrome.runtime.sendMessage({
      type: "START_IMAGE_COLLECT",
      tabId: tab.id,
      minWidth: Number(minWidthNode.value),
      includeBackgrounds: includeBackgroundsNode.checked
    });

    if (!response?.ok) {
      throw new Error(response?.error || "启动失败");
    }
  } catch (error) {
    statusNode.textContent = error.message || "启动失败";
    startButton.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "IMAGE_COLLECT_STATUS") {
    return;
  }

  statusNode.textContent = message.text;

  if (message.done) {
    startButton.disabled = false;
  }
});
