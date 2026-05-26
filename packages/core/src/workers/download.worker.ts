/// <reference lib="webworker" />
/**
 * ZipIt Download Worker
 *
 * Runs in a dedicated Web Worker thread. Fetches a file in streaming chunks
 * and writes them synchronously into the Origin Private File System (OPFS)
 * using FileSystemSyncAccessHandle for maximum throughput.
 *
 * Supports:
 * - Range requests (byte-level resumability)
 * - HEAD-based smart failover
 * - Pause via AbortController
 * - Content-Length metadata detection
 */

export interface WorkerStart {
  type: 'start';
  id: string;
  url: string;
  startByte: number;
}

export interface WorkerPause {
  type: 'pause';
  id: string;
}

export type WorkerInMessage = WorkerStart | WorkerPause;

export interface WorkerProgress {
  type: 'progress';
  id: string;
  downloadedBytes: number;
}

export interface WorkerCompleted {
  type: 'completed';
  id: string;
}

export interface WorkerPaused {
  type: 'paused';
  id: string;
}

export interface WorkerError {
  type: 'error';
  id: string;
  error: string;
}

export interface WorkerMetadataUpdate {
  type: 'metadata_update';
  id: string;
  totalBytes: number;
}

export type WorkerOutMessage =
  | WorkerProgress
  | WorkerCompleted
  | WorkerPaused
  | WorkerError
  | WorkerMetadataUpdate;

// ─── Worker state ──────────────────────────────────────────────────────────────
let isWatchdogAbort = false;
const activeTasks = new Map<string, { abortController: AbortController }>();

self.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  if (msg.type === 'start') {
    const { id, url, startByte } = msg;
    if (activeTasks.has(id)) return;

    isWatchdogAbort = false;
    const abortController = new AbortController();
    activeTasks.set(id, { abortController });

    try {
      await processDownload(id, url, startByte, abortController.signal);
    } catch (err: unknown) {
      const e = err as Error;
      if ((e.name === 'AbortError' || abortController.signal.aborted) && !isWatchdogAbort) {
        self.postMessage({ type: 'paused', id } satisfies WorkerPaused);
      } else {
        const errorMsg = isWatchdogAbort ? 'Download timed out (connection lost)' : (e.message || String(e));
        self.postMessage({
          type: 'error',
          id,
          error: errorMsg,
        } satisfies WorkerError);
      }
    } finally {
      activeTasks.delete(id);
    }
  } else if (msg.type === 'pause') {
    activeTasks.get(msg.id)?.abortController.abort();
  }
};

async function processDownload(
  id: string,
  url: string,
  startByte: number,
  signal: AbortSignal
): Promise<void> {
  const rootDir = await navigator.storage.getDirectory();
  const fileHandle = await rootDir.getFileHandle(id, { create: true });
  // @ts-ignore — createSyncAccessHandle is available in workers
  const accessHandle = await fileHandle.createSyncAccessHandle();

  const WATCHDOG_TIMEOUT_MS = 25000; // 25 seconds of silence
  let lastChunkTime = Date.now();
  let watchdogTimer: any = null;

  try {
    const headers = new Headers();
    if (startByte > 0) headers.set('Range', `bytes=${startByte}-`);

    // Start connection watchdog
    watchdogTimer = setInterval(() => {
      if (Date.now() - lastChunkTime > WATCHDOG_TIMEOUT_MS) {
        console.warn(`[DownloadWorker] Watchdog timed out downloading ${url} (no data for ${WATCHDOG_TIMEOUT_MS}ms). Aborting.`);
        isWatchdogAbort = true;
        activeTasks.get(id)?.abortController.abort();
      }
    }, 5000);

    let response = await fetchWithFallback(url, headers, signal);

    // Report total size if known
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
      const totalBytes = parseInt(contentLengthHeader, 10) + (startByte || 0);
      self.postMessage({
        type: 'metadata_update',
        id,
        totalBytes,
      } satisfies WorkerMetadataUpdate);
    }

    if (!response.body) throw new Error('Response body is null');

    const reader = response.body.getReader();
    let currentByte = startByte;
    let lastReportTime = Date.now();
    const REPORT_INTERVAL_MS = 300;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      // Update chunk timestamp on activity
      lastChunkTime = Date.now();

      // @ts-ignore — write options available in workers
      accessHandle.write(value, { at: currentByte });
      currentByte += value.byteLength;

      const now = Date.now();
      if (now - lastReportTime > REPORT_INTERVAL_MS) {
        self.postMessage({
          type: 'progress',
          id,
          downloadedBytes: currentByte,
        } satisfies WorkerProgress);
        lastReportTime = now;
      }
    }

    // @ts-ignore
    if (typeof accessHandle.flush === 'function') accessHandle.flush();

    // Final progress report
    self.postMessage({
      type: 'progress',
      id,
      downloadedBytes: currentByte,
    } satisfies WorkerProgress);

    self.postMessage({ type: 'completed', id } satisfies WorkerCompleted);
  } finally {
    if (watchdogTimer) clearInterval(watchdogTimer);
    accessHandle.close();
  }
}

/** Smart failover: HEAD check on 4xx/5xx before giving up. */
async function fetchWithFallback(
  url: string,
  headers: Headers,
  signal: AbortSignal
): Promise<Response> {
  let response: Response;

  try {
    response = await fetch(url, { headers, signal });

    if (!response.ok && response.status !== 206) {
      const head = await fetch(url, { method: 'HEAD', signal });
      if (head.status === 200) {
        response = await fetch(url, { headers, signal });
        if (!response.ok)
          throw new Error(`Download failed with HTTP ${response.status}`);
      } else {
        throw new Error(`Resource inaccessible (HTTP ${head.status})`);
      }
    }
  } catch (e: unknown) {
    const err = e as Error;
    if (err.name === 'AbortError') throw err;
    // Network error — attempt HEAD as diagnostic
    const head = await fetch(url, { method: 'HEAD', signal }).catch(() => null);
    if (head?.status === 200) {
      response = await fetch(url, { headers, signal });
    } else {
      throw err;
    }
  }

  return response;
}
