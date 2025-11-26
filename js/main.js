// js/main.js

import { auth, db } from './api.js';
import { STATE } from './config.js';
import { 
    showLoader, 
    safeAddClickListener, 
    setElValue,
    showToast
} from './utils.js';
import { handleLogin, handleLogout, saveSession } from './auth.js';
import { 
    loadDashboardData, 
    updateProdiPaguInfo,
    loadRekapanRealisasi
} from './dashboard.js';
import { 
    refreshProdiData, 
    refreshKelompokData, 
    refreshGrubBelanjaData, 
    loadGlobalSettings,
    loadBeritaAcaraSettings, // Pastikan ini sudah diekspor di admin.js
    populateLogUserFilter,
    refreshLogTable
} from './admin.js';
import { 
    setupExportListeners, 
    updatePerubahanUI, 
    setupNotificationListener,
    refreshAjuanTableAwal,
    refreshAjuanTablePerubahan,
    loadMatrixSemulaMenjadi // Dianggap ada di ajuan.js
} from './ajuan.js'; // Mengasumsikan ajuan.js menampung logic UI/Notifikasi

// --- PENTING: IMPORT EFEK SAMPING ---
// Memastikan semua kode di modul tereksekusi (termasuk window binding dan inisialisasi)
import './config.js';
import './utils.js';
import './api.js';
import './auth.js';
import './dashboard.js';
import './ajuan.js';
import './admin.js';

// --- FUNCTIONS ---

/**
 * Logika setelah user berhasil login dan data user dimuat.
 * @param {object} userData Data profil user dari Firestore.
 */
export async function initializeApp(userData) {
    STATE.role = userData.Role;
    STATE.id = userData.ID_Prodi;
    STATE.uid = userData.uid;
    STATE.currentUserData = userData;

    // 1. Setup UI Dasar
    document.body.classList.remove('login-view');
    document.getElementById('login-page-wrapper').style.display = 'none';
    document.getElementById('app-area').style.display = 'block';
    document.getElementById('welcome').innerHTML = `<span class="badge bg-secondary me-2">${STATE.role.toUpperCase()}</span> <strong>${STATE.id} - ${userData.Nama_Prodi}</strong>`;

    showLoader(true);
    
    try {
        // 2. Load Settings dan Master Data (Parallel)
        await Promise.all([
            loadGlobalSettings(), 
            loadBeritaAcaraSettings(),
            refreshProdiData(), 
            refreshGrubBelanjaData(),
            refreshKelompokData(),
        ]);

        updatePerubahanUI(STATE.globalSettings); 
        
        // 3. Role-based UI Adjustments
        const manageTabLink = document.getElementById('tab-manage-link');
        if (manageTabLink) manageTabLink.style.display = STATE.role === 'direktorat' ? 'block' : 'none';
        const logTabLink = document.getElementById('tab-log-link');
        if (logTabLink) logTabLink.style.display = STATE.role === 'direktorat' ? 'block' : 'none';
        const accountTabLink = document.getElementById('tab-pengaturan-akun-link');
        if (accountTabLink) accountTabLink.style.display = STATE.role === 'prodi' ? 'block' : 'none';

        if (STATE.role === 'prodi') {
             // Set current ajuan type based on active phase
            if (STATE.globalSettings.Status_Ajuan_Perubahan === 'Dibuka') {
                STATE.currentAjuanType = `Perubahan ${STATE.globalSettings.Tahap_Perubahan_Aktif || 1}`;
            } else {
                STATE.currentAjuanType = 'Awal';
            }
            await updateProdiPaguInfo(userData);
        } else {
            const direktoratCharts = document.getElementById('direktorat-charts');
            if(direktoratCharts) direktoratCharts.style.display = 'block';
            await populateLogUserFilter(); // Populate user filter for log tab
        }

        // 4. Load Data Awal untuk tab default (Dashboard)
        await loadDashboardData(true); // Force refresh data dashboard
        await loadRekapanRealisasi(); 
        
        // 5. Setup Listeners Lanjutan
        setupNotificationListener();
        setupExportListeners(); 
        setupTabListeners();
        setupDashboardFilterListeners();

        // Tampilkan tab dashboard secara eksplisit
        const dashboardTabTrigger = document.querySelector('[data-bs-target="#tab-dashboard"]');
        if (dashboardTabTrigger) {
            const tab = bootstrap.Tab.getOrCreateInstance(dashboardTabTrigger);
            tab.show();
        }
        
    } catch (error) {
        console.error("Initialization failed:", error);
        showToast('Gagal memuat data utama aplikasi. Cek koneksi Firebase/Supabase.', 'danger');
        // Tidak perlu force logout, biar user bisa mencoba lagi
    } finally {
        showLoader(false);
    }
}

/**
 * Setup listeners untuk navigasi tab (agar data dimuat saat tab dibuka)
 */
function setupTabListeners() {
    // Tab Daftar Ajuan Awal
    bindTabListener('#tab-daftar-awal', () => refreshAjuanTableAwal(false));
    
    // Tab Daftar Ajuan Perubahan
    bindTabListener('#tab-daftar-perubahan', () => refreshAjuanTablePerubahan(false));

    // Tab Log Aktivitas (Hanya untuk Direktorat)
    bindTabListener('#tab-log', () => {
        if (STATE.role === 'direktorat') {
            refreshLogTable('reset');
        }
    });
    
    // Tab Matrix (Diikat ke fungsi window yang di-export dari ajuan.js)
    bindTabListener('#tab-matrix-semula-menjadi', () => {
        if (STATE.role === 'direktorat' && STATE.globalSettings.Tahap_Perubahan_Aktif > 0) {
            if (typeof loadMatrixSemulaMenjadi === 'function') {
                loadMatrixSemulaMenjadi();
            } else {
                 showToast("Fungsi loadMatrixSemulaMenjadi belum tersedia.", 'warning');
            }
        }
    });

    // Tab Pengaturan Akun (Prodi)
     bindTabListener('#tab-pengaturan-akun', () => {
        if (STATE.role === 'prodi') {
            const settings = STATE.currentUserData.beritaAcaraSettings || {};
            setElValue('input-ttd-jabatan', settings.TTD_Jabatan || '');
            setElValue('input-ttd-nama', settings.TTD_Nama || '');
        }
    });
}

/** Helper untuk mengikat listener saat tab dibuka */
function bindTabListener(selector, handler) {
    const tabElement = document.querySelector(`[data-bs-target="${selector}"]`);
    if (tabElement) {
        tabElement.addEventListener('shown.bs.tab', handler);
    }
}

/** Setup listeners for dashboard filters */
function setupDashboardFilterListeners() {
    ['filterTahunDashboard', 'filterTipeDashboard'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => {
            STATE.cachedDashboardData = []; 
            loadDashboardData(true);
            loadRekapanRealisasi();
        });
    });
}

/**
 * Logika yang dijalankan jika user tidak terautentikasi
 */
function showLoginPage() {
    // Bersihkan sesi dan cache lokal saat logout
    localStorage.removeItem('siPandaiSession');
    localStorage.removeItem('cache_allKelompok');
    localStorage.removeItem('cache_allProdi');
    localStorage.removeItem('cache_allGrubBelanja'); 
    
    document.body.classList.add('login-view');
    document.getElementById('login-page-wrapper').style.display = 'flex';
    document.getElementById('app-area').style.display = 'none';
    setElValue('input-password', '');
    document.getElementById('input-user-id')?.focus();
}

// --- AUTHENTICATION & SESSION MANAGEMENT ---

/**
 * Listener utama Firebase Auth: mengelola status login
 */
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
            } else { 
                await auth.signOut(); 
            }
        } catch (error) { 
            console.error("Auth Listener Fatal Error:", error);
            await auth.signOut(); 
        }
    } else { 
        showLoginPage(); 
    }
    showLoader(false);
});

// --- DOM READY BINDINGS ---
document.addEventListener('DOMContentLoaded', () => {
    safeAddClickListener('btn-login', handleLogin);
    safeAddClickListener('btn-logout', handleLogout);
    
    // Binding Apply Filter Rekapan (Dibutuhkan di sini karena rekapan berada di dashboard)
    safeAddClickListener("btn-apply-filter-rekapan", loadRekapanRealisasi);
});

// --- MODAL CLEANUP ---
document.addEventListener("hidden.bs.modal", function (event) {
    // Reset background and scroll lock
    if (document.querySelectorAll('.modal.show').length === 0) {
        document.body.classList.remove('modal-open');
        document.body.style.paddingRight = '';
    }
    event.target.removeAttribute("style");
    event.target.removeAttribute("aria-hidden");
});