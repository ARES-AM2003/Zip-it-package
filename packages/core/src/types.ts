/**
 * Full TypeScript type surface for @khatiwadaprashant/zipit-core
 * All public-facing types are exported from this module.
 */

// ─── File lifecycle ────────────────────────────────────────────────────────────

/** The complete lifecycle of a file in the ZipIt queue. */
export type FileStatus =
  | 'idle'       // Added but not started
  | 'queued'     // In queue, waiting for a free worker slot
  | 'downloading' // Actively being downloaded into OPFS
  | 'staged'     // Fully in OPFS, awaiting transfer to local disk
  | 'transferring' // Streaming from OPFS → local FS
  | 'done'       // Successfully transferred / zipped
  | 'paused'     // Mid-download, paused by user
  | 'error';     // Failed (errorMessage populated)

/** A single file entry tracked by ZipIt. */
export interface FileEntry {
  /** Unique identifier (derived from URL by default). */
  id: string;
  /** The remote URL to download from. */
  url: string;
  /** The name the file will be saved as. */
  filename: string;
  /**
   * Optional relative folder path (e.g. "photos/2024/trip").
   * Used to recreate directory structure when saving to local folder.
   */
  folder?: string;
  /** Total size in bytes (0 if unknown until HEAD response). */
  totalBytes: number;
  /** Bytes downloaded so far. */
  downloadedBytes: number;
  /** Current lifecycle state. */
  status: FileStatus;
  /** ISO timestamp of when this entry was added. */
  addedAt: number;
  /** Error message if status === 'error'. */
  errorMessage?: string;
  /** Arbitrary user-supplied metadata. */
  metadata?: Record<string, unknown>;
}

// ─── Progress ─────────────────────────────────────────────────────────────────

/** Summary stats emitted with every progress event. */
export interface ProgressStats {
  /** Total files across all statuses. */
  totalFiles: number;
  /** Files with status 'done'. */
  completedFiles: number;
  /** Files with status 'staged'. */
  stagedFiles: number;
  /** Files with status 'downloading'. */
  activeFiles: number;
  /** Total bytes across all files. */
  totalBytes: number;
  /** Bytes successfully downloaded (including staged). */
  downloadedBytes: number;
  /** 0–1, derived from downloadedBytes / totalBytes. */
  overallProgress: number;
  /** Estimated bytes per second (rolling 3-second window). */
  speedBytesPerSecond: number;
  /** Estimated seconds remaining. null if unknown. */
  etaSeconds: number | null;
  /** Map of fileId → FileEntry for all tracked files. */
  files: Map<string, FileEntry>;
  /**
   * ZIP generation progress (only populated during ds.zip()).
   */
  zipProgress?: {
    totalFiles: number;
    currentFileIndex: number;
    currentFileName: string;
    isFinished: boolean;
  };
}

// ─── Event handlers ────────────────────────────────────────────────────────────

/** Called periodically (throttled to rAF) as download progresses. */
export type ProgressHandler = (stats: ProgressStats) => void;

/** Called once all files reach 'done' status. */
export type CompleteHandler = (stats: ProgressStats) => void;

/** Called when any file encounters an unrecoverable error. */
export type ErrorHandler = (error: Error, file: FileEntry) => void;

/** Called when an individual file's status or progress changes. */
export type FileProgressHandler = (file: FileEntry) => void;

// ─── Options ──────────────────────────────────────────────────────────────────

/** Options passed to `createZipIt()`. */
export interface ZipItOptions {
  /**
   * Number of files to download simultaneously.
   * @default 3
   */
  concurrency?: number;
  /**
   * How many in-flight zip chunks are kept in the worker mailbox.
   * Higher = faster compression, higher RAM use.
   * @default 10
   */
  zipBackpressureLimit?: number;
  /**
   * Maximum bytes buffered in the ReadableStream before backpressure kicks in.
   * @default 5 * 1024 * 1024  (5 MB)
   */
  streamBufferBytes?: number;
  /**
   * IndexedDB database name for persisting download state.
   * Change this if you run multiple ZipIt instances on the same origin.
   * @default 'zipit_v1'
   */
  dbName?: string;
  /**
   * Called on every progress tick.
   */
  onProgress?: ProgressHandler;
  /**
   * Called when all files have completed.
   */
  onComplete?: CompleteHandler;
  /**
   * Called on any file error.
   */
  onError?: ErrorHandler;
  /**
   * Called when an individual file's state changes.
   */
  onFileProgress?: FileProgressHandler;
  /**
   * If true, automatically attempts to resume the previous session from IndexedDB on creation.
   * @default false
   */
  autoHydrate?: boolean;
}

/** Options for adding an individual file to the queue. */
export interface AddFileOptions {
  /**
   * Override the filename derived from the URL.
   * If omitted, extracted from the URL pathname or Content-Disposition.
   */
  filename?: string;
  /**
   * Relative folder path used to preserve directory structure.
   * e.g. "photos/2024" → saves to <root>/photos/2024/<filename>
   */
  folder?: string;
  /**
   * Known size in bytes. Providing this improves quota checks and progress accuracy.
   * If omitted, the worker will detect it from Content-Length.
   */
  totalBytes?: number;
  /** Any user data to attach; survives hydration across page reloads. */
  metadata?: Record<string, unknown>;
}

// ─── Instance ─────────────────────────────────────────────────────────────────

/** The object returned by `createZipIt()`. */
export interface ZipItInstance {
  /**
   * Add a file URL to the download queue.
   * Safe to call before `start()`.
   * @example ds.add('https://example.com/photo.jpg', { folder: 'photos/2024' })
   */
  add: (url: string, options?: AddFileOptions) => FileEntry;

  /**
   * Add multiple URLs at once.
   * @example ds.addAll(['https://example.com/a.jpg', 'https://example.com/b.jpg'])
   */
  addAll: (urls: string[], options?: AddFileOptions) => FileEntry[];

  /**
   * Begin downloading all queued files.
   * If `saveToFolder` is true, prompts for a directory via File System Access API.
   */
  start: (options?: { saveToFolder?: boolean }) => Promise<void>;

  /** Pause all active downloads (byte-level, resumable). */
  pause: () => void;

  /** Resume paused downloads. */
  resume: () => void;

  /**
   * Cancel all downloads and clear the queue.
   * Does NOT delete already-staged OPFS files — call `reset()` for that.
   */
  cancel: () => void;

  /**
   * Download all queued files as a single streaming ZIP archive.
   * Does NOT require `start()` to have been called first.
   *
   * @param outputFilename - The name of the resulting .zip file
   * @example ds.zip('my-photos.zip')
   */
  zip: (outputFilename?: string) => Promise<void>;

  /**
   * Prompt the user to pick a local folder and save all staged files there,
   * preserving relative folder structure.
   * Requires File System Access API (Chrome/Edge only).
   */
  saveToFolder: () => Promise<void>;

  /**
   * Subscribe to a ZipIt event.
   * @example ds.on('progress', (stats) => console.log(stats.overallProgress))
   */
  on: {
    (event: 'progress', handler: ProgressHandler): () => void;
    (event: 'complete', handler: CompleteHandler): () => void;
    (event: 'error', handler: ErrorHandler): () => void;
    (event: 'file-progress', handler: FileProgressHandler): () => void;
  };

  /**
   * Remove an event handler previously registered with `on()`.
   */
  off: {
    (event: 'progress', handler: ProgressHandler): void;
    (event: 'complete', handler: CompleteHandler): void;
    (event: 'error', handler: ErrorHandler): void;
    (event: 'file-progress', handler: FileProgressHandler): void;
  };

  /**
   * Get a snapshot of all currently tracked files.
   */
  getFiles: () => Map<string, FileEntry>;

  /**
   * Get the latest progress stats.
   */
  getProgress: () => ProgressStats;

  /**
   * Whether downloads are currently paused.
   */
  isPaused: () => boolean;

  /**
   * Whether there are active downloads or staged files.
   */
  isBusy: () => boolean;

  /**
   * Clear all state (IndexedDB + OPFS cache). Useful for a complete reset.
   */
  reset: () => Promise<void>;

  /**
   * Resume a previous session from IndexedDB.
   * Call on page load to detect and offer to resume interrupted downloads.
   * @returns Files that were interrupted and can be resumed.
   */
  hydrate: () => Promise<FileEntry[]>;
}
