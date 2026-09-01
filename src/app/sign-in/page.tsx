import type { Metadata } from "next";

import { SignInForm } from "@/components/sign-in-form";

export const metadata: Metadata = {
  title: "Sign in · Autonomous DevOps Agent",
};

type SignInPageProps = {
  searchParams: Promise<{ returnTo?: string | string[] }>;
};

function safeReturnTo(value: string | string[] | undefined) {
  if (typeof value === "string" && value.startsWith("/servers")) {
    return value;
  }
  return "/servers/new";
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = await searchParams;

  return (
    <main className="product-canvas auth-canvas">
      <SignInForm returnTo={safeReturnTo(params.returnTo)} />
    </main>
  );
}
