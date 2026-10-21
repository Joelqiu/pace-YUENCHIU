# PACE 校園運動

PACE 可以在瀏覽器本機記錄 GPS 運動，也提供選擇性班級雲端功能。沒有部署雲端版時，運動與匯出功能仍可在 GitHub Pages 等靜態網站使用；班級登入、繳交及即時軌跡只在 Cloudflare Worker 版啟用。

## 雲端功能

- Cloudflare Worker 提供班級 API 與靜態網站資源。
- D1 保存班級、課程、成員、摘要繳交與即時紀錄索引。
- Durable Objects WebSocket 房間轉送即時運動數值與 GPS 點。
- Cloudflare Access 驗證登入；教師角色另由伺服器的 `TEACHER_EMAILS` 清單決定。
- 即時軌跡須在每次運動前另外勾選同意，只分享給本人與該班教師；運動結束 24 小時後自動刪除。
- 手動繳交課堂摘要不包含完整 GPS 軌跡。

## Cloudflare 部署

依照 [Cloudflare 部署與驗收說明](CLOUDFLARE_DEPLOY.md) 建立 D1、設定 Access、套用資料表並部署 Worker。`wrangler.jsonc` 中的資料庫 ID、Access Team Domain 與 Audience 需要填入自己的環境值；教師 email 必須用 Worker secret 設定。

部署前不要把學生軌跡 JSON、CSV、真實 email 或 `.dev.vars` 放進倉庫。

## 專案檔案

- `app.js`、`core.js`：手機 GPS、步數估算、運動紀錄與匯出。
- `cloud-live.js`、`live.html`、`live.js`：GPS 同意、離線暫存、即時同步與電腦地圖。
- `classroom.js`、`server/worker.js`：班級頁面及 API。
- `server/live-room.js`：WebSocket 即時房間與軌跡保存。
- `server/migrations/`：D1 schema。
- `sw.js`：離線快取。API 回應不會放進快取。
