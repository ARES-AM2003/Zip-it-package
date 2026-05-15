/**
 * StreamCompressor — bridges the ZIP Web Worker into a WHATWG ReadableStream.
 *
 * Implements two-layer backpressure:
 * 1. ReadableStream highWaterMark prevents OS write pipeline saturation
 * 2. In-flight chunk counter prevents Worker mailbox bloating
 *
 * @internal
 */

export class StreamCompressor {
  private worker: Worker;
  private readable: ReadableStream<Uint8Array>;
  private nextFileId = 1;
  private controller!: ReadableStreamDefaultController<Uint8Array>;

  // Backpressure layer 1: ReadableStream pipeline
  private resumeRead!: () => void;
  private readPacer: Promise<void> | null = null;

  // Backpressure layer 2: Worker mailbox
  private activeChunksInFlight = 0;
  private readonly MAX_IN_FLIGHT: number;
  private readonly STREAM_BUFFER_BYTES: number;

  constructor(options: { maxInFlight?: number; streamBufferBytes?: number } = {}) {
    this.MAX_IN_FLIGHT = options.maxInFlight ?? 10;
    this.STREAM_BUFFER_BYTES = options.streamBufferBytes ?? 5 * 1024 * 1024;

    this.worker = new Worker(
      new URL('../workers/zip.worker.ts', import.meta.url),
      { type: 'module' }
    );

    let streamFinalize!: () => void;
    let streamError!: (err: unknown) => void;

    this.readable = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller;
          streamFinalize = () => controller.close();
          streamError = (err: unknown) => controller.error(err);
        },
        pull: () => {
          // OS disk caught up — release the backpressure lock
          if (this.readPacer) {
            this.resumeRead();
            this.readPacer = null;
          }
        },
      },
      {
        highWaterMark: this.STREAM_BUFFER_BYTES,
        size: (chunk) => chunk.byteLength,
      }
    );

    this.worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'data') {
        this.activeChunksInFlight = Math.max(0, this.activeChunksInFlight - 1);
        try {
          this.controller.enqueue(msg.chunk as Uint8Array);
        } catch {
          // Stream already closed/aborted — silently ignore
          return;
        }

        // Engage backpressure if OS disc is too slow
        if (
          this.controller.desiredSize !== null &&
          this.controller.desiredSize <= 0 &&
          !this.readPacer
        ) {
          this.readPacer = new Promise<void>((resolve) => {
            this.resumeRead = resolve;
          });
        }

        if (msg.final) {
          streamFinalize();
          this.worker.terminate();
        }
      } else if (msg.type === 'error') {
        streamError(new Error(msg.error as string));
        this.worker.terminate();
      }
    };

    this.worker.postMessage({ type: 'init' });
  }

  /** The ReadableStream of compressed ZIP bytes. */
  getStream(): ReadableStream<Uint8Array> {
    return this.readable;
  }

  /**
   * Add a file to the ZIP by streaming it through the worker.
   * Blocks (awaits) until all chunks of this file are flushed.
   */
  async addFileStream(
    fileName: string,
    stream: ReadableStream<Uint8Array>
  ): Promise<void> {
    console.log('[StreamCompressor] Starting file stream:', fileName);
    const fileId = this.nextFileId++;
    this.worker.postMessage({ type: 'addFile', fileId, fileName });

    const reader = stream.getReader();
    try {
      while (true) {
        // Wait for OS disc pressure to release before fetching more bytes
        if (this.readPacer) await this.readPacer;

        // Throttle worker mailbox
        while (this.activeChunksInFlight > this.MAX_IN_FLIGHT) {
          await new Promise<void>((r) => setTimeout(r, 10));
        }

        const { done, value } = await reader.read();

        if (done) {
          const empty = new Uint8Array(0);
          this.worker.postMessage(
            { type: 'chunk', fileId, chunk: empty, final: true },
            [empty.buffer]
          );
          break;
        }

        if (value) {
          this.activeChunksInFlight++;
          this.worker.postMessage(
            { type: 'chunk', fileId, chunk: value, final: false },
            [value.buffer]
          );
        }
      }
    } catch (err) {
      // Gracefully close the file stream to avoid a corrupted ZIP entry
      const empty = new Uint8Array(0);
      this.worker.postMessage(
        { type: 'chunk', fileId, chunk: empty, final: true },
        [empty.buffer]
      );
      throw err;
    } finally {
      reader.releaseLock();
    }
  }

  /** Signal end of all files — triggers ZIP central directory write. */
  end(): void {
    this.worker.postMessage({ type: 'end' });
  }
}
