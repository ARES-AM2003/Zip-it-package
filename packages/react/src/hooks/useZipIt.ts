/**
 * useZipIt — primary React hook for batch downloading.
 *
 * Wraps `createZipIt` from `@khatiwadaprashant/zipit-core` and bridges it
 * into React's state model with stable callbacks.
 *
 * @example
 * ```tsx
 * import { useZipIt } from '@khatiwadaprashant/zipit-react';
 *
 * function MyDownloader({ urls }: { urls: string[] }) {
 *   const { progress, start, pause, resume, zip, files } = useZipIt({
 *     concurrency: 4,
 *   });
 *
 *   return (
 *     <div>
 *       <p>{(progress.overallProgress * 100).toFixed(1)}%</p>
 *       <button onClick={() => { urls.forEach(u => add(u)); start(); }}>Download</button>
 *       <button onClick={pause}>Pause</button>
 *       <button onClick={() => zip('archive.zip')}>Save as ZIP</button>
 *     </div>
 *   );
 * }
 * ```
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createZipIt,
  type ZipItOptions,
  type ZipItInstance,
  type ProgressStats,
  type FileEntry,
  type AddFileOptions,
} from '@khatiwadaprashant/zipit-core';

export type UseZipItOptions = ZipItOptions;

export interface UseZipItReturn {
  /** Add a single URL to the download queue. */
  add: (url: string, options?: AddFileOptions) => FileEntry;
  /** Add multiple URLs to the download queue. */
  addAll: (urls: string[], options?: AddFileOptions) => FileEntry[];
  /** Start all queued downloads. Optionally prompt for a save folder. */
  start: (options?: { saveToFolder?: boolean }) => Promise<void>;
  /** Pause active downloads (resumable). */
  pause: () => void;
  /** Resume paused downloads. */
  resume: () => void;
  /** Cancel all downloads. */
  cancel: () => void;
  /**
   * Stream all queued files into a single ZIP archive delivered to disk.
   * @param filename - The output ZIP filename. Defaults to 'dropstream-archive.zip'.
   */
  zip: (filename?: string) => Promise<void>;
  /** Prompt folder picker and save staged files to local disk. */
  saveToFolder: () => Promise<void>;
  /** Hydrate state from previous session (call on mount). */
  hydrate: () => Promise<FileEntry[]>;
  /** Clear all state and OPFS cache. */
  reset: () => Promise<void>;
  /** Live progress statistics, updated on every animation frame. */
  progress: ProgressStats;
  /** All tracked files, keyed by ID. */
  files: Map<string, FileEntry>;
  /** Whether downloads are currently paused. */
  isPaused: boolean;
  /** Whether there are active downloads in-flight. */
  isBusy: boolean;
  /** Direct access to the underlying ZipIt instance (escape hatch). */
  instance: ZipItInstance;
}

const EMPTY_PROGRESS: ProgressStats = {
  totalFiles: 0,
  completedFiles: 0,
  stagedFiles: 0,
  activeFiles: 0,
  totalBytes: 0,
  downloadedBytes: 0,
  overallProgress: 0,
  speedBytesPerSecond: 0,
  etaSeconds: null,
  files: new Map(),
};

/**
 * Core React hook for ZipIt.
 *
 * The ZipIt instance is created once (memoized for the lifetime of the component)
 * and event listeners are managed automatically.
 */
export function useZipIt(options: UseZipItOptions = {}): UseZipItReturn {
  // Memoize options as a stable ref to avoid re-creating the instance on every render
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  // Create the instance exactly once
  const instance = useMemo(
    () => createZipIt(optionsRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const [progress, setProgress] = useState<ProgressStats>(EMPTY_PROGRESS);
  const [isPaused, setIsPaused] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    const unsubProgress = instance.on('progress', (stats: ProgressStats) => {
      console.log('[ZipIt Hook] Received Progress Event:', stats.overallProgress, 'ZipProgress:', stats.zipProgress ? 'active' : 'none');
      setProgress(stats);
      setIsBusy(instance.isBusy());
    });

    const unsubComplete = instance.on('complete', (stats: ProgressStats) => {
      console.log('[ZipIt Hook] Received Complete Event');
      setProgress(stats);
      setIsBusy(false);
    });

    return () => {
      unsubProgress();
      unsubComplete();
    };
  }, [instance]);

  // ─── Stable callbacks ────────────────────────────────────────────────────

  const add = useCallback(
    (url: string, opts?: AddFileOptions) => instance.add(url, opts),
    [instance]
  );

  const addAll = useCallback(
    (urls: string[], opts?: AddFileOptions) => instance.addAll(urls, opts),
    [instance]
  );

  const start = useCallback(
    async (opts?: { saveToFolder?: boolean }) => {
      setIsBusy(true);
      setIsPaused(false);
      await instance.start(opts);
    },
    [instance]
  );

  const pause = useCallback(() => {
    instance.pause();
    setIsPaused(true);
  }, [instance]);

  const resume = useCallback(() => {
    instance.resume();
    setIsPaused(false);
  }, [instance]);

  const cancel = useCallback(() => {
    instance.cancel();
    setIsBusy(false);
    setIsPaused(false);
  }, [instance]);

  const zip = useCallback(
    (filename?: string) => instance.zip(filename),
    [instance]
  );

  const saveToFolder = useCallback(
    () => instance.saveToFolder(),
    [instance]
  );

  const hydrate = useCallback(
    () => instance.hydrate(),
    [instance]
  );

  const reset = useCallback(async () => {
    await instance.reset();
    setProgress(EMPTY_PROGRESS);
    setIsBusy(false);
    setIsPaused(false);
  }, [instance]);

  return {
    add,
    addAll,
    start,
    pause,
    resume,
    cancel,
    zip,
    saveToFolder,
    hydrate,
    reset,
    progress,
    files: progress.files,
    isPaused,
    isBusy,
    instance,
  };
}
