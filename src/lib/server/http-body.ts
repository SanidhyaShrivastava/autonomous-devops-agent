export type LimitedBodyResult =
  | { status: "ok"; text: string }
  | { status: "too_large" };

export function isJsonContentType(value: string | null) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

export async function readLimitedBody(
  request: Request,
  maxBytes: number,
): Promise<LimitedBodyResult> {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return { status: "too_large" };
  }
  if (!request.body) return { status: "ok", text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel("request body limit exceeded");
      return { status: "too_large" };
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: "ok", text: new TextDecoder().decode(combined) };
}
