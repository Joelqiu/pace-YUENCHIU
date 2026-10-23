# Cloudflare merge-test 環境

此環境只供 `cloudflare-merge-test` 分支測試，正式 Worker 與正式 D1 保持獨立。

## 已建立資源

- Worker：`pace-yuanchiu-merge-test`
- 測試網址：<https://pace-yuanchiu-merge-test.pace-yuenchiu.workers.dev>
- D1：`pace-yuanchiu-merge-test`（初始 migration 已套用）
- Pages API 允許來源：`https://joelqiu.github.io`

`wrangler.merge-test.jsonc` 是測試部署設定。請勿用正式的 `wrangler.jsonc` 部署此分支，也不要把正式 D1 ID 填入測試設定。

## 尚待設定：Cloudflare Access

測試 Worker 的 API 預設要求有效的 Access JWT。測試 Access application 建立前，API 會拒絕請求；目前設定中的 Audience 是佔位值。

1. 在 Cloudflare Zero Trust 建立 Self-hosted Access application，主機設為上方測試 Worker，路徑限於 `/api/*`。
2. Access policy 只允許指定測試帳號；不要使用 `Everyone`。請由管理者決定哪些測試帳號可以進入。
3. 在該 application 啟用「Bypass OPTIONS requests to origin」，讓 Worker 對預檢請求執行精確來源檢查。
4. 將 application 產生的 Audience Tag 填入 `wrangler.merge-test.jsonc` 的 `ACCESS_AUD`，再重新部署：

   ```powershell
   npx.cmd --yes wrangler deploy --config wrangler.merge-test.jsonc
   ```

5. 若要測試教師功能，在本機互動式輸入測試教師 email 到測試 Worker secret；不要提交 email 或 token：

   ```powershell
   npx.cmd --yes wrangler secret put TEACHER_EMAILS --config wrangler.merge-test.jsonc
   ```

## Pages 與跨站登入

`api-config.js` 將 Pages API 指向測試 Worker。Worker 只接受設定內列出的 Pages 來源，寫入請求仍需通過 Access 驗證。登入完成後，Worker 只會把瀏覽器導回 Pages 專案路徑。

GitHub Pages 目前仍由 `main` 發佈，因此測試分支尚無獨立 GitHub Pages 預覽網址。可先用 Worker 測試網址檢查雲端版；最終從 GitHub Pages 發出的跨站 Access Cookie 行為，仍須在不更動 `main` 的預覽來源上驗收後，才適合切換正式 Pages。
