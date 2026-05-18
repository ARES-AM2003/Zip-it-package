/**
 * createZipIt — the primary public factory function.
 *
 * @example
 * ```ts
 * import { createZipIt } from '@blueneon/zip-it';
 *
 * const ds = createZipIt({ concurrency: 4 });
 * ds.add('https://example.com/photo1.jpg', { folder: 'photos' });
 * ds.add('https://example.com/photo2.jpg', { folder: 'photos' });
 *
 * ds.on('progress', ({ overallProgress }) => {
 *   console.log(`${(overallProgress * 100).toFixed(1)}%`);
 * });
 *
 * await ds.start({ saveToFolder: true });
 *
 * // OR: stream-zip without ever hitting the server
 * await ds.zip('my-photos.zip');
 * ```
 */

import type {
  ZipItOptions,
  ZipItInstance,
  AddFileOptions,
  FileEntry,
  ProgressHandler,
  CompleteHandler,
  ErrorHandler,
  FileProgressHandler,
} from '../types';
import { StateStore } from '../store/StateStore';
import { DownloadEngine } from './DownloadEngine';
import { ZipEngine } from '../zip/ZipEngine';
import { filenameFromUrl, idFromUrl } from '../utils/helpers';

const DEFAULT_OPTIONS: Required<ZipItOptions> = {
  concurrency: 3,
  zipBackpressureLimit: 10,
  streamBufferBytes: 5 * 1024 * 1024,
  dbName: 'zipit_v1',
  onProgress: undefined as unknown as ProgressHandler,
  onComplete: undefined as unknown as CompleteHandler,
  onError: undefined as unknown as ErrorHandler,
  onFileProgress: undefined as unknown as FileProgressHandler,
  autoHydrate: false,
};

/**
 * Create a new ZipIt instance.
 *
 * @param options - Configuration for concurrency, buffering, and event handlers.
 * @returns A `ZipItInstance` with the full public API.
 *
 * @example
 * const ds = createZipIt({ concurrency: 4, onProgress: console.log });
 */
export function createZipIt(options: ZipItOptions = {}): ZipItInstance {
  const resolved: Required<ZipItOptions> = { ...DEFAULT_OPTIONS, ...options };

  const store = new StateStore(resolved.dbName);
  const engine = new DownloadEngine(resolved, store);
  const zipEngine = new ZipEngine({
    maxInFlight: resolved.zipBackpressureLimit,
    streamBufferBytes: resolved.streamBufferBytes,
  });

  // Register top-level option handlers
  if (resolved.onProgress) engine.on('progress', resolved.onProgress);
  if (resolved.onComplete) engine.on('complete', resolved.onComplete);
  if (resolved.onError) engine.on('error', resolved.onError);
  if (resolved.onFileProgress) engine.on('file-progress', resolved.onFileProgress);

  // Handle autoHydrate
  if (resolved.autoHydrate) {
    void engine.hydrate().catch(console.error);
  }

  // ─── Helper ───────────────────────────────────────────────────────────────

  function buildEntry(url: string, opts: AddFileOptions = {}): FileEntry {
    const id = idFromUrl(`${url}${opts.folder ?? ''}`);
    return {
      id,
      url,
      filename: opts.filename ?? filenameFromUrl(url),
      folder: opts.folder,
      totalBytes: opts.totalBytes ?? 0,
      downloadedBytes: 0,
      status: 'idle',
      addedAt: Date.now(),
      metadata: opts.metadata,
    };
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  const instance: ZipItInstance = {
    add(url, opts) {
      const entry = buildEntry(url, opts);
      engine.addFile(entry);
      return entry;
    },

    addAll(urls, opts) {
      return urls.map((url) => instance.add(url, opts));
    },

    async start(opts) {
      await engine.start(opts);
    },

    pause() {
      engine.pause();
    },

    resume() {
      engine.resume();
    },

    cancel() {
      engine.cancel();
    },

    async zip(outputFilename = 'zipit-archive.zip') {
      const files = Array.from(engine.getFiles().values());
      const requests = files.map((f) => ({
        url: f.url,
        fileName: f.folder ? `${f.folder}/${f.filename}` : f.filename,
        opfsId: f.status === 'staged' ? f.id : undefined,
      }));

      await zipEngine.streamArchive(
        outputFilename,
        requests,
        (zipProgress) => {
          engine.setZipProgress(zipProgress);
        },
        (error, fileName) => {
          // Find the file that failed if possible, or create a mock entry
          const file = files.find((f) => f.filename === fileName) || {
            id: 'zip-error',
            url: '',
            filename: fileName,
            status: 'error',
            totalBytes: 0,
            downloadedBytes: 0,
            addedAt: Date.now(),
          } as FileEntry;
          
          // @ts-ignore - trigger private event system for now or expose a proper way
          engine.listeners.error.forEach((h: ErrorHandler) => h(error, file));
        }
      );

      // Clear zip progress when done
      engine.setZipProgress(undefined);
    },

    async saveToFolder() {
      if (!('showDirectoryPicker' in window)) {
        throw new Error(
          '[ZipIt] File System Access API (showDirectoryPicker) is not supported in this browser. ' +
            'Use ds.zip() as a fallback for Firefox/Safari.'
        );
      }
      const handle = await (
        window as Window & { showDirectoryPicker: (opts: unknown) => Promise<FileSystemDirectoryHandle> }
      ).showDirectoryPicker({ mode: 'readwrite' });
      engine.setDirectoryHandle(handle);
    },

    on(event: string, handler: unknown) {
      return engine.on(event as 'progress', handler as ProgressHandler);
    },

    off(event: string, handler: unknown) {
      engine.off(event as 'progress', handler as ProgressHandler);
    },

    getFiles() {
      return engine.getFiles();
    },

    getProgress() {
      return engine.getProgress();
    },

    isPaused() {
      return engine.isPaused();
    },

    isBusy() {
      return engine.isBusy() || zipEngine.isBusy;
    },

    async reset() {
      await engine.reset();
    },

    async hydrate() {
      return engine.hydrate();
    },
  };

  return instance;
}
