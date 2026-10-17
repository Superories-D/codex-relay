import type { ChatImage } from "./types";
const imagePath = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
export function protocolImages(item: any): ChatImage[] {
  const images: ChatImage[] = [];
  const origin: ChatImage["origin"] =
    ["userMessage", "message"].includes(item.type) && item.role !== "assistant"
      ? "input"
      : item.type === "imageView" ||
          /view_image$/.test(item.name || item.tool || "")
        ? "view"
        : "generated";
  const add = (value: unknown, mime?: string, name?: string, local = false) => {
    if (typeof value !== "string" || !value || images.length >= 20) return;
    if (/^https:\/\//i.test(value)) {
      if (!images.some((image) => image.url === value))
        images.push({
          id: `${item.id || item.call_id || "image"}:${images.length}`,
          origin,
          name: name || "image.png",
          url: value,
          mime,
        });
      return;
    }
    const data = /^data:image\/(png|jpeg|webp|gif|avif|bmp);base64,/i.test(
      value,
    )
      ? value
      : !local &&
          mime?.startsWith("image/") &&
          !/^(?:https?:|data:)/i.test(value) &&
          !imagePath.test(value)
        ? `data:${mime};base64,${value}`
        : undefined;
    const file =
      !data &&
      (local || imagePath.test(value)) &&
      !/^(https?:|data:)/i.test(value)
        ? value
        : undefined;
    if (!data && !file) return;
    if (images.some((image) => (image.path || image.data) === (file || data)))
      return;
    const fileName = file?.split(/[\\/]/).at(-1);
    images.push({
      id: `${item.id || item.call_id || "image"}:${images.length}`,
      origin,
      name:
        name ||
        (origin === "generated" && /^exec-[a-f\d-]+\.png$/i.test(fileName || "")
          ? "generated-image.png"
          : fileName) ||
        `image-${images.length + 1}.png`,
      ...(file ? { path: file } : { data }),
      mime,
    });
  };
  const content = (parts: any) => {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "localImage")
        add(part.path, undefined, part.name, true);
      if (
        ["image", "inputImage", "input_image", "output_image"].includes(
          part.type,
        )
      )
        add(
          part.data ||
            part.imageUrl ||
            part.image_url?.url ||
            part.image_url ||
            part.url,
          part.mimeType || part.mime_type,
          part.name,
        );
      if (
        part.type === "resource" &&
        part.resource?.mimeType?.startsWith("image/")
      )
        add(part.resource.blob, part.resource.mimeType, part.resource.name);
    }
  };
  if (item.type === "imageView") add(item.path, undefined, undefined, true);
  if (
    item.type === "imageGeneration" ||
    item.type === "image_generation_call"
  ) {
    if (item.savedPath || item.saved_path)
      add(item.savedPath || item.saved_path, undefined, undefined, true);
    else if (typeof item.result === "string") add(item.result, "image/png");
  }
  if (/view_image$/.test(item.name || "")) {
    try {
      const args =
        typeof item.arguments === "string"
          ? JSON.parse(item.arguments)
          : item.arguments;
      add(args?.path, undefined, undefined, true);
    } catch {}
  }
  content(item.content);
  content(item.contentItems);
  content(item.result?.content);
  content(item.output?.content);
  content(item.output);
  if (item.result?.structuredContent?.image_url)
    add(item.result.structuredContent.image_url);
  if (item.result?.structuredContent?.imageUrl)
    add(item.result.structuredContent.imageUrl);
  if (
    typeof item.output === "string" &&
    /^[\[{]/.test(item.output) &&
    item.output.length < 40 * 1024 * 1024
  ) {
    try {
      const out = JSON.parse(item.output);
      content(out.content || out);
      if (out.image_url) add(out.image_url);
    } catch {}
  }
  return images;
}
export function imageSafePayload(item: any) {
  return JSON.parse(
    JSON.stringify(item, (key, value) =>
      typeof value === "string" &&
      (/^data:image\//.test(value) ||
        (["data", "blob", "result"].includes(key) && value.length > 4096))
        ? "[image payload saved separately]"
        : value,
    ),
  );
}
