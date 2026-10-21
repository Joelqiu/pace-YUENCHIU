import { DurableObject } from "cloudflare:workers";

const MAX_POINTS = 20000;
const MAX_MESSAGE = 64 * 1024;

export class LiveRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS room_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS track_points (seq INTEGER PRIMARY KEY, point TEXT NOT NULL);`);
  }

  meta() {
    const row = this.sql.exec("SELECT value FROM room_meta WHERE key='session'").toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }

  saveMeta(value) {
    this.sql.exec("INSERT INTO room_meta (key,value) VALUES ('session',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(value));
  }

  send(socket, value) {
    try { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }
    catch { try { socket.close(1011, "同步連線錯誤"); } catch {} }
  }

  broadcast(value) {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, value);
  }

  sendTrack(socket, after = 0) {
    const meta = this.meta();
    if (!meta) return;
    this.send(socket, { type: "snapshot", session: {
      id: meta.id, classId: meta.classId, lessonId: meta.lessonId, alias: meta.alias,
      status: meta.status, startedAt: meta.startedAt, endedAt: meta.endedAt,
      expiresAt: meta.expiresAt, stats: meta.stats, updatedAt: meta.updatedAt,
    }, after });
    let rows = this.sql.exec("SELECT seq,point FROM track_points WHERE seq>? ORDER BY seq", after).toArray();
    while (rows.length) {
      const batch = rows.splice(0, 250).map(row => ({ seq: row.seq, point: JSON.parse(row.point) }));
      this.send(socket, { type: "points", points: batch });
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/init" && request.method === "POST") {
      const data = await request.json();
      if (!this.meta()) {
        this.saveMeta({ ...data, status: "active", stats: { seconds: 0, meters: 0, steps: 0, cadence: 0 }, updatedAt: Date.now() });
        await this.ctx.storage.setAlarm(data.expiresAt);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/finish" && request.method === "POST") {
      const meta = this.meta();
      if (!meta) return new Response("not found", { status: 404 });
      const data = await request.json();
      this.saveMeta({ ...meta, status: "finished", endedAt: data.endedAt, expiresAt: data.expiresAt, updatedAt: Date.now() });
      await this.ctx.storage.setAlarm(data.expiresAt);
      this.broadcast({ type: "state", status: "finished", endedAt: data.endedAt });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/delete" && request.method === "POST") {
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.close(1000, "即時紀錄已刪除"); } catch {}
      }
      await this.ctx.storage.deleteAll();
      return Response.json({ ok: true });
    }
    if (url.pathname !== "/connect" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("not found", { status: 404 });
    }

    const meta = this.meta();
    if (!meta || meta.expiresAt <= Date.now()) return new Response("即時紀錄不存在或已過保存期限。", { status: 404 });
    const userId = request.headers.get("X-PACE-USER") || "";
    const role = request.headers.get("X-PACE-ROLE") || "";
    if (!((role === "owner" && userId === meta.ownerId) || (role === "teacher" && userId === meta.classOwnerId))) {
      return new Response("沒有此即時軌跡的存取權。", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, userId });
    this.sendTrack(server, Number(url.searchParams.get("after") || 0));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== "string" || message.length > MAX_MESSAGE) return socket.close(1009, "訊息過大");
    let data;
    try { data = JSON.parse(message); }
    catch { return socket.close(1003, "訊息格式錯誤"); }
    const attachment = socket.deserializeAttachment() || {};
    const meta = this.meta();
    if (!meta || meta.expiresAt <= Date.now()) return socket.close(1008, "即時紀錄已過期");
    if (attachment.role !== "owner" || attachment.userId !== meta.ownerId) return socket.close(1008, "此連線僅供觀看");

    if (data.type === "resume") {
      const after = Math.max(0, Math.min(MAX_POINTS, Math.floor(Number(data.after) || 0)));
      this.sendTrack(socket, after);
      return;
    }
    if (data.type === "point") {
      const seq = Number(data.seq), point = data.point || {};
      if (!Number.isInteger(seq) || seq < 1 || seq > MAX_POINTS || !Number.isFinite(point.lat) || Math.abs(point.lat) > 90 ||
        !Number.isFinite(point.lng) || Math.abs(point.lng) > 180 || !Number.isFinite(point.t) ||
        !Number.isFinite(point.accuracy) || point.accuracy < 0 || point.accuracy > 1000 ||
        !Number.isInteger(point.segment) || point.segment < 0 || point.segment > MAX_POINTS) {
        return this.send(socket, { type: "error", message: "定位點資料無效。" });
      }
      this.sql.exec("INSERT OR IGNORE INTO track_points (seq,point) VALUES (?,?)", seq, JSON.stringify({
        lat: point.lat, lng: point.lng, t: point.t, accuracy: point.accuracy, segment: point.segment,
      }));
      this.broadcast({ type: "point", seq, point: {
        lat: point.lat, lng: point.lng, t: point.t, accuracy: point.accuracy, segment: point.segment,
      } });
      this.send(socket, { type: "ack", seq });
      return;
    }
    if (data.type === "stats") {
      const stats = data.stats || {};
      const seconds = Number(stats.seconds), meters = Number(stats.meters), steps = Number(stats.steps), cadence = Number(stats.cadence);
      if (![seconds, meters, steps, cadence].every(Number.isFinite) || seconds < 0 || seconds > 10800 || meters < 0 || meters > 500000 || steps < 0 || steps > 100000 || cadence < 0 || cadence > 500) {
        return this.send(socket, { type: "error", message: "運動摘要資料無效。" });
      }
      const state = stats.status === "paused" ? "paused" : "active";
      const updated = { ...meta, status: state, stats: { seconds: Math.round(seconds), meters: Number(meters.toFixed(1)), steps: Math.round(steps), cadence: Math.round(cadence) }, updatedAt: Date.now() };
      this.saveMeta(updated);
      this.broadcast({ type: "stats", status: state, stats: updated.stats, updatedAt: updated.updatedAt });
      this.send(socket, { type: "ack", stats: true });
      return;
    }
    this.send(socket, { type: "error", message: "不支援的同步訊息。" });
  }

  webSocketClose(socket, code, reason, wasClean) {
    try { socket.close(code, reason); } catch {}
  }

  webSocketError(socket) {
    try { socket.close(1011, "同步連線中斷"); } catch {}
  }

  async alarm() {
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(1000, "即時定位保存期限已到"); } catch {}
    }
    await this.ctx.storage.deleteAll();
  }
}
