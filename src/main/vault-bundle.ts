import { createHash } from "node:crypto";
import type { VaultManifest } from "../shared/vault";
export const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const escape = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
export function bundleMetadata(manifest: VaultManifest, verifier: Buffer, text = (source: string) => source) {
  const manifestJSON = JSON.stringify(manifest, null, 2) + "\n";
  const rows = manifest.artifacts.map(file => {
    const href = file.path.split("/").map(encodeURIComponent).join("/");
    const task = manifest.tasks.find(t => t.id === file.jobId)!;
    return `<tr><td>${escape(task.title)}</td><td><a href="${href}">${escape(file.relative)}</a></td><td>${file.bytes.toLocaleString("en-US")} B</td><td><code>${file.sha256}</code></td></tr>`;
  }).join("\n");
  const tasks = manifest.tasks.map(task => `<li>${escape(task.title)} · ${escape(text({completed:"已完成",paused:"已暂停",cancelled:"已取消",needs_attention:"需要处理"}[task.stateAtCapture]))}${task.workflow ? ` · ${escape(task.workflow.title)} (${task.workflow.step}/${task.workflow.total})` : ""}</li>`).join("\n");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';base-uri 'none';form-action 'none'"><title>${escape(manifest.title)}</title><style>
  :root{color-scheme:light dark;font-family:system-ui,"Segoe UI",sans-serif}body{max-width:1100px;margin:40px auto;padding:0 24px;line-height:1.65}h1{font-size:28px}p{overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:12px;border-bottom:1px solid #8886;vertical-align:top}code,pre{font-family:ui-monospace,monospace;font-size:12px;overflow-wrap:anywhere;white-space:pre-wrap}td:last-child{width:32%}.fingerprint{padding:16px;border:1px solid #8886;border-radius:10px}summary{cursor:pointer}a{color:light-dark(#245baa,#8bb5ef)}@media(max-width:650px){table,tr,th,td{display:block}thead{display:none}td{padding:7px 0}td:last-child{width:auto}tr{padding:12px 0}}
  </style></head><body><h1>${escape(manifest.title)}</h1><p>${escape(text("已保存的完整交付版本"))} · ${escape(new Date(manifest.sealedAt).toISOString())}</p>
  <p>${escape(text("此交付包包含实际产物文件；不依赖原工作目录或模型账户。"))}</p><p>${escape(text("在 Windows 上运行 Verify.cmd 可复核文件完整性；如有可信的清单指纹，可传给 Verify.ps1 进行比对。"))}</p>
  <div class="fingerprint">${escape(text("清单 SHA256"))}<br><code>${sha256(manifestJSON)}</code></div>
  <h2>${escape(text("保存时的任务状态"))}</h2><ul>${tasks}</ul>
  <h2>${escape(text("交付产物"))}</h2><table><thead><tr><th>${escape(text("任务"))}</th><th>${escape(text("文件"))}</th><th>${escape(text("大小"))}</th><th>SHA256</th></tr></thead><tbody>${rows}</tbody></table>
  <p><a href="manifest.json">${escape(text("验收清单与工作流来源"))}</a></p></body></html>\n`;
  const files = new Map<string, Buffer>([["manifest.json", Buffer.from(manifestJSON)], ["index.html", Buffer.from(html)], ["Verify.ps1", verifier],
    ["Verify.cmd", Buffer.from('@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Verify.ps1" %*\r\nset "verify_result=%ERRORLEVEL%"\r\necho.\r\npause\r\nexit /b %verify_result%\r\n')]]);
  const checksums = [...files].map(([name, bytes]) => `${sha256(bytes)} *${name}`)
    .concat(manifest.artifacts.map(file => `${file.sha256} *${file.path}`)).join("\n") + "\n";
  files.set("SHA256SUMS.txt", Buffer.from(checksums));
  return {files, manifestSha256: sha256(manifestJSON)};
}
