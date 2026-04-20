import { StreamTrigger } from './StreamTrigger';
export declare class StreamCompressor {
    private worker;
    private readable;
    private nextFileId;
    private controller;
    private resumeRead;
    private readPacer;
    private activeChunksInFlight;
    private MAX_IN_FLIGHT;
    private _endSignaled;
    constructor();
    getStream(): ReadableStream<Uint8Array>;
    addFileStream(fileName: string, stream: ReadableStream<Uint8Array>): Promise<void>;
    end(): void;
}
export { StreamTrigger };
