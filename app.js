// app.js (module)
// Full-featured Admin + Supervisor client app using Firestore
// Assumes firebase-config.js exports: auth, db
// Uses modular Firestore functions via CDN imports (these are dynamic imports to support direct browser module usage).

import { auth, db } from './firebase-config.js';
import { 
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged 
} from 'https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js';
import {
  doc, getDoc, setDoc, updateDoc, collection, addDoc, query, where, onSnapshot,
  getDocs, orderBy, limit, serverTimestamp, runTransaction, deleteDoc, writeBatch
} from 'https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js';

// Helper: DOM references
const $ = id => document.getElementById(id);
const toastEl = $('toast');

function showToast(msg, ms=3500){
  if(!toastEl) { alert(msg); return; }
  toastEl.innerText = msg;
  toastEl.style.display = 'block';
  setTimeout(()=> toastEl.style.display='none', ms);
}

// Theme toggle (simple CSS invert for demonstration)
$('themeToggle').addEventListener('click', ()=> {
  document.body.classList.toggle('alt-theme');
  showToast('Theme toggled');
});

// Health check (very simple Firestore read)
async function checkHealth(){
  try{
    const ref = doc(db, 'meta', 'healthcheck');
    const snap = await getDoc(ref);
    if(snap.exists()){
      $('healthStatus').innerText = 'OK';
      $('healthStatus').style.background = 'linear-gradient(90deg, #00d3ff, #ff4ecf)';
      $('healthStatus').style.color = '#001';
    } else {
      $('healthStatus').innerText = 'OK (no doc)';
      $('healthStatus').style.background = '#ffd24a';
    }
  } catch(e){
    $('healthStatus').innerText = 'Offline';
    $('healthStatus').style.background = '#ff6b6b';
  }
}
checkHealth();

// --- Utility: Firestore wrappers for main collections ---
const coll = (name)=> collection(db, name);
const stationsCol = coll('stations');
const usersCol = coll('users');
const studentsCol = coll('students');
const assignmentsCol = coll('assignments');
const chatCol = coll('chat_messages');
const auditCol = coll('audit_logs');
const ticketCol = coll('maintenance_tickets');
const labsCol = coll('labs');
const heartbeatCol = coll('heartbeats');
const settingsDoc = doc(db, 'settings', 'global');

// --- Role helper ---
async function getRole(uid){
  if(!uid) return null;
  const u = await getDoc(doc(db,'users',uid));
  if(!u.exists()) return null;
  return u.data().role;
}

// --- AUTH UI wiring (create test users & login) ---
$('adminCreateBtn').addEventListener('click', async ()=> {
  const email = $('adminEmail').value || `admin_${Date.now()}@example.com`;
  const pwd = $('adminPass').value || 'Admin@123';
  try {
    const c = await createUserWithEmailAndPassword(auth, email, pwd);
    // create user doc
    await setDoc(doc(db,'users',c.user.uid), { name: 'Admin (seed)', email, role:'admin', createdAt: serverTimestamp() });
    showToast('Test Admin created. Use the email/password to sign in.');
  } catch(e){ showToast('Create admin failed: '+e.message); }
});

$('supCreateBtn').addEventListener('click', async ()=> {
  const email = $('supEmail').value || `sup_${Date.now()}@example.com`;
  const pwd = $('supPass').value || 'Sup@123';
  try {
    const c = await createUserWithEmailAndPassword(auth, email, pwd);
    await setDoc(doc(db,'users',c.user.uid), { name: 'Supervisor (seed)', email, role:'supervisor', labsAssigned:[], createdAt: serverTimestamp() });
    showToast('Test Supervisor created.');
  } catch(e){ showToast('Create sup failed: '+e.message); }
});

// Admin / Supervisor login flows
$('adminLoginForm').addEventListener('submit', async (ev)=> {
  ev.preventDefault();
  const email = $('adminEmail').value;
  const pass = $('adminPass').value;
  try{
    const cred = await signInWithEmailAndPassword(auth, email, pass);
    const r = await getRole(cred.user.uid);
    if(r !== 'admin'){ await signOut(auth); showToast('This account is not admin'); return; }
    showToast('Admin signed in');
  } catch(e){ showToast('Login failed: '+e.message); }
});

$('supLoginForm').addEventListener('submit', async (ev)=> {
  ev.preventDefault();
  const email = $('supEmail').value;
  const pass = $('supPass').value;
  try{
    const cred = await signInWithEmailAndPassword(auth, email, pass);
    const r = await getRole(cred.user.uid);
    if(r !== 'supervisor'){ await signOut(auth); showToast('This account is not supervisor'); return; }
    showToast('Supervisor signed in');
  } catch(e){ showToast('Login failed: '+e.message); }
});

// --- On auth change: show appropriate dashboard & init listeners ---
let stationsUnsub = null, chatUnsub = null, assignmentUnsub = null, auditUnsub = null, ticketUnsub = null, heartbeatUnsub = null;
onAuthStateChanged(auth, async (user)=> {
  if(!user){
    $('loginPanel').classList.remove('hidden');
    $('adminDashboard').classList.add('hidden');
    $('supervisorDashboard').classList.add('hidden');
    return;
  }
  const role = await getRole(user.uid);
  if(role === 'admin'){
    $('loginPanel').classList.add('hidden');
    $('adminDashboard').classList.remove('hidden');
    $('supervisorDashboard').classList.add('hidden');
    $('adminNameDisplay').innerText = user.email;
    initAdmin();
  } else if(role === 'supervisor'){
    $('loginPanel').classList.add('hidden');
    $('adminDashboard').classList.add('hidden');
    $('supervisorDashboard').classList.remove('hidden');
    $('supNameDisplay').innerText = user.email;
    initSupervisor(user.uid);
  } else {
    showToast('No role assigned; contact system admin');
    await signOut(auth);
  }
});

// --- Logout buttons ---
$('adminLogout').addEventListener('click', async ()=> { await signOut(auth); showToast('Logged out'); });
$('supLogout').addEventListener('click', async ()=> { await signOut(auth); showToast('Logged out'); });

// --- AUDIT helper ---
async function audit(action, detail=''){
  try {
    await addDoc(auditCol, { userId: auth.currentUser?.uid || 'system', role: await getRole(auth.currentUser?.uid), action, detail, ts: serverTimestamp() });
  } catch(e){ console.warn('audit failed', e); }
}

// ---------------------- ADMIN: init & features ----------------------
async function initAdmin(){
  // 1) Real-time stations list
  if(stationsUnsub) stationsUnsub();
  stationsUnsub = onSnapshot(stationsCol, snap => {
    const container = $('stationsGridAdmin');
    container.innerHTML = '';
    snap.docs.forEach(d => {
      const s = d.data();
      const el = document.createElement('div');
      el.className = 'station-card';
      el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
        <div><strong>${s.name}</strong><div class="muted small">${s.labId || 'No lab'}</div></div>
        <div style="text-align:right"><div class="muted small">${s.status}</div><div class="muted small">${d.id}</div></div>
      </div>
      <div style="margin-top:6px;display:flex;gap:6px">
        <button class="btn-primary small" data-id="${d.id}" data-action="view">View</button>
        <button class="btn-warning small" data-id="${d.id}" data-action="maintenance">Maintenance</button>
        <button class="btn-success small" data-id="${d.id}" data-action="free">Force Free</button>
      </div>`;
      container.appendChild(el);
      el.querySelector('[data-action="view"]').addEventListener('click', ()=> viewStationAdmin(d.id));
      el.querySelector('[data-action="maintenance"]').addEventListener('click', ()=> reportMaintenanceAdmin(d.id));
      el.querySelector('[data-action="free"]').addEventListener('click', ()=> forceFreeAdmin(d.id));
    });
  });

  // 2) Audit logs real-time (admin-only)
  if(auditUnsub) auditUnsub();
  auditUnsub = onSnapshot(query(auditCol, orderBy('ts','desc'), limit(50)), snap => {
    const el = $('auditListAdmin'); el.innerHTML = '';
    snap.docs.forEach(d => {
      const a = d.data();
      const div = document.createElement('div');
      div.className = 'muted small';
      div.innerText = `${new Date(a.ts?.toMillis?.() || Date.now()).toLocaleString()} • ${a.role || a.userId} • ${a.action} ${a.detail||''}`;
      el.appendChild(div);
    });
  });

  // 3) Tickets
  if(ticketUnsub) ticketUnsub();
  ticketUnsub = onSnapshot(ticketCol, snap => {
    const el = $('ticketListAdmin'); el.innerHTML = '';
    snap.docs.forEach(d => {
      const t = d.data();
      const div = document.createElement('div');
      div.className = 'muted small';
      div.innerHTML = `<strong>${t.stationId}</strong> • ${t.status} • ${t.note || ''} • ${t.raisedBy || ''}`;
      el.appendChild(div);
    });
  });

  // 4) Users list
  loadUserListAdmin();

  // 5) Analytics charts
  drawAdminCharts();

  // 6) Bind admin controls
  $('createStationBtn').onclick = createStationModal;
  $('bulkOfflineBtn').onclick = bulkOfflineModal;
  $('exportPdfBtn').onclick = exportAuditPdf;
  $('exportDocxBtn').onclick = exportAuditDocx;
  $('createUserBtn').onclick = createUserFromAdmin;
  $('assignTicketBtn').onclick = assignTicket;
  $('closeTicketBtn').onclick = closeTicket;
  $('openSettings').onclick = openSettingsModal;

  await audit('admin_login', `uid:${auth.currentUser.uid}`);
}

// --- ADMIN utility functions ---
async function viewStationAdmin(stationId){
  const snap = await getDoc(doc(db, 'stations', stationId));
  if(!snap.exists()) return showToast('Station not found');
  const s = snap.data();
  alert(`Station ${s.name}\nStatus: ${s.status}\nCurrentSession: ${JSON.stringify(s.currentSession || {})}`);
}

async function reportMaintenanceAdmin(stationId){
  await addDoc(ticketCol, { stationId, note: 'Reported by admin', status:'open', raisedBy: auth.currentUser.uid, createdAt: serverTimestamp() });
  await updateDoc(doc(db,'stations',stationId), { status:'maintenance' });
  await audit('report_maintenance', stationId);
  showToast('Maintenance reported');
}

async function forceFreeAdmin(stationId){
  try{
    await updateDoc(doc(db,'stations',stationId), { currentSession: null, status: 'available' });
    await addDoc(assignmentsCol, { stationId, action: 'force_free', by: auth.currentUser.uid, ts: serverTimestamp() });
    await audit('force_free', stationId);
    showToast('Station force-freed');
  } catch(e){ showToast('Error: '+e.message); }
}

// Create station modal simplified (prompt)
async function createStationModal(){
  const name = prompt('Station name (e.g., Station 01)');
  const labId = prompt('Lab ID (e.g., labA)');
  if(!name || !labId) return showToast('Cancelled');
  try{
    const docRef = await addDoc(stationsCol, { name, labId, status:'available', createdAt: serverTimestamp() });
    await updateDoc(doc(db,'labs',labId), { stations: [] }); // ensure lab exists or create separately
    await audit('create_station', `${docRef.id} ${name}`);
    showToast('Station created');
  } catch(e){ showToast('Create station error: '+e.message); }
}

// Bulk set offline (admin)
async function bulkOfflineModal(){
  const ids = prompt('Enter station IDs separated by comma');
  if(!ids) return;
  const arr = ids.split(',').map(s=>s.trim()).filter(Boolean);
  const batch = writeBatch(db);
  arr.forEach(id => batch.update(doc(db,'stations',id), { status: 'offline' }));
  await batch.commit();
  await audit('bulk_offline', arr.join(','));
  showToast('Bulk offline applied');
}

// create user from admin UI
async function createUserFromAdmin(){
  const email = $('newUserEmail').value;
  const role = $('newUserRole').value;
  if(!email || !role) return showToast('Provide email and role');
  // Client cannot create Firebase Auth accounts directly with admin privileges without Cloud Function.
  // We'll create a users doc and instruct admin to create auth user via console or Cloud Function.
  const udoc = { email, role, createdBy: auth.currentUser.uid, createdAt: serverTimestamp() };
  await addDoc(usersCol, udoc);
  await audit('create_user_doc', email);
  showToast('User doc created. Create Auth record via Firebase Console or Cloud Function.');
}

// load user list
async function loadUserListAdmin(){
  const snap = await getDocs(usersCol);
  const container = $('userListAdmin'); container.innerHTML = '';
  snap.docs.forEach(d => {
    const u = d.data(); const div = document.createElement('div');
    div.className='muted small'; div.innerText = `${u.email} • ${u.role || 'unknown'}`;
    container.appendChild(div);
  });
}

// export audit PDF
async function exportAuditPdf(){
  const { jsPDF } = window.jspdf;
  const docp = new jsPDF();
  docp.setFontSize(12);
  docp.text('Audit Report', 10, 12);
  const snap = await getDocs(query(auditCol, orderBy('ts','desc'), limit(200)));
  let y = 22;
  snap.forEach(d => {
    const r = d.data();
    const line = `${new Date(r.ts?.toMillis?.()||Date.now()).toLocaleString()} | ${r.role||r.userId} | ${r.action} ${r.detail||''}`;
    docp.text(line, 10, y);
    y += 6; if(y>280){ docp.addPage(); y=20; }
  });
  docp.save('audit.pdf');
  await audit('export_audit_pdf');
}

// export docx
async function exportAuditDocx(){
  const docxLib = window.docx;
  const { Document, Packer, Paragraph, TextRun } = docxLib;
  const doc = new Document();
  const snap = await getDocs(query(auditCol, orderBy('ts','desc'), limit(200)));
  const children = [ new Paragraph('Audit Report') ];
  snap.forEach(d=>{
    const r = d.data();
    children.push(new Paragraph(`${new Date(r.ts?.toMillis?.()||Date.now()).toLocaleString()} | ${r.role||r.userId} | ${r.action} ${r.detail||''}`));
  });
  doc.addSection({ children });
  const packer = new Packer();
  const blob = await packer.toBlob(doc);
  saveAs(blob, 'audit.docx');
  await audit('export_audit_docx');
}

// ticket assign & close (simple placeholders)
async function assignTicket(){ showToast('Assign technician: Use ticket UI to select technician and assign'); }
async function closeTicket(){ showToast('Close ticket: Implement tech workflow'); }

// open settings (simple)
async function openSettingsModal(){
  const cfg = prompt('Set session default duration (minutes)', '60');
  if(cfg){
    await setDoc(settingsDoc, { sessionDefaultMinutes: Number(cfg) }, { merge:true });
    await audit('update_settings', `sessionDefault:${cfg}`);
    showToast('Settings saved');
  }
}

// Admin analytics chart drawing
async function drawAdminCharts(){
  // assignments per day (last 7 days)
  const snaps = await getDocs(assignmentsCol);
  const counts = {};
  snaps.forEach(d=>{
    const r = d.data();
    const day = r.startAt?.toDate?.toISOString?.().slice(0,10) || 'unknown';
    counts[day] = (counts[day]||0)+1;
  });
  const days = Object.keys(counts).slice(-7);
  const data = days.map(d=>counts[d]||0);
  const ctx = $('chartAssignments').getContext('2d');
  new Chart(ctx, { type:'bar', data:{ labels: days, datasets:[{ label:'Assignments', data }] } });

  // peak hours (sample from assignments)
  const hours = new Array(24).fill(0);
  snaps.forEach(d=>{
    const r = d.data();
    const dt = r.startAt?.toDate?.();
    if(dt) hours[dt.getHours()]++;
  });
  const ctx2 = $('chartPeak').getContext('2d');
  new Chart(ctx2, { type:'line', data:{ labels: hours.map((_,i)=>String(i)), datasets:[{ label:'Active sessions by hour', data: hours }] } });
}

// ---------------------- SUPERVISOR: init & features ----------------------
function initSupervisor(uid){
  // show available stations in dropdown
  populateAvailableStations();

  // listen to active stations (supervisors should see labs they have assigned — for simplicity show all)
  if(assignmentUnsub) assignmentUnsub();
  assignmentUnsub = onSnapshot(stationsCol, snap=>{
    const el = $('activeStationsList'); el.innerHTML = '';
    const healthEl = $('stationHealthList'); healthEl.innerHTML = '';
    snap.docs.forEach(d=>{
      const s = d.data();
      const div = document.createElement('div');
      div.className = 'muted small';
      div.innerHTML = `<strong>${s.name}</strong> • ${s.status} • Current: ${s.currentSession?.studentId||'none'}`;
      el.appendChild(div);
      // station health
      const he = document.createElement('div'); he.className='muted small';
      he.innerText = `${s.name} heartbeat: ${s.lastSeen ? new Date(s.lastSeen.toMillis()).toLocaleString() : 'n/a'}`;
      healthEl.appendChild(he);
    });
  });

  // chat real-time (global room)
  if(chatUnsub) chatUnsub();
  chatUnsub = onSnapshot(query(chatCol, orderBy('createdAt','asc'), limit(200)), snap=>{
    const box = $('supChatBox'); box.innerHTML = '';
    snap.docs.forEach(d=>{
      const m = d.data();
      const msg = document.createElement('div');
      msg.className = 'chat-item';
      msg.innerHTML = `<strong>${m.fromRole||m.fromUid}</strong> <div class="small muted">${m.text}</div><div class="muted small">${new Date(m.createdAt?.toMillis?.()||Date.now()).toLocaleTimeString()}</div>`;
      box.appendChild(msg);
    });
    box.scrollTop = box.scrollHeight;
  });

  // bind supervisor UI actions
  $('studentLookupForm').addEventListener('submit', supFetchStudent);
  $('assignStationBtn').addEventListener('click', supAssignStation);
  $('reserveStationBtn').addEventListener('click', supReserveStation);
  $('extendSessionBtn').addEventListener('click', supExtendSession);
  $('forceReleaseBtn').addEventListener('click', supForceReleaseSelected);
  $('reportMaintBtn').addEventListener('click', supReportMaintenance);
  $('supSendBtn').addEventListener('click', supSendChat);
  $('autoAssignBtn').addEventListener('click', supAutoAssignQueue);
  $('viewHistoryBtn').addEventListener('click', supViewHistory);
  $('lateAlertsBtn').addEventListener('click', supLateAlerts);
  $('heartbeatBtn').addEventListener('click', supCheckHeartbeats);
  $('supExportPdf').addEventListener('click', supExportPdf);
  $('supExportCsv').addEventListener('click', supExportCsv);

  audit('supervisor_login', `uid:${uid}`);
}

// Populate stations dropdown
async function populateAvailableStations(){
  const snap = await getDocs(query(stationsCol, orderBy('name')));
  const sel = $('availableStations'); sel.innerHTML = '';
  snap.forEach(d=>{
    const s = d.data();
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.innerText = `${s.name} [${s.status}]`;
    sel.appendChild(opt);
  });
}

// SUP: Student fetch
async function supFetchStudent(e){
  e.preventDefault();
  const sid = $('studentIdLookup').value.trim();
  if(!sid) return showToast('Enter student ID');
  const snap = await getDoc(doc(db, 'students', sid));
  if(!snap.exists()){
    showToast('Student not found; create new?');
    // Create minimal student doc for testing
    if(confirm('Create demo student doc?')){
      await setDoc(doc(db,'students',sid), { name: `Student ${sid}`, program:'Unknown', year:1, hostel: 'N/A' });
      showToast('Student created');
      return supFetchStudent(e);
    }
    return;
  }
  const st = snap.data();
  $('studentCard').classList.remove('hidden');
  $('stName').innerText = st.name;
  $('stProgram').innerText = st.program || '';
  $('stIdView').innerText = sid;
  $('stYear').innerText = st.year || '';
  $('sessionKeyView').innerText = '';
  $('assignmentMessage').innerText = '';
  await populateAvailableStations();
}

// generate session key
function genKey(){ return Math.random().toString(36).slice(2,8).toUpperCase(); }

// SUP: assign station (transaction)
async function supAssignStation(){
  const stationId = $('availableStations').value;
  const studentId = $('stIdView').innerText;
  if(!stationId || !studentId) return showToast('Select student and station');
  const sessionKey = genKey();
  try{
    await runTransaction(db, async (tx) => {
      const sRef = doc(db, 'stations', stationId);
      const sSnap = await tx.get(sRef);
      if(!sSnap.exists()) throw new Error('Station missing');
      const sData = sSnap.data();
      if(sData.status === 'occupied') throw new Error('Station already occupied');
      tx.update(sRef, { status:'occupied', currentSession:{ studentId, startAt: serverTimestamp(), key: sessionKey } });
      const aRef = doc(assignmentsCol);
      tx.set(aRef, { stationId, studentId, supervisorId: auth.currentUser.uid, key:sessionKey, startAt: serverTimestamp() });
    });
    $('sessionKeyView').innerText = sessionKey;
    $('assignmentMessage').innerText = 'Assigned successfully';
    await audit('assign_station', `station:${stationId} student:${studentId}`);
    populateAvailableStations();
  } catch(e){
    $('assignmentMessage').innerText = 'Assignment failed: ' + e.message;
  }
}

// SUP: reserve station (for exam) create assignment with reserved flag and scheduled time
async function supReserveStation(){
  const stationId = $('availableStations').value;
  const studentId = $('stIdView').innerText || null;
  const until = prompt('Reserve until (ISO datetime or leave blank for 2 hours from now)');
  let expiresAt = null;
  if(until) expiresAt = new Date(until);
  else { expiresAt = new Date(Date.now() + 1000*60*60*2); }
  try{
    const key = genKey();
    await setDoc(doc(assignmentsCol), { stationId, studentId, reserved:true, reservedBy: auth.currentUser.uid, key, startAt: serverTimestamp(), expiresAt });
    await updateDoc(doc(db,'stations',stationId), { status:'reserved', currentSession: { studentId, key, startAt: serverTimestamp(), expiresAt } });
    showToast('Station reserved');
    await audit('reserve_station', stationId);
    populateAvailableStations();
  } catch(e){ showToast('Reserve failed: '+e.message); }
}

// SUP: extend session (simple update to assignment end time or create field)
async function supExtendSession(){
  const studentId = $('stIdView').innerText; if(!studentId) return showToast('No student selected');
  const extraM = Number(prompt('Extend by minutes', '30'));
  if(isNaN(extraM)) return;
  // find active assignment
  const snaps = await getDocs(query(assignmentsCol, where('studentId','==',studentId), orderBy('startAt','desc'), limit(1)));
  if(snaps.empty) return showToast('No assignment found to extend');
  const aDoc = snaps.docs[0];
  const data = aDoc.data();
  const newEnd = data.expiresAt ? new Date(data.expiresAt.toDate().getTime() + extraM*60000) : new Date(Date.now()+extraM*60000);
  await updateDoc(aDoc.ref, { expiresAt: newEnd, extendedBy: auth.currentUser.uid });
  await updateDoc(doc(db,'stations', data.stationId), { 'currentSession.expiresAt': newEnd });
  await audit('extend_session', `${aDoc.id}`);
  showToast('Session extended');
}

// SUP: force release selected (release by station selected in dropdown)
async function supForceReleaseSelected(){
  const stationId = $('availableStations').value;
  if(!stationId) return showToast('Select a station to release');
  await updateDoc(doc(db,'stations',stationId), { currentSession: null, status: 'available' });
  await audit('sup_force_release', stationId);
  showToast('Station released');
}

// SUP: report maintenance
async function supReportMaintenance(){
  const stationId = $('availableStations').value || prompt('Enter station id to report');
  if(!stationId) return;
  await addDoc(ticketCol, { stationId, note:'Reported by supervisor', status:'open', raisedBy: auth.currentUser.uid, createdAt: serverTimestamp() });
  await updateDoc(doc(db,'stations',stationId), { status:'maintenance' });
  await audit('sup_report_maintenance', stationId);
  showToast('Maintenance ticket created');
}

// SUP: chat send
async function supSendChat(){
  const text = $('supChatInput').value.trim();
  if(!text) return;
  await addDoc(chatCol, { roomId: 'global', text, fromUid: auth.currentUser.uid, fromRole: await getRole(auth.currentUser.uid), createdAt: serverTimestamp() });
  $('supChatInput').value = '';
  await audit('sup_chat_send', text.slice(0,40));
}

// SUP: Auto-assign queue (simple round-robin using available stations)
async function supAutoAssignQueue(){
  // gather waiting students (here we prompt for a list)
  const raw = prompt('Enter student IDs (comma separated) to auto-assign');
  if(!raw) return;
  const students = raw.split(',').map(s=>s.trim()).filter(Boolean);
  const snaps = await getDocs(query(stationsCol, where('status','==','available')));
  const avail = snaps.docs.map(d=>d.id);
  if(avail.length === 0) return showToast('No available stations');
  let idx = 0;
  for(const studentId of students){
    const stationId = avail[idx % avail.length];
    const key = genKey();
    await runTransaction(db, async (tx) => {
      const sRef = doc(db,'stations',stationId); const sSnap = await tx.get(sRef);
      if(!sSnap.exists()) throw new Error('Station missing');
      if(sSnap.data().status === 'occupied') return; // skip
      tx.update(sRef, { status:'occupied', currentSession: { studentId, startAt: serverTimestamp(), key } });
      tx.set(doc(assignmentsCol), { stationId, studentId, supervisorId: auth.currentUser.uid, key, startAt: serverTimestamp() });
    });
    idx++;
  }
  await audit('auto_assign_queue', `${students.length} students`);
  showToast('Auto-assign finished');
  populateAvailableStations();
}

// SUP: view assignment history for selected student or station (simple)
async function supViewHistory(){
  const sid = prompt('Enter student ID to view history (leave blank for all)');
  let q = assignmentsCol;
  if(sid) q = query(assignmentsCol, where('studentId','==',sid), orderBy('startAt','desc'));
  const snap = await getDocs(q);
  let out = `Assignments (${snap.size}):\n`;
  snap.forEach(d=> { const a=d.data(); out += `${a.stationId} • ${a.studentId} • ${a.key||''} • ${a.startAt?.toDate?.()}\n` });
  alert(out);
}

// SUP: late session alerts (sessions that exceeded expected time)
async function supLateAlerts(){
  // simplistic: find assignments with startAt older than default session minutes + grace
  const sdoc = await getDoc(settingsDoc);
  const defaultM = sdoc.exists() ? sdoc.data().sessionDefaultMinutes || 60 : 60;
  const cutoff = Date.now() - (defaultM + 15) * 60000; // 15 min grace
  const snaps = await getDocs(assignmentsCol);
  const late = [];
  snaps.forEach(d=>{
    const a = d.data();
    const started = a.startAt?.toMillis?.();
    if(started && started < cutoff && !a.endAt) late.push({ id:d.id, ...a });
  });
  if(late.length===0) return alert('No late sessions found.');
  alert('Late sessions:\n' + late.map(l=>`${l.stationId} • ${l.studentId}`).join('\n'));
}

// SUP: heartbeats check (stations should push heartbeats regularly)
async function supCheckHeartbeats(){
  const snaps = await getDocs(heartbeatCol);
  const stale = [];
  snaps.forEach(d=>{
    const h = d.data();
    const last = h.lastSeen?.toMillis?.();
    if(Date.now() - (last || 0) > 1000*60*15) stale.push({ stationId:d.id, last });
  });
  if(stale.length===0) return showToast('All heartbeats healthy');
  showToast(`Stale heartbeats: ${stale.length}`);
  console.table(stale);
}

// SUP: Export PDF & CSV (simple)
async function supExportPdf(){
  // Export current assignments
  const { jsPDF } = window.jspdf;
  const docp = new jsPDF();
  const snap = await getDocs(query(assignmentsCol, orderBy('startAt','desc'), limit(200)));
  docp.text('Assignments Report', 10, 12);
  let y=22;
  snap.forEach(d=>{
    const a = d.data();
    docp.text(`${a.stationId} | ${a.studentId} | ${a.supervisorId || ''}`, 10, y);
    y+=6; if(y>280){ docp.addPage(); y=20; }
  });
  docp.save('assignments.pdf');
  await audit('sup_export_pdf');
}

async function supExportCsv(){
  const snap = await getDocs(query(assignmentsCol, orderBy('startAt','desc'), limit(500)));
  let csv = 'stationId,studentId,supervisorId,startAt\n';
  snap.forEach(d=>{
    const a = d.data();
    csv += `${a.stationId},${a.studentId},${a.supervisorId || ''},${a.startAt?.toDate?.().toISOString() || ''}\n`;
  });
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
  saveAs(blob, 'assignments.csv');
  await audit('sup_export_csv');
}

// ---------------------- COMMON features: chat listeners, heartbeat pings ----------------------

// Chat send globally used by admin too (global room)
document.addEventListener('keydown', (e)=> {
  if(e.key === 'Enter' && e.ctrlKey) {
    // quick send from sup chat input
    const input = $('supChatInput');
    if(input && input.value.trim()) supSendChat();
  }
});

// Listen to chat messages to show admin notification badges
onSnapshot(query(chatCol, orderBy('createdAt','asc')), snap=>{
  // Notification logic can be added here (flashing badges)
  // For simplicity, we don't add desktop notifications in this client.
});

// Heartbeat ping: stations (kiosk clients) should write to 'heartbeats/{stationId}' with lastSeen: serverTimestamp()
// But we implement a simple monitor that will check this collection periodically
if(heartbeatUnsub) heartbeatUnsub();
heartbeatUnsub = onSnapshot(heartbeatCol, snap => {
  // update a small table or log (not shown)
});

// ---------------------- EXTRA: Station hardware heartbeat & kiosk lock integration ----------------------
// Function to simulate kiosk posting heartbeat (for testing)
async function simulateHeartbeat(stationId){
  await setDoc(doc(db,'heartbeats',stationId), { lastSeen: serverTimestamp(), stationId, updatedBy: auth.currentUser?.uid || 'system' });
  await updateDoc(doc(db,'stations',stationId), { lastSeen: serverTimestamp() });
}

// ---------------------- BOILERPLATE: initial data seed helpers ----------------------
async function seedDemoData(){
  // Creates sample labs, stations, students (idempotent-ish)
  try{
    // labs
    const labs = ['labA','labB'];
    for(const lab of labs){
      await setDoc(doc(db,'labs',lab), { name: (lab==='labA'?'Computing Lab A':'Computing Lab B'), location:'Block X', supervisors:[] }, { merge:true });
    }
    // stations
    for(let i=1;i<=12;i++){
      const id = `st-${i.toString().padStart(2,'0')}`;
      await setDoc(doc(db,'stations',id), { name:`Station ${i}`, labId: i<=6? 'labA':'labB', status:'available', createdAt: serverTimestamp() }, { merge:true });
    }
    // students
    for(let i=1;i<=20;i++){
      const sid = `UMB${1000+i}`;
      await setDoc(doc(db,'students',sid), { name:`Student ${i}`, program: i%2? 'Software Eng' : 'Computer Science', year: (i%4)+1, hostel: `Block ${String.fromCharCode(65+(i%4))}` }, { merge:true });
    }
    showToast('Demo data seeded');
  } catch(e){ console.error(e); showToast('Seed failed: '+e.message); }
}

// hook seed for manual use
window.seedDemoData = seedDemoData;

// ---------------------- INITIALIZATION & small helpers ----------------------
async function loadInitial(){
  // ensure settings exist
  const s = await getDoc(settingsDoc);
  if(!s.exists()) await setDoc(settingsDoc, { sessionDefaultMinutes: 60 });
  checkHealth();
}
loadInitial();

// ---------------------- ADMIN & SUP: searching, bulk actions, admin quick UI wiring ----------------------
// Admin: search input wired to filter grid (very simple)
$('adminStationSearch').addEventListener('input', async (e)=>{
  const q = e.target.value.toLowerCase();
  // naive filter by scanning DOM entries
  const cards = document.querySelectorAll('#stationsGridAdmin .station-card');
  cards.forEach(card => {
    const txt = card.innerText.toLowerCase();
    card.style.display = txt.includes(q) ? '' : 'none';
  });
});

// ADMIN: load user list function is above; refresh every 60s
setInterval(() => { loadUserListAdmin().catch(()=>{}); }, 60000);

window.app = {
  seedDemoData, populateAvailableStations, simulateHeartbeat
};
