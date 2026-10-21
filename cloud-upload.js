'use strict';
(() => {
  const dialog = document.createElement('dialog');
  dialog.id = 'submitDialog';
  dialog.innerHTML = `<div class="dialog-head"><h2>繳交到班級</h2><button class="close" id="closeUpload" aria-label="關閉繳交">×</button></div>
    <p class="cloud-upload-status" id="uploadStatus"></p>
    <form id="uploadForm">
      <label>班級<select id="uploadClass" required></select></label>
      <label>課程<select id="uploadLesson" required></select></label>
      <label class="upload-consent"><input type="checkbox" id="uploadConsent" required><span>同意將這次運動時間與距離提交給任課教師。不提交身體資料或完整 GPS 軌跡。</span></label>
      <fieldset class="reflection-fields"><legend>運動後反思（選填）</legend>
        <label>這次運動的感受<select id="reflectionEffort"><option value="">不填寫</option><option value="easy">輕鬆</option><option value="moderate">剛好</option><option value="hard">吃力</option></select></label>
        <label>路線或 GPS 紀錄觀察<textarea id="reflectionText" maxlength="200" rows="3" placeholder="最多 200 字；請勿填寫姓名或健康資料"></textarea></label>
        <label class="upload-consent"><input type="checkbox" id="reflectionConsent"><span>同意讓任課教師查看本次反思</span></label>
      </fieldset>
      <button class="primary" id="submitRecordBtn">確認繳交</button>
    </form><a class="cloud-link" href="classroom.html">加入班級／查看雲端紀錄 →</a>`;
  document.body.append(dialog);
  const $ = id => document.getElementById(id);
  let record;

  async function api(op, data = {}, write = false) {
    const response = await fetch('/api/classroom' + (write ? '' : '?' + new URLSearchParams({ op, ...data })), {
      method: write ? 'POST' : 'GET',
      headers: write ? { 'Content-Type': 'application/json' } : {},
      body: write ? JSON.stringify({ op, ...data }) : undefined,
      cache: 'no-store', credentials: 'same-origin',
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error('無法連接班級服務：這個網址可能只部署了靜態檔案，或尚未登入。'); }
    if (!response.ok) throw new Error(result.error || '班級資料操作失敗。');
    return result;
  }

  function option(select, value, label) {
    const item = document.createElement('option'); item.value = value; item.textContent = label; select.append(item);
  }

  async function loadLessons() {
    $('uploadLesson').replaceChildren();
    if (!$('uploadClass').value) return;
    const rows = (await api('lessons', { classId: $('uploadClass').value })).lessons.filter(item => !item.closed_at);
    rows.forEach(item => option($('uploadLesson'), item.id, item.title));
    $('submitRecordBtn').disabled = !rows.length;
    if (!rows.length) $('uploadStatus').textContent = '這個班級目前沒有開放繳交的課程。';
  }

  window.PaceSubmit = async value => {
    record = value;
    $('uploadConsent').checked = false;
    $('reflectionConsent').checked = false;
    $('reflectionEffort').value = '';
    $('reflectionText').value = '';
    $('uploadForm').hidden = true;
    $('uploadStatus').textContent = '連接班級資料庫…';
    dialog.showModal();
    try {
      if (record.demo) throw new Error('示範紀錄不能繳交。');
      const classes = (await api('classes')).classes.filter(item => item.status === 'active');
      $('uploadClass').replaceChildren();
      if (!classes.length) throw new Error('尚無已核准班級。請先至班級中心加入並等待教師核准。');
      classes.forEach(item => option($('uploadClass'), item.id, item.title));
      $('uploadForm').hidden = false;
      $('uploadStatus').textContent = `本次 ${(record.meters / 1000).toFixed(2)} km · ${(record.seconds / 60).toFixed(1)} 分鐘。每人每堂課限繳交一筆。`;
      await loadLessons();
    } catch (error) { $('uploadStatus').textContent = error.message; }
  };

  $('closeUpload').onclick = () => dialog.close();
  $('uploadClass').onchange = () => loadLessons().catch(error => $('uploadStatus').textContent = error.message);
  $('uploadForm').onsubmit = async event => {
    event.preventDefault();
    $('submitRecordBtn').disabled = true;
    try {
      const effort = $('reflectionEffort').value;
      const reflection = $('reflectionText').value.trim();
      const reflectionConsent = $('reflectionConsent').checked;
      if ((effort || reflection) && !reflectionConsent) throw new Error('若要提交反思，請另外勾選反思授權；也可清空反思後只繳交運動摘要。');
      const { id, date, seconds, meters, demo, state } = record;
      await api('submit', {
        classId: $('uploadClass').value,
        lessonId: $('uploadLesson').value,
        consent: $('uploadConsent').checked,
        reflectionConsent,
        record: { id, date, seconds, meters, demo, state, pointCount: record.points.length,
          effort: reflectionConsent ? effort : '', reflection: reflectionConsent ? reflection : '' },
      }, true);
      $('uploadStatus').textContent = '已成功繳交。教師可在班級中心查看摘要與你另外授權的反思。';
      $('uploadForm').hidden = true;
    } catch (error) { $('uploadStatus').textContent = error.message; }
    finally { $('submitRecordBtn').disabled = false; }
  };
})();
