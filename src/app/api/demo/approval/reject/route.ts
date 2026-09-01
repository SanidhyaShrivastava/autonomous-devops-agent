import { handleDemoApprovalDecision } from "@/lib/server/demo-approval";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return await handleDemoApprovalDecision(request, "rejected");
}
