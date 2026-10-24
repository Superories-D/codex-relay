export type CliSetupState = {
  phase:
    | "checking"
    | "downloading"
    | "installing"
    | "verifying"
    | "ready"
    | "error";
  path?: string;
  version?: string;
  error?: string;
};
