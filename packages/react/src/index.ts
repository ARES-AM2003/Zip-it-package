/**
 * @blueneon/zipit-react — React hooks
 *
 * @example
 * import { useZipIt } from '@blueneon/zipit-react';
 *
 * const { files, progress, start, pause, zip } = useZipIt({ concurrency: 4 });
 */

export { useZipIt } from './hooks/useZipIt';
export { useZip } from './hooks/useZip';
export type { UseZipItReturn, UseZipItOptions } from './hooks/useZipIt';
export type { UseZipReturn } from './hooks/useZip';
