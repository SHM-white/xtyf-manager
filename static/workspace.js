"use strict";
document.addEventListener('DOMContentLoaded', () => {
  const button = document.querySelector('[data-ws-menu]');
  const overlay = document.querySelector('[data-ws-close]');
  if (!button) return;
  const setOpen = (open) => {
    document.body.classList.toggle('ws-menu-open', open);
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? '关闭主导航' : '打开主导航');
  };
  button.addEventListener('click', () => setOpen(!document.body.classList.contains('ws-menu-open')));
  overlay?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 850) setOpen(false);
  });
  const pendingLink = document.getElementById('fundsPendingBadge');
  if (!pendingLink) return;
  const badge = pendingLink.querySelector('.nav-badge');
  let request = 0;
  const updateBadge = async () => {
    if (document.hidden) return;
    const own = ++request;
    let count = 0;
    try {
      const response = await BusinessUI.fetch('/funds/api/pending_review', {credentials: 'same-origin'});
      if (response.ok) {
        const data = await response.json();
        if (data.code === 0 && Number.isSafeInteger(data.count) && data.count > 0) count = data.count;
      }
    } catch (_) {
      // A failed read must not display an outdated count.
    }
    if (own !== request) return;
    badge.textContent = String(count);
    pendingLink.setAttribute('aria-label', '待审核资金记录，' + count + ' 条');
    if (!count && document.activeElement === pendingLink) pendingLink.previousElementSibling.focus();
    pendingLink.hidden = !count;
  };
  window.refreshFundsBadge = updateBadge;
  updateBadge();
  setInterval(updateBadge, 30000);
  document.addEventListener('visibilitychange', updateBadge);
});
