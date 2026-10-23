'use strict';
(() => {
  const configured = String(window.PACE_API_BASE || '').trim();
  const apiOrigin = new URL(configured || location.origin, location.href).origin;
  if (!apiOrigin.startsWith('https://') && apiOrigin !== location.origin) {
    throw new Error('雲端 API 必須使用 HTTPS。');
  }

  function url(path) {
    const target = path instanceof URL ? new URL(path.href) : new URL(String(path), `${apiOrigin}/`);
    if (target.origin !== apiOrigin) throw new TypeError('API URL 超出已設定的服務來源。');
    return target.href;
  }

  function fetchApi(path, options = {}) {
    const target = new URL(url(path));
    const credentials = target.origin === location.origin ? (options.credentials || 'same-origin') : 'include';
    return fetch(target.href, { cache: 'no-store', ...options, credentials });
  }

  function loginUrl(returnTo = location.href) {
    const target = new URL(url('/api/classroom?op=login'));
    if (target.origin !== location.origin) target.searchParams.set('returnTo', returnTo);
    return target.href;
  }

  function logoutUrl(returnTo = location.href) {
    const target = new URL(url('/cdn-cgi/access/logout'));
    target.searchParams.set('returnTo', returnTo);
    return target.href;
  }

  window.PaceApi = Object.freeze({ url, fetch: fetchApi, loginUrl, logoutUrl, origin: apiOrigin });
})();
