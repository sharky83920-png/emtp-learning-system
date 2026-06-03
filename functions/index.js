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
let _bankCache = null;
let _bankCacheAt = 0;
const BANK_TTL_MS = 5 * 60 * 1000;
async function getQuestionBank() {
  const now = Date.now();
  if (_bankCache && now - _bankCacheAt < BANK_TTL_MS) return _bankCache;
  const snap = await db.collection("questions").get();
  const all = [];
  snap.forEach((d) => {
    const x = d.data();
    if (x.isVisible !== false && x.isActive !== false) all.push({ id: d.id, ...x });
  });
  _bankCache = all;
  _bankCacheAt = now;
  return all;
}
// 水龍頭過濾（與 student.html faucetAllows 同邏輯）
function faucetAllows(q, fc) {
  if (!fc || !fc.sources) return true;
  const sources = fc.sources;
  const enabledIds = Object.keys(sources).filter((k) => sources[k] && sources[k].enabled);
  if (enabledIds.length === 0) return true;
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
    if (pool.length === 0) return { questions: [], poolSize: 0 };

    orderByRound(pool, counts);
    return { questions: pool.slice(0, count), poolSize: pool.length };
  });
