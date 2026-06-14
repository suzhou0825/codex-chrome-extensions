(function () {
  "use strict";

  if (window.__longPageCaptureReady) {
    return;
  }

  window.__longPageCaptureReady = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "LPC_INIT") {
      sendResponse(getMetrics());
      return false;
    }

    if (message.type === "LPC_SCROLL_TO") {
      scrollToPosition(message.y, message.delay).then(sendResponse);
      return true;
    }

    if (message.type === "LPC_BUILD") {
      buildOutput(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ error: error.message, count: 0 }));
      return true;
    }

    return false;
  });

  function getMetrics() {
    const doc = document.documentElement;
    const body = document.body;
    return {
      scrollWidth: Math.max(doc.scrollWidth, body?.scrollWidth || 0, window.innerWidth),
      scrollHeight: Math.max(doc.scrollHeight, body?.scrollHeight || 0, window.innerHeight),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollY: window.scrollY
    };
  }

  async function scrollToPosition(y, delay) {
    window.scrollTo(0, y);
    await wait(delay || 250);
    return getMetrics();
  }

  async function buildOutput(message) {
    const captures = message.captures || [];
    if (!captures.length) {
      throw new Error("没有可用截图");
    }

    const safeTitle = sanitizeFilename(message.title || document.title || "网页截图");
    const metrics = getMetrics();
    const firstImage = await loadImage(captures[0].dataUrl);
    const scale = firstImage.width / captures[0].innerWidth;
    const totalWidth = firstImage.width;
    const totalHeight = Math.ceil(metrics.scrollHeight * scale);

    if (message.format === "pdf") {
      const pages = [];
      for (const capture of captures) {
        const image = await loadImage(capture.dataUrl);
        pages.push({
          dataUrl: capture.dataUrl,
          width: image.width,
          height: image.height
        });
      }

      const pdfDataUrl = buildPdfDataUrl(pages);
      downloadFile(pdfDataUrl, `${safeTitle}.pdf`);
      return { count: 1 };
    }

    const chunkHeight = Math.max(8000, Math.min(Number(message.chunkHeight) || 24000, 30000));
    let count = 0;

    for (let top = 0; top < totalHeight; top += chunkHeight) {
      const height = Math.min(chunkHeight, totalHeight - top);
      const canvas = document.createElement("canvas");
      canvas.width = totalWidth;
      canvas.height = height;

      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      for (const capture of captures) {
        const image = await loadImage(capture.dataUrl);
        const captureTop = Math.round(capture.y * scale);
        const captureBottom = captureTop + image.height;
        const chunkBottom = top + height;
        const interTop = Math.max(top, captureTop);
        const interBottom = Math.min(chunkBottom, captureBottom);

        if (interBottom <= interTop) {
          continue;
        }

        context.drawImage(
          image,
          0,
          interTop - captureTop,
          image.width,
          interBottom - interTop,
          0,
          interTop - top,
          image.width,
          interBottom - interTop
        );
      }

      count += 1;
      const suffix = totalHeight > chunkHeight ? `-${String(count).padStart(2, "0")}` : "";
      downloadFile(canvas.toDataURL("image/png"), `${safeTitle}${suffix}.png`);
      await wait(80);
    }

    return { count };
  }

  function buildPdfDataUrl(pages) {
    const objects = [];
    const pageRefs = [];

    addObject("<< /Type /Catalog /Pages 2 0 R >>");
    addObject("");

    for (const page of pages) {
      const imageBytes = base64ToBinary(page.dataUrl.split(",")[1]);
      const pageWidth = Math.round(page.width * 72 / 96);
      const pageHeight = Math.round(page.height * 72 / 96);
      const imageObjectId = objects.length + 1;
      const pageObjectId = imageObjectId + 1;
      const contentObjectId = imageObjectId + 2;

      addObject(
        [
          `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height}`,
          "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
          `/Length ${imageBytes.length} >>`,
          "stream",
          imageBytes,
          "endstream"
        ]
      );

      addObject(
        [
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}]`,
          `/Resources << /XObject << /Im${imageObjectId} ${imageObjectId} 0 R >> >>`,
          `/Contents ${contentObjectId} 0 R >>`
        ].join(" ")
      );

      const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im${imageObjectId} Do\nQ`;
      addObject(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      pageRefs.push(`${pageObjectId} 0 R`);
    }

    objects[1] = `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pageRefs.length} >>`;

    const pdf = writePdf(objects);
    return `data:application/pdf;base64,${binaryToBase64(pdf)}`;

    function addObject(content) {
      objects.push(content);
    }
  }

  function writePdf(objects) {
    const parts = ["%PDF-1.3\n"];
    const offsets = [0];

    for (let index = 0; index < objects.length; index += 1) {
      offsets.push(byteLength(parts.join("")));
      parts.push(`${index + 1} 0 obj\n`);

      const object = objects[index];
      if (Array.isArray(object)) {
        for (const piece of object) {
          parts.push(piece, "\n");
        }
      } else {
        parts.push(object, "\n");
      }

      parts.push("endobj\n");
    }

    const xrefOffset = byteLength(parts.join(""));
    parts.push(`xref\n0 ${objects.length + 1}\n`);
    parts.push("0000000000 65535 f \n");

    for (let index = 1; index < offsets.length; index += 1) {
      parts.push(`${String(offsets[index]).padStart(10, "0")} 00000 n \n`);
    }

    parts.push(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
    );

    return parts.join("");
  }

  function downloadFile(dataUrl, filename) {
    const blobUrl = URL.createObjectURL(dataUrlToBlob(dataUrl));
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("图片加载失败"));
      image.src = dataUrl;
    });
  }

  function sanitizeFilename(name) {
    return name
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90) || "网页截图";
  }

  function base64ToBinary(base64) {
    const chars = atob(base64);
    let binary = "";
    for (let index = 0; index < chars.length; index += 1) {
      binary += String.fromCharCode(chars.charCodeAt(index));
    }
    return binary;
  }

  function dataUrlToBlob(dataUrl) {
    const [header, base64] = dataUrl.split(",");
    const mime = header.match(/^data:([^;]+)/)?.[1] || "application/octet-stream";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return new Blob([bytes], { type: mime });
  }

  function binaryToBase64(binary) {
    const chunkSize = 32766;
    let result = "";
    for (let index = 0; index < binary.length; index += chunkSize) {
      result += btoa(binary.slice(index, index + chunkSize));
    }
    return result;
  }

  function byteLength(value) {
    return value.length;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
