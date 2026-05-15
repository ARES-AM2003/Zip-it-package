/**
 * DownloadEngine — the OPFS-backed multi-threaded download manager.
 *
 * Manages the full lifecycle:
 *   queued → downloading (OPFS) → staged → transferring (local disk) → done
 *
 * @internal
 */

import type {
  FileEntry,
  ZipItOptions,
  ProgressStats,
  ProgressHandler,
  CompleteHandler,
  ErrorHandler,
  FileProgressHandler,
} from '../types';
import { StateStore } from '../store/StateStore';
import { rafThrottle } from '../utils/helpers';
import type { WorkerInMessage, WorkerOutMessage } from '../workers/download.worker';

type EventMap = {
  progress: ProgressHandler[];
  complete: CompleteHandler[];
  error: ErrorHandler[];
  'file-progress': FileProgressHandler[];
  'zip-progress': ((stats: Required<ProgressStats>['zipProgress']) => void)[];
};

export class DownloadEngine {
  private store: StateStore;
  private files = new Map<string, FileEntry>();
  private queue: string[] = [];
  private activeWorkers = new Map<string, Worker>();
  private activeTransfers = new Set<string>();
  private directoryHandle: FileSystemDirectoryHandle | null = null;
  private concurrency: number;
  private _isPaused = false;
  private listeners: EventMap = {
    progress: [],
    complete: [],
    error: [],
    'file-progress': [],
    'zip-progress': [],
  };

  private zipProgress?: ProgressStats['zipProgress'];

  // Speed tracking (rolling 3s window)
  private speedSamples: { time: number; bytes: number }[] = [];

  private emitProgress: () => void;

  constructor(options: Required<ZipItOptions>, store: StateStore) {
    this.store = store;
    this.concurrency = options.concurrency;

    // Throttle progress reporting to animation frames
    this.emitProgress = rafThrottle(() => {
      const stats = this.buildStats();
      this.listeners.progress.forEach((h) => h(stats));

      if (stats.completedFiles === stats.totalFiles && stats.totalFiles > 0) {
        this.listeners.complete.forEach((h) => h(stats));
        // Auto-cleanup
        this.store.clearAll().catch(console.error);
      }
    });
  }

  // ─── Event system ──────────────────────────────────────────────────────────

  on<K extends keyof EventMap>(event: K, handler: EventMap[K][number]): () => void {
    (this.listeners[event] as unknown[]).push(handler);
    return () => this.off(event, handler);
  }

  off<K extends keyof EventMap>(event: K, handler: EventMap[K][number]): void {
    (this.listeners[event] as unknown[]) = (this.listeners[event] as unknown[]).filter(
      (h) => h !== handler
    );
  }

  // ─── File queue management ──────────────────────────────────────────────────

  addFile(entry: FileEntry): void {
    this.files.set(entry.id, entry);
    if (!this.queue.includes(entry.id)) {
      this.queue.push(entry.id);
    }
    this.store.upsert(entry).catch(console.error);
  }

  // ─── Download lifecycle ────────────────────────────────────────────────────

  async start(options: { saveToFolder?: boolean } = {}): Promise<void> {
    if (options.saveToFolder && 'showDirectoryPicker' in window) {
      try {
        this.directoryHandle = await (
          window as Window & { showDirectoryPicker: (opts: unknown) => Promise<FileSystemDirectoryHandle> }
        ).showDirectoryPicker({ mode: 'readwrite' });
      } catch (err: unknown) {
        const e = err as Error;
        if (e.name !== 'AbortError') throw e;
      }
    }

    // Update queued files to 'queued' status
    for (const id of this.queue) {
      const entry = this.files.get(id);
      if (entry && entry.status === 'idle') {
        this.updateFile(id, { status: 'queued' });
      }
    }

    this._isPaused = false;
    this.processQueue();
  }

  pause(): void {
    this._isPaused = true;
    for (const [id, worker] of this.activeWorkers) {
      worker.postMessage({ type: 'pause', id } satisfies WorkerInMessage);
    }
  }

  resume(): void {
    this._isPaused = false;
    this.processQueue();
  }

  cancel(): void {
    this._isPaused = true;
    for (const [id, worker] of this.activeWorkers) {
      worker.postMessage({ type: 'pause', id } satisfies WorkerInMessage);
      worker.terminate();
    }
    this.activeWorkers.clear();
    this.queue = [];
  }

  setDirectoryHandle(handle: FileSystemDirectoryHandle): void {
    this.directoryHandle = handle;
    if (!this._isPaused) this.processQueue();
  }

  isPaused(): boolean { return this._isPaused; }

  isBusy(): boolean {
    return this.activeWorkers.size > 0 || this.queue.length > 0 || this.activeTransfers.size > 0;
  }

  getFiles(): Map<string, FileEntry> {
    return new Map(this.files);
  }

  getProgress(): ProgressStats {
    return this.buildStats();
  }

  setZipProgress(progress?: ProgressStats['zipProgress']): void {
    this.zipProgress = progress;
    if (progress) {
      this.listeners['zip-progress'].forEach((h) => h(progress));
    }
    this.emitProgress();
  }

  async hydrate(): Promise<FileEntry[]> {
    const stored = await this.store.getAll();
    const resumable: FileEntry[] = [];

    for (const entry of stored) {
      // Re-hydrate in-memory map
      this.files.set(entry.id, entry);

      if (entry.status === 'downloading' || entry.status === 'queued' || entry.status === 'paused') {
        // Reset to queued so they can be resumed
        const updated = { ...entry, status: 'queued' as const };
        this.files.set(entry.id, updated);
        this.queue.push(entry.id);
        resumable.push(updated);
      } else if (entry.status === 'staged') {
        // Was staged in OPFS, needs transfer
        if (this.directoryHandle) {
          void this.transferToLocalDisk(entry);
        } else {
          this.queue.push(entry.id);
          resumable.push(entry);
        }
      }
    }

    this.emitProgress();
    return resumable;
  }

  async reset(): Promise<void> {
    this.cancel();
    this.files.clear();
    this.queue = [];
    await this.store.clearAll();
    // Clear OPFS cache
    try {
      const rootDir = await navigator.storage.getDirectory();
      for await (const [name] of (rootDir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
        await rootDir.removeEntry(name);
      }
    } catch {
      // OPFS cleanup best-effort
    }
  }

  // ─── Internal queue processing ─────────────────────────────────────────────

  private processQueue(): void {
    if (this._isPaused) return;

    while (this.activeWorkers.size < this.concurrency && this.queue.length > 0) {
      const nextId = this.queue.shift()!;
      const entry = this.files.get(nextId);
      if (!entry) continue;

      if (entry.status === 'staged' && this.directoryHandle) {
        void this.transferToLocalDisk(entry);
      } else if (entry.status !== 'staged') {
        this.startWorker(entry);
      }
    }

    this.emitProgress();
  }

  private startWorker(entry: FileEntry): void {
    const worker = new Worker(
      new URL('../workers/download.worker.ts', import.meta.url),
      { type: 'module' }
    );
    this.activeWorkers.set(entry.id, worker);
    this.updateFile(entry.id, { status: 'downloading' });

    worker.onmessage = async (event: MessageEvent<WorkerOutMessage>) => {
      const msg = event.data;
      const current = this.files.get(entry.id);
      if (!current) return;

      switch (msg.type) {
        case 'progress':
          this.updateFile(entry.id, { downloadedBytes: msg.downloadedBytes });
          this.trackSpeed(msg.downloadedBytes - (current.downloadedBytes || 0));
          break;

        case 'metadata_update':
          this.updateFile(entry.id, { totalBytes: msg.totalBytes });
          break;

        case 'completed':
          this.activeWorkers.delete(entry.id);
          worker.terminate();
          this.updateFile(entry.id, { status: 'staged' });
          if (this.directoryHandle) {
            void this.transferToLocalDisk(this.files.get(entry.id)!);
          }
          this.processQueue();
          break;

        case 'error': {
          const fileError = new Error(msg.error);
          this.activeWorkers.delete(entry.id);
          worker.terminate();
          this.updateFile(entry.id, { status: 'error', errorMessage: msg.error });
          this.listeners.error.forEach((h) => h(fileError, this.files.get(entry.id)!));
          this.processQueue();
          break;
        }

        case 'paused':
          this.activeWorkers.delete(entry.id);
          worker.terminate();
          this.updateFile(entry.id, { status: 'paused' });
          this.processQueue();
          break;
      }
    };

    worker.postMessage({
      type: 'start',
      id: entry.id,
      url: entry.url,
      startByte: entry.downloadedBytes || 0,
    } satisfies WorkerInMessage);
  }

  private async transferToLocalDisk(entry: FileEntry): Promise<void> {
    this.activeTransfers.add(entry.id);
    this.updateFile(entry.id, { status: 'transferring' });

    try {
      const rootDir = await navigator.storage.getDirectory();
      const opfsHandle = await rootDir.getFileHandle(entry.id);
      const opfsFile = await opfsHandle.getFile();

      const targetDir = await this.resolveTargetDir(entry.folder);
      const localHandle = await targetDir.getFileHandle(entry.filename, { create: true });
      const writable = await localHandle.createWritable();
      await opfsFile.stream().pipeTo(writable);

      // Clean up OPFS entry
      await rootDir.removeEntry(entry.id);

      this.updateFile(entry.id, { status: 'done' });
    } catch (err: unknown) {
      const e = err as Error;
      this.updateFile(entry.id, { status: 'error', errorMessage: e.message });
      this.listeners.error.forEach((h) => h(e, this.files.get(entry.id)!));
    } finally {
      this.activeTransfers.delete(entry.id);
      this.emitProgress();
    }
  }

  private async resolveTargetDir(folder?: string): Promise<FileSystemDirectoryHandle> {
    if (!this.directoryHandle) throw new Error('No directory handle');
    if (!folder) return this.directoryHandle;

    let current = this.directoryHandle;
    for (const part of folder.split('/').filter(Boolean)) {
      current = await current.getDirectoryHandle(part, { create: true });
    }
    return current;
  }

  // ─── State helpers ─────────────────────────────────────────────────────────

  private updateFile(id: string, updates: Partial<FileEntry>): void {
    const existing = this.files.get(id);
    if (!existing) return;
    const updated = { ...existing, ...updates };
    this.files.set(id, updated);
    this.store.upsert(updated).catch(console.error);
    this.listeners['file-progress'].forEach((h) => h(updated));
    this.emitProgress();
  }

  private trackSpeed(byteDelta: number): void {
    const now = Date.now();
    this.speedSamples.push({ time: now, bytes: byteDelta });
    // Keep only last 3 seconds
    const cutoff = now - 3000;
    this.speedSamples = this.speedSamples.filter((s) => s.time >= cutoff);
  }

  private buildStats(): ProgressStats {
    const allFiles = Array.from(this.files.values());
    const completedFiles = allFiles.filter((f) => f.status === 'done').length;
    const stagedFiles = allFiles.filter((f) => f.status === 'staged').length;
    const activeFiles = allFiles.filter((f) => f.status === 'downloading').length;
    const totalBytes = allFiles.reduce((s, f) => s + (f.totalBytes || 0), 0);
    const downloadedBytes = allFiles.reduce((s, f) => s + (f.downloadedBytes || 0), 0);

    const speedBytesPerSecond = this.speedSamples.reduce((s, x) => s + x.bytes, 0) / 3;
    const remaining = totalBytes - downloadedBytes;
    const etaSeconds = speedBytesPerSecond > 0 ? remaining / speedBytesPerSecond : null;

    return {
      totalFiles: allFiles.length,
      completedFiles,
      stagedFiles,
      activeFiles,
      totalBytes,
      downloadedBytes,
      overallProgress: totalBytes > 0 ? downloadedBytes / totalBytes : 0,
      speedBytesPerSecond,
      etaSeconds,
      files: new Map(this.files),
      zipProgress: this.zipProgress,
    };
  }
}
