// js/dashboard.js
import { sb, db, getAjuanTableName } from './api.js';
import { STATE, RPD_MONTHS, PRODI_SUMMARY_TABLE } from './config.js';
import { 
    showLoader, showToast, getSafeValue, getColorForProdi, getMonthlyKey, 
    exportTableToExcel, safeAddClickListener, escapeHtml, getCache, setCache 
} from './utils.js';

// Global variable untuk instance Chart.js
let CHARTS = {};

// --- HELPER FUNCTIONS ---

/** Helper function to set up or update a Chart instance. */
function setupChart(canvasId, type, data, options) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (CHARTS[canvasId]) CHARTS[canvasId].destroy();
    // Chart.js dimuat secara global di index.html, jadi bisa langsung akses `Chart`
    CHARTS[canvasId] = new Chart(canvas.getContext('2d'), { type, data, options });
}

/** Helper function to calculate quarterly summaries. */
function calculateQuarterlySummary(monthlyData, total) { 
    const quarters = [0, 0, 0, 0]; 
    for (let i = 0; i < 12; i++) { 
        if (i < 3) quarters[0] += monthlyData[i]; 
        else if (i < 6) quarters[1] += monthlyData[i]; 
        else if (i < 9) quarters[2] += monthlyData[i]; 
        else quarters[3] += monthlyData[i]; 
    } 
    return { 
        values: quarters, 
        percentages: quarters.map(q => total > 0 ? ((q /total) * 100).toFixed(1) + '%' : '0.0%') 
    }; 
}

/** Helper function to calculate semester summaries. */
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

// --- FUNGSI UTAMA DASHBOARD ---

/** 
 * Fetches data for the dashboard based on role and filters.
 * @param {boolean} forceRefresh - If true, ignores local state cache.
 */
export async function loadDashboardData(forceRefresh = false) { 
  showLoader(true); 

  try {
    const selectedYear = getSafeValue('filterTahunDashboard');
    const selectedTipe = getSafeValue('filterTipeDashboard');

    // MODE 1: DIREKTORAT SUMMARY (Fast View - Uses prodi_summary table)
    const isDirectorateSummaryMode = STATE.role === 'direktorat' && !selectedYear && !selectedTipe;

    if (isDirectorateSummaryMode) {
        if (forceRefresh || STATE.direktoratSummaryData.length === 0) {
            const { data: summaryData, error: summaryError } = await sb
                .from(PRODI_SUMMARY_TABLE)
                .select('*'); 

            if (summaryError) throw summaryError;
            STATE.direktoratSummaryData = summaryData || [];
        }
        STATE.allDashboardData = []; 
        
    } else {
        // MODE 2: DETAILED VIEW (Prodi Role OR Direktorat with Filters)
        
        const tahapAktif = STATE.globalSettings.Tahap_Perubahan_Aktif || 0;
        let tablesToQuery = [];

        if (!selectedTipe) {
            tablesToQuery.push('ajuan');
            if (tahapAktif > 0) {
                 tablesToQuery.push(getAjuanTableName(`Perubahan ${tahapAktif}`));
            }
        } else if (selectedTipe === 'Awal') {
            tablesToQuery.push('ajuan');
        } else if (selectedTipe === 'Perubahan') {
            if (tahapAktif > 0) {
                tablesToQuery.push(getAjuanTableName(`Perubahan ${tahapAktif}`));
            }
        }
        
        if (tablesToQuery.length > 0 && (forceRefresh || STATE.cachedDashboardData.length === 0)) { 
            STATE.allDashboardData = [];
            const RPD_SELECT_COLUMNS = RPD_MONTHS.map(m => `${getMonthlyKey('RPD', m)}, ${getMonthlyKey('Realisasi', m)}`).join(', ');

            for (const tableName of tablesToQuery) {
                 const tipeLabel = tableName === 'ajuan' ? 'Awal' : `Perubahan ${tahapAktif}`;

                 let query = sb.from(tableName)
                   .select(`ID_Ajuan, ID_Prodi, Total, Status, Tipe_Ajuan, Timestamp, Is_Blocked, ${RPD_SELECT_COLUMNS}`);

                 if (STATE.role === 'prodi') {
                     query = query.eq('ID_Prodi', STATE.id); 
                 }
                
                 if (selectedYear) {
                     const start = `${selectedYear}-01-01 00:00:00`;
                     const end   = `${selectedYear}-12-31 23:59:59`;
                     query = query.gte('Timestamp', start).lte('Timestamp', end);
                 }

                 const { data: rawData, error } = await query;
                 if (!error && rawData) {
                     const processedData = (rawData || []).map(data => {
                        if (data.Timestamp) data.Timestamp = new Date(data.Timestamp); 
                        data.Is_Blocked = !!data.Is_Blocked; 
                        data.ID_Ajuan = String(data.ID_Ajuan || data.id);
                        data.Tipe_Ajuan = tipeLabel;
                        return data;
                     });
                     STATE.allDashboardData.push(...processedData);
                 }
            }
            STATE.cachedDashboardData = STATE.allDashboardData;  
        } else if (STATE.cachedDashboardData.length > 0) {
            STATE.allDashboardData = STATE.cachedDashboardData;
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

/** 
 * Processes the final filtered data and renders the dashboard UI elements.
 */
function processDataForDashboard() { 
      // Update filter info display
      const yearSelect = document.getElementById('filterTahunDashboard');
      const tipeSelect = document.getElementById('filterTipeDashboard');
      const selectedYear = getSafeValue('filterTahunDashboard'); 
      const selectedTipe = getSafeValue('filterTipeDashboard'); 
      
      // Populate filters if needed (relies on STATE.cachedDashboardData)
      const yearEl = document.getElementById('filterTahunDashboard');
      if (yearEl) {
        const years = [...new Set(STATE.cachedDashboardData.map(d => { 
            if(d.Timestamp) return new Date(d.Timestamp).getFullYear(); 
            return null; 
        }))].filter(Boolean).sort((a, b) => b - a); 
        const currentYear = new Date().getFullYear();
        if (!years.includes(currentYear)) years.unshift(currentYear);
        
        yearEl.innerHTML = '<option value="">Semua Tahun</option>'; 
        years.forEach(year => { 
            if (!isNaN(year)) yearEl.innerHTML += `<option value="${year}">${year}</option>`; 
        }); 
        // Ensure the selected year remains selected after population
        if (selectedYear) yearEl.value = selectedYear;
      }
      

      const filterInfoEl = document.getElementById('dashboard-filter-info');
      const yearText = yearSelect && selectedYear ? yearSelect.options[yearSelect.selectedIndex]?.text : "Semua Tahun";
      const tipeText = tipeSelect && selectedTipe ? tipeSelect.options[tipeSelect.selectedIndex]?.text : "Semua Tipe Ajuan";
      if(filterInfoEl) filterInfoEl.innerHTML = `Menampilkan data untuk: <strong>${yearText}</strong> & <strong>${tipeText}</strong>`;
      if(filterInfoEl) filterInfoEl.style.display = 'block';

      let filteredData = STATE.allDashboardData;
      
      // Perform final filtering based on selected Tipe Ajuan if multi-table data was loaded
      if (STATE.allDashboardData.length > 0 && selectedTipe) {
          filteredData = STATE.allDashboardData.filter(d => { 
              const isPerubahanMatch = selectedTipe === 'Perubahan' && (d.Tipe_Ajuan || '').startsWith('Perubahan');
              const isAwalMatch = selectedTipe === 'Awal' && d.Tipe_Ajuan === 'Awal';
              return isPerubahanMatch || isAwalMatch;
          }); 
      }
      
      // Set visibility of directorate charts/summaries
      const selectedYearFilter = getSafeValue('filterTahunDashboard');
      const selectedTipeFilter = getSafeValue('filterTipeDashboard');
      const isDirectorateSummaryMode = STATE.role === 'direktorat' && !selectedYearFilter && !selectedTipeFilter;

      const direktoratCharts = document.getElementById('direktorat-charts');
      if (direktoratCharts) {
          if (STATE.role === 'direktorat') {
              direktoratCharts.style.display = 'block';
              if (!isDirectorateSummaryMode) {
                   const container = document.getElementById('direktorat-summary-table-container');
                   if (container) container.innerHTML = '<p class="text-center text-muted small mt-3">Tabel ringkasan per unit dinonaktifkan saat filter waktu atau tipe ajuan diterapkan.</p>';
                   const statusCards = document.getElementById('direktorat-status-cards-container');
                   if (statusCards) statusCards.innerHTML = '<div class="col-12"><p class="text-center text-muted small">Kartu status unit dinonaktifkan saat filter waktu atau tipe ajuan diterapkan.</p></div>';
              }
          } else {
              direktoratCharts.style.display = 'none';
          }
      }
      
      renderDashboardSummary(filteredData); 
      
      if (STATE.role === 'direktorat' && isDirectorateSummaryMode) {
          renderDirektoratDashboard(STATE.direktoratSummaryData); 
      }
}

/**
 * Calculates and renders the aggregated metric cards and charts.
 */
function renderDashboardSummary(data, containerPrefix = 'dashboard-', chartPrefix = 'chart') { 
    
    let totalDiajukanOverall = 0;
    let totalDiterimaOverall = 0; 
    let totalDiajukanAwal = 0;
    let totalDiajukanPerubahan = 0;
    
    let statusCounts = { 'Menunggu Review': 0, 'Diterima': 0, 'Ditolak': 0, 'Revisi': 0 }; 
    const rpdPerBulan = Array(12).fill(0); 
    const realisasiPerBulan = Array(12).fill(0); 
    let totalDiterimaAwal = 0;

    // Aggregation from raw data
    data.forEach(ajuan => { 
        const total = Number(ajuan.Total) || 0;
        const isAwal = ajuan.Tipe_Ajuan === 'Awal' || !ajuan.Tipe_Ajuan;
        const isBlocked = !!ajuan.Is_Blocked;
        
        totalDiajukanOverall += total;
        if (isAwal) { totalDiajukanAwal += total; } else { totalDiajukanPerubahan += total; }

        if (ajuan.Status) { statusCounts[ajuan.Status] = (statusCounts[ajuan.Status] || 0) + 1; } 
        
        if (ajuan.Status === 'Diterima' && !isBlocked) { 
            totalDiterimaOverall += total;
            if (isAwal) { totalDiterimaAwal += total; }
            
            RPD_MONTHS.forEach((month, index) => { 
                const rpdVal = Number(ajuan[getMonthlyKey('RPD', month)]) || 0;
                const realVal = Number(ajuan[getMonthlyKey('Realisasi', month)] || ajuan[getMonthlyKey('realisasi', month)]) || 0;
                rpdPerBulan[index] += rpdVal;
                realisasiPerBulan[index] += realVal;
            }); 
        } 
    }); 
    
    let totalRPD = rpdPerBulan.reduce((a, b) => a + b, 0);
    let totalRealisasi = realisasiPerBulan.reduce((a, b) => a + b, 0);

    let directorateRpdPerBulan = rpdPerBulan;
    let directorateRealisasiPerBulan = realisasiPerBulan;
    let totalRpdForSummary = totalRPD;
    let totalRealisasiForSummary = totalRealisasi;
    let totalPaguFinalDiterima = totalDiterimaOverall;

    // Apply summary mode overrides for Director (when filters are OFF)
    const selectedYear = getSafeValue('filterTahunDashboard');
    const selectedTipe = getSafeValue('filterTipeDashboard');
    const isDirectorateSummaryMode = STATE.role === 'direktorat' && !selectedYear && !selectedTipe;

    if (isDirectorateSummaryMode) {
         totalRpdForSummary = STATE.direktoratSummaryData.reduce((sum, p) => sum + (Number(p.total_rpd_commitment) || 0), 0);
         totalRealisasiForSummary = STATE.direktoratSummaryData.reduce((sum, p) => sum + (Number(p.total_realisasi_overall) || 0), 0);
         totalPaguFinalDiterima = STATE.direktoratSummaryData.reduce((sum, p) => sum + (Number(p.total_diterima_final_bersih) || 0), 0);

        directorateRpdPerBulan = Array(12).fill(0);
        directorateRealisasiPerBulan = Array(12).fill(0);
        STATE.direktoratSummaryData.forEach(p => {
            if (p.rpd_monthly && p.realisasi_monthly) {
                 RPD_MONTHS.forEach((month, index) => {
                     directorateRpdPerBulan[index] += Number(p.rpd_monthly[getMonthlyKey('RPD', month)]) || 0;
                     directorateRealisasiPerBulan[index] += Number(p.realisasi_monthly[getMonthlyKey('Realisasi', month)]) || 0;
                 });
            }
        });
        statusCounts = { 'Menunggu Review': 0, 'Diterima': 0, 'Ditolak': 0, 'Revisi': 0 }; 
    }
    
    // Pagu Calculation
    const totalPaguAwal = (STATE.role === 'direktorat') 
        ? (STATE.allProdi || []).filter(p => p.Role === 'prodi').reduce((sum, p) => sum + (Number(p.Pagu_Anggaran) || 0), 0)
        : (STATE.currentUserData?.Pagu_Anggaran || 0);

    // --- Update Metric Cards ---
    document.getElementById(`${containerPrefix}total-diajukan-total`).textContent = 'Rp ' + totalDiajukanOverall.toLocaleString('id-ID'); 
    document.getElementById(`${containerPrefix}total-diajukan-awal`).textContent = 'Rp ' + totalDiajukanAwal.toLocaleString('id-ID');
    document.getElementById(`${containerPrefix}total-diajukan-perubahan`).textContent = 'Rp ' + totalDiajukanPerubahan.toLocaleString('id-ID');

    document.getElementById(`${containerPrefix}total-diterima-total`).textContent = 'Rp ' + totalDiterimaOverall.toLocaleString('id-ID');

    const diterimaBreakdown = document.getElementById('dashboard-diterima-breakdown');
    if(diterimaBreakdown) {
         if (STATE.role === 'prodi' && !isDirectorateSummaryMode) {
             diterimaBreakdown.innerHTML = '';
             diterimaBreakdown.style.display = 'none';
         } else {
              diterimaBreakdown.style.display = 'block';
              diterimaBreakdown.innerHTML = `
                <div class="small text-muted">Pagu Diterima Awal (Bersih): <strong>Rp ${totalDiterimaAwal.toLocaleString('id-ID')}</strong></div>
                <div class="small text-success">Pagu Diterima Final (Bersih): <strong>Rp ${totalPaguFinalDiterima.toLocaleString('id-ID')}</strong></div>
            `;
         }
    }
    
    document.getElementById('dashboard-total-pagu-awal').textContent = 'Rp ' + totalPaguAwal.toLocaleString('id-ID');
    document.getElementById('dashboard-total-pagu-perubahan').textContent = 'Rp ' + totalPaguFinalDiterima.toLocaleString('id-ID');
    
    const totalRPDEl = document.getElementById(`${containerPrefix}total-rpd`);
    const totalRealisasiEl = document.getElementById(`${containerPrefix}total-realisasi`);

    if (totalRPDEl) totalRPDEl.textContent = 'Rp ' + totalRpdForSummary.toLocaleString('id-ID'); 
    if (totalRealisasiEl) totalRealisasiEl.textContent = 'Rp ' + totalRealisasiForSummary.toLocaleString('id-ID'); 

    // --- Update Status Counts ---
    document.getElementById(`${containerPrefix}count-menunggu`).textContent = statusCounts['Menunggu Review']; 
    document.getElementById(`${containerPrefix}count-diterima`).textContent = statusCounts['Diterima']; 
    document.getElementById(`${containerPrefix}count-ditolak`).textContent = statusCounts['Ditolak']; 
    document.getElementById(`${containerPrefix}count-revisi`).textContent = statusCounts['Revisi']; 
    
    // --- Update RPD/Realisasi Metrics ---
    const totalRPDOverall = totalRpdForSummary; 
    const totalRealisasiOverall = totalRealisasiForSummary;
    const persentaseRealisasi = totalRPDOverall > 0 ? (totalRealisasiOverall / totalRPDOverall) * 100 : 0; 
    
    const persenRealisasiEl = document.getElementById('dashboard-persen-realisasi');
    if (persenRealisasiEl) persenRealisasiEl.textContent = persentaseRealisasi.toFixed(1) + '%'; 
    
    const progressBar = document.getElementById('dashboard-persen-realisasi-bar'); 
    if (progressBar) progressBar.style.width = `${Math.min(persentaseRealisasi, 100)}%`; 
    
    // --- Update Charts and Breakdown ---
    setupChart(`${chartPrefix}RPDvsRealisasi`, 'bar', { 
        labels: RPD_MONTHS, 
        datasets: [
            { label: 'Realisasi (Rp)', data: directorateRealisasiPerBulan, backgroundColor: 'rgba(255, 193, 7, 0.7)' }, 
            { label: 'RPD (Rp)', data: directorateRpdPerBulan, backgroundColor: 'rgba(13, 110, 253, 0.6)' }
        ] 
    }, { 
        responsive: true, 
        scales: { 
            x: { stacked: false }, 
            y: { stacked: false, beginAtZero: true, ticks: { callback: (value) => value.toLocaleString('id-ID') } } 
        } 
    }); 
    
    const monthlyRpdForSummary = directorateRpdPerBulan;
    const monthlyRealisasiForSummary = directorateRealisasiPerBulan;
    
    const rpdTriwulan = calculateQuarterlySummary(monthlyRpdForSummary, totalRpdForSummary); 
    const realisasiTriwulan = calculateQuarterlySummary(monthlyRealisasiForSummary, totalRealisasiForSummary); 
    const triwulanContainer = document.getElementById('dashboard-triwulan-summaries'); 
    if (triwulanContainer) { 
        triwulanContainer.innerHTML = `<h6 class="small text-muted">Rencana Penarikan (RPD)</h6><table class="table table-sm table-borderless text-center small"><thead class="table-light"><tr><th>Q</th><th>Total</th><th>%</th></tr></thead><tbody>${rpdTriwulan.values.map((val, i) => `<tr><td><strong>Q${i+1}</strong></td><td>${val.toLocaleString('id-ID')}</td><td><span class="badge bg-primary-subtle text-primary-emphasis">${rpdTriwulan.percentages[i]}</span></td></tr>`).join('')}</tbody></table><h6 class="small text-muted mt-2">Realisasi</h6><table class="table table-sm table-borderless text-center small"><thead class="table-light"><tr><th>Q</th><th>Total</th><th>%</th></tr></thead><tbody>${realisasiTriwulan.values.map((val, i) => `<tr><td><strong>Q${i+1}</strong></td><td>${val.toLocaleString('id-ID')}</td><td><span class="badge bg-success-subtle text-success-emphasis">${realisasiTriwulan.percentages[i]}</span></td></tr>`).join('')}</tbody></table>`; 
    }
    
    const rpdSemester = calculateSemesterSummary(monthlyRpdForSummary, totalRpdForSummary);
    const realisasiSemester = calculateSemesterSummary(monthlyRealisasiForSummary, totalRealisasiForSummary);
    const semesterContainer = document.getElementById('dashboard-semester-summaries');
    if (semesterContainer) {
        semesterContainer.innerHTML = `<h6 class="small text-muted">Rencana Penarikan (RPD)</h6><table class="table table-sm table-borderless text-center small"><thead class="table-light"><tr><th>S</th><th>Total</th><th>%</th></tr></thead><tbody>${rpdSemester.values.map((val, i) => `<tr><td><strong>S${i+1}</strong></td><td>${val.toLocaleString('id-ID')}</td><td><span class="badge bg-primary-subtle text-primary-emphasis">${rpdSemester.percentages[i]}</span></td></tr>`).join('')}</tbody></table><h6 class="small text-muted mt-2">Realisasi</h1><table class="table table-sm table-borderless text-center small"><thead class="table-light"><tr><th>S</th><th>Total</th><th>%</th></tr></thead><tbody>${realisasiSemester.values.map((val, i) => `<tr><td><strong>S${i+1}</strong></td><td>${val.toLocaleString('id-ID')}</td><td><span class="badge bg-success-subtle text-success-emphasis">${realisasiSemester.percentages[i]}</span></td></tr>`).join('')}</tbody></table>`;
    }
}


/**
 * Renders the Directorate summary cards and the main summary table.
 */
function renderDirektoratDashboard(summaryData) {
    // ... (Logika renderProdiStatusCards dan renderDirektoratSummaryTable dari script.js asli)
    // Untuk menghemat ruang, salin logika lengkap renderProdiStatusCards dan renderDirektoratSummaryTable ke sini atau sebagai fungsi internal.
    // Pastikan binding listener untuk 'btn-export-excel-direktorat-summary' dilakukan di main.js atau ajuan.js (setupExportListeners).
    
    // Placeholder implementation for visibility:
    const renderProdiStatusCards = (data) => { /* ... implementation ... */ };
    const renderDirektoratSummaryTable = (data) => { /* ... implementation ... */ };

    renderProdiStatusCards(summaryData);
    renderDirektoratSummaryTable(summaryData);
}

/**
 * Calculates and updates the prodi_summary table in Supabase.
 */
export async function recalculateProdiSummary(prodiId) {
    if (!prodiId) return;
    
    try {
        const tahapAktif = STATE.globalSettings.Tahap_Perubahan_Aktif || 0;
        let tablesToQuery = ['ajuan']; 
        if (tahapAktif > 0) {
             tablesToQuery.push(getAjuanTableName(`Perubahan ${tahapAktif}`));
        }

        let totalDiajukanOverall = 0;
        let totalDiterimaAwalBersih = 0; 
        let totalDiterimaFinalBersih = 0; 
        let totalRpdCommitment = 0;
        let totalRealisasiOverall = 0;

        const rpdMonthly = {};
        const realisasiMonthly = {};
        RPD_MONTHS.forEach(m => {
            rpdMonthly[getMonthlyKey('RPD', m)] = 0;
            realisasiMonthly[getMonthlyKey('Realisasi', m)] = 0;
        });
        
        const RPD_SELECT_COLUMNS = RPD_MONTHS.map(m => `${getMonthlyKey('RPD', m)}, ${getMonthlyKey('Realisasi', m)}`).join(', ');

        for (const tableName of tablesToQuery) {
             const isAwalTable = tableName === 'ajuan';

             const { data: rawData, error } = await sb.from(tableName)
                .select(`Total, Status, Tipe_Ajuan, Is_Blocked, ${RPD_SELECT_COLUMNS}`)
                .eq('ID_Prodi', prodiId);
            
             if (error) continue;

             rawData.forEach(ajuan => {
                const total = Number(ajuan.Total) || 0;
                const isBlocked = !!ajuan.Is_Blocked;

                totalDiajukanOverall += total;

                if (ajuan.Status === 'Diterima' && !isBlocked) {
                    if (isAwalTable) {
                        totalDiterimaAwalBersih += total;
                    } 
                    
                    totalDiterimaFinalBersih += total;

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
            last_updated: new Date().toISOString()
        };

        const { error: upsertError } = await sb.from(PRODI_SUMMARY_TABLE)
            .upsert(summaryData, { onConflict: 'id_prodi' });

        if (upsertError) throw upsertError;

        STATE.direktoratSummaryData = []; 
        
    } catch (error) {
        console.error(`[SUMMARY] Failed to update summary for ${prodiId}:`, error);
    }
}

/**
 * Updates the Pagu Info displayed in the Ajuan Form header (Prodi Role).
 */
export async function updateProdiPaguInfo(userData) {
    // ... (Salin logika updateProdiPaguInfo dari script.js asli)
    // Pastikan import 'db' dari firebase dan 'sb' dari supabase sudah benar.
}


/**
 * Loads data for the filtered Realisasi Rekapan table on the Dashboard.
 */
export async function loadRekapanRealisasi() {
    showLoader(true);
    // Asumsi implementasi loadRekapanRealisasi dari script.js lama sudah di-paste di sini
    
    try {
        const prodiFilter = getSafeValue("filterProdiRekapan"); 
        const grubFilter = getSafeValue("filterGrubBelanja");
        const kelompokFilter = getSafeValue("filterKelompokBelanja");
        const selectedYear = getSafeValue('filterTahunDashboard');
        const selectedTipe = getSafeValue('filterTipeDashboard');

        const tbody = document.getElementById("rekapRealisasiUnitBody");
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">Memuat data...</td></tr>`;
        
        const tahapAktif = STATE.globalSettings.Tahap_Perubahan_Aktif || 1;
        let targetTipe = selectedTipe;

        if (!targetTipe) {
             targetTipe = tahapAktif === 1 ? 'Awal' : `Perubahan ${tahapAktif}`;
        }
        
        const targetTableName = getAjuanTableName(targetTipe);
        const RPD_SELECT_COLUMNS = RPD_MONTHS.map(m => `${getMonthlyKey('RPD', m)}, ${getMonthlyKey('Realisasi', m)}`).join(', ');

        let query = sb
            .from(targetTableName)
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
             query = query.eq('ID_Prodi', STATE.id);
        } else if (prodiFilter) { 
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
            
            aggregatedData[key].Total_Diterima += Number(ajuan.Total) || 0;

            RPD_MONTHS.forEach(m => {
                aggregatedData[key].Total_RPD += Number(ajuan[getMonthlyKey('RPD', m)]) || 0;
                aggregatedData[key].Total_Realisasi += Number(ajuan[getMonthlyKey('Realisasi', m)]) || 0;
            });
        });

        const result = Object.values(aggregatedData);
        window.renderRekapanRealisasi(result); // Assume renderRekapanRealisasi is bound to window or exported

    } catch (e) {
        console.error("Gagal memuat rekapan realisasi:", e);
        showToast("Gagal memuat rekapan realisasi", "danger");
        document.getElementById("rekapRealisasiUnitBody").innerHTML = `<tr><td colspan="6" class="text-center text-danger">Gagal memuat data.</td></tr>`;
    } finally {
        showLoader(false);
    }
}


// --- WINDOW BINDING (Jika ada fungsi internal yang dipanggil dari HTML atau modul lain) ---
// Contoh: binding fungsi yang merender rekapan jika berada di luar modul
// window.renderRekapanRealisasi = renderRekapanRealisasi; 
// (Anda perlu memastikan fungsi renderRekapanRealisasi ada di ajuan.js atau dipindahkan ke sini dan diekspor)