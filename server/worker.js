import { LiveRoom } from "./live-room.js";

export { LiveRoom };

const nowIso = () => new Date().toISOString();
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});
const fail = (message, status = 400) => json({ error: message }, status);
const id = () => crypto.randomUUID();
const teacherEmails = env => new Set((env.TEACHER_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean));
const activeRetentionMs = env => Math.max(1, Math.min(168, Number(env.LIVE_RETENTION_HOURS) || 24)) * 60 * 60 * 1000;
let accessKeys = null, accessKeysFetchedAt = 0;

function base64UrlBytes(text) {
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - standard.length % 4) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

async function loadAccessKeys(teamDomain, force = false) {
  if (!force && accessKeys && Date.now() - accessKeysFetchedAt < 5 * 60 * 1000) return accessKeys;
  const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("無法讀取 Access 驗證金鑰。");
  const payload = await response.json();
  if (!Array.isArray(payload.keys)) throw new Error("Access 金鑰格式錯誤。");
  accessKeys = payload.keys;
  accessKeysFetchedAt = Date.now();
  return accessKeys;
}

async function verifyAccessToken(request, env) {
  const rawTeamDomain = String(env.ACCESS_TEAM_DOMAIN || "").trim().replace(/\/$/, "");
  const audience = String(env.ACCESS_AUD || "").trim();
  if (!rawTeamDomain || !audience) throw Object.assign(new Error("尚未設定 Cloudflare Access 身分驗證。"), { status: 503 });
  const teamUrl = new URL(rawTeamDomain);
  if (teamUrl.protocol !== "https:" || teamUrl.pathname !== "/") throw Object.assign(new Error("Cloudflare Access Team Domain 設定錯誤。"), { status: 503 });
  const teamDomain = teamUrl.origin;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw Object.assign(new Error("請先登入 PACE 班級服務。"), { status: 401 });
  const parts = token.split(".");
  if (parts.length !== 3) throw Object.assign(new Error("Access 登入資訊無效，請重新登入。"), { status: 401 });

  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(base64UrlBytes(parts[1])));
    if (header.alg !== "RS256" || !header.kid) throw new Error("unsupported token");
    const now = Math.floor(Date.now() / 1000);
    const claimAudiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.type !== "app" || claims.iss !== teamDomain || !claimAudiences.includes(audience) || !Number.isFinite(claims.exp) || claims.exp < now - 60 ||
      Number.isFinite(claims.nbf) && claims.nbf > now + 60 || !claims.sub || !claims.email) throw new Error("invalid claims");

    let keys = await loadAccessKeys(teamDomain);
    let jwk = keys.find(key => key.kid === header.kid && key.kty === "RSA");
    if (!jwk) { keys = await loadAccessKeys(teamDomain, true); jwk = keys.find(key => key.kid === header.kid && key.kty === "RSA"); }
    if (!jwk) throw new Error("unknown signing key");
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) throw new Error("invalid signature");
    return { sub: String(claims.sub), teacher: teacherEmails(env).has(String(claims.email).trim().toLowerCase()) };
  } catch {
    throw Object.assign(new Error("Access 登入資訊無效或已過期，請重新登入。"), { status: 401 });
  }
}

async function identity(request, env) {
  if (env.ENVIRONMENT === "development" && env.DEV_USER_EMAIL) {
    const email = env.DEV_USER_EMAIL.trim().toLowerCase();
    const devUserId = String(env.DEV_USER_ID || "local-user").trim().slice(0, 80);
    return { sub: `dev:${devUserId}`, teacher: teacherEmails(env).has(email) };
  }
  return verifyAccessToken(request, env);
}

async function body(request) {
  try { return await request.json(); }
  catch { throw Object.assign(new Error("請求資料格式錯誤。"), { status: 400 }); }
}

async function requireTeacherClass(db, classId, userId) {
  return db.prepare("SELECT * FROM classes WHERE id = ? AND owner_id = ?").bind(classId, userId).first();
}

async function requireMember(db, classId, userId, activeOnly = true) {
  const condition = activeOnly ? " AND status = 'active'" : "";
  return db.prepare(`SELECT * FROM members WHERE class_id = ? AND user_id = ?${condition}`).bind(classId, userId).first();
}

async function classroom(request, env, ctx, user) {
  const url = new URL(request.url);
  const data = request.method === "POST" ? await body(request) : Object.fromEntries(url.searchParams);
  const op = String(data.op || url.searchParams.get("op") || "");
  const db = env.DB;

  if (op === "login" && request.method === "GET") return Response.redirect(new URL("/classroom.html", url), 302);
  if (op === "me" && request.method === "GET") return json({ teacher: user.teacher });

  if (op === "classes" && request.method === "GET") {
    if (user.teacher) {
      const rows = await db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM members m WHERE m.class_id=c.id) AS enrolled
        FROM classes c WHERE c.owner_id=? ORDER BY c.created_at DESC`).bind(user.sub).all();
      return json({ classes: rows.results || [] });
    }
    const rows = await db.prepare(`SELECT c.id,c.title,m.alias,m.status,c.capacity,m.joined_at
      FROM members m JOIN classes c ON c.id=m.class_id WHERE m.user_id=? ORDER BY m.joined_at DESC`).bind(user.sub).all();
    return json({ classes: rows.results || [] });
  }

  if (op === "createClass" && request.method === "POST") {
    if (!user.teacher) return fail("只有授權教師可以建立班級。", 403);
    const title = String(data.title || "").trim().slice(0, 80);
    const capacity = Number(data.capacity);
    if (!title || !Number.isInteger(capacity) || capacity < 1 || capacity > 60) return fail("請輸入班級名稱及 1–60 人的名額。", 400);
    const classId = id(), code = Array.from(crypto.getRandomValues(new Uint8Array(12)), x => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[x % 32]).join("");
    await db.prepare("INSERT INTO classes (id,owner_id,title,join_code,capacity,created_at) VALUES (?,?,?,?,?,?)")
      .bind(classId, user.sub, title, code, capacity, nowIso()).run();
    return json({ id: classId, join_code: code }, 201);
  }

  if (op === "join" && request.method === "POST") {
    if (user.teacher) return fail("教師帳號不能以學生身分加入。", 403);
    const code = String(data.code || "").trim().toUpperCase();
    const alias = String(data.alias || "").trim().slice(0, 24);
    if (!code || !alias) return fail("請輸入班級碼與課堂代號。", 400);
    const memberId = id();
    let result;
    try {
      result = await db.prepare(`INSERT INTO members (id,class_id,user_id,alias,status,joined_at)
        SELECT ?, c.id, ?, ?, 'pending', ? FROM classes c
        WHERE c.join_code=? AND (SELECT COUNT(*) FROM members m WHERE m.class_id=c.id)<c.capacity`)
        .bind(memberId, user.sub, alias, nowIso(), code).run();
    } catch (error) {
      if (String(error?.message || error).includes("members.class_id, members.alias")) {
        return fail("這個班級代號已有人使用，請改用不同代號再送出。", 409);
      }
      throw error;
    }
    if (!result.meta?.changes) return fail("班級碼無效或名額已滿。", 409);
    return json({ id: memberId, status: "pending" }, 201);
  }

  if (op === "lessons" && request.method === "GET") {
    const classId = String(data.classId || "");
    if (!await requireTeacherClass(db, classId, user.sub) && !await requireMember(db, classId, user.sub, false)) return fail("沒有此班級的存取權。", 403);
    const rows = await db.prepare(`SELECT l.*,(SELECT COALESCE(SUM(a.seconds),0) FROM activities a WHERE a.lesson_id=l.id) AS total_seconds
      FROM lessons l WHERE l.class_id=? ORDER BY l.created_at DESC`).bind(classId).all();
    return json({ lessons: rows.results || [] });
  }

  if (op === "createLesson" && request.method === "POST") {
    const classId = String(data.classId || ""), title = String(data.title || "").trim().slice(0, 80), target = Number(data.targetMinutes);
    const activityType = String(data.activityType || "walk"), activityPlan = String(data.activityPlan || "").trim();
    const classGoalMinutes = data.classGoalMinutes === null || data.classGoalMinutes === "" || data.classGoalMinutes === undefined ? null : Number(data.classGoalMinutes);
    if (!user.teacher || !await requireTeacherClass(db, classId, user.sub)) return fail("只有班級教師可以建立課程。", 403);
    if (!title || !Number.isInteger(target) || target < 1 || target > 180 || !["walk", "run", "mixed", "other"].includes(activityType) || activityPlan.length > 500 ||
      classGoalMinutes !== null && (!Number.isInteger(classGoalMinutes) || classGoalMinutes < 1 || classGoalMinutes > 1000000)) return fail("請檢查課程名稱、活動安排及目標時間。", 400);
    const lessonId = id();
    await db.prepare("INSERT INTO lessons (id,class_id,title,target_minutes,activity_type,activity_plan,class_goal_minutes,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(lessonId, classId, title, target, activityType, activityPlan, classGoalMinutes, nowIso()).run();
    return json({ id: lessonId }, 201);
  }

  if (op === "closeLesson" && request.method === "POST") {
    const classId = String(data.classId || ""), lessonId = String(data.lessonId || "");
    if (!user.teacher || !await requireTeacherClass(db, classId, user.sub)) return fail("只有班級教師可以結束課程。", 403);
    await db.prepare("UPDATE lessons SET closed_at=? WHERE id=? AND class_id=? AND closed_at IS NULL")
      .bind(nowIso(), lessonId, classId).run();
    return json({ ok: true });
  }

  if (op === "approve" && request.method === "POST") {
    const classId = String(data.classId || ""), memberId = String(data.memberId || "");
    if (!user.teacher || !await requireTeacherClass(db, classId, user.sub)) return fail("只有班級教師可以審核學生。", 403);
    await db.prepare("UPDATE members SET status='active' WHERE id=? AND class_id=? AND status='pending'").bind(memberId, classId).run();
    return json({ ok: true });
  }

  if (op === "pendingMembers" && request.method === "GET") {
    const classId = String(data.classId || "");
    if (!user.teacher || !await requireTeacherClass(db, classId, user.sub)) return fail("只有班級教師可以查看加入申請。", 403);
    const rows = await db.prepare("SELECT id,alias,joined_at FROM members WHERE class_id=? AND status='pending' ORDER BY joined_at")
      .bind(classId).all();
    return json({ students: rows.results || [] });
  }

  if (op === "removeMember" && request.method === "POST") {
    const classId = String(data.classId || ""), memberId = String(data.memberId || "");
    if (!user.teacher || !await requireTeacherClass(db, classId, user.sub)) return fail("只有班級教師可以管理成員。", 403);
    const member = await db.prepare("SELECT user_id FROM members WHERE id=? AND class_id=?").bind(memberId, classId).first();
    if (member) {
      await purgeLiveSessions(db, env, "SELECT id FROM live_sessions WHERE class_id=? AND owner_id=?", [classId, member.user_id]);
      await db.prepare("DELETE FROM live_sessions WHERE class_id=? AND owner_id=?").bind(classId, member.user_id).run();
    }
    await db.prepare("DELETE FROM members WHERE id=? AND class_id=?").bind(memberId, classId).run();
    return json({ ok: true });
  }

  if (op === "dashboard" && request.method === "GET") {
    const classId = String(data.classId || ""), lessonId = String(data.lessonId || "");
    if (!user.teacher || !await requireTeacherClass(db, classId, user.sub)) return fail("只有班級教師可以查看課堂資料。", 403);
    const rows = await db.prepare(`SELECT m.id,m.alias,m.status,a.id AS activity_id,a.started_at,a.seconds,a.meters,
      a.effort,a.reflection,a.point_count,a.created_at AS submitted_at
      FROM members m LEFT JOIN activities a ON a.member_id=m.id AND a.lesson_id=?
      WHERE m.class_id=? ORDER BY m.alias`).bind(lessonId, classId).all();
    return json({ students: rows.results || [] });
  }

  if (op === "submit" && request.method === "POST") {
    const classId = String(data.classId || ""), lessonId = String(data.lessonId || ""), record = data.record || {};
    const member = await requireMember(db, classId, user.sub);
    const lesson = await db.prepare("SELECT * FROM lessons WHERE id=? AND class_id=?").bind(lessonId, classId).first();
    if (!member || !lesson || lesson.closed_at) return fail("班級或課程無效，或課程已截止。", 403);
    if (data.consent !== true) return fail("請先確認資料繳交同意。", 400);
    const seconds = Number(record.seconds), meters = Number(record.meters);
    const effort = String(record.effort || ""), reflection = String(record.reflection || "").trim();
    const pointCount = Number(record.pointCount), started = new Date(record.date);
    if (!["", "easy", "moderate", "hard"].includes(effort) || reflection.length > 200 ||
      (effort || reflection) && data.reflectionConsent !== true) return fail("請確認反思授權，並限制反思在 200 字內。", 400);
    if (record.demo || record.state !== "finished" || !Number.isFinite(started.getTime()) ||
      !Number.isFinite(seconds) || seconds < 1 || seconds > 43200 || !Number.isFinite(meters) || meters < 0 || meters > 500000 ||
      meters / seconds > 8 ||
      !Number.isInteger(pointCount) || pointCount < 0 || pointCount > 200000) return fail("運動資料超出可接受範圍。", 400);
    try {
      await db.prepare(`INSERT INTO activities (id,class_id,lesson_id,member_id,user_id,client_id,started_at,seconds,meters,effort,reflection,point_count,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id(), classId, lessonId, member.id, user.sub,
        String(record.id || "").slice(0, 80), started.toISOString(), Math.round(seconds), meters, effort, reflection, pointCount, nowIso()).run();
    } catch (error) { return fail("這堂課已有繳交紀錄，或此紀錄已經送出。", 409); }
    return json({ ok: true }, 201);
  }

  if (op === "myActivities" && request.method === "GET") {
    const rows = await db.prepare(`SELECT a.*,l.title AS lesson_title FROM activities a JOIN lessons l ON l.id=a.lesson_id
      WHERE a.user_id=? ORDER BY a.created_at DESC LIMIT 200`).bind(user.sub).all();
    return json({ activities: rows.results || [] });
  }

  if (op === "deleteActivity" && request.method === "POST") {
    const activityId = String(data.activityId || "");
    const result = await db.prepare("DELETE FROM activities WHERE id=? AND user_id=?").bind(activityId, user.sub).run();
    if (!result.meta?.changes) return fail("找不到可刪除的紀錄。", 404);
    return json({ ok: true });
  }

  if (op === "deleteClass" && request.method === "POST") {
    const classId = String(data.classId || "");
    if (!user.teacher || !await requireTeacherClass(db, classId, user.sub)) return fail("只有班級教師可以刪除班級。", 403);
    await purgeLiveSessions(db, env, "SELECT id FROM live_sessions WHERE class_id=?", [classId]);
    await db.batch([
      db.prepare("DELETE FROM activities WHERE class_id=?").bind(classId),
      db.prepare("DELETE FROM live_sessions WHERE class_id=?").bind(classId),
      db.prepare("DELETE FROM lessons WHERE class_id=?").bind(classId),
      db.prepare("DELETE FROM members WHERE class_id=?").bind(classId),
      db.prepare("DELETE FROM classes WHERE id=?").bind(classId),
    ]);
    return json({ ok: true });
  }

  return fail("找不到班級 API 操作。", 404);
}

async function purgeLiveSessions(db, env, query, values) {
  const rows = await db.prepare(query).bind(...values).all();
  await Promise.all((rows.results || []).map(async row => {
    const room = env.LIVE_ROOMS.get(env.LIVE_ROOMS.idFromName(row.id));
    const response = await room.fetch("https://room.internal/delete", { method: "POST" });
    if (!response.ok) throw new Error("無法清除即時軌跡資料。");
  }));
}

async function liveApi(request, env, ctx, user) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/live\/?/, "");
  const db = env.DB;

  if (path === "config" && request.method === "GET") return json({ enabled: true, retentionHours: Number(env.LIVE_RETENTION_HOURS) || 24 });

  if (path === "sessions" && request.method === "POST") {
    const data = await body(request);
    if (data.consent !== true) return fail("開始同步前需要同意把即時定位分享給自己與該課程教師。", 400);
    const classId = String(data.classId || ""), lessonId = String(data.lessonId || "");
    const clientId = String(data.clientId || "").slice(0, 80);
    if (!clientId) return fail("缺少本機運動識別碼。", 400);
    const member = await requireMember(db, classId, user.sub);
    const lesson = await db.prepare("SELECT * FROM lessons WHERE id=? AND class_id=? AND closed_at IS NULL").bind(lessonId, classId).first();
    if (!member || !lesson) return fail("請選擇已核准班級中仍開放的課程。", 403);
    const course = await db.prepare("SELECT owner_id FROM classes WHERE id=?").bind(classId).first();
    const retry = await db.prepare("SELECT id,class_id,lesson_id,alias,status,started_at,expires_at FROM live_sessions WHERE owner_id=? AND client_id=?")
      .bind(user.sub, clientId).first();
    if (retry) {
      const room = env.LIVE_ROOMS.get(env.LIVE_ROOMS.idFromName(retry.id));
      await room.fetch("https://room.internal/init", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: retry.id, classId: retry.class_id, lessonId: retry.lesson_id, ownerId: user.sub,
          classOwnerId: course.owner_id, alias: retry.alias, startedAt: retry.started_at, expiresAt: retry.expires_at }) });
      return json({ id: retry.id, classId: retry.class_id, lessonId: retry.lesson_id, alias: retry.alias, status: retry.status,
        startedAt: retry.started_at, expiresAt: retry.expires_at });
    }
    const previous = await db.prepare("SELECT id FROM live_sessions WHERE owner_id=? AND status IN ('active','paused') AND expires_at>? LIMIT 1")
      .bind(user.sub, Date.now()).first();
    if (previous) return fail("你已有進行中的即時運動；請先結束或刪除該紀錄。", 409);
    const sessionId = id(), startedAt = nowIso(), expiresAt = Date.now() + 3 * 60 * 60 * 1000 + activeRetentionMs(env);
    await db.prepare(`INSERT INTO live_sessions (id,client_id,class_id,lesson_id,owner_id,alias,status,started_at,expires_at)
      VALUES (?,?,?,?,?,?,'active',?,?)`).bind(sessionId, clientId, classId, lessonId, user.sub, member.alias, startedAt, expiresAt).run();
    const room = env.LIVE_ROOMS.get(env.LIVE_ROOMS.idFromName(sessionId));
    await room.fetch("https://room.internal/init", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sessionId, classId, lessonId, ownerId: user.sub, classOwnerId: course.owner_id, alias: member.alias, startedAt, expiresAt }) });
    return json({ id: sessionId, classId, lessonId, alias: member.alias, startedAt, status: "active", expiresAt }, 201);
  }

  if (path === "mine" && request.method === "GET") {
    await db.prepare("DELETE FROM live_sessions WHERE expires_at<=?").bind(Date.now()).run();
    const rows = await db.prepare(`SELECT s.id,s.class_id,s.lesson_id,s.alias,s.status,s.started_at,s.ended_at,s.expires_at,l.title AS lesson_title,c.title AS class_title
      FROM live_sessions s JOIN lessons l ON l.id=s.lesson_id JOIN classes c ON c.id=s.class_id
      WHERE s.owner_id=? AND s.expires_at>? ORDER BY s.started_at DESC LIMIT 50`).bind(user.sub, Date.now()).all();
    return json({ sessions: rows.results || [] });
  }

  const classMatch = path.match(/^class\/([^/]+)$/);
  if (classMatch && request.method === "GET") {
    const classId = decodeURIComponent(classMatch[1]);
    if (!user.teacher || !await requireTeacherClass(db, classId, user.sub)) return fail("只有該班級教師可以查看即時運動。", 403);
    await db.prepare("DELETE FROM live_sessions WHERE expires_at<=?").bind(Date.now()).run();
    const rows = await db.prepare(`SELECT s.id,s.class_id,s.lesson_id,s.alias,s.status,s.started_at,s.ended_at,s.expires_at,l.title AS lesson_title
      FROM live_sessions s JOIN lessons l ON l.id=s.lesson_id WHERE s.class_id=? AND s.expires_at>? ORDER BY s.started_at DESC LIMIT 60`)
      .bind(classId, Date.now()).all();
    return json({ sessions: rows.results || [] });
  }

  const sessionMatch = path.match(/^([^/]+)(?:\/(info|socket|finish|delete))?$/);
  if (!sessionMatch) return fail("找不到即時同步 API。", 404);
  const sessionId = sessionMatch[1], action = sessionMatch[2] || "info";
  const session = await db.prepare("SELECT * FROM live_sessions WHERE id=? AND expires_at>?").bind(sessionId, Date.now()).first();
  if (!session) return fail("即時紀錄不存在或已過保存期限。", 404);
  const owns = session.owner_id === user.sub;
  const teaches = user.teacher && Boolean(await requireTeacherClass(db, session.class_id, user.sub));
  if (!owns && !teaches) return fail("你沒有查看這筆即時定位的權限。", 403);

  if (action === "finish" && request.method === "POST") {
    if (!owns) return fail("只有運動者本人可以結束同步。", 403);
    const endedAt = session.ended_at || nowIso(), expiresAt = session.status === "finished" ? session.expires_at : Date.now() + activeRetentionMs(env);
    if (session.status !== "finished") {
      await db.prepare("UPDATE live_sessions SET status='finished',ended_at=?,expires_at=? WHERE id=? AND owner_id=?")
        .bind(endedAt, expiresAt, sessionId, user.sub).run();
    }
    const room = env.LIVE_ROOMS.get(env.LIVE_ROOMS.idFromName(sessionId));
    const result = await room.fetch("https://room.internal/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endedAt, expiresAt }) });
    if (!result.ok) return fail("運動已結束，但即時紀錄尚未確認保存期限；正在重試。", 503);
    return json({ ok: true, endedAt, expiresAt });
  }

  if (action === "delete" && request.method === "DELETE") {
    const room = env.LIVE_ROOMS.get(env.LIVE_ROOMS.idFromName(sessionId));
    const result = await room.fetch("https://room.internal/delete", { method: "POST" });
    if (!result.ok) return fail("即時軌跡未能完整刪除，請稍後重試。", 503);
    await db.prepare("DELETE FROM live_sessions WHERE id=?").bind(sessionId).run();
    return json({ ok: true });
  }

  if (action === "socket" && request.method === "GET") {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return fail("WebSocket 連線格式錯誤。", 426);
    const room = env.LIVE_ROOMS.get(env.LIVE_ROOMS.idFromName(sessionId));
    const headers = new Headers({ Upgrade: "websocket" });
    headers.set("X-PACE-USER", user.sub);
    headers.set("X-PACE-ROLE", owns ? "owner" : "teacher");
    headers.set("X-PACE-STATUS", session.status);
    headers.set("X-PACE-EXPIRES", String(session.expires_at));
    return room.fetch(new Request("https://room.internal/connect", { method: "GET", headers }));
  }

  if (request.method !== "GET") return fail("此操作只支援讀取。", 405);
  return json({ id: session.id, classId: session.class_id, lessonId: session.lesson_id, alias: session.alias,
    status: session.status, startedAt: session.started_at, endedAt: session.ended_at, expiresAt: session.expires_at,
    isOwner: owns, classTitle: (await db.prepare("SELECT title FROM classes WHERE id=?").bind(session.class_id).first())?.title || "" });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      if (request.method !== "GET" && request.method !== "HEAD" && request.headers.get("Origin") !== url.origin) {
        return fail("跨來源寫入請求已拒絕。", 403);
      }
      const user = await identity(request, env);
      if (url.pathname === "/api/classroom") return await classroom(request, env, ctx, user);
      if (url.pathname.startsWith("/api/live/")) return await liveApi(request, env, ctx, user);
      return fail("找不到 API 路徑。", 404);
    } catch (error) {
      return fail(error.message || "服務暫時無法處理請求。", error.status || 500);
    }
  },
  async scheduled(_event, env) {
    await env.DB.prepare("DELETE FROM live_sessions WHERE expires_at<=?").bind(Date.now()).run();
  },
};
