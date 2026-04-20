import { ZipWriter } from '@zip.js/zip.js';

let zipWriter: ZipWriter<Uint8Array> | null = null;
const fileControllers = new Map<number, ReadableStreamDefaultController<Uint8Array>>();
const activeAdds: Promise<any>[] = [];

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  try {
    if (msg.type === 'init') {
      const stream = new WritableStream({
        write(chunk) {
          // Send generated ZIP chunks back to the main thread securely 
          // without copying them in memory.
          self.postMessage({ type: 'data', chunk, final: false }, [chunk.buffer]);
        }
      });
      // zip64: true is the key here for 15GB+ support
      zipWriter = new ZipWriter(stream, { zip64: true });
    } else if (msg.type === 'addFile') {
      if (!zipWriter) return;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          fileControllers.set(msg.fileId, controller);
        }
      });

      // level: 0 ensures "store" mode (no compression), which prevents CPU spikes.
      // Track this addition so we can await it during closure
      const addPromise = zipWriter.add(msg.fileName, stream, { level: 0 });
      activeAdds.push(addPromise);
      
      // Remove from active list when done
      addPromise.finally(() => {
        const index = activeAdds.indexOf(addPromise);
        if (index > -1) activeAdds.splice(index, 1);
      });
    } else if (msg.type === 'chunk') {
      const controller = fileControllers.get(msg.fileId);
      if (controller) {
        if (msg.final) {
          controller.close();
          fileControllers.delete(msg.fileId);
        } else if (msg.chunk && msg.chunk.length > 0) {
          controller.enqueue(msg.chunk);
        }
      }
    } else if (msg.type === 'end') {
      if (zipWriter) {
        // Wait for all currently adding files to finish being pulled by zip.js
        await Promise.all(activeAdds);
        await zipWriter.close();
        zipWriter = null;
        // Signal the very end of the ZIP stream
        self.postMessage({ type: 'data', chunk: new Uint8Array(0), final: true });
      }
    }
  } catch (err: any) {
    self.postMessage({ type: 'error', error: err.message || err.toString() });
  }
};
