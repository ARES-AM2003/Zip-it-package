/**
 * URL and filename parsing utilities for ZipIt.
 */

/**
 * Derive a clean filename from a URL.
 * Strips query params and decodes URI encoding.
 *
 * @example
 * filenameFromUrl('https://cdn.example.com/photos/img_001.jpg?X-Amz-Expires=3600')
 * // → 'img_001.jpg'
 */
export function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Try to extract from S3/presigned URL first
    const amzKey = parsed.searchParams.get('response-content-disposition');
    if (amzKey) {
      const match = amzKey.match(/filename="?([^";]+)"?/);
      if (match?.[1]) return decodeURIComponent(match[1].trim());
    }

    const pathname = parsed.pathname;
    const parts = pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1];

    if (last && last.includes('.')) {
      return decodeURIComponent(last);
    }

    // Fallback: use host + timestamp
    return `download-${Date.now()}`;
  } catch {
    return `download-${Date.now()}`;
  }
}

/**
 * Generate a stable, collision-resistant ID from a URL.
 * Uses a simple djb2 hash to avoid crypto dependency.
 */
export function idFromUrl(url: string): string {
  let hash = 5381;
  for (let i = 0; i < url.length; i++) {
    hash = (hash * 33) ^ url.charCodeAt(i);
  }
  // Force unsigned 32-bit and convert to base36 for compact representation
  return (hash >>> 0).toString(36);
}

/**
 * Format bytes as a human-readable string (KB, MB, GB).
 * @example formatBytes(1536) // → '1.5 KB'
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Format seconds as a human-readable ETA string.
 * @example formatEta(3661) // → '1h 1m'
 */
export function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function rafThrottle<T extends (...args: unknown[]) => void>(fn: T): T {
  let rafId: number | null = null;
  let timeoutId: any = null;
  let lastArgs: unknown[] | null = null;

  return ((...args: unknown[]) => {
    lastArgs = args;
    const isHidden = typeof document !== 'undefined' && document.hidden;

    if (isHidden) {
      if (timeoutId !== null) return;
      timeoutId = setTimeout(() => {
        timeoutId = null;
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        fn(...(lastArgs || []));
      }, 250);
      return;
    }

    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      fn(...(lastArgs || []));
    });
  }) as T;
}
