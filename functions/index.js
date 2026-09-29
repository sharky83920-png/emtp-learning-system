/**
 * EMTP 學習系統 — 推播發送端（Cloud Functions, Gen1）
 *
 * 三種推播（對應使用者需求）：
 *   1) 新公告        announcements 首次發布      → 該班學員
 *   2) 勘誤待處理    question_error_reports 新增  → 指導員 + 後台(admin)
 *   3) 勘誤被回覆    notifications 新增(含 recipientId) → 該回報學員
 *
 * 設計：data-only 訊息 → 由 firebase-messaging-sw.js 自行 showNotification + setAppBadge。
 *      失效 token 自動清除。badge 數字盡量帶該收件者的「未讀總數」。
 */
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

const APP_BASE = "https://sharky83920-png.github.io/emtp-learning-system";

/** 送一批 token，data-only；回傳成功數，並清掉已失效的 token。 */
async function sendToTokens(tokenDocs, { title, body, url, icon, badge, tag }) {
  if (!tokenDocs.length) return 0;
  const tokens = tokenDocs.map((t) => t.token);
  const data = {
    title: title || "EMTP",
    body: body || "",
    url: url || APP_BASE + "/",
  };
  if (icon) data.icon = icon;
  if (tag) data.tag = tag;
  if (badge != null) data.badge = String(badge);

  let dead = [];
  let success = 0;
  // sendEachForMulticast 一次最多 500 個 token
  for (let i = 0; i < tokens.length; i += 500) {
    const slice = tokens.slice(i, i + 500);
    const sliceDocs = tokenDocs.slice(i, i + 500);
    const resp = await messaging.sendEachForMulticast({ tokens: slice, data });
    success += resp.successCount;
    resp.responses.forEach((r, j) => {
      if (!r.success) {
        const code = (r.error && r.error.code) || "";
        if (
          code.includes("registration-token-not-registered") ||
          code.includes("invalid-registration-token") ||
          code.includes("invalid-argument")
        ) {
          dead.push(sliceDocs[j].ref);
        }
      }
    });
  }
  await Promise.all(dead.map((ref) => ref.delete().catch(() => {})));
  return success;
}

/** 算某學員未讀總數：公告未讀 + 個人通知未讀（給 App 角標數字）。 */
async function countStudentUnread(studentId, classId) {
  let n = 0;
  try {
    if (classId) {
      const annSnap = await db
        .collection("announcements")
        .where("classIds", "array-contains", classId)
        .get();
      const now = Date.now();
      annSnap.forEach((d) => {
        const a = d.data();
        if (a.isPublished === false) return;
        const exp = a.expiresAt && a.expiresAt.toMillis ? a.expiresAt.toMillis() : 0;
        if (exp && exp < now) return;
        if (!(a.readBy || []).includes(studentId)) n++;
      });
    }
    const notiSnap = await db
      .collection("notifications")
      .where("recipientId", "==", studentId)
      .where("isRead", "==", false)
      .get();
    n += notiSnap.size;
  } catch (e) {
    console.error("countStudentUnread", e);
  }
  return n;
}

/** 取得指定班級們的「學員」push token。 */
async function tokensForStudentClasses(classIds) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < classIds.length; i += 10) {
    const chunk = classIds.slice(i, i + 10);
    const snap = await db
      .collection("push_tokens")
      .where("role", "==", "student")
      .where("classId", "in", chunk)
      .get();
    snap.forEach((d) => {
      if (seen.has(d.id)) return;
      seen.add(d.id);
      const x = d.data();
      out.push({ token: x.token, ref: d.ref, userId: x.userId, classId: x.classId });
    });
  }
  return out;
}

// ───────────────────────────────────────────────────────────
// 1) 新公告 → 該班學員
// ───────────────────────────────────────────────────────────
exports.onAnnouncement = functions
  .region("us-central1")
  .firestore.document("announcements/{id}")
  .onWrite(async (change) => {
    const after = change.after.exists ? change.after.data() : null;
    if (!after) return null;
    const before = change.before.exists ? change.before.data() : null;

    const publishedNow = after.isPublished !== false;
    const publishedBefore = before ? before.isPublished !== false : false;

    // 只在「首次成為已發布」且尚未推過時送（避免 readBy 更新等再次觸發重複推播）
    if (!publishedNow) return null;
    if (publishedBefore) return null;
    if (after.pushSentAt) return null;

    const classIds = Array.isArray(after.classIds) ? after.classIds : [];
    if (!classIds.length) return null;

    const tokenDocs = await tokensForStudentClasses(classIds);
    if (tokenDocs.length) {
      // 依學員分組，個別算未讀數當角標
      const byUser = {};
      tokenDocs.forEach((t) => {
        (byUser[t.userId] = byUser[t.userId] || { classId: t.classId, docs: [] }).docs.push(t);
      });
      const title = "📢 " + (after.title || "新公告");
      const body = (after.content || "").slice(0, 80);
      await Promise.all(
        Object.keys(byUser).map(async (uid) => {
          const g = byUser[uid];
          const badge = await countStudentUnread(uid, g.classId);
          return sendToTokens(g.docs, {
            title,
            body,
            url: APP_BASE + "/student.html",
            icon: "icon-student-192.png",
            badge,
            tag: "ann-" + change.after.id,
          });
        })
      );
    }
    // 標記已推、避免重複
    await change.after.ref
      .update({ pushSentAt: admin.firestore.FieldValue.serverTimestamp() })
      .catch(() => {});
    return null;
  });

// ───────────────────────────────────────────────────────────
// 2) 勘誤待處理 → 指導員 + 後台
// ───────────────────────────────────────────────────────────
exports.onErrorReport = functions
  .region("us-central1")
  .firestore.document("question_error_reports/{id}")
  .onCreate(async (snap) => {
    const r = snap.data() || {};
    if ((r.status || "pending") !== "pending") return null;

    const tokSnap = await db
      .collection("push_tokens")
      .where("role", "in", ["instructor", "admin"])
      .get();
    const tokenDocs = [];
    tokSnap.forEach((d) => tokenDocs.push({ token: d.data().token, ref: d.ref }));
    if (!tokenDocs.length) return null;

    // 角標 = 目前待處理的「題數」（去重 questionId）
    let pending = 0;
    try {
      const p = await db
        .collection("question_error_reports")
        .where("status", "==", "pending")
        .get();
      const qs = new Set();
      p.forEach((d) => qs.add(d.data().questionId));
      pending = qs.size;
    } catch (e) {
      console.error("pending count", e);
    }

    const body =
      (r.reportedByName || "學員") +
      "（" +
      (r.reportedByClassId || "") +
      "）回報：" +
      (r.reason || "").slice(0, 50);
    await sendToTokens(tokenDocs, {
      title: "⚠️ 新題目勘誤待處理",
      body,
      url: APP_BASE + "/instructor.html",
      icon: "icon-instructor-192.png",
      badge: pending,
    });
    return null;
  });

// ───────────────────────────────────────────────────────────
// 3) 勘誤被回覆（及任何個人通知）→ 收件學員
// ───────────────────────────────────────────────────────────
exports.onNotification = functions
  .region("us-central1")
  .firestore.document("notifications/{id}")
  .onCreate(async (snap) => {
    const n = snap.data() || {};
    if (!n.recipientId) return null;

    const tokSnap = await db
      .collection("push_tokens")
      .where("userId", "==", n.recipientId)
      .get();
    const tokenDocs = [];
    let classId = null;
    tokSnap.forEach((d) => {
      const x = d.data();
      tokenDocs.push({ token: x.token, ref: d.ref });
      classId = x.classId || classId;
    });
    if (!tokenDocs.length) return null;

    const badge = await countStudentUnread(n.recipientId, classId);
    await sendToTokens(tokenDocs, {
      title: n.title || "📩 新通知",
      body: (n.content || "").slice(0, 80),
      url: APP_BASE + "/student.html",
      icon: "icon-student-192.png",
      badge,
    });
    return null;
  });

// ───────────────────────────────────────────────────────────
// 4) 伺服器端抽題 drawQuiz（onCall, asia-east1）
//    學員只收 10 題、不下載整個題庫 → 讀取與「人數 × 題庫」脫鉤。
//    題庫快取在實例記憶體(多人共用, TTL 5 分)；保留「嚴格輪次」(挑刷最少的)。
// ───────────────────────────────────────────────────────────
// 題庫快取（增量更新）：首次全載 → 之後每 ≤60 秒查「updatedAt 之後的改動」合併（一週才幾百題、幾乎 0 讀取）
// → 每 12h 全載一次兜底（清真刪除殘留、補抓漏寫 updatedAt 的路徑如批次匯入）。隱藏題會被增量更新進來、由可見過濾排除。
let _bankMap = null;        // id -> question 物件
let _bankFullAt = 0;        // 上次全載時間(ms)
let _bankSyncAt = 0;        // 已同步到的最大 updatedAt(ms)，增量基準
let _lastIncrAt = 0;        // 上次增量查詢時間(ms)，節流用
const FULL_RELOAD_MS = 12 * 60 * 60 * 1000;
const INCR_MIN_MS = 60 * 1000;
function bankVisibleArray() {
  const out = [];
  _bankMap.forEach((q) => { if (q.isVisible !== false && q.isActive !== false) out.push(q); });
  return out;
}
async function getQuestionBank() {
  const now = Date.now();
  if (!_bankMap || now - _bankFullAt > FULL_RELOAD_MS) {        // 首次 / 12h 兜底：全載
    const snap = await db.collection("questions").get();
    _bankMap = new Map();
    let mx = 0;
    snap.forEach((d) => { const x = d.data(); _bankMap.set(d.id, { id: d.id, ...x }); const u = x.updatedAt && x.updatedAt.toMillis ? x.updatedAt.toMillis() : 0; if (u > mx) mx = u; });
    _bankFullAt = now; _bankSyncAt = mx || now; _lastIncrAt = now;
    return bankVisibleArray();
  }
  if (now - _lastIncrAt >= INCR_MIN_MS) {                       // 增量：每分鐘最多一次，只讀改動的題
    _lastIncrAt = now;
    try {
      const since = admin.firestore.Timestamp.fromMillis(_bankSyncAt);
      const snap = await db.collection("questions").where("updatedAt", ">", since).get();
      let mx = _bankSyncAt;
      snap.forEach((d) => { const x = d.data(); _bankMap.set(d.id, { id: d.id, ...x }); const u = x.updatedAt && x.updatedAt.toMillis ? x.updatedAt.toMillis() : 0; if (u > mx) mx = u; });
      _bankSyncAt = mx;
    } catch (e) { /* 增量查詢失敗（如缺索引）→ 用現有快取、不影響抽題 */ }
  }
  return bankVisibleArray();
}
// 🤖 御史大夫（AI 出題）的虛擬來源 id：AI 題的 createdByClassId 就是它，不是真班級。
const AI_SOURCE_ID = "_AI";
// 水龍頭過濾（與 student.html faucetAllows 同邏輯）
// 🔴 AI 題的防呆：「沒設定水龍頭 / 一個來源都沒開」時，一般題視為全開，但 AI 題一律不放行
//    —— 否則沒設定過水龍頭的班（含未來新開的班）會自動吃到 AI 題，那是使用者沒同意過的。
function faucetAllows(q, fc) {
  const isAI = q.createdByClassId === AI_SOURCE_ID;
  if (!fc || !fc.sources) return !isAI;
  const sources = fc.sources;
  const enabledIds = Object.keys(sources).filter((k) => sources[k] && sources[k].enabled);
  if (enabledIds.length === 0) return !isAI;
  const cfg = q.createdByClassId && sources[q.createdByClassId];
  if (!cfg || !cfg.enabled) return false;
  if (cfg.allMode) return true;
  const bookId = q.source && q.source.bookId;
  const chNum = q.source && q.source.chapterNumber;
  const list = cfg.chapters || [];
  if (bookId && list.includes(bookId + "|*")) return true;
  if (bookId && chNum != null && chNum !== "" && list.includes(bookId + "|" + chNum)) return true;
  return false;
}
// 輪次排序：先洗牌(同層隨機) → 依刷次升冪(刷少的優先)
function orderByRound(arr, counts) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  arr.sort((a, b) => (counts[a.id] || 0) - (counts[b.id] || 0));
  return arr;
}

exports.drawQuiz = functions
  .region("asia-east1")
  .runWith({ minInstances: 1, memory: "256MB" })
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "請先登入");
    const studentId = String((data && data.studentId) || "");
    const classId = String((data && data.classId) || "");
    const mode = data && data.mode === "practice" ? "practice" : "scoring";
    const dim = (data && data.dim) || null;
    const count = Math.min(Math.max(parseInt(data && data.count) || 10, 1), 20);
    const exclude = Array.isArray(data && data.exclude) ? data.exclude.map(String) : [];   // 排除清單（prefetch 傳當前這輪題 id → 下一輪不重複）
    if (!studentId || !classId) throw new functions.https.HttpsError("invalid-argument", "缺少 studentId/classId");

    const [bank, clsDoc, progDoc] = await Promise.all([
      getQuestionBank(),
      db.collection("classes").doc(classId).get(),
      db.collection("student_quiz_progress").doc(studentId).get(),
    ]);
    const fc = (clsDoc.exists && clsDoc.data().settings && clsDoc.data().settings.questionFaucet) || null;
    const counts = (progDoc.exists && progDoc.data().counts) || {};

    let pool = bank.filter((q) => faucetAllows(q, fc));
    if (mode === "practice" && dim) pool = pool.filter((q) => q.derivedDimension === dim);
    if (exclude.length) { const ex = new Set(exclude); pool = pool.filter((q) => !ex.has(q.id)); }   // 排除當前輪 → 整輪抽完才重複
    if (pool.length === 0) return { questions: [], poolSize: 0 };

    orderByRound(pool, counts);
    return { questions: pool.slice(0, count), poolSize: pool.length };
  });

// ═══════════════════════════════════════════════════════════
// 5) 封存＝真的斷線（Auth 帳號停用 + 撤銷憑證 + archived 標記）
//
//    破口（2026-08-19 發現）：封存原本只改 Firestore 文件，Firebase Auth 帳號
//    完全沒動 → 已登入的手機憑證還活著且會自動續期，只要不登出就能繼續做題。
//
//    修法：
//      a) students / instructors 文件的封存狀態一變 → 自動停用/啟用 Auth 帳號
//         （不管從後台按鈕、批次匯入、還是 Firebase Console 手改都會生效）
//      b) 另給 Master 一顆「全體同步」按鈕處理存量（syncArchivedAuth）
//      c) 停用後同時 revokeRefreshTokens：拿不到新 token，舊 token 最多 1 小時失效
//      d) 蓋 custom claim archived=true → firestore.rules 可在資料庫層擋寫入
// ═══════════════════════════════════════════════════════════
const MASTER_EMAIL = "sharky83920@gmail.com";
const fbAuth = admin.auth();

/** 文件是否處於封存狀態（archivedAt 有值 或 isActive===false）。 */
function isArchivedDoc(d) {
  return !!(d && (d.archivedAt || d.isActive === false));
}

/** 找出這筆學員/指導員對應的 Auth 帳號：authUid 優先，其次 email。 */
async function resolveAuthUser(kind, docId, d, cache) {
  if (d.authUid) {
    if (cache && cache.byUid.has(d.authUid)) return cache.byUid.get(d.authUid);
    if (!cache) { try { return await fbAuth.getUser(d.authUid); } catch (e) { /* uid 失效 → 改用 email */ } }
  }
  // 學員登入帳號＝「班級小寫-座號@emtp.local」＝ 文件 id + @emtp.local；指導員用真實 email
  const email = (kind === "student" ? `${docId}@emtp.local` : d.email || "").toLowerCase();
  if (!email) return null;
  if (cache) return cache.byEmail.get(email) || null;
  try { return await fbAuth.getUserByEmail(email); } catch (e) { return null; }
}

/**
 * 學員的「實際封存狀態」＝自己被封存 or 所屬班級被封存。
 * （2026-08-19：發現封存班級不會連動學員，6 個已封存班級底下 225 人帳號全活著）
 * classArchived 傳 Map<classId, bool> 可免逐筆查班級；傳 null 則自己查一次。
 */
async function effectiveArchived(kind, d, classArchived) {
  if (isArchivedDoc(d)) return true;
  if (kind !== "student" || !d.classId) return false;
  if (classArchived) return !!classArchived.get(d.classId);
  const c = await db.collection("classes").doc(d.classId).get();
  return c.exists && isArchivedDoc(c.data());
}

/** 把單一帳號調成目標狀態；已經正確就不打 API（回 changed:false）。 */
async function syncOneAuth(kind, docId, d, cache, classArchived) {
  const archived = await effectiveArchived(kind, d, classArchived);
  const user = await resolveAuthUser(kind, docId, d, cache);
  if (!user) return { changed: false, reason: "no-auth-account", archived };
  const hasClaim = !!(user.customClaims && user.customClaims.archived);
  if (user.disabled === archived && hasClaim === archived) {
    return { changed: false, reason: "already", archived };
  }
  const claims = Object.assign({}, user.customClaims || {});
  if (archived) claims.archived = true; else delete claims.archived;
  await fbAuth.setCustomUserClaims(user.uid, claims);
  await fbAuth.updateUser(user.uid, { disabled: archived });
  if (archived) await fbAuth.revokeRefreshTokens(user.uid);   // 撤銷續期憑證：舊 token 到期後就再也換不到新的
  return { changed: true, reason: "synced", archived, uid: user.uid, email: user.email };
}

/** 文件變動 → 只在「封存狀態真的改變」時同步 Auth（避免每次改成績都打 Auth API）。 */
function makeArchiveTrigger(collectionName, kind) {
  return functions
    .region("us-central1")
    .firestore.document(`${collectionName}/{id}`)
    .onWrite(async (change, context) => {
      const after = change.after.exists ? change.after.data() : null;
      if (!after) return null;                                   // 文件被刪 → 帳號另行處理、不在此動
      const before = change.before.exists ? change.before.data() : null;
      const now = isArchivedDoc(after);
      // 自身封存狀態沒變 → 不動（班級層級的變動交給 onClassArchiveChange 處理，不重複打 Auth API）。
      // 新建的文件一律評估一次：加進「已封存班級」的新學員也要跟著停用。
      if (before && isArchivedDoc(before) === now) return null;
      try {
        const r = await syncOneAuth(kind, context.params.id, after, null, null);
        console.log(`[archiveSync] ${collectionName}/${context.params.id} archived=${now}`, JSON.stringify(r));
      } catch (e) {
        console.error(`[archiveSync] ${collectionName}/${context.params.id} 失敗`, e);
      }
      return null;
    });
}

exports.onStudentArchiveChange = makeArchiveTrigger("students", "student");
exports.onInstructorArchiveChange = makeArchiveTrigger("instructors", "instructor");

/**
 * 班級封存/恢復 → 全班學員連動（使用者定義：封存班級＝該班一律停用，比照個人封存）。
 * 單班最多數十人，逐筆處理並留節流空間，故放寬 timeout/記憶體。
 */
exports.onClassArchiveChange = functions
  .region("us-central1")
  .runWith({ timeoutSeconds: 540, memory: "512MB" })
  .firestore.document("classes/{id}")
  .onWrite(async (change, context) => {
    const after = change.after.exists ? change.after.data() : null;
    if (!after) return null;
    const before = change.before.exists ? change.before.data() : null;
    const now = isArchivedDoc(after);
    if (before && isArchivedDoc(before) === now) return null;   // 封存狀態沒變 → 不動
    const classId = context.params.id;
    const classArchived = new Map([[classId, now]]);
    const snap = await db.collection("students").where("classId", "==", classId).get();
    let changed = 0, failed = 0;
    for (const s of snap.docs) {
      try {
        const r = await syncOneAuth("student", s.id, s.data(), null, classArchived);
        if (r.changed) changed++;
      } catch (e) {
        failed++;
        console.error(`[archiveSync] students/${s.id} 失敗`, e);
      }
    }
    console.log(`[archiveSync] classes/${classId} archived=${now} → 全班 ${snap.size} 人、調整 ${changed} 人、失敗 ${failed} 人`);
    return null;
  });

/** 一次抓完所有 Auth 帳號建索引（420 人只用 1 次 API，不逐筆查）。 */
async function loadAllAuthUsers() {
  const byUid = new Map();
  const byEmail = new Map();
  let pageToken;
  do {
    const res = await fbAuth.listUsers(1000, pageToken);
    res.users.forEach((u) => {
      byUid.set(u.uid, u);
      if (u.email) byEmail.set(u.email.toLowerCase(), u);
    });
    pageToken = res.pageToken;
  } while (pageToken);
  return { byUid, byEmail };
}

/** Master 專用：把所有學員/指導員的 Auth 狀態對齊封存狀態（處理存量、立即強制登出）。 */
exports.syncArchivedAuth = functions
  .region("asia-east1")
  .runWith({ timeoutSeconds: 540, memory: "256MB" })
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "請先登入");
    if (context.auth.token.email !== MASTER_EMAIL) {
      throw new functions.https.HttpsError("permission-denied", "只有 Master 能執行");
    }
    const cache = await loadAllAuthUsers();
    const clsSnap = await db.collection("classes").get();
    const classArchived = new Map(clsSnap.docs.map((c) => [c.id, isArchivedDoc(c.data())]));
    const out = { disabled: [], enabled: [], noAccount: [], unchanged: 0, scanned: 0 };
    for (const [col, kind] of [["students", "student"], ["instructors", "instructor"]]) {
      const snap = await db.collection(col).get();
      for (const docSnap of snap.docs) {
        const d = docSnap.data();
        out.scanned++;
        const label = `${d.name || docSnap.id}${kind === "student" ? `(${docSnap.id})` : ""}`;
        let r;
        try {
          r = await syncOneAuth(kind, docSnap.id, d, cache, classArchived);
        } catch (e) {
          out.noAccount.push(`${label}: ${e.message}`);
          continue;
        }
        if (r.reason === "no-auth-account") {
          if (r.archived) out.noAccount.push(label);   // 只有封存者沒帳號才值得回報
        } else if (!r.changed) {
          out.unchanged++;
        } else if (r.archived) {
          out.disabled.push(label);
        } else {
          out.enabled.push(label);
        }
      }
    }
    console.log("[syncArchivedAuth]", JSON.stringify(out));
    return out;
  });


/* ─────────────────────────────────────────────────────────────
 * 📊 milestoneBoard — 教官用 Milestone 總覽的守門員（2026-09-29）
 *
 * 為什麼要有這一支：milestone.html 是「知道網址就能看」的頁面（皇上指定），
 * 但 Firestore 規則沒辦法依 token 限制查詢範圍。如果為了讓免登入頁讀到資料
 * 而放寬 milestone_evaluations 的讀取權，等於全部 388 人的評核對外開放。
 * 所以改成：網頁完全不碰資料庫，只拿 token 來問這支 function，
 * 由 admin SDK 驗證 token → 只回傳該 token 綁定那一班的資料。
 *
 * 🔴 三道保護：
 *   1. token 錯／停用／過期 → 一律 403，不透露任何內容
 *   2. 只回傳 token 綁定的 classId，別班一個字都不給
 *   3. 回傳的學員欄位只有 座號 + 姓名，**身分證與其他個資不出網**
 *
 * token 存 milestone_view_tokens/{token}：
 *   { classId, label, active:true, createdAt, expiresAt?(Timestamp), useCount, lastUsedAt }
 *   這個集合沒列在 firestore.rules 裡 → 依「其餘一律拒絕」原則，前端讀不到，只有本支讀得到。
 * ───────────────────────────────────────────────────────────── */
exports.milestoneBoard = functions
  .region("asia-east1")
  .runWith({ memory: "256MB" })
  .https.onRequest(async (req, res) => {
    // 這頁掛在 GitHub Pages，跟 function 不同網域 → 需要 CORS
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return res.status(204).send("");

    const token = String(req.query.t || "").trim();
    // 先擋明顯不合法的，避免拿奇怪字串去查資料庫
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
      return res.status(403).json({ error: "forbidden" });
    }

    try {
      const tkDoc = await db.collection("milestone_view_tokens").doc(token).get();
      if (!tkDoc.exists) return res.status(403).json({ error: "forbidden" });
      const tk = tkDoc.data() || {};
      if (tk.active === false) return res.status(403).json({ error: "revoked" });
      if (tk.expiresAt && tk.expiresAt.toMillis && tk.expiresAt.toMillis() < Date.now()) {
        return res.status(403).json({ error: "expired" });
      }
      const classId = String(tk.classId || "");
      if (!classId) return res.status(403).json({ error: "forbidden" });

      const [clsDoc, stuSnap, msSnap, grpSnap, evSnap, sysDoc] = await Promise.all([
        db.collection("classes").doc(classId).get(),
        db.collection("students").where("classId", "==", classId).get(),
        db.collection("milestones").get(),
        db.collection("milestone_groups").get(),
        db.collection("milestone_evaluations").where("classId", "==", classId).get(),
        db.collection("system_settings").doc("global").get(),
      ]);

      // 🔴 算分規則必須與 student.html 完全一致，否則教官看到的分數跟學員自己看到的對不起來：
      //    ① 該班的排除設定 classes/{id}.settings.epaScoring（排除某些身分／單位／評核者／項目）
      //    ② 每項取「最近 N 次」平均，N＝system_settings/global.milestoneRecentN（預設 3）
      const epaScoring = (clsDoc.exists && clsDoc.data().settings && clsDoc.data().settings.epaScoring) || {};
      const recentN = (sysDoc.exists && Number(sysDoc.data().milestoneRecentN)) || 3;

      // 🔴 只挑要用的欄位出網：座號與姓名。身分證、電話等一律不送。
      const students = stuSnap.docs
        .filter((d) => (d.data() || {}).isActive !== false && (d.data() || {}).archived !== true)
        .map((d) => {
          const v = d.data() || {};
          // 🔴 只取這兩個欄位。學員文件裡還有 idNumber（身分證）、email、authUid，一律不出網。
          return { id: d.id, no: v.studentNo || "", name: v.name || "" };
        })
        .sort((a, b) => String(a.no).localeCompare(String(b.no), "zh-Hant", { numeric: true }));

      const groups = grpSnap.docs
        .map((d) => { const v = d.data() || {}; return { id: d.id, name: v.name || d.id, order: Number(v.displayOrder || 99), active: v.isActive !== false }; })
        .filter((g) => g.active)
        .sort((a, b) => a.order - b.order);

      const milestones = msSnap.docs
        .map((d) => {
          const v = d.data() || {};
          return { id: d.id, name: v.name || d.id, step: v.step || "", groupId: v.groupId || "",
                   order: Number(v.displayOrder || 99),
                   visible: v.isVisible !== false && v.isActive !== false,
                   inRadar: v.countInRadar !== false };
        })
        .filter((m) => m.visible)
        .sort((a, b) => a.order - b.order);

      const stuIds = new Set(students.map((s) => s.id));
      const evals = evSnap.docs
        .map((d) => {
          const v = d.data() || {};
          // 🔴 寫入端用的是 evaluatedAt（不是 createdAt）——eval.html 第 718 行
          const t = v.evaluatedAt && v.evaluatedAt.toMillis ? v.evaluatedAt.toMillis() : null;
          return { studentId: String(v.studentId || ""), milestoneId: String(v.milestoneId || ""),
                   level: Number(v.level || 0),
                   evaluator: String(v.evaluatorName || ""),
                   role: String(v.evaluatorRole || ""),
                   unit: String(v.evaluatorUnit || ""),
                   feedback: String(v.qualitativeFeedback || ""),
                   at: t };
        })
        .filter((e) => e.studentId && e.milestoneId && e.level > 0 && stuIds.has(e.studentId));

      // 用過一次就記一筆，方便日後查這條連結被用了幾次
      tkDoc.ref.update({
        useCount: admin.firestore.FieldValue.increment(1),
        lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});

      return res.status(200).json({
        className: (clsDoc.exists && (clsDoc.data().displayName || clsDoc.data().name)) || classId,
        classId, label: tk.label || "",
        groups, milestones, students, evals,
        epaScoring, recentN,
        generatedAt: Date.now(),
      });
    } catch (e) {
      console.error("[milestoneBoard]", e);
      return res.status(500).json({ error: "server" });
    }
  });


/* ─────────────────────────────────────────────────────────────
 * 🔑 milestoneBoardToken — 產生／撤銷 Milestone 總覽的觀看連結（2026-09-29）
 *
 * 只有 Master（皇上）能呼叫。網址外流時，來這裡按「撤銷」，舊連結立刻失效。
 * action: "list" | "create" | "revoke"
 * ───────────────────────────────────────────────────────────── */
exports.milestoneBoardToken = functions
  .region("asia-east1")
  .runWith({ memory: "256MB" })
  .https.onCall(async (data, context) => {
    if (!context.auth || context.auth.token.email !== MASTER_EMAIL) {
      throw new functions.https.HttpsError("permission-denied", "只有系統管理者可以管理觀看連結");
    }
    const action = String((data && data.action) || "list");
    const col = db.collection("milestone_view_tokens");

    if (action === "create") {
      const classId = String((data && data.classId) || "").trim();
      if (!classId) throw new functions.https.HttpsError("invalid-argument", "缺少 classId");
      // 32 碼：A-Z a-z 0-9 - _，與 milestoneBoard 的格式檢查一致
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const buf = require("crypto").randomBytes(32);
      let token = "";
      for (let i = 0; i < 32; i++) token += chars[buf[i] % chars.length];
      await col.doc(token).set({
        classId,
        label: String((data && data.label) || ""),
        active: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: context.auth.token.email,
        useCount: 0,
      });
      return { token, url: APP_BASE + "/milestone.html?t=" + token };
    }

    if (action === "revoke") {
      const token = String((data && data.token) || "");
      if (!token) throw new functions.https.HttpsError("invalid-argument", "缺少 token");
      await col.doc(token).update({
        active: false,
        revokedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ok: true };
    }

    const snap = await col.orderBy("createdAt", "desc").limit(50).get();
    return {
      tokens: snap.docs.map((d) => {
        const v = d.data() || {};
        return {
          token: d.id, classId: v.classId || "", label: v.label || "",
          active: v.active !== false, useCount: v.useCount || 0,
          createdAt: v.createdAt && v.createdAt.toMillis ? v.createdAt.toMillis() : null,
          lastUsedAt: v.lastUsedAt && v.lastUsedAt.toMillis ? v.lastUsedAt.toMillis() : null,
          url: APP_BASE + "/milestone.html?t=" + d.id,
        };
      }),
    };
  });
