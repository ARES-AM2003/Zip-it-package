export interface ZipDownloadRequest {
    url: string;
    fileName: string;
    opfsId?: string;
}
export declare class ZipStreamingManager {
    private _isBusy;
    get isBusy(): boolean;
    /**
     * Reads from OPFS if opfsId is provided, otherwise fetches from URL.
     */
    streamArchive(archiveName: string, requests: ZipDownloadRequest[]): Promise<void>;
}
