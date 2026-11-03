/* AI Chat 桌面版 —— preload
 * 在页面里提供与 Android 版完全相同的 window.AndroidBridge（同名、同参数、同步/异步语义一致）：
 *   request(id, method, url, headersJson, body, timeoutSec)  异步；结果通过 window.__nativeHttp.onStart/onChunk/onEnd/onError 回调
 *   cancel(id)                                              异步
 *   storeGet(name) -> string|null                           同步
 *   storeSet(name, value) -> boolean                        同步
 *   storeDelete(name)                                       同步
 *   copy(text) / openUrl(url) / toast(text) / saveImage(src) 异步
 *   readAsset(path) -> base64 string                        同步
 * 另外加上桌面习惯：Enter 发送（Shift+Enter 换行）、Esc / 鼠标侧键 = 返回、拖拽 / 粘贴文件添加附件。
 */
'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const str = v => (v == null ? '' : String(v));

const bridge = {
  request(id, method, url, headersJson, body, timeoutSec) {
    ipcRenderer.send('bridge:request', str(id), str(method), str(url), str(headersJson), str(body), Number(timeoutSec) || 0);
  },
  cancel(id) { ipcRenderer.send('bridge:cancel', str(id)); },
  storeGet(name) { const v = ipcRenderer.sendSync('bridge:storeGet', str(name)); return v == null ? null : v; },
  storeSet(name, value) { return ipcRenderer.sendSync('bridge:storeSet', str(name), str(value)) === true; },
  storeDelete(name) { ipcRenderer.sendSync('bridge:storeDelete', str(name)); },
  // v0.9.0
  storeExists(name) { return ipcRenderer.sendSync('bridge:storeExists', str(name)) === true; },
  storeRename(from, to) { return ipcRenderer.sendSync('bridge:storeRename', str(from), str(to)) === true; },
  storeList() { return ipcRenderer.sendSync('bridge:storeList') || '[]'; },
  storeAppend(name, text) { return ipcRenderer.sendSync('bridge:storeAppend', str(name), str(text)) === true; },
  registerProvider(id, baseUrl, authType) { return ipcRenderer.sendSync('bridge:registerProvider', str(id), str(baseUrl), str(authType)) || 'error'; },
  setSecret(kind, id, value) { return ipcRenderer.sendSync('bridge:setSecret', str(kind), str(id), str(value)) === true; },
  hasSecret(kind, id) { return ipcRenderer.sendSync('bridge:hasSecret', str(kind), str(id)) === true; },
  deleteSecret(kind, id) { ipcRenderer.sendSync('bridge:deleteSecret', str(kind), str(id)); },
  clearSecrets() { ipcRenderer.sendSync('bridge:clearSecrets'); },
  requestForProvider(id, providerId, method, url, headersJson, body, timeoutSec) {
    ipcRenderer.send('bridge:requestForProvider', str(id), str(providerId), str(method), str(url), str(headersJson), str(body), Number(timeoutSec) || 0);
  },
  copy(text) { ipcRenderer.send('bridge:copy', str(text)); },
  openUrl(url) { ipcRenderer.send('bridge:openUrl', str(url)); },
  readAsset(p) { return ipcRenderer.sendSync('bridge:readAsset', str(p)) || ''; },
  toast(text) { showToast(str(text)); },
  saveImage(src) { ipcRenderer.send('bridge:saveImage', str(src)); },
  // 桌面版额外标记（Android 上不存在，网页代码不依赖它）
  isDesktop: true,
  platform: process.platform,
};
contextBridge.exposeInMainWorld('AndroidBridge', bridge);

// ---------------- Toast（复用页面里的 #toast 样式） ----------------
let toastTimer = null;
function showToast(text) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}
ipcRenderer.on('desktop:toast', (_e, text) => showToast(text));

// ---------------- 桌面交互 ----------------
function back() {
  // window.onAndroidBack 在页面主世界里定义，通过 executeJavaScript 调用
  return webFrame.executeJavaScript('window.onAndroidBack ? window.onAndroidBack() : false').catch(() => false);
}

function feedFiles(fileList) {
  const input = document.getElementById('file-input');
  if (!input || !fileList || !fileList.length) return false;
  const dt = new DataTransfer();
  for (const f of fileList) dt.items.add(f);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('desktop');
  if (process.platform === 'win32') document.documentElement.classList.add('desktop-win');

  // Enter 发送，Shift+Enter 换行；输入法组字时不触发
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
      back();
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229) return;
    const t = e.target;
    if (!t || t.id !== 'input') return;
    e.preventDefault();
    const btn = document.getElementById('btn-send');
    if (btn && !btn.disabled && !btn.classList.contains('stop')) btn.click();
  }, true);

  // 鼠标侧键「后退」
  window.addEventListener('mouseup', e => { if (e.button === 3) { e.preventDefault(); back(); } });

  // 拖拽文件到窗口 = 添加附件；同时阻止拖入文件时页面跳转
  window.addEventListener('dragover', e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('drop', e => {
    e.preventDefault();
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) {
      const attach = document.getElementById('btn-attach');
      // 生图模式等不允许附件时，沿用页面自己的提示逻辑
      if (document.getElementById('composer-card') && document.getElementById('composer-card').classList.contains('imgmode')) { attach && attach.click(); return; }
      feedFiles(files);
    }
  });

  // 在输入框粘贴图片 / 文件 = 添加附件
  document.addEventListener('paste', e => {
    const t = e.target;
    if (!t || t.id !== 'input') return;
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) {
      if (document.getElementById('composer-card') && document.getElementById('composer-card').classList.contains('imgmode')) return;
      e.preventDefault();
      feedFiles(files);
    }
  }, true);
});
