'use strict';
// Logika murni (tanpa akses Firebase): menyusun daftar notifikasi satu hari dari data master & kalender.
// Aturannya sengaja sama dengan yang dipakai aplikasi (libur per unit, rapat menimpa JP, izin guru, dsb.).

const HARI = { Monday: 'Senin', Tuesday: 'Selasa', Wednesday: 'Rabu', Thursday: 'Kamis', Friday: 'Jumat', Saturday: 'Sabtu', Sunday: 'Minggu' };
const HARI_BY_UTC_DAY = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

function wibParts(d) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long', hourCycle: 'h23' });
  const o = {};
  f.formatToParts(d).forEach(p => { o[p.type] = p.value; });
  return { dateKey: `${o.year}-${o.month}-${o.day}`, minutes: Number(o.hour) * 60 + Number(o.minute), hari: HARI[o.weekday] };
}
function addDays(dateKey, n) {
  const d = new Date(dateKey + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function hariOf(dateKey) { return HARI_BY_UTC_DAY[new Date(dateKey + 'T12:00:00Z').getUTCDay()]; }
function toMin(hm) {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(hm == null ? '' : hm).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function fmtMin(m) { const x = ((m % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); }
function fmtDate(dateKey) { const [y, m, d] = dateKey.split('-'); return `${d}/${m}/${y}`; }
function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function schoolIdsOf(t) { return [...new Set([...(t && t.schoolIds || []), t && t.schoolId].filter(v => v != null))]; }
const same = (a, b) => String(a) === String(b);

function holidayFor(calendar, dateKey, schoolId) {
  return calendar.find(e => e.type === 'libur' && e.mulai <= dateKey && dateKey <= (e.akhir || e.mulai) && (e.schoolId == null || same(e.schoolId, schoolId))) || null;
}
function meetingsOn(calendar, dateKey) {
  return calendar.filter(e => e.type === 'rapat' && e.tanggal === dateKey && toMin(e.jamMulai) != null && toMin(e.jamSelesai) != null);
}
function meetingAppliesTo(m, schoolId) { return m.schoolId == null || same(m.schoolId, schoolId); }
function meetingBlocks(calendar, dateKey, schoolId, startMin, endMin) {
  return meetingsOn(calendar, dateKey).find(m => meetingAppliesTo(m, schoolId) && startMin < toMin(m.jamSelesai) && endMin > toMin(m.jamMulai)) || null;
}

// Jendela jadwal: menit mulai JP pertama sampai selesai JP terakhir pada unit sekolah kelas tsb.
function scheduleWindow(sc, classes, periods) {
  const cls = classes.find(c => same(c.id, sc.classId));
  if (!cls) return null;
  const ps = periods.filter(p => same(p.schoolId, cls.schoolId) && Number(p.jam) >= Number(sc.jamMulai) && Number(p.jam) <= Number(sc.jamSelesai));
  const times = ps.map(p => String(p.waktu || '').split('-')).map(([a, b]) => [toMin(a), toMin(b)]).filter(([a, b]) => a != null && b != null);
  if (!times.length) return null;
  return { schoolId: cls.schoolId, start: Math.min(...times.map(t => t[0])), end: Math.max(...times.map(t => t[1])), times };
}

function makeItem(base) { return Object.assign({ minute: 0, kind: '', key: '', uid: '', teacherId: null, title: '', body: '', tag: '', data: {} }, base); }

/**
 * data: { users:[{uid,teacherId}], teachers, schedules, periods, classes, subjects, calendar }
 * Hanya guru yang punya token (users) yang direncanakan. Mengembalikan daftar item notifikasi untuk dateKey.
 */
function buildPlan(data, dateKey) {
  const { users, teachers, schedules, periods, classes, subjects, calendar } = data;
  const hari = hariOf(dateKey), tomorrow = addDays(dateKey, 1), hariBesok = hariOf(tomorrow);
  const items = [];
  for (const u of users) {
    const t = teachers.find(x => same(x.id, u.teacherId));
    if (!t) continue;
    const tid = u.teacherId, mySchools = schoolIdsOf(t);
    const mine = schedules.filter(sc => same(sc.teacherId, tid));

    // ---- Jam mengajar hari ini
    for (const sc of mine.filter(s => String(s.hari || '').trim().toLowerCase() === hari.toLowerCase())) {
      const w = scheduleWindow(sc, classes, periods); if (!w) continue;
      if (holidayFor(calendar, dateKey, w.schoolId)) continue;                       // hari libur: tidak ada JP
      if (w.times.every(([a, b]) => meetingBlocks(calendar, dateKey, w.schoolId, a, b))) continue; // seluruh JP diganti rapat
      const cls = (classes.find(c => same(c.id, sc.classId)) || {}).nama || 'kelas';
      const sub = (subjects.find(x => same(x.id, sc.subjectId)) || {}).nama || '';
      const label = clip(cls + (sub ? ' • ' + sub : ''), 60);
      const dataObj = { scheduleId: String(sc.id), date: dateKey, schoolId: String(w.schoolId), jamMulai: String(sc.jamMulai), jamSelesai: String(sc.jamSelesai) };
      items.push(makeItem({ key: `soon_${sc.id}_${tid}`, minute: w.start - 5, kind: 'soon', uid: u.uid, teacherId: tid,
        title: 'Sebentar lagi mengajar', body: `Jam ke-${sc.jamMulai} (${label}) dimulai pukul ${fmtMin(w.start)}. Siapkan absen Anda.`, tag: `siabsen-soon-${sc.id}`, data: dataObj }));
      items.push(makeItem({ key: `late_${sc.id}_${tid}`, minute: w.start + 3, kind: 'late', uid: u.uid, teacherId: tid,
        title: 'Anda belum absen', body: `Jam ke-${sc.jamMulai} (${label}) sudah dimulai. Buka aplikasi lalu kirim absensi.`, tag: `siabsen-late-${sc.id}`, data: dataObj }));
    }

    // ---- Hari libur: hari ini (06:00) dan besok (17:00), hanya untuk guru yang punya jadwal pada hari itu di unit terkait
    const liburNotice = (day, hariName, kind, minute, prefix) => {
      const mineThatDay = mine.filter(s => String(s.hari || '').trim().toLowerCase() === hariName.toLowerCase());
      let hit = null;
      for (const sc of mineThatDay) {
        const w = scheduleWindow(sc, classes, periods); if (!w) continue;
        hit = holidayFor(calendar, day, w.schoolId); if (hit) break;
      }
      if (!hit) return;
      items.push(makeItem({ key: `${kind}_${day}_${tid}`, minute, kind, uid: u.uid, teacherId: tid,
        title: kind === 'holidayToday' ? 'Hari ini libur' : 'Besok libur',
        body: clip(`${prefix}${hit.keterangan || 'Libur'}. Absensi ditutup dan JP pada hari itu tidak dihitung.`, 140),
        tag: `siabsen-libur-${day}`, data: { date: day } }));
    };
    liburNotice(dateKey, hari, 'holidayToday', 6 * 60, 'Hari ini libur: ');
    liburNotice(tomorrow, hariBesok, 'holidayTomorrow', 17 * 60, `Besok (${hariBesok} ${fmtDate(tomorrow)}) libur: `);

    // ---- Rapat hari ini: pemberitahuan pagi (06:00) dan pengingat 15 menit sebelum mulai
    for (const m of meetingsOn(calendar, dateKey)) {
      if (!(m.schoolId == null || mySchools.some(s => same(s, m.schoolId)))) continue;
      const st = toMin(m.jamMulai);
      const when = `${m.jamMulai}–${m.jamSelesai}`;
      if (st >= 7 * 60) {
        items.push(makeItem({ key: `meetToday_${m.id}_${tid}`, minute: 6 * 60, kind: 'meetToday', uid: u.uid, teacherId: tid,
          title: 'Ada rapat hari ini', body: clip(`${m.judul}, pukul ${when} WIB. Buka aplikasi untuk mengisi kehadiran.`, 140), tag: `siabsen-meetinfo-${m.id}`, data: { meetingId: String(m.id), date: dateKey } }));
      }
      items.push(makeItem({ key: `meet15_${m.id}_${tid}`, minute: st - 15, kind: 'meet15', uid: u.uid, teacherId: tid,
        title: 'Rapat 15 menit lagi', body: clip(`${m.judul} dimulai pukul ${m.jamMulai}. Buka aplikasi untuk mengisi Hadir / Izin.`, 140), tag: `siabsen-meet15-${m.id}`, data: { meetingId: String(m.id), date: dateKey } }));
    }
  }
  return items.filter(i => i.minute >= 0 && i.minute < 1440).sort((a, b) => a.minute - b.minute);
}

module.exports = { wibParts, addDays, hariOf, toMin, fmtMin, schoolIdsOf, holidayFor, meetingsOn, meetingBlocks, scheduleWindow, buildPlan };
