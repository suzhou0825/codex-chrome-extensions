const startButton = document.getElementById("start");
const formatSelect = document.getElementById("format");
const chunkHeightSelect = document.getElementById("chunkHeight");
const statusNode = document.getElementById("status");

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  statusNode.textContent = "正在准备当前页面...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("没有找到当前标签页");
    }

    await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      tabId: tab.id,
      format: formatSelect.value,
      chunkHeight: Number(chunkHeightSelect.value)
    });
  } catch (error) {
    statusNode.textContent = error.message || "启动失败";
    startButton.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "CAPTURE_STATUS") {
    return;
  }

  statusNode.textContent = message.text;

  if (message.done) {
    startButton.disabled = false;
  }
});
