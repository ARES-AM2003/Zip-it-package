export type DownloadStatus = 'pending' | 'downloading' | 'paused' | 'completed' | 'transferred' | 'error';
export interface FileDownloadMetadata {
    id: string;
    url: string;
    fileName: string;
    relativePath: string;
    totalSize: number;
    downloadedSize: number;
    status: DownloadStatus;
    errorMessage?: string;
    timestamp: number;
}
export declare class StateStore {
    private dbPromise;
    constructor();
    getAll(): Promise<FileDownloadMetadata[]>;
    getFileMetadata(id: string): Promise<FileDownloadMetadata | undefined>;
    upsertFileMetadata(metadata: FileDownloadMetadata): Promise<void>;
    deleteFileMetadata(id: string): Promise<void>;
    clearAll(): Promise<void>;
}
export declare const stateStore: StateStore;
