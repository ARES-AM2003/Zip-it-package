/**
 * ZipEngine — orchestrates streaming ZIP creation from URLs or OPFS files.
 *
 * This is the implementation behind `ds.zip('my-photos.zip')`.
 * Files are downloaded and zipped concurrently without loading all data into RAM.
 *
 * @internal
 */

import * as zip from '@zip.js/zip.js';

export interface ZipRequest {
  url: string;
  fileName: string;
  /** If provided, reads from OPFS instead of re-fetching from network. */
  opfsId?: string;
}

export interface ZipEngineOptions {
  maxInFlight?: number;
  streamBufferBytes?: number;
}

/**
 * Cross-browser download trigger for a ReadableStream.
 *
 * - Chrome/Edge: Uses File System Access API `showSaveFilePicker`
 * - Firefox/Safari/others: Falls back to streamsaver.js
 */
async function triggerStreamDownload(
  fileName: string,
  stream: ReadableStream<Uint8Array>
): Promise<void> {
  // Prefer native File System Access API save dialog (Tier 1)
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as Window & { showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle> })
        .showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: 'ZIP Archive', accept: { 'application/zip': ['.zip'] } }],
        });
      const writable = await handle.createWritable();
      await stream.pipeTo(writable);
      return;
    } catch (err: unknown) {
      const e = err as Error;
      if (e.name !== 'AbortError') {
        // Fall through to OPFS fallback
        console.warn('[ZipIt] showSaveFilePicker failed, falling back to OPFS:', e.message);
      } else {
        throw e; // User cancelled
      }
    }
  }

  // Fallback: OPFS Sandboxed Streaming + Native Browser Download (Tier 2)
  if (supportsOPFS()) {
    try {
      console.log('[ZipIt] OPFS streaming fallback starting...');
      const rootDir = await navigator.storage.getDirectory();
      const tempFileId = `temp_zip_${Date.now()}.zip`;

      // Setup Web Worker for synchronous writing to avoid main-thread hangs/blocking
      const workerBlob = new Blob([`
        let accessHandle = null;
        self.onmessage = async (e) => {
          const { type, fileId, chunk, at } = e.data;
          if (type === 'init') {
            try {
              const root = await navigator.storage.getDirectory();
              const handle = await root.getFileHandle(fileId, { create: true });
              accessHandle = await handle.createSyncAccessHandle();
              self.postMessage({ type: 'initialized' });
            } catch (err) {
              self.postMessage({ type: 'error', error: err.message });
            }
          } else if (type === 'write') {
            try {
              accessHandle.write(chunk, { at });
              self.postMessage({ type: 'written' });
            } catch (err) {
              self.postMessage({ type: 'error', error: err.message });
            }
          } else if (type === 'close') {
            try {
              if (accessHandle) {
                if (typeof accessHandle.flush === 'function') accessHandle.flush();
                accessHandle.close();
              }
              self.postMessage({ type: 'closed' });
            } catch (err) {
              self.postMessage({ type: 'error', error: err.message });
            }
          }
        };
      `], { type: 'application/javascript' });

      const workerUrl = URL.createObjectURL(workerBlob);
      const worker = new Worker(workerUrl);

      // Wait for initialization
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (e) => {
          if (e.data.type === 'initialized') resolve();
          else if (e.data.type === 'error') reject(new Error(e.data.error));
        };
        worker.postMessage({ type: 'init', fileId: tempFileId });
      });

      let currentOffset = 0;
      const opfsWritable = new WritableStream<Uint8Array>({
        write(chunk) {
          return new Promise<void>((resolve, reject) => {
            worker.onmessage = (e) => {
              if (e.data.type === 'written') resolve();
              else if (e.data.type === 'error') reject(new Error(e.data.error));
            };
            // Transfer the buffer for optimal performance (no copy)
            const buffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
            worker.postMessage(
              { type: 'write', chunk: new Uint8Array(buffer), at: currentOffset },
              [buffer]
            );
            currentOffset += chunk.byteLength;
          });
        },
        close() {
          return new Promise<void>((resolve, reject) => {
            worker.onmessage = (e) => {
              if (e.data.type === 'closed') resolve();
              else if (e.data.type === 'error') reject(new Error(e.data.error));
            };
            worker.postMessage({ type: 'close' });
          });
        },
        abort(err) {
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
          throw err;
        }
      });

      await stream.pipeTo(opfsWritable);
      worker.terminate();
      URL.revokeObjectURL(workerUrl);

      // Trigger native download via createObjectURL
      console.log('[ZipIt] OPFS zipping complete. Triggering native download...');
      const fileHandle = await rootDir.getFileHandle(tempFileId);
      const file = await fileHandle.getFile();
      const blobURL = URL.createObjectURL(file);

      const tempLink = document.createElement('a');
      tempLink.style.display = 'none';
      tempLink.href = blobURL;
      tempLink.setAttribute('download', fileName);
      document.body.appendChild(tempLink);
      tempLink.click();

      // Cleanup DOM node immediately, revoke URL after delay to allow browser to start download
      document.body.removeChild(tempLink);
      setTimeout(() => {
        URL.revokeObjectURL(blobURL);
      }, 30000);

      return;
    } catch (err: unknown) {
      console.error('[ZipIt] OPFS streaming fallback failed, trying streamsaver:', err);
      // Fall through to streamsaver
    }
  }

  // Fallback: streamsaver.js (Service Worker based) (Tier 3)
  const streamSaver = await import('streamsaver');
  const fileStream = streamSaver.default.createWriteStream(fileName);
  await stream.pipeTo(fileStream);
}

export class ZipEngine {
  private _isBusy = false;

  constructor(_options: ZipEngineOptions = {}) {
    // Native stream-based backpressure handles pacing automatically
    console.log('[ZipIt] (LOCAL OPTIMIZED BUILD) ZipEngine initialized successfully.');
  }

  get isBusy(): boolean {
    return this._isBusy;
  }

  /**
   * Stream-zip the provided requests into a single archive delivered directly
   * to the user's disk. Zero RAM spikes — files are compressed as they arrive.
   *
   * @example
   * await zipEngine.streamArchive('photos.zip', [
   *   { url: 'https://cdn.example.com/img1.jpg', fileName: 'img1.jpg' },
   * ])
   */
  async streamArchive(
    archiveName: string,
    requests: ZipRequest[],
    onProgress?: (stats: {
      currentFileIndex: number;
      totalFiles: number;
      currentFileName: string;
      isFinished: boolean;
    }) => void,
    onError?: (error: Error, fileName: string) => void
  ): Promise<void> {
    if (this._isBusy) {
      throw new Error(
        '[ZipIt] ZipEngine is already streaming an archive. ' +
          'Wait for the current operation to complete before starting a new one.'
      );
    }

    this._isBusy = true;
    console.log('[ZipIt] (LOCAL OPTIMIZED BUILD) Starting local ZIP64 compression stream for:', archiveName);

    // Clean up any old temp files from previous aborted sessions (non-blocking)
    if (supportsOPFS()) {
      navigator.storage.getDirectory().then(async (root) => {
        try {
          if (typeof (root as any)[Symbol.asyncIterator] === 'function') {
            for await (const [name] of (root as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
              if (name.startsWith('temp_zip_')) {
                await root.removeEntry(name).catch(() => {});
              }
            }
          }
        } catch (err) {
          console.warn('[ZipIt] Failed to run OPFS temp files cleanup:', err);
        }
      }).catch((err) => {
        console.warn('[ZipIt] Failed to access OPFS for cleanup:', err);
      });
    }

    // Disable web workers globally to avoid complex bundler worker path configuration.
    // Since level: 0 (STORE method) is used, there is virtually no CPU overhead, making Web Workers unnecessary.
    zip.configure({ useWebWorkers: false });

    // TransformStream bridges the ZIP writer to the download trigger
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const zipWriter = new zip.ZipWriter(writable, { zip64: true });

    // Trigger the OS download FIRST so the browser shows progress immediately
    let isAborted = false;
    const downloadPromise = triggerStreamDownload(archiveName, readable).catch(
      (err: unknown) => {
        const e = err as Error;
        isAborted = true;
        console.error('[ZipIt] Stream download failed or cancelled:', e);
        if (onError) onError(e, archiveName);
        throw e; // Propagate to caller
      }
    );

    try {
      const rootDir = supportsOPFS() ? await navigator.storage.getDirectory() : null;

      const usedNames = new Set<string>();
      for (let i = 0; i < requests.length; i++) {
        const req = requests[i];
        if (onProgress) {
          onProgress({
            currentFileIndex: i + 1,
            totalFiles: requests.length,
            currentFileName: req.fileName,
            isFinished: false,
          });
        }

        let stream: ReadableStream<Uint8Array> | null = null;

        // Prefer OPFS if the file was already staged
        if (req.opfsId && rootDir) {
          try {
            const fileHandle = await rootDir.getFileHandle(req.opfsId);
            const file = await fileHandle.getFile();
            stream = file.stream();
          } catch {
            // OPFS entry not found — fall through to network fetch
          }
        }

        // Network fetch as fallback (or primary for on-the-fly zip)
        if (!stream) {
          try {
            console.log(`[ZipIt] Processing file ${i + 1}/${requests.length}: ${req.fileName}`);
            const response = await fetch(req.url);
            if (!response.ok || !response.body) {
              throw new Error(`HTTP ${response.status}`);
            }
            stream = response.body;
          } catch (err: unknown) {
            const e = err as Error;
            console.warn(`[ZipIt] Failed to fetch ${req.url}: ${e.message}. Skipping.`);
            if (onError) onError(e, req.fileName);
            continue;
          }
        }

        if (isAborted) {
          console.warn('[ZipIt] Zipping loop aborted because download stream closed.');
          break;
        }

        // Duplicate name prevention
        let finalName = req.fileName;
        let counter = 1;
        while (usedNames.has(finalName)) {
          const extIndex = req.fileName.lastIndexOf(".");
          const base =
            extIndex > -1 ? req.fileName.slice(0, extIndex) : req.fileName;
          const ext = extIndex > -1 ? req.fileName.slice(extIndex) : "";
          finalName = `${base} (${counter++})${ext}`;
        }
        usedNames.add(finalName);

        // Add file to ZIPWriter. level: 0 specifies STORE (no compression),
        // which is ideal for pre-compressed images/videos and keeps CPU overhead near-zero.
        await zipWriter.add(finalName, stream, { level: 0 });
      }

      await zipWriter.close();

      if (onProgress) {
        console.log('[ZipIt] Zipping loop finished, reporting 100%');
        onProgress({
          currentFileIndex: requests.length,
          totalFiles: requests.length,
          currentFileName: '',
          isFinished: true,
        });
      }
      await downloadPromise;
    } finally {
      this._isBusy = false;
      console.log('[ZipIt] ZipEngine finished archive:', archiveName);
    }
  }
}

function supportsOPFS(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage !== 'undefined' &&
    typeof navigator.storage.getDirectory === 'function'
  );
}
