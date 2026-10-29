"use strict";
// Shared, authenticated, same-origin raster image lightbox for the web workspace.
// The original attachment URL remains protected by its existing server permissions.
window.ImageViewer = (() => {
  const TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/avif"]);
  const EXT = /\.(?:png|jpe?g|webp|gif|bmp|avif)$/i;
  const MAX_BYTES = 100 * 1024 * 1024;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const filename = value => String(value || "图片").replace(/[\\/\x00-\x1f]/g, "_").slice(0, 180) || "图片";
  let dialog, picture, caption, status, scale = 1, rotation = 0, offsetX = 0, offsetY = 0;
  let imageBlob, objectUrl, currentURL, controller, generation = 0, returnFocus, pointer;

  function localURL(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && ["http:", "https:"].includes(url.protocol) ? url : null;
    } catch (_) { return null; }
  }
  function canPreview(value) {
    const url = localURL(value);
    if (!url) return false;
    try { return EXT.test(decodeURIComponent(url.pathname)); } catch (_) { return false; }
  }
  function sourceFor(link) {
    if (!link || link.matches("[data-no-image-preview]")) return null;
    if (link.matches("a[href]")) {
      const url = localURL(link.href);
      if (!url) return null;
      // Explicit opt-in handles attachment routes without filename suffixes.
      if (link.hasAttribute("data-image-preview") || canPreview(link.href)) return {url: url.href, name: link.dataset.imageName || link.getAttribute("download") || link.querySelector("img")?.alt || url.pathname.split("/").pop()};
      const thumb = link.querySelector("img[src]");
      // Do not hijack navigation (e.g. profile avatars linking to settings).
      if (thumb && localURL(thumb.src)?.href === url.href) return {url: url.href, name: thumb.alt || "图片"};
    } else if (link.matches("img[data-image-preview][src]")) {
      const url = localURL(link.dataset.imagePreview || link.src);
      if (url) return {url: url.href, name: link.dataset.imageName || link.alt};
    }
    return null;
  }
  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.className = "xt-image-viewer";
    dialog.setAttribute("aria-label", "图片查看器");
    dialog.innerHTML = `<div class="xt-iv-shell">
      <header class="xt-iv-bar"><span class="xt-iv-name" data-iv-name></span>
        <div class="xt-iv-tools" aria-label="图片操作">
          <button type="button" data-iv-action="out" title="缩小（-）" aria-label="缩小">−</button>
          <span class="xt-iv-zoom" data-iv-zoom>100%</span>
          <button type="button" data-iv-action="in" title="放大（+）" aria-label="放大">+</button>
          <button type="button" data-iv-action="fit" title="还原大小（0）">适应</button>
          <button type="button" data-iv-action="rotate" title="顺时针旋转 90°（R）">旋转</button>
          <button type="button" data-iv-action="copy">复制</button>
          <button type="button" data-iv-action="download">下载</button>
          <button type="button" data-iv-action="close" title="关闭（Esc）" aria-label="关闭">×</button>
        </div></header>
      <div class="xt-iv-stage" data-iv-stage><img data-iv-image alt="" draggable="false" hidden></div>
      <p class="xt-iv-status" data-iv-status role="status" aria-live="polite"></p>
    </div>`;
    document.body.append(dialog);
    picture = dialog.querySelector("[data-iv-image]");
    caption = dialog.querySelector("[data-iv-name]");
    status = dialog.querySelector("[data-iv-status]");
    dialog.addEventListener("click", event => {
      const button = event.target.closest("[data-iv-action]");
      if (button) { event.preventDefault(); action(button.dataset.ivAction); }
      else if (event.target === dialog) close();
    });
    dialog.addEventListener("close", () => { if (!dialog.open) cleanup(); });
    dialog.addEventListener("keydown", event => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.target.matches("input,textarea")) return;
      const key = {"+":"in", "=":"in", "-":"out", "_":"out", "0":"fit", "r":"rotate", "R":"rotate"}[event.key];
      if (key) { event.preventDefault(); action(key); }
    });
    const stage = dialog.querySelector("[data-iv-stage]");
    stage.addEventListener("wheel", event => {
      if (!imageBlob) return;
      event.preventDefault(); action(event.deltaY < 0 ? "in" : "out");
    }, {passive:false});
    stage.addEventListener("pointerdown", event => {
      if (!imageBlob || event.button !== 0) return;
      pointer = {id:event.pointerId, x:event.clientX, y:event.clientY};
      stage.setPointerCapture?.(event.pointerId);
    });
    stage.addEventListener("pointermove", event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      offsetX += event.clientX - pointer.x; offsetY += event.clientY - pointer.y;
      pointer.x = event.clientX; pointer.y = event.clientY; draw();
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) stage.addEventListener(type, () => { pointer = null; });
    return dialog;
  }
  function draw() {
    if (!picture) return;
    picture.style.transform = `translate(${offsetX}px, ${offsetY}px) rotate(${rotation}deg) scale(${scale})`;
    dialog.querySelector("[data-iv-zoom]").textContent = `${Math.round(scale * 100)}%`;
  }
  function setStatus(text) { if (status) status.textContent = text; }
  function cleanup() {
    ++generation;
    controller?.abort(); controller = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null; imageBlob = null; currentURL = null; pointer = null;
    if (picture) { picture.removeAttribute("src"); picture.hidden = true; }
    const focus = returnFocus; returnFocus = null;
    if (focus?.isConnected) focus.focus({preventScroll:true});
  }
  function close() {
    if (!dialog) return;
    if (dialog.open) dialog.close();
    cleanup();
  }
  // Discussion uploads deliberately use application/octet-stream, even for PNG/JPEG/WebP.
  // Verify magic bytes rather than trusting an extension or the caller-supplied filename.
  async function rasterBlob(blob) {
    if (blob.size > MAX_BYTES) throw new Error("图片超过 100 MiB，无法在查看器中加载。");
    const header = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const start = (...bytes) => bytes.every((byte, index) => header[index] === byte);
    const word = (index, value) => value.split("").every((char, i) => header[index + i] === char.charCodeAt(0));
    let mime;
    if (start(137, 80, 78, 71, 13, 10, 26, 10)) mime = "image/png";
    else if (start(255, 216, 255)) mime = "image/jpeg";
    else if (word(0, "RIFF") && word(8, "WEBP")) mime = "image/webp";
    else if (word(0, "GIF87a") || word(0, "GIF89a")) mime = "image/gif";
    else if (start(66, 77)) mime = "image/bmp";
    else if (word(4, "ftyp") && (word(8,"avif") || word(8,"avis"))) mime = "image/avif";
    if (!mime || !TYPES.has(mime)) throw new Error("附件不是支持的图片格式，请使用原下载方式查看。");
    return new Blob([blob], {type:mime});
  }
  async function open(url, name = "图片", origin = document.activeElement) {
    const safe = localURL(url);
    if (!safe) throw new Error("只能在站内查看图片");
    ensureDialog();
    // A previous fetch may still be in progress; invalidate before changing images.
    if (dialog.open) cleanup();
    returnFocus = origin;
    currentURL = safe.href;
    caption.textContent = filename(name);
    setStatus("正在加载图片…");
    picture.hidden = true;
    scale = 1; rotation = 0; offsetX = offsetY = 0; draw();
    if (!dialog.open) dialog.showModal();
    const sequence = ++generation;
    controller = new AbortController();
    try {
      const response = await fetch(safe.href, {credentials:"same-origin", signal:controller.signal, cache:"no-store"});
      if (!response.ok) throw new Error(response.status === 401 ? "登录已失效" : response.status === 403 ? "没有查看权限" : response.status === 404 ? "图片不存在或已删除" : `读取失败（${response.status}）`);
      const size = Number(response.headers.get("Content-Length"));
      if (size > MAX_BYTES) throw new Error("图片超过 100 MiB，无法在查看器中加载。");
      const blob = await rasterBlob(await response.blob());
      if (sequence !== generation || !dialog.open) return;
      const src = URL.createObjectURL(blob);
      objectUrl = src; imageBlob = blob;
      picture.onload = () => { if (sequence === generation) { picture.hidden = false; setStatus("滚轮缩放 · 拖动移动 · Esc 关闭"); } };
      picture.onerror = () => { if (sequence === generation) { picture.hidden = true; setStatus("图片解码失败或浏览器不支持此格式"); imageBlob = null; } };
      picture.src = src;
    } catch (error) {
      if (sequence === generation && error.name !== "AbortError") setStatus(error.message || "无法打开图片");
    }
  }
  async function copy() {
    if (!imageBlob) return;
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") { setStatus("当前浏览器不支持复制图片，请使用下载按钮。"); return; }
    try {
      // ClipboardItem PNG is consistently supported, unlike direct WebP/JPEG clipboard data.
      const canvas = document.createElement("canvas");
      canvas.width = picture.naturalWidth; canvas.height = picture.naturalHeight;
      if (!canvas.width || !canvas.height) throw new Error("图片尚未加载完成");
      if (canvas.width * canvas.height > 32_000_000) throw new Error("图片像素过多，建议下载后复制");
      canvas.getContext("2d").drawImage(picture, 0, 0);
      const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (!png) throw new Error("图片无法转换为 PNG");
      await navigator.clipboard.write([new ClipboardItem({"image/png":png})]);
      setStatus("已复制图片到剪贴板");
    } catch (error) { setStatus(`复制失败：${error.message || "浏览器未授予剪贴板权限"}`); }
  }
  function download() {
    if (!currentURL) return;
    const link = document.createElement("a");
    link.href = objectUrl || currentURL; link.download = caption.textContent || "图片";
    document.body.append(link); link.click(); link.remove();
    setStatus("已发起下载");
  }
  function action(operation) {
    if (operation === "close") { close(); return; }
    if (operation === "download") { download(); return; }
    if (!imageBlob) return;
    if (operation === "in") scale = clamp(Math.round(scale * 125) / 100, .1, 8);
    if (operation === "out") scale = clamp(Math.round(scale * 80) / 100, .1, 8);
    if (operation === "fit") { scale = 1; rotation = 0; offsetX = offsetY = 0; }
    if (operation === "rotate") rotation = (rotation + 90) % 360;
    if (operation === "copy") { void copy(); return; }
    draw();
  }
  document.addEventListener("click", event => {
    // The packaged clients keep their existing native attachment transport.
    if (window.XTYF?.invoke) return;
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = event.target?.closest?.("a[href],img[data-image-preview]");
    const resource = sourceFor(target);
    if (!resource) return;
    event.preventDefault(); event.stopPropagation();
    void open(resource.url, resource.name, target).catch(error => window.BusinessUI?.notify?.(error.message));
  }, true);
  return {open, close, canPreview, sourceFor};
})();
