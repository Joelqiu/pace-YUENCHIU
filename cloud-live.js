(() => {
  'use strict';
  const API = 'api/';
  const QUEUE_KEY = 'campus-live-pending-v1';
  const byId = id => document.getElementById(id);
  const h = (tag, text, cls) => { const el = document.createElement(tag); if (text) el.textContent = text; if (cls) el.className = cls; return el; };
  const urlFor = path => new URL(path, location.href).href;
  let shareReady = false, currentClass = '', currentSession = null;

  async function api(path, options = {}) {
    const response = await fetch(urlFor(path), { cache: 'no-store', credentials: 'same-origin', ...options,
      headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers });
    let data;
    try { data = await response.json(); }
    catch { throw Object.assign(new Error(response.redirected ? '請先登入班級中心，再啟用即時同步。' : '即時同步服務尚未部署。'), { status: response.status }); }
    if (!response.ok) throw Object.assign(new Error(data.error || '即時同步請求失敗。'), { status: response.status });
    return data;
  }

  function insertSetup() {
    const fields = byId('fields');
    if (!fields || byId('liveSyncSetup')) return;
    const box = h('section', '', 'live-sync-setup');
    box.id = 'liveSyncSetup';
    const consentLabel = h('label', '', 'check live-sync-check');
    const consent = document.createElement('input'); consent.type = 'checkbox'; consent.id = 'liveSyncConsent';
    const consentText = h('span', '分享本次運動的 GPS 軌跡與運動數值，讓自己及此課程的授權教師即時查看。');
    consentLabel.append(consent, consentText);
    const pickers = h('div', '', 'live-sync-pickers'); pickers.id = 'liveSyncPickers'; pickers.hidden = true;
    const classLabel = h('label', '班級'); const classSelect = document.createElement('select'); classSelect.id = 'liveSyncClass'; classSelect.required = false; classLabel.append(classSelect);
    const lessonLabel = h('label', '課程'); const lessonSelect = document.createElement('select'); lessonSelect.id = 'liveSyncLesson'; lessonSelect.required = false; lessonLabel.append(lessonSelect);
    pickers.append(classLabel, lessonLabel);
    const message = h('p', '未勾選時不會上傳 GPS；本機運動紀錄照常保存。取消即時分享不影響本次運動記錄。', 'fine');
    const auth = h('a', '登入班級中心以啟用同步 →', 'live-sync-login'); auth.href = urlFor('api/classroom?op=reauth'); auth.hidden = true;
    const status = h('p', '', 'live-sync-config-status'); status.id = 'liveSyncConfigStatus';
    box.append(consentLabel, pickers, message, auth, status);
    const consentExisting = byId('consent')?.closest('label');
    if (consentExisting) consentExisting.after(box); else fields.append(box);
    consent.addEventListener('change', () => {
      pickers.hidden = !consent.checked;

    });
    classSelect.addEventListener('change', () => loadLessons(classSelect.value));
    bootstrapShareOptions().catch(error => {
      if (error.status === 404) { box.hidden = true; return; }
      auth.hidden = false;
      status.textContent = '登入後可選擇班級，運動期間的定位才會上傳。';
    });
  }

  async function bootstrapShareOptions() {
    await api('api/live/config');
    const who = await api('api/classroom?op=me');
    if (who.teacher) {
      byId('liveSyncConfigStatus').textContent = '教師帳號可在班級中心檢視已授權的即時運動。';
      byId('liveSyncSetup').hidden = true;
      return;
    }
    const rows = (await api('api/classroom?op=classes')).classes.filter(x => x.status === 'active');
    const select = byId('liveSyncClass'); select.replaceChildren();
    if (!rows.length) {
      byId('liveSyncConfigStatus').textContent = '先在班級中心加入班級並等待教師核准，之後即可選擇課程分享。';
      return;
    }
    for (const row of rows) {
      const option = document.createElement('option'); option.value = row.id; option.textContent = row.title;
      select.append(option);
    }
    shareReady = true;
    select.disabled = false;
    await loadLessons(select.value);
    byId('liveSyncConfigStatus').textContent = '定位只分享給本人及所選課程教師；運動結束 24 小時後自動清除，期間可由本人或該班教師提前刪除。';
  }

  async function loadLessons(classId) {
    const select = byId('liveSyncLesson');
    if (!select || !classId) return;
    select.replaceChildren();
    const rows = (await api(`api/classroom?op=lessons&classId=${encodeURIComponent(classId)}`)).lessons.filter(x => !x.closed_at);
    for (const row of rows) {
      const option = document.createElement('option'); option.value = row.id; option.textContent = row.title;
      select.append(option);
    }
    if (!rows.length) {
      const option = document.createElement('option'); option.value = ''; option.textContent = '目前沒有開放中的課程'; select.append(option);
    }
    select.disabled = !rows.length;
  }

  function sessionLink(id) { return urlFor(`live.html?id=${encodeURIComponent(id)}`); }
  function renderStatus(text, href) {
    const status = byId('liveSyncStatus'); if (!status) return;
    status.replaceChildren(h('span', text));
    if (href) {
      const link = h('a', '開啟電腦儀表板 ↗'); link.href = href; link.target = '_blank'; link.rel = 'noopener';
      const copy = h('button', '複製儀表板連結'); copy.type = 'button';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(href); copy.textContent = '已複製連結'; }
        catch { copy.textContent = '請複製網址列連結'; }
      });
      status.append(link, copy);
    }
  }

  function readQueue() {
    try { const value = JSON.parse(localStorage.getItem(QUEUE_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; }
    catch { return {}; }
  }
  function writeQueue(queue) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); }
    catch { renderStatus('同步暫存空間不足；本機運動仍會儲存，請保持連線。'); }
  }

  const live = {
    runId: null, serverId: null, socket: null, points: [], ack: 0, nextSeq: 0,
    lastStats: 0, lastStatus: '', finishPending: false, finishRequested: false, finishRetryAt: 0, startPromise: null, retryAt: 0,
    async start(session, classId, lessonId) {
      this.runId = String(session.id); this.points = []; this.ack = 0; this.nextSeq = 0; this.finishPending = false; this.finishRequested = false; this.finishRetryAt = 0; this.retryAt = 0;
      this.meta = { classId, lessonId, alias: session.alias || '' };
      this.loadPending();
      await this.ensureRemote();
    },
    loadPending() {
      const item = readQueue()[this.runId];
      if (!item) return;
      this.points = Array.isArray(item.points) ? item.points : [];
      this.ack = Number(item.ack) || 0;
      this.nextSeq = this.points.reduce((n, p) => Math.max(n, p.seq), this.ack);
      this.finishPending = Boolean(item.finishPending);
    },
    persistPending() {
      const all = readQueue();
      if (this.points.length || this.finishPending) all[this.runId] = { points: this.points, ack: this.ack, finishPending: this.finishPending };
      else delete all[this.runId];
      writeQueue(all);
    },
    async ensureRemote() {
      if (!this.runId || this.serverId || this.startPromise || Date.now() < this.retryAt) return this.startPromise;
      this.startPromise = api('api/live/sessions', { method: 'POST', body: JSON.stringify({
        clientId: this.runId, classId: this.meta.classId, lessonId: this.meta.lessonId, consent: true,
      }) }).then(data => {
        this.serverId = data.id;
        currentSession = data.id;
        this.connect();
        renderStatus('正在同步 GPS 與運動資料', sessionLink(data.id));
        if (this.finishPending && !this.points.length) void this.finishRemote();
      }).catch(error => {
        this.retryAt = Date.now() + 5000;
        renderStatus(`即時同步連線失敗：${error.message}；本機仍會記錄，稍後重試。`);
      }).finally(() => { this.startPromise = null; });
      return this.startPromise;
    },
    connect() {
      if (!this.serverId || this.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.socket.readyState)) return;
      const target = new URL(urlFor(`api/live/${encodeURIComponent(this.serverId)}/socket`));
      target.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(target); this.socket = socket;
      socket.onopen = () => {
        renderStatus('即時同步中', sessionLink(this.serverId));
        socket.send(JSON.stringify({ type: 'resume', after: this.ack }));
        this.flush();
      };
      socket.onmessage = event => this.receive(event.data);
      socket.onclose = () => { if (this.socket === socket && this.serverId) renderStatus('同步暫時中斷；資料保留在本機並等待重連。', sessionLink(this.serverId)); };
      socket.onerror = () => { try { socket.close(); } catch {} };
    },
    receive(raw) {
      let data; try { data = JSON.parse(raw); } catch { return; }
      if (data.type === 'ack' && Number.isInteger(data.seq)) {
        this.ack = Math.max(this.ack, data.seq); this.points = this.points.filter(point => point.seq > this.ack); this.persistPending();
        if (this.finishPending && !this.points.length) this.finishRemote();
      }
      if (data.type === 'error') renderStatus(`同步訊息：${data.message}`, this.serverId ? sessionLink(this.serverId) : '');
    },
    point(point) {
      if (!this.runId || !point || this.nextSeq >= 20000) {
        if (this.nextSeq === 20000) renderStatus('即時軌跡已達 20,000 點上限；本機仍會完整記錄。');
        return;
      }
      const seq = ++this.nextSeq;
      this.points.push({ seq, point: { lat: point.lat, lng: point.lng, t: point.t, accuracy: point.accuracy, segment: point.segment } });
      this.persistPending(); this.flush();
    },
    flush() {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      for (const item of this.points) this.socket.send(JSON.stringify({ type: 'point', seq: item.seq, point: item.point }));
    },
    stats(state) {
      if (!this.runId || !this.serverId || Date.now() - this.lastStats < 5000) return;
      this.lastStats = Date.now();
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'stats', stats: state }));
    },
    async finish(state) {
      if (!this.runId || this.finishRequested) return;
      this.finishRequested = true;
      this.finishPending = true; this.persistPending();
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'stats', stats: { ...state, status: 'finished' } }));
        this.flush();
      }
      await this.finishRemote();
    },
    async finishRemote() {
      if (!this.serverId || !this.finishPending || this.points.length || Date.now() < this.finishRetryAt) return;
      try {
        await api(`api/live/${encodeURIComponent(this.serverId)}/finish`, { method: 'POST', body: '{}' });
        this.finishPending = false; this.persistPending();
        renderStatus('運動已完成；即時軌跡保存 24 小時', sessionLink(this.serverId));
      } catch { this.finishRetryAt = Date.now() + 5000; renderStatus('運動已結束；等待連線恢復後補上結束狀態。', sessionLink(this.serverId)); }
    },
  };
  window.PaceLive = live;

  function insertLiveStatus() {
    const panel = document.querySelector('.session-panel');
    if (!panel || byId('liveSyncStatus')) return;
    const node = h('div', '', 'live-sync-status'); node.id = 'liveSyncStatus';
    node.append(h('span', '未啟用即時同步')); panel.append(node);
  }

  function setupClassroom() {
    const teacher = byId('teacherDashboard'), student = byId('studentPanel');
    if (teacher && !byId('teacherLiveSessions')) {
      const box = h('section', '', 'class-card live-class-card'); box.id = 'teacherLiveSessions';
      box.append(h('h3', '即時運動軌跡'), h('p', '只有本人與此班教師可查看；紀錄在運動結束 24 小時後自動清除。', 'fine'));
      const rows = h('div', '', 'live-session-list'); rows.id = 'teacherLiveRows'; box.append(rows);
      teacher.prepend(box);
    }
    if (student && !byId('studentLiveSessions')) {
      const box = h('section', '', 'student-live-card'); box.id = 'studentLiveSessions';
      box.append(h('h3', '我的即時運動'), h('div', '', 'live-session-list'));
      box.querySelector('div').id = 'studentLiveRows'; student.append(box);
    }
  }

  async function refreshClassroom() {
    const select = byId('classSelect');
    if (!select || !select.value) return;
    try {
      const who = await api('api/classroom?op=me');
      setupClassroom();
      if (who.teacher) {
        const rows = (await api(`api/live/class/${encodeURIComponent(select.value)}`)).sessions;
        const root = byId('teacherLiveRows'); if (!root) return;
        root.replaceChildren();
        if (!rows.length) root.append(h('p', '目前沒有尚在保存期限內的即時運動。'));
        for (const row of rows) addLiveRow(root, row);
      } else {
        const rows = (await api('api/live/mine')).sessions;
        const root = byId('studentLiveRows'); if (!root) return;
        root.replaceChildren();
        if (!rows.length) root.append(h('p', '尚無即時同步紀錄。'));
        for (const row of rows) addLiveRow(root, row);
      }
    } catch { /* 既有班級頁面會顯示 API 登入或連線錯誤。 */ }
  }

  function addLiveRow(root, row) {
    const item = h('article', '', 'live-session-row');
    const info = h('div'); info.append(h('strong', `${row.alias} · ${row.class_title || row.lesson_title || '即時運動'}`));
    info.append(h('small', `${row.status === 'finished' ? '已結束' : row.status === 'paused' ? '已暫停' : '進行中'} · ${new Date(row.started_at).toLocaleString('zh-TW')}`));
    const link = h('a', '查看軌跡 →', 'outline'); link.href = sessionLink(row.id); item.append(info, link); root.append(item);
  }

  function pollApp() {
    const state = window.PaceSessionState?.();
    if (!state || state.demo) return;
    if (state.liveSyncConsent && (!live.runId || live.runId !== String(state.id))) {
      if (!shareReady) { renderStatus('即時同步尚未就緒；本機仍會儲存運動紀錄。'); return; }
      if (!byId('liveSyncClass')?.value || !byId('liveSyncLesson')?.value) { renderStatus('請選擇有開放課程的班級；本機仍會儲存運動紀錄。'); return; }
      live.start(state, byId('liveSyncClass')?.value, byId('liveSyncLesson')?.value).catch(() => {});
    }
    if (!live.runId || live.runId !== String(state.id)) return;
    while (live.nextSeq < state.points.length && live.nextSeq < 20000) live.point(state.points[live.nextSeq]);
    if (live.nextSeq >= 20000 && state.points.length > 20000) renderStatus('即時軌跡已達 20,000 點上限；本機仍會完整記錄。');
    const elapsed = Math.max(0, Math.round(state.seconds));
    const cadence = elapsed ? Math.round((state.steps * 60) / elapsed) : 0;
    live.stats({ status: state.state === 'paused' ? 'paused' : state.state === 'finished' ? 'finished' : 'active',
      seconds: elapsed, meters: state.meters, steps: state.steps, cadence });
    if (state.state === 'finished' && !live.finishRequested) live.finish({ seconds: elapsed, meters: state.meters, steps: state.steps, cadence }).catch(() => {});
    if (state.state === 'finished' && live.finishPending && !live.points.length) live.finishRemote();
    if (live.serverId && (!live.socket || live.socket.readyState === WebSocket.CLOSED)) live.connect();
    if (!live.serverId && !live.startPromise) live.ensureRemote();
  }

  insertSetup();
  insertLiveStatus();
  setupClassroom();
  setInterval(pollApp, 1000);
  setInterval(refreshClassroom, 7000);
  document.addEventListener('change', event => { if (event.target?.id === 'classSelect' || event.target?.id === 'lessonSelect') refreshClassroom(); });
})();
