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
});
