'use strict';
const { wibParts, schoolIdsOf, toMin, buildPlan } = require('./planner');

const WORK_FROM = 5 * 60, WORK_TO = 21 * 60;  // hanya aktif 05:00–21:00 WIB (hemat biaya)
const GRACE_MIN = 2;                          // item yang terlewat sampai 2 menit tetap dikirim (toleransi jitter scheduler)
const REBUILD_MIN = 60;                       // data master (jadwal/JP) dibaca ulang paling lambat tiap 60 menit
const INVALID_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

async function ensurePlan(repo, t, nowMs) {
  let plan = await repo.getPlan(t.dateKey);
  const latest = await repo.latestCalendarUpdateMs();
  const stale = !plan || (nowMs - plan.builtAtMs) > REBUILD_MIN * 60000 || latest > plan.builtAtMs;
  if (stale) {
    const data = await repo.loadPlanData();
    plan = { date: t.dateKey, builtAtMs: nowMs, items: buildPlan(data, t.dateKey), calendarIds: data.calendar.map(e => String(e.id)) };
    await repo.savePlan(t.dateKey, plan);
  }
  return plan;
}

// Pemeriksaan saat akan mengirim (kondisi bisa berubah setelah rencana disusun).
async function passes(item, repo, t) {
  const d = item.data || {};
  if (item.kind === 'soon' || item.kind === 'late') {
    if (await repo.holidayDocExists(t.dateKey, d.schoolId)) return false;
    const leave = await repo.getLeave(item.teacherId, t.dateKey);
    if (leave && (leave.status === undefined || leave.status === 'Disetujui')) {
      const slots = []; for (let n = Number(d.jamMulai); n <= Number(d.jamSelesai); n++) slots.push(n);
      const per = Array.isArray(leave.periods) ? leave.periods.map(Number) : [];
      if (leave.scope === 'ALL' || !per.length || slots.some(n => per.includes(n))) return false;
    }
    const atts = await repo.attendancesFor(item.uid, t.dateKey);
    if (atts.some(a => String(a.scheduleId) === String(d.scheduleId))) return false;   // sudah absen
    return true;
  }
  if (item.kind === 'meet15' || item.kind === 'meetToday') {
    if (!(await repo.calendarDocExists(d.meetingId))) return false;                    // rapat sudah dihapus
    if (item.kind === 'meet15' && await repo.hasMeetingResponse(d.meetingId, item.uid)) return false; // sudah mengisi
    return true;
  }
  return true;
}

async function sendTo(item, repo, messaging) {
  const tokens = await repo.tokensForUid(item.uid);
  if (!tokens.length) return { sent: 0, tokens: 0 };
  const message = {
    tokens: tokens.map(x => x.token),
    data: { title: item.title, body: item.body, tag: item.tag, kind: item.kind, url: './' },
    webpush: { headers: { Urgency: 'high', TTL: '1800' } },
    android: { priority: 'high' }
  };
  const res = await messaging.sendEachForMulticast(message);
  let sent = 0;
  for (let i = 0; i < res.responses.length; i++) {
    const r = res.responses[i];
    if (r.success) sent++;
    else if (r.error && INVALID_TOKEN.has(r.error.code)) await repo.deleteToken(tokens[i].id);
  }
  return { sent, tokens: tokens.length };
}

async function runMinute({ repo, messaging, now }) {
  const t = wibParts(now);
  if (t.minutes < WORK_FROM || t.minutes > WORK_TO) return { skipped: 'di luar jam kerja', at: t.minutes };
  const plan = await ensurePlan(repo, t, now.getTime());
  const due = plan.items.filter(i => i.minute <= t.minutes && i.minute > t.minutes - 1 - GRACE_MIN);
  const out = { date: t.dateKey, minute: t.minutes, planItems: plan.items.length, due: due.length, sent: 0, skipped: 0 };
  for (const item of due) {
    const id = `${t.dateKey}_${item.key}`;
    if (!(await repo.claim(id))) { out.skipped++; continue; }          // sudah diproses (mencegah dobel)
    try {
      if (!(await passes(item, repo, t))) { out.skipped++; continue; }
      const r = await sendTo(item, repo, messaging);
      out.sent += r.sent ? 1 : 0;
    } catch (err) {
      await repo.release(id);                                           // gagal sementara: boleh dicoba lagi pada menit berikutnya
      out.error = String(err && err.message || err);
    }
  }
  return out;
}

module.exports = { runMinute, ensurePlan, passes, WORK_FROM, WORK_TO, GRACE_MIN, REBUILD_MIN };
