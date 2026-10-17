// PowerShell 7 and IDE hosts can export module paths that are incompatible with
// Windows PowerShell 5.1. Let powershell.exe rebuild its own default module path.
export function windowsPowerShellEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"),
  );
}
