# Cloudflare 雲端版部署

此部署會讓 Cloudflare Worker 同時提供網站資源與班級 API。GitHub Pages 仍可保留本機 GPS 功能，但沒有雲端 API；要使用即時同步，學生與教師都要開啟 Worker 的網站網址。

## 1. 建立 Cloudflare 資源

1. 在 Cloudflare 帳號中建立 D1 資料庫：

   ```powershell
   npx wrangler d1 create pace-yuanchiu
   ```

2. 將輸出的資料庫 ID 填入 `wrangler.jsonc` 的 `d1_databases[0].database_id`。
3. 將 `ACCESS_TEAM_DOMAIN` 改成自己的 Access Team Domain，例如 `https://school.cloudflareaccess.com`。在 Zero Trust 的 Access application 設定中建立自用網站應用程式，保護 Worker 網址下的 `/api/*` 路徑。
4. 讓預期使用者都符合 Access 的登入政策。教師也必須登入；教師權限另由 `TEACHER_EMAILS` 決定。
5. 將 Access application 的 Audience Tag 填入 `ACCESS_AUD`。

Access 會在送到 Worker 的請求附上 `Cf-Access-Jwt-Assertion`。Worker 會向 Team Domain 讀取公開簽章金鑰，驗證簽章、issuer、audience、有效期限與 email；只檢查請求標頭不足以驗證登入。參考 [Access JWT 驗證說明](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。

## 2. 設定教師名單與資料表

教師 email 不要寫在前端、`wrangler.jsonc` 或 Git。使用 Worker secret 設定逗號分隔的教師名單：

```powershell
npx wrangler secret put TEACHER_EMAILS
```

依提示輸入教師 email，例如 `teacher1@example.edu,teacher2@example.edu`。不在名單內的已登入使用者會以學生角色使用服務。

套用 D1 資料表：

```powershell
npx wrangler d1 migrations apply pace-yuanchiu --remote
```

本專案使用 Durable Objects SQLite storage 保存即時點位；Wrangler 部署時會套用 `LiveRoom` 類別遷移。

## 3. 部署 Worker 與網站

```powershell
npx wrangler deploy
```

Wrangler 會部署 Worker 與靜態網站資源。`/api/*` 由 Worker 處理，其餘檔案由 Static Assets 提供。參考 [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/) 與 [D1 Wrangler migrations](https://developers.cloudflare.com/d1/wrangler-commands/)。

## 4. 上線前人工驗收

- 登入名單包含的教師帳號，確認可建立班級；以學生帳號登入並申請加入，教師核准後再選擇開放課程。
- 在手機開始運動前，逐次確認即時 GPS 分享選項；未勾選時不得建立即時軌跡。
- 手機與電腦使用同一個 Worker 網址及已登入帳號。運動中確認電腦地圖、時間、距離、估算步數與步頻會更新。
- 以另一個無權限帳號開啟同一連結，確認讀取被拒絕；本人或班級教師可查看及刪除。
- 以斷線後恢復連線的方式確認點位會補送；運動結束後確認停止更新，並在結束 24 小時後無法再讀取。
- 以 iPhone Safari、Android Chrome 分別完成實機流程；瀏覽器省電、背景暫停與 GPS 精度仍可能影響更新，網頁無法保證固定取樣頻率。

尚未完成這些 Cloudflare 帳號設定與手機實測前，雲端即時同步屬於已準備程式、未上線驗收的功能。
