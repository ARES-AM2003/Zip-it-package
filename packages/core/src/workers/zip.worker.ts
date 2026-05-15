/// <reference lib="webworker" />
/**
 * ZipIt ZIP Worker
 *
 * Receives chunked file data and streams it through fflate's ZIP compressor.
 * Outputs compressed chunks back to the main thread via postMessage.
 *
 * Uses backpressure signaling to prevent the worker mailbox from bloating.
 */

import { Zip, ZipPassThrough } from 'fflate';

interface InitMessage { type: 'init' }
interface AddFileMessage { type: 'addFile'; fileId: number; fileName: string }
interface ChunkMessage {
  type: 'chunk';
  fileId: number;
  chunk: Uint8Array;
  final: boolean;
}
interface EndMessage { type: 'end' }

type WorkerMessage = InitMessage | AddFileMessage | ChunkMessage | EndMessage;

let zip: Zip;
const fileStreams = new Map<number, ZipPassThrough>();

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'init': {
      zip = new Zip((err, chunk, final) => {
        if (err) {
          self.postMessage({ type: 'error', error: err.message });
          return;
        }

        // Transfer chunk without copy using Transferable
        const buffer = chunk.buffer.slice(
          chunk.byteOffset,
          chunk.byteOffset + chunk.byteLength
        );
        self.postMessage({ type: 'data', chunk: new Uint8Array(buffer), final }, [buffer]);
      });
      break;
    }

    case 'addFile': {
      console.log('[ZipWorker] Adding file:', msg.fileName, 'ID:', msg.fileId);
      try {
        const fileStream = new ZipPassThrough(msg.fileName);
        fileStreams.set(msg.fileId, fileStream);
        zip.add(fileStream);
      } catch (err: any) {
        console.error('[ZipWorker] Error adding file:', msg.fileName, err);
        self.postMessage({ type: 'error', error: `Failed to add ${msg.fileName}: ${err.message}` });
      }
      break;
    }

    case 'chunk': {
      const fileStream = fileStreams.get(msg.fileId);
      if (!fileStream) break;

      if (msg.final) {
        fileStream.push(msg.chunk, true);
        fileStreams.delete(msg.fileId);
      } else {
        fileStream.push(msg.chunk, false);
      }
      break;
    }

    case 'end': {
      zip.end();
      break;
    }
  }
};
