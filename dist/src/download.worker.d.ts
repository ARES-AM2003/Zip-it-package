export interface WorkerStartMessage {
    type: 'start';
    id: string;
    url: string;
    startByte: number;
}
export interface WorkerPauseMessage {
    type: 'pause';
    id: string;
}
export type WorkerInMessage = WorkerStartMessage | WorkerPauseMessage;
export interface WorkerProgressMessage {
    type: 'progress';
    id: string;
    downloadedSize: number;
}
export interface WorkerCompletedMessage {
    type: 'completed';
    id: string;
}
export interface WorkerPausedMessage {
    type: 'paused';
    id: string;
}
export interface WorkerErrorMessage {
    type: 'error';
    id: string;
    error: string;
}
export interface WorkerMetadataUpdateMessage {
    type: 'metadata_update';
    id: string;
    totalSize: number;
}
export type WorkerOutMessage = WorkerProgressMessage | WorkerCompletedMessage | WorkerPausedMessage | WorkerErrorMessage | WorkerMetadataUpdateMessage;
