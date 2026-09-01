import "server-only";

import { createHmac } from "node:crypto";

function requestSecret() {
  const value = process.env.RUNNER_PAIRING_REQUEST_SECRET;
  if (!value) throw new Error("Server configuration unavailable");
  return value;
}

function firstAddress(value: string | null) {
  return value?.split(",", 1)[0]?.trim().slice(0, 128) || "address-unavailable";
}

export function runnerClientAddressDigest(request: Request) {
  const address =
    process.env.VERCEL === "1"
      ? firstAddress(request.headers.get("x-vercel-forwarded-for"))
      : "address-unavailable";
  return createHmac("sha256", requestSecret())
    .update(address, "utf8")
    .digest("hex");
}
