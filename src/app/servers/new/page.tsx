import type { Metadata } from "next";

import { ServerOnboarding } from "@/components/server-onboarding";

export const metadata: Metadata = {
  title: "Connect one Linux runner · Autonomous DevOps Agent",
  description:
    "Pair one owner-bound Linux runner through an outbound heartbeat-only connection.",
};

export default function NewServerPage() {
  return (
    <main className="product-canvas">
      <ServerOnboarding />
    </main>
  );
}
