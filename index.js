'use strict';
// Notifikasi push Si-Absen GURU TQ: pemberitahuan jam mengajar, hari libur, dan rapat tanpa membuka aplikasi.
// Dijalankan Cloud Scheduler tiap menit. Panduan pemasangan: ../PANDUAN-NOTIFIKASI.md
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { runMinute } = require('./runner');

initializeApp();
const REGION = 'asia-southeast2'; // Jakarta. Boleh diganti; fungsi terjadwal tidak harus sama dengan lokasi Firestore.

function makeRepo(db) {
  const col = n => db.collection(n);
  const rows = async name => (await col(name).get()).docs.map(d => ({ ...d.data(), id: d.data().id ?? (Number(d.id) || d.id) }));
  const ms = v => (v && typeof v.toMillis === 'function') ? v.toMillis() : 0;
  return {
    async getPlan(date) { const s = await col('pushPlans').doc(date).get(); return s.exists ? s.data() : null; },
    async savePlan(date, plan) { await col('pushPlans').doc(date).set(plan); },
    async latestCalendarUpdateMs() {
      const s = await col('academicCalendar').orderBy('updatedAt', 'desc').limit(1).get();
      return s.empty ? 0 : ms(s.docs[0].get('updatedAt'));
    },
    async loadPlanData() {
      const tokens = await col('pushTokens').get();
      const uids = [...new Set(tokens.docs.map(d => d.get('uid')).filter(Boolean))];
      const users = [];
      for (let i = 0; i < uids.length; i += 25) {
        const snaps = await Promise.all(uids.slice(i, i + 25).map(uid => col('users').doc(uid).get()));
        snaps.forEach(s => { const u = s.data(); if (s.exists && u.role === 'guru' && u.aktif === true && u.teacherId != null) users.push({ uid: s.id, teacherId: u.teacherId }); });
      }
      const cal = (await col('academicCalendar').get()).docs.map(d => ({ id: d.id, ...d.data() }));
      const [teachers, schedules, periods, classes, subjects] = await Promise.all(['teachers', 'schedules', 'periods', 'classes', 'subjects'].map(rows));
      return { users, teachers, schedules, periods, classes, subjects, calendar: cal };
    },
    async claim(id) { try { await col('pushSent').doc(id).create({ at: Date.now() }); return true; } catch (e) { if (e.code === 6 || /ALREADY_EXISTS/.test(String(e.message))) return false; throw e; } },
    async release(id) { await col('pushSent').doc(id).delete().catch(() => {}); },
    async holidayDocExists(date, schoolId) {
      const ids = [`libur_all_${date}`, `libur_${schoolId}_${date}`];
      const snaps = await Promise.all(ids.map(i => col('academicCalendar').doc(i).get()));
      return snaps.some(s => s.exists);
    },
    async getLeave(teacherId, date) { const s = await col('teacherLeaves').doc(`${teacherId}_${date}`).get(); return s.exists ? s.data() : null; },
    async attendancesFor(uid, date) { const s = await col('teacherAttendances').where('teacherUid', '==', uid).where('tanggal', '==', date).get(); return s.docs.map(d => d.data()); },
    async hasMeetingResponse(meetingId, uid) { return (await col('meetingAttendances').doc(`${meetingId}_${uid}`).get()).exists; },
    async calendarDocExists(id) { return (await col('academicCalendar').doc(String(id)).get()).exists; },
    async tokensForUid(uid) { const s = await col('pushTokens').where('uid', '==', uid).get(); return s.docs.map(d => ({ id: d.id, token: d.get('token') })).filter(x => x.token); },
    async deleteToken(id) { await col('pushTokens').doc(id).delete().catch(() => {}); }
  };
}

exports.pushMinute = onSchedule({ schedule: '* * * * *', timeZone: 'Asia/Jakarta', region: REGION, timeoutSeconds: 60, memory: '256MiB' }, async () => {
  const result = await runMinute({ repo: makeRepo(getFirestore()), messaging: getMessaging(), now: new Date() });
  if (result.sent || result.error) logger.info('pushMinute', result);
});

