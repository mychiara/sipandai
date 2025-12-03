// --- INITIALIZATION ---

// 1. Initialize Firebase
// Check if apps are already initialized to prevent re-initialization errors
if (!firebase.apps.length) {
    firebase.initializeApp(CONFIG.firebase);
}

const db = firebase.firestore();
const auth = firebase.auth();

// 2. Initialize Supabase
// "supabase" global comes from the CDN script included in your HTML
const { createClient } = supabase; 
const sb = createClient(CONFIG.supabase.url, CONFIG.supabase.key);

// --- ALIASES & HELPERS ---

// FIREBASE ALIASES
const serverTimestamp = firebase.firestore.FieldValue.serverTimestamp;
const deleteField = firebase.firestore.FieldValue.delete;
const firestoreTimestamp = firebase.firestore.Timestamp; 

// SUPABASE ALIASES
const sbTimestamp = () => new Date().toISOString(); 
// CONSTANTS
const PRODI_SUMMARY_TABLE = 'prodi_summary'; 
const RPD_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Ags', 'Sep', 'Okt', 'Nov', 'Des'];
const PRODI_COLORS = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];
const AJUAN_IMPORT_HEADERS = ['Judul_Kegiatan', 'Grub_Belanja_Utama', 'Nama_Ajuan', 'ID_Kelompok', 'Jumlah', 'Satuan', 'Harga_Satuan', 'Keterangan', 'Status_Revisi', 'Data_Dukung'];
const GRUB_BELANJA_UTAMA_OPTIONS = [];

// Helper to get snake_case column key
const getMonthlyKey = (prefix, monthAbbr) => `${prefix.toLowerCase()}_${monthAbbr.toLowerCase()}`;
const RPD_SELECT_COLUMNS = RPD_MONTHS.map(m => `${getMonthlyKey('RPD', m)}, ${getMonthlyKey('Realisasi', m)}`).join(', ');

// --- STATE MANAGEMENT ---
let STATE = { 
  role: null, id: null, uid: null, currentUserData: null, 
  allKelompok: [], allProdi: [], allDirektoratUids: [], allGrubBelanja: [], 
  currentAjuanDataAwal: [], currentAjuanDataPerubahan: [], 
  stagingList: JSON.parse(localStorage.getItem('siPandai_stagingList')) || [],
  selectedAjuanIdsAwal: new Set(), selectedAjuanIdsPerubahan: new Set(),
  allDashboardData: [], cachedDashboardData: [], direktoratSummaryData: [],
  globalSettings: {}, beritaAcaraSettings: {}, currentAjuanType: 'Awal',
  logPageSize: 50, currentLogPage: 1
};

let CHARTS = {};
const LOADER = document.getElementById('loading-overlay');
const TOAST_CONTAINER = document.querySelector('.toast-container');

// --- HELPER FUNCTIONS ---

function showLoader(show) { if(LOADER) LOADER.style.display = show ? 'flex' : 'none'; }

function showToast(message, type = 'success') {
  const toastId = 'toast-' + Date.now();
  const toastHTML = `<div id="${toastId}" class="toast align-items-center text-bg-${type} border-0" role="alert"><div class="d-flex"><div class="toast-body">${message}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div></div>`;
  TOAST_CONTAINER.insertAdjacentHTML('beforeend', toastHTML);
  const toastEl = document.getElementById(toastId);
  if (toastEl) new bootstrap.Toast(toastEl, { delay: 5000 }).show();
}

function escapeHtml(s) { return s ? String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]) : ''; }

function getColorForProdi(prodiId) {
  if (!prodiId) return '#cccccc';
  let hash = 0; for (let i = 0; i < prodiId.length; i++) hash = prodiId.charCodeAt(i) + ((hash << 5) - hash);
  return PRODI_COLORS[Math.abs(hash % PRODI_COLORS.length)];
}

/**
 * Mendapatkan nama tabel Supabase berdasarkan string tipe ajuan.
 * Contoh: "Awal" -> "ajuan", "Perubahan 1" -> "ajuanrev1"
 */
function getAjuanTableName(tipe) {
    if (!tipe) return 'ajuan';
    if (tipe === 'Awal') return 'ajuan';
    
    // Cek format "Perubahan X"
    const match = tipe.match(/Perubahan (\d+)/);
    if (match) {
        const rev = parseInt(match[1], 10);
        if (rev >= 1 && rev <= 30) return `ajuanrev${rev}`;
    }
    
    // Fallback jika hanya "Perubahan" (gunakan tahap aktif)
    if (tipe.trim() === 'Perubahan') {
        const activeStage = STATE.globalSettings.Tahap_Perubahan_Aktif || 1;
        return `ajuanrev${activeStage}`;
    }
    return 'ajuan';
}

function sanitizeTipeForCSS(tipe) { return tipe ? tipe.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '') : ''; }

function safeAddClickListener(id, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
}

// Caching Helpers
function setCache(key, data, ttlMinutes = 120) {
    try { localStorage.setItem(key, JSON.stringify({ value: data, expiry: Date.now() + ttlMinutes * 60000 })); } catch (e) { console.warn("Storage full"); }
}
function getCache(key) {
    try {
        const item = JSON.parse(localStorage.getItem(key));
        if (!item) return null;
        if (Date.now() > item.expiry) { localStorage.removeItem(key); return null; }
        return item.value;
    } catch (e) { return null; }
}

// Input Helpers
const getElValue = (id) => document.getElementById(id)?.value || '';
const getSafeValue = (id) => document.getElementById(id)?.value || '';
const setElValue = (id, val) => { const el = document.getElementById(id); if(el) el.value = val; };
const getElChecked = (id) => document.getElementById(id)?.checked || false;
const setElChecked = (id, val) => { const el = document.getElementById(id); if(el) el.checked = val; };


// --- DOM CONTENT LOADED ---
document.addEventListener('DOMContentLoaded', function() {
const editUserRoleSelect = document.getElementById('edit_user_role');
if (editUserRoleSelect) {
    editUserRoleSelect.addEventListener('change', function() {
        const ttdGroup = document.getElementById('edit-ttd-settings-group');
        // Tampilkan setting TTD hanya jika role adalah 'prodi'
        // Sembunyikan jika role 'direktorat' atau 'pimpinan'
        if (ttdGroup) {
            ttdGroup.style.display = (this.value === 'prodi') ? 'block' : 'none';
        }
    });
}

// --- CORE FUNCTION: AUTO COPY AJUAN (RPC VERSION) ---
async function performPindahkanAjuan() {
    // Validasi Role
    if (STATE.role !== 'prodi' && STATE.role !== 'direktorat') {
         showToast("Akses ditolak.", "danger"); return;
    }
    
    showLoader(true);
    try {
        const tahapAktif = STATE.globalSettings?.Tahap_Perubahan_Aktif || 1;
        const tahapSebelumnya = tahapAktif - 1;

        if (tahapAktif <= 0) {
             throw new Error("Tahap Perubahan belum diaktifkan (Tahap 0).");
        }

        const sourceType = tahapSebelumnya === 0 ? "Awal" : `Perubahan ${tahapSebelumnya}`;
        const destinationType = `Perubahan ${tahapAktif}`;

        const sourceTable = getAjuanTableName(sourceType);
        const destTable = getAjuanTableName(destinationType);

        if (sourceTable === destTable) throw new Error("Tabel sumber dan tujuan sama.");

        // Parameter untuk RPC
        // Jika Prodi: kirim ID Prodi agar hanya menyalin data miliknya
        // Jika Direktorat: kirim NULL untuk menyalin semua
        const targetProdi = STATE.role === 'prodi' ? STATE.id : null; 

        // Panggil RPC 'copy_accepted_ajuan' di Supabase
        const { data: rpcResult, error: rpcError } = await sb.rpc('copy_accepted_ajuan', {
            source_table: sourceTable,
            dest_table: destTable,
            target_prodi_id: targetProdi,
            target_tipe_label: destinationType
        });

        if (rpcError) throw rpcError;

        const count = rpcResult.count || 0;

        if (count > 0) {
            const msg = STATE.role === 'prodi' 
                ? `${count} ajuan berhasil disalin dari ${sourceType} ke ${destinationType}.`
                : `${count} ajuan berhasil dipindahkan (Direktorat).`;
            
            showToast(msg, "success");
            
            await logActivity("Auto Copy Ajuan", `Menyalin ${count} item dari ${sourceTable} ke ${destTable}`);

            // Update Summary (Pagu)
            if (STATE.role === 'prodi') {
                await recalculateProdiSummary(STATE.id);
            } else if (STATE.role === 'direktorat') {
                 // Untuk direktorat, idealnya kita tahu prodi mana saja yang terupdate. 
                 // Untuk simplifikasi, kita refresh dashboard utama.
                 STATE.direktoratSummaryData = []; 
            }

            // Refresh tampilan tabel perubahan
            refreshAjuanTablePerubahan(true);
            
            // Refresh Pagu Info di UI
            updateProdiPaguInfo(STATE.currentUserData);
        } else {
            showToast(`Tidak ada ajuan baru berstatus 'Diterima' di ${sourceType} yang perlu disalin.`, "info");
        }

    } catch (e) {
        console.error("Gagal auto copy:", e);
        let msg = e.message;
        if (e.code === 'PGRST202') msg = "Fungsi server (RPC) tidak ditemukan. Hubungi Administrator.";
        showToast(`Gagal menyalin ajuan: ${msg}`, "danger");
    } finally {
        showLoader(false);
    }
}

// Bind Global Button for Manual Trigger (Backup)
safeAddClickListener("btn-copy-accepted", async () => { await performPindahkanAjuan(); });
safeAddClickListener("btn-pindahkan-ajuan-backend", async () => { await performPindahkanAjuan(); });


// --- UI UPDATER: PERUBAHAN & COPY BUTTON ---
function updatePerubahanUI(settings) {
    const isTahapPerubahanOpen = settings.Status_Ajuan_Perubahan === 'Dibuka';
    const tahapAktif = settings.Tahap_Perubahan_Aktif || 1;
    const tahapStr = `Perubahan ${tahapAktif}`;

    // Toggle Nav Items
    ['nav-item-ajuan-perubahan', 'nav-item-daftar-perubahan', 'nav-item-rpd-perubahan', 'nav-item-realisasi-perubahan'].forEach(id => {
        const el = document.getElementById(id);
        if(el) el.style.display = isTahapPerubahanOpen ? 'block' : 'none';
    });

    // Update Labels
    if (isTahapPerubahanOpen) {
      const linkAjuanPerubahan = document.querySelector('#link-ajuan-perubahan');
      const linkDaftarPerubahan = document.querySelector('#link-daftar-perubahan');
      const linkRpd = document.querySelector('#link-rpd-perubahan');
      const linkReal = document.querySelector('#link-realisasi-perubahan');

      if (linkAjuanPerubahan) linkAjuanPerubahan.innerHTML = `<i class="bi bi-pencil-square"></i> Buat Ajuan ${tahapStr}`;
      if (linkDaftarPerubahan) linkDaftarPerubahan.innerHTML = `<i class="bi bi-list-check"></i> Daftar Ajuan ${tahapStr}`;
      if (linkRpd) linkRpd.innerHTML = `<i class="bi bi-calendar2-event"></i> RPD ${tahapStr}`;
      if (linkReal) linkReal.innerHTML = `<i class="bi bi-graph-up-arrow"></i> Realisasi ${tahapStr}`;
    }
    
    // Konfigurasi Tombol Copy
    const copyBtn = document.getElementById('btn-copy-accepted');
    if (copyBtn) {
        // Tampilkan tombol jika Tahap Perubahan Dibuka DAN (Role Prodi ATAU Direktorat)
        if (isTahapPerubahanOpen && (STATE.role === 'prodi' || STATE.role === 'direktorat')) { 
             copyBtn.style.display = 'inline-block';
             const sourceStr = tahapAktif == 1 ? "Awal" : `Perubahan ${tahapAktif - 1}`;
             const destinationStr = `Perubahan ${tahapAktif}`;
             
             copyBtn.innerHTML = `<i class="bi bi-files"></i> Pindahkan Ajuan Diterima (${sourceStr} &rarr; ${destinationStr})`;
             copyBtn.title = `Salin otomatis semua ajuan 'Diterima' dari ${sourceStr} ke ${destinationStr}`;
        } else {
             copyBtn.style.display = 'none';
        }
    }
}


// --- SUMMARY CALCULATION ---
// GANTIKAN FUNGSI recalculateProdiSummary YANG LAMA DENGAN INI:

async function recalculateProdiSummary(prodiId) {
    if (!prodiId) return;
    
    try {
        // Panggil RPC yang baru kita buat
        const { data, error } = await sb.rpc('get_prodi_summary', { target_prodi_id: prodiId });

        if (error) throw error;

        // Ambil hasil perhitungan (biasanya array dengan 1 objek)
        const result = data[0] || { 
            total_diajukan: 0, 
            total_diterima: 0, 
            total_rpd: 0, 
            total_realisasi: 0 
        };

        // Ambil Pagu Awal (Ceiling) dari User Profile (karena tidak ada di tabel ajuan)
        const prodiUserData = STATE.allProdi.find(p => p.ID_Prodi === prodiId);
        const paguAwal = Number(prodiUserData?.Pagu_Anggaran) || 0;

        // Simpan hasil ringkas ke tabel prodi_summary (agar dashboard cepat)
        const summaryData = {
            id_prodi: prodiId,
            pagu_awal_ceiling: paguAwal,
            total_diajukan_overall: result.total_diajukan,
            total_diterima_final_bersih: result.total_diterima,
            total_rpd_commitment: result.total_rpd,
            total_realisasi_overall: result.total_realisasi,
            last_updated: new Date().toISOString()
        };

        const { error: upsertError } = await sb.from(PRODI_SUMMARY_TABLE)
            .upsert(summaryData, { onConflict: 'id_prodi' });

        if (upsertError) throw upsertError;

        // Clear cache dashboard agar UI refresh
        STATE.direktoratSummaryData = []; 
        
    } catch (error) {
        console.error(`[SUMMARY RPC] Failed for ${prodiId}:`, error);
    }
}

// --- LOGGING ---
async function logActivity(action, details = '') {
  if (!STATE.uid) return;
  sb.from('activityLog').insert({ action, details, userId: STATE.id, userUid: STATE.uid, timestamp: sbTimestamp() });
}

// --- MIGRATED TO SUPABASE: Load Global Settings (FIXED) ---
async function loadGlobalSettings() {
    console.log("[GlobalSettings] Memulai pemuatan dari Supabase...");
    try {
        const { data, error } = await sb
            .from('app_config')
            .select('settings')
            .eq('id', 'globalSettings')
            .maybeSingle();

        if (error) {
            console.error("[GlobalSettings] Error Query:", error);
            throw error;
        }

        if (data && data.settings) {
            console.log("[GlobalSettings] Data ditemukan:", data.settings);
            STATE.globalSettings = data.settings;

            // --- PENTING: Konversi Tanggal agar Dashboard Tidak Error ---
            // Dashboard mengharapkan fungsi .toDate(), kita buat shim/pengganti manual
            
            // 1. Batas Tanggal Awal
            if (STATE.globalSettings.Batas_Tanggal_Pengajuan) {
                const rawDate = STATE.globalSettings.Batas_Tanggal_Pengajuan;
                STATE.globalSettings.Batas_Tanggal_Pengajuan = {
                    toDate: () => new Date(rawDate) // Membuat fake Timestamp object
                };
            }

            // 2. Batas Tanggal Perubahan
            if (STATE.globalSettings.Batas_Tanggal_Pengajuan_Perubahan) {
                const rawDate = STATE.globalSettings.Batas_Tanggal_Pengajuan_Perubahan;
                STATE.globalSettings.Batas_Tanggal_Pengajuan_Perubahan = {
                    toDate: () => new Date(rawDate) // Membuat fake Timestamp object
                };
            }
        } else {
            console.warn("[GlobalSettings] Data KOSONG di Supabase. Menggunakan default.");
            // Default Values agar UI tidak rusak jika DB kosong
            STATE.globalSettings = {
                Status_Ajuan_Awal: 'Ditutup',
                Status_Ajuan_Perubahan: 'Ditutup',
                Tahap_Perubahan_Aktif: 1,
                Pengumuman_Aktif: false,
                Pengumuman_Teks: ''
            };
        }
    } catch (e) {
        console.error("[GlobalSettings] Gagal memuat:", e);
        STATE.globalSettings = {};
    }
}

async function initializeApp(userData) {
    STATE.role = userData.Role;
    STATE.id = userData.ID_Prodi;
    STATE.uid = userData.uid;
    STATE.currentUserData = userData;

    document.body.classList.remove('login-view');
    document.getElementById('login-page-wrapper').style.display = 'none';
    document.getElementById('app-area').style.display = 'block';
    document.getElementById('welcome').innerHTML = `<span class="badge bg-secondary me-2">${STATE.role.toUpperCase()}</span> <strong>${STATE.id} - ${userData.Nama_Prodi}</strong>`;
    
    await loadGlobalSettings(); 
    updatePerubahanUI(STATE.globalSettings); 
    
    // Hide/Show Menus based on Role/Settings
    const isPerubahanOpen = STATE.globalSettings.Status_Ajuan_Perubahan === 'Dibuka';
    if(document.getElementById('nav-item-ajuan-awal')) 
        document.getElementById('nav-item-ajuan-awal').style.display = isPerubahanOpen ? 'none' : 'block';
    
    if (STATE.role === 'prodi') {
      STATE.currentAjuanType = isPerubahanOpen ? `Perubahan ${STATE.globalSettings.Tahap_Perubahan_Aktif || 1}` : 'Awal';
      document.getElementById('direktorat-charts').style.display = 'none';
    } else { 
      document.getElementById('direktorat-charts').style.display = 'block';
    }
    
    await loadInitialData(); 
    loadDashboardData();
    setupExportListeners();
}

async function loadInitialData() {
    showLoader(true);
    try {
        await refreshGrubBelanjaData(); 
        await refreshKelompokData(); 
        await refreshProdiData(); 

        refreshAjuanTableAwal(true); 
    } catch (e) { showToast('Gagal memuat data awal.', 'danger'); } 
    finally { showLoader(false); }
}

async function refreshGrubBelanjaData() {
    const cached = getCache('cache_allGrubBelanja');
    if(cached) { STATE.allGrubBelanja = cached; } else {
        const { data } = await sb.from('grub_belanja')('ID_Grub, Nama_Grub');
        STATE.allGrubBelanja = data || [];
        setCache('cache_allGrubBelanja', STATE.allGrubBelanja);
    }
    GRUB_BELANJA_UTAMA_OPTIONS.length = 0;
    STATE.allGrubBelanja.forEach(g => GRUB_BELANJA_UTAMA_OPTIONS.push(g.Nama_Grub));
    
    ['selectGrub', 'edit-selectGrub'].forEach(id => populateGrubBelanja(id));
    ['filterGrubAwal', 'filterGrubPerubahan'].forEach(id => populateGrubBelanja(id, true));
}

async function refreshKelompokData() {
    const cached = getCache('cache_allKelompok');
    if(cached) { STATE.allKelompok = cached; } else {
        const { data } = await sb.from('kelompok').select('ID_Kelompok, Nama_Kelompok');
        STATE.allKelompok = data || [];
        setCache('cache_allKelompok', STATE.allKelompok);
    }
    ['selectKelompok', 'edit-selectKelompok'].forEach(id => populateKelompok(STATE.allKelompok, id));
    ['filterKelompokAwal', 'filterKelompokPerubahan'].forEach(id => populateKelompokFilter(STATE.allKelompok, id));
}

async function refreshProdiData() {
    const cached = getCache('cache_allProdi');
    if(cached) { STATE.allProdi = cached; } else {
        const snap = await db.collection('users').get();
        STATE.allProdi = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
        setCache('cache_allProdi', STATE.allProdi);
    }
    if (STATE.role === 'direktorat') {
        const list = STATE.allProdi.filter(p => p.Role === 'prodi');
        ['filterProdiAwal', 'filterProdiPerubahan', 'filterProdiRPDAwal', 'filterProdiRPDPerubahan', 'filterProdiRealisasiAwal', 'filterProdiRealisasiPerubahan'].forEach(id => populateProdiFilter(list, id));
        populateProdiList(STATE.allProdi);
    }
}

// --- LOGIN ---
document.getElementById('btn-login').addEventListener('click', async () => {
    const e = document.getElementById('input-user-id').value;
    const p = document.getElementById('input-password').value;
    showLoader(true);
    try {
        const uc = await auth.signInWithEmailAndPassword(e, p);
        const ud = await db.collection('users').doc(uc.user.uid).get();
        if (ud.exists) initializeApp({ ...ud.data(), uid: uc.user.uid });
        else throw new Error("Profil tidak ditemukan.");
    } catch (er) { showToast(er.message, 'danger'); }
    finally { showLoader(false); }
});

// --- AJUAN TABLE LOGIC ---
async function refreshAjuanTable(tipe) {
    const isPerubahan = tipe.startsWith('Perubahan');
    const containerId = isPerubahan ? 'tableAjuanPerubahan' : 'tableAjuanAwal';
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = `<div class="text-center p-5">Memuat data ${tipe}...</div>`;
    const tableName = getAjuanTableName(tipe);

    let query = sb.from(tableName).select('*').eq('Tipe_Ajuan', tipe);
    if (STATE.role === 'prodi') query = query.eq('ID_Prodi', STATE.id);

    // Apply Filter jika ada
    const prodiFilter = getSafeValue(isPerubahan ? 'filterProdiPerubahan' : 'filterProdiAwal');
    if (prodiFilter) query = query.eq('ID_Prodi', prodiFilter);

    const { data, error } = await query.order('Timestamp', { ascending: false });

    if (error) {
        container.innerHTML = `<div class="text-center text-danger">Error: ${error.message}</div>`;
        return;
    }

    if (isPerubahan) STATE.currentAjuanDataPerubahan = data;
    else STATE.currentAjuanDataAwal = data;

    renderAjuanTable(data, tipe);
}

// --- OPTIMIZATION: Fungsi controller untuk mengelola pemanggilan data ---
const refreshAjuanTableAwal = (forceRefresh = false) => {
    // Jika tidak dipaksa refresh DAN data sudah ada di cache state, gunakan data yang ada
    if (!forceRefresh && STATE.currentAjuanDataAwal && STATE.currentAjuanDataAwal.length > 0) {
        console.log("Menampilkan data Ajuan Awal dari cache state.");
        renderAjuanTable(STATE.currentAjuanDataAwal, 'Awal');
        return;
    }
    // Jika dipaksa atau data belum ada, panggil fungsi fetch
    console.log("Mengambil data Ajuan Awal dari Supabase.");
    refreshAjuanTable('Awal');
};

const refreshAjuanTablePerubahan = (forceRefresh = false) => {
    const tahapAktif = STATE.globalSettings.Tahap_Perubahan_Aktif || 1;
    const tipe = `Perubahan ${tahapAktif}`;
    
    // Jika tidak dipaksa refresh DAN data sudah ada di cache state, gunakan data yang ada
    if (!forceRefresh && STATE.currentAjuanDataPerubahan && STATE.currentAjuanDataPerubahan.length > 0 && STATE.currentAjuanType === tipe) {
        console.log("Menampilkan data Ajuan Perubahan dari cache state.");
        renderAjuanTable(STATE.currentAjuanDataPerubahan, tipe);
        return;
    }
    // Jika dipaksa atau data belum ada, panggil fungsi fetch
    console.log("Mengambil data Ajuan Perubahan dari Supabase.");
    refreshAjuanTable(tipe);
};

function renderAjuanTable(data, tipe) {
    const isPerubahan = tipe.startsWith('Perubahan');
    const containerId = isPerubahan ? 'tableAjuanPerubahan' : 'tableAjuanAwal';
    const container = document.getElementById(containerId);
    
    if (!data || data.length === 0) {
        container.innerHTML = '<div class="text-center text-muted p-5">Belum ada ajuan.</div>';
        return;
    }

    let html = `<table class="table table-hover table-sm small align-middle">
        <thead class="table-light">
            <tr>
                <th>Judul & Rincian</th>
                <th class="text-end">Total</th>
                <th class="text-center">Status</th>
                <th>Aksi</th>
            </tr>
        </thead><tbody>`;
        
    data.forEach(r => {
        const total = Number(r.Total).toLocaleString('id-ID');
        const badgeClass = r.Status === 'Diterima' ? 'bg-success' : (r.Status === 'Ditolak' ? 'bg-danger' : 'bg-secondary');
        const blocked = r.Is_Blocked ? '<span class="badge bg-dark ms-1">BLOCKED</span>' : '';
        
        html += `<tr>
            <td>
                <strong>${escapeHtml(r.Nama_Ajuan)}</strong>
                <div class="text-muted small">${escapeHtml(r.Judul_Kegiatan)}</div>
            </td>
            <td class="text-end font-monospace">Rp ${total}</td>
            <td class="text-center"><span class="badge ${badgeClass}">${r.Status}</span>${blocked}</td>
            <td>
                <button class="btn btn-sm btn-outline-primary" onclick="window.openHistoryModal('${r.ID_Ajuan}', '${escapeHtml(r.Nama_Ajuan)}')"><i class="bi bi-clock"></i></button>
            </td>
        </tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;
}

// --- TAB EVENTS ---
const tabPerubahan = document.querySelector('[data-bs-target="#tab-daftar-perubahan"]');
if (tabPerubahan) tabPerubahan.addEventListener('shown.bs.tab', () => refreshAjuanTablePerubahan());

const tabAwal = document.querySelector('[data-bs-target="#tab-daftar-awal"]');
if (tabAwal) tabAwal.addEventListener('shown.bs.tab', () => refreshAjuanTableAwal());


// --- STUB FUNCTIONS (Agar Script Tetap Kompatibel) ---
// (Fungsi-fungsi ini dipanggil di HTML atau bagian lain, pastikan ada implementasinya jika dibutuhkan fitur lengkapnya)
window.updateProdiPaguInfo = async (userData) => { /* Update UI info pagu */ };
window.openHistoryModal = async (id, name) => { 
    // Simplified History Modal
    alert(`History for ID: ${id} (${name}) belum diimplementasi penuh dalam versi ringkas ini.`);
};

// --- TAMBAHKAN FUNGSI INI ---
function downloadAjuanTemplate() {
    // Header sesuai dengan AJUAN_IMPORT_HEADERS di konstanta atas
    const headers = [
        'Judul_Kegiatan', 
        'Grub_Belanja_Utama', 
        'Nama_Ajuan', 
        'ID_Kelompok', 
        'Jumlah', 
        'Satuan', 
        'Harga_Satuan', 
        'Keterangan', 
        'Status_Revisi', 
        'Data_Dukung'
    ];

    // Data contoh (opsional, agar user paham cara isi)
    const sampleData = [
        [
            "Kegiatan Workshop Kurikulum", 
            "Belanja Barang", 
            "Kertas A4", 
            "K-01", 
            10, 
            "Rim", 
            55000, 
            "Untuk keperluan workshop", 
            "Ajuan Baru", 
            "http://link-google-drive..."
        ]
    ];

    // Buat Workbook baru
    const wb = XLSX.utils.book_new();
    // Buat Sheet dengan Header
    const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleData]);
    
    // Tambahkan sheet ke workbook
    XLSX.utils.book_append_sheet(wb, ws, "Template Ajuan");

    // Download file
    XLSX.writeFile(wb, "Template_Import_Ajuan_SiPandai.xlsx");
}

  function setupExportListeners() {
      // Helper to get the current sanitized type for dynamic tables (like Perubahan-1)
      const getCurrentAjuanTipe = () => {
          const tipe = STATE.currentAjuanType || 'Awal';
          return sanitizeTipeForCSS(tipe);
      };
      
      const getCurrentPerubahanTipe = (prefix) => {
          const tahap = STATE.globalSettings.Tahap_Perubahan_Aktif || 1;
          return `${prefix}Perubahan${tahap}`;
      }

      // 1. Ajuan Awal (Daftar Ajuan)
      safeAddClickListener('btn-export-excel-awal', () => exportTableToExcel('table-export-Awal', 'Daftar_Ajuan_Awal'));
      safeAddClickListener('btn-print-awal', () => printContainer('tableAjuanAwal'));
      safeAddClickListener('btn-export-pdf-awal', () => exportContainerToPDF('tableAjuanAwal', 'Daftar_Ajuan_Awal', 'landscape'));

      // 2. Ajuan Perubahan (Daftar Ajuan)
      safeAddClickListener('btn-export-excel-perubahan', () => {
          const sanitizedTipe = getCurrentAjuanTipe();
          exportTableToExcel(`table-export-${sanitizedTipe}`, `Daftar_Ajuan_${sanitizedTipe}`);
      });
      safeAddClickListener('btn-print-perubahan', () => printContainer('tableAjuanPerubahan'));
      safeAddClickListener('btn-export-pdf-perubahan', () => exportContainerToPDF('tableAjuanPerubahan', 'Daftar_Ajuan_Perubahan', 'landscape'));

      // 3. RPD Awal
      safeAddClickListener('btn-export-excel-rpd-awal', () => exportTableToExcel('table-export-RPDAwal', 'RPD_Awal'));
      safeAddClickListener('btn-print-rpd-awal', () => printContainer('tableRPDAwal'));
      safeAddClickListener('btn-export-pdf-rpd-awal', () => exportContainerToPDF('tableRPDAwal', 'RPD_Awal', 'landscape'));


      // 4. RPD Perubahan
      safeAddClickListener('btn-export-excel-rpd-perubahan', () => {
           const tipe = getCurrentPerubahanTipe('RPD');
           exportTableToExcel(`table-export-${tipe}`, `RPD_${tipe}`);
      });
      safeAddClickListener('btn-print-rpd-perubahan', () => printContainer('tableRPDPerubahan'));
      safeAddClickListener('btn-export-pdf-rpd-perubahan', () => exportContainerToPDF('tableRPDPerubahan', 'RPD_Perubahan', 'landscape'));
      
      // 5. Realisasi Awal
      safeAddClickListener('btn-export-excel-realisasi-awal', () => exportTableToExcel('table-export-RealisasiAwal', 'Realisasi_Awal'));
      safeAddClickListener('btn-print-realisasi-awal', () => printContainer('tableRealisasiAwal'));
      safeAddClickListener('btn-export-pdf-realisasi-awal', () => exportContainerToPDF('tableRealisasiAwal', 'Realisasi_Awal', 'landscape'));


      // 6. Realisasi Perubahan
      safeAddClickListener('btn-export-excel-realisasi-perubahan', () => {
           const tipe = getCurrentPerubahanTipe('Realisasi');
           exportTableToExcel(`table-export-${tipe}`, `Realisasi_${tipe}`);
      });
      safeAddClickListener('btn-print-realisasi-perubahan', () => printContainer('tableRealisasiPerubahan'));
      safeAddClickListener('btn-export-pdf-realisasi-perubahan', () => exportContainerToPDF('tableRealisasiPerubahan', 'Realisasi_Perubahan', 'landscape'));
      
      // 7. Berita Acara Handlers
      safeAddClickListener('btn-preview-ba', handleBeritaAcaraPreview);
      safeAddClickListener('btn-print-ba', () => printContainer('berita-acara-content')); // Use printContainer for optimized printing
      // Bound to btn-download-pdf-ba based on index.html ID
      safeAddClickListener('btn-download-pdf-ba', () => { 
          const tipe = document.getElementById('filterTipeBA').value || 'Awal';
          const orientationEl = document.getElementById('ba-orientation');
          const orientation = orientationEl ? orientationEl.value : (tipe === 'Awal' ? 'portrait' : 'landscape');
          exportContainerToPDF('berita-acara-content', `Berita_Acara_${tipe.replace(/\s/g, '_')}`, orientation);
      });
      
      // 8. Dashboard Refresh
      safeAddClickListener('btn-refresh-dashboard', () => loadDashboardData(true));
      
      // 9. Ajuan Template Download (NEW)
      safeAddClickListener('btn-download-ajuan-template', downloadAjuanTemplate);
  }
  // Tambahkan ini di area Event Listeners
const filterProdiRekapan = document.getElementById('filterProdiRekapan');
if (filterProdiRekapan) {
    filterProdiRekapan.addEventListener('change', () => {
        loadRekapanRealisasi(); // Memanggil ulang fungsi load data
    });
}

// Pastikan filter Grub dan Kelompok juga memicu reload (jika belum ada)
const filterGrubRekapan = document.getElementById('filterGrubBelanja');
if (filterGrubRekapan) {
    filterGrubRekapan.addEventListener('change', loadRekapanRealisasi);
}

const filterKelompokRekapan = document.getElementById('filterKelompokBelanja');
if (filterKelompokRekapan) {
    filterKelompokRekapan.addEventListener('change', loadRekapanRealisasi);
}

  // --- END UTILITY FUNCTIONS FOR EXPORT & PRINT ---
  
    // --- NEW: RECALCULATE PRODI SUMMARY TABLE ---
    /**
     * Recalculates all dashboard metrics for a single Prodi/Unit and updates the prodi_summary table.
     * @param {string} prodiId 
     */
     async function recalculateProdiSummary(prodiId) {
        if (!prodiId) return;
        // console.log(`[SUMMARY] Recalculating summary for ${prodiId}`);
        
        try {
            const tahapAktif = STATE.globalSettings.Tahap_Perubahan_Aktif || 0;
            
            // We only need to look at Awal and the LATEST active revision table.
            // Previous revisions are historically relevant but the "Budget Ceiling" is determined by the latest state.
            let tablesToQuery = ['ajuan']; 
            if (tahapAktif > 0) {
                 tablesToQuery.push(getAjuanTableName(`Perubahan ${tahapAktif}`));
            }

            let totalDiajukanOverall = 0;
            let totalDiterimaAwalBersih = 0; // Specifically from 'ajuan' table
            let totalDiterimaFinalBersih = 0; // Awal + Changes in Perubahan
            let totalRpdCommitment = 0;
            let totalRealisasiOverall = 0;

            // Initialize monthly sums
            const rpdMonthly = {};
            const realisasiMonthly = {};
            RPD_MONTHS.forEach(m => {
                rpdMonthly[getMonthlyKey('RPD', m)] = 0;
                realisasiMonthly[getMonthlyKey('Realisasi', m)] = 0;
            });

            // Iterate through relevant tables
            for (const tableName of tablesToQuery) {
                 const isAwalTable = tableName === 'ajuan';

                 const { data: rawData, error } = await sb.from(tableName)
                    .select(`Total, Status, Tipe_Ajuan, Is_Blocked, ${RPD_SELECT_COLUMNS}`)
                    .eq('ID_Prodi', prodiId);
                
                 if (error) {
                    console.error(`[SUMMARY] Failed to query ${tableName}:`, error);
                    continue;
                 }

                 rawData.forEach(ajuan => {
                    const total = Number(ajuan.Total) || 0;
                    const isBlocked = !!ajuan.Is_Blocked;

                    totalDiajukanOverall += total;

                    if (ajuan.Status === 'Diterima' && !isBlocked) {
                        // If we are in the Awal table, add to Awal total
                        if (isAwalTable) {
                            totalDiterimaAwalBersih += total;
                        } 
                        
                        // logic for Final Budget:
                        // Note: If 'Perubahan' entries represent the *difference* (+/-), simply summing them is correct.
                        // If 'Perubahan' entries represent the *new full value* of a specific item, logic depends on ID tracking.
                        // Assuming standard SiPandai logic: All 'Diterima' items in active tables constitute the budget.
                        totalDiterimaFinalBersih += total;

                        // RPD & Realisasi aggregation
                        RPD_MONTHS.forEach(m => {
                            const rpdVal = Number(ajuan[getMonthlyKey('RPD', m)]) || 0;
                            const realVal = Number(ajuan[getMonthlyKey('Realisasi', m)]) || 0;
                            
                            totalRpdCommitment += rpdVal;
                            totalRealisasiOverall += realVal;

                            rpdMonthly[getMonthlyKey('RPD', m)] += rpdVal;
                            realisasiMonthly[getMonthlyKey('Realisasi', m)] += realVal;
                        });
                    }
                 });
            }
            
            // Get Pagu Awal from Firebase State
            const prodiUserData = STATE.allProdi.find(p => p.ID_Prodi === prodiId);
            const paguAwal = Number(prodiUserData?.Pagu_Anggaran) || 0;

            const summaryData = {
                id_prodi: prodiId,
                pagu_awal_ceiling: paguAwal,
                total_diajukan_overall: totalDiajukanOverall,
                total_diterima_awal_bersih: totalDiterimaAwalBersih,
                total_diterima_final_bersih: totalDiterimaFinalBersih, 
                total_rpd_commitment: totalRpdCommitment,
                total_realisasi_overall: totalRealisasiOverall,
                realisasi_monthly: realisasiMonthly,
                rpd_monthly: rpdMonthly,
                last_updated: sbTimestamp()
            };

            const { error: upsertError } = await sb.from(PRODI_SUMMARY_TABLE)
                .upsert(summaryData, { onConflict: 'id_prodi' });

            if (upsertError) throw upsertError;

            // Clear cache to ensure UI updates immediately
            STATE.direktoratSummaryData = []; 
            
        } catch (error) {
            console.error(`[SUMMARY] Failed to update summary for ${prodiId}:`, error);
        }
    }
    // --- END: RECALCULATE PRODI SUMMARY TABLE ---

  
  // --- MIGRATED TO SUPABASE: activityLog ---
  // Temukan fungsi ini di script.js dan ubah bagian catch-nya
async function logActivity(action, details = '') {
  if (!STATE.uid || !STATE.id) {
     // Jika dipanggil sebelum STATE terisi (misal, sebelum initializeApp selesai), lewati
     return;
  }
  const payload = {
      action: action,
      details: details,
      userId: STATE.id,
      userUid: STATE.uid,
      timestamp: sbTimestamp()
  };
  
  try {
      const { error } = await sb.from('activityLog').insert(payload);
      
      if (error) {
           console.error("Supabase Log Activity FAILED:", error);
           throw new Error("Supabase insert error: " + error.message);
      }
      
  } catch (e) {
      // Ini akan menangkap kegagalan koneksi atau RLS yang masih bandel
      console.error("Gagal mencatat aktivitas (Supabase). Cek RLS INSERT pada activityLog.", e); 
      // showToast("Gagal mencatat log aktivitas.", 'warning'); 
  }
}
  
  function saveSession(userData) { try { localStorage.setItem('siPandaiSession', JSON.stringify(userData)); } catch (e) { console.error("Gagal menyimpan sesi:", e); } }
  function getSession() { try { return JSON.parse(localStorage.getItem('siPandaiSession')); } catch (e) { return null; } }
  function clearSession() { localStorage.removeItem('siPandaiSession'); }

  // ------------------------------------------------------------------
  // --- START FIREBASE CONFIGURATION FUNCTIONS ---
  // ------------------------------------------------------------------

  // --- FIX: loadGlobalSettings (Supabase Safe Version) ---
async function loadGlobalSettings() {
    console.log("[GlobalSettings] Loading...");
    try {
        const { data, error } = await sb
            .from('app_config')
            .select('settings')
            .eq('id', 'globalSettings')
            .maybeSingle();

        if (error) throw error;

        if (data && data.settings) {
            STATE.globalSettings = data.settings;

            // --- HELPER KONVERSI TANGGAL ---
            // Fungsi helper agar tidak crash jika tanggal null/kosong
            const attachDateHelper = (dateString) => {
                if (!dateString) return null;
                return {
                    toDate: () => new Date(dateString)
                };
            };

            // Terapkan helper ke properti tanggal
            STATE.globalSettings.Batas_Tanggal_Pengajuan = attachDateHelper(STATE.globalSettings.Batas_Tanggal_Pengajuan);
            STATE.globalSettings.Batas_Tanggal_Pengajuan_Perubahan = attachDateHelper(STATE.globalSettings.Batas_Tanggal_Pengajuan_Perubahan);

            console.log("[GlobalSettings] Loaded & Parsed:", STATE.globalSettings);
        } else {
            console.warn("[GlobalSettings] Data not found, using defaults.");
            STATE.globalSettings = { Status_Ajuan_Awal: 'Ditutup' };
        }
    } catch (e) {
        console.error("[GlobalSettings] Error:", e);
        STATE.globalSettings = {};
    }
}

async function loadFilterOptionsRekapan() { 
    try {
        // Load Grub Belanja
        const { data: grubData, error: grubError } = await sb.from('grub_belanja').select('*').order('Nama_Grub');
        if (grubData) {
            const elGrub = document.getElementById("filterGrubBelanja");
            if (elGrub) {
                elGrub.innerHTML = '<option value="">Semua Grub Belanja</option>';
                grubData.forEach(g => {
                    elGrub.innerHTML += `<option value="${g.Nama_Grub}">${g.Nama_Grub}</option>`;
                });
            }
        }

        // Load Kelompok Belanja
        const { data: kelData, error: kelError } = await sb.from('kelompok').select('*').order('Nama_Kelompok');
        if (kelData) {
            const elKel = document.getElementById("filterKelompokBelanja");
            if (elKel) {
                elKel.innerHTML = '<option value="">Semua Kelompok Belanja</option>';
                kelData.forEach(k => {
                    elKel.innerHTML += `<option value="${k.ID_Kelompok}">${k.ID_Kelompok} - ${k.Nama_Kelompok}</option>`;
                });
            }
        }
        
        // --- BAGIAN INI DIPERBARUI ---
        // Load Prodi Filter (Untuk Direktorat DAN Pimpinan)
        const elProdi = document.getElementById("filterProdiRekapan");
        if (elProdi) {
             // Cek jika role adalah direktorat ATAU pimpinan
             if (STATE.role === 'direktorat' || STATE.role === 'pimpinan') {
                 elProdi.innerHTML = '<option value="">Semua Unit</option>';
                 
                 // Pastikan STATE.allProdi sudah terisi sebelumnya
                 const prodiList = STATE.allProdi.filter(p => p.Role === 'prodi');
                 
                 prodiList.sort((a, b) => a.ID_Prodi.localeCompare(b.ID_Prodi)).forEach(p => {
                     elProdi.innerHTML += `<option value="${p.ID_Prodi}">${p.ID_Prodi} - ${p.Nama_Prodi}</option>`;
                 });
                 
                 // Tampilkan container filter jika sebelumnya disembunyikan
                 if (elProdi.parentElement) elProdi.parentElement.style.display = 'block';
             } else {
                 // Sembunyikan filter untuk role 'prodi' (karena mereka hanya melihat data sendiri)
                 if (elProdi.parentElement) elProdi.parentElement.style.display = 'none';
             }
        }
        // -----------------------------

    } catch (e) {
        console.error("Gagal memuat filter Rekapan Realisasi:", e);
    }
}

async function loadRekapanRealisasi() {
    showLoader(true);

    try {
        // Ambil filter (Use getSafeValue for non-critical dashboard filters)
        const prodiFilter = getSafeValue("filterProdiRekapan"); 
        const grubFilter = getSafeValue("filterGrubBelanja");
        const kelompokFilter = getSafeValue("filterKelompokBelanja");
        const selectedYear = getSafeValue('filterTahunDashboard');
        const selectedTipe = getSafeValue('filterTipeDashboard'); // Get Tipe filter

        const tbody = document.getElementById("rekapRealisasiUnitBody");
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">Memuat data...</td></tr>`;
        
        // KRITIS: Tentukan tabel target berdasarkan filter tipe ajuan di dashboard
        // Jika filter tipe tidak dipilih, kita perlu memilih tabel Tahap Aktif
        const tahapAktif = STATE.globalSettings.Tahap_Perubahan_Aktif || 1;
        let targetTipe = selectedTipe;

        // Jika filter tipe kosong, gunakan tipe ajuan dari tahap aktif
        if (!targetTipe) {
             targetTipe = tahapAktif === 1 ? 'Awal' : `Perubahan ${tahapAktif}`;
        }
        
        const targetTableName = getAjuanTableName(targetTipe);

        let query = sb
            .from(targetTableName) // <-- REF ACT: Query dari tabel yang benar
            .select(`
                ID_Prodi,
                Total,
                Grub_Belanja_Utama,
                ID_Kelompok,
                ${RPD_SELECT_COLUMNS}
            `)
            .filter('Status', 'eq', 'Diterima')
            .filter('Is_Blocked', 'eq', false);

        if (STATE.role === 'prodi') {
             // Prodi hanya melihat datanya sendiri
             query = query.eq('ID_Prodi', STATE.id);
        } else if (prodiFilter) { // DIREKTORAT: filter berdasarkan Unit yang dipilih
             query = query.eq('ID_Prodi', prodiFilter);
        }
        
        if (selectedYear) {
            const start = `${selectedYear}-01-01 00:00:00`;
            const end   = `${selectedYear}-12-31 23:59:59`;
            query = query.gte('Timestamp', start).lte('Timestamp', end);
        }

        if (grubFilter) query = query.filter('Grub_Belanja_Utama', 'eq', grubFilter);
        if (kelompokFilter) query = query.filter('ID_Kelompok', 'eq', kelompokFilter);

        const { data, error } = await query;
        if (error) throw error;
        
        // --- Aggregation Logic: Group by Prodi, Grub, and Kelompok ---
        const aggregationKey = (d) => `${d.ID_Prodi}|${d.Grub_Belanja_Utama}|${d.ID_Kelompok}`;
        const aggregatedData = {};
        
        data.forEach(ajuan => {
            const key = aggregationKey(ajuan);
            if (!aggregatedData[key]) {
                aggregatedData[key] = {
                    ID_Prodi: ajuan.ID_Prodi,
                    Grub_Belanja_Utama: ajuan.Grub_Belanja_Utama,
                    ID_Kelompok: ajuan.ID_Kelompok,
                    Total_Diterima: 0,
                    Total_RPD: 0,
                    Total_Realisasi: 0,
                };
            }
            
            // Sum Total Diterima (Total Ajuan)
            aggregatedData[key].Total_Diterima += Number(ajuan.Total) || 0;

            // Sum RPD and Realisasi across all months
            RPD_MONTHS.forEach(m => {
                aggregatedData[key].Total_RPD += Number(ajuan[getMonthlyKey('RPD', m)]) || 0;
                aggregatedData[key].Total_Realisasi += Number(ajuan[getMonthlyKey('Realisasi', m)]) || 0;
            });
        });

        const result = Object.values(aggregatedData);
        renderRekapanRealisasi(result);

    } catch (e) {
        console.error("Gagal memuat rekapan realisasi:", e);
        showToast("Gagal memuat rekapan realisasi", "danger");
        document.getElementById("rekapRealisasiUnitBody").innerHTML = `<tr><td colspan="6" class="text-center text-danger">Gagal memuat data.</td></tr>`;
    } finally {
        showLoader(false);
    }
}

// ======================================================
// PINDAHKAN SELURUH AJUAN DITERIMA → AJUAN PERUBAHAN
// ======================================================


// Extracted perform function for moving accepted ajuan (used by backend and generate buttons)
async function performPindahkanAjuan() {
    // Aksi ini hanya boleh dijalankan oleh prodi atau direktorat (jika tombolnya terlihat)
    if (STATE.role !== 'prodi' && STATE.role !== 'direktorat') {
         showToast("Anda tidak memiliki izin untuk melakukan aksi ini.", "danger");
         return;
    }
    
    try {
        showLoader(true);

        const tahapAktif = STATE.globalSettings?.Tahap_Perubahan_Aktif || 1;
        const tahapSebelumnya = tahapAktif - 1;

        if (tahapAktif <= 1) {
            // Jika tahapAktif = 1, artinya kita menyalin dari 'Awal' ke 'Perubahan 1'. Ini diperbolehkan.
            // Namun, jika dijalankan di tahap 0 (belum ada tahap aktif), kita blok.
            if (tahapAktif === 0) {
                 showToast("Tahap Perubahan belum diaktifkan.", "warning");
                 showLoader(false);
                 return;
            }
        }

        const sourceType = tahapSebelumnya === 0 ? "Awal" : `Perubahan ${tahapSebelumnya}`;
        const destinationType = `Perubahan ${tahapAktif}`;

        // KRITIS: Tentukan nama tabel sumber dan tujuan berdasarkan tipe ajuan
        const sourceTableName = getAjuanTableName(sourceType);
        const destinationTableName = getAjuanTableName(destinationType);

        if (sourceTableName === destinationTableName) {
             showToast(`Tabel sumber (${sourceTableName}) sama dengan tabel tujuan. Proses dibatalkan.`, "danger");
             showLoader(false);
             return;
        }

        // 1. Ambil daftar ID_Ajuan_Asal yang sudah ada di tabel tujuan (untuk Prodi yang login)
        let existingQuery = sb.from(destinationTableName).select("ID_Ajuan_Asal");
        
        if (STATE.role === 'prodi') {
             existingQuery = existingQuery.eq('ID_Prodi', STATE.id);
        }

        const { data: existing, error: errExisting } = await existingQuery;
        if (errExisting) throw errExisting;

        const existingSet = new Set(existing.map(e => String(e.ID_Ajuan_Asal)).filter(Boolean));

        // 2. Ambil seluruh ajuan diterima pada tahap sebelumnya dari TABEL SUMBER
        let acceptedQuery = sb
            .from(sourceTableName)
            .select("*")
            .eq("Status", "Diterima")
            .eq("Is_Blocked", false);

        if (STATE.role === 'prodi') {
             acceptedQuery = acceptedQuery.eq('ID_Prodi', STATE.id); // <--- FILTER KRITIS UNTUK PRODI
        }

        const { data: diterima, error: errDiterima } = await acceptedQuery;

        if (errDiterima) throw errDiterima;

        if (!diterima.length) {
            showToast(`Tidak ada ajuan diterima dari tahap ${sourceType} yang memenuhi syarat untuk disalin.`, "info");
            showLoader(false);
            return;
        }

        // 3. Filter ajuan yang belum pernah dipindahkan dan siapkan data baru
        const toInsert = diterima
    .filter(a => !existingSet.has(String(a.ID_Ajuan))) 
    .map(a => {
        // Hapus ID lama dan buat objek baru yang bersih untuk insert
        // Kita tidak bisa menggunakan spread {...a} karena mungkin ada properti yang tidak valid
        
        const newA = {
            // Kolom utama
            "ID_Prodi": a.ID_Prodi,
            "Grub_Belanja_Utama": a.Grub_Belanja_Utama,
            "ID_Kelompok": a.ID_Kelompok,
            "Judul_Kegiatan": a.Judul_Kegiatan,
            "Nama_Ajuan": a.Nama_Ajuan,
            "Jumlah": a.Jumlah,
            "Satuan": a.Satuan,
            "Harga_Satuan": a.Harga_Satuan,
            "Total": a.Total,
            "Keterangan": a.Keterangan,
            "Status_Revisi": a.Status_Revisi,
            "Data_Dukung": a.Data_Dukung,
            
            // Kolom Sistem Baru
            "Status": 'Menunggu Review',
            "Tipe_Ajuan": destinationType,
            "Timestamp": new Date().toISOString(),
            "Komentar": a.Komentar || [], // Carry over existing comments if any
            "Is_Blocked": false,
            "Catatan_Reviewer": null,
            "ID_Ajuan_Asal": String(a.ID_Ajuan), 

            // Kolom RPD (Pastikan case sensitivity cocok dengan Supabase: rpd_jan, etc.)
            // Kita ambil langsung dari objek 'a'
            "rpd_jan": a.rpd_jan || 0, "rpd_feb": a.rpd_feb || 0, "rpd_mar": a.rpd_mar || 0, "rpd_apr": a.rpd_apr || 0, 
            "rpd_mei": a.rpd_mei || 0, "rpd_jun": a.rpd_jun || 0, "rpd_jul": a.rpd_jul || 0, "rpd_ags": a.rpd_ags || 0, 
            "rpd_sep": a.rpd_sep || 0, "rpd_okt": a.rpd_okt || 0, "rpd_nov": a.rpd_nov || 0, "rpd_des": a.rpd_des || 0,

            // Kolom Realisasi
            "realisasi_jan": a.realisasi_jan || 0, "realisasi_feb": a.realisasi_feb || 0, "realisasi_mar": a.realisasi_mar || 0, "realisasi_apr": a.realisasi_apr || 0, 
            "realisasi_mei": a.realisasi_mei || 0, "realisasi_jun": a.realisasi_jun || 0, "realisasi_jul": a.realisasi_jul || 0, "realisasi_ags": a.realisasi_ags || 0, 
            "realisasi_sep": a.realisasi_sep || 0, "realisasi_okt": a.realisasi_okt || 0, "realisasi_nov": a.realisasi_nov || 0, "realisasi_des": a.realisasi_des || 0,

            // Kolom Kalkulasi 
            "calcA1": a.calcA1 || null, "calcS1": a.calcS1 || null,
            "calcA2": a.calcA2 || null, "calcS2": a.calcS2 || null,
            "calcA3": a.calcA3 || null, "calcS3": a.calcS3 || null,
            "calcA4": a.calcA4 || null, "calcS4": a.calcS4 || null,
            "calcA5": a.calcA5 || null, "calcS5": a.calcS5 || null,
            "calcA6": a.calcA6 || null, "calcS6": a.calcS6 || null,
            
        };

        // Hapus properti yang mungkin undefined dari objek sumber
        Object.keys(newA).forEach(key => {
            if (newA[key] === undefined) {
                delete newA[key];
            }
        });
        
        return newA;
    });

        // 4. Insert batch ke Supabase (TABEL TUJUAN)
        const { error: errInsert } = await sb.from(destinationTableName).insert(toInsert); 
        if (errInsert) throw errInsert;

        const successMessage = (STATE.role === 'prodi') 
            ? `${toInsert.length} ajuan Anda berhasil disalin dari tahap ${sourceType} ke ${destinationType}. Silakan cek tab Daftar Ajuan Perubahan.`
            : `${toInsert.length} ajuan berhasil dipindahkan (Direktorat).`;

        showToast(successMessage, "success");

        logActivity(
            "Pindahkan Ajuan Diterima",
            `Menyalin ${toInsert.length} ajuan dari tabel ${sourceTableName} ke tabel ${destinationTableName}`
        );

        // 5. Reload tampilan daftar perubahan
        if (typeof refreshAjuanTablePerubahan === "function") {
            refreshAjuanTablePerubahan(true); 
        }

    } catch (e) {
        console.error("Gagal memindahkan ajuan:", e);
        // START FIX: Improved RLS error handling
        let errorMessage = "Gagal memindahkan ajuan. Pastikan tabel revisi sudah dibuat dan skemanya benar.";
        if (e.code === '42501') {
             errorMessage = "Gagal memindahkan ajuan: Pelanggaran RLS Supabase (42501). Pastikan kebijakan INSERT di Supabase mengizinkan Unit/Direktorat yang bersangkutan.";
        } else if (e.message && e.message.includes('401')) {
             errorMessage = "Gagal memindahkan ajuan: Tidak terautentikasi (401). Pastikan Anon Key Supabase Anda valid dan RLS disiapkan.";
        } else if (e.message && e.message.includes('column "id_ajuan" does not exist')) {
             errorMessage = "Gagal memindahkan ajuan: Skema tabel tujuan mungkin tidak sinkron atau ID_Ajuan belum dikonfigurasi sebagai PK auto-increment.";
        }
        showToast(errorMessage, "danger");
        // END FIX
    } finally {
        showLoader(false);
    }
}

safeAddClickListener("btn-pindahkan-ajuan-backend", async () => { await performPindahkanAjuan(); });
safeAddClickListener("btn-copy-accepted", async () => { await performPindahkanAjuan(); });


// --- OPTIMIZED MATRIX LOAD FUNCTION ---
async function loadMatrixSemulaMenjadi() {
    const loadingEl = document.getElementById("matrix-loading");
    const tbody = document.getElementById("matrixBody");
    
    if (loadingEl) loadingEl.style.display = "block";
    if (tbody) tbody.innerHTML = ""; // Bersihkan dulu agar terasa responsif

    try {
        const tahapAktif = STATE.globalSettings.Tahap_Perubahan_Aktif || 0;
        
        // Validasi Tahap
        if (tahapAktif === 0) {
            if (loadingEl) loadingEl.style.display = "none";
            if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted p-4">Tahap Perubahan belum diaktifkan (Masih Tahap Awal).</td></tr>`;
            return;
        }

        // Tentukan Tabel Sumber (Semula) dan Tujuan (Menjadi)
        const menjadiTipe = `Perubahan ${tahapAktif}`;
        const semulaTipe = tahapAktif === 1 ? "Awal" : `Perubahan ${tahapAktif - 1}`;
        
        const tableMenjadi = getAjuanTableName(menjadiTipe);
        const tableSemula = getAjuanTableName(semulaTipe);

        console.time("MatrixFetch"); // Debug kecepatan

        // 1. SIAPKAN QUERY (Hanya ambil kolom yg diperlukan untuk performa)
        const selectCols = "ID_Ajuan, ID_Prodi, Nama_Ajuan, Total, ID_Ajuan_Asal, Judul_Kegiatan";
        
        let queryMenjadi = sb.from(tableMenjadi)
            .select(selectCols)
            .eq("Status", "Diterima")
            .eq("Is_Blocked", false);

        let querySemula = sb.from(tableSemula)
            .select(selectCols)
            .eq("Status", "Diterima")
            .eq("Is_Blocked", false);

        // Filter Prodi jika bukan Direktorat
        if (STATE.role === 'prodi') {
            queryMenjadi = queryMenjadi.eq('ID_Prodi', STATE.id);
            querySemula = querySemula.eq('ID_Prodi', STATE.id);
        }

        // 2. PARALLEL FETCH (Jalan bersamaan, lebih cepat)
        const [resMenjadi, resSemula] = await Promise.all([queryMenjadi, querySemula]);

        if (resMenjadi.error) throw resMenjadi.error;
        if (resSemula.error) throw resSemula.error;

        const dataMenjadi = resMenjadi.data || [];
        const dataSemula = resSemula.data || [];

        console.timeEnd("MatrixFetch");

        // 3. PENGOLAHAN DATA (Menggunakan Map untuk kecepatan O(1))
        
        // Map data Semula berdasarkan ID_Ajuan agar mudah dicari
        // Key: ID_Ajuan, Value: Object Data
        const semulaMap = new Map();
        dataSemula.forEach(item => {
            semulaMap.set(String(item.ID_Ajuan), item);
        });

        // Array hasil
        const matrixRows = [];

        // Loop Data Menjadi (Data Aktif)
        dataMenjadi.forEach(itemBaru => {
            const idAsal = itemBaru.ID_Ajuan_Asal ? String(itemBaru.ID_Ajuan_Asal) : null;
            let itemLama = null;
            let nominalSemula = 0;

            // Coba cari pasangannya di data Semula
            if (idAsal && semulaMap.has(idAsal)) {
                itemLama = semulaMap.get(idAsal);
                nominalSemula = Number(itemLama.Total) || 0;
                // Hapus dari map untuk menandai sudah diproses (opsional, jika ingin melihat yg dihapus)
                semulaMap.delete(idAsal); 
            }

            const nominalMenjadi = Number(itemBaru.Total) || 0;
            const selisih = nominalMenjadi - nominalSemula;

            // Masukkan ke row jika ada perubahan atau barang baru, atau sekadar ingin menampilkan semua data aktif
            matrixRows.push({
                ID_Prodi: itemBaru.ID_Prodi,
                Nama_Ajuan: itemBaru.Nama_Ajuan,
                Judul_Kegiatan: itemBaru.Judul_Kegiatan, // Tambahan konteks
                Semula: nominalSemula,
                Menjadi: nominalMenjadi,
                Selisih: selisih,
                Status: nominalSemula === 0 ? 'Baru' : (selisih !== 0 ? 'Berubah' : 'Tetap')
            });
        });

        // (Opsional) Jika Anda ingin menampilkan item yang DIHAPUS (ada di Semula, tidak ada di Menjadi)
        // Uncomment blok di bawah ini jika diinginkan:
        /*
        semulaMap.forEach((itemLama) => {
             matrixRows.push({
                ID_Prodi: itemLama.ID_Prodi,
                Nama_Ajuan: itemLama.Nama_Ajuan,
                Judul_Kegiatan: itemLama.Judul_Kegiatan,
                Semula: Number(itemLama.Total) || 0,
                Menjadi: 0,
                Selisih: 0 - (Number(itemLama.Total) || 0),
                Status: 'Dihapus'
            });
        });
        */

        // 4. SORTING (Agar rapi per Unit)
        matrixRows.sort((a, b) => {
            if (a.ID_Prodi !== b.ID_Prodi) return a.ID_Prodi.localeCompare(b.ID_Prodi);
            return a.Nama_Ajuan.localeCompare(b.Nama_Ajuan);
        });

        // 5. RENDER
        renderMatrixSemulaMenjadi(matrixRows, semulaTipe, menjadiTipe);

    } catch (e) {
        console.error("Matrix error:", e);
        showToast(`Gagal memuat Matrix: ${e.message}`, "danger");
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="text-center text-danger">Terjadi kesalahan saat memuat data.</td></tr>`;
    } finally {
        if (loadingEl) loadingEl.style.display = "none";
    }
}

// --- OPTIMIZED MATRIX RENDER FUNCTION ---
function renderMatrixSemulaMenjadi(rows, semulaTipe, menjadiTipe) {
    const tbody = document.getElementById("matrixBody");
    const headerTitle = document.getElementById("matrixHeaderTitle");
    const headerSemula = document.getElementById("matrixHeaderSemula");
    const headerMenjadi = document.getElementById("matrixHeaderMenjadi");

    // Update Header Text
    if (headerTitle) headerTitle.textContent = `Perbandingan Anggaran: ${semulaTipe} vs ${menjadiTipe}`;
    if (headerSemula) headerSemula.textContent = `Total ${semulaTipe}`;
    if (headerMenjadi) headerMenjadi.textContent = `Total ${menjadiTipe}`;

    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted p-4">Tidak ada data ajuan diterima pada tahap ini.</td></tr>`;
        return;
    }

    // Cache Prodi Colors & Names untuk menghindari kalkulasi berulang di dalam loop
    const prodiMeta = {};
    STATE.allProdi.forEach(p => {
        prodiMeta[p.ID_Prodi] = {
            nama: p.Nama_Prodi,
            color: getColorForProdi(p.ID_Prodi)
        };
    });

    let htmlBuilder = ""; // String builder for performance
    let currentProdi = null;
    let no = 1;
    
    // Subtotals
    let subSemula = 0, subMenjadi = 0, subSelisih = 0;
    
    // Grand Totals
    let grandSemula = 0, grandMenjadi = 0, grandSelisih = 0;

    const fmt = (num) => num.toLocaleString('id-ID'); // Helper format

    // Fungsi helper untuk merender baris subtotal
    const renderSubtotal = (prodi) => {
        const cls = subSelisih > 0 ? "text-success" : (subSelisih < 0 ? "text-danger" : "");
        return `
            <tr class="table-secondary fw-bold" style="font-size: 0.9em;">
                <td colspan="3" class="text-end">Subtotal ${prodi}</td>
                <td class="text-end">Rp ${fmt(subSemula)}</td>
                <td class="text-end">Rp ${fmt(subMenjadi)}</td>
                <td class="text-end ${cls}">Rp ${fmt(subSelisih)}</td>
            </tr>
        `;
    };

    rows.forEach((r, index) => {
        // Cek pergantian Grup Prodi
        if (currentProdi !== r.ID_Prodi) {
            // Jika bukan baris pertama, tutup grup sebelumnya dengan subtotal
            if (currentProdi !== null) {
                htmlBuilder += renderSubtotal(currentProdi);
            }

            // Reset subtotal & update current
            currentProdi = r.ID_Prodi;
            subSemula = 0; subMenjadi = 0; subSelisih = 0;
            no = 1;

            const meta = prodiMeta[currentProdi] || { nama: currentProdi, color: '#ccc' };
            htmlBuilder += `
                <tr class="table-light border-start border-5" style="border-left-color: ${meta.color} !important;">
                    <td colspan="6" class="py-2">
                        <strong>${currentProdi}</strong> - <span class="text-muted">${escapeHtml(meta.nama)}</span>
                    </td>
                </tr>
            `;
        }

        // Kalkulasi
        subSemula += r.Semula; subMenjadi += r.Menjadi; subSelisih += r.Selisih;
        grandSemula += r.Semula; grandMenjadi += r.Menjadi; grandSelisih += r.Selisih;

        const selisihClass = r.Selisih > 0 ? "text-success" : (r.Selisih < 0 ? "text-danger" : "text-muted");
        const selisihIcon = r.Selisih > 0 ? "<i class='bi bi-caret-up-fill small'></i>" : (r.Selisih < 0 ? "<i class='bi bi-caret-down-fill small'></i>" : "");
        const styleChange = r.Semula !== r.Menjadi ? "background-color: #fffyea;" : ""; // Highlight baris yg berubah tipis

        htmlBuilder += `
            <tr style="${styleChange}">
                <td class="text-center">${no++}</td>
                <td>${r.ID_Prodi}</td>
                <td>
                    <div class="fw-bold text-dark">${escapeHtml(r.Nama_Ajuan)}</div>
                    <div class="small text-muted">${escapeHtml(r.Judul_Kegiatan)}</div>
                </td>
                <td class="text-end text-secondary">${r.Semula === 0 ? '-' : fmt(r.Semula)}</td>
                <td class="text-end fw-bold">${fmt(r.Menjadi)}</td>
                <td class="text-end fw-bold ${selisihClass}">
                    ${selisihIcon} ${fmt(r.Selisih)}
                </td>
            </tr>
        `;
    });

    // Render subtotal untuk grup terakhir
    if (currentProdi !== null) {
        htmlBuilder += renderSubtotal(currentProdi);
    }

    // Render Grand Total
    const grandCls = grandSelisih > 0 ? "text-success" : (grandSelisih < 0 ? "text-danger" : "");
    htmlBuilder += `
        <tr class="table-dark fw-bold border-top border-3 border-white">
            <td colspan="3" class="text-end text-uppercase">Total Keseluruhan</td>
            <td class="text-end">Rp ${fmt(grandSemula)}</td>
            <td class="text-end">Rp ${fmt(grandMenjadi)}</td>
            <td class="text-end ${grandCls}">Rp ${fmt(grandSelisih)}</td>
        </tr>
    `;

    // Inject ke DOM sekaligus (Fast Render)
    tbody.innerHTML = htmlBuilder;
}


function renderRekapanRealisasi(data) {
    const tbody = document.getElementById("rekapRealisasiUnitBody");
    if (!tbody) return;

    if (!data.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">Tidak ada data realisasi yang ditemukan untuk filter ini.</td></tr>`;
        return;
    }

    // Sort by Unit, then Grub, then Kelompok
    data.sort((a, b) => {
        if (a.ID_Prodi !== b.ID_Prodi) return a.ID_Prodi.localeCompare(b.ID_Prodi);
        if (a.Grub_Belanja_Utama !== b.Grub_Belanja_Utama) return a.Grub_Belanja_Utama.localeCompare(b.Grub_Belanja_Utama);
        return a.ID_Kelompok.localeCompare(b.ID_Kelompok);
    });

    // Helper to get Prodi Name
    const prodiNameMap = STATE.allProdi.reduce((acc, p) => {
        acc[p.ID_Prodi] = p.Nama_Prodi;
        return acc;
    }, {});
    
    // Helper to get Kelompok Name
    const kelompokNameMap = STATE.allKelompok.reduce((acc, k) => {
        acc[k.ID_Kelompok] = k.Nama_Kelompok;
        return acc;
    }, {});

    let html = '';
    
    // Grouping for Rowspan Calculation
    const groupedByProdi = data.reduce((acc, item) => {
        if (!acc[item.ID_Prodi]) acc[item.ID_Prodi] = [];
        acc[item.ID_Prodi].push(item);
        return acc;
    }, {});
    
    // Grand Totals
    let grandTotalRealisasi = 0;
    let grandTotalRPD = 0;

    const prodiKeys = Object.keys(groupedByProdi).sort();
    
    prodiKeys.forEach(prodiId => {
        const prodiGroup = groupedByProdi[prodiId];
        const rowSpan = prodiGroup.length;
        const prodiName = prodiNameMap[prodiId] || prodiId;
        
        let subTotalRealisasi = 0;
        let subTotalRPD = 0;

        prodiGroup.forEach((item, index) => {
            const totalRealisasi = item.Total_Realisasi;
            const totalRPD = item.Total_RPD;
            const percentage = totalRPD > 0 ? (totalRealisasi / totalRPD) * 100 : 0;
            const percentageText = percentage.toFixed(1) + '%';
            const percentageClass = percentage >= 100 ? 'bg-success' : 'bg-warning';
            
            subTotalRealisasi += totalRealisasi;
            subTotalRPD += totalRPD;
            
            grandTotalRealisasi += totalRealisasi;
            grandTotalRPD += totalRPD;

            html += `
                <tr>
                    ${index === 0 ? `<td rowspan="${rowSpan}" class="align-middle fw-bold" style="border-left: 5px solid ${getColorForProdi(prodiId)};">${escapeHtml(prodiName)}</td>` : ''}
                    <td>${escapeHtml(item.Grub_Belanja_Utama)}</td>
                    <td>${item.ID_Kelompok} - ${escapeHtml(kelompokNameMap[item.ID_Kelompok] || item.ID_Kelompok)}</td>
                    <td class="text-end">Rp ${totalRealisasi.toLocaleString('id-ID')}</td>
                    <td class="text-end">Rp ${totalRPD.toLocaleString('id-ID')}</td>
                    <td class="text-center"><span class="badge ${percentageClass}">${percentageText}</span></td>
                </tr>
            `;
        });
        
        // Add Subtotal row for each Prodi
        const subTotalPercentage = subTotalRPD > 0 ? (subTotalRealisasi / subTotalRPD) * 100 : 0;
        const subTotalPercentageText = subTotalPercentage.toFixed(1) + '%';
        const subTotalPercentageClass = subTotalPercentage >= 100 ? 'bg-success' : 'bg-warning';
        
        html += `
            <tr class="table-info">
                <td colspan="3" class="text-end fw-bold">Subtotal Realisasi Unit ${escapeHtml(prodiName)}</td>
                <td class="text-end fw-bold">Rp ${subTotalRealisasi.toLocaleString('id-ID')}</td>
                <td class="text-end fw-bold">Rp ${subTotalRPD.toLocaleString('id-ID')}</td>
                <td class="text-center fw-bold"><span class="badge ${subTotalPercentageClass}">${subTotalPercentageText}</span></td>
            </tr>
        `;
    });
    
    // Add Grand Total row
    const grandTotalPercentage = grandTotalRPD > 0 ? (grandTotalRealisasi / grandTotalRPD) * 100 : 0;
    const grandTotalPercentageText = grandTotalPercentage.toFixed(1) + '%';
    
    html += `
        <tr class="table-dark">
            <td colspan="3" class="text-end fw-bold">GRAND TOTAL</td>
            <td class="text-end fw-bold">Rp ${grandTotalRealisasi.toLocaleString('id-ID')}</td>
            <td class="text-end fw-bold">Rp ${grandTotalRPD.toLocaleString('id-ID')}</td>
            <td class="text-center fw-bold"><span class="badge bg-light text-dark">${grandTotalPercentageText}</span></td>
        </tr>
    `;

    tbody.innerHTML = html;
}

function getProdiName(id) {
    const p = STATE.allProdi.find(x => x.ID_Prodi === id);
    return p ? p.Nama_Prodi : id;
}


// --- MIGRATED TO SUPABASE: Load BA Settings ---
async function loadBeritaAcaraSettings() {
    try {
        const { data, error } = await sb
            .from('app_config')
            .select('settings')
            .eq('id', 'beritaAcaraSettings')
            .maybeSingle();

        if (data && data.settings) {
            STATE.beritaAcaraSettings = data.settings;
        } else {
            // Default jika kosong
            STATE.beritaAcaraSettings = {
                TTD_Kanan_Jabatan: 'Wakil Direktur II',
                TTD_Kanan_Nama: '(..................................................)',
                TTD_Kiri_Jabatan: 'Ketua Jurusan/Program Studi',
                TTD_Kiri_Nama: '(..................................................)'
            };
        }
    } catch (e) {
        console.error("Gagal memuat Berita Acara Settings (Supabase):", e);
    }
}
/**
 * Merender Petunjuk Penggunaan berdasarkan Role (Prodi / Direktorat / Pimpinan)
 */
function renderUserGuide() {
    const container = document.getElementById('petunjuk-content-area');
    if (!container) return;

    const role = STATE.role;
    let htmlContent = '';

    /* ============================================================
       1.  P A N D U A N    R O L E :   P R O D I
       ============================================================ */
    if (role === 'prodi') {

        htmlContent = `
        <div class="premium-guide">

    <!-- HEADER -->
    <div class="alert alert-info shadow-sm border rounded d-flex align-items-center p-3 mb-4">
        <div class="me-3">
            <i class="bi bi-mortarboard-fill fs-1 text-primary"></i>
        </div>
        <div>
            <h5 class="fw-bold mb-1">Panduan Pengguna – Unit / Prodi</h5>
            <div class="small">Alur lengkap penyusunan anggaran: Ajuan → Review → RPD → Realisasi → Laporan</div>
        </div>
    </div>

    <!-- VISUAL POINTER / ILLUSTRATION -->
    <div class="row g-3 mb-4">
        <div class="col-md-4">
            <div class="card h-100 shadow-sm border-0 rounded-3 guide-card">
                <div class="card-body text-center">
                    <i class="bi bi-pencil-square fs-1 text-primary mb-2"></i>
                    <h6 class="fw-bold">Buat Ajuan</h6>
                    <p class="small text-muted">Isi detail kebutuhan kegiatan dan operasional.</p>
                </div>
            </div>
        </div>
        <div class="col-md-4">
            <div class="card h-100 shadow-sm border-0 rounded-3 guide-card">
                <div class="card-body text-center">
                    <i class="bi bi-calendar-check fs-1 text-success mb-2"></i>
                    <h6 class="fw-bold">Isi RPD Bulanan</h6>
                    <p class="small text-muted">Susun rencana penarikan dana sesuai kebutuhan waktu.</p>
                </div>
            </div>
        </div>
        <div class="col-md-4">
            <div class="card h-100 shadow-sm border-0 rounded-3 guide-card">
                <div class="card-body text-center">
                    <i class="bi bi-graph-up-arrow fs-1 text-warning mb-2"></i>
                    <h6 class="fw-bold">Input Realisasi</h6>
                    <p class="small text-muted">Laporkan progres penggunaan dana secara berkala.</p>
                </div>
            </div>
        </div>
    </div>

    <!-- ACCORDION -->
    <div class="accordion" id="accordionProdiPremium">

        <!-- 1. Ajuan -->
        <div class="accordion-item shadow-sm border-0 rounded mb-3">
            <h2 class="accordion-header">
                <button class="accordion-button fw-bold" data-bs-toggle="collapse" data-bs-target="#pp1">
                    <i class="bi bi-file-earmark-plus me-2 text-primary"></i> 1. Membuat Ajuan Anggaran
                </button>
            </h2>
            <div id="pp1" class="accordion-collapse collapse show">
                <div class="accordion-body">
                    <p class="fw-semibold">Langkah lengkap:</p>
                    <ol class="pointer-list">
                        <li><i class="bi bi-caret-right-fill text-primary"></i> Buka menu <strong>Formulir Ajuan</strong>.</li>
                        <li><i class="bi bi-caret-right-fill text-primary"></i> Lengkapi grub belanja, kelompok, judul kegiatan, rincian, dan harga.</li>
                        <li><i class="bi bi-caret-right-fill text-primary"></i> Klik <strong>Tambahkan ke Daftar Sementara</strong>.</li>
                        <li><i class="bi bi-caret-right-fill text-primary"></i> Kirim semua ajuan menggunakan tombol <strong>Kirim Semua Ajuan</strong>.</li>
                        <li><i class="bi bi-upload text-primary"></i> Gunakan <strong>Import Excel</strong> untuk banyak item sekaligus.</li>
                    </ol>

                    <div class="alert alert-warning mt-3">
                        <i class="bi bi-exclamation-triangle"></i>
                        Pastikan total ajuan tidak melebihi <strong>Pagu Unit</strong>.
                    </div>
                </div>
            </div>
        </div>

        <!-- 2. Status -->
        <div class="accordion-item shadow-sm border-0 rounded mb-3">
            <h2 class="accordion-header">
                <button class="accordion-button collapsed fw-bold" data-bs-toggle="collapse" data-bs-target="#pp2">
                    <i class="bi bi-clipboard-check me-2 text-success"></i> 2. Memantau Status Ajuan
                </button>
            </h2>
            <div id="pp2" class="accordion-collapse collapse">
                <div class="accordion-body">
                    <div class="status-guide">
                        <p class="fw-semibold mb-2">Arti status:</p>
                        <ul>
                            <li><span class="badge bg-secondary">Menunggu Review</span> → Sedang diperiksa.</li>
                            <li><span class="badge bg-warning text-dark">Revisi</span> → Perbaiki sesuai catatan reviewer.</li>
                            <li><span class="badge bg-success">Diterima</span> → Disetujui.</li>
                            <li><span class="badge bg-danger">Ditolak</span> → Tidak lolos penilaian.</li>
                        </ul>

                        <div class="alert alert-info mt-3">
                            <i class="bi bi-chat-dots"></i> Gunakan fitur <strong>Komentar</strong> untuk diskusi dengan Direktorat.
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 3. RPD -->
        <div class="accordion-item shadow-sm border-0 rounded mb-3">
            <h2 class="accordion-header">
                <button class="accordion-button collapsed fw-bold" data-bs-toggle="collapse" data-bs-target="#pp3">
                    <i class="bi bi-calendar-event me-2 text-warning"></i> 3. Mengisi Rencana Penarikan Dana (RPD)
                </button>
            </h2>
            <div id="pp3" class="accordion-collapse collapse">
                <div class="accordion-body">
                    <ol>
                        <li>Buka halaman <strong>RPD</strong>.</li>
                        <li>Isi nilai Januari–Desember.</li>
                        <li><span class="text-success fw-bold">Sisa = 0 wajib</span> sebelum simpan.</li>
                        <li>Simpan per baris menggunakan tombol <strong>Simpan</strong>.</li>
                    </ol>

                    <div class="alert alert-secondary mt-3">
                        <i class="bi bi-lightbulb"></i> Tips:
                        RPD yang rapi memudahkan penjadwalan pencairan dana.
                    </div>
                </div>
            </div>
        </div>

        <!-- 4. Realisasi -->
        <div class="accordion-item shadow-sm border-0 rounded mb-3">
            <h2 class="accordion-header">
                <button class="accordion-button collapsed fw-bold" data-bs-toggle="collapse" data-bs-target="#pp4">
                    <i class="bi bi-graph-down-arrow me-2 text-danger"></i> 4. Melaporkan Realisasi Anggaran
                </button>
            </h2>
            <div id="pp4" class="accordion-collapse collapse">
                <div class="accordion-body">
                    <ol>
                        <li>Buka halaman <strong>Realisasi</strong>.</li>
                        <li>Masukkan nilai realisasi ketika dana digunakan.</li>
                        <li>Klik <strong>Simpan</strong>.</li>
                    </ol>

                    <div class="alert alert-success mt-3">
                        <i class="bi bi-bar-chart"></i>
                        Dashboard akan menampilkan progres serapan secara otomatis.
                    </div>
                </div>
            </div>
        </div>

        <!-- 5. Laporan -->
        <div class="accordion-item shadow-sm border-0 rounded mb-3">
            <h2 class="accordion-header">
                <button class="accordion-button collapsed fw-bold" data-bs-toggle="collapse" data-bs-target="#pp5">
                    <i class="bi bi-printer me-2 text-dark"></i> 5. Export Laporan & Berita Acara
                </button>
            </h2>
            <div id="pp5" class="accordion-collapse collapse">
                <div class="accordion-body">
                    <ul>
                        <li>Gunakan tombol <strong>Print / PDF / Excel</strong> untuk tiap tabel.</li>
                        <li>Berita Acara tersedia pada tab khusus.</li>
                        <li>Pastikan data <strong>TTD</strong> sudah diisi di Pengaturan Akun.</li>
                    </ul>
                </div>
            </div>
        </div>

    </div>

</div>

        `;

    /* ============================================================
       2.  P A N D U A N    R O L E :   P I M P I N A N
       ============================================================ */
    } else if (role === 'pimpinan') {

        htmlContent = `
        <div class="premium-guide">

    <!-- HEADER -->
    <div class="alert alert-warning shadow-sm border rounded d-flex align-items-center p-3 mb-4">
        <div class="me-3">
            <i class="bi bi-award-fill fs-1 text-warning"></i>
        </div>
        <div>
            <h5 class="fw-bold mb-1">Panduan Pengguna – Mode Pimpinan</h5>
            <div class="small">Akses eksekutif untuk memantau kinerja anggaran seluruh Unit/Prodi secara real-time.</div>
        </div>
    </div>

    <!-- ILLUSTRATION / VISUAL CARDS -->
    <div class="row g-3 mb-4">
        <div class="col-md-4">
            <div class="card h-100 shadow-sm border-0 rounded-3">
                <div class="card-body text-center">
                    <i class="bi bi-speedometer2 fs-1 text-primary mb-2"></i>
                    <h6 class="fw-bold">Dashboard Eksekutif</h6>
                    <p class="small text-muted">Melihat performa anggaran instansi secara menyeluruh.</p>
                </div>
            </div>
        </div>

        <div class="col-md-4">
            <div class="card h-100 shadow-sm border-0 rounded-3">
                <div class="card-body text-center">
                    <i class="bi bi-funnel fs-1 text-success mb-2"></i>
                    <h6 class="fw-bold">Filter Dinamis</h6>
                    <p class="small text-muted">Analisis mendalam berdasarkan Unit, Tahun, dan Tipe Ajuan.</p>
                </div>
            </div>
        </div>

        <div class="col-md-4">
            <div class="card h-100 shadow-sm border-0 rounded-3">
                <div class="card-body text-center">
                    <i class="bi bi-layout-split fs-1 text-danger mb-2"></i>
                    <h6 class="fw-bold">Matrix Semula-Menjadi</h6>
                    <p class="small text-muted">Menganalisa perubahan anggaran sebelum & sesudah revisi.</p>
                </div>
            </div>
        </div>
    </div>

    <!-- ACCORDION -->
    <div class="accordion" id="accordionPimpinanPremium">

        <!-- 1. Dashboard Eksekutif -->
        <div class="accordion-item shadow-sm border-0 rounded mb-3">
            <h2 class="accordion-header" id="pm1">
                <button class="accordion-button fw-bold" data-bs-toggle="collapse" data-bs-target="#pmp1">
                    <i class="bi bi-speedometer2 me-2 text-primary"></i> 1. Dashboard Eksekutif
                </button>
            </h2>

            <div id="pmp1" class="accordion-collapse collapse show">
                <div class="accordion-body">

                    <p class="fw-semibold mb-3">Dashboard menampilkan indikator utama:</p>

                    <ul class="pointer-list">
                        <li><i class="bi bi-boxes text-primary"></i> <strong>Kartu Ringkasan</strong>: Total Pagu, Total RPD, Total Realisasi.</li>
                        <li><i class="bi bi-bar-chart-line-fill text-success"></i> <strong>Grafik Realisasi vs RPD</strong> untuk memantau efektivitas serapan.</li>
                        <li><i class="bi bi-people text-warning"></i> <strong>Tabel Kinerja Prodi</strong>: perbandingan antar unit.</li>
                    </ul>

                    <div class="alert alert-info mt-3">
                        <i class="bi bi-lightbulb"></i>
                        Tips: Gunakan dashboard sebagai overview untuk mendeteksi unit dengan serapan rendah atau penyerapan terlalu cepat.
                    </div>

                </div>
            </div>
        </div>

        <!-- 2. Filter Dashboard -->
        <div class="accordion-item shadow-sm border-0 rounded mb-3">
            <h2 class="accordion-header" id="pm2">
                <button class="accordion-button collapsed fw-bold" data-bs-toggle="collapse" data-bs-target="#pmp2">
                    <i class="bi bi-funnel me-2 text-success"></i> 2. Menggunakan Filter Dashboard
                </button>
            </h2>

            <div id="pmp2" class="accordion-collapse collapse">
                <div class="accordion-body">

                    <p class="fw-semibold mb-3">Anda dapat menyaring tampilan data berdasarkan:</p>

                    <div class="row g-2 mb-3">
                        <div class="col-md-4">
                            <div class="alert alert-primary p-2 small">
                                <i class="bi bi-building"></i> <strong>Unit/Prodi</strong><br>
                                Melihat detail anggaran unit tertentu saja.
                            </div>
                        </div>

                        <div class="col-md-4">
                            <div class="alert alert-warning p-2 small">
                                <i class="bi bi-calendar-event"></i> <strong>Tahun Anggaran</strong><br>
                                Meninjau data per tahun (historis & terkini).
                            </div>
                        </div>

                        <div class="col-md-4">
                            <div class="alert alert-success p-2 small">
                                <i class="bi bi-diagram-3"></i> <strong>Tipe Ajuan</strong><br>
                                Anggaran Awal atau Perubahan.
                            </div>
                        </div>
                    </div>

                    <p class="text-muted small">
                        Filter akan memengaruhi tampilan Dashboard, RPD, Realisasi, dan Rekapan.
                    </p>

                </div>
            </div>
        </div>

        <!-- 3. Melihat Detail -->
        <div class="accordion-item shadow-sm border-0 rounded mb-3">
            <h2 class="accordion-header" id="pm3">
                <button class="accordion-button collapsed fw-bold" data-bs-toggle="collapse" data-bs-target="#pmp3">
                    <i class="bi bi-table me-2 text-dark"></i> 3. Melihat Detail Anggaran Unit
                </button>
            </h2>

            <div id="pmp3" class="accordion-collapse collapse">
                <div class="accordion-body">

                    <p class="fw-semibold">Detail per Unit/Prodi dapat diakses melalui:</p>

                    <ul>
                        <li><i class="bi bi-calendar2-event text-primary"></i> Menu <strong>RPD</strong></li>
                        <li><i class="bi bi-graph-up-arrow text-success"></i> Menu <strong>Realisasi</strong></li>
                    </ul>

                    <div class="alert alert-secondary mt-3">
                        <i class="bi bi-printer"></i>
                        Semua data dapat diekspor ke <strong>Excel</strong>, <strong>PDF</strong>, atau <strong>dicetak</strong>.
                    </div>

                </div>
            </div>
        </div>

        <!-- 4. Matrix Semula-Menjadi -->
        <div class="accordion-item shadow-sm border-0 rounded mb-3">
            <h2 class="accordion-header" id="pm4">
                <button class="accordion-button collapsed fw-bold" data-bs-toggle="collapse" data-bs-target="#pmp4">
                    <i class="bi bi-layout-split me-2 text-danger"></i> 4. Matrix Semula → Menjadi
                </button>
            </h2>

            <div id="pmp4" class="accordion-collapse collapse">
                <div class="accordion-body">

                    <p>Matrix ini memuat:</p>
                    <ul>
                        <li><i class="bi bi-arrow-left-right text-danger"></i> Perbandingan <strong>Total Semula vs Menjadi</strong></li>
                        <li><i class="bi bi-zoom-in text-primary"></i> Selisih anggaran setelah revisi</li>
                        <li><i class="bi bi-basket text-info"></i> Penambahan item baru atau pengurangan item</li>
                    </ul>

                    <div class="alert alert-light border mt-3">
                        <i class="bi bi-info-circle"></i>
                        Cocok untuk rapat evaluasi anggaran dan pengambilan keputusan.
                    </div>

                </div>
            </div>
        </div>

        <!-- 5. Riwayat -->
        <div class="accordion-item shadow-sm border-0 rounded mb-3">
            <h2 class="accordion-header" id="pm5">
                <button class="accordion-button collapsed fw-bold" data-bs-toggle="collapse" data-bs-target="#pmp5">
                    <i class="bi bi-clock-history me-2 text-info"></i> 5. Komentar & Riwayat Perubahan
                </button>
            </h2>

            <div id="pmp5" class="accordion-collapse collapse">
                <div class="accordion-body">

                    <p>Pimpinan memiliki akses <strong>Read Only</strong> ke histori:</p>

                    <ul>
                        <li><i class="bi bi-clock text-info"></i> Riwayat perubahan data</li>
                        <li><i class="bi bi-chat-dots text-primary"></i> Diskusi revisi antara Unit & Direktorat</li>
                        <li><i class="bi bi-file-text text-secondary"></i> Catatan revisi item per item</li>
                    </ul>

                    <div class="alert alert-info mt-3">
                        <i class="bi bi-eye-fill"></i>  
                        Fitur ini membantu transparansi dan audit internal.
                    </div>

                </div>
            </div>
        </div>

    </div>

</div>

        `;

    /* ============================================================
       3.  P A N D U A N    R O L E :   D I R E K T O R A T
       ============================================================ */
    } else {

        htmlContent = `
        <div class="premium-guide">

    <!-- HEADER -->
    <div class="alert alert-primary shadow-sm border rounded d-flex align-items-center p-3 mb-4">
        <div class="me-3">
            <i class="bi bi-shield-lock-fill fs-1 text-primary"></i>
        </div>
        <div>
            <h5 class="fw-bold mb-1">Panduan Pengguna – Mode Direktorat / Administrator</h5>
            <div class="small">Anda memiliki akses penuh untuk mengelola user, review anggaran, pengaturan sistem, dan monitoring global.</div>
        </div>
    </div>

    <!-- VISUAL CARDS -->
    <div class="row g-3 mb-4">
        
        <div class="col-md-4">
            <div class="card shadow-sm h-100 border-0 rounded-3">
                <div class="card-body text-center">
                    <i class="bi bi-check2-square fs-1 text-success mb-2"></i>
                    <h6 class="fw-bold">Review Ajuan</h6>
                    <p class="small text-muted">Evaluasi ajuan dari seluruh unit secara cepat dan sistematis.</p>
                </div>
            </div>
        </div>

        <div class="col-md-4">
            <div class="card shadow-sm h-100 border-0 rounded-3">
                <div class="card-body text-center">
                    <i class="bi bi-gear-fill fs-1 text-warning mb-2"></i>
                    <h6 class="fw-bold">Pengaturan Sistem</h6>
                    <p class="small text-muted">Atur tahapan, deadline, master data, dan pagu anggaran.</p>
                </div>
            </div>
        </div>

        <div class="col-md-4">
            <div class="card shadow-sm h-100 border-0 rounded-3">
                <div class="card-body text-center">
                    <i class="bi bi-bar-chart-line-fill fs-1 text-primary mb-2"></i>
                    <h6 class="fw-bold">Monitoring & Log</h6>
                    <p class="small text-muted">Pantau serapan anggaran & aktivitas user secara real-time.</p>
                </div>
            </div>
        </div>

    </div>

    <!-- ACCORDION -->
    <div class="accordion" id="accordionDirektoratPremium">

        <!-- 1. Review Ajuan -->
        <div class="accordion-item shadow-sm border-0 rounded mb-3">
            <h2 class="accordion-header">
                <button class="accordion-button fw-bold" data-bs-toggle="collapse" data-bs-target="#dir1">
                    <i class="bi bi-check-circle-fill me-2 text-success"></i> 1. Melakukan Review Ajuan Anggaran
                </button>
            </h2>

            <div id="dir1" class="accordion-collapse collapse show">
                <div class="accordion-body">

                    <p class="fw-semibold">Direktorat dapat melakukan review ajuan dengan dua metode:</p>

                    <ul class="pointer-list">
                        <li><i class="bi bi-caret-right-fill text-success"></i> <strong>Review Satuan</strong> per item.</li>
                        <li><i class="bi bi-caret-right-fill text-success"></i> <strong>Review Massal</strong> menggunakan checkbox.</li>
                    </ul>

                    <p class="fw-bold mt-3 mb-2">Tindakan yang tersedia:</p>
                    <ul>
                        <li><i class="bi bi-check2-square text-success"></i> <strong>Terima</strong> – Menyetujui ajuan.</li>
                        <li><i class="bi bi-arrow-counterclockwise text-warning"></i> <strong>Minta Revisi</strong> – Meminta perbaikan (dengan catatan).</li>
                        <li><i class="bi bi-x-square text-danger"></i> <strong>Tolak</strong> – Tidak menyetujui ajuan.</li>
                        <li><i class="bi bi-lock-fill text-secondary"></i> <strong>Blokir</strong> – Menahan ajuan agar tidak ikut dalam RPD.</li>
                    </ul>

                    <div class="alert alert-info mt-3">
                        <i class="bi bi-info-circle"></i>
                        Gunakan fitur komentar untuk memberikan instruksi rinci ke Unit/Prodi.
                    </div>

                </div>
            </div>
        </div>

        <!-- 2. Pengaturan Sistem -->
        <div class="accordion-item shadow-sm border-0 rounded mb-3">
            <h2 class="accordion-header">
                <button class="accordion-button collapsed fw-bold" data-bs-toggle="collapse" data-bs-target="#dir2">
                    <i class="bi bi-gear-fill me-2 text-warning"></i> 2. Pengaturan Sistem & Manajemen
                </button>
            </h2>

            <div id="dir2" class="accordion-collapse collapse">
                <div class="accordion-body">

                    <p class="fw-semibold mb-3">Menu Manajemen memberikan kontrol penuh atas:</p>

                    <!-- Icons Boxes -->
                    <div class="row g-3">

                        <div class="col-md-4">
                            <div class="alert alert-primary p-2 small">
                                <i class="bi bi-people-fill"></i> <strong>Manajemen User</strong><br>
                                Tambah unit, reset password, dan atur role.
                            </div>
                        </div>

                        <div class="col-md-4">
                            <div class="alert alert-success p-2 small">
                                <i class="bi bi-wallet2"></i> <strong>Pagu Anggaran</strong><br>
                                Menetapkan batas anggaran setiap unit.
                            </div>
                        </div>

                        <div class="col-md-4">
                            <div class="alert alert-info p-2 small">
                                <i class="bi bi-hdd-stack-fill"></i> <strong>Data Master</strong><br>
                                Kelola Grub Belanja & Kelompok Belanja.
                            </div>
                        </div>

                        <div class="col-md-4">
                            <div class="alert alert-warning p-2 small">
                                <i class="bi bi-calendar-event-fill"></i> <strong>Tahapan Ajuan</strong><br>
                                Membuka/menutup Ajuan Awal & Perubahan.
                            </div>
                        </div>

                        <div class="col-md-4">
                            <div class="alert alert-danger p-2 small">
                                <i class="bi bi-hourglass-split"></i> <strong>Deadline Pengajuan</strong><br>
                                Menentukan batas waktu pengajuan seluruh unit.
                            </div>
                        </div>

                        <div class="col-md-4">
                            <div class="alert alert-secondary p-2 small">
                                <i class="bi bi-megaphone-fill"></i> <strong>Pengumuman Global</strong><br>
                                Mengirimkan notifikasi pengumuman ke semua user.
                            </div>
                        </div>

                    </div>

                </div>
            </div>
        </div>

        <!-- 3. Monitoring & Log -->
        <div class="accordion-item shadow-sm border-0 rounded mb-3">
            <h2 class="accordion-header">
                <button class="accordion-button collapsed fw-bold" data-bs-toggle="collapse" data-bs-target="#dir3">
                    <i class="bi bi-bar-chart-line-fill me-2 text-primary"></i> 3. Monitoring Dashboard & Log Aktivitas
                </button>
            </h2>

            <div id="dir3" class="accordion-collapse collapse">
                <div class="accordion-body">

                    <p class="fw-semibold">Direktorat dapat melakukan monitoring pada:</p>

                    <ul>
                        <li><i class="bi bi-speedometer2 text-primary"></i> <strong>Dashboard Utama</strong> – Melihat total Pagu, RPD, Realisasi.</li>
                        <li><i class="bi bi-people text-success"></i> <strong>Tabel Rekap Unit</strong> – Performa lengkap tiap Prodi/Unit.</li>
                        <li><i class="bi bi-calendar-range text-warning"></i> <strong>Filter Tahun</strong> – Analisis per periode tertentu.</li>
                        <li><i class="bi bi-diagram-3 text-danger"></i> <strong>Filter Tipe Ajuan</strong> – Anggaran Awal / Perubahan.</li>
                    </ul>

                    <div class="alert alert-secondary mt-3">
                        <i class="bi bi-clock-history"></i> <strong>Log Aktivitas</strong><br>
                        Melacak: login user, pengeditan data, penghapusan item, perubahan status ajuan, dan lain-lain.
                    </div>

                </div>
            </div>
        </div>

        <!-- 4. Komunikasi -->
        <div class="accordion-item shadow-sm border-0 rounded mb-3">
            <h2 class="accordion-header">
                <button class="accordion-button collapsed fw-bold" data-bs-toggle="collapse" data-bs-target="#dir4">
                    <i class="bi bi-chat-text-fill me-2 text-info"></i> 4. Komunikasi & Catatan Revisi
                </button>
            </h2>

            <div id="dir4" class="accordion-collapse collapse">
                <div class="accordion-body">

                    <p class="fw-semibold">Direktorat dapat berkomunikasi dengan Unit melalui fitur:</p>

                    <ul>
                        <li><i class="bi bi-chat-dots text-primary"></i> <strong>Komentar</strong> – Beri arahan atau koreksi.</li>
                        <li><i class="bi bi-clipboard-check text-warning"></i> <strong>Catatan Revisi</strong> – Tersimpan otomatis dalam sistem.</li>
                        <li><i class="bi bi-bell-fill text-danger"></i> <strong>Notifikasi</strong> – Sistem mengirimkan pemberitahuan ke Unit.</li>
                    </ul>

                    <div class="alert alert-info mt-3">
                        <i class="bi bi-shield-fill-check"></i>  
                        Semua komentar terekam dalam sistem untuk keperluan audit dan transparansi.
                    </div>

                </div>
            </div>
        </div>

    </div>

</div>

        `;
    }

    container.innerHTML = htmlContent;
}

  /**
   * Renders the announcement bar on the dashboard based on global settings.
   */
  async function displayGlobalAnnouncement() {
    const announcementArea = document.getElementById('global-announcement-area');
    const announcementTextEl = document.getElementById('global-announcement-text');
    
    if (!announcementArea || !announcementTextEl) return;
    
    // Cek apakah settings sudah termuat
    if (STATE.globalSettings && STATE.globalSettings.Pengumuman_Aktif && STATE.globalSettings.Pengumuman_Teks) {
        announcementTextEl.innerHTML = escapeHtml(STATE.globalSettings.Pengumuman_Teks);
        announcementArea.style.display = 'block';
    } else {
        announcementArea.style.display = 'none';
    }
}
/**
 * Merender Petunjuk Penggunaan berdasarkan Role (Prodi/Direktorat)
 */
function renderUserGuide() {
    const container = document.getElementById('petunjuk-content-area');
    if (!container) return;

    const role = STATE.role; // 'prodi' atau 'direktorat'
    let htmlContent = '';

    if (role === 'prodi') {
        // --- KONTEN PANDUAN UNTUK PRODI / UNIT ---
        htmlContent = `
        <div class="accordion" id="accordionPanduanProdi">
            
            <div class="alert alert-info d-flex align-items-center">
                <i class="bi bi-info-circle-fill fs-4 me-3"></i>
                <div>
                    <strong>Selamat Datang, ${STATE.id}!</strong><br>
                    Panduan ini menjelaskan alur kerja pengajuan anggaran mulai dari perencanaan hingga realisasi.
                </div>
            </div>

            <!-- 1. Pengajuan Anggaran -->
            <div class="accordion-item">
                <h2 class="accordion-header" id="headingOne">
                    <button class="accordion-button" type="button" data-bs-toggle="collapse" data-bs-target="#collapseOne">
                        <strong>1. Cara Melakukan Pengajuan Anggaran (Awal & Perubahan)</strong>
                    </button>
                </h2>
                <div id="collapseOne" class="accordion-collapse collapse show" data-bs-parent="#accordionPanduanProdi">
                    <div class="accordion-body">
                        <ol>
                            <li>Pilih menu <strong>Formulir Ajuan</strong> (Awal atau Perubahan sesuai tahap aktif).</li>
                            <li>Isi form <strong>Rincian Ajuan</strong> (Grub Belanja, Kelompok, Judul, Rincian, Volume, Harga).</li>
                            <li>Klik tombol <strong><i class="bi bi-plus-circle"></i> Tambahkan ke Daftar Sementara</strong>. Item akan masuk ke tabel bawah.</li>
                            <li>Ulangi langkah tersebut untuk item lain. Perhatikan <strong>Info Pagu Anggaran</strong> di atas agar tidak melebihi batas.</li>
                            <li>Jika sudah selesai, klik tombol <strong><i class="bi bi-send"></i> Kirim Semua Ajuan</strong> untuk mengirim ke Direktorat.</li>
                            <li>Alternatif: Gunakan fitur <strong>Import Excel</strong> untuk mengupload banyak data sekaligus (Download template terlebih dahulu).</li>
                        </ol>
                    </div>
                </div>
            </div>

            <!-- 2. Memantau Status & Perbaikan -->
            <div class="accordion-item">
                <h2 class="accordion-header" id="headingTwo">
                    <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseTwo">
                        <strong>2. Memantau Status & Melakukan Revisi</strong>
                    </button>
                </h2>
                <div id="collapseTwo" class="accordion-collapse collapse" data-bs-parent="#accordionPanduanProdi">
                    <div class="accordion-body">
                        <ul>
                            <li>Buka menu <strong>Daftar Ajuan</strong>.</li>
                            <li>Lihat kolom <strong>Status</strong>:
                                <ul>
                                    <li><span class="badge bg-secondary">Menunggu Review</span>: Sedang diperiksa Direktorat.</li>
                                    <li><span class="badge bg-warning text-dark">Revisi</span>: Perlu perbaikan. Klik tombol <i class="bi bi-pencil"></i> (Edit), perbaiki data/catatan, lalu Simpan.</li>
                                    <li><span class="badge bg-success">Diterima</span>: Ajuan disetujui.</li>
                                    <li><span class="badge bg-danger">Ditolak</span>: Ajuan tidak disetujui.</li>
                                </ul>
                            </li>
                            <li>Gunakan tombol <i class="bi bi-chat-dots"></i> untuk berdiskusi/chat dengan reviewer.</li>
                        </ul>
                    </div>
                </div>
            </div>

            <!-- 3. RPD (Rencana Penarikan Dana) -->
            <div class="accordion-item">
                <h2 class="accordion-header" id="headingThree">
                    <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseThree">
                        <strong>3. Mengisi RPD (Rencana Penarikan Dana)</strong>
                    </button>
                </h2>
                <div id="collapseThree" class="accordion-collapse collapse" data-bs-parent="#accordionPanduanProdi">
                    <div class="accordion-body">
                        <p>Setelah ajuan berstatus <strong>Diterima</strong>, Anda wajib mengisi RPD:</p>
                        <ol>
                            <li>Buka menu <strong>RPD</strong>.</li>
                            <li>Sistem menampilkan daftar barang yang disetujui.</li>
                            <li>Isi kolom <strong>Jan - Des</strong> sesuai rencana pembelanjaan.</li>
                            <li>Pastikan kolom <strong>Sisa</strong> bernilai 0 (Total RPD = Total Diterima).</li>
                            <li>Klik tombol <i class="bi bi-save"></i> <strong>Simpan</strong> di sebelah kanan setiap baris.</li>
                        </ol>
                    </div>
                </div>
            </div>

            <!-- 4. Realisasi -->
            <div class="accordion-item">
                <h2 class="accordion-header" id="headingFour">
                    <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseFour">
                        <strong>4. Melaporkan Realisasi Anggaran</strong>
                    </button>
                </h2>
                <div id="collapseFour" class="accordion-collapse collapse" data-bs-parent="#accordionPanduanProdi">
                    <div class="accordion-body">
                        <ol>
                            <li>Buka menu <strong>Realisasi</strong>.</li>
                            <li>Isi nominal realisasi pada bulan yang bersangkutan ketika dana telah cair/dibelanjakan.</li>
                            <li>Klik tombol <i class="bi bi-save"></i> <strong>Simpan</strong>.</li>
                            <li>Grafik di Dashboard akan otomatis terupdate membandingkan RPD vs Realisasi.</li>
                        </ol>
                    </div>
                </div>
            </div>
            
             <!-- 5. Cetak & Berita Acara -->
            <div class="accordion-item">
                <h2 class="accordion-header" id="headingFive">
                    <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseFive">
                        <strong>5. Mencetak Laporan & Berita Acara</strong>
                    </button>
                </h2>
                <div id="collapseFive" class="accordion-collapse collapse" data-bs-parent="#accordionPanduanProdi">
                    <div class="accordion-body">
                        <ul>
                            <li>Gunakan tombol <strong>Export Excel / PDF / Print</strong> yang tersedia di atas setiap tabel (Daftar Ajuan, RPD, Realisasi).</li>
                            <li>Untuk mencetak Berita Acara penetapan anggaran, buka tab <strong>Berita Acara</strong>.</li>
                            <li>Pastikan <strong>Pengaturan Akun</strong> (Nama & Jabatan TTD) sudah diisi agar tercetak di laporan.</li>
                        </ul>
                    </div>
                </div>
            </div>

        </div>`;

    } else {
        // --- KONTEN PANDUAN UNTUK DIREKTORAT ---
        htmlContent = `
        <div class="accordion" id="accordionPanduanDirektorat">
            
            <div class="alert alert-primary d-flex align-items-center">
                <i class="bi bi-shield-check fs-4 me-3"></i>
                <div>
                    <strong>Mode Administrator / Direktorat</strong><br>
                    Anda memiliki akses penuh untuk manajemen user, pengaturan sistem, dan review anggaran.
                </div>
            </div>

            <!-- 1. Review Ajuan -->
            <div class="accordion-item">
                <h2 class="accordion-header" id="headingDir1">
                    <button class="accordion-button" type="button" data-bs-toggle="collapse" data-bs-target="#collapseDir1">
                        <strong>1. Melakukan Review Ajuan (Approval)</strong>
                    </button>
                </h2>
                <div id="collapseDir1" class="accordion-collapse collapse show" data-bs-parent="#accordionPanduanDirektorat">
                    <div class="accordion-body">
                        <p>Anda dapat mereview ajuan satu per satu atau secara massal:</p>
                        <ul>
                            <li><strong>Review Satuan:</strong> Pada tabel Daftar Ajuan, klik tombol aksi:
                                <ul>
                                    <li><button class="btn btn-sm btn-success disabled"><i class="bi bi-check2-square"></i></button> Terima</li>
                                    <li><button class="btn btn-sm btn-warning disabled"><i class="bi bi-arrow-counterclockwise"></i></button> Minta Revisi (Tulis catatan)</li>
                                    <li><button class="btn btn-sm btn-danger disabled"><i class="bi bi-x-square"></i></button> Tolak</li>
                                </ul>
                            </li>
                            <li><strong>Review Massal:</strong> Centang kotak di sebelah kiri baris (atau "Pilih Semua"), lalu gunakan tombol aksi massal yang muncul di atas tabel.</li>
                            <li><strong>Blokir:</strong> Gunakan tombol <i class="bi bi-lock"></i> untuk memblokir ajuan Diterima agar tidak masuk perhitungan RPD (misal: dana ditahan).</li>
                        </ul>
                    </div>
                </div>
            </div>

            <!-- 2. Manajemen & Pengaturan -->
            <div class="accordion-item">
                <h2 class="accordion-header" id="headingDir2">
                    <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseDir2">
                        <strong>2. Pengaturan Sistem & Tahapan</strong>
                    </button>
                </h2>
                <div id="collapseDir2" class="accordion-collapse collapse" data-bs-parent="#accordionPanduanDirektorat">
                    <div class="accordion-body">
                        <p>Buka menu <strong>Manajemen</strong> untuk:</p>
                        <ul>
                            <li><strong>Manajemen User:</strong> Menambah Unit/Prodi baru, mereset password, atau mengatur Pagu Anggaran (Ceiling).</li>
                            <li><strong>Data Master:</strong> Mengelola Grub Belanja dan Kelompok Belanja.</li>
                            <li><strong>Pengaturan Global:</strong>
                                <ul>
                                    <li>Membuka/Menutup Status Ajuan (Awal/Perubahan).</li>
                                    <li>Mengatur Tanggal Batas Pengajuan (Deadline).</li>
                                    <li>Mengaktifkan Pengumuman di Dashboard user.</li>
                                </ul>
                            </li>
                            
                        </ul>
                    </div>
                </div>
            </div>

            <!-- 3. Monitoring -->
            <div class="accordion-item">
                <h2 class="accordion-header" id="headingDir3">
                    <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#collapseDir3">
                        <strong>3. Monitoring Dashboard & Log</strong>
                    </button>
                </h2>
                <div id="collapseDir3" class="accordion-collapse collapse" data-bs-parent="#accordionPanduanDirektorat">
                    <div class="accordion-body">
                        <ul>
                            <li><strong>Dashboard Utama:</strong> Melihat ringkasan total Pagu, RPD, dan Realisasi seluruh institusi.</li>
                            <li><strong>Filter Dashboard:</strong> Gunakan filter Tahun atau Tipe Ajuan untuk melihat data spesifik.</li>
                            <li><strong>Tabel Ringkasan Unit:</strong> (Muncul jika tidak ada filter) Melihat performa serapan anggaran per Prodi secara real-time.</li>
                            <li><strong>Log Aktivitas:</strong> Memantau siapa yang melakukan perubahan data, login, atau menghapus item.</li>
                        </ul>
                    </div>
                </div>
            </div>

        </div>`;
    }

    container.innerHTML = htmlContent;
}
  // ------------------------------------------------------------------
  // --- END FIREBASE CONFIGURATION FUNCTIONS ---
  // ------------------------------------------------------------------


  function updatePerubahanUI(settings) {
    const isTahapPerubahanOpen = settings.Status_Ajuan_Perubahan === 'Dibuka';
    const tahapAktif = settings.Tahap_Perubahan_Aktif || 1;
    const tahapStr = `Perubahan ${tahapAktif}`;
    const navItemAjuanPerubahan = document.getElementById('nav-item-ajuan-perubahan');
    const navItemDaftarPerubahan = document.getElementById('nav-item-daftar-perubahan');
    const navItemRpdPerubahan = document.getElementById('nav-item-rpd-perubahan');
    const navItemRealisasiPerubahan = document.getElementById('nav-item-realisasi-perubahan');
    
    if (navItemAjuanPerubahan) navItemAjuanPerubahan.style.display = isTahapPerubahanOpen ? 'block' : 'none';
    if (navItemDaftarPerubahan) navItemDaftarPerubahan.style.display = isTahapPerubahanOpen ? 'block' : 'none';
    if (navItemRpdPerubahan) navItemRpdPerubahan.style.display = isTahapPerubahanOpen ? 'block' : 'none';
    if (navItemRealisasiPerubahan) navItemRealisasiPerubahan.style.display = isTahapPerubahanOpen ? 'block' : 'none';

    if (isTahapPerubahanOpen) {
      const linkAjuanPerubahan = document.querySelector('#link-ajuan-perubahan');
      const linkDaftarPerubahan = document.querySelector('#link-daftar-perubahan');
      const linkRpdPerubahan = document.querySelector('#link-rpd-perubahan');
      const linkRealisasiPerubahan = document.querySelector('#link-realisasi-perubahan');
      
      if (linkAjuanPerubahan) linkAjuanPerubahan.innerHTML = `<i class="bi bi-pencil-square"></i> Buat Ajuan ${tahapStr}`;
      if (linkDaftarPerubahan) linkDaftarPerubahan.innerHTML = `<i class="bi bi-list-check"></i> Daftar Ajuan ${tahapStr}`;
      if (linkRpdPerubahan) linkRpdPerubahan.innerHTML = `<i class="bi bi-calendar2-event"></i> RPD ${tahapStr}`;
      if (linkRealisasiPerubahan) linkRealisasiPerubahan.innerHTML = `<i class="bi bi-graph-up-arrow"></i> Realisasi ${tahapStr}`;
    }
    const daftarPerubahanTitle = document.getElementById('daftar-perubahan-title');
    const rpdPerubahanTitle = document.getElementById('rpd-perubahan-title');
    const realisasiPerubahanTitle = document.getElementById('realisasi-perubahan-title');

    if(daftarPerubahanTitle) daftarPerubahanTitle.innerHTML = `<i class="bi bi-list-check"></i> Daftar Ajuan ${tahapStr}`;
    if(rpdPerubahanTitle) rpdPerubahanTitle.innerHTML = `<i class="bi bi-calendar2-event"></i> RPD ${tahapStr}`;
    if(realisasiPerubahanTitle) realisasiPerubahanTitle.innerHTML = `<i class="bi bi-graph-up-arrow"></i> Realisasi ${tahapStr}`;
    
    const copyBtn = document.getElementById('btn-copy-accepted');
    // KRITIS: HANYA tampilkan untuk PRODI saat tahap perubahan aktif
    if (copyBtn) {
        if (isTahapPerubahanOpen && STATE.role === 'prodi') { // <--- KRITIS: DIUBAH MENJADI 'prodi'
             copyBtn.style.display = 'block';
             const sourceStr = tahapAktif == 1 ? "Awal" : `Perubahan ${tahapAktif - 1}`;
             const destinationStr = tahapAktif == 1 ? `Perubahan ${tahapAktif}` : `Perubahan ${tahapAktif}`;
             copyBtn.innerHTML = `<i class="bi bi-files"></i> Pindahkan Ajuan Diterima (${sourceStr} -> ${destinationStr})`; // <-- Disesuaikan teksnya
             copyBtn.title = `Salin semua ajuan dari tahap ${sourceStr} yang diterima dan tidak diblokir ke daftar ${destinationStr}`;
        } else {
             copyBtn.style.display = 'none';
        }
    }
}

  async function updateProdiPaguInfo(userData) {
    if (!userData || STATE.role !== 'prodi') return;
    const paguInfoArea = document.getElementById('pagu-info-area');
    if (!paguInfoArea) return;
    
    try {
        const paguAnggaran = Number(userData.Pagu_Anggaran) || 0;
        
        // Ajuan Awal selalu di tabel 'ajuan'
        const ajuanAwalTableName = getAjuanTableName('Awal'); 

        // 1. Calculate Total Ajuan Awal (Active Statuses) (Supabase Query)
        const { data: activeAjuanAwalData, error: awalError } = await sb.from(ajuanAwalTableName)
            .select('Total')
            .eq('ID_Prodi', STATE.id)
            .eq('Tipe_Ajuan', 'Awal')
            .in('Status', ['Menunggu Review', 'Diterima', 'Revisi']);

        if (awalError) throw awalError;

        let totalDiajukanAwal = 0;
        activeAjuanAwalData.forEach(data => {
            totalDiajukanAwal += Number(data.Total) || 0;
        });
        
        // 2. Calculate Total Ajuan Overall (Active Statuses) (Supabase Query)
        // NOTE: Ini mengasumsikan STATE.currentAjuanType di tab Form Ajuan (bisa Awal atau Perubahan X)
        const activeTableName = getAjuanTableName(STATE.currentAjuanType); 
        
        const { data: activeAjuanOverallData, error: overallError } = await sb.from(activeTableName)
            .select('Total')
            .eq('ID_Prodi', STATE.id)
            .in('Status', ['Menunggu Review', 'Diterima', 'Revisi']);
            
        if (overallError) throw overallError;

        let totalDiajukanOverall = 0;
        activeAjuanOverallData.forEach(data => {
            totalDiajukanOverall += Number(data.Total) || 0;
        });


        const sisaPaguAwal = paguAnggaran - totalDiajukanAwal;
        const sisaPaguClass = sisaPaguAwal < 0 ? 'text-danger fw-bold' : 'text-success';

        let extraInfo = '';
        if (STATE.currentAjuanType !== 'Awal') {
            extraInfo = `
                <div class="mt-2 pt-2 border-top w-100">
                    <span class="text-muted">Total Ajuan Aktif di tahap ${STATE.currentAjuanType}:</span>
                    <strong class="d-block fs-6">Rp ${totalDiajukanOverall.toLocaleString('id-ID')}</strong>
                </div>`;
        }


        paguInfoArea.innerHTML = `
            <div class="d-flex flex-wrap justify-content-around text-center small">
                <div>
                    <span class="text-muted">Pagu Anggaran Awal Anda (Ceiling Awal):</span>
                    <strong class="d-block fs-6">Rp ${paguAnggaran.toLocaleString('id-ID')}</strong>
                </div>
                <div>
                    <span class="text-muted">Total Ajuan Awal Aktif (Menunggu/Diterima/Revisi):</span>
                    <strong class="d-block fs-6">Rp ${totalDiajukanAwal.toLocaleString('id-ID')}</strong>
                </div>
                <div>
                    <span class="text-muted">Sisa Pagu Awal yang Belum Diajukan:</span>
                    <strong class="d-block fs-6 ${sisaPaguClass}">Rp ${sisaPaguAwal.toLocaleString('id-ID')}</strong>
                </div>
                ${extraInfo}
            </div>
        `;
        paguInfoArea.style.display = 'block';

    } catch (error) {
        console.error("Gagal update Pagu Info:", error);
        paguInfoArea.innerHTML = `<div class="text-danger small text-center">Gagal memuat informasi pagu anggaran.</div>`;
        paguInfoArea.style.display = 'block';
    }
  }

// --- FIX: initializeApp ---
async function initializeApp(userData) {
    STATE.role = userData.Role;
    STATE.id = userData.ID_Prodi;
    STATE.uid = userData.uid;
    STATE.currentUserData = userData;

    document.body.classList.remove('login-view');
    document.getElementById('login-page-wrapper').style.display = 'none';
    document.getElementById('app-area').style.display = 'block';
    
    // Tampilan Badge User
    let roleBadgeColor = STATE.role === 'pimpinan' ? 'bg-warning text-dark' : 'bg-secondary';
    document.getElementById('welcome').innerHTML = `<span class="badge ${roleBadgeColor} me-2">${STATE.role.toUpperCase()}</span> <strong>${STATE.id} - ${userData.Nama_Prodi}</strong>`;
    
    await loadGlobalSettings(); 
    await loadBeritaAcaraSettings();
    updatePerubahanUI(STATE.globalSettings); 
    displayGlobalAnnouncement(); 
    updateDashboardDeadlineInfo();
    renderUserGuide(); 

    // --- LOGIKA HAK AKSES (ROLE MANAGEMENT) ---
    
    // 1. Reset Tampilan Menu (Sembunyikan semua dulu)
    const menusToHide = [
        'nav-item-ajuan-awal', 'nav-item-ajuan-perubahan', // Buat Ajuan
        'tab-manage-link', // Pengaturan Admin
        'tab-log-link', // Log Aktivitas
        'tab-pengaturan-akun-link', // Pengaturan Akun
        'tab-berita-acara', // Berita Acara
        'tab-matrix-semula-menjadi' // Matrix
    ];
    
    // Helper untuk hide/show element by ID (bukan class/target)
    // Perhatikan: ID di HTML Anda untuk Matrix adalah di <a> atau <li>, pastikan ID-nya benar.
    // Di index.html Anda: Matrix ada di <li> tanpa ID spesifik, tapi punya target. 
    // Kita anggap ID <li> nya 'tab-matrix-link' (Anda mungkin perlu tambahkan ID ini di HTML jika belum ada)
    // Atau gunakan querySelector untuk target href.
    
    // Sembunyikan menu spesifik
    const hideMenuByHref = (href) => {
        const el = document.querySelector(`a[href="${href}"]`)?.parentElement;
        if(el) el.style.display = 'none';
    };

    if (STATE.role === 'pimpinan') {
        // --- KONFIGURASI PIMPINAN ---
        // Hide menu input & admin
        hideMenuByHref('#tab-form-ajuan');
        hideMenuByHref('#tab-manage');
        hideMenuByHref('#tab-log');
        hideMenuByHref('#tab-pengaturan-akun');
        hideMenuByHref('#tab-berita-acara');
        
        // --- BARIS DI BAWAH INI DIHAPUS AGAR MATRIX MUNCUL ---
        // hideMenuByHref('#tab-matrix-semula-menjadi'); 
        
        // Show filter Unit di Dashboard
        const dashFilter = document.getElementById('filterProdiDashboard');
        if(dashFilter) dashFilter.style.display = 'inline-block';

        // Tampilkan filter prodi di tab lain
        ['filterProdiAwal', 'filterProdiPerubahan', 'filterProdiRPDAwal', 'filterProdiRPDPerubahan', 'filterProdiRealisasiAwal', 'filterProdiRealisasiPerubahan'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'inline-block';
        });

        document.getElementById('direktorat-charts').style.display = 'block'; // Pimpinan melihat chart

    } else if (STATE.role === 'prodi') {
        // --- KONFIGURASI PRODI ---
        if (STATE.globalSettings.Status_Ajuan_Perubahan === 'Dibuka') {
            STATE.currentAjuanType = `Perubahan ${STATE.globalSettings.Tahap_Perubahan_Aktif || 1}`;
        } else {
            STATE.currentAjuanType = 'Awal';
        }
        await updateProdiPaguInfo(userData);

        // Hide filter prodi (karena hanya lihat data sendiri)
        ['filterProdiAwal', 'filterProdiPerubahan', 'filterProdiRPDAwal', 'filterProdiRPDPerubahan', 'filterProdiRealisasiAwal', 'filterProdiRealisasiPerubahan', 'filterProdiBA', 'filterProdiDashboard'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        
        document.getElementById('direktorat-charts').style.display = 'none';
        const accountLink = document.getElementById('tab-pengaturan-akun-link');
        if(accountLink) accountLink.style.display = 'block';

        // Logika Menu Ajuan
        const navAwal = document.getElementById('nav-item-ajuan-awal');
        if(navAwal) navAwal.style.display = (STATE.globalSettings.Status_Ajuan_Perubahan === 'Dibuka') ? 'none' : 'block';

    } else { 
        // --- KONFIGURASI DIREKTORAT ---
        // Show filter prodi
        ['filterProdiAwal', 'filterProdiPerubahan', 'filterProdiRPDAwal', 'filterProdiRPDPerubahan', 'filterProdiRealisasiAwal', 'filterProdiRealisasiPerubahan', 'filterProdiBA', 'filterProdiDashboard'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'inline-block';
        });
        document.getElementById('direktorat-charts').style.display = 'block';
        
        // Show Admin Menus
        const manageLink = document.getElementById('tab-manage-link');
        if(manageLink) manageLink.style.display = 'block';
        const logLink = document.getElementById('tab-log-link');
        if(logLink) logLink.style.display = 'block';
    }
    
    // Buka Dashboard Default
    const dashboardTabTrigger = document.querySelector('[data-bs-target="#tab-dashboard"]');
    if (dashboardTabTrigger) {
        const tab = bootstrap.Tab.getOrCreateInstance(dashboardTabTrigger);
        tab.show();
    }
    
    await loadInitialData(); 
    await loadFilterOptionsRekapan();
    await loadDashboardData();
    
    setupNotificationListener();
    setupExportListeners();

    loadRekapanRealisasi(); 

    // Listener Dashboard Filters
    ['filterTahunDashboard', 'filterTipeDashboard', 'filterProdiDashboard'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => {
            STATE.cachedDashboardData = []; 
            loadDashboardData(true);
        });
    });
}

  document.getElementById('btn-login').addEventListener('click', async () => {
    const email = document.getElementById('input-user-id').value;
    const password = document.getElementById('input-password').value;
    if (!email || !password) { showToast('Email dan Password harus diisi!', 'warning'); return; }
    
    showLoader(true);
    try {
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        const user = userCredential.user;
        
        const userDoc = await db.collection('users').doc(user.uid).get();
        if (!userDoc.exists) {
            await auth.signOut();
            throw new Error("Profil pengguna tidak ditemukan. Hubungi administrator.");
        }
        
        const userData = userDoc.data();
        const sessionData = { ...userData, uid: user.uid };
        saveSession(sessionData);
        await initializeApp(sessionData);
        await logActivity('User Login', `Login berhasil.`);

    } catch (error) {
        console.error("Login process error:", error); // Log the actual error
        const message = error.code === 'auth/wrong-password' || error.code === 'auth/user-not-found' ? 'Email atau Password salah.' : 'Terjadi kesalahan saat login.';
        showToast(`Login Gagal: ${message}`, 'danger');
    } finally {
        showLoader(false);
    }
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    try {
        await logActivity('User Logout');
        if(STATE.notificationListener) STATE.notificationListener();
        await auth.signOut();
        clearSession();
        // --- OPTIMIZATION: Hapus cache saat logout ---
        localStorage.removeItem('siPandaiSession');
        localStorage.removeItem('cache_allKelompok');
        localStorage.removeItem('cache_allProdi');
        localStorage.removeItem('cache_allGrubBelanja'); 
        window.location.reload();
    } catch (error) {
        showToast(`Gagal logout: ${error.message}`, 'danger');
    }
  });
  
  function showLoginPage() {
    clearSession();
    document.body.classList.add('login-view');
    document.getElementById('login-page-wrapper').style.display = 'flex';
    document.getElementById('app-area').style.display = 'none';
    document.getElementById('input-password').value = '';
  }

  auth.onAuthStateChanged(async (user) => {
    showLoader(true);
    if (user) {
        try {
            const userDoc = await db.collection('users').doc(user.uid).get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                const sessionData = { ...userData, uid: user.uid };
                saveSession(sessionData);
                await initializeApp(sessionData);
            } else { await auth.signOut(); }
        } catch (error) { await auth.signOut(); }
    } else { showLoginPage(); }
    showLoader(false);
  });
  
  // createNotification uses Firebase (notifications collection) - KEPT
  async function createNotification(targetUid, message) {
      if (!targetUid) return;
      try {
        await db.collection('notifications').add({
            targetUid: targetUid,
            message: message,
            isRead: false,
            timestamp: serverTimestamp()
        });
      } catch (e) { console.error("Gagal membuat notifikasi:", e); }
  }

  // --- MIGRATED TO SUPABASE: ajuan_history ---
  async function logHistory(ajuanId, action, details) {
      try {
        // Ajuan history is now a separate Supabase table
        await sb.from('ajuan_history').insert({
            ajuan_id: String(ajuanId), // Ensure ID is a string for consistency
            action: action,
            details: details,
            userId: STATE.id,
            userUid: STATE.uid,
            timestamp: sbTimestamp()
        });
      } catch(e) { console.error("Gagal mencatat riwayat (Supabase):", e); }
  }

  // setupNotificationListener uses Firebase (notifications collection) - KEPT
  function setupNotificationListener() {
      if (STATE.notificationListener) STATE.notificationListener();
      if (!STATE.uid) return;
      
      // KRITIS: Pastikan Firebase Security Rules mengizinkan pengguna untuk membaca koleksi 'notifications'
      // hanya untuk dokumen yang targetUid-nya sesuai dengan UID pengguna saat ini.
        STATE.notificationListener = db.collection('notifications').where('targetUid', '==', STATE.uid)
          .orderBy('timestamp', 'desc')
          .limit(20)
          .onSnapshot(snapshot => {
              let notifications = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
              const unreadCount = notifications.filter(n => !n.isRead).length;
              const countEl = document.getElementById('notification-count');
              
              if (unreadCount > 0) {
                  countEl.textContent = unreadCount;
                  countEl.style.display = 'flex';
              } else {
                  countEl.style.display = 'none';
              }
              renderNotifications(notifications);
          }, error => {
              // Jika ini gagal (Error 403 / Missing permissions), cek Firebase Security Rules!
              console.error("Error listener notifikasi (Cek Firebase Security Rules):", error);
          });
  }

  function renderNotifications(notifications) {
      const container = document.getElementById('notification-items-container');
      if (notifications.length === 0) {
          container.innerHTML = '<p class="text-muted text-center small p-3">Tidak ada notifikasi baru.</p>';
          return;
      }
      container.innerHTML = notifications.map(n => {
          const time = n.timestamp && n.timestamp.toDate ? n.timestamp.toDate().toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) : '';
          return `<div class="list-group-item list-group-item-action ${!n.isRead ? 'unread' : ''}">
                      <div class="d-flex w-100 justify-content-between">
                          <p class="mb-1 small">${escapeHtml(n.message)}</p>
                      </div>
                      <small class="text-muted">${time}</small>
                  </div>`;
      }).join('');
  }

  document.getElementById('notification-bell').addEventListener('show.bs.dropdown', async () => {
      const unreadSnapshot = await db.collection('notifications')
          .where('targetUid', '==', STATE.uid)
          .where('isRead', '==', false)
          .get();
      
      if (unreadSnapshot.empty) return;
      const batch = db.batch();
      unreadSnapshot.docs.forEach(doc => {
          batch.update(doc.ref, { isRead: true });
      });
      await batch.commit().catch(e => console.error("Gagal menandai notifikasi terbaca:", e));
  });

  // --- MIGRATED TO SUPABASE: openHistoryModal ---
  window.openHistoryModal = async (id, nama) => {
    // Ensure ID is a string before substring
    const ajuanId = String(id);
    document.getElementById('historyModalAjuanId').innerText = ajuanId.substring(0, 6) + '...';
    document.getElementById('historyModalAjuanNama').innerText = nama;
    const logListEl = document.getElementById('history-log-list');
    if(logListEl) logListEl.innerHTML = `<div class="text-center text-muted p-3">Memuat riwayat...</div>`;
    
    const historyModalEl = document.getElementById('historyModal');
    if (historyModalEl) {
        const modal = bootstrap.Modal.getOrCreateInstance(historyModalEl);
        modal.show();
    }

    try {
        // Supabase Query (History is stored centrally, identified by ajuan_id)
        const { data: historyLogs, error } = await sb.from('ajuan_history')
            .select('*')
            .eq('ajuan_id', ajuanId)
            .order('timestamp', { ascending: false });
            
        if (error) throw error;

        if (historyLogs.length === 0) {
            if(logListEl) logListEl.innerHTML = `<div class="text-center text-muted p-3">Belum ada riwayat perubahan.</div>`;
            return;
        }
        
        if(logListEl) logListEl.innerHTML = historyLogs.map(log => {
            // Convert ISO string to Date object
            const timestamp = log.timestamp ? new Date(log.timestamp) : null;
            const time = timestamp ? timestamp.toLocaleString('id-ID') : '';
            return `<div class="history-log-item">
                        <div class="d-flex justify-content-between align-items-center">
                            <strong class="text-primary">${escapeHtml(log.action)}</strong>
                            <small class="text-muted">${time}</small>
                        </div>
                        <p class="mb-1 small">${escapeHtml(log.details)}</p>
                        <small class="text-muted fst-italic">Oleh: ${escapeHtml(log.userId)}</small>
                    </div>`;
        }).join('');
    } catch (error) {
        if(logListEl) logListEl.innerHTML = `<div class="text-center text-danger p-3">Gagal memuat riwayat.</div>`;
        console.error("History fetch error (Supabase):", error);
    }
  };

  function clearRincianForm() {
      // Clear standard fields
      ['namaAjuan', 'satuan', 'keterangan', 'dataDukung'].forEach(id => setElValue(id, ''));
      
      // Clear calculated result fields (now outputs of manual calculation)
      ['jumlah', 'hargaSatuan', 'total'].forEach(id => setElValue(id, '')); 
      
      // Clear the 6 calculation inputs and their units (kept for safety/schema)
      for (let i = 1; i <= 6; i++) {
          setElValue(`calcA${i}`, '');
          setElValue(`calcS${i}`, '');
      }

      setElValue('selectGrub', '');
      setElValue('selectKelompok', '');
      setElValue('selectRevisi', 'Ajuan Baru');
      const namaAjuanEl = document.getElementById('namaAjuan');
      if(namaAjuanEl) namaAjuanEl.focus();
  }
  function clearAjuanForm() { 
      setElValue('judulKegiatan', '');
      clearRincianForm(); 
  }
  function saveStagingToLocal() {
    localStorage.setItem('siPandai_stagingList', JSON.stringify(STATE.stagingList));
}
  function renderStagingTable() {
    const stagingArea = document.getElementById('staging-area'); 
    const container = document.getElementById('staging-table-container'); 
    const summaryEl = document.getElementById('staging-summary');
    
    
    if (!stagingArea || !container || !summaryEl) return;

    if (STATE.stagingList.length === 0) { stagingArea.style.display = 'none'; container.innerHTML = ''; return; }
    stagingArea.style.display = 'block';
    let totalStaging = 0;
    const tableRows = STATE.stagingList.map((item, index) => {
      const itemTotal = Number(item.Total) || 0; totalStaging += itemTotal;
      return `<tr><td>${index + 1}</td><td>${escapeHtml(item.Grub_Belanja_Utama)}</td><td>${escapeHtml(item.Judul_Kegiatan)}</td><td>${escapeHtml(item.Nama_Ajuan)}</td><td>${escapeHtml(item.ID_Kelompok)}</td><td class="text-end">${Number(item.Jumlah).toLocaleString('id-ID', { maximumFractionDigits: 2 })}</td><td>${escapeHtml(item.Satuan)}</td><td class="text-end">${Number(item.Harga_Satuan).toLocaleString('id-ID')}</td><td class="text-end fw-bold">${itemTotal.toLocaleString('id-ID')}</td><td><button class="btn btn-sm btn-outline-danger" onclick="window.removeFromStaging(${index})" title="Hapus"><i class="bi bi-trash"></i></button></td></td></tr>`;
    }).join('');
    container.innerHTML = `<table class="table table-sm table-striped"><thead class="table-light"><tr><th>No.</th><th>Grub Belanja</th><th>Judul Kegiatan</th><th>Rincian Ajuan</th><th>Kelompok</th><th class="text-end">Jumlah</th><th>Satuan</th><th class="text-end">Harga Satuan</th><th class="text-end">Total</th><th>Aksi</th></tr></thead><tbody>${tableRows}</tbody></table>`;
    summaryEl.innerHTML = `Total Ajuan: ${STATE.stagingList.length} Rincian | Grand Total: Rp ${totalStaging.toLocaleString('id-ID')}`;
  }
  window.removeFromStaging = (index) => { STATE.stagingList.splice(index, 1); saveStagingToLocal(); renderStagingTable(); }
  
  document.getElementById('btn-add-to-staging').addEventListener('click', () => {
    if (STATE.role !== 'prodi') { showToast('Hanya role prodi yang dapat mengajukan.', 'danger'); return; }
    
    // 1. Perform calculation and get results from manual inputs
    const calcResults = hitungTotalAjuan();
    
    const judulKegiatan = getSafeValue('judulKegiatan').trim();
    const namaAjuan = getSafeValue('namaAjuan').trim();
    const satuan = getSafeValue('satuan').trim();
    
    // Check if the calculated total is valid (must be > 0)
    if (calcResults.total <= 0) {
        showToast('Total biaya harus lebih besar dari 0. Periksa rincian Jumlah dan Harga Satuan.', 'warning'); 
        return;
    }

    if (!judulKegiatan) { showToast('Judul Kegiatan wajib diisi.', 'warning'); document.getElementById('judulKegiatan').focus(); return; }
    if (!namaAjuan || !satuan || !getSafeValue('selectKelompok') || !getSafeValue('selectGrub')){ 
        showToast('Harap lengkapi Judul, Rincian, Satuan Akhir, Kelompok, Grub.', 'warning'); return; 
    }
    
    // 2. Prepare payload
    const payload = {
      Grub_Belanja_Utama: getSafeValue('selectGrub'), 
      Judul_Kegiatan: judulKegiatan, 
      ID_Prodi: STATE.id, 
      ID_Kelompok: getSafeValue('selectKelompok'), 
      Nama_Ajuan: namaAjuan, 
      // Use calculated results for DB fields:
      Jumlah: calcResults.jumlah, 
      Satuan: satuan, 
      Harga_Satuan: calcResults.harga, 
      Total: calcResults.total, 
      Keterangan: getSafeValue('keterangan'), 
      Status_Revisi: getSafeValue('selectRevisi'), 
      Data_Dukung: getSafeValue('dataDukung'),
      
      // NEW: Set calculation breakdown to null/empty as it is not used in this mode
      calcA1: null, calcS1: null,
      calcA2: null, calcS2: null,
      calcA3: null, calcS3: null,
      calcA4: null, calcS4: null,
      calcA5: null, calcS5: null,
      calcA6: null, calcS6: null,
    };
    
    STATE.stagingList.push(payload);
    saveStagingToLocal(); 
    showToast(`Rincian "${payload.Nama_Ajuan}" telah ditambahkan.`, 'info'); 
    renderStagingTable(); 
    clearRincianForm();
  });
  document.getElementById('btn-clear-staging').addEventListener('click', () => {
    if (confirm('Yakin ingin menghapus semua rincian?')) { STATE.stagingList = []; saveStagingToLocal(); renderStagingTable(); clearAjuanForm(); showToast('Daftar ajuan dibersihkan.', 'info'); }
  });

  // --- MIGRATED TO SUPABASE: Ajuan Submission (Bulk Insert) (MODIFIED) ---
  document.getElementById('btn-submit-all-staged').addEventListener('click', async () => {
    if (STATE.stagingList.length === 0) { showToast('Tidak ada ajuan untuk dikirim.', 'warning'); return; }
        const deadlineCheck = validateSubmissionDeadline(STATE.currentAjuanType);
    if (!deadlineCheck.allowed) {
        showToast(deadlineCheck.message, 'danger');
        return; // Hentikan proses jika lewat batas
    }
    showLoader(true);
    const prodiId = STATE.id; // Store current Prodi ID

    try {
        let deadlineTimestamp = null;
        let deadlineType = STATE.currentAjuanType;
        const targetTableName = getAjuanTableName(deadlineType); // <-- REF ACT: Dapatkan nama tabel tujuan

        if (STATE.currentAjuanType === 'Awal') {
            deadlineTimestamp = STATE.globalSettings.Batas_Tanggal_Pengajuan;
        } else {
            deadlineTimestamp = STATE.globalSettings.Batas_Tanggal_Pengajuan_Perubahan;
        }

        if (deadlineTimestamp && deadlineTimestamp.toDate) {
            const deadlineDate = deadlineTimestamp.toDate();
            const today = new Date();
            today.setHours(0, 0, 0, 0); 
            
            if (today > deadlineDate) {
                throw new Error(`Pengajuan ${deadlineType} ditutup. Batas waktu pengajuan adalah ${deadlineDate.toLocaleDateString('id-ID')}.`);
            }
        }
        
        const prodiDoc = await db.collection('users').doc(STATE.uid).get();
        const paguAnggaran = Number(prodiDoc.data().Pagu_Anggaran) || 0;
        
        // --- START Pagu Check Modification (Supabase Query) ---
        if (STATE.currentAjuanType === 'Awal' && paguAnggaran > 0) {
            
            const ajuanAwalTableName = getAjuanTableName('Awal'); // Ajuan Awal selalu di tabel 'ajuan'

            const { data: activeAjuanData, error: ajuanQueryError } = await sb.from(ajuanAwalTableName)
                .select('Total')
                .eq('ID_Prodi', STATE.id)
                .eq('Tipe_Ajuan', 'Awal') 
                .in('Status', ['Menunggu Review', 'Diterima', 'Revisi']);

            if (ajuanQueryError) throw new Error("Gagal memeriksa pagu: " + ajuanQueryError.message);

            let currentTotalAjuanAwal = 0;
            activeAjuanData.forEach(data => {
                currentTotalAjuanAwal += Number(data.Total) || 0;
            });

            const totalStaging = STATE.stagingList.reduce((sum, item) => sum + item.Total, 0);
            
            const projectedTotalAwal = currentTotalAjuanAwal + totalStaging;

            if (projectedTotalAwal > paguAnggaran) {
                throw new Error(`Gagal. Total ajuan Awal yang diajukan (Rp ${projectedTotalAwal.toLocaleString('id-ID')}) akan melebihi pagu anggaran Awal Anda (Rp ${paguAnggaran.toLocaleString('id-ID')}).`);
            }
        }
        // --- END Pagu Check Modification ---

        // --- SUPABASE BULK INSERT ---
        const ajuanToInsert = STATE.stagingList.map(ajuan => ({ 
            ...ajuan, 
            Tipe_Ajuan: STATE.currentAjuanType, 
            Status: "Menunggu Review", 
            Komentar: [], 
            Is_Blocked: false, 
            Timestamp: sbTimestamp()
        }));
        
        // Insert ke tabel yang benar (ajuan atau ajuanrevX)
        const { data: insertedRows, error: insertError } = await sb.from(targetTableName) 
            .insert(ajuanToInsert)
            .select('ID_Ajuan, Total'); 
            
        if (insertError) {
             console.error("Supabase Insert Error:", insertError);
             let msg = insertError.message;
             if (insertError.code === '42501') {
                  msg = `Pelanggaran RLS: Supabase menolak operasi INSERT. Cek RLS policy pada tabel ${targetTableName}.`;
             }
             if (msg.includes("'calcA1' column")) {
                 msg += ". KRITIS: Anda harus menambahkan 12 kolom kalkulasi (calcA1...calcS6) ke tabel 'ajuan' di Supabase.";
             } else if (msg.includes("cannot insert into view")) {
                 msg += ". Harap periksa Trigger atau RLS pada tabel 'ajuan' di Supabase.";
             }
             throw new Error("Gagal menyimpan ajuan: " + msg);
        }

        // Log History individually 
        for (const ajuan of insertedRows) {
            await logHistory(
                String(ajuan.ID_Ajuan), 
                `Ajuan Dibuat (${targetTableName})`,
                `Ajuan baru ditambahkan dengan total Rp ${Number(ajuan.Total).toLocaleString('id-ID')}.`
            );
        }
        // --- END SUPABASE BULK INSERT ---
        
        await logActivity('Create Ajuan', `Mengirim ${STATE.stagingList.length} ajuan baru (${STATE.currentAjuanType}) ke tabel ${targetTableName}.`);

        STATE.allDirektoratUids.forEach(uid => {
            createNotification(uid, `${STATE.id} telah mengirim ${STATE.stagingList.length} ajuan baru untuk direview di tahap ${STATE.currentAjuanType}.`);
        });

        showToast(`${STATE.stagingList.length} ajuan berhasil dikirim.`);
        STATE.stagingList = []; saveStagingToLocal(); renderStagingTable(); clearAjuanForm();
        
        // --- Trigger Recalculation ---
        await recalculateProdiSummary(prodiId);
        // --- End Trigger ---

        if (STATE.currentAjuanType === 'Awal') {
            refreshAjuanTableAwal(true); 
            const tabTrigger = document.querySelector('[data-bs-target="#tab-daftar-awal"]');
            if(tabTrigger) bootstrap.Tab.getOrCreateInstance(tabTrigger).show();
        } else {
            refreshAjuanTablePerubahan(true); 
            const tabTrigger = document.querySelector('[data-bs-target="#tab-daftar-perubahan"]');
            if(tabTrigger) bootstrap.Tab.getOrCreateInstance(tabTrigger).show();
        }
        updateProdiPaguInfo(STATE.currentUserData);

    } catch (error) {
        showToast(error.message, 'danger');
        console.error("Error submitting ajuan: ", error);
    } finally {
        showLoader(false);
    }
  });
  

  // --- TAMBAHKAN KODE INI DI BAGIAN EVENT LISTENERS (BAWAH FILE) ---

// Listener untuk memuat data saat Tab Matrix diklik
const tabMatrixLink = document.querySelector('a[href="#tab-matrix-semula-menjadi"]');
if (tabMatrixLink) {
    tabMatrixLink.addEventListener('shown.bs.tab', () => {
        loadMatrixSemulaMenjadi();
    });
}

// Listener untuk tombol Refresh di dalam Tab Matrix
safeAddClickListener('btn-refresh-matrix', loadMatrixSemulaMenjadi);
  // --- Event Listener and Handler for Import Ajuan (NEW) (MODIFIED) ---
  const uploadAjuanInput = document.getElementById('input-upload-excel-ajuan');
  if (uploadAjuanInput) {
      uploadAjuanInput.addEventListener('change', handleAjuanImport);
  }

      async function handleAjuanImport(e) {
      const file = e.target.files[0];
      if (!file) return;

      if (STATE.role !== 'prodi') {
          showToast('Import Ajuan hanya diizinkan untuk Unit.', 'danger');
          e.target.value = '';
          return;
      }
      
          const deadlineCheck = validateSubmissionDeadline(STATE.currentAjuanType);
    if (!deadlineCheck.allowed) {
        showToast(deadlineCheck.message, 'danger');
        e.target.value = ''; // Reset input file
        return; // Hentikan proses
    }
      showLoader(true);
      const prodiId = STATE.id; // Store current Prodi ID
      const reader = new FileReader();
      
      reader.onload = async (event) => {
          try {
              const data = new Uint8Array(event.target.result);
              const workbook = XLSX.read(data, { type: 'array' });
              const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
              const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
              
              if (jsonData.length < 2) {
                  throw new Error('File Excel kosong atau hanya berisi header.');
              }
              
              const headers = jsonData[0];
              
              // Header validation
              if (!AJUAN_IMPORT_HEADERS.every((h, i) => headers[i] === h)) {
                  throw new Error(`Format header tidak sesuai. Pastikan urutan dan nama header: ${AJUAN_IMPORT_HEADERS.join(', ')}`);
              }
              
              let importData = [];
              const ajuanType = STATE.currentAjuanType; 
              const targetTableName = getAjuanTableName(ajuanType);
              let totalImportedAmount = 0;
              
              for (let i = 1; i < jsonData.length; i++) {
                  const row = jsonData[i];
                  if (!row || row.filter(x => x).length === 0) continue; // Skip empty rows

                  const dataMap = AJUAN_IMPORT_HEADERS.reduce((acc, header, index) => {
                      // Normalize header keys and handle null/undefined
                      acc[header] = row[index];
                      return acc;
                  }, {});
                  
                  // Convert numerical fields safely
                  const jumlah = Number(dataMap.Jumlah) || 0;
                  const hargaSatuan = Number(dataMap.Harga_Satuan) || 0;
                  const total = jumlah * hargaSatuan;
                  
                  // Minimal validation check
                  if (!dataMap.Judul_Kegiatan || !dataMap.Nama_Ajuan || jumlah <= 0 || hargaSatuan < 0 || !dataMap.ID_Kelompok || !dataMap.Grub_Belanja_Utama) {
                      showToast(`Baris ${i + 1} dilewati: Data wajib (Judul, Rincian, Jml, Hrg, Kelompok, Grub) tidak lengkap atau tidak valid.`, 'warning');
                      continue;
                  }
                  
                  // Construct the Supabase row object
                  const newAjuan = {
                      Grub_Belanja_Utama: String(dataMap.Grub_Belanja_Utama), 
                      Judul_Kegiatan: String(dataMap.Judul_Kegiatan), 
                      ID_Prodi: STATE.id, 
                      ID_Kelompok: String(dataMap.ID_Kelompok), 
                      Nama_Ajuan: String(dataMap.Nama_Ajuan), 
                      Jumlah: jumlah, 
                      Satuan: String(dataMap.Satuan || 'unit'), 
                      Harga_Satuan: hargaSatuan, 
                      Total: total, 
                      Keterangan: String(dataMap.Keterangan || ''), 
                      Status_Revisi: String(dataMap.Status_Revisi || 'Ajuan Baru'), 
                      Data_Dukung: String(dataMap.Data_Dukung || ''),
                      Tipe_Ajuan: ajuanType, 
                      Status: "Menunggu Review", 
                      Komentar: [], 
                      Is_Blocked: false, 
                      Timestamp: sbTimestamp()
                  };
                  
                  importData.push(newAjuan);
                  totalImportedAmount += total;
              }
              
              if (importData.length === 0) {
                  throw new Error("Tidak ada data ajuan valid yang ditemukan untuk diimport.");
              }
              
              // --- Pagu Check (Same logic as manual submission) ---
              const paguAnggaran = STATE.currentUserData.Pagu_Anggaran || 0;
              if (ajuanType === 'Awal' && paguAnggaran > 0) {
                  const ajuanAwalTableName = getAjuanTableName('Awal');

                  const { data: activeAjuanData, error: ajuanQueryError } = await sb.from(ajuanAwalTableName)
                      .select('Total')
                      .eq('ID_Prodi', STATE.id)
                      .eq('Tipe_Ajuan', 'Awal') 
                      .in('Status', ['Menunggu Review', 'Diterima', 'Revisi']);

                  if (ajuanQueryError) throw new Error("Gagal memeriksa pagu: " + ajuanQueryError.message);

                  let currentTotalAjuanAwal = 0;
                  activeAjuanData.forEach(data => {
                      currentTotalAjuanAwal += Number(data.Total) || 0;
                  });
                  
                  const projectedTotalAwal = currentTotalAjuanAwal + totalImportedAmount;

                  if (projectedTotalAwal > paguAnggaran) {
                      throw new Error(`Gagal. Total ajuan Awal yang diimport (Rp ${totalImportedAmount.toLocaleString('id-ID')}) akan melebihi pagu Awal Anda (Rp ${paguAnggaran.toLocaleString('id-ID')}).`);
                  }
              }
              // --- End Pagu Check ---


              // --- SUPABASE BULK INSERT ---
              const { data: insertedRows, error: insertError } = await sb.from(targetTableName) // <-- REF ACT: Insert ke tabel yang benar
                  .insert(importData)
                  .select('ID_Ajuan, Total'); 
                  
              if (insertError) {
                   console.error("Supabase Import Insert Error:", insertError);
                   let msg = insertError.message;
                   if (insertError.code === '42501') {
                       msg = `Pelanggaran RLS: Supabase menolak operasi INSERT. Cek RLS policy pada tabel ${targetTableName}.`;
                   }
                   if (msg.includes("'calcA1' column")) {
                       msg += ". KRITIS: Anda harus menambahkan 12 kolom kalkulasi (calcA1...calcS6) ke tabel 'ajuan' di Supabase.";
                   } else if (msg.includes("cannot insert into view")) {
                       msg += ". Harap periksa Trigger atau RLS pada tabel 'ajuan' di Supabase.";
                   }
                   throw new Error("Gagal menyimpan ajuan massal: " + msg);
              }

              // Log History for inserted items
              const logLimit = Math.min(insertedRows.length, 5);
              for (let j = 0; j < logLimit; j++) {
                  const ajuan = insertedRows[j];
                  await logHistory(
                      String(ajuan.ID_Ajuan), 
                      `Ajuan Dibuat (Import Excel, ${targetTableName})`,
                      `Ajuan import ditambahkan (total ${insertedRows.length} item).`
                  );
              }
              
              await logActivity('Import Ajuan', `Mengimport ${insertedRows.length} ajuan dari Excel (${ajuanType}) ke tabel ${targetTableName}. Total: Rp ${totalImportedAmount.toLocaleString('id-ID')}.`);

              STATE.allDirektoratUids.forEach(uid => {
                  createNotification(uid, `${STATE.id} telah mengimport ${insertedRows.length} ajuan baru (${ajuanType}) untuk direview.`);
              });

              showToast(`${insertedRows.length} ajuan berhasil diimport dan dikirim.`, 'success');

              // --- Trigger Recalculation ---
              await recalculateProdiSummary(prodiId);
              // --- End Trigger ---

              // Refresh relevant table and dashboard
              if (ajuanType === 'Awal') {
                  refreshAjuanTableAwal(true); 
                  const tabTrigger = document.querySelector('[data-bs-target="#tab-daftar-awal"]');
                  if(tabTrigger) bootstrap.Tab.getOrCreateInstance(tabTrigger).show();
              } else {
                  refreshAjuanTablePerubahan(true); 
                  const tabTrigger = document.querySelector('[data-bs-target="#tab-daftar-perubahan"]');
                  if(tabTrigger) bootstrap.Tab.getOrCreateInstance(tabTrigger).show();
              }
              updateProdiPaguInfo(STATE.currentUserData);

          } catch (error) {
              showToast(`Gagal mengimpor file: ${error.message}`, 'danger');
              console.error("Import Ajuan Error:", error);
          } finally {
              e.target.value = ''; // Clear file input
              showLoader(false);
          }
      };
      
      reader.readAsArrayBuffer(file);
  }
  
  document.getElementById('link-ajuan-awal').addEventListener('click', () => {
    STATE.currentAjuanType = 'Awal';
    const titleEl = document.getElementById('ajuan-form-title');
    if(titleEl) titleEl.innerHTML = `<i class="bi bi-file-earmark-plus"></i> Formulir Ajuan Awal`;
    updateProdiPaguInfo(STATE.currentUserData);
  });
  document.getElementById('link-ajuan-perubahan').addEventListener('click', () => {
    const tahapAktif = STATE.globalSettings.Tahap_Perubahan_Aktif || 1;
    STATE.currentAjuanType = `Perubahan ${tahapAktif}`;
    const titleEl = document.getElementById('ajuan-form-title');
    if(titleEl) titleEl.innerHTML = `<i class="bi bi-pencil-square"></i> Formulir Ajuan Perubahan ${tahapAktif}`;
    updateProdiPaguInfo(STATE.currentUserData);
  });
  
  function populateGrubBelanja(selectId, isFilter = false) {
    const sel = document.getElementById(selectId); 
    if (!sel) return;
    sel.innerHTML = isFilter ? '<option value="">Semua Grub Belanja</option>' : '<option value="">-- Pilih Grub Belanja --</option>';
    // Use the dynamically populated GRUB_BELANJA_UTAMA_OPTIONS
    GRUB_BELANJA_UTAMA_OPTIONS.forEach(optVal => sel.add(new Option(optVal, optVal)));
  }
  
 // --- PERBAIKAN: loadInitialData (Aman untuk Prodi) ---
async function loadInitialData() {
    showLoader(true);
    try {
        // 1. Load Data Master (Supabase)
        await refreshGrubBelanjaData();
        await refreshKelompokData();
        
        // 2. Load User Data (Firebase) - menggunakan fungsi yang sudah diperbaiki sebelumnya
        await refreshProdiData();

        // 3. Setup Filter (Khusus Direktorat)
        if (STATE.role === 'direktorat') {
            const prodiList = STATE.allProdi.filter(p => p.Role === 'prodi');
            const filterIds = [
                'filterProdiAwal', 'filterProdiPerubahan', 
                'filterProdiRPDAwal', 'filterProdiRPDPerubahan', 
                'filterProdiRealisasiAwal', 'filterProdiRealisasiPerubahan', 
                'filterProdiBA'
            ];
            filterIds.forEach(id => populateProdiFilter(prodiList, id));
        }
        
        // 4. Ambil UID Direktorat (Untuk Notifikasi) - DIBUNGKUS TRY-CATCH AGAR TIDAK CRASH
        try {
            // Hanya jalankan query jika role direktorat, atau coba jalankan tapi tangkap errornya
            if (STATE.role === 'direktorat') {
                const direktoratSnapshot = await db.collection('users').where('Role', '==', 'direktorat').get();
                STATE.allDirektoratUids = direktoratSnapshot.docs.map(doc => doc.id);
            } else {
                // Untuk Prodi, kita tidak bisa query 'users'.
                // Biarkan kosong dulu agar tidak error permission.
                // (Jika notifikasi wajib, solusinya harus lewat Cloud Functions atau struktur data berbeda)
                STATE.allDirektoratUids = []; 
                console.log("Mode Prodi: Melewati pengambilan UID Direktorat via Query (Restricted).");
            }
        } catch (dirError) {
            console.warn("Gagal mengambil UID Direktorat (Non-fatal):", dirError.message);
            STATE.allDirektoratUids = [];
        }

        // 5. Load Data Tabel Utama
        refreshAjuanTableAwal(true); 

    } catch (error) {
        console.error("Error loading initial data:", error);
        showToast('Gagal memuat data awal aplikasi. Coba refresh halaman.', 'danger');
    } finally {
        showLoader(false);
    }
}

  // --- MIGRATED TO SUPABASE: refreshGrubBelanjaData (NEW FUNCTION) ---
  async function refreshGrubBelanjaData() {
      const cacheKey = 'cache_allGrubBelanja';
      const cachedData = getCache(cacheKey);
  
      if (cachedData) {
          console.log("Memuat data Grub Belanja dari CACHE.");
          STATE.allGrubBelanja = cachedData;
      } else {
          console.log("Mengambil data Grub Belanja dari SUPABASE.");
          try {
              // Supabase Query
              const { data: grubData, error } = await sb.from('grub_belanja').select('ID_Grub, Nama_Grub');
              if (error) throw error;
              
              STATE.allGrubBelanja = grubData;
              setCache(cacheKey, STATE.allGrubBelanja, 120); 
          } catch (e) {
              console.error("Gagal mengambil data Grub Belanja (Supabase)", e);
              showToast("Gagal memuat data grub belanja.", "danger");
              return; 
          }
      }
      
      // Populate global options array GRUB_BELANJA_UTAMA_OPTIONS
      GRUB_BELANJA_UTAMA_OPTIONS.length = 0;
      STATE.allGrubBelanja.forEach(g => GRUB_BELANJA_UTAMA_OPTIONS.push(g.Nama_Grub));
  
      // Refresh UI elements
      ['selectGrub', 'edit-selectGrub'].forEach(id => populateGrubBelanja(id));
      ['filterGrubAwal', 'filterGrubPerubahan'].forEach(id => populateGrubBelanja(id, true));
      if (STATE.role === 'direktorat') { populateGrubBelanjaList(STATE.allGrubBelanja); }
  }

  // --- MIGRATED TO SUPABASE: refreshKelompokData ---
  async function refreshKelompokData() {
    const cacheKey = 'cache_allKelompok';
    const cachedData = getCache(cacheKey);

    if (cachedData) {
        console.log("Memuat data Kelompok dari CACHE.");
        STATE.allKelompok = cachedData;
    } else {
        console.log("Mengambil data Kelompok dari SUPABASE.");
        try {
            // Supabase Query (Table name: 'kelompok')
            const { data: kelompokData, error } = await sb.from('kelompok').select('ID_Kelompok, Nama_Kelompok');
            if (error) throw error;
            
            STATE.allKelompok = kelompokData;
            setCache(cacheKey, STATE.allKelompok, 120); 
        } catch (e) {
            console.error("Gagal mengambil data Kelompok (Supabase)", e);
            showToast("Gagal memuat data kelompok.", "danger");
            return; 
        }
    }

    ['selectKelompok', 'edit-selectKelompok'].forEach(id => populateKelompok(STATE.allKelompok, id));
    ['filterKelompokAwal', 'filterKelompokPerubahan'].forEach(id => populateKelompokFilter(STATE.allKelompok, id));
    if (STATE.role === 'direktorat') { populateKelompokList(STATE.allKelompok); }
  }

 // --- PERBAIKAN: refreshProdiData (Role-Aware) ---
async function refreshProdiData() {
    const cacheKey = 'cache_allProdi';
    localStorage.removeItem(cacheKey);

    try {
        let prodiList = [];

        // MODIFIKASI: Pimpinan diperlakukan sama seperti Direktorat dalam hal fetch users
        if (STATE.role === 'direktorat' || STATE.role === 'pimpinan') {
            const prodiSnapshot = await db.collection('users').get();
            prodiList = prodiSnapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() }));
        } else {
            // Prodi logic...
            if (STATE.currentUserData) {
                prodiList = [{ uid: STATE.uid, ...STATE.currentUserData }];
            } else {
                const doc = await db.collection('users').doc(STATE.uid).get();
                if (doc.exists) prodiList = [{ uid: doc.id, ...doc.data() }];
            }
        }
        
        STATE.allProdi = prodiList;
        setCache(cacheKey, STATE.allProdi, 120); 
        
        // Populate Filters
        if (STATE.role === 'direktorat' || STATE.role === 'pimpinan') {
            const listProdiOnly = STATE.allProdi.filter(p => p.Role === 'prodi');
            // Tambahkan ID filterProdiDashboard
            const filterIds = [
                'filterProdiAwal', 'filterProdiPerubahan', 
                'filterProdiRPDAwal', 'filterProdiRPDPerubahan', 
                'filterProdiRealisasiAwal', 'filterProdiRealisasiPerubahan', 
                'filterProdiBA', 'filterProdiDashboard'
            ];
            filterIds.forEach(id => populateProdiFilter(listProdiOnly, id));
            
            // Populate list manajemen hanya untuk Direktorat
            if (STATE.role === 'direktorat' && typeof populateProdiList === 'function') {
                populateProdiList(STATE.allProdi);
            }
        }

    } catch (e) {
        console.error("Gagal mengambil data Prodi", e);
    }
}
  // --- OPTIMIZATION END ---

  function populateKelompok(list, selectId) { 
    const sel = document.getElementById(selectId); 
    if (!sel) return;
    sel.innerHTML = '<option value="">-- Pilih Kelompok --</option>'; 
    (list || []).forEach(it => sel.add(new Option(`${it.ID_Kelompok} - ${it.Nama_Kelompok}`, it.ID_Kelompok))); 
  }
  function populateProdiFilter(list, selectId) { 
    const sel = document.getElementById(selectId); 
    if (!sel) return;
    sel.innerHTML = '<option value="">Semua Unit</option>';
    (list || []).forEach(it => sel.add(new Option(`${it.ID_Prodi} - ${it.Nama_Prodi}`, it.ID_Prodi))); 
  }
  function populateKelompokFilter(list, selectId) { 
    const sel = document.getElementById(selectId); 
    if (!sel) return;
    sel.innerHTML = '<option value="">Semua Kelompok</option>'; 
    (list || []).forEach(it => sel.add(new Option(`${it.ID_Kelompok} - ${it.Nama_Kelompok}`, it.ID_Kelompok))); 
  }
  
  function populateProdiList(list) { 
    const container = document.getElementById('listProdi'); 
    if (!container) return;
    container.innerHTML = (list || []).map(p => { 
      const paguValue = p.Pagu_Anggaran || 0; 
      const baSettings = p.beritaAcaraSettings || {}; 
      
      const isProdiRole = p.Role === 'prodi';
      const paguInputHTML = isProdiRole 
        ? `<div class="input-group input-group-sm mt-2">
             <span class="input-group-text">Pagu Rp</span>
             <input type="number" class="form-control" id="pagu-input-${p.uid}" value="${paguValue}" min="0" placeholder="0">
             <button class="btn btn-outline-success" onclick="window.savePagu('${p.uid}')" title="Simpan Pagu"><i class="bi bi-save"></i></button>
           </div>`
        : `<div class="small text-muted mt-2 fst-italic">Role: Direktorat (Tanpa Pagu)</div>`;

      return `<div class="border p-2 mb-2 rounded-2">
                <div class="d-flex justify-content-between align-items-center">
                  <div>
                    <strong>${p.ID_Prodi}</strong> - ${escapeHtml(p.Nama_Prodi)}
                    <div class="small text-muted">${p.Email || ''}</div>
                  </div>
                  <div class="btn-group">
                    <button class="btn btn-sm btn-outline-secondary" onclick="window.fillEditProdi('${p.uid}','${p.ID_Prodi}','${escapeHtml(p.Nama_Prodi)}','${p.Email}','${p.Role}', '${escapeHtml(baSettings.TTD_Jabatan || '')}', '${escapeHtml(baSettings.TTD_Nama || '')}')" title="Edit Profil"><i class="bi bi-pencil"></i></button>
                    <button class="btn btn-sm btn-outline-danger" onclick="window.deleteUser('${p.uid}','${escapeHtml(p.ID_Prodi)}')" title="Hapus Profil"><i class="bi bi-trash"></i></button>
                  </div>
                </div>
                ${paguInputHTML} 
              </div>`; 
    }).join(''); 
  }

  function populateKelompokList(list) { 
    const container = document.getElementById('listKelompok'); 
    if(!container) return; container.innerHTML = (list || []).map(k => `<div class="border p-2 mb-2 rounded-2 d-flex justify-content-between align-items-center"><div><strong>${k.ID_Kelompok}</strong> - ${escapeHtml(k.Nama_Kelompok)}</div><div class="btn-group"><button class="btn btn-sm btn-outline-secondary" onclick="window.fillEditKelompok('${k.ID_Kelompok}','${escapeHtml(k.Nama_Kelompok)}')"><i class="bi bi-pencil"></i></button><button class="btn btn-sm btn-outline-danger" onclick="window.deleteKelompok('${k.ID_Kelompok}')" title="Hapus"><i class="bi bi-trash"></i></button></div></div>`).join(''); 
  }
  
  // --- NEW FUNCTION: Populate Grub Belanja List for Management UI ---
  function populateGrubBelanjaList(list) { 
    const container = document.getElementById('listGrubBelanja'); 
    if(!container) return; 
    
    // --- RLS Diagnostic Improvement ---
    if (!list || list.length === 0) {
        container.innerHTML = '<div class="text-center text-muted p-3">Tidak ada data Grub Belanja. Harap periksa RLS SELECT di Supabase jika tabel sudah terisi.</div>';
        return;
    }
    // ---------------------------------
    
    container.innerHTML = (list || []).map(g => `<div class="border p-2 mb-2 rounded-2 d-flex justify-content-between align-items-center"><div><strong>${g.ID_Grub}</strong> - ${escapeHtml(g.Nama_Grub)}</div><div class="btn-group"><button class="btn btn-sm btn-outline-secondary" onclick="window.fillEditGrubBelanja('${g.ID_Grub}','${escapeHtml(g.Nama_Grub)}')"><i class="bi bi-pencil"></i></button><button class="btn btn-sm btn-outline-danger" onclick="window.deleteGrubBelanja('${g.ID_Grub}')" title="Hapus"><i class="bi bi-trash"></i></button></div></div>`).join(''); 
  }

  // ------------------------------------------------------------------
  // --- START RENDER ACTIONS HELPER (FIXED FOR REFERENCE ERROR) ---
  // ------------------------------------------------------------------
/**
 * Memvalidasi apakah saat ini masih dalam periode pengajuan yang diizinkan.
 * @param {string} tipeAjuan - 'Awal' atau string yang mengandung 'Perubahan'
 * @returns {object} { allowed: boolean, message: string }
 */
function validateSubmissionDeadline(tipeAjuan) {
    // 1. Validasi Role: Hanya Unit yang dibatasi deadline (Direktorat bebas)
    if (STATE.role !== 'prodi') return { allowed: true };

    let deadlineConfig = null;
    let label = '';

    // 2. Tentukan Tanggal Batas berdasarkan Tipe
    if (tipeAjuan === 'Awal') {
        deadlineConfig = STATE.globalSettings.Batas_Tanggal_Pengajuan;
        label = 'Ajuan Awal';
    } else {
        // Asumsi semua tahap perubahan mengikuti satu tanggal deadline perubahan global
        deadlineConfig = STATE.globalSettings.Batas_Tanggal_Pengajuan_Perubahan;
        label = 'Ajuan Perubahan';
    }

    // Jika belum diatur direktorat, defaultnya DIIZINKAN (atau bisa diubah jadi dilarang)
    if (!deadlineConfig) return { allowed: true };

    // 3. Normalisasi Tanggal (Handle format Firebase Timestamp shim atau Date String)
    let deadlineDate;
    try {
        if (typeof deadlineConfig.toDate === 'function') {
            deadlineDate = deadlineConfig.toDate();
        } else {
            deadlineDate = new Date(deadlineConfig);
        }
    } catch (e) {
        console.error("Format tanggal tidak valid", e);
        return { allowed: true }; // Fallback jika error parsing
    }

    // 4. Set Deadline ke AKHIR HARI tersebut (23:59:59)
    // Agar jika deadline tgl 10, pengajuan tgl 10 jam 23:00 masih bisa masuk.
    deadlineDate.setHours(23, 59, 59, 999);

    const now = new Date();

    // 5. Cek Perbandingan
    if (now > deadlineDate) {
        const tglStr = deadlineDate.toLocaleDateString('id-ID', { 
            day: 'numeric', month: 'long', year: 'numeric' 
        });
        return {
            allowed: false,
            message: `Pengajuan ${label} DITUTUP. Batas waktu telah berakhir pada ${tglStr}.`
        };
    }

    return { allowed: true };
}
  /**
   * Generates action buttons HTML for an ajuan row.
   * @param {object} r Ajuan data row.
   * @param {string} tipe Tipe Ajuan (Awal or Perubahan X).
   * @returns {string} HTML string of buttons.
   */
  function renderActionsForRow(r, tipe) {
      const isProdi = STATE.role === 'prodi';
      const isDirektorat = STATE.role === 'direktorat';
      const status = r.Status;
      const ajuanId = String(r.ID_Ajuan); // Ensure string conversion here
      const ajuanNama = r.Nama_Ajuan;
      const isBlocked = !!r.Is_Blocked;

      let html = `<div class="btn-group btn-group-sm" role="group">`;
      
      // 1. History Button (Always visible)
      html += `<button class="btn btn-outline-secondary" onclick="window.openHistoryModal('${ajuanId}', '${escapeHtml(ajuanNama)}')"><i class="bi bi-clock-history"></i></button>`;

      // 2. Komentar Button (Always visible)
      html += `<button class="btn btn-outline-info" onclick="window.openKomentarModal('${ajuanId}', '${escapeHtml(ajuanNama)}')" title="Komentar"><i class="bi bi-chat-dots"></i></button>`;

      // --- PRODI Actions ---
      if (isProdi) {
          // PRODI can edit/delete if status is Review, Revisi, or Ditolak (to fix and resubmit)
          if (status === 'Menunggu Review' || status === 'Revisi' || status === 'Ditolak') {
              // Edit/Delete for pending or revised items
              html += `<button class="btn btn-outline-primary" onclick="window.openEditModal('${ajuanId}')" title="Edit"><i class="bi bi-pencil"></i></button>`;
              html += `<button class="btn btn-outline-danger" onclick="window.deleteAjuan('${ajuanId}', '${tipe}')" title="Hapus"><i class="bi bi-trash"></i></button>`;
          } else if (status === 'Diterima') {
              html += `<button class="btn btn-outline-success disabled" title="Diterima, tidak dapat diubah"><i class="bi bi-check-lg"></i></button>`;
          }
      }

      // --- DIREKTORAT Actions (Review/Status Change) ---
      if (isDirektorat) {
          // Edit button for Direktorat
          html += `<button class="btn btn-outline-primary" onclick="window.openEditModal('${ajuanId}')" title="Edit Rincian"><i class="bi bi-pencil"></i></button>`;

          // Review Actions
          if (status === 'Menunggu Review' || status === 'Revisi') {
              html += `<button class="btn btn-success" onclick="window.openReviewModal('${ajuanId}', 'Diterima', '${tipe}', '${status}')" title="Terima"><i class="bi bi-check2-square"></i></button>`;
              html += `<button class="btn btn-warning" onclick="window.openReviewModal('${ajuanId}', 'Revisi', '${tipe}', '${status}')" title="Minta Revisi"><i class="bi bi-arrow-counterclockwise"></i></button>`;
              html += `<button class="btn btn-danger" onclick="window.openReviewModal('${ajuanId}', 'Ditolak', '${tipe}', '${status}')" title="Tolak"><i class="bi bi-x-square"></i></button>`;
          } else if (status === 'Diterima' || status === 'Ditolak') {
               // Allow changing status back if needed
              html += `<button class="btn btn-info" onclick="window.openReviewModal('${ajuanId}', 'Menunggu Review', '${tipe}', '${status}')" title="Kembalikan ke Review"><i class="bi bi-arrow-left-square"></i></button>`;
          }
          
          // Block/Unblock toggle
          if (status === 'Diterima') {
              const blockAction = isBlocked ? 'Buka Blokir' : 'Blokir';
              const blockIcon = isBlocked ? 'bi-lock-open' : 'bi-lock';
              const blockClass = isBlocked ? 'btn-outline-warning' : 'btn-outline-dark';
              html += `<button class="btn ${blockClass} ms-2" onclick="window.toggleBlockAjuan('${ajuanId}', ${!isBlocked}, '${tipe}')" title="${blockAction} (Hapus dari RPD/Realisasi)"><i class="bi ${blockIcon}"></i></button>`;
          }
      }

      html += `</div>`;
      return html;
  }
   // --- TAMBAHAN: PIMPINAN TIDAK PUNYA AKSI ---
    if (STATE.role === 'pimpinan') {
        // Hanya tampilkan tombol History & Komentar (Read Only)
        let html = `<div class="btn-group btn-group-sm" role="group">`;
        html += `<button class="btn btn-outline-secondary" onclick="window.openHistoryModal('${r.ID_Ajuan}', '${escapeHtml(r.Nama_Ajuan)}')"><i class="bi bi-clock-history"></i></button>`;
        html += `<button class="btn btn-outline-info" onclick="window.openKomentarModal('${r.ID_Ajuan}', '${escapeHtml(r.Nama_Ajuan)}')" title="Lihat Komentar"><i class="bi bi-chat-dots"></i></button>`;
        html += `</div>`;
        return html;
    }
    // ------------------------------------------

  // ------------------------------------------------------------------
  // --- END RENDER ACTIONS HELPER ---
  // ------------------------------------------------------------------
  
  // Helper function to format the calculation breakdown for display
  function formatBreakdown(r) {
      // Check if the new calculation fields exist (for compatibility with old data)
      if (r.calcA1 === undefined || r.calcA1 === null) {
          // Fallback to old format (or standard single Quantity x Price display)
          const jumlah = Number(r.Jumlah || 0);
          const harga = Number(r.Harga_Satuan || 0);
          const satuan = escapeHtml(r.Satuan || '');
          return `<div class="small text-nowrap">${jumlah.toLocaleString('id-ID', { maximumFractionDigits: 2 })} ${satuan} X Rp ${harga.toLocaleString('id-ID')}</div>`;
      }
      
      let volumeBreakdown = [];
      for (let i = 1; i <= 3; i++) {
          const a = Number(r[`calcA${i}`]);
          const s = escapeHtml(r[`calcS${i}`] || '');
          if (a > 0) volumeBreakdown.push(`${a.toLocaleString('id-ID', { maximumFractionDigits: 2 })} ${s}`);
      }
      
      let costBreakdown = [];
      for (let i = 4; i <= 6; i++) {
          const a = Number(r[`calcA${i}`]);
          const s = escapeHtml(r[`calcS${i}`] || '');
          if (a > 0) costBreakdown.push(`${a.toLocaleString('id-ID', { maximumFractionDigits: 2 })} ${s}`);
      }
      
      const jumlah = Number(r.Jumlah || 0);
      const harga = Number(r.Harga_Satuan || 0);
      const satuan = escapeHtml(r.Satuan || '');
      
      return `
<div class="small text-muted mb-1" style="display:none" title="Volume Breakdown"> ${volumeBreakdown.join(' x ') || '1'} </div>
<div class="small text-muted mb-1" style="display:none" title="Harga Satuan Breakdown"> ${costBreakdown.join(' x ') || '1'} </div>

          <strong class="text-nowrap">${jumlah.toLocaleString('id-ID', { maximumFractionDigits: 2 })} ${satuan} X Rp ${harga.toLocaleString('id-ID')}</strong>
      `;
  }
  
  // --- MIGRATED TO SUPABASE: refreshAjuanTable (Ajuan Fetching) ---
   function refreshAjuanTable(tipe) {
    const isPerubahan = tipe.startsWith('Perubahan');
    const tableId = isPerubahan ? `tableAjuanPerubahan` : `tableAjuanAwal`;
    const summaryId = isPerubahan ? `summary-display-perubahan` : `summary-display-awal`;

    // Ambil Tahap Perubahan Aktif dari global settings
    const tahapAktif = STATE.globalSettings.Tahap_Perubahan_Aktif || 1;
    const currentTipe = isPerubahan ? `Perubahan ${tahapAktif}` : 'Awal';
    
    // KRITIS: Tentukan nama tabel yang akan di-query
    const targetTableName = getAjuanTableName(currentTipe);
    
    // Perbarui STATE.currentAjuanType
    STATE.currentAjuanType = currentTipe;
    
    const tableContainer = document.getElementById(tableId);
    if (!tableContainer) return;

    showLoader(true);
    tableContainer.innerHTML = `<div class="text-center text-muted p-5">Memuat data...</div>`;
    
    const summaryEl = document.getElementById(summaryId);
    if(summaryEl) summaryEl.style.display = 'none';

    if (isPerubahan) {
        STATE.selectedAjuanIdsPerubahan.clear();
        updateBulkActionBar('Perubahan');
    } else {
        STATE.selectedAjuanIdsAwal.clear();
        updateBulkActionBar('Awal');
    }
    
    try {
        // Gantilah .select('*') dengan daftar panjang ini:
let query = sb.from(targetTableName)
    .select(`
        ID_Ajuan,
        ID_Ajuan_Asal,
        ID_Prodi,
        Nama_Ajuan,
        Judul_Kegiatan,
        Grub_Belanja_Utama,
        ID_Kelompok,
        Total,
        Status,
        Is_Blocked,
        Tipe_Ajuan,
        Status_Revisi,
        Data_Dukung,
        Catatan_Reviewer,
        Jumlah,
        Satuan,
        Harga_Satuan,
        Timestamp,
        calcA1, calcS1, calcA2, calcS2, calcA3, calcS3, 
        calcA4, calcS4, calcA5, calcS5, calcA6, calcS6
    `) // <-- Perhatikan: Kolom 'Komentar' DIHAPUS agar ringan
    .eq('Tipe_Ajuan', currentTipe); // <-- REF ACT

        // Use getSafeValue for filter elements in case they are hidden/missing
        const prodiFilter = getSafeValue(isPerubahan ? 'filterProdiPerubahan' : 'filterProdiAwal');
        if (STATE.role === 'prodi') {
            query = query.eq('ID_Prodi', STATE.id);
        } else if (prodiFilter) {
            query = query.eq('ID_Prodi', prodiFilter);
        }
        
        const grubFilter = getSafeValue(isPerubahan ? `filterGrubPerubahan` : `filterGrubAwal`);
        if (grubFilter) query = query.eq('Grub_Belanja_Utama', grubFilter);
        
        const kelompokFilter = getSafeValue(isPerubahan ? `filterKelompokPerubahan` : `filterKelompokAwal`);
        if(kelompokFilter) query = query.eq('ID_Kelompok', kelompokFilter);

        const statusFilter = getSafeValue(isPerubahan ? `filterStatusPerubahan` : `filterStatusAwal`);
        if (statusFilter) query = query.eq('Status', statusFilter);
        
        // Execute the query
        query.order('Timestamp', { ascending: false }).then(async ({ data: ajuanDataRaw, error }) => {
            if (error) throw error;
            
            let ajuanData = ajuanDataRaw.map(data => {
                // Convert timestamp string to Date object
                if (data.Timestamp) data.Timestamp = new Date(data.Timestamp);
                if (data.Is_Blocked === undefined) data.Is_Blocked = false; 

                // FIX: Ensure ID_Ajuan and ID_Ajuan_Asal are explicitly strings
                data.ID_Ajuan = String(data.ID_Ajuan || data.id);
                if (data.ID_Ajuan_Asal) data.ID_Ajuan_Asal = String(data.ID_Ajuan_Asal);
                
                // PENTING: Pastikan Total selalu ada sebagai angka, meskipun 0
                data.Total = Number(data.Total) || 0; 
                
                return data;
            });
            
            // ajuanData is already sorted by Supabase query

            if (isPerubahan) {
                STATE.currentAjuanDataPerubahan = ajuanData; 
                const asalIds = [...new Set(ajuanData.map(d => d.ID_Ajuan_Asal).filter(Boolean))];
                const originalDataMap = new Map();

                // KRITIS: Tentukan nama tabel asal (Awal atau Perubahan sebelumnya)
                const tahapSebelumnya = tahapAktif - 1;
                const originalTipe = tahapSebelumnya === 0 ? 'Awal' : `Perubahan ${tahapSebelumnya}`;
                const originalTableName = getAjuanTableName(originalTipe);

                if (asalIds.length > 0) {
                    // Fetch all original documents from the correct previous table
                    const { data: originalData, error: originalError } = await sb.from(originalTableName) // <-- REF ACT
                        .select('*')
                        .in('ID_Ajuan', asalIds);
                    
                    if (originalError) console.warn('Error fetching original ajuan:', originalError);

                    (originalData || []).forEach(doc => {
                        // Ensure original IDs are also treated as strings in the map keys
                        originalDataMap.set(String(doc.ID_Ajuan || doc.id), doc);
                    });
                    
                    renderAjuanTable(ajuanData, currentTipe, originalDataMap);
                    showLoader(false);
                    
                } else {
                    renderAjuanTable(ajuanData, currentTipe);
                    showLoader(false);
                }
            } else { // 'Awal'
                STATE.currentAjuanDataAwal = ajuanData; 
                renderAjuanTable(ajuanData, currentTipe);
                showLoader(false);
            }
        }).catch(error => {
            console.error(`Error getting ajuan ${tipe} (Supabase, Table: ${targetTableName}):`, error);
            showToast(`Gagal memuat data ajuan ${tipe.toLowerCase()}.`, "danger");
            if (tableContainer) tableContainer.innerHTML = '<div class="text-center text-danger p-5">Gagal memuat data. Periksa konsol untuk detail error.</div>';
            showLoader(false);
        });
        
    } catch (error) {
        console.error(`Error during query setup (Supabase):`, error);
        showToast(`Gagal memuat data ajuan ${tipe.toLowerCase()}.`, "danger");
        if (tableContainer) tableContainer.innerHTML = '<div class="text-center text-danger p-5">Gagal memuat data.</div>';
        showLoader(false);
    }
  }
  

  safeAddClickListener('btn-refresh-awal', () => refreshAjuanTableAwal(true));
  ['filterStatusAwal', 'filterProdiAwal', 'filterKelompokAwal', 'filterGrubAwal'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => {
          STATE.currentAjuanDataAwal = []; 
          refreshAjuanTableAwal(true);
      });
  });
  
  safeAddClickListener('btn-refresh-perubahan', () => refreshAjuanTablePerubahan(true));
  ['filterStatusPerubahan', 'filterProdiPerubahan', 'filterKelompokPerubahan', 'filterGrubPerubahan'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => {
          STATE.currentAjuanDataPerubahan = []; 
          refreshAjuanTablePerubahan(true);
      });
  });
  
  const tabDaftarAwal = document.querySelector('[data-bs-target="#tab-daftar-awal"]');
  if (tabDaftarAwal) {
      tabDaftarAwal.addEventListener('shown.bs.tab', () => refreshAjuanTableAwal(false));
  }
  
  const tabDaftarPerubahan = document.querySelector('[data-bs-target="#tab-daftar-perubahan"]');
  if (tabDaftarPerubahan) {
      tabDaftarPerubahan.addEventListener('shown.bs.tab', () => refreshAjuanTablePerubahan(false));
  }
  
  // --- MIGRATED TO SUPABASE: toggleBlockAjuan (MODIFIED) ---
  window.toggleBlockAjuan = async (id, blockStatus, tipe) => {
      const ajuanId = String(id);
      const actionText = blockStatus ? 'Blokir' : 'Buka Blokir';
      if (!confirm(`Yakin ingin ${actionText.toLowerCase()} ajuan ID: ${ajuanId}? Ajuan yang diblokir tidak akan dimasukkan dalam perhitungan RPD dan Realisasi, meskipun statusnya Diterima.`)) {
          return;
      }
      
      const targetTableName = getAjuanTableName(tipe); // <-- REF ACT: Tentukan tabel tujuan

      showLoader(true);
      try {
          // 1. Fetch current ajuan data to get Prodi ID
          const { data: ajuan, error: fetchError } = await sb.from(targetTableName).select('ID_Prodi').eq('ID_Ajuan', ajuanId).maybeSingle(); // <-- REF ACT
          if (fetchError || !ajuan) throw new Error("Ajuan tidak ditemukan.");
          const prodiId = ajuan.ID_Prodi;

          // 2. Supabase Update
          const { error } = await sb.from(targetTableName) // <-- REF ACT
              .update({ Is_Blocked: blockStatus })
              .eq('ID_Ajuan', ajuanId);

          if (error) throw error;
          
          await logActivity('Toggle Block Ajuan', `${actionText} ajuan ID: ${ajuanId} (${tipe}) di tabel ${targetTableName}.`);
          logHistory(ajuanId, `Ajuan ${blockStatus ? 'Diblokir' : 'Dibuka Blokir'}`, `Status blokir diubah menjadi ${blockStatus} di tabel ${targetTableName}.`);

          showToast(`Ajuan ${ajuanId.substring(0,6)}.. berhasil di${blockStatus ? 'blokir' : 'buka blokir'}.`);
          
          // --- Trigger Recalculation ---
          await recalculateProdiSummary(prodiId);
          // --- End Trigger ---

          if(tipe.startsWith('Awal')) refreshAjuanTableAwal(true); else refreshAjuanTablePerubahan(true);
          loadDashboardData(true); 

      } catch(error) { 
          showToast(`Gagal ${actionText.toLowerCase()}: ${error.message}`, 'danger'); 
      } finally { 
          showLoader(false); 
      }
  };


  function renderAjuanTable(rows, tipe, originalDataMap = null) {
    const isPerubahan = tipe.startsWith('Perubahan');
    const tableId = isPerubahan ? `tableAjuanPerubahan` : `tableAjuanAwal`;
    const summaryId = isPerubahan ? `summary-display-perubahan` : `summary-display-awal`;

    const container = document.getElementById(tableId);

    
    if (!container) return;
    const sanitizedTipe = sanitizeTipeForCSS(tipe);

    if (rows.length === 0) { 
        container.innerHTML = '<div class="text-center text-muted p-5">Belum ada ajuan.</div>'; 
        const summaryEl = document.getElementById(summaryId);
        if (summaryEl) summaryEl.style.display = 'none'; 
        return; 
    }
    
    let grandTotal = 0, acceptedTotal = 0, rejectedTotal = 0;
    
    // START: Logic for Perubahan Table Summary (Including Selisih)
    let totalSelisih = 0;
    if (isPerubahan) {
        rows.forEach(r => {
            const original = originalDataMap && r.ID_Ajuan_Asal && originalDataMap.has(r.ID_Ajuan_Asal) ? originalDataMap.get(r.ID_Ajuan_Asal) : {};
            const totalLama = Number(original.Total) || 0;
            const totalBaru = Number(r.Total) || 0;
            const selisih = totalBaru - totalLama;
            totalSelisih += selisih;
            
            const totalValue = Number(r.Total) || 0; 
            grandTotal += totalValue; 
            
            // Accepted total excludes blocked items
            if (r.Status === 'Diterima' && !r.Is_Blocked) acceptedTotal += totalValue; 
            else if (r.Status === 'Ditolak') rejectedTotal += totalValue; 
        });
    } else {
         rows.forEach(r => { 
            const totalValue = Number(r.Total) || 0; 
            grandTotal += totalValue; 
            
            // Accepted total excludes blocked items
            if (r.Status === 'Diterima' && !r.Is_Blocked) acceptedTotal += totalValue; 
            else if (r.Status === 'Ditolak') rejectedTotal += totalValue; 
        });
    }

    const summaryContainer = document.getElementById(summaryId);
    if(summaryContainer) {
        let summaryHtml = `<div><strong>Total Diajukan:</strong> Rp ${grandTotal.toLocaleString('id-ID')}</div><div><strong class="text-success">Total Diterima (Bersih):</strong> Rp ${acceptedTotal.toLocaleString('id-ID')}</div><div><strong class="text-danger">Total Ditolak:</strong> Rp ${rejectedTotal.toLocaleString('id-ID')}</div>`;
        
        if (isPerubahan) {
            const selisihClass = totalSelisih >= 0 ? 'text-success' : 'text-danger';
            summaryHtml += `<div><strong class="${selisihClass}">Total Selisih:</strong> Rp ${totalSelisih.toLocaleString('id-ID')}</div>`;
            
            if (STATE.role === 'direktorat') {
                const selisihByProdi = {};
                rows.forEach(r => {
                    const prodiId = r.ID_Prodi;
                    const original = originalDataMap && r.ID_Ajuan_Asal && originalDataMap.has(r.ID_Ajuan_Asal) ? originalDataMap.get(r.ID_Ajuan_Asal) : {};
                    const totalLama = Number(original.Total) || 0;
                    const totalBaru = Number(r.Total) || 0;
                    const selisih = totalBaru - totalLama;
                    selisihByProdi[prodiId] = (selisihByProdi[prodiId] || 0) + selisih;
                });
                
                const prodiSelisihHtml = Object.keys(selisihByProdi).map(prodiId => {
                    const selisihVal = selisihByProdi[prodiId];
                    const cls = selisihVal >= 0 ? 'text-success' : 'text-danger';
                    return `<span class="me-2"><span class="badge bg-light text-dark fw-normal">${prodiId}</span> <strong class="${cls}">Rp ${selisihVal.toLocaleString('id-ID')}</strong></span>`;
                }).join('');
                
                summaryHtml += `<div class="mt-2 pt-2 border-top w-100"><strong class="d-block small text-muted">Selisih Per Unit:</strong> ${prodiSelisihHtml}</div>`;
            }
        }
        
        summaryContainer.innerHTML = summaryHtml;
        summaryContainer.style.display = 'flex';
    }
    // END: Logic for Perubahan Table Summary
    
    // Status classes definition
    const statusClassMap = { 
        "Menunggu Review": "status-menunggu-review", 
        "Diterima": "status-diterima", 
        "Ditolak": "status-ditolak", 
        "Revisi": "status-revisi",
        "Blocked": "status-diblokir" 
    };

    if (isPerubahan) {
        let html = `<table class="table table-hover align-middle" id="table-export-${sanitizedTipe}" style="min-width: 2200px;"><thead class="table-light"><tr>
                        <th style="width: 30px;" rowspan="2" class="align-middle"><input type="checkbox" id="select-all-ajuan-${sanitizedTipe}" title="Pilih Semua"></th>
                        <th colspan="3" class="text-center bg-secondary-subtle">SEMULA</th>
                        <th colspan="3" class="text-center bg-light">MENJADI</th>
                        <th rowspan="2" class="align-middle text-end" style="min-width: 120px;">Selisih</th>
                        <th rowspan="2" class="align-middle text-center action-buttons">Dakung</th>
                        <th rowspan="2" class="align-middle" style="min-width: 140px;">Status</th>
                        <th rowspan="2" class="align-middle" style="min-width: 200px;">Catatan Reviewer</th>
                        <th rowspan="2" class="align-middle text-end action-buttons" style="min-width: 280px;">Aksi</th>
                      </tr>
                      <tr class="table-light">
                        <th style="min-width: 250px;">Rincian Ajuan (Lama)</th>
                        <th style="min-width: 200px;">Detail Kuantitas (Lama)</th>
                        <th class="text-end" style="min-width: 130px;">Total Biaya (Lama)</th>
                        <th style="min-width: 250px;">Rincian Ajuan (Baru)</th>
                        <th style="min-width: 200px;">Detail Kuantitas (Baru)</th>
                        <th class="text-end" style="min-width: 130px;">Total Biaya (Baru)</th>
                      </tr>
                    </thead><tbody>`;
        
        const groupedData = rows.reduce((acc, row) => {
            const grubKey = row.Grub_Belanja_Utama || 'Lain-lain'; const kelompokId = row.ID_Kelompok || 'Lain-lain';
            const namaKelompok = (STATE.allKelompok.find(k => k.ID_Kelompok === kelompokId) || {}).Nama_Kelompok || 'Lain-lain';
            const kelompokKey = `${kelompokId} - ${namaKelompok}`; const kegiatanKey = row.Judul_Kegiatan || 'Tanpa Judul';
            if (!acc[grubKey]) acc[grubKey] = {}; if (!acc[grubKey][kelompokKey]) acc[grubKey][kelompokKey] = {}; if (!acc[grubKey][kelompokKey][kegiatanKey]) acc[grubKey][kelompokKey][kegiatanKey] = [];
            acc[grubKey][kelompokKey][kegiatanKey].push(row); return acc;
        }, {});

        const sortedGrubKeys = Object.keys(groupedData).sort();
        const prodiNameMap = STATE.allProdi.reduce((acc, prodi) => { acc[prodi.ID_Prodi] = prodi.Nama_Prodi; return acc; }, {});
        
        sortedGrubKeys.forEach(grubKey => {
          html += `<tr class="group-header-grub"><td colspan="12" class="fw-bold"><i class="bi bi-folder-fill"></i> ${escapeHtml(grubKey)}</td></tr>`;
          const sortedKelompokKeys = Object.keys(groupedData[grubKey]).sort();
          sortedKelompokKeys.forEach(kelompokKey => {
              html += `<tr class="group-header-kelompok"><td colspan="12" class="fw-bold ps-4"><i class="bi bi-tags-fill"></i> Kelompok: ${escapeHtml(kelompokKey)}</td></tr>`;
              const sortedKegiatanKeys = Object.keys(groupedData[grubKey][kelompokKey]).sort();
              sortedKegiatanKeys.forEach(kegiatanKey => {
                  html += `<tr class="group-header-kegiatan"><td colspan="12" class="fw-bold ps-5"><i class="bi bi-collection-fill text-secondary"></i> Kegiatan: ${escapeHtml(kegiatanKey)}</td></tr>`;
                  groupedData[grubKey][kelompokKey][kegiatanKey].forEach(r => {
                      const ajuanIdString = String(r.ID_Ajuan);
                      const original = originalDataMap && r.ID_Ajuan_Asal && originalDataMap.has(r.ID_Ajuan_Asal) ? originalDataMap.get(r.ID_Ajuan_Asal) : {};
const totalLama = Number(original.Total) || 0; 
const totalBaru = Number(r.Total) || 0;
const selisih = totalBaru - totalLama;

                      const selisihClass = selisih > 0 ? 'text-success' : (selisih < 0 ? 'text-danger' : '');
                      const selisihText = selisih > 0 ? `+${selisih.toLocaleString('id-ID')}` : selisih.toLocaleString('id-ID');
                      const dataDukungLink = r.Data_Dukung ? `<a href="${escapeHtml(r.Data_Dukung)}" target="_blank" class="btn btn-sm btn-outline-secondary" title="Lihat"><i class="bi bi-box-arrow-up-right"></i></a>` : `<span class="text-muted small fst-italic">N/A</span>`;
                      const prodiColor = getColorForProdi(r.ID_Prodi);
                      const prodiNama = prodiNameMap[r.ID_Prodi] || r.ID_Prodi;
                      const prodiInfoHtml = STATE.role === 'direktorat' ? `<div class="small text-muted">Oleh: <strong>${escapeHtml(prodiNama)}</strong></div>` : '';
                      const idAjuanAsal = r.ID_Ajuan_Asal ? `<span class="badge bg-light text-dark fw-normal fst-italic">Asal: ${String(r.ID_Ajuan_Asal).substring(0, 6)}..</span>` : ''; // Corrected variable name
                      
                      const isBlocked = !!r.Is_Blocked;
                      const statusKey = isBlocked ? "Blocked" : r.Status;
                      const rowClass = isBlocked ? 'blocked-row' : ''; 
                      const statusBadgeText = isBlocked && r.Status === 'Diterima' ? `Diterima (BLOKIR)` : (isBlocked ? `${r.Status} (BLOKIR)` : r.Status);
                      
                      html += `<tr class="prodi-indicator ${rowClass}" style="border-left-color: ${prodiColor};">
                                  <td><input type="checkbox" class="ajuan-checkbox-${sanitizedTipe}" data-id="${ajuanIdString}"></td>
                                  <td class="bg-secondary-subtle"><small>${escapeHtml(original.Nama_Ajuan || 'N/A')}</small></td>
                                  <td class="bg-secondary-subtle">${formatBreakdown(original)}</td>
                                  <td class="text-end bg-secondary-subtle"><small>Rp ${totalLama.toLocaleString('id-ID')}</small></td>
                                  <td><div class="d-flex justify-content-between align-items-start"><strong class="me-2">${escapeHtml(r.Nama_Ajuan)}</strong><span class="badge bg-secondary-subtle text-secondary-emphasis fw-normal text-nowrap">${ajuanIdString.substring(0, 6)}..</span></div>${prodiInfoHtml}<div class="mt-1"><span class="badge bg-info-subtle text-info-emphasis fw-normal">${escapeHtml(r.Status_Revisi || 'Ajuan Baru')}</span> ${idAjuanAsal}</div></td>
                                  <td>${formatBreakdown(r)}</td>
                                  <td class="text-end text-nowrap"><strong>Rp ${totalBaru.toLocaleString('id-ID')}</strong></td>
                                  <td class="text-end text-nowrap fw-bold ${selisihClass}">${selisihText}</td>
                                  <td class="text-center action-buttons">${dataDukungLink}</td>
                                  <td><span class="badge rounded-pill status-badge ${statusClassMap[statusKey] || statusClassMap[r.Status] || 'bg-secondary'}">${statusBadgeText}</span></td>
                                  <td class="text-end action-buttons">${renderActionsForRow(r, tipe)}</td>
                              </tr>`;
                  });
              });
          });
        });
        container.innerHTML = html + '</tbody></table>';
    } else { // This is for tipe === 'Awal'
        const groupedData = rows.reduce((acc, row) => {
            const grubKey = row.Grub_Belanja_Utama || 'Lain-lain'; const kelompokId = row.ID_Kelompok || 'Lain-lain';
            const namaKelompok = (STATE.allKelompok.find(k => k.ID_Kelompok === kelompokId) || {}).Nama_Kelompok || 'Lain-lain';
            const kelompokKey = `${kelompokId} - ${namaKelompok}`; const kegiatanKey = row.Judul_Kegiatan || 'Tanpa Judul';
            if (!acc[grubKey]) acc[grubKey] = {}; if (!acc[grubKey][kelompokKey]) acc[grubKey][kelompokKey] = {}; if (!acc[grubKey][kelompokKey][kegiatanKey]) acc[grubKey][kelompokKey][kegiatanKey] = [];
            acc[grubKey][kelompokKey][kegiatanKey].push(row); return acc;
        }, {});
        const sortedGrubKeys = Object.keys(groupedData).sort(); // FIX: grubKey was undefined in this scope
        const prodiNameMap = STATE.allProdi.reduce((acc, prodi) => { acc[prodi.ID_Prodi] = prodi.Nama_Prodi; return acc; }, {});
        let html = `<table class="table table-hover align-middle" id="table-export-${sanitizedTipe}" style="min-width: 1350px;"><thead class="table-light"><tr><th style="width: 30px;"><input type="checkbox" id="select-all-ajuan-${sanitizedTipe}"></th><th style="min-width: 250px;">Rincian Ajuan</th><th style="min-width: 200px;">Detail Kuantitas</th><th class="text-end" style="min-width: 130px;">Total Biaya</th><th class="text-center action-buttons">Dakung</th><th style="min-width: 140px;">Status</th><th style="min-width: 200px;">Catatan Reviewer</th><th class="text-end action-buttons" style="min-width: 280px;">Aksi</th></tr></thead><tbody>`;
        sortedGrubKeys.forEach(grubKey => {
          html += `<tr class="group-header-grub"><td colspan="8" class="fw-bold"><i class="bi bi-folder-fill"></i> ${escapeHtml(grubKey)}</td></tr>`;
          const sortedKelompokKeys = Object.keys(groupedData[grubKey]).sort();
          sortedKelompokKeys.forEach(kelompokKey => {
              const sortedKegiatanKeys = Object.keys(groupedData[grubKey][kelompokKey]).sort();
              html += `<tr class="group-header-kelompok"><td colspan="8" class="fw-bold ps-4"><i class="bi bi-tags-fill"></i> Kelompok: ${escapeHtml(kelompokKey)}</td></tr>`;
              sortedKegiatanKeys.forEach(kegiatanKey => {
                  html += `<tr class="group-header-kegiatan"><td colspan="8" class="fw-bold ps-5"><i class="bi bi-collection-fill text-secondary"></i> Kegiatan: ${escapeHtml(kegiatanKey)}</td></tr>`;
                  groupedData[grubKey][kelompokKey][kegiatanKey].forEach(r => {
                      const ajuanIdString = String(r.ID_Ajuan);
                      const dataDukungLink = r.Data_Dukung ? `<a href="${escapeHtml(r.Data_Dukung)}" target="_blank" class="btn btn-sm btn-outline-secondary" title="Lihat"><i class="bi bi-box-arrow-up-right"></i></a>` : `<span class="text-muted small fst-italic">N/A</span>`;
                      const prodiColor = getColorForProdi(r.ID_Prodi);
                      const prodiNama = prodiNameMap[r.ID_Prodi] || r.ID_Prodi;
                      const prodiInfoHtml = STATE.role === 'direktorat' ? `<div class="small text-muted">Oleh: <strong>${escapeHtml(prodiNama)}</strong></div>` : '';
                      const idAjuanAsal = r.ID_Ajuan_Asal ? `<span class="badge bg-light text-dark fw-normal fst-italic">Asal: ${String(r.ID_Ajuan_Asal).substring(0, 6)}..</span>` : '';
                      
                      const isBlocked = !!r.Is_Blocked;
                      const statusKey = isBlocked ? "Blocked" : r.Status;
                      const rowClass = isBlocked ? 'blocked-row' : ''; 
                      const statusBadgeText = isBlocked && r.Status === 'Diterima' ? `Diterima (BLOKIR)` : (isBlocked ? `${r.Status} (BLOKIR)` : r.Status);

                      html += `<tr class="prodi-indicator ${rowClass}" style="border-left-color: ${prodiColor};"><td><input type="checkbox" class="ajuan-checkbox-${sanitizedTipe}" data-id="${ajuanIdString}"></td><td><div class="d-flex justify-content-between align-items-start"><strong class="me-2">${escapeHtml(r.Nama_Ajuan)}</strong><span class="badge bg-secondary-subtle text-secondary-emphasis fw-normal text-nowrap">${ajuanIdString.substring(0, 6)}..</span></div>${prodiInfoHtml}<div class="mt-1"><span class="badge bg-info-subtle text-info-emphasis fw-normal">${escapeHtml(r.Status_Revisi || 'Ajuan Baru')}</span> ${idAjuanAsal}</div></td><td>${formatBreakdown(r)}</td><td class="text-end text-nowrap"><strong>Rp ${Number(r.Total).toLocaleString('id-ID')}</strong></td><td class="text-center action-buttons">${dataDukungLink}</td><td><span class="badge rounded-pill status-badge ${statusClassMap[statusKey] || statusClassMap[r.Status] || 'bg-secondary'}">${statusBadgeText}</span></td><td><small class="text-muted fst-italic">${escapeHtml(r.Catatan_Reviewer || '')}</small></td><td class="text-end action-buttons">${renderActionsForRow(r, tipe)}</td></tr>`;
                  });
              });
          });
        });
        container.innerHTML = html + '</tbody></table>'; 
    }
    addCheckboxListeners(tipe);
  }

  window.openEditModal = async (id) => {
    const ajuanId = String(id);
    showLoader(true);
    try {
        // Tentukan tipe ajuan saat ini dari STATE atau fallback ke 'Awal'
        const tipeAjuan = STATE.currentAjuanType || 'Awal';
        const targetTableName = getAjuanTableName(tipeAjuan); // <-- REF ACT
        
        // Supabase Query
        const { data: ajuan, error } = await sb.from(targetTableName).select('*').eq('ID_Ajuan', ajuanId).maybeSingle(); // <-- REF ACT
        if (error || !ajuan) throw new Error("Ajuan tidak ditemukan atau gagal dimuat.");
        const r = ajuan;

        setElValue('edit-id-ajuan', ajuanId);
        document.getElementById('editModalAjuanId').innerText = ajuanId.substring(0, 6) + '...';
        setElValue('edit-tipeAjuan', r.Tipe_Ajuan || 'Awal');
        setElValue('edit-judulKegiatan', r.Judul_Kegiatan); 
        setElValue('edit-namaAjuan', r.Nama_Ajuan);
        setElValue('edit-selectGrub', r.Grub_Belanja_Utama); 
        setElValue('edit-selectKelompok', r.ID_Kelompok);
        setElValue('edit-selectRevisi', r.Status_Revisi || 'Ajuan Baru'); 
        setElValue('edit-dataDukung', r.Data_Dukung || ''); 
        
        // --- NEW: Populate Calculation Inputs (dikosongkan/disembunyikan) ---
        for (let i = 1; i <= 6; i++) {
            // Populate numerical fields (A) 
            const a_value = (r[`calcA${i}`] === null || r[`calcA${i}`] === undefined) ? '' : r[`calcA${i}`];
            setElValue(`edit-calcA${i}`, a_value); 
            // Populate unit fields (S)
            setElValue(`edit-calcS${i}`, r[`calcS${i}`] || '');
        }
        
        // ********* KRITIS: Set fields directly from DB *********
        // Populasikan Jumlah, Satuan, Harga Satuan, Total
        setElValue('edit-jumlah', r.Jumlah ? Number(r.Jumlah).toLocaleString('id-ID', { maximumFractionDigits: 2 }) : '0'); 
        setElValue('edit-satuan', r.Satuan); 
        setElValue('edit-hargaSatuan', r.Harga_Satuan ? Number(r.Harga_Satuan).toLocaleString('id-ID', { maximumFractionDigits: 0 }) : '0'); 
        setElValue('edit-total', r.Total ? Number(r.Total).toLocaleString('id-ID', { maximumFractionDigits: 0 }) : '0'); 
        
        // Panggil fungsi hitungTotalAjuan('edit-') untuk memastikan Total terformat dan terhitung ulang jika ada input yang diubah.
        hitungTotalAjuan('edit-');

        // ****************************************************************************

        setElValue('edit-keterangan', r.Keterangan); 
        
        const editModalEl = document.getElementById('editAjuanModal');
        if (editModalEl) {
            const modal = bootstrap.Modal.getOrCreateInstance(editModalEl);
            modal.show();
        }
    } catch (error) { showToast(`Gagal memuat data edit: ${error.message}`, 'danger'); } finally { showLoader(false); }
  };
  
  // --- MIGRATED TO SUPABASE: Ajuan Update (MODIFIED) ---
  document.getElementById('btn-update-ajuan').addEventListener('click', async () => {
    const idAjuan = getElValue('edit-id-ajuan');
    const tipeAjuan = getElValue('edit-tipeAjuan'); // Akan berisi 'Awal' atau 'Perubahan X'
    const targetTableName = getAjuanTableName(tipeAjuan); // <-- REF ACT
    showLoader(true);

    let prodiId = null;

    try {
        // 1. Perform simple calculation and get results from visible fields
        const calcResults = hitungTotalAjuan('edit-');
        const newTotal = calcResults.total;
        
        // Use getSafeValue for less critical inputs
        const newSatuan = getSafeValue('edit-satuan').trim();
        const newNamaAjuan = getSafeValue('edit-namaAjuan');
        const newJudulKegiatan = getSafeValue('edit-judulKegiatan');
        
        if (!newSatuan || newTotal <= 0 || !newNamaAjuan || !newJudulKegiatan) {
            throw new Error('Harap lengkapi Judul, Rincian, Satuan Akhir, dan pastikan Total > 0. Total dihitung ulang dari Jumlah dan Harga Satuan.');
        }

        // 2. Fetch current data for Pagu check and Change tracking (from the correct table)
        const { data: dataBefore, error: fetchError } = await sb.from(targetTableName).select('*').eq('ID_Ajuan', idAjuan).maybeSingle(); // <-- REF ACT
        if (fetchError || !dataBefore) throw new Error("Item ajuan tidak ditemukan.");
        prodiId = dataBefore.ID_Prodi;

        // Prepare data to update
        const dataAfter = { 
            Grub_Belanja_Utama: getSafeValue('edit-selectGrub'),
            Judul_Kegiatan: newJudulKegiatan,
            Nama_Ajuan: newNamaAjuan,
            ID_Kelompok: getSafeValue('edit-selectKelompok'),
            
            // Use calculated results for DB fields:
            Jumlah: calcResults.jumlah, 
            Satuan: newSatuan, 
            Harga_Satuan: calcResults.harga, 
            Total: newTotal,
            
            Catatan_Reviewer: dataBefore.Catatan_Reviewer, // Preserve existing reviewer note
            Keterangan: getSafeValue('edit-keterangan'),
            Status_Revisi: getSafeValue('edit-selectRevisi'),
            Data_Dukung: getSafeValue('edit-dataDukung'),
            
            // NEW: Set calculation breakdown to null/empty as it is not used in this mode
            calcA1: null, calcS1: null,
            calcA2: null, calcS2: null,
            calcA3: null, calcS3: null,
            calcA4: null, calcS4: null,
            calcA5: null, calcS5: null,
            calcA6: null, calcS6: null,
        };

        // 3. Pagu Check (Only for 'Awal' in the 'ajuan' table)
        if (STATE.role === 'prodi' && tipeAjuan === 'Awal') {
            const paguAnggaran = STATE.currentUserData.Pagu_Anggaran || 0;
            if (paguAnggaran > 0) {
                
                let activeAjuanQuery = sb.from(getAjuanTableName('Awal')) // <-- Pagu check selalu ke tabel 'ajuan' untuk pagu Awal
                    .select('Total')
                    .eq('ID_Prodi', STATE.id)
                    .eq('Tipe_Ajuan', 'Awal')
                    .in('Status', ['Menunggu Review', 'Diterima', 'Revisi'])
                    .neq('ID_Ajuan', idAjuan); // Exclude current document
                    
                const { data: activeAjuanData, error: queryError } = await activeAjuanQuery;
                if (queryError) throw new Error("Gagal memeriksa pagu: " + queryError.message);
                
                let currentTotalAjuanAwal = 0;
                activeAjuanData.forEach(doc => { 
                   currentTotalAjuanAwal += Number(doc.Total) || 0; 
                });
                
                const projectedTotal = currentTotalAjuanAwal + newTotal;
                
                if (projectedTotal > paguAnggaran) {
                     throw new Error(`Gagal. Total ajuan Awal (Rp ${projectedTotal.toLocaleString('id-ID')}) akan melebihi pagu Awal Anda (Rp ${paguAnggaran.toLocaleString('id-ID')}).`);
                }
            }
        }
        
        // 4. Change tracking and History logging 
        let changes = [];
        const allKeys = Object.keys(dataAfter);
        for (const key of allKeys) {
            const valBefore = dataBefore[key] === null ? '' : String(dataBefore[key]);
            const valAfter = dataAfter[key] === null ? '' : String(dataAfter[key]);
            
            if (valAfter !== valBefore && key !== 'Catatan_Reviewer' && !key.startsWith('calc')) {
                changes.push(`'${key}' dari '${valBefore}' menjadi '${valAfter}'`);
            }
        }
        
        if (changes.length > 0) {
            const historyDetails = `Detail perubahan: ${changes.join(', ')}.`;
            await logHistory(idAjuan, "Ajuan Diedit", historyDetails);
            await logActivity('Update Ajuan', `Mengedit ajuan ID: ${idAjuan} di tabel ${targetTableName}. Perubahan: ${historyDetails}`);
        }
        
        // 5. Supabase Update
        const { error: updateError } = await sb.from(targetTableName) // <-- REF ACT
            .update(dataAfter)
            .eq('ID_Ajuan', idAjuan);
            
        if (updateError) throw updateError;
        
        showToast('Ajuan berhasil diperbarui.');
        
        const editModalEl = document.getElementById('editAjuanModal');
        if(editModalEl) bootstrap.Modal.getOrCreateInstance(editModalEl).hide();

        // --- Trigger Recalculation ---
        if (prodiId) await recalculateProdiSummary(prodiId);
        // --- End Trigger ---

        // Refresh tabel berdasarkan tipe ajuan yang sedang diedit
        if (tipeAjuan.startsWith('Perubahan')) refreshAjuanTablePerubahan(true); else refreshAjuanTableAwal(true);
        if (STATE.role === 'prodi') updateProdiPaguInfo(STATE.currentUserData);

    } catch (error) {
        showToast(`Gagal update: ${error.message}`, 'danger');
        console.error("Update error (Supabase):", error);
    } finally {
        showLoader(false);
    }
  });

  // --- MIGRATED TO SUPABASE: Ajuan Delete (MODIFIED) ---
  window.deleteAjuan = async (id, tipe) => {
      const ajuanId = String(id);
      const targetTableName = getAjuanTableName(tipe); // <-- REF ACT
      
      if (confirm(`Yakin ingin menghapus ajuan ID: ${ajuanId} dari tabel ${targetTableName}?`)) {
          showLoader(true);
          let prodiId = null;
          try {
              // 1. Fetch data before deletion to get Prodi ID
              const { data: ajuan, error: fetchError } = await sb.from(targetTableName).select('ID_Prodi').eq('ID_Ajuan', ajuanId).maybeSingle(); // <-- REF ACT
              if (fetchError || !ajuan) throw new Error("Ajuan tidak ditemukan.");
              prodiId = ajuan.ID_Prodi;

              // 2. Supabase Delete Ajuan
              const { error: deleteAjuanError } = await sb.from(targetTableName).delete().eq('ID_Ajuan', ajuanId); // <-- REF ACT
              if (deleteAjuanError) throw deleteAjuanError;
              
              // 3. Supabase Delete History
              await sb.from('ajuan_history').delete().eq('ajuan_id', ajuanId);
              
              await logActivity('Delete Ajuan', `Menghapus ajuan ID: ${ajuanId} dari tabel ${targetTableName}.`);
              showToast('Ajuan berhasil dihapus.');
              
              // --- Trigger Recalculation ---
              await recalculateProdiSummary(prodiId);
              // --- End Trigger ---

              if(tipe.startsWith('Awal')) refreshAjuanTableAwal(true); else refreshAjuanTablePerubahan(true);
              if(STATE.role === 'prodi') updateProdiPaguInfo(STATE.currentUserData);
          } catch(error) { showToast(`Gagal menghapus: ${error.message}`, 'danger'); } finally { showLoader(false); }
      }
  };

  window.openReviewModal = (id, action, tipe, oldStatus) => {
    const idString = String(id);
    setElValue('review-id-ajuan', `${idString}|${tipe}`);
    setElValue('review-action', action); 
    document.getElementById('reviewModalAjuanId').innerText = idString.includes(',') ? 'Beberapa Ajuan' : idString.substring(0, 6) + '...'; 
    document.getElementById('review-action-text').innerText = action;
    setElValue('review-old-status', oldStatus || '');
    const targetInfo = document.getElementById('review-target-info');
    if(targetInfo) {
        if(idString.includes(',')) { targetInfo.style.display = 'block'; targetInfo.innerText = `Aksi ini akan diterapkan pada ${idString.split(',').length} ajuan terpilih.`; } else { targetInfo.style.display = 'none'; }
    }
    setElValue('review-catatan', ''); 
    
    const reviewModalEl = document.getElementById('reviewAjuanModal');
    if(reviewModalEl) bootstrap.Modal.getOrCreateInstance(reviewModalEl).show();
  };

  // --- MIGRATED TO SUPABASE: Ajuan Review (Bulk Update) (MODIFIED) ---
  document.getElementById('btn-submit-review').addEventListener('click', async () => {
    const [idString, tipe] = getElValue('review-id-ajuan').split('|');
    const oldStatus = getElValue('review-old-status');
    const ids = idString.split(',').map(String); // Ensure IDs are strings
    const newStatus = getElValue('review-action');
    const catatan = getElValue('review-catatan');
    
    const targetTableName = getAjuanTableName(tipe); // <-- REF ACT: Tentukan tabel tujuan
    
    const data = { Status: newStatus, Catatan_Reviewer: catatan };
    if (newStatus === 'Diterima') {
         data.Is_Blocked = false; // Ensure accepted items are not blocked by default
    }
    
    showLoader(true);
    const ajuanProdiMap = new Map(); 

    try {
        // 1. Bulk Update in Supabase
        const { error: updateError } = await sb.from(targetTableName) // <-- REF ACT
            .update(data)
            .in('ID_Ajuan', ids);
            
        if (updateError) throw updateError;

        // 2. Logging History, Collecting Prodi info, and Triggering Recalculation
        const prodiIdsToRecalculate = new Set();
        
        for (const id of ids) {
            const detailLog = `Status diubah dari '${oldStatus || "N/A"}' menjadi '${newStatus}' di tabel ${targetTableName}. Catatan: ${catatan || 'Tidak ada.'}`;
            await logHistory(id, "Status Direview", detailLog);
            
            if (STATE.role === 'direktorat') {
                // Fetch required data for notification and recalculation
                // NOTE: This fetch can fail due to RLS 406 error if not configured correctly
                const { data: ajuanData, error: fetchError } = await sb.from(targetTableName).select('ID_Prodi, Nama_Ajuan').eq('ID_Ajuan', id).maybeSingle(); // <-- REF ACT
                if (fetchError) console.warn("Gagal fetching ajuan data for notification/recalc.", fetchError);
                
                if (ajuanData) {
                    const prodiId = ajuanData.ID_Prodi;
                    prodiIdsToRecalculate.add(prodiId);
                    
                    if (!ajuanProdiMap.has(prodiId)) {
                        ajuanProdiMap.set(prodiId, []);
                    }
                    ajuanProdiMap.get(prodiId).push(ajuanData.Nama_Ajuan);
                }
            }
        }
        
        // --- Trigger Recalculation for affected prodi ---
        for (const prodiId of prodiIdsToRecalculate) {
            await recalculateProdiSummary(prodiId);
        }
        // --- End Trigger ---
        
        await logActivity('Review Ajuan', `Status ${ids.length} ajuan di tabel ${targetTableName} diubah menjadi ${newStatus}. Catatan: ${catatan || 'Tidak ada'}.`);

        if (STATE.role === 'direktorat') {
            for (const [prodiId, ajuanNames] of ajuanProdiMap.entries()) {
                const prodiUser = STATE.allProdi.find(p => p.ID_Prodi === prodiId);
                if (prodiUser && prodiUser.uid) {
                    const message = `Ajuan '${ajuanNames[0]}' ${ajuanNames.length > 1 ? `dan ${ajuanNames.length-1} lainnya` : ''} telah direview menjadi: ${newStatus} (${tipe}).`;
                    createNotification(prodiUser.uid, message);
                }
            }
        }

        showToast(`${ids.length} review berhasil dikirim.`);
        
        const reviewModalEl = document.getElementById('reviewAjuanModal');
        if(reviewModalEl) bootstrap.Modal.getOrCreateInstance(reviewModalEl).hide();

        // **FIX: Clear selection state and hide bulk action bar if it was a bulk action**
        if(tipe.startsWith('Awal')) {
            if (ids.length > 1) {
                STATE.selectedAjuanIdsAwal.clear();
                updateBulkActionBar('Awal'); 
            }
            refreshAjuanTableAwal(true);
        } else {
            if (ids.length > 1) {
                STATE.selectedAjuanIdsPerubahan.clear();
                updateBulkActionBar('Perubahan');
            }
            refreshAjuanTablePerubahan(true);
        }
        
        loadDashboardData(true);

    } catch (error) { 
        showToast(`Gagal mengirim review: ${error.message}`, 'danger'); 
        console.error("Review error (Supabase):", error);
    } finally { 
        showLoader(false); 
    }
  });
  
  function updateBulkActionBar(tipe) { 
      const lowerTipe = tipe.toLowerCase();
      const bar = document.getElementById(`bulk-action-bar-${lowerTipe}`); 
      const countEl = document.getElementById(`bulk-selected-count-${lowerTipe}`); 
      const selectedIds = tipe === 'Awal' ? STATE.selectedAjuanIdsAwal : STATE.selectedAjuanIdsPerubahan; 
      const selectedCount = selectedIds.size; 
      
      if (!bar || !countEl) return;
      
      if (selectedCount > 0 && STATE.role === 'direktorat') { 
          bar.style.display = 'flex'; 
          countEl.textContent = selectedCount; 
      } else { 
          bar.style.display = 'none'; 
      } 
  }
  
  function addCheckboxListeners(tipe) { 
      const sanitizedTipe = sanitizeTipeForCSS(tipe);

      const selectAll = document.getElementById(`select-all-ajuan-${sanitizedTipe}`); 
      const checkboxes = document.querySelectorAll(`.ajuan-checkbox-${sanitizedTipe}`); 
      const selectedIds = tipe === 'Awal' ? STATE.selectedAjuanIdsAwal : STATE.selectedAjuanIdsPerubahan; 
      
      if (selectAll) { 
          selectAll.addEventListener('change', (e) => { 
              checkboxes.forEach(cb => { 
                  cb.checked = e.target.checked; 
                  const id = cb.dataset.id; 
                  if (e.target.checked) selectedIds.add(id); 
                  else selectedIds.delete(id); 
              }); 
              updateBulkActionBar(tipe.startsWith('Perubahan') ? 'Perubahan' : 'Awal'); 
          }); 
      } 
      checkboxes.forEach(cb => { 
          cb.addEventListener('change', (e) => { 
              const id = e.target.dataset.id; 
              if (e.target.checked) selectedIds.add(id); 
              else selectedIds.delete(id); 
              if(selectAll) selectAll.checked = checkboxes.length === selectedIds.size; 
              updateBulkActionBar(tipe.startsWith('Perubahan') ? 'Perubahan' : 'Awal'); 
          }); 
      }); 
  }
  
  ['Awal', 'Perubahan'].forEach(tipe => {
    const lowerTipe = tipe.toLowerCase();
    
    // Helper function to get selected IDs based on type
    const getSelectedIds = () => {
        return Array.from(tipe === 'Awal' ? STATE.selectedAjuanIdsAwal : STATE.selectedAjuanIdsPerubahan);
    };

    // --- Bulk Review Handlers (calling openReviewModal) ---
    safeAddClickListener(`bulk-accept-${lowerTipe}`, () => {
        const ids = getSelectedIds();
        if (ids.length === 0) { showToast('Pilih setidaknya satu ajuan.', 'warning'); return; }
        window.openReviewModal(ids.join(','), 'Diterima', tipe);
    });

    safeAddClickListener(`bulk-reject-${lowerTipe}`, () => {
        const ids = getSelectedIds();
        if (ids.length === 0) { showToast('Pilih setidaknya satu ajuan.', 'warning'); return; }
        window.openReviewModal(ids.join(','), 'Ditolak', tipe);
    });

    safeAddClickListener(`bulk-revision-${lowerTipe}`, () => {
        const ids = getSelectedIds();
        if (ids.length === 0) { showToast('Pilih setidaknya satu ajuan.', 'warning'); return; }
        window.openReviewModal(ids.join(','), 'Revisi', tipe);
    });
    // --- End Bulk Review Handlers ---

    // ... (existing import user code) ...

    // --- MIGRATED TO SUPABASE: Bulk Delete (MODIFIED) ---
    safeAddClickListener(`bulk-delete-${lowerTipe}`, async () => {
        const ids = Array.from(tipe === 'Awal' ? STATE.selectedAjuanIdsAwal : STATE.selectedAjuanIdsPerubahan).map(String); 
        const targetTableName = getAjuanTableName(tipe); // <-- REF ACT
        
        if (ids.length === 0) return;
        if (confirm(`Yakin ingin menghapus ${ids.length} ajuan terpilih dari tabel ${targetTableName}?`)) {
            showLoader(true);
            try {
                // Fetch affected prodi IDs before deletion
                const { data: ajuanData, error: fetchError } = await sb.from(targetTableName).select('ID_Prodi').in('ID_Ajuan', ids); // <-- REF ACT
                if (fetchError) console.warn("Failed to fetch prodi IDs for deletion recalculation.");
                const prodiIdsToRecalculate = [...new Set(ajuanData.map(d => d.ID_Prodi))];

                // Bulk delete Ajuan
                const { error: deleteAjuanError } = await sb.from(targetTableName).delete().in('ID_Ajuan', ids); // <-- REF ACT
                if (deleteAjuanError) throw deleteAjuanError;
                
                // Bulk delete History
                const { error: deleteHistoryError } = await sb.from('ajuan_history').delete().in('ajuan_id', ids);
                if (deleteHistoryError) console.warn('Failed to delete history: ', deleteHistoryError);
                
                await logActivity('Bulk Delete Ajuan', `Menghapus ${ids.length} ajuan dari tabel ${targetTableName}.`);
                showToast(`${ids.length} ajuan berhasil dihapus.`);

                // --- Trigger Recalculation ---
                for (const prodiId of prodiIdsToRecalculate) {
                    await recalculateProdiSummary(prodiId);
                }
                // --- End Trigger ---

                // **FIX: Clear selection state and hide bulk action bar**
                if (tipe === 'Awal') STATE.selectedAjuanIdsAwal.clear(); else STATE.selectedAjuanIdsPerubahan.clear();
                updateBulkActionBar(tipe); 
                
                if (tipe === 'Awal') refreshAjuanTableAwal(true); else refreshAjuanTablePerubahan(true);
                loadDashboardData(true);
            } catch (error) { showToast(`Gagal menghapus: ${error.message}`, 'danger'); } finally { showLoader(false); }
        }
    });

    // --- MIGRATED TO SUPABASE: Bulk Block/Unblock (MODIFIED) ---
    safeAddClickListener(`bulk-block-${lowerTipe}`, async () => {
        const ids = Array.from(tipe === 'Awal' ? STATE.selectedAjuanIdsAwal : STATE.selectedAjuanIdsPerubahan).map(String); 
        const targetTableName = getAjuanTableName(tipe); // <-- REF ACT
        
        if (ids.length === 0) return;
        if (confirm(`Yakin ingin memBLOKIR ${ids.length} ajuan terpilih di tabel ${targetTableName}? Ajuan yang diblokir TIDAK akan masuk RPD/Realisasi.`)) {
            showLoader(true);
            try {
                // Fetch affected prodi IDs before block operation
                const { data: ajuanData, error: fetchError } = await sb.from(targetTableName).select('ID_Prodi').in('ID_Ajuan', ids); // <-- REF ACT
                if (fetchError) console.warn("Failed to fetch prodi IDs for block recalculation.");
                const prodiIdsToRecalculate = [...new Set(ajuanData.map(d => d.ID_Prodi))];

                // Bulk Update Block status
                const { error: blockError } = await sb.from(targetTableName) // <-- REF ACT
                    .update({ Is_Blocked: true })
                    .in('ID_Ajuan', ids);

                if (blockError) throw blockError;
                
                await logActivity('Bulk Block Ajuan', `Memblokir ${ids.length} ajuan di tabel ${targetTableName}.`);
                showToast(`${ids.length} ajuan berhasil diblokir.`);

                // --- Trigger Recalculation ---
                for (const prodiId of prodiIdsToRecalculate) {
                    await recalculateProdiSummary(prodiId);
                }
                // --- End Trigger ---

                // **FIX: Clear selection state and hide bulk action bar**
                if (tipe === 'Awal') STATE.selectedAjuanIdsAwal.clear(); else STATE.selectedAjuanIdsPerubahan.clear();
                updateBulkActionBar(tipe); 

                if (tipe === 'Awal') refreshAjuanTableAwal(true); else refreshAjuanTablePerubahan(true);
                loadDashboardData(true);
            } catch (error) { showToast(`Gagal memblokir: ${error.message}`, 'danger'); } finally { showLoader(false); }
        }
    });
  });

  // --- MIGRATED TO SUPABASE: Copy Accepted Ajuan (MODIFIED) ---
  // (Logic moved into performPindahkanAjuan and bound via btn-copy-accepted and btn-pindahkan-ajuan-backend)

  // --- MIGRATED TO SUPABASE: RPD/Realisasi Fetch and Save (MODIFIED) ---

  async function refreshTable(baseName, tipe) {
    const isPerubahan = tipe.startsWith("Perubahan");
    const tableContainerId = isPerubahan ? `table${baseName}Perubahan` : `table${baseName}Awal`;
    const filterProdiId = isPerubahan ? `filterProdi${baseName}Perubahan` : `filterProdi${baseName}Awal`;
    const tableContainer = document.getElementById(tableContainerId);
    
    if (!tableContainer) return;
    
    tableContainer.innerHTML = `<div class="text-center text-muted p-5">Memuat data...</div>`;
    showLoader(true);
    
    const targetTableName = getAjuanTableName(tipe); // <-- REF ACT

    try {
        let query = sb.from(targetTableName) // <-- REF ACT
            .select(`ID_Ajuan, ID_Prodi, Nama_Ajuan, Judul_Kegiatan, Total, Is_Blocked, ${RPD_SELECT_COLUMNS}`) // Ensure all required fields are selected
            .eq('Status', 'Diterima')
            .eq('Tipe_Ajuan', tipe);
        
        if (STATE.role === 'direktorat' || STATE.role === 'pimpinan') {
    const prodiFilter = getSafeValue(filterProdiId);
    if (prodiFilter) query = query.eq('ID_Prodi', prodiFilter);
} else {
    query = query.eq('ID_Prodi', STATE.id);
}
        
        const { data: rawData, error } = await query;
        if (error) throw error;
        
        let data = rawData.map(d => ({ ID_Ajuan: String(d.ID_Ajuan || d.id), ...d })); 
        
        // Filter out blocked items locally
        data = data.filter(d => !d.Is_Blocked);

        const tipeSuffix = isPerubahan ? 'Perubahan' : 'Awal';
        if (baseName === 'RPD') {
            renderRPDTable(data, tipeSuffix);
        } else if (baseName === 'Realisasi') {
            renderRealisasiTable(data, tipeSuffix);
            renderRealisasiSummary(data, tipeSuffix);
        }
    } catch(error) {
        tableContainer.innerHTML = `<div class="text-center text-danger p-5">Gagal memuat data.</div>`;
        console.error(`${baseName} ${tipe} Error (Supabase, Table: ${targetTableName}):`, error);
    } finally {
        showLoader(false);
    }
  }

  
  function renderRPDTable(data, tipe) { 
    const container = document.getElementById(`tableRPD${tipe}`); 
    if (!container) return;
    if (data.length === 0) { container.innerHTML = '<div class="text-center text-muted p-5">Tidak ada ajuan diterima dan tidak diblokir.</div>'; return; } 
    
    const isReadOnlyRole = (STATE.role === 'direktorat' || STATE.role === 'pimpinan');
const readOnlyAttr = isReadOnlyRole ? 'readonly' : ''; 
const disabledBtnClass = isReadOnlyRole ? 'disabled' : ''; 
const actionColumnStyle = (STATE.role === 'pimpinan') ? 'display:none;' : ''; // Sembunyikan tombol simpan sepenuhnya untuk pimpinan 
    
    // ADJUSTED HEADER MIN-WIDTHS FOR BETTER SCALING
    let tableHeader = `<tr class="table-light"><th rowspan="2" class="align-middle">ID</th>${isDirektorat ? '<th rowspan="2" class="align-middle">Unit</th>' : ''}<th rowspan="2" class="align-middle" style="min-width: 200px;">Rincian</th><th rowspan="2" class="align-middle text-end" style="min-width: 100px;">Total Diterima</th><th colspan="12" class="text-center">Rencana Penarikan Dana per Bulan (Rp)</th><th rowspan="2" class="align-middle text-end" style="min-width: 100px;">Total RPD</th><th rowspan="2" class="align-middle text-end" style="min-width: 100px;">Sisa</th><th rowspan="2" class="align-middle text-center action-buttons" style="min-width: 70px;">Aksi</th></th></tr><tr class="table-light">${RPD_MONTHS.map(m => `<th class="text-center" style="min-width: 75px;">${m}</th>`).join('')}</tr>`; 
    
    const tableRows = data.map(r => { 
        // PERBAIKAN: Memastikan ajuanId adalah string sebelum menggunakan substring
        const ajuanId = String(r.ID_Ajuan); 
        let totalAllocated = 0; 
        
        const rpdInputs = RPD_MONTHS.map(month => { 
            // Correctly access snake_case column names
            const value = Number(r[getMonthlyKey('RPD', month)] || 0); 
            totalAllocated += value; 
            return `<td><input type="number" class="form-control form-control-sm rpd-input" data-ajuan-id="${ajuanId}" value="${value}" oninput="window.updateRpdRowSummary('${ajuanId}', '${tipe}')" min="0" ${readOnlyAttr}></td>`; 
        }).join(''); 
        
        const totalAjuan = Number(r.Total) || 0; 
        const sisa = totalAjuan - totalAllocated; 
        const sisaClass = sisa < 0 ? 'text-danger fw-bold' : ''; 
        
        const prodiCell = isDirektorat ? `<td>${escapeHtml(r.ID_Prodi)}</td>` : '';
        
        // Determine the export ID based on the rendered type
        const exportTableId = `table-export-RPD${tipe}`;
        
        return `<tr id="rpd-row-${tipe}-${ajuanId}"><td><span class="badge bg-secondary-subtle text-secondary-emphasis fw-normal">${ajuanId.substring(0,6)}..</span></td>${prodiCell}<td><strong>${escapeHtml(r.Nama_Ajuan)}</strong><div class="small text-muted">${escapeHtml(r.Judul_Kegiatan)}</div></td><td class="text-end fw-bold" data-total="${totalAjuan}">${totalAjuan.toLocaleString('id-ID')}</td>${rpdInputs}<td class="text-end fw-bold rpd-total-allocated">${totalAllocated.toLocaleString('id-ID')}</td><td class="text-end fw-bold rpd-sisa ${sisaClass}">${sisa.toLocaleString('id-ID')}</td><td class="text-center action-buttons"><button class="btn btn-sm btn-primary ${disabledBtnClass}" onclick="window.saveRPD('${ajuanId}', '${tipe}')" title="Simpan RPD"><i class="bi bi-save"></i></button></td></tr>`; 
    }).join(''); 
    
    container.innerHTML = `<table class="table table-bordered table-sm small" id="table-export-RPD${tipe}"><thead>${tableHeader}</thead><tbody>${tableRows}</tbody></table>`; 
  }
  
  window.updateRpdRowSummary = (ajuanId, tipe) => { const row = document.getElementById(`rpd-row-${tipe}-${ajuanId}`); if (!row) return false; const totalValue = parseFloat(row.querySelector('[data-total]').dataset.total); let currentSum = 0; row.querySelectorAll('.rpd-input').forEach(input => { currentSum += Number(input.value) || 0; }); const sisa = totalValue - currentSum; row.querySelector('.rpd-total-allocated').textContent = currentSum.toLocaleString('id-ID'); row.querySelector('.rpd-sisa').textContent = sisa.toLocaleString('id-ID'); if (sisa < 0) { row.querySelector('.rpd-sisa').classList.add('text-danger'); return false; } else { row.querySelector('.rpd-sisa').classList.remove('text-danger'); return true; } }
  
  // --- MIGRATED TO SUPABASE: Save RPD (MODIFIED) ---
  window.saveRPD = async (id, tipe) => {
    const ajuanId = String(id);
    const targetTableName = getAjuanTableName(tipe); // <-- REF ACT
    
    if (!window.updateRpdRowSummary(ajuanId, tipe)) {
        showToast('Gagal. Total alokasi RPD melebihi total diterima.', 'danger');
        return;
    }
    showLoader(true);
    const row = document.getElementById(`rpd-row-${tipe}-${ajuanId}`);
    const rpdData = {};
    let totalRpd = 0;
    let prodiId = null;

    try {
        // 1. Fetch Prodi ID
        const { data: ajuan, error: fetchError } = await sb.from(targetTableName).select('ID_Prodi').eq('ID_Ajuan', ajuanId).maybeSingle(); // <-- REF ACT
        if (fetchError || !ajuan) throw new Error("Ajuan tidak ditemukan.");
        prodiId = ajuan.ID_Prodi;

        if (row) {
            row.querySelectorAll('.rpd-input').forEach((input, index) => {
                const value = Number(input.value) || 0;
                // Use snake_case column names for Supabase update
                rpdData[getMonthlyKey('RPD', RPD_MONTHS[index])] = value;
                totalRpd += value;
            });
        }

        // 2. Supabase Update
        const { error } = await sb.from(targetTableName) // <-- REF ACT
            .update(rpdData)
            .eq('ID_Ajuan', ajuanId);
        
        if (error) throw error;
        
        await logHistory(ajuanId, `RPD Disimpan (${targetTableName})`, `Total RPD yang disimpan: Rp ${totalRpd.toLocaleString('id-ID')}.`);
        await logActivity('Save RPD', `Menyimpan RPD untuk ajuan ID ${ajuanId} di tabel ${targetTableName}. Total: Rp ${totalRpd.toLocaleString('id-ID')}.`);
        showToast(`RPD untuk ${ajuanId.substring(0,6)}.. disimpan.`);
        
        // --- Trigger Recalculation ---
        if (prodiId) await recalculateProdiSummary(prodiId);
        loadDashboardData(true); // Force dashboard refresh to get latest RPD summary
        // --- End Trigger ---

        if (row) {
            row.classList.add('row-saved-animation');
            setTimeout(() => row.classList.remove('row-saved-animation'), 2000);
        }
    } catch (error) {
        showToast(`Gagal menyimpan RPD: ${error.message}`, 'danger');
    } finally {
        showLoader(false);
    }
  };

   function renderRealisasiTable(data, tipe) { 
    const container = document.getElementById(`tableRealisasi${tipe}`); 
    if (!container) return;
    if (data.length === 0) { container.innerHTML = '<div class="text-center text-muted p-5">Tidak ada ajuan diterima dan tidak diblokir.</div>'; return; } 
    const isReadOnlyRole = (STATE.role === 'direktorat' || STATE.role === 'pimpinan');
const readOnlyAttr = isReadOnlyRole ? 'readonly' : ''; 
const disabledBtnClass = isReadOnlyRole ? 'disabled' : ''; 
const actionColumnStyle = (STATE.role === 'pimpinan') ? 'display:none;' : ''; // Sembunyikan tombol simpan sepenuhnya untuk pimpinan
    // ADJUSTED HEADER MIN-WIDTHS FOR BETTER SCALING
    let tableHeader = `<tr class="table-light"><th rowspan="2" class="align-middle">ID</th>${isDirektorat ? '<th rowspan="2" class="align-middle">Unit</th>' : ''}<th rowspan="2" class="align-middle" style="min-width: 200px;">Rincian</th><th rowspan="2" class="align-middle text-end" style="min-width: 100px;">Total RPD</th><th colspan="12" class="text-center">Realisasi Penarikan Dana per Bulan (Rp)</th><th rowspan="2" class="align-middle text-end" style="min-width: 100px;">Total Realisasi</th><th rowspan="2" class="align-middle text-center action-buttons" style="min-width: 70px;">Aksi</th></tr><tr class="table-light">${RPD_MONTHS.map(m => `<th class="text-center" style="min-width: 75px;">${m}</th>`).join('')}</tr>`; 
    
    const tableRows = data.map(r => {  
        // PERBAIKAN: Memastikan ajuanId adalah string sebelum menggunakan substring
        const ajuanId = String(r.ID_Ajuan); 
        let totalRealisasi = 0; 
        let totalRPD = 0; 

        const realisasiInputs = RPD_MONTHS.map(month => { 
            // Correctly access snake_case column names
            const realisasiKey = getMonthlyKey('Realisasi', month);
            const rpdKey = getMonthlyKey('RPD', month);

            const value = Number(r[realisasiKey] || 0); 
            totalRealisasi += value; 
            totalRPD += Number(r[rpdKey] || 0); 

            return `<td><input type="number" class="form-control form-control-sm realisasi-input" value="${value}" oninput="window.updateRealisasiRowSummary('${ajuanId}', '${tipe}')" min="0" ${readOnlyAttr}></td>`; 
        }).join(''); 
        
        const prodiCell = isDirektorat ? `<td>${escapeHtml(r.ID_Prodi)}</td>` : '';

        return `<tr id="realisasi-row-${tipe}-${ajuanId}"><td><span class="badge bg-secondary-subtle text-secondary-emphasis fw-normal">${ajuanId.substring(0,6)}..</span></td>${prodiCell}<td><strong>${escapeHtml(r.Nama_Ajuan)}</strong></td><td class="text-end fw-bold">${totalRPD.toLocaleString('id-ID')}</td>${realisasiInputs}<td class="text-end fw-bold realisasi-total">${totalRealisasi.toLocaleString('id-ID')}</td><td class="text-center action-buttons"><button class="btn btn-sm btn-primary ${disabledBtnClass}" onclick="window.saveRealisasi('${ajuanId}', '${tipe}')" title="Simpan Realisasi"><i class="bi bi-save"></i></button></td></tr>`; 
    }).join(''); 
    container.innerHTML = `<table class="table table-bordered table-sm small" id="table-export-Realisasi${tipe}"><thead>${tableHeader}</thead><tbody>${tableRows}</tbody></table>`; 
  }
  
  function renderRealisasiSummary(data, tipe) { 
    const container = document.getElementById(`realisasi-summary-area-${tipe.toLowerCase()}`); 
    if (!container) return;

    const rpdPerBulan = Array(12).fill(0); 
    const realisasiPerBulan = Array(12).fill(0); 
    data.forEach(ajuan => { RPD_MONTHS.forEach((month, index) => { rpdPerBulan[index] += Number(ajuan[getMonthlyKey('RPD', month)]) || 0; realisasiPerBulan[index] += Number(ajuan[getMonthlyKey('Realisasi', month)]) || 0; }); }); 
    const totalRPD = rpdPerBulan.reduce((a, b) => a + b, 0); 
    const totalRealisasi = realisasiPerBulan.reduce((a, b) => a + b, 0); 
    const rpdTriwulan = calculateQuarterlySummary(rpdPerBulan, totalRPD); 
    const realisasiTriwulan = calculateQuarterlySummary(realisasiPerBulan, totalRealisasi); 
    let summaryHtml = `<div class="card d-print-none"><div class="card-header fw-bold">Ringkasan Realisasi Anggaran ${tipe}</div><div class="card-body"><div class="row g-4"><div class="col-lg-6"><h6 class="text-center small text-muted">Realisasi per Bulan</h6><table class="table table-sm table-striped small"><thead class="table-light"><tr><th>Bulan</th><th class="text-end">RPD</th><th class="text-end">Realisasi</th><th class="text-center">%</th></tr></thead><tbody>${rpdPerBulan.map((rpd, i) => { const real = realisasiPerBulan[i]; const percent = rpd > 0 ? ((real / rpd) * 100).toFixed(1) : '0.0'; return `<tr><td>${RPD_MONTHS[i]}</td><td class="text-end">${rpd.toLocaleString('id-ID')}</td><td class="text-end">${real.toLocaleString('id-ID')}</td><td class="text-center"><span class="badge ${percent >= 100 ? 'bg-success-subtle text-success-emphasis' : 'bg-warning-subtle text-warning-emphasis'}">${percent}%</span></td></tr>`; }).join('')}<tr class="table-dark"><td><strong>Total</strong></td><td class="text-end"><strong>${totalRPD.toLocaleString('id-ID')}</strong></td><td class="text-end"><strong>${totalRealisasi.toLocaleString('id-ID')}</strong></td><td class="text-center"><strong>${totalRPD > 0 ? ((totalRealisasi/totalRPD)*100).toFixed(1) : '0.0'}%</strong></td></tr></tbody></table></div><div class="col-lg-6"><h6 class="small text-muted text-center">Realisasi per Triwulan</h6><table class="table table-sm table-striped small"><thead class="table-light"><tr><th>Triwulan</th><th class="text-end">RPD</th><th class="text-end">Realisasi</th><th class="text-center">%</th></tr></thead><tbody>${rpdTriwulan.values.map((rpd, i) => { const real = realisasiTriwulan.values[i]; const percent = rpd > 0 ? ((real / rpd) * 100).toFixed(1) : '0.0'; return `<tr><td><strong>Q${i+1}</strong></td><td class="text-end">${rpd.toLocaleString('id-ID')}</td><td class="text-end">${real.toLocaleString('id-ID')}</td><td class="text-center"><span class="badge ${percent >= 100 ? 'bg-success-subtle text-success-emphasis' : 'bg-warning-subtle text-warning-emphasis'}">${percent}%</span></td></tr>`; }).join('')}</tbody></table></div></div></div></div>`; 
    container.innerHTML = summaryHtml; 
  }
  
  window.updateRealisasiRowSummary = (ajuanId, tipe) => { 
    const row = document.getElementById(`realisasi-row-${tipe}-${ajuanId}`); 
    if (!row) return; 
    let currentSum = 0; 
    row.querySelectorAll('.realisasi-input').forEach(input => currentSum += Number(input.value) || 0); 
    const totalEl = row.querySelector('.realisasi-total');
    if (totalEl) totalEl.textContent = currentSum.toLocaleString('id-ID'); 
  }
  
  // --- MIGRATED TO SUPABASE: Save Realisasi (MODIFIED) ---
  window.saveRealisasi = async (id, tipe) => {
    const ajuanId = String(id);
    const targetTableName = getAjuanTableName(tipe); // <-- REF ACT
    showLoader(true);
    const row = document.getElementById(`realisasi-row-${tipe}-${ajuanId}`);
    const realisasiData = {};
    let totalRealisasi = 0;
    let prodiId = null;

    try {
        // 1. Fetch Prodi ID
        const { data: ajuan, error: fetchError } = await sb.from(targetTableName).select('ID_Prodi').eq('ID_Ajuan', ajuanId).maybeSingle(); // <-- REF ACT
        if (fetchError || !ajuan) throw new Error("Ajuan tidak ditemukan.");
        prodiId = ajuan.ID_Prodi;

        if (row) {
            row.querySelectorAll('.realisasi-input').forEach((input, index) => {
                const value = Number(input.value) || 0;
                // Use snake_case column names for Supabase update
                realisasiData[getMonthlyKey('Realisasi', RPD_MONTHS[index])] = value;
                totalRealisasi += value;
            });
        }
        
        // 2. Supabase Update
        const { error } = await sb.from(targetTableName) // <-- REF ACT
            .update(realisasiData)
            .eq('ID_Ajuan', ajuanId);
        
        if (error) throw error;

        await logHistory(ajuanId, `Realisasi Disimpan (${targetTableName})`, `Total Realisasi yang disimpan: Rp ${totalRealisasi.toLocaleString('id-ID')}.`);
        await logActivity('Save Realisasi', `Menyimpan realisasi untuk ajuan ID ${ajuanId} di tabel ${targetTableName}. Total: Rp ${totalRealisasi.toLocaleString('id-ID')}.`);
        showToast(`Realisasi untuk ${ajuanId.substring(0,6)}.. disimpan.`);
        
        // --- Trigger Recalculation ---
        if (prodiId) await recalculateProdiSummary(prodiId);
        loadDashboardData(true); // Force dashboard refresh to get latest Realisasi summary
        // --- End Trigger ---

        if (row) {
            row.classList.add('row-saved-animation');
            setTimeout(() => row.classList.remove('row-saved-animation'), 2000);
        }
    } catch (error) {
        showToast(`Gagal menyimpan Realisasi: ${error.message}`, 'danger');
    } finally {
        showLoader(false);
    }
  };

  ['Awal', 'Perubahan'].forEach(tipe => {
      const isPerubahan = tipe === 'Perubahan';
      const tipeLower = tipe.toLowerCase();
      
      const tabTargetRpd = document.querySelector(`[data-bs-target="#tab-rpd-${tipeLower}"]`);
      if (tabTargetRpd) {
        tabTargetRpd.addEventListener('shown.bs.tab', () => {
            const tipeQuery = isPerubahan ? `Perubahan ${STATE.globalSettings.Tahap_Perubahan_Aktif || 1}` : 'Awal';
            refreshTable('RPD', tipeQuery);
        });
      }
      safeAddClickListener(`btn-refresh-rpd-${tipeLower}`, () => {
          const tipeQuery = isPerubahan ? `Perubahan ${STATE.globalSettings.Tahap_Perubahan_Aktif || 1}` : 'Awal';
          refreshTable('RPD', tipeQuery);
      });
      
      const filterProdiRpd = document.getElementById(`filterProdiRPD${tipe}`);
      if (filterProdiRpd) {
        filterProdiRpd.addEventListener('change', () => {
            const tipeQuery = isPerubahan ? `Perubahan ${STATE.globalSettings.Tahap_Perubahan_Aktif || 1}` : 'Awal';
            refreshTable('RPD', tipeQuery);
        });
      }


      const tabTargetRealisasi = document.querySelector(`[data-bs-target="#tab-realisasi-${tipeLower}"]`);
      if (tabTargetRealisasi) {
        tabTargetRealisasi.addEventListener('shown.bs.tab', () => {
            const tipeQuery = isPerubahan ? `Perubahan ${STATE.globalSettings.Tahap_Perubahan_Aktif || 1}` : 'Awal';
            refreshTable('Realisasi', tipeQuery);
        });
      }
      safeAddClickListener(`btn-refresh-realisasi-${tipeLower}`, () => {
          const tipeQuery = isPerubahan ? `Perubahan ${STATE.globalSettings.Tahap_Perubahan_Aktif || 1}` : 'Awal';
          refreshTable('Realisasi', tipeQuery);
      });
      
      const filterProdiRealisasi = document.getElementById(`filterProdiRealisasi${tipe}`);
      if (filterProdiRealisasi) {
        filterProdiRealisasi.addEventListener('change', () => {
            const tipeQuery = isPerubahan ? `Perubahan ${STATE.globalSettings.Tahap_Perubahan_Aktif || 1}` : 'Awal';
            refreshTable('Realisasi', tipeQuery);
        });
      }
  });
  
  // --- START BERITA ACARA PREVIEW HANDLERS (NEW/FIXED) ---
  
  async function handleBeritaAcaraPreview() {
      // Use getSafeValue to ensure no error if the element is missing
      const tipeAjuan = getSafeValue('filterTipeBA') || 'Awal';
      
      // Check if directorate needs to select a prodi for Perubahan BA
      if (STATE.role === 'direktorat' && tipeAjuan.startsWith('Perubahan')) {
           const prodiFilter = getSafeValue('filterProdiBA');
           if (!prodiFilter) {
                showToast('Harap pilih Unit di filter untuk melihat Berita Acara Perubahan.', 'warning'); 
                return;
           }
      }

      if (tipeAjuan.startsWith('Awal')) {
          await renderBeritaAcaraAwal(tipeAjuan);
      } else {
          await renderBeritaAcaraPerubahan(tipeAjuan);
      }
      
      // Show action buttons after preview
      const baActions = document.getElementById('ba-actions');
      if (baActions) baActions.style.display = 'flex'; // Use flex to show button group
  }
  
  const tabBeritaAcara = document.querySelector('[data-bs-target="#tab-berita-acara"]');
  if (tabBeritaAcara) {
      tabBeritaAcara.addEventListener('shown.bs.tab', () => {
          // Hide action buttons initially until preview is run
          const baActions = document.getElementById('ba-actions');
          if (baActions) baActions.style.display = 'none';
          document.getElementById('berita-acara-content').innerHTML = `<div class="text-center text-muted p-5">Tekan tombol "Pratinjau Berita Acara" untuk memuat konten.</div>`;
          
          // Default BA type based on current stage
          const currentStage = STATE.globalSettings.Status_Ajuan_Perubahan === 'Dibuka' 
            ? `Perubahan ${STATE.globalSettings.Tahap_Perubahan_Aktif || 1}` 
            : 'Awal';
          setElValue('filterTipeBA', currentStage);
      });
  }

  const filterTipeBA = document.getElementById('filterTipeBA');
  if(filterTipeBA) {
      filterTipeBA.addEventListener('change', () => {
          const tipe = filterTipeBA.value;
          const baProdiFilter = document.getElementById('filterProdiBA');
          const baProdiFilterGroup = document.getElementById('ba-filter-group-prodi');
          
          // Only force selection/visibility for Direktorat on Perubahan BA
          if (STATE.role === 'direktorat') {
              if (tipe.startsWith('Perubahan')) {
                   if (baProdiFilterGroup) baProdiFilterGroup.style.display = 'block';
              } else {
                   // If printing Awal, allow printing all (by clearing filter)
                   if (baProdiFilterGroup) baProdiFilterGroup.style.display = 'block';
                   if (baProdiFilter) baProdiFilter.value = ''; // Clear filter for bulk BA Awal
              }
          }
          // Clear previous preview
          document.getElementById('berita-acara-content').innerHTML = `<div class="text-center text-muted p-5">Tekan tombol "Pratinjau Berita Acara" untuk memuat konten.</div>`;
          const baActions = document.getElementById('ba-actions');
          if (baActions) baActions.style.display = 'none';
      });
  }
  
  const filterProdiBA = document.getElementById('filterProdiBA');
  if(filterProdiBA) {
       filterProdiBA.addEventListener('change', () => {
          // Clear previous preview when filter changes
          document.getElementById('berita-acara-content').innerHTML = `<div class="text-center text-muted p-5">Tekan tombol "Pratinjau Berita Acara" untuk memuat konten.</div>`;
          const baActions = document.getElementById('ba-actions');
          if (baActions) baActions.style.display = 'none';
       });
  }

  // --- END BERITA ACARA PREVIEW HANDLERS ---


  async function renderBeritaAcaraAwal(tipeAjuan) {
    const container = document.getElementById('berita-acara-content');
    if (!container) return;
    container.innerHTML = `<div class="text-center text-muted p-5">Memuat data Berita Acara...</div>`;
    showLoader(true);
    
    try {
        const prodiFilter = getSafeValue('filterProdiBA');
        
        // 1. Tentukan target Prodi ID(s)
        let targetProdiIds = [];
        if (STATE.role === 'direktorat' && !prodiFilter) {
            // Ambil semua prodi
            targetProdiIds = STATE.allProdi.filter(p => p.Role === 'prodi').map(p => p.ID_Prodi);
        } else {
             let prodiId = STATE.role === 'prodi' ? STATE.id : prodiFilter;
             if (!prodiId) throw new Error('Silakan pilih Unit di filter.'); 
             targetProdiIds = [prodiId];
        }

        if (targetProdiIds.length === 0) throw new Error("Tidak ada unit yang dipilih.");

        const targetTableName = getAjuanTableName(tipeAjuan);

        // 2. QUERY BATCH (Satu kali request untuk semua prodi)
        const { data: allAjuanData, error } = await sb.from(targetTableName)
            .select('*')
            .eq('Tipe_Ajuan', tipeAjuan)
            .in('ID_Prodi', targetProdiIds) // Menggunakan IN filter
            .eq('Status', 'Diterima');
        
        if (error) throw error;

        // Filter blocked items di memory
        const cleanData = allAjuanData.filter(d => !d.Is_Blocked);

        if (cleanData.length === 0) {
            throw new Error(`Tidak ada data ajuan "Diterima" (Clean) untuk unit terpilih.`);
        }

        // 3. Grouping Data by Prodi di Memory (Javascript)
        const dataByProdi = cleanData.reduce((acc, item) => {
            if (!acc[item.ID_Prodi]) acc[item.ID_Prodi] = [];
            acc[item.ID_Prodi].push(item);
            return acc;
        }, {});

        // 4. Generate HTML Loop
        let allProdisHtml = '';
        const sortedProdiIds = Object.keys(dataByProdi).sort();

        for (const pid of sortedProdiIds) {
            const prodiData = STATE.allProdi.find(p => p.ID_Prodi === pid) || { Nama_Prodi: pid, beritaAcaraSettings: {} };
            const pData = dataByProdi[pid];

            if (allProdisHtml !== '') allProdisHtml += '<div style="page-break-after: always;"></div>';

            // --- Generate Tabel Rincian ---
            let grandTotal = 0;
            const groupedData = pData.reduce((acc, row) => {
                const grubKey = row.Grub_Belanja_Utama || 'Lain-lain';
                if (!acc[grubKey]) acc[grubKey] = [];
                acc[grubKey].push(row);
                return acc;
            }, {});
            
            let tableRowsHtml = '';
            let no = 1;
            Object.keys(groupedData).sort().forEach(grubKey => {
                tableRowsHtml += `<tr><td colspan="5" style="background-color: #f2f2f2;"><strong>${escapeHtml(grubKey)}</strong></td></tr>`;
                groupedData[grubKey].forEach(r => {
                    grandTotal += Number(r.Total) || 0;
                    tableRowsHtml += `<tr><td style="text-align: center;">${no++}</td><td>${escapeHtml(r.Nama_Ajuan)}</td><td style="text-align: center;">${Number(r.Jumlah).toLocaleString('id-ID', { maximumFractionDigits: 2 })} ${escapeHtml(r.Satuan)}</td><td style="text-align: right;">${Number(r.Harga_Satuan).toLocaleString('id-ID')}</td><td style="text-align: right;">${Number(r.Total).toLocaleString('id-ID')}</td></tr>`;
                });
            });

            // --- Template Surat (HTML String) ---
            // (Gunakan template yang sama seperti di kode asli Anda, panggil variabel tableRowsHtml & grandTotal)
            // ... Copy paste template HTML BA di sini ...
            
            // Contoh ringkas:
            const today = new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
            const ttdKiri = prodiData.beritaAcaraSettings?.TTD_Nama || STATE.beritaAcaraSettings.TTD_Kiri_Nama;
            
            allProdisHtml += `
                <div class="ba-page-content">
                    <div class="ba-judul"><h5>BERITA ACARA - ${escapeHtml(prodiData.Nama_Prodi)}</h5></div>
                    <table class="ba-table">
                        <thead><tr><th>No</th><th>Uraian</th><th>Vol</th><th>Harga</th><th>Jumlah</th></tr></thead>
                        <tbody>${tableRowsHtml}<tr><td colspan="4" class="text-end fw-bold">TOTAL</td><td class="text-end fw-bold">${grandTotal.toLocaleString('id-ID')}</td></tr></tbody>
                    </table>
                    <div class="ba-signatures"><p>Kupang, ${today}</p><p><u>${escapeHtml(ttdKiri)}</u></p></div>
                </div>`;
        }
        
        container.innerHTML = allProdisHtml;

    } catch (error) {
        container.innerHTML = `<div class="text-center text-danger p-5">Error: ${error.message}</div>`;
        showToast(error.message, 'danger');
    } finally {
        showLoader(false);
    }
}

  async function renderBeritaAcaraPerubahan(tipeAjuan) {
    const container = document.getElementById('berita-acara-content');
    if (!container) return;
    container.innerHTML = `<div class="text-center text-muted p-5">Memuat data Berita Acara Perubahan...</div>`;
    showLoader(true);

    try {
        const prodiFilter = getSafeValue('filterProdiBA');
        const tahapAktif = tipeAjuan;
        
        let targetProdiList = [];
        if (STATE.role === 'direktorat' && !prodiFilter) {
            // Direktorat harus memilih prodi untuk BA Perubahan
            throw new Error('Untuk Berita Acara Perubahan, harap filter per Unit untuk memuat perbandingan.');
        } else {
             let prodiId = STATE.role === 'prodi' ? STATE.id : prodiFilter;
             const prodiData = (STATE.role === 'direktorat') 
                ? STATE.allProdi.find(p => p.ID_Prodi === prodiId) || { ID_Prodi: prodiId, Nama_Prodi: prodiId }
                : STATE.currentUserData;
             targetProdiList.push(prodiData);
        }

        let allProdisHtml = '';
        let baGeneratedCount = 0;

        for (const prodiData of targetProdiList) {
            const prodiId = prodiData.ID_Prodi;
            
            // 1. Fetch current accepted data (from the revision table)
            const currentTableName = getAjuanTableName(tipeAjuan); // e.g., 'ajuanrev1'
            
            const { data: currentRawData, error: currentError } = await sb.from(currentTableName) // <-- REF ACT
                .select('*, ID_Ajuan_Asal') // Ensure ID_Ajuan_Asal is included
                .eq('Tipe_Ajuan', tipeAjuan)
                .eq('ID_Prodi', prodiId)
                .eq('Status', 'Diterima');
            
            if (currentError) throw currentError;

            let currentData = currentRawData.map(d => {
                d.ID_Ajuan = String(d.ID_Ajuan || d.id); // Ensure string ID
                if (d.ID_Ajuan_Asal) d.ID_Ajuan_Asal = String(d.ID_Ajuan_Asal);
                return d;
            }).filter(d => !d.Is_Blocked); 

            if (currentData.length === 0) {
                if (targetProdiList.length === 1) {
                    throw new Error(`Tidak ada ajuan ${tipeAjuan} berstatus "Diterima" dan tidak diblokir untuk ${prodiId}.`);
                }
                continue;
            }

            baGeneratedCount++;
            if (allProdisHtml !== '') {
                allProdisHtml += '<div style="page-break-after: always;"></div>';
            }

            const asalIds = [...new Set(currentData.map(d => d.ID_Ajuan_Asal).filter(Boolean))];
            const originalDataMap = new Map();

            // 2. Determine Original Table Name (Awal atau Perubahan X-1)
            const tahapNumber = parseInt(tipeAjuan.replace('Perubahan ', ''));
            const sourceType = tahapNumber === 1 ? 'Awal' : `Perubahan ${tahapNumber - 1}`;
            const originalTableName = getAjuanTableName(sourceType); // <-- REF ACT

            // 3. Fetch original data (Supabase Query) - from the previous stage's table
            if (asalIds.length > 0) {
                const { data: originalData, error: originalError } = await sb.from(originalTableName) // <-- REF ACT
                    .select('*')
                    .in('ID_Ajuan', asalIds); 
                
                if (originalError) console.warn("Error fetching original data for comparison:", originalError);

                (originalData || []).forEach(doc => {
                    originalDataMap.set(String(doc.ID_Ajuan || doc.id), doc);
                });
            }
            
            // --- Data Processing for Comparison Table ---
            let grandTotalBaru = 0;
            let grandTotalLama = 0;
            let totalSelisih = 0;

            const tableRows = currentData.map((r, index) => {
                const original = originalDataMap.get(r.ID_Ajuan_Asal) || {};
                
                const namaLama = escapeHtml(original.Nama_Ajuan || 'Ajuan Baru');
                const volLama = Number(original.Jumlah) || 0;
                const hrgLama = Number(original.Harga_Satuan) || 0;
                const totalLama = Number(original.Total) || 0;

                const namaBaru = escapeHtml(r.Nama_Ajuan);
                const volBaru = Number(r.Jumlah) || 0;
                const hrgBaru = Number(r.Harga_Satuan) || 0;
                const totalBaru = Number(r.Total) || 0;

                const selisih = totalBaru - totalLama;
                
                grandTotalBaru += totalBaru;
                grandTotalLama += totalLama;
                totalSelisih += selisih;

                const selisihColor = selisih === 0 ? 'text-muted' : (selisih > 0 ? 'text-success' : 'text-danger');

                // Generate table rows, ensuring two rows per item
                return `
                    <tr>
                        <td rowspan="2" style="text-align: center; vertical-align: middle;">${index + 1}</td>
                        <td class="bg-light-subtle">${namaLama}</td>
                        <td style="text-align: center;">${volLama.toLocaleString('id-ID', { maximumFractionDigits: 2 })} ${escapeHtml(original.Satuan || '')}</td>
                        <td style="text-align: right;">${hrgLama.toLocaleString('id-ID')}</td>
                        <td style="text-align: right;">${totalLama.toLocaleString('id-ID')}</td>
                        <td rowspan="2" style="text-align: right; vertical-align: middle; font-weight: bold; ${selisihColor === 'text-danger' ? 'color: red;' : selisihColor === 'text-success' ? 'color: green;' : ''}">${selisih > 0 ? '+' : ''}${selisih.toLocaleString('id-ID')}</td>
                    </tr>
                    <tr>
                        <td style="font-weight: bold;">${namaBaru}</td>
                        <td style="text-align: center;">${volBaru.toLocaleString('id-ID', { maximumFractionDigits: 2 })} ${escapeHtml(r.Satuan)}</td>
                        <td style="text-align: right;">${hrgBaru.toLocaleString('id-ID')}</td>
                        <td style="text-align: right; font-weight: bold;">${totalBaru.toLocaleString('id-ID')}</td>
                    </tr>
                `;
            }).join('');
            
            // --- Signature and Header Info rendering ---
            const prodiBaSettings = prodiData.beritaAcaraSettings || {};
            const ttdKiriJabatan = prodiBaSettings.TTD_Jabatan || STATE.beritaAcaraSettings.TTD_Kiri_Jabatan || 'Ketua Jurusan/Program Studi';
            const ttdKiriNama = prodiBaSettings.TTD_Nama || STATE.beritaAcaraSettings.TTD_Kiri_Nama || '(..................................................)';
            const ttdKananJabatan = STATE.beritaAcaraSettings.TTD_Kanan_Jabatan || 'Wakil Direktur II';
            const ttdKananNama = STATE.beritaAcaraSettings.TTD_Kanan_Nama || '(..................................................)';
            const today = new Date();
            const tglCetak = today.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
            const tahunAnggaran = today.getFullYear();
            
            const selisihTotalColor = totalSelisih >= 0 ? 'text-success' : 'text-danger';

            allProdisHtml += `
                <div class="ba-page-content">
                <div class="ba-kop">
                    <table><tr><td style="width: 100px; text-align: right; border:none; padding-right: 15px;"><img src="https://si-pandai.netlify.app/LOGO%20POLTEKKES%20KEMENKES%20KUPANG.png" alt="Logo"></td><td style="text-align: left; border:none;"><div class="ba-kop-text"><h5>KEMENTERIAN KESEHATAN REPUBLIK INDONESIA</h5><h5>BADAN PENGEMBANGAN DAN PEMBERDAYAAN SUMBER DAYA MANUSIA KESEHATAN</h5><h5 style="font-size: 1.3em;">POLITEKNIK KESEHATAN KEMENKES KUPANG</h5><p style="font-weight: normal; font-size: 0.9em;">Jalan Piet A. Tallo, Liliba - Kupang, Nusa Tenggara Timur</p></div></td></tr></table>
                </div>
                <div class="ba-judul">
                    <h5>BERITA ACARA</h5><h5>PERUBAHAN KEGIATAN DAN ANGGARAN TAHAP: ${tipeAjuan.toUpperCase()}</h5><p>Nomor: .......................................</p>
                </div>
                <div class="ba-paragraf">
                    Pada hari ini, tanggal ${tglCetak}, telah dilaksanakan pembahasan dan penetapan perubahan usulan kegiatan dan anggaran untuk <strong>${escapeHtml(prodiData.Nama_Prodi)}</strong> Tahun Anggaran ${tahunAnggaran} (${tipeAjuan}).
                    Berdasarkan hasil pembahasan, total anggaran sebelumnya yang diterima adalah Rp ${grandTotalLama.toLocaleString('id-ID')}. Setelah perubahan, total anggaran yang ditetapkan adalah Rp ${grandTotalBaru.toLocaleString('id-ID')}, dengan selisih <strong class="${selisihTotalColor}">${totalSelisih > 0 ? '+' : ''}${totalSelisih.toLocaleString('id-ID')}</strong>. Rincian perubahannya adalah sebagai berikut:
                </div>
                
                <table class="ba-table ba-comparison-table">
                    <thead>
                        <tr>
                            <th rowspan="2" style="width: 3%;">No</th>
                            <th style="width: 47%;">Rincian Ajuan (LAMA / BARU)</th>
                            <th style="width: 10%;">Volume</th>
                            <th style="width: 15%;">Harga Satuan (Rp)</th>
                            <th style="width: 15%;">Total Biaya (Rp)</th>
                            <th rowspan="2" style="width: 10%;">Selisih Biaya (Rp)</th>
                        </tr>
                        <tr>
                            <th colspan="4" style="text-align: left; font-style: italic;">(Baris 1: Data Sebelumnya; Baris 2: Data Final)</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows}
                        <tr>
                            <td colspan="4" style="text-align: right; font-weight: bold;">TOTAL ANGGARAN SEBELUMNYA (LAMA)</td>
                            <td style="text-align: right; font-weight: bold;">${grandTotalLama.toLocaleString('id-ID')}</td>
                            <td rowspan="2" style="vertical-align: middle; font-weight: bold; ${totalSelisih >= 0 ? 'color: green;' : 'color: red;'}">${totalSelisih > 0 ? '+' : ''}${totalSelisih.toLocaleString('id-ID')}</td>
                        </tr>
                        <tr>
                            <td colspan="4" style="text-align: right; font-weight: bold;">TOTAL ANGGARAN DITERIMA (BARU)</td>
                            <td style="text-align: right; font-weight: bold;">${grandTotalBaru.toLocaleString('id-ID')}</td>
                        </tr>
                    </tbody>
                </table>
                
                <div class="ba-paragraf">Demikian Berita Acara ini dibuat untuk dapat dipergunakan sebagaimana mestinya.</div>
                <div class="ba-signatures">
                    <table><tr><td><p>Kupang, ${tglCetak}</p><p><strong>${escapeHtml(ttdKiriJabatan)}</strong></p><br><br><br><br><p><strong><u>${escapeHtml(ttdKiriNama)}</u></strong></p></td><td><p><br></p><p><strong>${escapeHtml(ttdKananJabatan)}</strong></p><br><br><br><br><p><strong><u>${escapeHtml(ttdKananNama)}</u></strong></p></td></tr></table>
                </div>
                </div>
            `;
        }

        if (baGeneratedCount === 0 && targetProdiList.length > 1) {
             throw new Error(`Tidak ada data ajuan "Diterima" dan tidak diblokir yang ditemukan untuk unit manapun pada tahap ${tipeAjuan}.`); 
        }
        container.innerHTML = allProdisHtml;

    } catch (error) {
        container.innerHTML = `<div class="text-center text-danger p-5"><strong>Gagal membuat pratinjau Berita Acara Perubahan:</strong> ${error.message}</div>`;
        showToast(error.message, 'danger');
    } finally {
        showLoader(false);
    }
  }


  // --- OPTIMIZED: loadDashboardData (MODIFIED FOR MULTI-TABLE AGGREGATION) ---
async function loadDashboardData(forceRefresh = false) { 
  showLoader(true); 

  try {
    const selectedYear = getSafeValue('filterTahunDashboard');
    const selectedTipe = getSafeValue('filterTipeDashboard'); 
    
    // TAMBAHAN: Ambil filter unit khusus dashboard
    const selectedProdi = getSafeValue('filterProdiDashboard');

    // Tentukan Tahap Aktif
    const isPerubahanOpen = STATE.globalSettings.Status_Ajuan_Perubahan === 'Dibuka';
    const tahapAktif = STATE.globalSettings.Tahap_Perubahan_Aktif || 1;
    const activePhaseLabel = isPerubahanOpen ? `Perubahan ${tahapAktif}` : 'Awal';
    const activeTableName = getAjuanTableName(activePhaseLabel);

    // MODE PIMPINAN / DIREKTORAT (SUMMARY VIEW)
    // Jika tidak ada filter tahun & tipe, gunakan mode ringkasan tabel prodi_summary
    const isSummaryMode = (STATE.role === 'direktorat' || STATE.role === 'pimpinan') && !selectedYear && !selectedTipe;

    if (isSummaryMode) {
        if (forceRefresh || STATE.direktoratSummaryData.length === 0) {
            let query = sb
                .from(PRODI_SUMMARY_TABLE)
                .select(`id_prodi, pagu_awal_ceiling, total_diterima_awal_bersih, total_diterima_final_bersih, total_rpd_commitment, total_realisasi_overall, rpd_monthly, realisasi_monthly`);
            
            // FILTER PENTING UNTUK PIMPINAN:
            if (selectedProdi) {
                query = query.eq('id_prodi', selectedProdi);
            }

            const { data: summaryData, error: summaryError } = await query;
            if (summaryError) throw summaryError;
            STATE.direktoratSummaryData = summaryData || [];
        }
        STATE.allDashboardData = []; // Clear detailed data
        
    } else {
        // MODE DETAIL (Tabel Ajuan Aktif)
        let targetTable = activeTableName;
        let targetLabel = activePhaseLabel;

        if (selectedTipe === 'Awal') { targetTable = 'ajuan'; targetLabel = 'Awal'; }
        else if (selectedTipe === 'Perubahan') { targetTable = getAjuanTableName(`Perubahan ${tahapAktif}`); targetLabel = `Perubahan ${tahapAktif}`; }
        
        if (forceRefresh || STATE.cachedDashboardData.length === 0) { 
            STATE.allDashboardData = [];
            let query = sb.from(targetTable)
               .select(`ID_Ajuan, ID_Prodi, Total, Status, Tipe_Ajuan, Timestamp, Is_Blocked, ${RPD_SELECT_COLUMNS}`);

             // Filter Logic
             if (STATE.role === 'prodi') {
                 query = query.eq('ID_Prodi', STATE.id); 
             } else if ((STATE.role === 'direktorat' || STATE.role === 'pimpinan') && selectedProdi) {
                 // Pimpinan memfilter berdasarkan dropdown
                 query = query.eq('ID_Prodi', selectedProdi);
             }
            
             if (selectedYear) {
                 const start = `${selectedYear}-01-01 00:00:00`;
                 const end   = `${selectedYear}-12-31 23:59:59`;
                 query = query.gte('Timestamp', start).lte('Timestamp', end);
             }

             const { data: rawData, error } = await query;
             if (!error && rawData) {
                 const processedData = rawData.map(data => {
                    if (data.Timestamp) data.Timestamp = new Date(data.Timestamp); 
                    data.Is_Blocked = !!data.Is_Blocked; 
                    data.ID_Ajuan = String(data.ID_Ajuan || data.id);
                    data.Tipe_Ajuan = targetLabel; 
                    return data;
                 });
                 STATE.allDashboardData = processedData;
             }
            STATE.cachedDashboardData = STATE.allDashboardData;  
        } else {
            if (STATE.cachedDashboardData.length > 0) STATE.allDashboardData = STATE.cachedDashboardData;
        }
    }
    
    processDataForDashboard(); 

  } catch(error) { 
      showToast('Gagal memuat data dashboard.', 'danger'); 
      console.error("Dashboard Error:", error); 
  } finally { 
      showLoader(false); 
  } 
}

  
  function populateDashboardFilters(data) { 
    // FIX 3: Add defensive check for data parameter to prevent TypeError
    const safeData = data || []; 
    const yearSelect = document.getElementById('filterTahunDashboard'); 
    if (!yearSelect) return; 
    
    const years = [...new Set(safeData.map(d => { 
        if(d.Timestamp) return new Date(d.Timestamp).getFullYear(); 
        return null; 
    }))].filter(Boolean).sort((a, b) => b - a); 
    
    // Ensure current year is always an option if no data is present
    const currentYear = new Date().getFullYear();
    if (!years.includes(currentYear)) {
        years.unshift(currentYear);
    }
    
    yearSelect.innerHTML = '<option value="">Semua Tahun</option>'; 
    years.forEach(year => { 
        if (!isNaN(year)) yearSelect.innerHTML += `<option value="${year}">${year}</option>`; 
    }); 
}
  function setupChart(canvasId, type, data, options) { const canvas = document.getElementById(canvasId); if (!canvas) return; if (CHARTS[canvasId]) CHARTS[canvasId].destroy(); CHARTS[canvasId] = new Chart(canvas.getContext('2d'), { type, data, options }); }
  function calculateQuarterlySummary(monthlyData, total) { const quarters = [0, 0, 0, 0]; for (let i = 0; i < 12; i++) { if (i < 3) quarters[0] += monthlyData[i]; else if (i < 6) quarters[1] += monthlyData[i]; else if (i < 9) quarters[2] += monthlyData[i]; else quarters[3] += monthlyData[i]; } return { values: quarters, percentages: quarters.map(q => total > 0 ? ((q /total) * 100).toFixed(1) + '%' : '0.0%') }; }
  
  function calculateSemesterSummary(monthlyData, total) {
    const semesters = [0, 0];
    for (let i = 0; i < 12; i++) {
        if (i < 6) semesters[0] += monthlyData[i]; 
        else semesters[1] += monthlyData[i];      
    }
    return {
        values: semesters,
        percentages: semesters.map(s => total > 0 ? ((s / total) * 100).toFixed(1) + '%' : '0.0%')
    };
  }
  
  function updateDashboardDeadlineInfo() { 
      const deadlineInfoEl = document.getElementById('dashboard-deadline-info'); 
      if (!deadlineInfoEl) return; 
      
      const isPerubahanOpen = STATE.globalSettings.Status_Ajuan_Perubahan === 'Dibuka';
      const tahapAktif = STATE.globalSettings.Tahap_Perubahan_Aktif || 1;
      
      let deadlineTimestamp;
      let deadlineStageName;

      if (isPerubahanOpen) {
          deadlineTimestamp = STATE.globalSettings.Batas_Tanggal_Pengajuan_Perubahan; // NEW SETTING
          deadlineStageName = `Perubahan ${tahapAktif}`;
      } else {
          deadlineTimestamp = STATE.globalSettings.Batas_Tanggal_Pengajuan;
          deadlineStageName = 'Awal';
      }
      
      if (deadlineTimestamp && deadlineTimestamp.toDate) { 
          const deadlineDate = deadlineTimestamp.toDate(); 
          const today = new Date(); 
          today.setHours(0, 0, 0, 0); 
          
          let alertClass = 'alert-info'; 
          let message = `Batas waktu pengajuan <strong>${deadlineStageName}</strong> adalah <strong>${deadlineDate.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</strong>.`; 
          
          if (today > deadlineDate) { 
              alertClass = 'alert-danger'; 
              message = `Periode pengajuan <strong>${deadlineStageName}</strong> telah berakhir pada <strong>${deadlineDate.toLocaleDateString('id-ID', { day: 'numeric', month: 'long' })}</strong>.`; 
          } 
          
          deadlineInfoEl.innerHTML = `<i class="bi bi-info-circle-fill me-2"></i> ${message}`; 
          deadlineInfoEl.className = `alert ${alertClass} text-center small p-2`; 
          deadlineInfoEl.style.display = 'block'; 
          } else { 
          deadlineInfoEl.innerHTML = `<i class="bi bi-info-circle-fill me-2"></i> Batas waktu pengajuan belum ditentukan oleh direktorat.`; 
          deadlineInfoEl.className = 'alert alert-warning text-center small p-2'; 
          deadlineInfoEl.style.display = 'block'; 
      } 
  }
  
  function processDataForDashboard() { 
      updateDashboardDeadlineInfo(); 
      
      const yearSelect = document.getElementById('filterTahunDashboard');
      const tipeSelect = document.getElementById('filterTipeDashboard');
      
      const selectedYear = getSafeValue('filterTahunDashboard'); 
      const selectedTipe = getSafeValue('filterTipeDashboard'); 

      populateDashboardFilters(STATE.cachedDashboardData); 

      const filterInfoEl = document.getElementById('dashboard-filter-info');
      const yearText = yearSelect && selectedYear ? yearSelect.options[yearSelect.selectedIndex].text : "Semua Tahun";
      const tipeText = tipeSelect && selectedTipe ? tipeSelect.options[tipeSelect.selectedIndex].text : "Semua Tipe Ajuan";
      if(filterInfoEl) filterInfoEl.innerHTML = `Menampilkan data untuk: <strong>${yearText}</strong> & <strong>${tipeText}</strong>`;
      if(filterInfoEl) filterInfoEl.style.display = 'block';

      let filteredData = STATE.allDashboardData;
      
      if (STATE.allDashboardData.length > 0 && selectedTipe) {
          filteredData = STATE.allDashboardData.filter(d => { 
              const isPerubahanMatch = selectedTipe === 'Perubahan' && (d.Tipe_Ajuan || '').startsWith('Perubahan');
              const isAwalMatch = selectedTipe === 'Awal' && d.Tipe_Ajuan === 'Awal';
              return isPerubahanMatch || isAwalMatch;
          }); 
      }
      
      // Elemen Kartu Dashboard
      const diajukanCard = document.getElementById('card-diajukan');
      const diterimaCard = document.getElementById('card-diterima');
      const paguCard = document.getElementById('dashboard-total-pagu-card');
      const rpdCard = document.getElementById('card-rpd-realisasi');
      const direktoratCharts = document.getElementById('direktorat-charts');
      const statusCards = document.getElementById('direktorat-status-cards-container');
      const tableContainer = document.getElementById('direktorat-summary-table-container');
      
      const isDirectorateSummaryMode = (STATE.role === 'direktorat' || STATE.role === 'pimpinan') && !selectedYear && !selectedTipe;

      // --- LOGIKA VISIBILITAS KARTU ---

      if (STATE.role === 'pimpinan') {
          // PIMPINAN: Sembunyikan kartu detail, tampilkan Chart & Summary Table
          if (diajukanCard) diajukanCard.style.display = 'none';
          if (diterimaCard) diterimaCard.style.display = 'none';
          if (paguCard) paguCard.style.display = 'none'; 
          
          if (rpdCard) {
              rpdCard.style.display = 'block';
              rpdCard.classList.remove('col-xl-3', 'col-md-6');
              rpdCard.classList.add('col-12'); 
          }
          if (direktoratCharts) direktoratCharts.style.display = 'block';
          if (statusCards) statusCards.style.display = 'none';

      } else if (isDirectorateSummaryMode) {
          // DIREKTORAT (Mode Ringkasan): Sembunyikan kartu detail, tampilkan Summary Table & Status Cards
          if (diajukanCard) diajukanCard.style.display = 'none';
          if (diterimaCard) diterimaCard.style.display = 'none';
          if (paguCard) paguCard.style.display = 'none'; 
          
          if (rpdCard) {
              rpdCard.classList.remove('col-xl-3', 'col-md-6');
              rpdCard.classList.add('col-12'); 
          }
          if (direktoratCharts) direktoratCharts.style.display = 'block';
          if (statusCards) statusCards.style.display = 'flex'; 

      } else { 
          // --- LOGIKA UNTUK PRODI (Dan Direktorat mode Filter) ---
          
          // 1. Kartu Pagu (Status Anggaran)
          if (paguCard) paguCard.style.display = 'block'; 

          // 2. Kartu Diajukan & Diterima: SEMBUNYIKAN JIKA PRODI
          if (STATE.role === 'prodi') {
              if (diajukanCard) diajukanCard.style.display = 'none'; // Hapus Total Diajukan
              if (diterimaCard) diterimaCard.style.display = 'none'; // Hapus Total Diterima
          } else {
              // Jika Direktorat dengan filter, tetap tampilkan
              if (diajukanCard) diajukanCard.style.display = 'block';
              if (diterimaCard) diterimaCard.style.display = 'block';
          }
          
          // 3. Grafik RPD vs Realisasi
          if (rpdCard) {
              rpdCard.classList.remove('col-12');
              rpdCard.classList.add('col-xl-3', 'col-md-6');
              rpdCard.style.display = 'block';
          }

          if (direktoratCharts) direktoratCharts.style.display = STATE.role === 'direktorat' ? 'block' : 'none';
      }
      
      renderDashboardSummary(filteredData); 
      
      // Logika Tabel Ringkasan Unit
      if (STATE.role === 'direktorat' || STATE.role === 'pimpinan') { 
          if (STATE.role === 'pimpinan' || isDirectorateSummaryMode) {
              renderDirektoratDashboard(STATE.direktoratSummaryData); 
              if (tableContainer) tableContainer.style.display = 'block';
          } else {
              if (tableContainer) tableContainer.innerHTML = '';
              if (statusCards) statusCards.innerHTML = '<div class="col-12"><p class="text-center text-muted small">Tabel ringkasan per unit dinonaktifkan saat filter waktu atau tipe ajuan diterapkan.</p></div>';
          }
      } 
  }

 function renderDashboardSummary(data, containerPrefix = 'dashboard-', chartPrefix = 'chart') { 
    
 let totalDiajukanOverall = 0;
    let totalDiterimaOverall = 0; 
    let statusCounts = { 'Menunggu Review': 0, 'Diterima': 0, 'Ditolak': 0, 'Revisi': 0 }; 
    const rpdPerBulan = Array(12).fill(0); 
    const realisasiPerBulan = Array(12).fill(0); 

    data.forEach(ajuan => { 
        const total = Number(ajuan.Total) || 0;
        const isBlocked = !!ajuan.Is_Blocked;
        
        totalDiajukanOverall += total;

        if (ajuan.Status) statusCounts[ajuan.Status] = (statusCounts[ajuan.Status] || 0) + 1; 
        
        if (ajuan.Status === 'Diterima' && !isBlocked) { 
            totalDiterimaOverall += total;
            RPD_MONTHS.forEach((month, index) => { 
                const rpdVal = Number(ajuan[getMonthlyKey('RPD', month)]) || 0;
                const realVal = Number(ajuan[getMonthlyKey('Realisasi', month)]) || 0;
                rpdPerBulan[index] += rpdVal;
                realisasiPerBulan[index] += realVal;
            }); 
        } 
    }); 
    
    let totalRPD = rpdPerBulan.reduce((a, b) => a + b, 0);
    let totalRealisasi = realisasiPerBulan.reduce((a, b) => a + b, 0);
    // End Aggregation Logic

    // --- LOGIC BARU UNTUK SUMMARY DIREKTORAT (FAST VIEW) ---
    let paguSebelumDisplay = 0;
    let paguSekarangDisplay = 0;
    
    const isDirectorateSummaryMode = STATE.role === 'direktorat' && !getSafeValue('filterTahunDashboard') && !getSafeValue('filterTipeDashboard');

    if (isDirectorateSummaryMode) {
        // Ambil dari prodi_summary
        paguSebelumDisplay = STATE.direktoratSummaryData.reduce((sum, p) => sum + (Number(p.total_diterima_awal_bersih) || 0), 0);
        paguSekarangDisplay = STATE.direktoratSummaryData.reduce((sum, p) => sum + (Number(p.total_diterima_final_bersih) || 0), 0);
        totalRPD = STATE.direktoratSummaryData.reduce((sum, p) => sum + (Number(p.total_rpd_commitment) || 0), 0);
        totalRealisasi = STATE.direktoratSummaryData.reduce((sum, p) => sum + (Number(p.total_realisasi_overall) || 0), 0);
        
        // Reset array bulanan untuk chart
        rpdPerBulan.fill(0); realisasiPerBulan.fill(0);
        STATE.direktoratSummaryData.forEach(p => {
             if (p.rpd_monthly && p.realisasi_monthly) {
                 RPD_MONTHS.forEach((month, index) => {
                     rpdPerBulan[index] += Number(p.rpd_monthly[getMonthlyKey('RPD', month)]) || 0;
                     realisasiPerBulan[index] += Number(p.realisasi_monthly[getMonthlyKey('Realisasi', month)]) || 0;
                 });
            }
        });
    } else {
        // Mode Prodi / Filter: Pagu Sekarang = Total Diterima dari tabel aktif
        paguSekarangDisplay = totalDiterimaOverall;
        
        // Pagu Sebelum: Logic manual untuk Prodi
        const isPerubahanOpen = STATE.globalSettings.Status_Ajuan_Perubahan === 'Dibuka';
        if (STATE.role === 'prodi') {
             if (isPerubahanOpen) {
                 // Ambil dari Pagu Sebelum di summary row prodi (harus di fetch terpisah atau asumsi user data)
                 // Simplifikasi: Pagu Sebelum = totalDiterimaAwalBersih di summary table (jika ada)
                 // Namun karena ini view tabel raw, kita gunakan nilai calculated local jika memungkinkan, atau hardcode 0 jika rumit.
                 // Better approach: User Pagu_Anggaran is always Ceiling.
                 paguSebelumDisplay = STATE.currentUserData.Pagu_Anggaran || 0; // Fallback visual
             } else {
                 paguSebelumDisplay = STATE.currentUserData.Pagu_Anggaran || 0;
             }
        }
    }

    // --- UPDATE UI TEXT & LABELS ---
    const isPerubahanOpen = STATE.globalSettings.Status_Ajuan_Perubahan === 'Dibuka';
    const activeLabel = isPerubahanOpen ? `Perubahan ${STATE.globalSettings.Tahap_Perubahan_Aktif || 1}` : 'Awal';
    
    // Label Dinamis
    const paguLabelEl = document.getElementById('dashboard-pagu-label');
    if(paguLabelEl) paguLabelEl.textContent = "Status Anggaran (" + activeLabel + ")";

    // Kartu Pagu
    // Label: Pagu Sebelum (Awal/Lama)
    const paguAwalEl = document.getElementById('dashboard-total-pagu-awal');
    if (paguAwalEl) {
        paguAwalEl.parentElement.innerHTML = `Pagu Sebelum: <strong id="dashboard-total-pagu-awal">Rp ${paguSebelumDisplay.toLocaleString('id-ID')}</strong>`;
    }

    // Label: Pagu Sekarang (Aktif)
    const paguPerubahanEl = document.getElementById('dashboard-total-pagu-perubahan');
    if (paguPerubahanEl) {
        paguPerubahanEl.parentElement.innerHTML = `Pagu Aktif (${activeLabel}): <strong id="dashboard-total-pagu-perubahan">Rp ${paguSekarangDisplay.toLocaleString('id-ID')}</strong>`;
    }

    // Update Angka Utama Pagu Card (Total Pagu Sekarang)
    const totalPaguTotalEl = document.getElementById(`${containerPrefix}total-pagu-total`);
    if (totalPaguTotalEl) totalPaguTotalEl.textContent = 'Rp ' + paguSekarangDisplay.toLocaleString('id-ID');

    // Kartu Lainnya
    const totalDiajukanTotalEl = document.getElementById(`${containerPrefix}total-diajukan-total`);
    if (totalDiajukanTotalEl) totalDiajukanTotalEl.textContent = 'Rp ' + totalDiajukanOverall.toLocaleString('id-ID'); 
    
    // Sembunyikan breakdown Awal/Perubahan di kartu Diajukan (karena kita hanya lihat aktif)
    const diajukanBreakdown = document.getElementById('dashboard-diajukan-breakdown');
    if(diajukanBreakdown) diajukanBreakdown.style.display = 'none';

    const totalDiterimaTotalEl = document.getElementById(`${containerPrefix}total-diterima-total`);
    if (totalDiterimaTotalEl) totalDiterimaTotalEl.textContent = 'Rp ' + paguSekarangDisplay.toLocaleString('id-ID');
    
    // Hide breakdown diterima
    const diterimaBreakdown = document.getElementById('dashboard-diterima-breakdown');
    if(diterimaBreakdown) diterimaBreakdown.style.display = 'none';

    // RPD & Realisasi
    const totalRPDEl = document.getElementById(`${containerPrefix}total-rpd`);
    const totalRealisasiEl = document.getElementById(`${containerPrefix}total-realisasi`);
    if(totalRPDEl) totalRPDEl.textContent = 'Rp ' + totalRPD.toLocaleString('id-ID'); 
    if(totalRealisasiEl) totalRealisasiEl.textContent = 'Rp ' + totalRealisasi.toLocaleString('id-ID'); 

    // Chart & Progress
    setupChart(`${chartPrefix}RPDvsRealisasi`, 'bar', { 
        labels: RPD_MONTHS, 
        datasets: [
            { label: 'Realisasi (Rp)', data: realisasiPerBulan, backgroundColor: 'rgba(255, 193, 7, 0.7)' }, 
            { label: 'RPD (Rp)', data: rpdPerBulan, backgroundColor: 'rgba(13, 110, 253, 0.6)' }
        ] 
    }, { responsive: true, scales: { x: { stacked: false }, y: { stacked: false, beginAtZero: true } } });

    const persentaseRealisasi = totalRPD > 0 ? (totalRealisasi / totalRPD) * 100 : 0; 
    const persenRealisasiEl = document.getElementById('dashboard-persen-realisasi');
    if (persenRealisasiEl) persenRealisasiEl.textContent = persentaseRealisasi.toFixed(1) + '%'; 
    const progressBar = document.getElementById('dashboard-persen-realisasi-bar'); 
    if (progressBar) progressBar.style.width = `${Math.min(persentaseRealisasi, 100)}%`;
    
    // Status Counts
    const countMenungguEl = document.getElementById(`${containerPrefix}count-menunggu`);
    if(countMenungguEl) countMenungguEl.textContent = statusCounts['Menunggu Review']; 
    const countDiterimaEl = document.getElementById(`${containerPrefix}count-diterima`);
    if(countDiterimaEl) countDiterimaEl.textContent = statusCounts['Diterima']; 
    const countDitolakEl = document.getElementById(`${containerPrefix}count-ditolak`);
    if(countDitolakEl) countDitolakEl.textContent = statusCounts['Ditolak']; 
    const countRevisiEl = document.getElementById(`${containerPrefix}count-revisi`);
    if(countRevisiEl) countRevisiEl.textContent = statusCounts['Revisi']; 
    
    // Render Tabel Triwulan/Semester (Copy existing logic)
    const rpdTriwulan = calculateQuarterlySummary(rpdPerBulan, totalRPD); 
    const realisasiTriwulan = calculateQuarterlySummary(realisasiPerBulan, totalRealisasi); 
    const triwulanContainer = document.getElementById('dashboard-triwulan-summaries'); 
    if (triwulanContainer) { 
       triwulanContainer.innerHTML = `<h6 class="small text-muted">RPD (${activeLabel})</h6><table class="table table-sm table-borderless text-center small"><thead class="table-light"><tr><th>Q</th><th>Total</th><th>%</th></tr></thead><tbody>${rpdTriwulan.values.map((val, i) => `<tr><td>Q${i+1}</td><td>${val.toLocaleString('id-ID')}</td><td><span class="badge bg-primary-subtle text-primary-emphasis">${rpdTriwulan.percentages[i]}</span></td></tr>`).join('')}</tbody></table><h6 class="small text-muted mt-2">Realisasi (${activeLabel})</h6><table class="table table-sm table-borderless text-center small"><thead class="table-light"><tr><th>Q</th><th>Total</th><th>%</th></tr></thead><tbody>${realisasiTriwulan.values.map((val, i) => `<tr><td>Q${i+1}</td><td>${val.toLocaleString('id-ID')}</td><td><span class="badge bg-success-subtle text-success-emphasis">${realisasiTriwulan.percentages[i]}</span></td></tr>`).join('')}</tbody></table>`; 
    }
    const rpdSemester = calculateSemesterSummary(rpdPerBulan, totalRPD);
    const realisasiSemester = calculateSemesterSummary(realisasiPerBulan, totalRealisasi);
    const semesterContainer = document.getElementById('dashboard-semester-summaries');
    if (semesterContainer) {
       semesterContainer.innerHTML = `<h6 class="small text-muted">RPD (${activeLabel})</h6><table class="table table-sm table-borderless text-center small"><thead class="table-light"><tr><th>S</th><th>Total</th><th>%</th></tr></thead><tbody>${rpdSemester.values.map((val, i) => `<tr><td>S${i+1}</td><td>${val.toLocaleString('id-ID')}</td><td><span class="badge bg-primary-subtle text-primary-emphasis">${rpdSemester.percentages[i]}</span></td></tr>`).join('')}</tbody></table><h6 class="small text-muted mt-2">Realisasi (${activeLabel})</h1><table class="table table-sm table-borderless text-center small"><thead class="table-light"><tr><th>S</th><th>Total</th><th>%</th></tr></thead><tbody>${realisasiSemester.values.map((val, i) => `<tr><td>S${i+1}</td><td>${val.toLocaleString('id-ID')}</td><td><span class="badge bg-success-subtle text-success-emphasis">${realisasiSemester.percentages[i]}</span></td></tr>`).join('')}</tbody></table>`;
    }
}
  
function renderDirektoratDashboard(summaryData) {
    
    // Collect data per Prodi
    const allProdiMap = (STATE.allProdi || [])
        .filter(p => p.Role === 'prodi')
        .reduce((acc, p) => { acc[p.ID_Prodi] = p; return acc; }, {});

    // Map summary data to the structure needed for rendering the table/cards
    const dashboardData = summaryData.map(item => {
        const prodiInfo = allProdiMap[item.id_prodi] || { Nama_Prodi: item.id_prodi };
        
        // Extract monthly realisasi from JSONB
        const realisasiMonthly = item.realisasi_monthly || {};
        const realisasiPerBulan = RPD_MONTHS.map(m => Number(realisasiMonthly[getMonthlyKey('Realisasi', m)]) || 0);

        const tw = [
            realisasiPerBulan[0] + realisasiPerBulan[1] + realisasiPerBulan[2], 
            realisasiPerBulan[3] + realisasiPerBulan[4] + realisasiPerBulan[5], 
            realisasiPerBulan[6] + realisasiPerBulan[7] + realisasiPerBulan[8], 
            realisasiPerBulan[9] + realisasiPerBulan[10] + realisasiPerBulan[11] 
        ];
        
        const semester = [
            tw[0] + tw[1], 
            tw[2] + tw[3]  
        ];

        const paguAwal = Number(item.pagu_awal_ceiling) || 0;
        const paguSekarang = Number(item.total_diterima_final_bersih) || 0;
        const totalRealisasi = Number(item.total_realisasi_overall) || 0;
        const totalRPDCommitment = Number(item.total_rpd_commitment) || 0;
        const totalDiterimaAwalBersih = Number(item.total_diterima_awal_bersih) || 0;
        
        const Sisa_Belum_RPD = paguSekarang - totalRPDCommitment;
        const Sisa_Belum_Realisasi = totalRPDCommitment - totalRealisasi;
        const Selisih_Pagu_Bersih = paguSekarang - totalDiterimaAwalBersih;
        
        return {
            Nama_Prodi: prodiInfo.Nama_Prodi,
            ID_Prodi: item.id_prodi,
            Pagu_Awal: paguAwal, 
            Pagu_Sebelum_Bersih: totalDiterimaAwalBersih, 
            Pagu_Sekarang: paguSekarang, 
            Selisih_Pagu: Selisih_Pagu_Bersih, 
            Total_RPD: totalRPDCommitment,
            
            Realisasi_TW1: tw[0],
            Realisasi_TW2: tw[1],
            Realisasi_TW3: tw[2],
            Realisasi_TW4: tw[3],
            Realisasi_S1: semester[0],
            Realisasi_S2: semester[1],
            Total_Realisasi: totalRealisasi,
            
            Sisa_Belum_RPD: Sisa_Belum_RPD,
            Sisa_Belum_Realisasi: Sisa_Belum_Realisasi,
        };
    });
    
    renderProdiStatusCards(dashboardData);
    renderDirektoratSummaryTable(dashboardData);
}

// --- GANTI FUNGSI renderDirektoratSummaryTable DENGAN INI ---

function renderDirektoratSummaryTable(summaryData) {
    const container = document.getElementById('direktorat-summary-table-container');
    if (!container) return;

    // Safety check: jika data kosong/undefined
    if (!summaryData || summaryData.length === 0) {
        container.innerHTML = '<div class="text-center text-muted p-3">Tidak ada data untuk ditampilkan.</div>';
        return;
    }
      
    const getPeriodPercentage = (amount, total) => {
        const percentage = total > 0 ? (amount / total) * 100 : 0;
        return `<span class="badge bg-light text-dark fw-normal">${percentage.toFixed(1)}%</span>`;
    };

    // Helper aman untuk format angka (mencegah error toLocaleString of undefined)
    const safeFmt = (val) => (Number(val) || 0).toLocaleString('id-ID');

    let tableHTML = `
        <div class="table-responsive">
            <table class="table table-sm table-bordered table-striped small align-middle table-hover" id="table-export-direktorat-summary" style="min-width: 2350px;">
                <thead class="table-light">
                    <tr>
                        <th rowspan="2" class="align-middle text-center">No.</th>
                        <th rowspan="2" class="align-middle" style="min-width: 150px;">Nama Unit</th>
                        <th colspan="4" class="text-center">Pagu & RPD Anggaran (Rp)</th>
                        <th colspan="12" class="text-center">Realisasi (Rp)</th>
                        <th rowspan="2" class="align-middle text-end" style="min-width: 130px;">Total Realisasi (Rp)</th>
                        <th rowspan="2" class="align-middle text-center" style="min-width: 100px;">% Realisasi</th>
                    </tr>
                    <tr>
                        <th class="text-end" style="min-width: 130px;">Pagu Awal (Ceiling)</th>
                        <th class="text-end" style="min-width: 130px;">Pagu Sekarang (Diterima)</th>
                        <th class="text-end" style="min-width: 100px;">Selisih Pagu</th>
                        <th class="text-end" style="min-width: 130px;">Total RPD</th>
                        <th class="text-end">TW 1</th><th class="text-center">%</th>
                        <th class="text-end">TW 2</th><th class="text-center">%</th>
                        <th class="text-end">TW 3</th><th class="text-center">%</th>
                        <th class="text-end">TW 4</th><th class="text-center">%</th>
                        <th class="text-end" style="min-width: 110px;">Smt 1</th><th class="text-center">%</th>
                        <th class="text-end" style="min-width: 110px;">Smt 2</th><th class="text-center">%</th>
                    </tr>
                </thead>
                <tbody>
    `;
    
    // PERBAIKAN DI SINI: Menambahkan Total_RPD ke inisialisasi object
    let grandTotals = {
        Pagu_Awal: 0, 
        Pagu_Sekarang: 0, 
        Selisih_Pagu: 0, 
        Total_RPD: 0,         // <-- SEBELUMNYA HILANG, MENYEBABKAN ERROR
        Total_Realisasi: 0,
        Realisasi_TW1: 0, 
        Realisasi_TW2: 0, 
        Realisasi_TW3: 0, 
        Realisasi_TW4: 0,
        Realisasi_S1: 0, 
        Realisasi_S2: 0
    };

    summaryData.sort((a, b) => a.ID_Prodi.localeCompare(b.ID_Prodi)).forEach((item, index) => {
        const selisihClass = item.Selisih_Pagu > 0 ? 'text-success' : (item.Selisih_Pagu < 0 ? 'text-danger' : '');
        
        // Akumulasi Grand Total
        Object.keys(grandTotals).forEach(key => {
            // Pastikan nilai dijumlahkan sebagai angka
            grandTotals[key] += (Number(item[key]) || 0);
        });

        const percentage = item.Pagu_Sekarang > 0 ? ((item.Total_Realisasi / item.Pagu_Sekarang) * 100) : 0;
        const percentageText = percentage.toFixed(1);
        const progressColor = percentage >= 90 ? 'bg-success' : (percentage >= 70 ? 'bg-warning' : 'bg-danger');

        tableHTML += `
            <tr class="prodi-indicator" style="border-left-color: ${getColorForProdi(item.ID_Prodi)};">
                <td class="text-center">${index + 1}</td>
                <td>${escapeHtml(item.Nama_Prodi)} <span class="small text-muted d-block">${item.ID_Prodi}</span></td>
                <td class="text-end">${safeFmt(item.Pagu_Awal)}</td>
                <td class="text-end fw-bold">${safeFmt(item.Pagu_Sekarang)}</td>
                <td class="text-end ${selisihClass} fw-bold">${safeFmt(item.Selisih_Pagu)}</td>
                <td class="text-end text-info fw-bold">${safeFmt(item.Total_RPD)}</td>
                
                <td class="text-end">${safeFmt(item.Realisasi_TW1)}</td>
                <td class="text-center">${getPeriodPercentage(item.Realisasi_TW1, item.Pagu_Sekarang)}</td>
                
                <td class="text-end">${safeFmt(item.Realisasi_TW2)}</td>
                <td class="text-center">${getPeriodPercentage(item.Realisasi_TW2, item.Pagu_Sekarang)}</td>
                
                <td class="text-end">${safeFmt(item.Realisasi_TW3)}</td>
                <td class="text-center">${getPeriodPercentage(item.Realisasi_TW3, item.Pagu_Sekarang)}</td>
                
                <td class="text-end">${safeFmt(item.Realisasi_TW4)}</td>
                <td class="text-center">${getPeriodPercentage(item.Realisasi_TW4, item.Pagu_Sekarang)}</td>

                <td class="text-end fw-bold">${safeFmt(item.Realisasi_S1)}</td>
                <td class="text-center">${getPeriodPercentage(item.Realisasi_S1, item.Pagu_Sekarang)}</td>

                <td class="text-end fw-bold">${safeFmt(item.Realisasi_S2)}</td>
                <td class="text-center">${getPeriodPercentage(item.Realisasi_S2, item.Pagu_Sekarang)}</td>

                <td class="text-end text-primary fw-bold">${safeFmt(item.Total_Realisasi)}</td>
                <td class="text-center">
                    <div class="progress" role="progressbar" title="${percentageText}%" style="height: 18px; font-size: 0.75rem;">
                        <div class="progress-bar ${progressColor} text-dark" style="width: ${Math.min(percentage, 100)}%">${percentageText}%</div>
                    </div>
                </td>
            </tr>
        `;
    });
    
    const overallSelisihClass = grandTotals.Selisih_Pagu > 0 ? 'text-success' : (grandTotals.Selisih_Pagu < 0 ? 'text-danger' : '');
    const grandTotalPercentage = grandTotals.Pagu_Sekarang > 0 ? ((grandTotals.Total_Realisasi / grandTotals.Pagu_Sekarang) * 100) : 0;
    const grandTotalPercentageText = grandTotalPercentage.toFixed(1);

    // Menggunakan safeFmt di sini untuk mencegah error
    tableHTML += `
        <tr class="table-dark">
            <td colspan="2" class="text-end fw-bold">TOTAL KESELURUHAN</td>
            <td class="text-end fw-bold">${safeFmt(grandTotals.Pagu_Awal)}</td>
            <td class="text-end fw-bold">${safeFmt(grandTotals.Pagu_Sekarang)}</td>
            <td class="text-end fw-bold ${overallSelisihClass}">${safeFmt(grandTotals.Selisih_Pagu)}</td>
            <td class="text-end fw-bold">${safeFmt(grandTotals.Total_RPD)}</td>
            
            <td class="text-end fw-bold">${safeFmt(grandTotals.Realisasi_TW1)}</td>
            <td class="text-center">${getPeriodPercentage(grandTotals.Realisasi_TW1, grandTotals.Pagu_Sekarang)}</td>
            
            <td class="text-end fw-bold">${safeFmt(grandTotals.Realisasi_TW2)}</td>
            <td class="text-center">${getPeriodPercentage(grandTotals.Realisasi_TW2, grandTotals.Pagu_Sekarang)}</td>
            
            <td class="text-end fw-bold">${safeFmt(grandTotals.Realisasi_TW3)}</td>
            <td class="text-center">${getPeriodPercentage(grandTotals.Realisasi_TW3, grandTotals.Pagu_Sekarang)}</td>
            
            <td class="text-end fw-bold">${safeFmt(grandTotals.Realisasi_TW4)}</td>
            <td class="text-center">${getPeriodPercentage(grandTotals.Realisasi_TW4, grandTotals.Pagu_Sekarang)}</td>
            
            <td class="text-end fw-bold">${safeFmt(grandTotals.Realisasi_S1)}</td>
            <td class="text-center">${getPeriodPercentage(grandTotals.Realisasi_S1, grandTotals.Pagu_Sekarang)}</td>
            
            <td class="text-end fw-bold">${safeFmt(grandTotals.Realisasi_S2)}</td>
            <td class="text-center">${getPeriodPercentage(grandTotals.Realisasi_S2, grandTotals.Pagu_Sekarang)}</td>

            <td class="text-end fw-bold">${safeFmt(grandTotals.Total_Realisasi)}</td>
            <td class="text-center fw-bold"><span class="badge bg-light text-dark">${grandTotalPercentageText}%</span></td>
        </tr>
    `;

    tableHTML += `</tbody></table></div>`;
    container.innerHTML = tableHTML;
    
    safeAddClickListener('btn-export-excel-direktorat-summary', () => exportTableToExcel('table-export-direktorat-summary', 'Ringkasan_Direktorat'));
}
  
function renderProdiStatusCards(summaryData) {
      const container = document.getElementById('direktorat-status-cards-container');
      if (!container) return;

      if (summaryData.length === 0) {
          container.innerHTML = '<div class="col-12"><p class="text-center text-muted small">Tidak ada data untuk tahap aktif ini.</p></div>';
          return;
      }
      
      summaryData.sort((a, b) => a.ID_Prodi.localeCompare(b.ID_Prodi));
      
      let html = summaryData.map(item => {
          const prodiColor = getColorForProdi(item.ID_Prodi);
          
          // Field Mapping dari recalculateProdiSummary:
          // Pagu_Sebelum_Bersih (total_diterima_awal_bersih) -> Baseline sebelumnya
          // Pagu_Sekarang (total_diterima_final_bersih) -> Aktif Sekarang
          
          const paguSebelum = item.Pagu_Sebelum_Bersih; 
          const paguSekarang = item.Pagu_Sekarang; 
          
          // Selisih = Sekarang - Sebelum
          const selisih = paguSekarang - paguSebelum;
          
          const totalRealisasi = item.Total_Realisasi;
          const sisaBelumRPD = item.Sisa_Belum_RPD;
          const sisaBelumRealisasi = item.Sisa_Belum_Realisasi;
          
          const selisihClass = selisih >= 0 ? 'text-success' : 'text-danger';
          const rpdSisaClass = sisaBelumRPD < 0 ? 'text-danger' : 'text-white'; 
          const realisasiSisaClass = sisaBelumRealisasi < 0 ? 'text-danger' : 'text-white';

          const realisasiPercent = paguSekarang > 0 
              ? ((totalRealisasi / paguSekarang) * 100).toFixed(1)
              : '0.0';

          return `
            <div class="col-xl-3 col-lg-4 col-md-6 col-sm-6">
                <div class="card card-prodi-status" style="background-color: ${prodiColor};">
                    <h6>${escapeHtml(item.Nama_Prodi)} (${item.ID_Prodi})</h6>
                    <hr class="mt-0 mb-2 border-light opacity-50">
                    <div class="row g-2">
                        
                        <div class="col-12 border-bottom border-light opacity-50 pb-2">
                            <span class="sub-metric">Pagu Sebelum</span>
                            <span class="metric-value d-block">Rp ${paguSebelum.toLocaleString('id-ID')}</span>
                        </div>

                        <div class="col-12 border-bottom border-light opacity-50 pb-2">
                            <span class="sub-metric">Pagu Aktif (Sekarang)</span>
                            <div class="d-flex justify-content-between align-items-baseline">
                                <span class="metric-value">Rp ${paguSekarang.toLocaleString('id-ID')}</span>
                                <span class="badge ${selisihClass}" style="background-color: rgba(255,255,255,0.3); font-size: 0.75em;" title="Selisih">
                                    ${selisih >= 0 ? '+' : ''}${selisih.toLocaleString('id-ID')}
                                </span>
                            </div>
                        </div>
                        
                        <div class="col-6">
                            <span class="sub-metric d-block">Total RPD</span>
                            <span class="metric-value small">Rp ${item.Total_RPD.toLocaleString('id-ID')}</span>
                        </div>
                        <div class="col-6">
                            <span class="sub-metric d-block">Total Realisasi</span>
                            <span class="metric-value small">Rp ${totalRealisasi.toLocaleString('id-ID')}</span>
                        </div>
                        
                        <div class="col-6 border-top border-light opacity-50 pt-2">
                            <span class="sub-metric d-block">Sisa Blm RPD</span>
                            <span class="metric-value small ${rpdSisaClass}">Rp ${sisaBelumRPD.toLocaleString('id-ID')}</span>
                        </div>
                        <div class="col-6 border-top border-light opacity-50 pt-2">
                            <span class="sub-metric d-block">Sisa Blm Realisasi</span>
                            <span class="metric-value small ${realisasiSisaClass}">Rp ${sisaBelumRealisasi.toLocaleString('id-ID')}</span>
                        </div>
                        
                        <div class="col-12 mt-3 pt-2 border-top border-light opacity-50">
                            <div class="d-flex justify-content-between align-items-center">
                                <span class="sub-metric">Persentase Realisasi</span>
                                <span class="fs-4 fw-bold">${realisasiPercent}%</span>
                            </div>
                            <div class="progress mt-1" role="progressbar" style="height: 6px;">
                                <div class="progress-bar ${realisasiPercent >= 90 ? 'bg-success' : (realisasiPercent >= 70 ? 'bg-warning' : 'bg-danger')}" style="width: ${Math.min(parseFloat(realisasiPercent), 100)}%;"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
          `;
          }).join('');
      
      container.innerHTML = html;
}
  
  // ------------------------------------------------------------------
  // --- START MANAJEMEN GRUB BELANJA UTAMA (MIGRATED TO SUPABASE) ---
  // ------------------------------------------------------------------
  
  function clearGrubBelanjaForm() { 
      setElValue('mg_ID', ''); 
      setElValue('mg_Nama', ''); 
      const idEl = document.getElementById('mg_ID');
      if (idEl) idEl.readOnly = false;
  }
  
  window.fillEditGrubBelanja = (id, nama) => { 
      setElValue('mg_ID', id); 
      setElValue('mg_Nama', nama); 
      const idEl = document.getElementById('mg_ID');
      if (idEl) idEl.readOnly = true;
  };

  safeAddClickListener('btn-new-grub-belanja', () => {
      clearGrubBelanjaForm();
      const namaEl = document.getElementById('mg_Nama');
      if (namaEl) namaEl.focus();
  });

  safeAddClickListener('btn-save-grub-belanja', async () => { 
    const id = getSafeValue('mg_ID').trim(); 
    const nama = getSafeValue('mg_Nama').trim(); 
    const idEl = document.getElementById('mg_ID');
    const isNew = idEl ? !idEl.readOnly : true;
    
    if (!id || !nama) { showToast('ID dan Nama Grub Belanja wajib diisi.', 'warning'); return; } 
    showLoader(true); 
    try { 
        // Supabase Upsert
        const { error } = await sb.from('grub_belanja')
            .upsert({ ID_Grub: id, Nama_Grub: nama }, { onConflict: 'ID_Grub' }); 
            
        if (error) throw error;
        
        showToast(`Grub Belanja berhasil di${isNew ? 'tambah' : 'perbarui'}.`); 
        clearGrubBelanjaForm(); 
        localStorage.removeItem('cache_allGrubBelanja'); 
        await refreshGrubBelanjaData(); 
    } catch (error) { 
        showToast(`Gagal menyimpan Grub Belanja: ${error.message}`, 'danger'); 
    } finally { 
        showLoader(false); 
    } 
  });
  
  window.deleteGrubBelanja = async (id) => { 
    if (confirm(`Yakin ingin menghapus Grub Belanja "${id}"? Ajuan yang terkait mungkin menjadi tidak valid.`)) { 
        showLoader(true); 
        try { 
            // Supabase Delete
            const { error } = await sb.from('grub_belanja').delete().eq('ID_Grub', id); 
            if (error) throw error;
            
            showToast(`Grub Belanja "${id}" berhasil dihapus.`); 
            clearGrubBelanjaForm(); 
            localStorage.removeItem('cache_allGrubBelanja'); 
            await refreshGrubBelanjaData(); 
        } catch (error) { 
            showToast(`Gagal menghapus Grub Belanja: ${error.message}`, 'danger'); 
            } finally { 
            showLoader(false); 
        } 
    } 
  };

  const uploadGrubBelanjaInput = document.getElementById('input-upload-excel-grub');
  if (uploadGrubBelanjaInput) {
      uploadGrubBelanjaInput.addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (!file) return;
          showLoader(true);
          const reader = new FileReader();
          reader.onload = async (event) => {
              try {
                  const data = new Uint8Array(event.target.result);
                  const workbook = XLSX.read(data, {
                      type: 'array'
                  });
                  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                  const jsonData = XLSX.utils.sheet_to_json(firstSheet, {
                      header: 1
                  });
                  if (jsonData.length < 2 || jsonData[0][0] !== 'ID_Grub' || jsonData[0][1] !== 'Nama_Grub') {
                      throw new Error('Format file tidak sesuai. Pastikan header baris pertama adalah ID_Grub dan Nama_Grub.');
                  }
                  
                  let importData = [];
                  let count = 0;
                  for (let i = 1; i < jsonData.length; i++) {
                      const row = jsonData[i];
                      const id = String(row[0] || '').trim();
                      const nama = String(row[1] || '').trim();
                      if (id && nama) {
                          // Pastikan kolom sesuai dengan Supabase
                          importData.push({ ID_Grub: id, Nama_Grub: nama });
                          count++;
                      }
                  }
                  if (count === 0) {
                      throw new Error("Tidak ada data valid untuk diimport.");
                  }
                  
                  // Supabase Bulk Upsert
                  const { error } = await sb.from('grub_belanja')
                      .upsert(importData, { onConflict: 'ID_Grub' });

                  if (error) throw error;

                  showToast(`${count} data Grub Belanja berhasil diimport/diperbarui.`, 'success');
                  localStorage.removeItem('cache_allGrubBelanja');
                  await refreshGrubBelanjaData();
              } catch (error) {
                  showToast(`Gagal mengimpor file: ${error.message}`, 'danger');
              } finally {
                  e.target.value = '';
                  showLoader(false);
              }
          };
          reader.readAsArrayBuffer(file);
      });
  }
  // ------------------------------------------------------------------
  // --- END MANAJEMEN GRUB BELANJA UTAMA ---
  // ------------------------------------------------------------------

  
  // --- MIGRATED TO SUPABASE: Save Kelompok ---
  safeAddClickListener('btn-save-kelompok', async () => { 
    const id = getSafeValue('mk_ID').trim(); 
    const nama = getSafeValue('mk_Nama').trim(); 
    if (!id || !nama) { showToast('ID dan Nama Kelompok wajib diisi.', 'warning'); return; } 
    showLoader(true); 
    try { 
        // Supabase Upsert
        const { error } = await sb.from('kelompok')
            .upsert({ ID_Kelompok: id, Nama_Kelompok: nama }, { onConflict: 'ID_Kelompok' }); 
            
        if (error) throw error;
        
        showToast('Kelompok berhasil disimpan.'); 
        clearKelompokForm(); 
        localStorage.removeItem('cache_allKelompok'); 
        await refreshKelompokData(); 
    } catch (error) { 
        showToast(`Gagal menyimpan kelompok: ${error.message}`, 'danger'); 
    } finally { 
        showLoader(false); 
    } 
  });
  
  // --- MIGRATED TO SUPABASE: Delete Kelompok ---
  window.deleteKelompok = async (id) => { 
    if (confirm(`Yakin ingin menghapus kelompok "${id}"?`)) { 
        showLoader(true); 
        try { 
            // Supabase Delete
            const { error } = await sb.from('kelompok').delete().eq('ID_Kelompok', id); 
            if (error) throw error;
            
            showToast(`Kelompok "${id}" berhasil dihapus.`); 
            clearKelompokForm(); 
            localStorage.removeItem('cache_allKelompok'); 
            await refreshKelompokData();
            } catch (error) { 
            showToast(`Gagal menghapus kelompok: ${error.message}`, 'danger'); 
        } finally { 
            showLoader(false); 
        } 
    } 
  };
  
  // Helper for management forms (Firebase functions remain unchanged, only helper is copied)
  function clearKelompokForm() { 
      setElValue('mk_ID', ''); 
      setElValue('mk_Nama', ''); 
  }
  window.fillEditKelompok = (id, nama) => { 
      setElValue('mk_ID', id); 
      setElValue('mk_Nama', nama); 
  };
  
  // --- MIGRATED TO SUPABASE: Upload Kelompok Excel ---
  const uploadKelompokInput = document.getElementById('input-upload-excel-kelompok');
  if (uploadKelompokInput) {
      uploadKelompokInput.addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (!file) return;
          showLoader(true);
          const reader = new FileReader();
          reader.onload = async (event) => {
              try {
                  const data = new Uint8Array(event.target.result);
                  const workbook = XLSX.read(data, {
                      type: 'array'
                  });
                  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                  const jsonData = XLSX.utils.sheet_to_json(firstSheet, {
                      header: 1
                  });
                  if (jsonData.length < 2 || jsonData[0][0] !== 'ID_Kelompok' || jsonData[0][1] !== 'Nama_Kelompok') {
                      throw new Error('Format file tidak sesuai. Pastikan header adalah ID_Kelompok dan Nama_Kelompok.');
                  }
                  
                  let importData = [];
                  let count = 0;
                  for (let i = 1; i < jsonData.length; i++) {
                      const row = jsonData[i];
                      const id = String(row[0] || '').trim();
                      const nama = String(row[1] || '').trim();
                      if (id && nama) {
                          importData.push({ ID_Kelompok: id, Nama_Kelompok: nama });
                          count++;
                      }
                  }
                  if (count === 0) {
                      throw new Error("Tidak ada data valid untuk diimport.");
                  }
                  
                  // Supabase Bulk Upsert
                  const { error } = await sb.from('kelompok')
                      .upsert(importData, { onConflict: 'ID_Kelompok' });

                  if (error) throw error;

                  showToast(`${count} data kelompok berhasil diimport/diperbarui.`, 'success');
                  localStorage.removeItem('cache_allKelompok');
                  await refreshKelompokData();
              } catch (error) {
                  showToast(`Gagal mengimpor file: ${error.message}`, 'danger');
              } finally {
                  e.target.value = '';
                  showLoader(false);
              }
          };
          reader.readAsArrayBuffer(file);
      });
  }
  
  // --- MIGRATED: Backup/Restore Logic (Split between Supabase and Firebase) ---
  const SB_COLLECTIONS = ['ajuan', 'kelompok', 'grub_belanja', 'activityLog', 'ajuan_history', PRODI_SUMMARY_TABLE]; 
  
  // Tambahkan semua tabel ajuanrevX ke dalam daftar backup
  for (let i = 1; i <= 30; i++) {
      SB_COLLECTIONS.push(`ajuanrev${i}`);
  }
  
  const FB_COLLECTIONS = ['users', 'appConfig', 'notifications'];
  const ALL_COLLECTIONS_FOR_DISPLAY = [...new Set([...SB_COLLECTIONS, ...FB_COLLECTIONS])]; // Use Set to ensure uniqueness for display

  async function backupAllData() {
      if (STATE.role !== 'direktorat') { showToast("Hanya direktorat yang dapat melakukan backup.", "warning"); return; }
      showLoader(true);
      showToast("Memulai proses backup, ini mungkin memakan waktu beberapa saat...", "info");
      const backupData = {};
      try {
          // 1. Backup Supabase Data
          for (const collectionName of SB_COLLECTIONS) {
              const { data, error } = await sb.from(collectionName).select('*');
              // Silently ignore missing tables if they don't exist yet (e.g., ajuanrev2)
              if (error && error.code !== '42P01') { // 42P01 is Postgres "Undefined table"
                   throw new Error(`Supabase backup failed for ${collectionName}: ${error.message}`);
              }
              if (data) {
                 backupData[collectionName] = data;
              }
          }

          // 2. Backup Firebase Data
          for (const collectionName of FB_COLLECTIONS) {
              const snapshot = await db.collection(collectionName).get();
              backupData[collectionName] = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          }

          const jsonString = JSON.stringify(backupData, null, 2);
          const blob = new Blob([jsonString], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
          a.href = url;
          a.download = `sipandai_backup_${timestamp}.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          showToast("Backup data berhasil diunduh.", "success");
      } catch (error) {
          console.error("Backup failed:", error);
          showToast(`Backup gagal: ${error.message}`, "danger");
      } finally {
          showLoader(false);
      }
  }

  async function handleRestoreFile(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (e) => {
          try {
              const data = JSON.parse(e.target.result);
              const promptMessage = `PERINGATAN: Aksi ini akan MENGHAPUS SEMUA DATA saat ini di koleksi: ${ALL_COLLECTIONS_FOR_DISPLAY.join(', ')} di Supabase dan Firebase. \n\nAksi ini tidak dapat dibatalkan. Ketik 'RESTORE' untuk melanjutkan.`;
              const confirmation = prompt(promptMessage);
              if (confirmation === 'RESTORE') {
                  await executeRestore(data);
              } else {
                  showToast("Restore dibatalkan.", "info");
              }
          } catch (error) {
              showToast(`Gagal membaca file restore: ${error.message}`, "danger");
              console.error("Restore file read error:", error);
          } finally {
              event.target.value = '';
          }
      };
      reader.readAsText(file);
  }

  async function executeRestore(data) {
      showLoader(true);
      showToast("Memulai proses restore. JANGAN tutup atau refresh halaman ini.", "info");
      try {
          
          // 1. Clean and Restore Supabase Data
          for (const collectionName of SB_COLLECTIONS) {
              // Check if data exists for this collection in the backup file
              if (!data[collectionName]) continue;
              
              showToast(`Menghapus data lama di Supabase '${collectionName}'...`, 'warning');
              
              // Attempt to delete all rows in the table
              try {
                  // Using improbable condition to ensure global delete
                  const { error: deleteError } = await sb.from(collectionName).delete().neq('id_prodi', 'non-existent-id'); 
                   if (deleteError) { 
                      console.warn(`Supabase generic delete failed for ${collectionName}:`, deleteError); 
                      // Fallback with a different improbable condition
                      await sb.from(collectionName).delete().neq('created_at', '1900-01-01T00:00:00+00:00');
                   }
              } catch(e) {
                 // Ignore "relation does not exist" error for missing rev tables
                 if (!e.message.includes("relation")) {
                      console.warn(`Supabase aggressive delete failed for ${collectionName}:`, e);
                 }
              }


              if (data[collectionName] && data[collectionName].length > 0) {
                   showToast(`Menulis data baru ke Supabase '${collectionName}'...`, 'info');
                   const insertData = data[collectionName];
                   const CHUNK_SIZE = 500;
                   for (let i = 0; i < insertData.length; i += CHUNK_SIZE) {
                       const chunk = insertData.slice(i, i + CHUNK_SIZE);
                       const { error } = await sb.from(collectionName).insert(chunk, { returning: 'minimal' });
                       if (error) {
                           console.error(`Gagal restore Supabase ${collectionName} chunk ${i}:`, error);
                           throw new Error(`Gagal restore Supabase ${collectionName}.`);
                       }
                   }
              }
          }

          // 2. Clean and Restore Firebase Data
          for (const collectionName of FB_COLLECTIONS) {
              showToast(`Menghapus data lama di Firebase '${collectionName}'...`, 'warning');
              const collectionRef = db.collection(collectionName);
              const snapshot = await collectionRef.get();
              
              const deletePromises = [];
              let deleteBatch = db.batch();
              snapshot.docs.forEach((doc, index) => {
                  deleteBatch.delete(doc.ref);
                  if ((index + 1) % 500 === 0) {
                      deletePromises.push(deleteBatch.commit());
                      deleteBatch = db.batch();
                  }
              });
              deletePromises.push(deleteBatch.commit());
              await Promise.all(deletePromises);

              // Insert new Firebase data
              if (data[collectionName] && data[collectionName].length > 0) {
                  showToast(`Menulis data baru ke Firebase '${collectionName}'...`, 'info');
                  const restoreData = data[collectionName];
                  const insertPromises = [];
                  let insertBatch = db.batch();

                  for (let i = 0; i < restoreData.length; i++) {
                      const docData = restoreData[i];
                      const { id, ...restData } = docData;
                      
                      // Convert back Firestore Timestamps from backup JSON structure
                      for (const key in restData) {
                          if (restData[key] && restData[key].seconds !== undefined && restData[key].nanoseconds !== undefined) {
                              restData[key] = new firebase.firestore.Timestamp(restData[key].seconds, restData[key].nanoseconds);
                          } else if (Array.isArray(restData[key])) { 
                              // Handle nested array timestamps (like Komentar in old backups)
                              restData[key] = restData[key].map(item => {
                                  if (item && item.timestamp && item.timestamp.seconds !== undefined) {
                                      item.timestamp = new firebase.firestore.Timestamp(item.timestamp.seconds, item.timestamp.nanoseconds);
                                  }
                                  return item;
                              });
                          }
                      }

                      const docRef = db.collection(collectionName).doc(id);
                      insertBatch.set(docRef, restData);
                      
                      if ((i + 1) % 500 === 0) { 
                          insertPromises.push(insertBatch.commit());
                          insertBatch = db.batch();
                      }
                  }
                  insertPromises.push(insertBatch.commit());
                  await Promise.all(insertPromises);
              }
          }

          showToast("Restore data berhasil diselesaikan! Silakan refresh halaman.", "success");
      } catch (error) {
          showToast(`Restore gagal: ${error.message}`, "danger");
          console.error("Restore execution failed:", error);
      } finally {
          showLoader(false);
      }
  }

  safeAddClickListener('btn-backup-data', backupAllData);
  const restoreInput = document.getElementById('input-restore-data');
  if(restoreInput) restoreInput.addEventListener('change', handleRestoreFile);
  
  // --- START: Log Aktivitas (MODIFIED FOR SUPABASE OFFSET/LIMIT) ---

  window.navigateLogPage = async (direction) => {
      await refreshLogTable(direction);
  };

  async function populateLogUserFilter() {
      if (STATE.allProdi.length === 0) {
          await refreshProdiData();
      }
      const filterEl = document.getElementById('filterLogUser');
      if (!filterEl) return;
      
      filterEl.innerHTML = '<option value="">Semua Pengguna</option>';
      
      STATE.allProdi.sort((a, b) => a.ID_Prodi.localeCompare(b.ID_Prodi)).forEach(p => {
          filterEl.add(new Option(`${p.ID_Prodi} (${p.Role})`, p.ID_Prodi));
      });
  }

  async function refreshLogTable(navigation = 'reset') {
    if (STATE.role !== 'direktorat') return;
    const tableContainer = document.getElementById('tableLogAktivitas');
    if (!tableContainer) return;
    
    tableContainer.innerHTML = `<div class="text-center text-muted p-5">Memuat log...</div>`;
    showLoader(true);
    
    const paginationControls = document.getElementById('log-pagination-controls');
    if (paginationControls) paginationControls.innerHTML = '';
    
    try {
        if (navigation === 'reset') {
            STATE.currentLogPage = 1;
        } else if (navigation === 'next') {
            STATE.currentLogPage++;
        } else if (navigation === 'prev' && STATE.currentLogPage > 1) {
            STATE.currentLogPage--;
        }
        
        const offset = (STATE.currentLogPage - 1) * STATE.logPageSize;
        
        let queryBuilder = sb.from('activityLog')
            .select('userId, action, details, timestamp', { count: 'exact' })
            .order('timestamp', { ascending: false });

        // Use getSafeValue for log filters
        const userFilter = getSafeValue('filterLogUser');
        const dateStartFilter = getSafeValue('filterLogDateStart');
        const dateEndFilter = getSafeValue('filterLogDateEnd');

        if (userFilter) queryBuilder = queryBuilder.eq('userId', userFilter);
      if (dateStartFilter) queryBuilder = queryBuilder.gte('timestamp', dateStartFilter);
      if (dateEndFilter) {
            const endDate = new Date(dateEndFilter);
            endDate.setHours(23, 59, 59, 999);
            queryBuilder = queryBuilder.lte('timestamp', endDate.toISOString());
        }

        const { data: logs, count, error } = await queryBuilder
            .range(offset, offset + STATE.logPageSize - 1);
            
        if (error) throw error;

        // Determine if there is a next page based on total count
        const hasNextPage = count > (STATE.currentLogPage * STATE.logPageSize);
        
        // Convert logs timestamp strings to Date objects for rendering
        logs.forEach(log => {
            if (log.timestamp) log.timestamp = new Date(log.timestamp);
        });

        renderLogTable(logs);
        renderLogPagination(hasNextPage);

    } catch (error) {
        tableContainer.innerHTML = `<div class="text-center text-danger p-5">Gagal memuat log aktivitas.</div>`;
        console.error("Error fetching activity log (Supabase):", error);
    } finally {
        showLoader(false);
    }
  }

  function renderLogTable(logs) {
    const container = document.getElementById('tableLogAktivitas');
    if (!container) return;

    if (logs.length === 0) {
        container.innerHTML = '<div class="text-center text-muted p-5">Tidak ada aktivitas yang tercatat untuk filter ini.</div>';
        return;
    }
    const tableHeader = `
        <thead class="table-light">
            <tr>
                <th>Waktu</th>
                <th>Pengguna</th>
                <th>Aksi</th>
                <th>Detail</th>
            </tr>
        </thead>`;
    const tableRows = logs.map(log => {
        const time = log.timestamp && log.timestamp.toLocaleString ? log.timestamp.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'long' }) : 'N/A';
        return `
            <tr>
                <td class="text-nowrap">${time}</td>
                <td class="text-nowrap">${escapeHtml(log.userId)}</td>
                <td><span class="badge bg-info-subtle text-info-emphasis">${escapeHtml(log.action)}</span></td>
                <td><small>${escapeHtml(log.details)}</small></td>
            </tr>`;
    }).join('');
    container.innerHTML = `<table class="table table-sm table-striped table-hover">${tableHeader}<tbody>${tableRows}</tbody></table>`;
  }
  
  function renderLogPagination(hasNextPage) {
      const container = document.getElementById('log-pagination-controls');
      if (!container) return;

      const isFirstPage = STATE.currentLogPage === 1;

      const prevDisabled = isFirstPage ? 'disabled' : '';
      const nextDisabled = !hasNextPage ? 'disabled' : '';

      container.innerHTML = `
          <div class="d-flex justify-content-between align-items-center mt-3">
              <button class="btn btn-sm btn-outline-secondary ${prevDisabled}" onclick="window.navigateLogPage('prev')">
                  <i class="bi bi-arrow-left"></i> Sebelumnya
              </button>
              <span class="small text-muted">Halaman ${STATE.currentLogPage}</span>
              <button class="btn btn-sm btn-outline-secondary ${nextDisabled}" onclick="window.navigateLogPage('next')">
                  Berikutnya <i class="bi bi-arrow-right"></i>
              </button>
          </div>
      `;
  }

  safeAddClickListener('btn-filter-log', () => refreshLogTable('reset'));
  safeAddClickListener('btn-refresh-log', () => refreshLogTable('reset'));
  const tabLogAktivitas = document.querySelector('[data-bs-target="#tab-log"]');
if (tabLogAktivitas) {
    tabLogAktivitas.addEventListener('shown.bs.tab', async () => {
        if (STATE.role === 'direktorat') {
            await populateLogUserFilter(); // Pastikan filter user terisi
            refreshLogTable('reset'); // Panggil fungsi untuk memuat data log
        }
    });
}
// --- TAMBAHAN: TOMBOL BERSIHKAN LOG (SUPABASE) ---
  safeAddClickListener('btn-clear-log', async () => {
      // 1. Validasi Role (Hanya Direktorat)
      if (STATE.role !== 'direktorat') {
          showToast("Akses ditolak. Hanya Direktorat yang dapat menghapus log.", "danger");
          return;
      }

      // 2. Konfirmasi Keamanan (Double Check)
      const confirmMsg = "PERINGATAN KERAS:\n\n" +
                         "Anda akan menghapus SELURUH RIWAYAT LOG AKTIVITAS secara permanen dari database.\n" +
                         "Data ini penting untuk audit jejak pengguna.\n\n" +
                         "Ketik 'BERSIHKAN' (huruf besar) untuk melanjutkan penghapusan.";
      
      const userInput = prompt(confirmMsg);

      if (userInput !== 'BERSIHKAN') {
          if (userInput !== null) showToast("Penghapusan log dibatalkan.", "info");
          return;
      }

      showLoader(true);
      try {
          // 3. Eksekusi Hapus di Supabase
          // Supabase membutuhkan filter (WHERE clause) untuk melakukan delete.
          // Kita gunakan .neq('id', 0) atau .neq('action', 'x') untuk memilih semua baris.
          // Asumsi: Kolom 'id' adalah Primary Key (int8) di Supabase.
          
          // Opsi A: Jika tabel activityLog punya kolom 'id' (auto increment)
          // const { error } = await sb.from('activityLog').delete().neq('id', 0);

          // Opsi B (Lebih aman jika struktur ID tidak pasti): Hapus yang userId-nya tidak kosong
          const { error } = await sb.from('activityLog').delete().neq('userId', 'system_placeholder_impossible_string');

          if (error) throw error;

          showToast("Seluruh data log aktivitas berhasil dibersihkan dari database.", "success");
          
          // 4. Buat Log Baru (Jejak Audit Bahwa Log Dihapus)
          // Penting agar admin lain tahu bahwa log pernah dibersihkan
          await logActivity('Clear All Logs', 'Direktorat membersihkan seluruh riwayat aktivitas sebelumnya.');
          
          // 5. Refresh Tabel Log di UI
          refreshLogTable('reset');

      } catch (error) {
          console.error("Gagal membersihkan log:", error);
          showToast(`Gagal membersihkan log: ${error.message}`, "danger");
      } finally {
          showLoader(false);
      }
  });
  // --- END: Log Aktivitas ---


  // --- START: Fitur Komentar (MIGRATED TO SUPABASE: Array Update) ---
  window.openKomentarModal = async (id, nama) => {
    const ajuanId = String(id);
    document.getElementById('komentarModalAjuanId').innerText = ajuanId.substring(0, 6) + '...';
    document.getElementById('komentarModalAjuanNama').innerText = nama;
    setElValue('komentar-id-ajuan', ajuanId);
    setElValue('komentar-input', '');
    
    const komentarListEl = document.getElementById('komentar-list');
    if (komentarListEl) komentarListEl.innerHTML = `<div class="text-center text-muted">Memuat komentar...</div>`;
    
    const komentarModalEl = document.getElementById('komentarModal');
    if (komentarModalEl) bootstrap.Modal.getOrCreateInstance(komentarModalEl).show();

    try {
        // Find which table the ajuan belongs to (based on current active tab, which should contain this ID)
        // Note: This relies on the table list being freshly loaded into STATE.currentAjuanDataAwal/Perubahan
        const ajuanData = STATE.currentAjuanDataAwal.find(a => String(a.ID_Ajuan) === ajuanId) || 
                         STATE.currentAjuanDataPerubahan.find(a => String(a.ID_Ajuan) === ajuanId);
        
        // Fallback aggressively if local state is missing, by assuming current type
        const tipe = ajuanData ? ajuanData.Tipe_Ajuan : (STATE.currentAjuanType || 'Awal');
        const targetTableName = getAjuanTableName(tipe); // <-- REF ACT

        const { data: ajuan, error } = await sb.from(targetTableName).select('Komentar').eq('ID_Ajuan', ajuanId).maybeSingle(); // <-- REF ACT
        if (error || !ajuan) throw new Error("Ajuan tidak ditemukan.");
        
        const comments = ajuan.Komentar || [];
        renderKomentarList(comments);
        
    } catch (error) {
        console.error("Gagal memuat komentar:", error);
        if (komentarListEl) komentarListEl.innerHTML = `<div class="text-center text-danger">Gagal memuat komentar.</div>`;
    }
  };

  function renderKomentarList(comments) {
    const listEl = document.getElementById('komentar-list');
    if (!listEl) return;

    if (!comments || comments.length === 0) {
      listEl.innerHTML = '<p class="text-center text-muted small m-0">Belum ada diskusi untuk ajuan ini.</p>';
      return;
    }
    
    listEl.innerHTML = comments.map(c => {
      const isCurrentUser = c.author === STATE.id;
      const bubbleClass = c.author === STATE.id ? 'comment-bubble-user' : (c.author === 'direktorat' ? 'comment-bubble-reviewer' : 'comment-bubble-other'); // Adjusted bubble class
      // Supabase JSONB stores JS Dates/Timestamps which can be converted back
      const timestamp = c.timestamp ? new Date(c.timestamp) : null; 
      const time = timestamp ? timestamp.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      return `<div class="comment-bubble ${bubbleClass}">
                <div class="author">${escapeHtml(c.author)}</div>
                <div class="text">${escapeHtml(c.text)}</div>
                <div class="timestamp">${time}</div>
              </div>`;
    }).join('');
    listEl.scrollTop = listEl.scrollHeight; 
  }

  safeAddClickListener('btn-submit-komentar', async () => {
    const ajuanId = getElValue('komentar-id-ajuan');
    const inputEl = document.getElementById('komentar-input');
    const text = inputEl ? inputEl.value.trim() : '';
    if (!text) {
      showToast("Komentar tidak boleh kosong.", "warning");
      return;
      }

    showLoader(true);
    try {
      // Find table name dynamically
      const ajuanData = STATE.currentAjuanDataAwal.find(a => String(a.ID_Ajuan) === ajuanId) || 
                         STATE.currentAjuanDataPerubahan.find(a => String(a.ID_Ajuan) === ajuanId);
      
      const tipe = ajuanData ? ajuanData.Tipe_Ajuan : (STATE.currentAjuanType || 'Awal');
      const targetTableName = getAjuanTableName(tipe); // <-- REF ACT
      
      // 1. Fetch current comments
      const { data: currentAjuan, error: fetchError } = await sb.from(targetTableName) // <-- REF ACT
          .select('Komentar, Nama_Ajuan, ID_Prodi')
          .eq('ID_Ajuan', ajuanId)
          .maybeSingle();
          
      if (fetchError || !currentAjuan) throw new Error("Gagal mengambil data ajuan untuk komentar.");
      
      const existingComments = currentAjuan.Komentar || [];
      
      const newComment = {
          author: STATE.id,
          text: text,
          timestamp: new Date() 
      };

      const updatedComments = [...existingComments, newComment];

      // 2. Update Supabase
      const { error: updateError } = await sb.from(targetTableName) // <-- REF ACT
          .update({ Komentar: updatedComments })
          .eq('ID_Ajuan', ajuanId);
          
      if (updateError) throw updateError;

      // Update local UI
      renderKomentarList(updatedComments); 
      if(inputEl) inputEl.value = '';

      // Send notifications (uses Firebase users/notifications)
      if (STATE.role === 'prodi') { 
          STATE.allDirektoratUids.forEach(uid => {
              createNotification(uid, `${STATE.id} mengirim komentar baru pada ajuan "${currentAjuan.Nama_Ajuan}" (${tipe}).`);
          });
      } else { 
          const prodiUser = STATE.allProdi.find(p => p.ID_Prodi === currentAjuan.ID_Prodi);
          if (prodiUser && prodiUser.uid) {
              createNotification(prodiUser.uid, `Direktorat mengirim komentar baru pada ajuan Anda "${currentAjuan.Nama_Ajuan}" (${tipe}).`);
          }
      }
      
      await logActivity('Komentar Dikirim', `Mengirim komentar pada ajuan ID ${ajuanId} di tabel ${targetTableName}: "${text}"`);
      showToast("Komentar berhasil dikirim.", "success");

    } catch (error) {
      console.error("Gagal mengirim komentar:", error);
      showToast(`Gagal mengirim komentar: ${error.message}`, "danger");
    } finally {
      showLoader(false);
    }
  });
  // --- END: Fitur Komentar ---


  // ------------------------------------------------------------------
  // --- START FIREBASE USER/CONFIG MANAGEMENT HANDLERS ---
  // ------------------------------------------------------------------

  // Save Pagu Anggaran (Firebase) (MODIFIED)
  window.savePagu = async (uid) => {
      const paguInput = document.getElementById(`pagu-input-${uid}`);
      if (!paguInput) return;
      const paguValue = Number(paguInput.value) || 0;
      
      if (paguValue < 0) { showToast("Pagu tidak boleh negatif.", "warning"); return; }
      
      showLoader(true);
      try {
          await db.collection('users').doc(uid).update({ Pagu_Anggaran: paguValue });
          
          // Update STATE and cache
          localStorage.removeItem('cache_allProdi'); 
          await refreshProdiData();
          
          showToast(`Pagu Anggaran untuk ${uid} berhasil disimpan: Rp ${paguValue.toLocaleString('id-ID')}.`);
          await logActivity('Update Pagu', `Mengubah pagu untuk UID ${uid} menjadi ${paguValue}.`);

          // --- Trigger Recalculation for affected prodi ---
          const prodiData = STATE.allProdi.find(p => p.uid === uid);
          if (prodiData) {
              await recalculateProdiSummary(prodiData.ID_Prodi);
              loadDashboardData(true); // Refresh dashboard after pagu change
          }
          // --- End Trigger ---

      } catch (error) {
          showToast(`Gagal menyimpan Pagu: ${error.message}`, 'danger');
      } finally {
          showLoader(false);
      }
  };

  // ------------------------------------------------------------------
// --- START FIREBASE USER/CONFIG MANAGEMENT HANDLERS (MODIFIED) ---
// ------------------------------------------------------------------

// Fill Edit Prodi Modal (Firebase) (MODIFIED)
window.fillEditProdi = (uid, id, nama, email, role, ttdJabatan = '', ttdNama = '') => {
    // Sembunyikan field password saat mengedit
    const passwordGroup = document.getElementById('user-password-group');
    if (passwordGroup) passwordGroup.style.display = 'none';

    // Tampilkan UID field
    const uidGroup = document.getElementById('user-uid-group');
    if (uidGroup) uidGroup.style.display = 'block';

    setElValue('edit_user_uid', uid);
    setElValue('edit_user_id', id);
    setElValue('edit_user_nama', nama);
    setElValue('edit_user_email', email);
    setElValue('edit_user_role', role);
    setElValue('edit_user_ttd_jabatan', ttdJabatan);
    setElValue('edit_user_ttd_nama', ttdNama);

    // Show TTD settings only for Prodi
    const ttdGroup = document.getElementById('edit-ttd-settings-group');
    if (ttdGroup) ttdGroup.style.display = (role === 'prodi') ? 'block' : 'none';

    const modalTitle = document.getElementById('userModalTitle');
    if (modalTitle) modalTitle.textContent = `Edit Pengguna: ${id}`;
    
    const btnAdd = document.getElementById('btn-add-user');
    const btnUpdate = document.getElementById('btn-update-user');
    if (btnAdd) btnAdd.style.display = 'none';
    if (btnUpdate) btnUpdate.style.display = 'block';

    const userModalEl = document.getElementById('userModal');
    if (userModalEl) {
        const modal = bootstrap.Modal.getOrCreateInstance(userModalEl);
        modal.show();
    }
};

// Clear User Form (for new user functionality, if enabled) (MODIFIED)
function clearUserForm() {
    // Tampilkan field password untuk pendaftaran baru
    const passwordGroup = document.getElementById('user-password-group');
    if (passwordGroup) {
        passwordGroup.style.display = 'block';
        setElValue('edit_user_password', '');
    }

    // Sembunyikan field UID karena akan di-generate oleh Auth
    const uidGroup = document.getElementById('user-uid-group');
    if (uidGroup) uidGroup.style.display = 'none';

    setElValue('edit_user_uid', ''); // Pastikan UID dikosongkan
    setElValue('edit_user_id', '');
    setElValue('edit_user_nama', '');
    setElValue('edit_user_email', '');
    setElValue('edit_user_role', 'prodi');
    setElValue('edit_user_ttd_jabatan', '');
    setElValue('edit_user_ttd_nama', '');
    
    const ttdGroup = document.getElementById('edit-ttd-settings-group');
    if (ttdGroup) ttdGroup.style.display = 'block';
    
    const modalTitle = document.getElementById('userModalTitle');
    const btnAdd = document.getElementById('btn-add-user');
    const btnUpdate = document.getElementById('btn-update-user');

    if (modalTitle) modalTitle.textContent = 'Tambah Pengguna Baru';
    if (btnAdd) btnAdd.style.display = 'block';
    if (btnUpdate) btnUpdate.style.display = 'none';
}

// --- FIXED & STABLE: SAVE USER FUNCTION (Reuse App Pattern) ---
async function saveUser(isNew) {
    // 1. Lepaskan fokus dari tombol (mencegah error aria-hidden)
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
    }

    // Ambil Value
    const uid = getElValue('edit_user_uid');
    const prodiId = getElValue('edit_user_id').trim();
    const namaProdi = getElValue('edit_user_nama').trim();
    const email = getElValue('edit_user_email').trim();
    const role = getElValue('edit_user_role');
    
    const ttdJabatan = getSafeValue('edit_user_ttd_jabatan').trim();
    const ttdNama = getSafeValue('edit_user_ttd_nama').trim();

    if (!prodiId || !namaProdi || !email || !role) { 
        showToast('Semua field wajib diisi.', 'warning'); 
        return; 
    }

    let finalUid = uid;
    let password = '';

    if (isNew) {
        try {
            password = getElValue('edit_user_password').trim();
            if (!password || password.length < 6) {
                 showToast('Password harus diisi dan minimal 6 karakter.', 'warning');
                 return;
            }
        } catch (e) {
            showToast('Password harus diisi.', 'warning');
            return;
        }
    }

    showLoader(true);

    try {
        if (isNew) {
            // ============================================================
            // PERBAIKAN STABIL: REUSE SECONDARY APP
            // Jangan dihapus (.delete), gunakan kembali jika sudah ada.
            // ============================================================
            const appName = "SecondaryApp";
            let secondaryApp = firebase.apps.find(app => app.name === appName);

            // Jika belum ada, baru kita buat. Jika sudah ada, pakai yang lama.
            if (!secondaryApp) {
                secondaryApp = firebase.initializeApp(CONFIG.firebase, appName);
            }

            const secondaryAuth = secondaryApp.auth();

            // 1. Buat user baru di instance sekunder
            // (Ini tidak akan melogout Admin di instance utama)
            const userCredential = await secondaryAuth.createUserWithEmailAndPassword(email, password);
            finalUid = userCredential.user.uid;

            // 2. Logout dari instance sekunder saja untuk kebersihan sesi
            await secondaryAuth.signOut();

            // ============================================================
            // KEMBALI KE DB UTAMA (ADMIN)
            // ============================================================
            
            const initialData = { 
                ID_Prodi: prodiId,
                Nama_Prodi: namaProdi,
                Email: email,
                Role: role,
                Pagu_Anggaran: 0, 
                beritaAcaraSettings: (role === 'prodi') ? { TTD_Jabatan: ttdJabatan, TTD_Nama: ttdNama } : {}
            };
            
            // Simpan profil ke Firestore (menggunakan 'db' utama)
            await db.collection('users').doc(finalUid).set(initialData);

            showToast(`Pengguna baru ${prodiId} berhasil didaftarkan.`);
            await logActivity('Create User', `Mendaftarkan user baru: ${prodiId}.`);

        } else {
            // --- UPDATE USER EXISTING (Sama seperti sebelumnya) ---
            if (!uid) throw new Error("UID pengguna tidak ditemukan untuk diupdate.");
            
            const updateData = {
                ID_Prodi: prodiId,
                Nama_Prodi: namaProdi,
                Email: email,
                Role: role
            };

            if (role === 'prodi') {
                updateData.beritaAcaraSettings = { TTD_Jabatan: ttdJabatan, TTD_Nama: ttdNama };
            } else {
                 updateData.beritaAcaraSettings = deleteField(); 
            }

            await db.collection('users').doc(uid).update(updateData);
            showToast(`Profil ${prodiId} berhasil diperbarui.`);
            await logActivity('Update Profile', `Mengubah profil user: ${prodiId}.`);
            
            // Update sesi lokal jika admin mengedit dirinya sendiri
            if (uid === STATE.uid) {
                const updatedDoc = await db.collection('users').doc(uid).get();
                if (updatedDoc.exists) {
                    const sessionData = { ...updatedDoc.data(), uid: uid };
                    saveSession(sessionData);
                    STATE.currentUserData = sessionData;
                }
            }
        }
        
        // Refresh data dan tutup modal
        localStorage.removeItem('cache_allProdi');
        await refreshProdiData();
        
        const userModalEl = document.getElementById('userModal');
        if(userModalEl) bootstrap.Modal.getOrCreateInstance(userModalEl).hide();

    } catch (error) {
        let displayMessage;
        if (error.code && error.code.includes('auth/email-already-in-use')) {
            displayMessage = `Email ${email} sudah terdaftar.`;
        } else if (error.code && error.code.includes('auth/')) {
            displayMessage = `Otentikasi Gagal: ${error.message}`;
        } else {
            displayMessage = error.message;
        }

        showToast(`Gagal menyimpan: ${displayMessage}`, 'danger');
        console.error("Save user error:", error);
    } finally {
        // PERUBAHAN PENTING:
        // Kita TIDAK menghapus (delete) secondaryApp di sini.
        // Membiarkannya tetap hidup mencegah error "app-deleted" jika fungsi dipanggil lagi.
        showLoader(false);
    }
}

// Pastikan btn-update-user memanggil saveUser(false)
safeAddClickListener('btn-update-user', () => saveUser(false));

// Pastikan btn-open-add-user-modal tetap memanggil clearUserForm
safeAddClickListener('btn-add-user', () => saveUser(true)); 

safeAddClickListener('btn-open-add-user-modal', () => {
    clearUserForm();
    const userModalEl = document.getElementById('userModal');
    if (userModalEl) bootstrap.Modal.getOrCreateInstance(userModalEl).show();
});

  // Update Prodi TTD settings in Account Settings tab (for Prodi only)
  async function updateProdiTtdSettings() {
      if (STATE.role !== 'prodi') return;
      
      let jabatan;
      let nama;
      
      try {
        // Use getSafeValue as a safety measure, though these elements should exist in the Prodi view
        jabatan = getSafeValue('input-ttd-jabatan').trim();
        nama = getSafeValue('input-ttd-nama').trim();
      } catch (error) {
        showToast(`Gagal memperbarui TTD: Input tidak lengkap atau hilang.`, 'danger');
        console.error("Update Prodi TTD Input Error:", error);
        return;
      }
      
      showLoader(true);
      try {
          const settings = { TTD_Jabatan: jabatan, TTD_Nama: nama };
          
          // KRITIS: Memerlukan izin tulis di Firebase Firestore Rules untuk koleksi 'users'.
          await db.collection('users').doc(STATE.uid).update({
              beritaAcaraSettings: settings
          });
          
          // Update local state and session
          STATE.currentUserData.beritaAcaraSettings = settings;
          saveSession(STATE.currentUserData);
          
          showToast("Pengaturan TTD Berita Acara berhasil diperbarui.", "success");
          await logActivity('Update TTD Settings', `Mengubah pengaturan TTD BA.`);
          
      } catch (error) {
          showToast(`Gagal memperbarui TTD: ${error.message}`, 'danger');
      } finally {
          showLoader(false);
      }
  }

  async function loadFilterMasterData() {
    // Load Grub Belanja
    const grubSelect = document.getElementById('filterGrubBelanja');
    if (grubSelect) {
        grubSelect.innerHTML = `<option value="">Semua Grub Belanja</option>`;
        STATE.allGrubBelanja.forEach(g => {
            grubSelect.innerHTML += `<option value="${g.Nama_Grub}">${g.Nama_Grub}</option>`;
        });
    }

    // Load Kelompok Belanja
    const kelompokSelect = document.getElementById('filterKelompokBelanja');
    if (kelompokSelect) {
        kelompokSelect.innerHTML = `<option value="">Semua Kelompok Belanja</option>`;
        STATE.allKelompok.forEach(k => {
            kelompokSelect.innerHTML += `<option value="${k.ID_Kelompok}">${k.ID_Kelompok} - ${k.Nama_Kelompok}</option>`;
        });
    }
}


// --- MIGRATED TO SUPABASE: Save Global Settings ---
async function saveGlobalSettings() {
    if (STATE.role !== 'direktorat') { showToast("Akses ditolak.", "danger"); return; }
    
    let settings;
    let batasTanggalAwal;
    let batasTanggalPerubahan;

    try {
        settings = {
            Status_Ajuan_Awal: getSafeValue('setting-status-awal'),
            Status_Ajuan_Perubahan: getSafeValue('setting-status-perubahan'),
            Tahap_Perubahan_Aktif: Number(getSafeValue('setting-tahap-perubahan')) || 1,
            Pengumuman_Aktif: getElChecked('setting-pengumuman-aktif'), 
            Pengumuman_Teks: getSafeValue('setting-pengumuman-teks').trim(),
        };
        
        batasTanggalAwal = getSafeValue('setting-batas-tanggal');
        batasTanggalPerubahan = getSafeValue('setting-batas-tanggal-perubahan');
        
    } catch (error) {
         showToast(`Gagal menyimpan pengaturan global: Input tidak lengkap.`, 'danger');
         return;
    }
    
    // Simpan Tanggal sebagai ISO String (Supabase JSONB tidak support object Timestamp Firebase)
    if (batasTanggalAwal) {
        settings.Batas_Tanggal_Pengajuan = new Date(batasTanggalAwal + 'T00:00:00').toISOString();
    } else {
        settings.Batas_Tanggal_Pengajuan = null;
    }
    
    if (batasTanggalPerubahan) {
        settings.Batas_Tanggal_Pengajuan_Perubahan = new Date(batasTanggalPerubahan + 'T00:00:00').toISOString();
    } else {
        settings.Batas_Tanggal_Pengajuan_Perubahan = null;
    }

    showLoader(true);
    try {
        // Simpan ke Supabase tabel 'app_config' dengan ID 'globalSettings'
        const { error } = await sb.from('app_config').upsert({
            id: 'globalSettings',
            settings: settings,
            updated_at: new Date().toISOString()
        });

        if (error) throw error;

        // Update State Lokal (tambahkan helper .toDate() untuk live update tanpa refresh)
        STATE.globalSettings = { ...settings };
        if (settings.Batas_Tanggal_Pengajuan) {
            STATE.globalSettings.Batas_Tanggal_Pengajuan = { toDate: () => new Date(settings.Batas_Tanggal_Pengajuan) };
        }
        if (settings.Batas_Tanggal_Pengajuan_Perubahan) {
            STATE.globalSettings.Batas_Tanggal_Pengajuan_Perubahan = { toDate: () => new Date(settings.Batas_Tanggal_Pengajuan_Perubahan) };
        }

        updatePerubahanUI(STATE.globalSettings);
        displayGlobalAnnouncement();
        showToast("Pengaturan global & pengumuman berhasil disimpan ke Supabase.");
        
        await logActivity('Update Global Settings', `Mengubah status ajuan & pengumuman.`);
        loadDashboardData(true); 

    } catch (error) {
        showToast(`Gagal menyimpan pengaturan: ${error.message}`, 'danger');
        console.error(error);
    } finally {
        showLoader(false);
    }
}

// --- MIGRATED TO SUPABASE: Save BA Settings ---
async function saveBeritaAcaraSettings() {
    if (STATE.role !== 'direktorat') { showToast("Akses ditolak.", "danger"); return; }
    
    let settings;
    try {
        settings = {
            TTD_Kanan_Jabatan: getSafeValue('setting-ttd-kanan-jabatan').trim(),
            TTD_Kanan_Nama: getSafeValue('setting-ttd-kanan-nama').trim(),
            TTD_Kiri_Jabatan: getSafeValue('setting-ttd-kiri-jabatan').trim(),
            TTD_Kiri_Nama: getSafeValue('setting-ttd-kiri-nama').trim()
        };
    } catch (error) {
        showToast(`Gagal menyimpan pengaturan TTD.`, 'danger');
        return;
    }
    
    showLoader(true);
    try {
        // Simpan ke Supabase
        const { error } = await sb.from('app_config').upsert({
            id: 'beritaAcaraSettings',
            settings: settings,
            updated_at: new Date().toISOString()
        });

        if (error) throw error;

        STATE.beritaAcaraSettings = settings;
        showToast("Pengaturan TTD Berita Acara berhasil disimpan ke Supabase.");
        await logActivity('Update BA Settings', `Mengubah pengaturan TTD Berita Acara global.`);
    } catch (error) {
        showToast(`Gagal menyimpan pengaturan TTD: ${error.message}`, 'danger');
    } finally {
        showLoader(false);
    }
}
  // --- END FIREBASE USER/CONFIG MANAGEMENT HANDLERS ---

  // ------------------------------------------------------------------
  // --- START MANAGEMENT TAB EVENT LISTENERS ---
  // ------------------------------------------------------------------

  safeAddClickListener('btn-update-user', () => saveUser(false));
  // FIX: Mengikat btn-add-user ke fungsi saveUser(true) untuk penambahan user baru
  safeAddClickListener('btn-add-user', () => saveUser(true)); 
  safeAddClickListener('btn-open-add-user-modal', () => {
      clearUserForm();
      const userModalEl = document.getElementById('userModal');
      if (userModalEl) bootstrap.Modal.getOrCreateInstance(userModalEl).show();
  });
  safeAddClickListener('btn-save-ttd-settings', updateProdiTtdSettings);
  
  // Rebinding the save buttons to ensure both UI sections in the Manage tab work
  safeAddClickListener('btn-save-settings', saveGlobalSettings);
  safeAddClickListener('btn-save-ba-settings', saveBeritaAcaraSettings);
  
  // Workaround for the duplicated ID in HTML structure
  const globalSettingsCard = document.querySelector('#tab-manage .row > .col-md-6:nth-child(4) .card-body');
  const announcementCard = document.querySelector('#tab-manage .row > .col-md-6:nth-child(5) .card-body');
  
  if (globalSettingsCard) {
      const btn = globalSettingsCard.querySelector('#btn-save-settings');
      if (btn) btn.addEventListener('click', saveGlobalSettings);
  }
  if (announcementCard) {
      const btn = announcementCard.querySelector('#btn-save-settings');
      if (btn) btn.addEventListener('click', saveGlobalSettings);
  }


  // Load Prodi TTD settings on tab switch (Account settings)
  const tabPengaturanAkun = document.querySelector('[data-bs-target="#tab-pengaturan-akun"]');
  if (tabPengaturanAkun) {
      tabPengaturanAkun.addEventListener('shown.bs.tab', () => {
          if (STATE.role === 'prodi') {
              const settings = STATE.currentUserData.beritaAcaraSettings || {};
              setElValue('input-ttd-jabatan', settings.TTD_Jabatan || '');
              setElValue('input-ttd-nama', settings.TTD_Nama || '');
          }
      });
  }


  // Load Global Settings when Manage Tab is opened (UI setup)
  const tabManage = document.querySelector('[data-bs-target="#tab-manage"]');
  if (tabManage) {
      tabManage.addEventListener('shown.bs.tab', async () => {
          if (STATE.role === 'direktorat') {
              showLoader(true);
              
              // Refresh all management lists
              await refreshGrubBelanjaData(); 
              await refreshKelompokData();
              await refreshProdiData();
              
              await loadGlobalSettings();
              await loadBeritaAcaraSettings();
              
              // Populate Global Settings UI
              const s = STATE.globalSettings;
              
              
              setElValue('setting-status-awal', s.Status_Ajuan_Awal || 'Ditutup');
              setElValue('setting-status-perubahan', s.Status_Ajuan_Perubahan || 'Ditutup');
              setElValue('setting-tahap-perubahan', s.Tahap_Perubahan_Aktif || 1);
              setElChecked('setting-pengumuman-aktif', s.Pengumuman_Aktif);
              setElValue('setting-pengumuman-teks', s.Pengumuman_Teks || '');
              
              let deadlineDateAwal = ''; 
              if (s.Batas_Tanggal_Pengajuan && s.Batas_Tanggal_Pengajuan.toDate) {
                  const date = s.Batas_Tanggal_Pengajuan.toDate();
                  // Format YYYY-MM-DD for input type="date"
                  deadlineDateAwal = date.toISOString().substring(0, 10); 
              }
              setElValue('setting-batas-tanggal', deadlineDateAwal);
              
              // NEW: Populate Perubahan Deadline
              let deadlineDatePerubahan = '';
              if (s.Batas_Tanggal_Pengajuan_Perubahan && s.Batas_Tanggal_Pengajuan_Perubahan.toDate) {
                  const date = s.Batas_Tanggal_Pengajuan_Perubahan.toDate();
                  deadlineDatePerubahan = date.toISOString().substring(0, 10); 
              }
              setElValue('setting-batas-tanggal-perubahan', deadlineDatePerubahan);
              
              // Populate Berita Acara Settings UI
              const ba = STATE.beritaAcaraSettings;
              setElValue('setting-ttd-kanan-jabatan', ba.TTD_Kanan_Jabatan || '');
              setElValue('setting-ttd-kanan-nama', ba.TTD_Kanan_Nama || '');
              setElValue('setting-ttd-kiri-jabatan', ba.TTD_Kiri_Jabatan || '');
              setElValue('setting-ttd-kiri-nama', ba.TTD_Kiri_Nama || '');

              // Populate Log Filter
              await populateLogUserFilter();
              refreshLogTable('reset');
              
              showLoader(false);
          }
      });
  }
  // ------------------------------------------------------------------
  // --- END MANAGEMENT TAB EVENT LISTENERS ---
  // ------------------------------------------------------------------
});


/* --- PATCH: bindOnce + safeHideModal + modal fix --- */

// Prevent duplicate event bindings
function bindOnce(selector, event, handler) {
    const el = document.querySelector(selector);
    if (!el) return;
    const key = `__bound_${event}`;
    if (!el[key]) {
        el.addEventListener(event, handler);
        el[key] = true;
    }
}

// Bootstrap-safe modal hide
function safeHideModal(modalId) {
    const modalEl = document.getElementById(modalId);
    if (!modalEl) return;
    const instance = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
    instance.hide();
}

// Cleanup aria-hidden when modal is closed
document.addEventListener("hidden.bs.modal", function (event) {
    event.target.removeAttribute("style");
    event.target.removeAttribute("aria-hidden");
});

// --- FIX: AUTO CALCULATE TOTAL (JUMLAH x HARGA SATUAN) ---

// 1. Fungsi Kalkulasi Utama
window.hitungTotalAjuan = function(prefix = '') {
    // Ambil elemen
    const elJumlah = document.getElementById(prefix + 'jumlah');
    const elHarga = document.getElementById(prefix + 'hargaSatuan');
    const elTotal = document.getElementById(prefix + 'total');

    if (!elJumlah || !elHarga || !elTotal) return { jumlah: 0, harga: 0, total: 0 };

    // Bersihkan nilai input dari titik/koma (jika ada format sebelumnya)
    // Asumsi input type="number" biasanya mengembalikan string polos, tapi untuk keamanan kita parsing.
    let valJumlah = parseFloat(elJumlah.value.replace(/\./g, '').replace(',', '.')) || 0;
    let valHarga = parseFloat(elHarga.value.replace(/\./g, '').replace(',', '.')) || 0;
    // Hitung Total
    let total = valJumlah * valHarga;

    // Tampilkan Total dengan format Ribuan Indonesia
    // Input Total biasanya readonly text, jadi kita set value-nya yang terformat
    elTotal.value = total.toLocaleString('id-ID');

    return { jumlah: valJumlah, harga: valHarga, total: total };
};

// 2. Pasang Event Listener saat Dokumen Siap
document.addEventListener('DOMContentLoaded', function() {
    
    // --- A. Untuk Form Ajuan Baru (Staging) ---
    const inputsBaru = ['jumlah', 'hargaSatuan'];
    inputsBaru.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', function() {
                window.hitungTotalAjuan(''); // Tanpa prefix
            });
             // Opsional: Handle paste event juga
            el.addEventListener('change', function() {
                window.hitungTotalAjuan(''); 
            });
        }
    });

    // --- B. Untuk Modal Edit ---
    const inputsEdit = ['edit-jumlah', 'edit-hargaSatuan'];
    inputsEdit.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', function() {
                window.hitungTotalAjuan('edit-'); // Pakai prefix 'edit-'
            });
            el.addEventListener('change', function() {
                window.hitungTotalAjuan('edit-'); 
            });
        }
    });

    console.log("Auto-calculation listeners attached.");
    // --- FIXED: DELETE USER FUNCTION (Global Scope) ---
window.deleteUser = async (uid, prodiId) => {
    // Pesan konfirmasi yang jelas
    const confirmMessage = `PERINGATAN BAHAYA:\n\n` +
        `Anda akan menghapus Unit: ${prodiId}\n` +
        `Aksi ini akan MENGHAPUS PERMANEN:\n` +
        `1. Profil Pengguna di Firebase\n` +
        `2. Data Ajuan Awal di Supabase\n` +
        `3. Seluruh Data Ajuan Perubahan (Tahap 1-30) di Supabase\n` +
        `4. Data RPD, Realisasi, dan Ringkasan Anggaran\n\n` +
        `Data yang dihapus TIDAK DAPAT DIKEMBALIKAN.\n` +
        `Apakah Anda yakin ingin melanjutkan?`;

    if (confirm(confirmMessage)) {
        showLoader(true);
        try {
            console.log(`[Delete User] Memulai penghapusan untuk: ${prodiId}`);

            // 1. HAPUS DATA DARI SUPABASE (Berdasarkan ID_Prodi)
            const deletePromises = [];

            // A. Hapus dari Tabel Utama (Ajuan Awal)
            deletePromises.push(sb.from('ajuan').delete().eq('ID_Prodi', prodiId));

            // B. Hapus dari Tabel Summary (Dashboard)
            deletePromises.push(sb.from(PRODI_SUMMARY_TABLE).delete().eq('id_prodi', prodiId));

            // C. Hapus Log Aktivitas User Tersebut
            deletePromises.push(sb.from('activityLog').delete().eq('userId', prodiId));

            // D. Hapus dari Semua Tabel Revisi/Perubahan (ajuanrev1 s.d ajuanrev30)
            for (let i = 1; i <= 30; i++) {
                const deleteRev = sb.from(`ajuanrev${i}`).delete().eq('ID_Prodi', prodiId)
                    .then(({ error }) => {
                        // Abaikan error jika tabel tidak ditemukan (normal jika revisi belum sampai tahap 30)
                        if (error && error.code !== '42P01') {
                            console.warn(`Info: Tabel ajuanrev${i} mungkin kosong atau error:`, error.message);
                        }
                    });
                deletePromises.push(deleteRev);
            }

            // Tunggu semua proses penghapusan data Supabase selesai
            await Promise.all(deletePromises);
            console.log(`[Delete User] Data Supabase bersih.`);

            // 2. HAPUS PROFIL DARI FIREBASE FIRESTORE
            await db.collection('users').doc(uid).delete();

            // 3. LOG AKTIVITAS (Oleh Admin yang sedang login)
            if (STATE.id) {
                await sb.from('activityLog').insert({
                    action: 'DELETE UNIT & DATA',
                    details: `Menghapus user ${prodiId} beserta seluruh data ajuan database.`,
                    userId: STATE.id,
                    userUid: STATE.uid,
                    timestamp: new Date().toISOString()
                });
            }

            showToast(`Unit ${prodiId} dan seluruh datanya berhasil dihapus permanen.`, 'success');

            // 4. REFRESH UI & CACHE
            localStorage.removeItem('cache_allProdi');
            
            // Bersihkan data dashboard lokal agar grafik langsung hilang tanpa refresh
            if (STATE.allDashboardData) {
                STATE.allDashboardData = STATE.allDashboardData.filter(d => d.ID_Prodi !== prodiId);
            }
            if (STATE.direktoratSummaryData) {
                STATE.direktoratSummaryData = STATE.direktoratSummaryData.filter(d => d.id_prodi !== prodiId);
            }
            
            await refreshProdiData(); // Refresh list user di tabel
            loadDashboardData(true);  // Refresh dashboard utama

        } catch (error) {
            showToast(`Gagal menghapus pengguna sepenuhnya: ${error.message}`, 'danger');
            console.error("Delete user critical error:", error);
        } finally {
            showLoader(false);
        }
    }
};
// --- FIX 1: DEFINISIKAN ULANG refreshProdiData (DIPERBAIKI UNTUK PRODI) ---
window.refreshProdiData = async function() {
    const cacheKey = 'cache_allProdi';
    
    // Hapus cache lama
    localStorage.removeItem(cacheKey);

    console.log("Mengambil data Prodi dari FIRESTORE.");
    try {
        let prodiList = [];

        // CEK ROLE:
        if (STATE.role === 'direktorat') {
            // JIKA DIREKTORAT: Boleh ambil semua data (db.collection('users').get())
            const prodiSnapshot = await db.collection('users').get();
            prodiList = prodiSnapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() }));
        } else {
            // JIKA PRODI: TIDAK BOLEH ambil semua (akan kena Permission Error).
            // Cukup gunakan data diri sendiri yang sudah dimuat saat login.
            if (STATE.currentUserData) {
                // Pastikan formatnya array agar kompatibel dengan logika aplikasi lainnya
                prodiList = [{
                    uid: STATE.uid,
                    ...STATE.currentUserData
                }];
            } else {
                // Fallback jika currentUserData belum siap, ambil dokumen sendiri by ID
                const doc = await db.collection('users').doc(STATE.uid).get();
                if (doc.exists) {
                    prodiList = [{ uid: doc.id, ...doc.data() }];
                }
            }
        }
        
        // Update STATE global
        STATE.allProdi = prodiList;
        
        // Simpan ke cache baru
        setCache(cacheKey, STATE.allProdi, 120); 
        
        // Update Tampilan List (Hanya relevan jika yang login Direktorat)
        if (STATE.role === 'direktorat' && typeof populateProdiList === 'function') {
            populateProdiList(STATE.allProdi); 
        }

    } catch (e) {
        console.error("Gagal mengambil data Prodi (Firebase)", e);
        // Jangan showToast error permission agar user tidak bingung, cukup log di console
        if (e.code !== 'permission-denied') {
             showToast("Gagal memuat ulang data pengguna.", "danger");
        }
    }
};

});
/* --- END PATCH --- */
    
