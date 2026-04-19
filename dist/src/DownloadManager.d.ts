export interface DownloadRequest {
    id: string;
    url: string;
    fileName: string;
    relativePath?: string;
    totalSize: number;
}
export interface DownloadStats {
    totalFiles: number;
    completedFiles: number;
    stagedFiles: number;
    transferredFiles: number;
    totalBytes: number;
    downloadedBytes: number;
    activeFiles: string[];
    activeTransfers: string[];
}
export declare class DownloadManager {
    private taskQueue;
    private activeWorkers;
    private activeTransfers;
    private directoryHandle;
    private concurrencyLimit;
    private isPaused;
    onProgress?: (stats: DownloadStats) => void;
    private progressAnimationFrame;
    constructor();
    private hydrateFromStore;
    startDownloads(requests: DownloadRequest[]): Promise<void>;
    private processQueue;
    private startWorker;
    private getTargetDirectoryHandle;
    private transferToLocalDisk;
    togglePause(): void;
    isBusy(): boolean;
    getPaused(): boolean;
    setDirectoryHandle(handle: FileSystemDirectoryHandle): void;
    hasDirectoryHandle(): boolean;
    reportProgress(): void;
}
