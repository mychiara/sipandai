// js/utils.js

/**
 * Menampilkan atau menyembunyikan loading overlay
 * @param {boolean} show 
 */
export function showLoader(show) {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.display = show ? 'flex' : 'none';
}

/**
 * Menampilkan pesan Toast (Notifikasi kecil)
 * @param {string} message - Isi pesan
 * @param {string} type - 'success', 'danger', 'warning', 'info'
 */
export function showToast(message, type = 'success') {
    const TOAST_CONTAINER = document.querySelector('.toast-container');
    if (!TOAST_CONTAINER) return;

    const toastId = 'toast-' + Date.now();
    const toastHTML = `
        <div id="${toastId}" class="toast align-items-center text-bg-${type} border-0" role="alert" aria-live="assertive" aria-atomic="true">
            <div class="d-flex">
                <div class="toast-body">${message}</div>
                <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
            </div>
        </div>`;
        
    TOAST_CONTAINER.insertAdjacentHTML('beforeend', toastHTML);
    const toastEl = document.getElementById(toastId);
    if (toastEl) {
        // Menggunakan Bootstrap global
        const toast = new bootstrap.Toast(toastEl, { delay: 5000 });
        toast.show();
        toastEl.addEventListener('hidden.bs.toast', () => toastEl.remove());
    }
}

/**
 * Mencegah XSS dengan meng-escape karakter HTML
 */
export function escapeHtml(s) {
    return s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';
}

/**
 * Mengambil nilai input dengan aman (mencegah error null)
 */
export function getSafeValue(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
}

/**
 * Mengambil status checked checkbox dengan aman
 */
export function getElChecked(id) {
    const el = document.getElementById(id);
    return el ? el.checked : false;
}

/**
 * Mengatur nilai input element
 */
export function setElValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
}

/**
 * Mengatur status checked checkbox
 */
export function setElChecked(id, checked) {
    const el = document.getElementById(id);
    if (el) el.checked = checked;
}

/**
 * Menambahkan event listener click dengan pengecekan elemen
 */
export function safeAddClickListener(id, handler) {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('click', handler);
    }
}

/**
 * Mendapatkan warna unik berdasarkan ID Prodi
 */
export function getColorForProdi(prodiId) {
    const PRODI_COLORS = [
        '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
        '#3a4e5a', '#6f4e37', '#a7c957', '#9b59b6', '#3498db', '#f1c40f', '#2ecc71', '#e74c3c', '#95a5a6', '#d35400',
        '#c0392b', '#16a085', '#27ae60', '#2980b9', '#8e44ad', '#f39c12', '#d35400', '#c0392b', '#16a085', '#27ae60'
    ];
    if (!prodiId) return '#cccccc';
    let hash = 0;
    for (let i = 0; i < prodiId.length; i++) {
        hash = prodiId.charCodeAt(i) + ((hash << 5) - hash);
    }
    return PRODI_COLORS[Math.abs(hash % PRODI_COLORS.length)];
}

/**
 * Membuat timestamp ISO String untuk Supabase
 */
export const sbTimestamp = () => new Date().toISOString();

/**
 * Membersihkan string agar aman digunakan sebagai ID/Class CSS
 */
export function sanitizeTipeForCSS(tipe) {
    if (!tipe) return '';
    return tipe.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '');
}

/**
 * Membuat key kolom database untuk RPD/Realisasi (contoh: rpd_jan, realisasi_mar)
 * @param {string} prefix - 'RPD' atau 'Realisasi'
 * @param {string} monthAbbr - 'Jan', 'Feb', dst.
 */
export const getMonthlyKey = (prefix, monthAbbr) => `${prefix.toLowerCase()}_${monthAbbr.toLowerCase()}`;

// --- CACHING FUNCTIONS ---

export function setCache(key, data, ttlMinutes = 120) {
    const now = new Date();
    const item = {
        value: data,
        expiry: now.getTime() + ttlMinutes * 60 * 1000,
    };
    try {
        localStorage.setItem(key, JSON.stringify(item));
    } catch (e) {
        console.warn("Gagal menyimpan cache, storage penuh.", e);
    }
}

export function getCache(key) {
    try {
        const itemStr = localStorage.getItem(key);
        if (!itemStr) return null;
        const item = JSON.parse(itemStr);
        const now = new Date();
        if (now.getTime() > item.expiry) {
            localStorage.removeItem(key);
            return null;
        }
        return item.value;
    } catch (e) {
        return null;
    }
}

// --- EXPORT & PRINT FUNCTIONS ---

/**
 * Export tabel HTML ke Excel menggunakan SheetJS (XLSX)
 */
export function exportTableToExcel(tableId, filename) {
    if (typeof XLSX === 'undefined') {
        showToast('Library XLSX (SheetJS) tidak dimuat.', 'danger');
        return;
    }
    const table = document.getElementById(tableId);
    if (!table) {
        showToast(`Tabel ID ${tableId} tidak ditemukan.`, 'warning');
        return;
    }

    const ws = XLSX.utils.table_to_sheet(table, { raw: true });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    const finalFilename = `${filename}_${new Date().toISOString().substring(0, 10)}.xlsx`;
    XLSX.writeFile(wb, finalFilename);
    showToast(`Data berhasil diekspor ke ${finalFilename}`, 'success');
}

/**
 * Export kontainer HTML ke PDF menggunakan html2pdf
 */
export function exportContainerToPDF(containerId, filename, defaultOrientation = 'portrait') {
    if (typeof html2pdf === 'undefined') {
        showToast('Library html2pdf.js tidak dimuat.', 'danger');
        return;
    }

    const container = document.getElementById(containerId);
    if (!container || container.innerHTML.trim() === '') {
        showToast('Konten kosong atau tidak ditemukan.', 'warning');
        return;
    }

    showLoader(true);

    let orientation = defaultOrientation;
    let format = 'A4';
    
    // Cek override dari dropdown UI jika ada
    const tabPrefix = containerId.replace('table', '').toLowerCase();
    const sizeEl = document.getElementById(`print-paper-size-${tabPrefix}`) || document.getElementById('ba-paper-size');
    const orientationEl = document.getElementById(`print-orientation-${tabPrefix}`) || document.getElementById('ba-orientation');

    if (sizeEl) format = sizeEl.value;
    if (orientationEl) orientation = orientationEl.value;

    const content = container.cloneNode(true);
    
    // Bersihkan elemen non-cetak
    content.querySelectorAll('.d-print-none').forEach(el => el.remove());
    
    // Paksa tabel responsive agar terlihat penuh
    content.querySelectorAll('.table-responsive').forEach(el => {
        el.style.overflow = 'visible';
        el.style.width = '100%';
    });

    if (containerId === 'berita-acara-content') {
        content.classList.add('ba-page-content');
    }

    const finalFilename = `${filename}_${new Date().toISOString().substring(0, 10)}.pdf`;
    const CAPTURE_WIDTH = orientation === 'landscape' ? 3500 : 2500;

    const options = {
        margin: [10, 10, 10, 10],
        filename: finalFilename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, logging: false, useCORS: true, width: CAPTURE_WIDTH, windowWidth: CAPTURE_WIDTH },
        jsPDF: { unit: 'mm', format: format, orientation: orientation }
    };

    html2pdf().from(content).set(options).save().then(() => {
        showToast(`Dokumen berhasil diekspor ke PDF.`, 'success');
    }).catch(e => {
        showToast(`Gagal ekspor PDF: ${e.message}`, 'danger');
    }).finally(() => {
        showLoader(false);
    });
}

/**
 * Mencetak area tertentu (Print Container)
 */
export function printContainer(containerId) {
    const container = document.getElementById(containerId);
    if (!container) {
        showToast('Konten tidak ditemukan untuk dicetak.', 'danger');
        return;
    }

    const printContents = container.innerHTML;
    let paperSize = 'A4';
    let orientation = 'portrait';

    const tabPrefix = containerId.replace('table', '').toLowerCase();
    const sizeEl = document.getElementById(`print-paper-size-${tabPrefix}`) || document.getElementById('ba-paper-size');
    const orientationEl = document.getElementById(`print-orientation-${tabPrefix}`) || document.getElementById('ba-orientation');

    if (sizeEl) paperSize = sizeEl.value;
    if (orientationEl) orientation = orientationEl.value;

    const printWindow = window.open('', '', 'height=600,width=800');

    printWindow.document.write('<html><head><title>Cetak Dokumen</title>');
    // Load Bootstrap untuk styling
    printWindow.document.write('<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">');
    
    // CSS Khusus Cetak (Salinan dari script asli)
    printWindow.document.write('<style>');
    printWindow.document.write(`
        body { font-family: 'Times New Roman', Times, serif; font-size: 10pt; padding: 15px; }
        @page { size: ${paperSize} ${orientation}; margin: 0.5in; }
        .d-print-none { display: none !important; }
        
        /* Styles for BA */
        .ba-page-content { max-width: 100%; margin: auto; }
        .ba-kop { text-align: center; margin-bottom: 20px; border-bottom: 2px solid #000; padding-bottom: 10px; }
        .ba-kop table { width: 100%; border: none; margin: auto; }
        .ba-kop img { height: 70px; }
        .ba-kop-text { line-height: 1.2; }
        .ba-kop-text h5 { margin: 0; font-weight: bold; }
        .ba-judul { text-align: center; margin-bottom: 25px; }
        .ba-judul h5 { font-size: 1.2em; font-weight: bold; margin: 5px 0; }
        .ba-judul p { font-size: 0.9em; margin-top: 5px; }
        .ba-paragraf { text-align: justify; margin-bottom: 20px; text-indent: 0.5in; }
        .ba-table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 9pt; }
        .ba-table th, .ba-table td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; }
        .ba-table th { text-align: center; background-color: #f2f2f2; }
        .ba-signatures table { width: 100%; margin-top: 50px; border: none; }
        .ba-signatures td { width: 50%; text-align: center; border: none; padding: 0; }
        
        /* Styles for General Tables */
        .table { border: 1px solid #000; table-layout: auto; width: 100% !important; max-width: 100% !important; font-size: 9pt; }
        .table thead th { background-color: #f2f2f2 !important; -webkit-print-color-adjust: exact; padding: 4px 6px; border: 1px solid #000 !important; }
        .table tbody td { padding: 4px 6px; border: 1px solid #000; }
        .action-buttons { display: none !important; }
        .prodi-indicator { border-left: none !important; }
        #${containerId} > .table-responsive { overflow: visible !important; }
    `);
    printWindow.document.write('</style></head><body>');
    printWindow.document.write(printContents);
    printWindow.document.write('</body></html>');

    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
        printWindow.print();
        printWindow.close();
    }, 500);
}

/**
 * Helper untuk format tampilan rincian kalkulasi (Breakdown)
 */
export function formatBreakdown(r) {
    if (r.calcA1 === undefined || r.calcA1 === null) {
        // Fallback ke format lama
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

    // Debugging hidden elements included if needed, mostly we show the summary
    return `<strong class="text-nowrap">${jumlah.toLocaleString('id-ID', { maximumFractionDigits: 2 })} ${satuan} X Rp ${harga.toLocaleString('id-ID')}</strong>`;
}