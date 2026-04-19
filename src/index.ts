// === Core Managers ===
export { DownloadManager } from './DownloadManager';
export { ZipStreamingManager } from './ZipStreamingManager';
export { StreamCompressor } from './StreamCompressor';
export { StreamTrigger } from './StreamTrigger';

// === Types & Interfaces ===
export type { DownloadRequest, DownloadStats } from './DownloadManager';
export type { ZipDownloadRequest } from './ZipStreamingManager';
export type { FileDownloadMetadata, DownloadStatus } from './StateStore';

// === State Store (for advanced use cases) ===
export { StateStore, stateStore } from './StateStore';
