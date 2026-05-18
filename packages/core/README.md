# ZipIt ⚡

[![npm version](https://img.shields.io/npm/v/@blueneon/zip-it?color=7c6fff&style=flat-square)](https://www.npmjs.com/package/@blueneon/zip-it)
[![Bundle Size](https://img.shields.io/bundlephobia/minzip/@blueneon/zip-it?label=core%20gzipped&color=22d3a0&style=flat-square)](https://bundlephobia.com/package/@blueneon/zip-it)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/github/actions/workflow/status/rochaksulu/zipit/ci.yml?label=tests&style=flat-square)](https://github.com/Prashant8Khatiwada/zipit/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?style=flat-square)](https://www.typescriptlang.org/)

> **Client-side ZIP streaming and resumable batch download library for the browser.**
> No server. No RAM spikes. No compromise.

[**→ Live Demo**](https://zipit.dev) · [**Documentation**](https://zipit.dev/docs) · [**npm**](https://www.npmjs.com/package/@blueneon/zip-it)

---

## Why ZipIt?

Traditional file downloads are broken for large batches:

| Problem | Typical approach | ZipIt |
|---|---|---|
| **Zipping on the server** | CPU/memory spike, blocks requests | ✅ Zipped in browser, zero server cost |
| **RAM exhaustion** | Load all files into memory | ✅ OPFS staging with backpressure |
| **Lost progress on refresh** | Start over | ✅ Byte-level resumability via IndexedDB |
| **Flat directory output** | No folder structure | ✅ Native folder structure preserved |
| **Browser memory limits** | Crash on 1GB+ | ✅ Streaming writes below 5 MB working set |

---

## Getting Started

```bash
npm install @blueneon/zip-it fflate
# or
pnpm add @blueneon/zip-it fflate
```

**In 5 lines:**
```ts
import { createZipIt } from '@blueneon/zip-it';

const ds = createZipIt({ concurrency: 4 });
ds.add('https://example.com/photo1.jpg', { folder: 'photos/2024' });
ds.add('https://example.com/photo2.jpg', { folder: 'photos/2024' });
await ds.zip('my-photos.zip'); // ← Streams to disk. No RAM spike. No server.
```

### React
```bash
npm install @khatiwadaprashant/zipit-react @blueneon/zip-it fflate
```

```tsx
import { useZipIt } from '@khatiwadaprashant/zipit-react';

function Gallery({ urls }) {
  const { add, start, zip, progress, files } = useZipIt({ concurrency: 4 });

  return (
    <div>
      <p>{(progress.overallProgress * 100).toFixed(1)}%</p>
      <button onClick={() => { urls.forEach(u => add(u)); start({ saveToFolder: true }); }}>
        Download to Folder
      </button>
      <button onClick={() => zip('gallery.zip')}>Download as ZIP</button>
    </div>
  );
}
```

---

## Core Features

### 1. Client-side ZIP Streaming
ZIP files are assembled in the browser using streaming compression — files are compressed as they download, chunk by chunk:

```ts
// Stream-zip 500 photos without ever loading them all into RAM
await ds.zip('vacation-2024.zip');
```

No server endpoint. No temp files on the server. Works offline for cached OPFS files.

### 2. OPFS Staging Pipeline
Files are downloaded into the Origin Private File System (OPFS) using `FileSystemSyncAccessHandle` for maximum throughput, then streamed to the user's local folder:

```
Network → [Download Worker] → OPFS → [Main Thread] → Local Disk
```

### 3. Byte-level Resumability
Downloads survive page refreshes, browser crashes, and navigation:

```ts
// On page load — restore a previous session
const interrupted = await ds.hydrate();
if (interrupted.length > 0) {
  await ds.start({ saveToFolder: true }); // Resume where you left off
}
```

### 4. Folder Structure Preservation
```ts
ds.add('https://cdn.example.com/img1.jpg', { folder: 'photos/london/2024' });
ds.add('https://cdn.example.com/img2.jpg', { folder: 'photos/paris/2024' });
// → saves as: MyFolder/photos/london/2024/img1.jpg
//              MyFolder/photos/paris/2024/img2.jpg
await ds.start({ saveToFolder: true });
```

### 5. Intelligent Backpressure
Two-layer backpressure prevents RAM from spiking when disk is slower than network:
- **Layer 1**: ReadableStream `highWaterMark` (5 MB default)
- **Layer 2**: Worker mailbox chunk cap (10 in-flight chunks default)

---

## Full API Reference

### `createZipIt(options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `concurrency` | `number` | `3` | Parallel downloads |
| `zipBackpressureLimit` | `number` | `10` | Max in-flight ZIP chunks |
| `streamBufferBytes` | `number` | `5242880` | Max ReadableStream buffer (5 MB) |
| `dbName` | `string` | `'zipit_v1'` | IndexedDB store name |
| `onProgress` | `ProgressHandler` | — | Progress callback |
| `onComplete` | `CompleteHandler` | — | Called on batch complete |
| `onError` | `ErrorHandler` | — | Called on file error |
| `onFileProgress` | `FileProgressHandler` | — | Per-file state changes |

### Instance Methods

```ts
const ds = createZipIt(options);

// Queue management
ds.add(url, { filename?, folder?, totalBytes?, metadata? }): FileEntry
ds.addAll(urls, options?): FileEntry[]

// Lifecycle
await ds.start({ saveToFolder?: boolean })
ds.pause()
ds.resume()
ds.cancel()

// Output
await ds.zip(outputFilename?)          // Stream-zip to disk
await ds.saveToFolder()                // Pick folder and transfer

// Events (returns unsubscribe fn)
ds.on('progress', (stats: ProgressStats) => void)
ds.on('complete', (stats: ProgressStats) => void)
ds.on('error', (error: Error, file: FileEntry) => void)
ds.on('file-progress', (file: FileEntry) => void)
ds.off(event, handler)

// State
ds.getFiles(): Map<string, FileEntry>
ds.getProgress(): ProgressStats
ds.isPaused(): boolean
ds.isBusy(): boolean

// Session
await ds.hydrate(): FileEntry[]   // Restore previous session
await ds.reset()                  // Clear all state + OPFS
```

---

## Browser Compatibility

| Feature | Chrome | Edge | Firefox | Safari |
|---|---|---|---|---|
| Download + ZIP (core) | ✅ 102+ | ✅ 102+ | ✅ 111+ | ✅ 15.4+ |
| OPFS Staging | ✅ | ✅ | ✅ | ✅ 16+ |
| Native Folder Save | ✅ | ✅ | ❌ (ZIP fallback) | ❌ (ZIP fallback) |
| Resumable downloads | ✅ | ✅ | ✅ | ✅ |

---

## Migration from Server-side Zipping

**Before:**
```ts
// Server-side: blocks a worker for 30+ seconds per batch, OOM risk
app.get('/zip', async (req, res) => {
  const archive = archiver('zip');
  res.pipe(archive);
  for (const url of req.query.urls) {
    archive.append(fetch(url), { name: url.split('/').pop() });
  }
  await archive.finalize();
});
```

**After:**
```ts
// Client-side: instant, free, streams directly to disk
import { createZipIt } from '@blueneon/zip-it';
const ds = createZipIt();
urls.forEach(url => ds.add(url));
await ds.zip('archive.zip');
```

---

## Development

```bash
# Install all workspace deps
pnpm install

# Run web app
pnpm dev

# Run tests
pnpm test

# Build all packages
pnpm build

# Publish (on git tag)
git tag v0.1.0 && git push --tags
```

---

## Contributing

PRs welcome! Please follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.

---

## License

MIT © Prashant Khatiwada
