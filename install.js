/* Installation help only; no access to pronunciation or query state. */
(() => {
  const KEY = 'fayin-install-dismissed-until';
  const hint = document.querySelector('#install-hint');
  const dialog = document.querySelector('#install-dialog');
  const nativeButton = document.querySelector('#native-install');
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let prompt = null;
  let dismissedUntil = Infinity; // Storage disabled: do not repeatedly nag.
  try { dismissedUntil = Number(localStorage.getItem(KEY) || 0); } catch (_) { /* help remains available */ }
  hint.hidden = standalone() || !mobile || Date.now() < dismissedUntil;
  function dismiss() {
    hint.hidden = true;
    try { localStorage.setItem(KEY, String(Date.now() + 30 * 86400000)); } catch (_) { /* optional */ }
  }
  function openHelp() {
    document.querySelector('#install-platform-note').textContent = standalone()
      ? '你已在独立应用窗口中使用。'
      : '按当前设备选择下面的方法，添加后仍保留原来的查询体验。';
    dialog.showModal();
    dismiss();
  }
  document.querySelector('#install-button').addEventListener('click', openHelp);
  document.querySelector('#install-hint-open').addEventListener('click', openHelp);
  document.querySelector('#install-hint-dismiss').addEventListener('click', dismiss);
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    prompt = event;
    nativeButton.hidden = standalone();
  });
  nativeButton.addEventListener('click', async () => {
    if (!prompt) return;
    const current = prompt;
    prompt = null;
    nativeButton.hidden = true;
    try { await current.prompt(); await current.userChoice; } catch (_) { /* manual instructions remain */ }
    dismiss();
  });
  window.addEventListener('appinstalled', () => {
    prompt = null;
    nativeButton.hidden = true;
    dismiss();
    document.querySelector('#install-platform-note').textContent = '已安装。以后可以从主屏幕或应用列表打开。';
  });
})();
