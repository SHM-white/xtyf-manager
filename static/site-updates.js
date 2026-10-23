"use strict";
document.addEventListener('DOMContentLoaded', () => {
  const banner = document.querySelector('[data-site-update-banner]');
  if (!banner) return;
  const storageKey = 'xtyf-site-release-seen:' + banner.dataset.userId;
  const close = banner.querySelector('[data-site-update-close]');
  const detail = banner.querySelector('[data-site-update-detail]');
  const summary = banner.querySelector('[data-site-update-summary]');
  let current = '';
  let acknowledged = '';
  try {
    acknowledged = window.localStorage.getItem(storageKey) || '';
  } catch (_) {
    // Private browsing may deny storage; the notice still works for this page.
  }

  const dismiss = () => {
    if (!current) return;
    acknowledged = current;
    try {
      window.localStorage.setItem(storageKey, current);
    } catch (_) { /* Storage is optional. */ }
    banner.hidden = true;
  };
  close?.addEventListener('click', dismiss);
  detail?.addEventListener('click', dismiss);

  const refresh = async () => {
    if (document.hidden) return;
    try {
      const response = await fetch(banner.dataset.siteUpdateApi, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) return;
      const data = await response.json();
      if (!data.available || !/^[0-9a-f]{40}$/.test(data.commit || '')) {
        banner.hidden = true;
        return;
      }
      current = data.commit;
      if (summary) summary.textContent = data.latest_subject || '新版本已上线，点击查看本次更新内容。';
      banner.hidden = current === acknowledged;
    } catch (_) {
      // A transient outage must not interrupt the rest of the workspace.
    }
  };
  void refresh();
  window.setInterval(refresh, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  window.addEventListener('focus', () => { if (!document.hidden) void refresh(); });
});
