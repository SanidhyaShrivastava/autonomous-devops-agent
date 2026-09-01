"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type AuthFlow = "signIn" | "signUp";

export function SignInForm({ returnTo }: { returnTo: string }) {
  const { signIn } = useAuthActions();
  const router = useRouter();
  const [flow, setFlow] = useState<AuthFlow>("signIn");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const formData = new FormData(event.currentTarget);
      formData.set("flow", flow);
      await signIn("password", formData);
      router.replace(returnTo);
      router.refresh();
    } catch {
      setError(
        flow === "signIn"
          ? "Sign in failed. Check your email and password."
          : "Account creation failed. Use a valid email and at least 8 password characters.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="auth-shell" aria-labelledby="auth-title">
      <Link className="auth-back-link" href="/">
        ← Return to recovery demo
      </Link>
      <p className="section-kicker">Operator access · private preview</p>
      <h1 id="auth-title">
        {flow === "signIn" ? "Sign in to connect a runner" : "Create your operator account"}
      </h1>
      <p className="auth-intro">
        A connected Linux runner creates credentials and future recovery authority,
        so it must belong to a named owner.
      </p>

      <form className="auth-form" onSubmit={handleSubmit}>
        <label htmlFor="operator-email">Email</label>
        <input
          autoComplete="email"
          id="operator-email"
          name="email"
          placeholder="you@company.com"
          required
          type="email"
        />

        <label htmlFor="operator-password">Password</label>
        <input
          autoComplete={flow === "signIn" ? "current-password" : "new-password"}
          id="operator-password"
          minLength={8}
          name="password"
          required
          type="password"
        />

        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}

        <button className="primary-action" disabled={isSubmitting} type="submit">
          {isSubmitting
            ? flow === "signIn"
              ? "Signing in…"
              : "Creating account…"
            : flow === "signIn"
              ? "Sign in"
              : "Create account"}
        </button>

        <button
          className="auth-flow-toggle"
          disabled={isSubmitting}
          onClick={() => {
            setError(null);
            setFlow(flow === "signIn" ? "signUp" : "signIn");
          }}
          type="button"
        >
          {flow === "signIn"
            ? "New here? Create an account"
            : "Already have an account? Sign in"}
        </button>
      </form>

      <p className="auth-boundary">
        This Build Week login has no password-reset email yet. Use a password manager
        and do not reuse an important password.
      </p>
    </section>
  );
}
