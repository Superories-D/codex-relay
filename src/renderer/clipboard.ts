/** Desktop copying uses the trusted bridge; general browser permissions stay off. */
export async function copyText(text: string): Promise<void> {
  if (window.relay?.command)
    await window.relay.command("clipboard.writeText", text);
  else await navigator.clipboard.writeText(text);
}
