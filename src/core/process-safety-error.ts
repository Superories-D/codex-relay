/** Cleanup failed before a worker could retain its process handle. Freeze dispatch. */
export class ProcessSafetyError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ProcessSafetyError";
  }
}
