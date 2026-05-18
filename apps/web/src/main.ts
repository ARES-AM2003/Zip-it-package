/**
 * ZipIt Web App — Main UI controller
 * Matrix-style UI wired to @blueneon/zip-it with persistent Hash Routing.
 */

import { createZipIt, getBrowserCapabilities, formatEta } from '@blueneon/zip-it';
import type { ProgressStats, FileEntry } from '@blueneon/zip-it';

// ─── Browser Capabilities ─────────────────────────────────────────────────────
const caps = getBrowserCapabilities();

// ─── ZipIt Engine ─────────────────────────────────────────────────────────────
const ds = createZipIt({
  concurrency: 4,
  onProgress: renderProgress,
  onComplete: (stats: ProgressStats) => {
    updateStatus(`SUCCESS // ${stats.totalFiles} ASSETS COMMITTED`);
  },
  onError: (err: Error, file: FileEntry) => {
    console.error(`ERROR on ${file.filename}:`, err);
  },
});

// ─── DOM References ───────────────────────────────────────────────────────────
function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Object ${id} not found in DOM`);
  return e as T;
}

const urlInput    = el<HTMLTextAreaElement>('url-input');
const apiUrlInput = el<HTMLInputElement>('api-url');
const fetchBtn    = el<HTMLButtonElement>('fetch-api-btn');
const goBtn       = el<HTMLButtonElement>('go-btn');
const resumeCard  = el<HTMLDivElement>('resume-card');
const resumeBtn   = el<HTMLButtonElement>('resume-btn');
const dismissBtn  = el<HTMLButtonElement>('dismiss-btn');
const resumeText  = el<HTMLParagraphElement>('resume-text');

const progBar     = el<HTMLDivElement>('prog-bar');
const progPct     = el<HTMLDivElement>('prog-pct');
const progStatus  = el<HTMLDivElement>('prog-status');
const pmFiles     = el<HTMLDivElement>('pm-files');
const pmSpeed     = el<HTMLDivElement>('pm-speed');
const pmEta       = el<HTMLDivElement>('pm-eta');
const fileList    = el<HTMLDivElement>('file-list');

const ctrlPause   = el<HTMLButtonElement>('ctrl-pause');
const ctrlResume  = el<HTMLButtonElement>('ctrl-resume');
const ctrlReset   = el<HTMLButtonElement>('ctrl-reset');

// ─── Hash Helper ──────────────────────────────────────────────────────────────
function updateStatus(msg: string) {
  progStatus.textContent = msg;
}

// ─── Session Hydration ────────────────────────────────────────────────────────
(async () => {
  try {
    const pending = await ds.hydrate();
    if (pending.length > 0) {
      resumeText.textContent = `${pending.length} nodes detected from previous buffer.`;
      resumeCard.style.display = 'flex';
      // Auto-focus the config if session found
      if (location.hash === '#landing' || !location.hash) {
        location.hash = '#config';
      }
    }
  } catch (e) {
    console.warn('Buffer empty');
  }
})();

resumeBtn.addEventListener('click', async () => {
  resumeCard.style.display = 'none';
  location.hash = '#transit';
  await ds.start({ saveToFolder: caps.fileSystemAccess });
});

dismissBtn.addEventListener('click', async () => {
  resumeCard.style.display = 'none';
  await ds.reset();
});

// ─── API Fetch Logic ──────────────────────────────────────────────────────────
fetchBtn.addEventListener('click', async () => {
  const url = apiUrlInput.value.trim();
  if (!url) return;

  fetchBtn.disabled = true;
  fetchBtn.textContent = 'BUSY...';

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const data = await res.json();
    let urls: string[] = [];

    if (Array.isArray(data)) {
      urls = data;
    } else if (data && typeof data === 'object') {
      urls = data.urls || data.presignedUrls || [];
    }

    if (urls.length > 0) {
      urlInput.value = urls.join('\n');
      urlInput.dispatchEvent(new Event('input'));
    } else {
      alert('EMPTY RESPONSE');
    }
  } catch (e: any) {
    alert(`FETCH ERROR: ${e.message}`);
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.textContent = 'FETCH';
  }
});

// ─── Execution Logic ──────────────────────────────────────────────────────────
function getMode(): string {
  return (window as any)._mode || 'folder';
}

goBtn.addEventListener('click', async () => {
  const urls = urlInput.value
    .split(/[\n,]+/)
    .map(u => u.trim())
    .filter(u => u.startsWith('http'));

  if (urls.length === 0) {
    alert('Paste source URLs to proceed.');
    return;
  }

  urls.forEach(url => ds.add(url));
  location.hash = '#transit';
  updateStatus('INITIALIZING TRANSIT...');

  try {
    if (getMode() === 'zip') {
      await ds.zip('archive.zip');
    } else {
      await ds.start({ saveToFolder: caps.fileSystemAccess });
    }
  } catch (e: any) {
    if (e.name !== 'AbortError') {
      updateStatus(`CRITICAL_FAIL: ${e.message}`);
    }
  }
});

// ─── Controls ─────────────────────────────────────────────────────────────────
ctrlPause.addEventListener('click', () => {
  ds.pause();
  ctrlPause.style.display = 'none';
  ctrlResume.style.display = 'inline-flex';
  updateStatus('PAUSED // IDLE');
});

ctrlResume.addEventListener('click', () => {
  ds.resume();
  ctrlResume.style.display = 'none';
  ctrlPause.style.display = 'inline-flex';
  updateStatus('RESUMING SYNC...');
});

ctrlReset.addEventListener('click', async () => {
  if (confirm('TERMINATE ALL JOBS?')) {
    await ds.reset();
    location.reload();
  }
});

// ─── Rendering Pipeline ───────────────────────────────────────────────────────
function renderProgress(stats: ProgressStats) {
  const pct = Math.round(stats.overallProgress * 100);
  
  if (progBar) progBar.style.width = `${pct}%`;
  if (progPct) progPct.textContent = `${pct}%`;
  if (pmFiles) pmFiles.textContent = `${stats.completedFiles} / ${stats.totalFiles}`;
  if (pmSpeed) pmSpeed.textContent = fmtSpeed(stats.speedBytesPerSecond);
  if (pmEta)   pmEta.textContent   = stats.etaSeconds != null ? formatEta(stats.etaSeconds) : '--';

  if (stats.stagedFiles > 0 && getMode() === 'folder') {
    updateStatus(`WRITING TO DISK // ${stats.stagedFiles} CLUSTERS`);
  } else if (stats.activeFiles > 0) {
    updateStatus(`SATURATING LINK // ${stats.activeFiles} ACTIVE WORKERS`);
  }

  renderFileList(stats.files);
}

function renderFileList(files: Map<string, FileEntry>) {
  const arr = Array.from(files.values()).sort((a, b) => {
    const order: any = { downloading: 0, transferring: 1, staged: 2, queued: 3, done: 4, error: 5 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9);
  });

  const existing = new Set(Array.from(fileList.children).map(c => (c as HTMLElement).dataset.id));

  arr.forEach(file => {
    const statusLabel = getStatusLabel(file);
    if (existing.has(file.id)) {
      const row = fileList.querySelector(`[data-id="${file.id}"]`) as HTMLElement;
      if (row) {
        const s = row.querySelector('.s-tag');
        if (s) s.textContent = statusLabel;
      }
    } else {
      const row = document.createElement('div');
      row.style.padding = '0.75rem 1.25rem';
      row.style.borderBottom = '1px solid rgba(34, 197, 94, 0.1)';
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.fontSize = '0.8rem';
      row.style.fontFamily = 'Geist Mono';
      row.dataset.id = file.id;
      row.innerHTML = `
        <span style="color: #fff; opacity: 0.7;">> ${file.filename}</span>
        <span class="s-tag" style="font-weight: 700; color: #22c55e;">${statusLabel}</span>
      `;
      fileList.appendChild(row);
    }
    existing.delete(file.id);
  });

  existing.forEach(id => fileList.querySelector(`[data-id="${id}"]`)?.remove());
}

function getStatusLabel(f: FileEntry): string {
  if (f.status === 'done') return 'DONE';
  if (f.status === 'downloading') return 'ACTIVE';
  if (f.status === 'staged') return 'STAGED';
  if (f.status === 'transferring') return 'MOVING';
  if (f.status === 'error') return 'FAIL';
  return f.status.toUpperCase();
}

function fmtSpeed(bps: number): string {
  if (bps <= 0) return '0 MB/s';
  const mbs = bps / (1024 * 1024);
  return `${mbs.toFixed(2)} MB/s`;
}
