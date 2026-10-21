'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('id') || '';
  const apiUrl = suffix => new URL(`api/live/${encodeURIComponent(sessionId)}${suffix}`, location.href).href;
  const api = async (url, options = {}) => {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
    let data;
    try { data = await response.json(); }
    catch { throw new Error(response.redirected ? '登入後可查看授權的即時軌跡。' : '即時同步服務目前無法讀取。'); }
    if (!response.ok) throw new Error(data.error || '目前沒有查看權限。');
    return data;
  };

  let map, socket, metadata, stats = { seconds: 0, meters: 0, steps: 0, cadence: 0 }, lastSeq = 0;
  let lines = new Map(), points = new Map(), reconnectTimer, reconnectDelay = 1000;

  function message(text) { $('liveMessage').textContent = text; }
  function duration(seconds) {
    const value = Math.max(0, Math.floor(seconds || 0));
    return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  }
  function renderStats() {
    $('liveDistance').textContent = (Number(stats.meters || 0) / 1000).toFixed(2);
    $('liveElapsed').textContent = duration(stats.seconds);
    $('liveSteps').textContent = Number.isFinite(stats.steps) ? Math.round(stats.steps).toLocaleString('zh-TW') : '—';
    $('liveCadence').textContent = Number(stats.cadence) ? `${Math.round(stats.cadence)} 步/分` : '—';
    $('livePointCount').textContent = String(points.size);
  }
  function renderStatus(status) {
    const label = status === 'finished' ? '已結束' : status === 'paused' ? '已暫停' : '運動中';
    $('liveStatus').textContent = label;
  }
  function routePoint(seq, point) {
    if (!Number.isInteger(seq) || seq <= lastSeq || !Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) return;
    lastSeq = seq;
    points.set(seq, point);
    const segment = Number.isInteger(point.segment) ? point.segment : 0;
    let line = lines.get(segment);
    if (!line) { line = L.polyline([], { color: '#d95432', weight: 5, lineCap: 'round', lineJoin: 'round' }).addTo(map); lines.set(segment, line); }
    line.addLatLng([point.lat, point.lng]);
    $('liveAccuracy').textContent = Number.isFinite(point.accuracy) ? `±${Math.round(point.accuracy)} m` : '—';
    if (points.size === 1) map.setView([point.lat, point.lng], 17);
    renderStats();
  }
  function clearLines() { for (const line of lines.values()) map.removeLayer(line); lines = new Map(); points = new Map(); lastSeq = 0; }
  function handle(raw) {
    let data; try { data = JSON.parse(raw); } catch { return; }
    if (data.type === 'snapshot') {
      metadata = data.session || metadata;
      if (metadata) { renderStatus(metadata.status); stats = metadata.stats || stats; }
      renderStats();
      return;
    }
    if (data.type === 'points' && Array.isArray(data.points)) {
      for (const item of data.points) routePoint(item.seq, item.point);
      return;
    }
    if (data.type === 'point') { routePoint(data.seq, data.point); return; }
    if (data.type === 'stats') { stats = data.stats || stats; renderStatus(data.status); renderStats(); return; }
    if (data.type === 'state') { renderStatus(data.status); message('運動已結束；這筆即時軌跡會在保存期限後自動清除。'); }
  }
  function connect() {
    if (!metadata || socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
    const url = new URL(apiUrl('/socket'));
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('after', String(lastSeq));
    socket = new WebSocket(url);
    socket.onopen = () => { reconnectDelay = 1000; $('liveStatus').textContent = '已連線'; message('正在接收即時定位與運動數值。'); };
    socket.onmessage = event => handle(event.data);
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (metadata?.status !== 'finished') {
        $('liveStatus').textContent = '重新連線中';
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(15000, reconnectDelay * 2);
      }
    };
  }
  async function load() {
    if (!sessionId) throw new Error('網址缺少即時紀錄識別碼。');
    if (!window.L) throw new Error('地圖載入失敗；請檢查網路後重整。');
    map = L.map('liveMap').setView([24.1796, 120.6495], 14);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    addBaseMap(map);
    $('centerTrack').addEventListener('click', () => {
      const layers = [...lines.values()];
      const bounds = L.featureGroup(layers).getBounds();
      if (bounds.isValid()) map.fitBounds(bounds.pad(.15));
    });
    const data = await api(apiUrl('/info'));
    metadata = data;
    $('liveTitle').textContent = data.classTitle || '即時運動軌跡';
    $('liveSubtitle').textContent = `${data.lessonId ? '課程即時檢視' : '即時檢視'} · 開始於 ${new Date(data.startedAt).toLocaleString('zh-TW')}`;
    $('liveAlias').textContent = data.alias || '運動者';
    renderStatus(data.status);
    $('deleteLive').hidden = false;
    $('deleteLive').addEventListener('click', async () => {
      if (!confirm('永久刪除此筆即時軌跡與運動資料？')) return;
      try { await api(apiUrl('/delete'), { method: 'DELETE' }); message('即時紀錄已刪除。'); metadata.status = 'finished'; $('liveStatus').textContent = '已刪除'; $('deleteLive').disabled = true; socket?.close(); }
      catch (error) { message(error.message); }
    });
    connect();
  }
  $('liveLogin').href = new URL('api/classroom?op=login', location.href).href;
  load().catch(error => { message(error.message); $('liveStatus').textContent = '無法載入'; $('liveLogin').hidden = false; });
})();
