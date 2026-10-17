// Markdown/URL-style Windows paths may include a slash before the drive.
// Passing /D:/... to path.win32.resolve produces D:\D:\..., not D:\....
// This changes that representation only; raw filename percent signs stay intact.
export function normalizeLocalPath(value: string): string {
  return value.replace(/^[\\/](?=[a-z]:[\\/])/i, "");
}
