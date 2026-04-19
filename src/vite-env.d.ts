// Type declarations for Vite's special worker import queries.
// These are resolved at build time by Vite – the ?worker&inline suffix
// causes the worker script to be base64-encoded and inlined into the bundle.

declare module '*?worker&inline' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}

declare module '*?worker' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
