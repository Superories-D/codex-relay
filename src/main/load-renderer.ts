import type { BrowserWindow } from "electron";
import { pathToFileURL } from "node:url";

// A trusted reload during initial navigation cancels loadFile with ERR_ABORTED.
// Wait for that navigation rather than treating the user's refresh as a fatal
// startup error. Other failures and unexpected destinations remain errors.
export async function loadRenderer(window: BrowserWindow, file: string) {
  try {
    await window.loadFile(file);
  } catch (error: any) {
    const contents = window.webContents,
      expected = pathToFileURL(file).href;
    if (
      error.code !== "ERR_ABORTED" ||
      window.isDestroyed() ||
      contents.getURL() !== expected
    )
      throw error;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        contents.removeListener("did-finish-load", finished);
        contents.removeListener("did-fail-load", failed);
        contents.removeListener("destroyed", destroyed);
      };
      const finish = (failure?: Error) => {
        cleanup();
        failure ? reject(failure) : resolve();
      };
      const finished = () =>
        finish(contents.getURL() === expected ? undefined : error);
      const failed = (
        _event: unknown,
        code: number,
        message: string,
        _url: string,
        main: boolean,
      ) => {
        if (main && code !== -3)
          finish(new Error(`Renderer load failed (${code}): ${message}`));
      };
      const destroyed = () => finish(error);
      const timer = setTimeout(
        () => finish(new Error("Renderer reload timed out during startup")),
        20000,
      );
      contents.on("did-finish-load", finished);
      contents.on("did-fail-load", failed);
      contents.once("destroyed", destroyed);
      if (!contents.isLoadingMainFrame()) finished();
    });
  }
}
