export function directoryName(path: string) { return path.slice(path.lastIndexOf('/') + 1) || '/'; }
