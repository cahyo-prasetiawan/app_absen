'use strict';
// Pengujian lokal tanpa Firebase: Firestore & FCM digantikan objek tiruan di memori.
const assert = require('assert');
const { runMinute } = require('../runner');
const { buildPlan, wibParts } = require('../planner');

const wib = s => new Date(s + '+07:00');   // contoh: wib('2026-11-02T06:00:00') -> Senin 06:00 WIB
const T = [];
const test = (name, fn) => T.push({ name, fn });

function baseData() {
  return {
    teachers: [{ id: 7, nama: 'Budi', schoolIds: [1] }, { id: 8, nama: 'Sari', schoolIds: [2] }],
    classes: [{ id: 1, nama: '1A', schoolId: 1 }, { id: 2, nama: '7A', schoolId: 2 }],
    subjects: [{ id: 1, nama: 'IPA' }],
    periods: [{ schoolId: 1, jam: 1, waktu: '07:00-07:40' }, { schoolId: 1, jam: 2, waktu: '07:40-08:20' }, { schoolId: 2, jam: 1, waktu: '08:00-08:40' }],
    schedules: [
      { id: 1, teacherId: 7, classId: 1, subjectId: 1, hari: 'Senin', jamMulai: 1, jamSelesai: 2 },
      { id: 2, teacherId: 8, classId: 2, subjectId: 1, hari: 'Senin', jamMulai: 1, jamSelesai: 1 },
      { id: 3, teacherId: 7, classId: 1, subjectId: 1, hari: 'Selasa', jamMulai: 1, jamSelesai: 1 }
    ],
    users: [{ uid: 'uidA', teacherId: 7 }, { uid: 'uidB', teacherId: 8 }],
    calendar: [
      { id: 'rapat_all_2026-11-02_0900', type: 'rapat', mulai: '2026-11-02', akhir: '2026-11-02', tanggal: '2026-11-02', jamMulai: '09:00', jamSelesai: '11:00', judul: 'Rapat Evaluasi', schoolId: null, updatedAtMs: 1000 },
      { id: 'libur_1_2026-11-03', type: 'libur', mulai: '2026-11-03', akhir: '2026-11-03', hari: '2026-11-03', keterangan: 'Libur Unit MI', schoolId: 1, updatedAtMs: 1000 }
    ]
  };
}

function makeRepo(data) {
  const state = { plans: {}, sent: new Set(), leaves: {}, atts: {}, meetResp: new Set(), tokens: { uidA: [{ id: 'uidA_d1', token: 'tokA' }], uidB: [{ id: 'uidB_d1', token: 'tokB' }] }, deleted: [], planBuilds: 0, calUpdate: 1000 };
  const repo = {
    state, data,
    async getPlan(d) { return state.plans[d] || null; },
    async savePlan(d, p) { state.plans[d] = JSON.parse(JSON.stringify(p)); },
    async latestCalendarUpdateMs() { return state.calUpdate; },
    async loadPlanData() { state.planBuilds++; return JSON.parse(JSON.stringify(data)); },
    async claim(id) { if (state.sent.has(id)) return false; state.sent.add(id); return true; },
    async release(id) { state.sent.delete(id); },
    async holidayDocExists(date, sid) { return data.calendar.some(e => e.type === 'libur' && (e.id === `libur_all_${date}` || e.id === `libur_${sid}_${date}`)); },
    async getLeave(tid, date) { return state.leaves[`${tid}_${date}`] || null; },
    async attendancesFor(uid, date) { return state.atts[`${uid}_${date}`] || []; },
    async hasMeetingResponse(mid, uid) { return state.meetResp.has(`${mid}_${uid}`); },
    async calendarDocExists(id) { return data.calendar.some(e => e.id === id); },
    async tokensForUid(uid) { return (state.tokens[uid] || []).slice(); },
    async deleteToken(id) { state.deleted.push(id); for (const u of Object.keys(state.tokens)) state.tokens[u] = state.tokens[u].filter(t => t.id !== id); }
  };
  return repo;
}
function makeMessaging(opts = {}) {
  const calls = [];
  return {
    calls,
    async sendEachForMulticast(msg) {
      calls.push(msg);
      if (opts.fail) throw new Error('FCM down');
      return { responses: msg.tokens.map(t => (opts.invalid && opts.invalid.includes(t)) ? { success: false, error: { code: 'messaging/registration-token-not-registered' } } : { success: true }) };
    }
  };
}
const titles = m => m.calls.map(c => c.data.title + '→' + c.tokens.join(','));

test('rencana: jenis & jam notifikasi sesuai aturan', () => {
  const plan = buildPlan(baseData(), '2026-11-02');
  const k = plan.map(i => `${i.kind}:${i.uid}:${String(Math.floor(i.minute / 60)).padStart(2, '0')}:${String(i.minute % 60).padStart(2, '0')}`);
  assert.deepStrictEqual(k.sort(), [
    'holidayTomorrow:uidA:17:00', 'late:uidA:07:03', 'late:uidB:08:03', 'meet15:uidA:08:45', 'meet15:uidB:08:45',
    'meetToday:uidA:06:00', 'meetToday:uidB:06:00', 'soon:uidA:06:55', 'soon:uidB:07:55'].sort());
  const hol = plan.find(i => i.kind === 'holidayTomorrow');
  assert.ok(/Besok \(Selasa 03\/11\/2026\) libur: Libur Unit MI/.test(hol.body), hol.body);
});
test('rencana: guru unit lain tidak mendapat pemberitahuan libur unit MI', () => {
  const plan = buildPlan(baseData(), '2026-11-02');
  assert.ok(!plan.some(i => i.kind === 'holidayTomorrow' && i.uid === 'uidB'));
});
test('hari libur hari ini: tidak ada pengingat jam mengajar, ada pemberitahuan libur 06:00', () => {
  const d = baseData(); d.calendar.push({ id: 'libur_all_2026-11-02', type: 'libur', mulai: '2026-11-02', akhir: '2026-11-02', hari: '2026-11-02', keterangan: 'Libur Nasional', schoolId: null });
  const plan = buildPlan(d, '2026-11-02');
  assert.ok(!plan.some(i => i.kind === 'soon' || i.kind === 'late'));
  assert.deepStrictEqual(plan.filter(i => i.kind === 'holidayToday').map(i => i.uid).sort(), ['uidA', 'uidB']);
});
test('rapat menimpa seluruh JP: pengingat mengajar dihapus; menimpa sebagian: tetap ada', () => {
  const d = baseData(); d.calendar = [{ id: 'r', type: 'rapat', mulai: '2026-11-02', akhir: '2026-11-02', tanggal: '2026-11-02', jamMulai: '06:30', jamSelesai: '08:30', judul: 'Rapat Pagi', schoolId: 1 }];
  let plan = buildPlan(d, '2026-11-02');
  assert.ok(!plan.some(i => i.kind === 'soon' && i.uid === 'uidA'));   // JP guru A (07:00–08:20) seluruhnya tertimpa
  assert.ok(plan.some(i => i.kind === 'soon' && i.uid === 'uidB'));    // guru B unit 2 tidak terpengaruh
  d.calendar[0].jamSelesai = '07:20';
  plan = buildPlan(d, '2026-11-02');
  assert.ok(plan.some(i => i.kind === 'soon' && i.uid === 'uidA'));
});

test('06:00 mengirim pemberitahuan rapat ke semua guru, tidak dobel di menit yang sama', async () => {
  const repo = makeRepo(baseData()), m = makeMessaging();
  const r1 = await runMinute({ repo, messaging: m, now: wib('2026-11-02T06:00:10') });
  assert.strictEqual(r1.sent, 2);
  assert.deepStrictEqual(titles(m).sort(), ['Ada rapat hari ini→tokA', 'Ada rapat hari ini→tokB']);
  const r2 = await runMinute({ repo, messaging: m, now: wib('2026-11-02T06:00:50') });
  assert.strictEqual(r2.sent, 0); assert.strictEqual(m.calls.length, 2);
});
test('toleransi 2 menit: 06:02 masih terkirim, 06:03 tidak', async () => {
  let repo = makeRepo(baseData()), m = makeMessaging();
  await runMinute({ repo, messaging: m, now: wib('2026-11-02T06:02:00') }); assert.strictEqual(m.calls.length, 2);
  repo = makeRepo(baseData()); m = makeMessaging();
  await runMinute({ repo, messaging: m, now: wib('2026-11-02T06:03:00') }); assert.strictEqual(m.calls.length, 0);
});
test('06:55 pengingat "sebentar lagi" hanya untuk guru A; berisi data JP & kelas', async () => {
  const repo = makeRepo(baseData()), m = makeMessaging();
  await runMinute({ repo, messaging: m, now: wib('2026-11-02T06:55:00') });
  assert.deepStrictEqual(titles(m), ['Sebentar lagi mengajar→tokA']);
  assert.ok(/Jam ke-1 \(1A • IPA\) dimulai pukul 07:00/.test(m.calls[0].data.body), m.calls[0].data.body);
  assert.strictEqual(m.calls[0].data.tag, 'siabsen-soon-1');
});
test('07:03 "belum absen" terkirim bila belum absen, tidak terkirim bila sudah absen', async () => {
  let repo = makeRepo(baseData()), m = makeMessaging();
  await runMinute({ repo, messaging: m, now: wib('2026-11-02T07:03:00') });
  assert.deepStrictEqual(titles(m), ['Anda belum absen→tokA']);
  repo = makeRepo(baseData()); m = makeMessaging(); repo.state.atts['uidA_2026-11-02'] = [{ scheduleId: 1 }];
  await runMinute({ repo, messaging: m, now: wib('2026-11-02T07:03:00') });
  assert.strictEqual(m.calls.length, 0);
});
test('izin disetujui seharian: pengingat mengajar tidak dikirim', async () => {
  const repo = makeRepo(baseData()), m = makeMessaging(); repo.state.leaves['7_2026-11-02'] = { status: 'Disetujui', scope: 'ALL' };
  await runMinute({ repo, messaging: m, now: wib('2026-11-02T06:55:00') });
  assert.strictEqual(m.calls.length, 0);
});
test('izin parsial hanya JP lain: pengingat tetap dikirim', async () => {
  const repo = makeRepo(baseData()), m = makeMessaging(); repo.state.leaves['7_2026-11-02'] = { status: 'Disetujui', scope: 'JP', periods: [5] };
  await runMinute({ repo, messaging: m, now: wib('2026-11-02T06:55:00') });
  assert.strictEqual(m.calls.length, 1);
});
test('libur ditambahkan setelah rencana dibuat: rencana disusun ulang dan pengingat batal', async () => {
  const repo = makeRepo(baseData()), m = makeMessaging();
  await runMinute({ repo, messaging: m, now: wib('2026-11-02T05:30:00') });            // rencana pertama
  assert.strictEqual(repo.state.planBuilds, 1);
  repo.data.calendar.push({ id: 'libur_all_2026-11-02', type: 'libur', mulai: '2026-11-02', akhir: '2026-11-02', hari: '2026-11-02', keterangan: 'Libur Mendadak', schoolId: null });
  repo.state.calUpdate = wib('2026-11-02T05:40:00').getTime();                          // admin mengubah kalender
  await runMinute({ repo, messaging: m, now: wib('2026-11-02T06:55:00') });
  assert.strictEqual(repo.state.planBuilds, 2);
  assert.ok(!m.calls.some(c => c.data.kind === 'soon'));
});
test('libur dihapus/ditambah tanpa mengubah kalender: dokumen libur dicek lagi saat kirim', async () => {
  const repo = makeRepo(baseData()), m = makeMessaging();
  await runMinute({ repo, messaging: m, now: wib('2026-11-02T05:30:00') });
  repo.data.calendar.push({ id: 'libur_1_2026-11-02', type: 'libur', mulai: '2026-11-02', akhir: '2026-11-02', hari: '2026-11-02', schoolId: 1 }); // tanpa memperbarui calUpdate
  await runMinute({ repo, messaging: m, now: wib('2026-11-02T06:55:00') });
  assert.ok(!m.calls.some(c => c.data.kind === 'soon'));
});
test('rapat 15 menit: terkirim untuk guru yang belum mengisi, dilewati yang sudah', async () => {
  const repo = makeRepo(baseData()), m = makeMessaging(); repo.state.meetResp.add('rapat_all_2026-11-02_0900_uidB');
  await runMinute({ repo, messaging: m, now: wib('2026-11-02T08:45:00') });
  assert.deepStrictEqual(titles(m), ['Rapat 15 menit lagi→tokA']);
});
test('rapat yang dihapus setelah rencana dibuat tidak dikirim', async () => {
  const repo = makeRepo(baseData()), m = makeMessaging();
  await runMinute({ repo, messaging: m, now: wib('2026-11-02T05:30:00') });
  repo.data.calendar = repo.data.calendar.filter(e => e.type !== 'rapat');
  await runMinute({ repo, messaging: m, now: wib('2026-11-02T08:45:00') });
  assert.strictEqual(m.calls.length, 0);
});
test('17:00 pemberitahuan libur besok untuk guru A saja', async () => {
  const repo = makeRepo(baseData()), m = makeMessaging();
  await runMinute({ repo, messaging: m, now: wib('2026-11-02T17:00:20') });
  assert.deepStrictEqual(titles(m), ['Besok libur→tokA']);
});
test('di luar jam kerja (04:00 dan 22:00) tidak melakukan apa pun, tanpa membaca data', async () => {
  const repo = makeRepo(baseData()), m = makeMessaging();
  const a = await runMinute({ repo, messaging: m, now: wib('2026-11-02T04:00:00') });
  const b = await runMinute({ repo, messaging: m, now: wib('2026-11-02T22:00:00') });
  assert.ok(a.skipped && b.skipped); assert.strictEqual(repo.state.planBuilds, 0); assert.strictEqual(m.calls.length, 0);
});
test('token tidak valid dihapus, token valid tetap dipakai', async () => {
  const repo = makeRepo(baseData()), m = makeMessaging({ invalid: ['tokA'] }); repo.state.tokens.uidA.push({ id: 'uidA_d2', token: 'tokA2' });
  await runMinute({ repo, messaging: m, now: wib('2026-11-02T06:55:00') });
  assert.deepStrictEqual(repo.state.deleted, ['uidA_d1']);
  assert.deepStrictEqual(repo.state.tokens.uidA.map(t => t.id), ['uidA_d2']);
});
test('gagal kirim sementara: klaim dilepas dan dicoba lagi menit berikutnya', async () => {
  const repo = makeRepo(baseData());
  let r = await runMinute({ repo, messaging: makeMessaging({ fail: true }), now: wib('2026-11-02T06:55:00') });
  assert.ok(r.error);
  const m = makeMessaging();
  r = await runMinute({ repo, messaging: m, now: wib('2026-11-02T06:56:00') });
  assert.strictEqual(m.calls.length, 1);
});
test('guru tanpa token tidak masuk rencana', () => {
  const d = baseData(); d.users = [{ uid: 'uidA', teacherId: 7 }];
  const plan = buildPlan(d, '2026-11-02');
  assert.ok(plan.every(i => i.uid === 'uidA'));
});
test('zona waktu: 23:30 UTC hari Minggu = 06:30 WIB hari Senin', () => {
  const t = wibParts(new Date('2026-11-01T23:30:00Z'));
  assert.deepStrictEqual([t.dateKey, t.hari, t.minutes], ['2026-11-02', 'Senin', 390]);
});

(async () => {
  let ok = 0;
  for (const t of T) {
    try { await t.fn(); ok++; console.log('  LULUS ', t.name); }
    catch (e) { console.log('  GAGAL ', t.name, '\n        ', e.message); process.exitCode = 1; }
  }
  console.log(`\n${ok}/${T.length} pengujian lulus`);
})();
