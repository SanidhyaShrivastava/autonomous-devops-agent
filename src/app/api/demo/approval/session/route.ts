import { handleDemoApprovalSession } from "@/lib/server/demo-approval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return await handleDemoApprovalSession(request);
}
