import React, { useEffect, useState } from "react";
import { t, errorText } from "../../renderer/i18n";
export function RemoteArtifacts({
  id,
  call,
}: {
  id: string;
  call: (name: string, args?: any) => Promise<any>;
}) {
  const [files, setFiles] = useState<any[]>([]),
    [preview, setPreview] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = () =>
    call("assets.list", { id })
      .then((r) => {
        setFiles(r.files);
        setError("");
      })
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    let current = true;
    void call("assets.list", { id })
      .then((r) => {
        if (current) setFiles(r.files);
      })
      .catch((e) => {
        if (current) setError(errorText(e));
      });
    return () => {
      current = false;
    };
  }, [id]);
  async function open(file: any, download: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await call("assets.read", { id, assetId: file.id });
      if (download) {
        const bytes = Uint8Array.from(atob(result.data), (c) =>
            c.charCodeAt(0),
          ),
          url = URL.createObjectURL(new Blob([bytes], { type: result.mime })),
          a = document.createElement("a");
        a.href = url;
        a.download = result.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else setPreview(result);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="remote-artifacts">
      <summary>
        {t("输出文件")} / {t("附件")} · {files.length}
      </summary>
      <button type="button" onClick={() => void refresh()} disabled={busy}>
        {t("刷新")}
      </button>
      {files.map((f) => (
        <div key={f.id}>
          <span>
            {f.name} · {f.size} B
          </span>
          <button
            type="button"
            onClick={() => void open(f, false)}
            disabled={busy}
          >
            {t("预览")}
          </button>
          <button
            type="button"
            onClick={() => void open(f, true)}
            disabled={busy}
          >
            {t("下载")}
          </button>
        </div>
      ))}
      {preview && (
        <section>
          <h3>{preview.name}</h3>
          {preview.preview !== undefined ? (
            <pre>{preview.preview}</pre>
          ) : preview.mime.startsWith("image/") ? (
            <img
              style={{ maxWidth: "100%" }}
              src={`data:${preview.mime};base64,${preview.data}`}
              alt={preview.name}
            />
          ) : (
            <p>{t("此文件请下载后查看。")}</p>
          )}
          <button type="button" onClick={() => setPreview(undefined)}>
            {t("关闭")}
          </button>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
