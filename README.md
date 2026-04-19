# @blueneon/zip-it

> High-performance, browser-based download manager for massive file batches (10 GB+). Built on the **Origin Private File System (OPFS)**, **File System Access API**, and **ZIP streaming** — with full resumability, pause/resume, and zero-dependency ZIP compression built in.

[![npm version](https://img.shields.io/npm/v/@blueneon/zip-it)](https://www.npmjs.com/package/@blueneon/zip-it)
[![license](https://img.shields.io/npm/l/@blueneon/zip-it)](./LICENSE)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@blueneon/zip-it)](https://bundlephobia.com/package/@blueneon/zip-it)

---

## Table of Contents

- [Why @blueneon/zip-it?](#-why-blueneonzip-it)
- [Installation](#-installation)
- [Quick Start](#-quick-start)
- [How It Works](#-how-it-works)
  - [Architecture Overview](#architecture-overview)
  - [DownloadManager – OPFS Pipeline](#downloadmanager--opfs-pipeline)
  - [ZipStreamingManager – Zero-Disk ZIP Mode](#zipstreamingmanager--zero-disk-zip-mode)
  - [StateStore – IndexedDB Persistence](#statestore--indexeddb-persistence)
  - [Web Workers](#web-workers)
  - [Backpressure & Memory Safety](#backpressure--memory-safety)
- [Usage](#-usage)
  - [Persistent Batch Downloads (Native Folder)](#1-persistent-batch-downloads-native-folder)
  - [On-the-Fly ZIP Streaming](#2-on-the-fly-zip-streaming)
  - [Pause & Resume](#3-pause--resume)
  - [Manual State Access](#4-manual-state-access)
- [API Reference](#-api-reference)
  - [DownloadManager](#downloadmanager)
  - [ZipStreamingManager](#zipstreamingmanager)
  - [StreamCompressor](#streamcompressor)
  - [StateStore](#statestore)
  - [Types](#types)
- [Browser Support](#-browser-support)
- [Contributing](#-contributing)

---

## ✨ Why @blueneon/zip-it?

Most browser download solutions either hit memory limits on large files, require server-side ZIP generation, or can't survive a page refresh. `@blueneon/zip-it` solves all three:

| Capability | @blueneon/zip-it | Typical Approach |
| :--- | :---: | :---: |
| Download 10 GB+ in-browser | ✅ | ❌ |
| Survive page refresh / crash | ✅ | ❌ |
| Pause and resume mid-download | ✅ | ❌ |
| Stream direct-to-ZIP (no temp disk) | ✅ | ❌ |
| Preserve folder structure in ZIP | ✅ | ❌ |
| RAM-safe backpressure | ✅ | ❌ |
| Zero server-side code required | ✅ | ❌ |

---

## 📦 Installation

```bash
npm install @blueneon/zip-it
```

**Peer dependency** — install `streamsaver` if you need ZIP Streaming on non-Chromium browsers:

```bash
npm install streamsaver
```

---

## ⚡ Quick Start

```typescript
import { DownloadManager } from '@blueneon/zip-it';

const manager = new DownloadManager();

manager.onProgress = (stats) => {
  console.log(`${stats.completedFiles} / ${stats.totalFiles} files done`);
};

await manager.startDownloads([
  { id: 'file-1', url: 'https://cdn.example.com/photo.jpg', fileName: 'photo.jpg', totalSize: 5_000_000 },
  { id: 'file-2', url: 'https://cdn.example.com/video.mp4', fileName: 'video.mp4', totalSize: 800_000_000 },
]);
```

---

## 🏗️ How It Works

### Architecture Overview

`@blueneon/zip-it` is composed of four cooperating layers:

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Your Application                             │
└─────────────────────────────┬────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
   ┌──────────▼──────────┐         ┌──────────▼──────────┐
   │   DownloadManager   │         │  ZipStreamingManager │
   │  (OPFS + Native FS) │         │  (Zero-Disk Streamer)│
   └──────────┬──────────┘         └──────────┬──────────┘
              │                               │
   ┌──────────▼──────────┐         ┌──────────▼──────────┐
   │   download.worker   │         │   StreamCompressor   │
   │  (fetch → OPFS I/O) │         │ (zip.worker + fflate)│
   └──────────┬──────────┘         └──────────┬──────────┘
              │                               │
   ┌──────────▼──────────┐         ┌──────────▼──────────┐
   │     StateStore      │         │    StreamTrigger     │
   │    (IndexedDB)      │         │  (streamsaver / SW)  │
   └─────────────────────┘         └─────────────────────┘
```

---

### DownloadManager – OPFS Pipeline

`DownloadManager` is the primary engine for downloading large batches of individual files. It uses a **two-phase pipeline**:

#### Phase 1 — Fetch → OPFS (via Web Worker)

Each file is assigned to a dedicated **Web Worker** (`download.worker.ts`). The worker:

1. Sends an HTTP `GET` with a `Range: bytes=N-` header to resume partial downloads.
2. Streams the response body chunk-by-chunk using the **Streams API** (`ReadableStream.getReader()`).
3. Writes each chunk synchronously to **OPFS** (Origin Private File System) using `createSyncAccessHandle()` — a zero-copy, high-throughput file I/O API available only inside workers.
4. Reports progress every 500 ms back to the main thread.
5. If a `GET` fails (e.g. 403/404), performs a `HEAD` check. If the HEAD returns 200 it retries the GET, otherwise it marks the file as errored and moves on.

This keeps the **main thread fully unblocked** and allows `concurrencyLimit` (default: 3) workers to run simultaneously.

#### Phase 2 — OPFS → Local File System (Transfer)

Once a file is fully staged in OPFS, it is **streamed directly** to the user's selected local directory via the **File System Access API** (`showDirectoryPicker`). The transfer uses `ReadableStream.pipeTo(writable)` so the OPFS file is never loaded into RAM in full. After a successful transfer the OPFS cache entry is deleted to reclaim storage.

**Nested folder structures** (via `relativePath`) are fully supported — subdirectories are created automatically using `getDirectoryHandle({ create: true })`.

---

### ZipStreamingManager – Zero-Disk ZIP Mode

For browsers that don't support the File System Access API (Firefox, Safari), or when you want to avoid the directory picker entirely, `ZipStreamingManager` streams files **directly into a ZIP archive** as they are downloaded — no temporary disk space required.

The flow:

1. A `StreamCompressor` is created, which spins up a `zip.worker` (using `fflate` under the hood) and bridges its output into a standard `ReadableStream<Uint8Array>`.
2. The OS download is **triggered immediately** via `StreamTrigger` (backed by `streamsaver`) before any data arrives, so the browser's native progress bar activates right away.
3. Files are fetched sequentially. If a file already exists in OPFS (e.g. partially staged by `DownloadManager`), it reads from OPFS instead of re-fetching from the network.
4. Each file's byte stream is pumped into the `StreamCompressor` using zero-copy `postMessage` transfer (`Transferable`).
5. When all files are added, `compressor.end()` triggers DEFLATE finalization, flushing the ZIP central directory and closing the output stream.

---

### StateStore – IndexedDB Persistence

`StateStore` is a thin, promise-based wrapper around the browser's **IndexedDB** API. It backs the `DownloadManager` with crash-safe persistence.

- **Database**: `DownloadManagerDB`, object store: `manifest`, keyed by file `id`.
- On every progress event, chunk write, status change (pending → downloading → completed → transferred), the metadata is `upsert`-ed atomically.
- On construction, `DownloadManager` calls `hydrateFromStore()` — any file in `pending`, `downloading`, or `completed` state is automatically re-queued, allowing downloads to **resume from the exact byte** they were interrupted at.
- After 100% of files reach `transferred` status, `stateStore.clearAll()` is called automatically to clean up the manifest.

---

### Web Workers

The package ships two inlined Web Workers (bundled as base-64 blobs via `?worker&inline`). **Consumers need zero bundler config** — no extra `worker` loader rules required.

| Worker | Role |
| :--- | :--- |
| `download.worker` | Per-file HTTP fetch + synchronous OPFS write |
| `zip.worker` | fflate DEFLATE compression on a dedicated thread |

Workers communicate with the main thread exclusively via **typed `postMessage` interfaces** (`WorkerInMessage` / `WorkerOutMessage`), keeping the API surface narrow and testable.

---

### Backpressure & Memory Safety

Large-file streaming is only safe if every link in the pipeline respects backpressure. `@blueneon/zip-it` implements it at three separate levels:

| Level | Mechanism | Purpose |
| :--- | :--- | :--- |
| **OPFS write** | Synchronous `SyncAccessHandle.write()` inside Worker | Zero-copy writes; no async buffering RAM overhead |
| **ZIP stream buffer** | `ReadableStream` with `highWaterMark: 5 MB` | Caps the in-memory buffer between compressor and disk writer |
| **Worker mailbox** | `MAX_IN_FLIGHT = 10` in-flight chunks cap | Prevents fflate's Worker mailbox from pre-loading gigabytes of future chunks |

When the OS disk write speed falls behind the network download speed, the `ReadableStream`'s `desiredSize` drops to ≤ 0, which locks the `readPacer` promise inside `StreamCompressor.addFileStream()`. This physically pauses fetching new bytes from the network until the consumer (streamsaver) drains the buffer and calls the stream's `pull()` hook.

---

## 📖 Usage

### 1. Persistent Batch Downloads (Native Folder)

```typescript
import { DownloadManager } from '@blueneon/zip-it';

const manager = new DownloadManager();

// Listen for real-time progress updates
manager.onProgress = (stats) => {
  const pct = ((stats.completedFiles / stats.totalFiles) * 100).toFixed(1);
  console.log(`Progress: ${pct}%`);
  console.log(`Downloaded: ${(stats.downloadedBytes / 1e6).toFixed(1)} MB`);
  console.log(`Actively downloading: ${stats.activeFiles}`);
  console.log(`Transferring to disk: ${stats.activeTransfers}`);
};

const files = [
  {
    id: 'doc-001',
    url: 'https://cdn.example.com/report.pdf',
    fileName: 'report.pdf',
    relativePath: 'documents/2024',  // saved to <selectedDir>/documents/2024/report.pdf
    totalSize: 12_000_000,
  },
  {
    id: 'img-002',
    url: 'https://cdn.example.com/photo.jpg',
    fileName: 'photo.jpg',
    totalSize: 4_500_000,
  },
];

// Triggers the native directory picker (Chrome/Edge only).
// Automatically resumes from where it left off if called again.
await manager.startDownloads(files);
```

---

### 2. On-the-Fly ZIP Streaming

```typescript
import { ZipStreamingManager } from '@blueneon/zip-it';

const zip = new ZipStreamingManager();

await zip.streamArchive('holiday-photos.zip', [
  { url: 'https://cdn.example.com/day1.jpg', fileName: 'day1/photo.jpg' },
  { url: 'https://cdn.example.com/day2.mp4', fileName: 'day2/video.mp4' },
]);
// The browser's native "Save As" dialog fires immediately.
// Files are compressed and streamed as they arrive — no temp storage needed.
```

**Hybrid mode** — stream files already cached in OPFS by `DownloadManager`:

```typescript
await zip.streamArchive('batch.zip', [
  { url: 'https://cdn.example.com/file.pdf', fileName: 'file.pdf', opfsId: 'doc-001' },
]);
// Reads from OPFS first; falls back to network fetch if not found.
```

---

### 3. Pause & Resume

```typescript
const manager = new DownloadManager();
await manager.startDownloads(files);

// Pause all active downloads
manager.togglePause();
console.log('Paused:', manager.getPaused()); // true

// Resume
manager.togglePause();
console.log('Paused:', manager.getPaused()); // false
```

Resume after a page refresh is **automatic** — just re-instantiate `DownloadManager`. It reads IndexedDB on construction and re-queues any unfinished files.

---

### 4. Manual State Access

```typescript
import { stateStore } from '@blueneon/zip-it';

// Inspect all tracked files
const all = await stateStore.getAll();
const pending = all.filter(f => f.status === 'pending');
const errored = all.filter(f => f.status === 'error');

console.log(`${pending.length} pending, ${errored.length} errored`);

// Get a single file's metadata
const meta = await stateStore.getFileMetadata('doc-001');
console.log(meta?.downloadedSize, '/', meta?.totalSize);

// Manually clear the manifest (e.g. to start a fresh batch)
await stateStore.clearAll();
```

---

## 📚 API Reference

### DownloadManager

```typescript
class DownloadManager {
  /** Callback fired every animation frame when state changes. */
  onProgress?: (stats: DownloadStats) => void;

  /** Queue files for downloading. Triggers native directory picker on first call. */
  startDownloads(requests: DownloadRequest[]): Promise<void>;

  /** Toggle pause/resume for all active workers. */
  togglePause(): void;

  /** Returns true if any workers are active or files are queued. */
  isBusy(): boolean;

  /** Returns true if currently paused. */
  getPaused(): boolean;

  /** Manually provide a directory handle (skip the picker). */
  setDirectoryHandle(handle: FileSystemDirectoryHandle): void;

  /** Returns true if a directory handle has been set. */
  hasDirectoryHandle(): boolean;

  /** Manually trigger a progress report. */
  reportProgress(): void;
}
```

---

### ZipStreamingManager

```typescript
class ZipStreamingManager {
  /** Returns true if a ZIP archive is currently being streamed. */
  get isBusy(): boolean;

  /**
   * Compress and stream files as a ZIP to the user's Downloads folder.
   * @param archiveName  File name of the resulting ZIP (e.g. "photos.zip")
   * @param requests     Array of files to include in the archive
   */
  streamArchive(archiveName: string, requests: ZipDownloadRequest[]): Promise<void>;
}
```

---

### StreamCompressor

Low-level class that bridges the `zip.worker` (fflate) with a standard `ReadableStream`. Use this if you need direct control over ZIP construction.

```typescript
class StreamCompressor {
  /** Returns the output ReadableStream<Uint8Array> of compressed ZIP bytes. */
  getStream(): ReadableStream<Uint8Array>;

  /** Add a file from any ReadableStream source. Awaitable — resolves when the file is fully added. */
  addFileStream(fileName: string, stream: ReadableStream<Uint8Array>): Promise<void>;

  /** Finalize the ZIP central directory and close the output stream. */
  end(): void;
}
```

---

### StateStore

```typescript
class StateStore {
  /** Get all file metadata records from IndexedDB. */
  getAll(): Promise<FileDownloadMetadata[]>;

  /** Get a single file's metadata by ID. */
  getFileMetadata(id: string): Promise<FileDownloadMetadata | undefined>;

  /** Insert or update a file's metadata record. */
  upsertFileMetadata(metadata: FileDownloadMetadata): Promise<void>;

  /** Delete a single file's record. */
  deleteFileMetadata(id: string): Promise<void>;

  /** Delete all records (clears the entire manifest). */
  clearAll(): Promise<void>;
}

/** Pre-initialized singleton — import and use directly. */
export const stateStore: StateStore;
```

---

### Types

#### `DownloadRequest`

| Property | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `id` | `string` | ✅ | Unique identifier used for resumability and OPFS keying. |
| `url` | `string` | ✅ | Source URL of the file to download. |
| `fileName` | `string` | ✅ | File name to use when saving to disk. |
| `relativePath` | `string` | ❌ | Subfolder path within the selected directory (e.g. `"photos/2024"`). |
| `totalSize` | `number` | ✅ | Expected file size in bytes. Used for quota checking and progress calculation. |

#### `DownloadStats`

| Property | Type | Description |
| :--- | :--- | :--- |
| `totalFiles` | `number` | Total files in the current batch. |
| `completedFiles` | `number` | Files staged in OPFS or transferred to disk. |
| `stagedFiles` | `number` | Files fully downloaded to OPFS, awaiting transfer. |
| `transferredFiles` | `number` | Files physically saved to the user's local directory. |
| `totalBytes` | `number` | Sum of all `totalSize` values. |
| `downloadedBytes` | `number` | Total bytes received across all active and completed files. |
| `activeFiles` | `string[]` | IDs of files currently being fetched by workers. |
| `activeTransfers` | `string[]` | IDs of files currently being moved from OPFS → local disk. |

#### `ZipDownloadRequest`

| Property | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `url` | `string` | ✅ | Source URL of the file. |
| `fileName` | `string` | ✅ | Path inside the ZIP archive (supports nested paths e.g. `"folder/subfolder/file.jpg"`). |
| `opfsId` | `string` | ❌ | OPFS key to read from instead of fetching from the network. |

#### `FileDownloadMetadata`

| Property | Type | Description |
| :--- | :--- | :--- |
| `id` | `string` | Unique file identifier. |
| `url` | `string` | Source URL. |
| `fileName` | `string` | Target file name. |
| `relativePath` | `string` | Subfolder path. |
| `totalSize` | `number` | Total expected size in bytes. |
| `downloadedSize` | `number` | Bytes successfully written to OPFS so far. |
| `status` | `DownloadStatus` | Current status: `pending` \| `downloading` \| `paused` \| `completed` \| `transferred` \| `error` |
| `errorMessage` | `string?` | Error details if status is `error`. |
| `timestamp` | `number` | Unix timestamp of the last state update. |

---

## 🌐 Browser Support

| Feature | Chrome / Edge 102+ | Firefox | Safari 16.4+ |
| :--- | :---: | :---: | :---: |
| OPFS (`createSyncAccessHandle`) | ✅ | ✅ | ✅ |
| File System Access API (`showDirectoryPicker`) | ✅ | ❌ | ❌ |
| ZIP Streaming fallback (streamsaver) | ✅ | ✅ | ✅ |
| Pause / Resume | ✅ | ✅ | ✅ |
| IndexedDB Persistence | ✅ | ✅ | ✅ |

> **Firefox / Safari**: The native directory picker is unavailable. `DownloadManager` will stage files in OPFS but cannot transfer them to a local folder. Use `ZipStreamingManager` as the delivery method on these browsers.

---

## 🤝 Contributing

Pull requests and issues are welcome. When contributing:

1. Fork the repo and create a feature branch.
2. Run `npm run dev` to spin up the demo harness.
3. Build with `npm run build:lib` before submitting.

---

MIT License — Created by **Rochak Sulu**
