export declare class StreamTrigger {
    /**
     * Initializes the cross-browser native download mechanism.
     * If `totalSize` cannot be explicitly determined, the download happens successfully,
     * but the browser will only show an indefinite progress indicator until completion.
     */
    static triggerDownload(fileName: string, stream: ReadableStream<Uint8Array>, totalSize?: number): Promise<void>;
}
