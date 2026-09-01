/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const convexMock = vi.hoisted(() => ({
  mutate: vi.fn(),
  useMutation: vi.fn(),
  useQuery: vi.fn(),
}));
const authMock = vi.hoisted(() => ({ signOut: vi.fn() }));
const routerMock = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("convex/react", () => ({
  useMutation: convexMock.useMutation,
  useQuery: convexMock.useQuery,
}));
vi.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => authMock,
}));
vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));

import { ServerOnboarding } from "@/components/server-onboarding";

function privateState(overrides: Record<string, unknown> = {}) {
  return { enrollment: null, runner: null, ...overrides };
}

describe("server onboarding", () => {
  beforeEach(() => {
    convexMock.mutate.mockReset();
    convexMock.mutate.mockResolvedValue({
      enrollmentId: "invite-1",
      expiresAt: Date.now() + 10 * 60_000,
    });
    convexMock.useMutation.mockReset();
    convexMock.useMutation.mockReturnValue(convexMock.mutate);
    convexMock.useQuery.mockReset();
    convexMock.useQuery.mockReturnValue(privateState());
    authMock.signOut.mockReset();
    routerMock.push.mockReset();
    routerMock.refresh.mockReset();
    vi.stubGlobal("crypto", {
      getRandomValues: (value: Uint8Array) => value.fill(1),
      subtle: {
        digest: async () => new Uint8Array(32).fill(2).buffer,
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("starts with one owner-bound runner and no enabled actions", () => {
    render(<ServerOnboarding />);

    expect(
      screen.getByRole("heading", { name: "Connect one Linux runner" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Private runner label")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: /I own this server or have permission/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("No recovery actions enabled")).toBeInTheDocument();
    expect(screen.getByText(/heartbeat only/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/hostname|IP address|secret/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create pairing code" })).toBeDisabled();
  });

  it("creates a 256-bit code but sends only its digest to Convex", async () => {
    render(<ServerOnboarding />);

    fireEvent.change(screen.getByLabelText("Private runner label"), {
      target: { value: "staging-web-1" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I own this server or have permission/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));

    await waitFor(() => expect(convexMock.mutate).toHaveBeenCalledOnce());
    expect(convexMock.mutate).toHaveBeenCalledWith({
      codeDigest: "02".repeat(32),
      label: "staging-web-1",
    });
    expect(await screen.findByText(/^gxpair_/)).toHaveTextContent(
      /^gxpair_[A-Za-z0-9_-]{43}$/,
    );
    expect(screen.getByText("Run this on your Linux server")).toBeInTheDocument();
    expect(screen.getByText(/expires in 10 minutes/i)).toBeInTheDocument();
  });

  it("never re-shows a code after reload and offers a fresh one", () => {
    convexMock.useQuery.mockReturnValue(
      privateState({
        enrollment: {
          enrollmentId: "invite-1",
          label: "staging-web-1",
          state: "waiting",
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      }),
    );

    render(<ServerOnboarding />);

    expect(screen.queryByText(/^gxpair_/)).not.toBeInTheDocument();
    expect(screen.getByText(/code cannot be shown again/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a new code" })).toBeInTheDocument();
  });

  it("shows online only after a fresh heartbeat and keeps actions disabled", () => {
    convexMock.useQuery.mockReturnValue(
      privateState({
        runner: {
          runnerId: "gxr_abcdefghijklmnopqrstuvwx",
          label: "staging-web-1",
          osFamily: "linux",
          architecture: "arm64",
          agentVersion: "0.1.0",
          pairedAt: Date.now() - 4_000,
          lastHeartbeatAt: Date.now(),
          revokedAt: null,
        },
      }),
    );

    render(<ServerOnboarding />);

    expect(screen.getByText("Runner connected")).toBeInTheDocument();
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText(/No logs, services, or commands are available/i)).toBeInTheDocument();
    expect(screen.getByText("No recovery actions enabled")).toBeInTheDocument();
  });
});
