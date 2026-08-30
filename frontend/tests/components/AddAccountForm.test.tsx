import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import AddAccountForm from "../../src/components/Account/AddAccountForm";

const mocks = vi.hoisted(() => ({
  addAccount: vi.fn(),
  addToast: vi.fn(),
  authenticate: vi.fn(),
  clearSearch: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../src/hooks/useAccounts", () => ({
  useAccounts: () => ({
    addAccount: mocks.addAccount,
  }),
}));

vi.mock("../../src/store/toast", () => ({
  useToastStore: (
    selector: (state: { addToast: typeof mocks.addToast }) => unknown,
  ) => selector({ addToast: mocks.addToast }),
}));

vi.mock("../../src/hooks/useSearch", () => ({
  useSearch: (
    selector: (state: { clear: typeof mocks.clearSearch }) => unknown,
  ) => selector({ clear: mocks.clearSearch }),
}));

vi.mock("../../src/apple/authenticate", () => ({
  authenticate: mocks.authenticate,
  AuthenticationError: class AuthenticationError extends Error {
    codeRequired = false;
  },
}));

vi.mock("../../src/apple/config", () => ({
  generateDeviceId: () => "001122aabbcc",
}));

describe("AddAccountForm", () => {
  it("accepts phone-number Apple IDs without email validation", () => {
    render(
      <MemoryRouter initialEntries={["/accounts/add"]}>
        <AddAccountForm />
      </MemoryRouter>,
    );

    const appleId = screen.getByLabelText(
      "accounts.addForm.email",
    ) as HTMLInputElement;
    expect(appleId).toHaveAttribute("type", "text");
    expect(appleId).toHaveAttribute("autocomplete", "username");

    fireEvent.change(appleId, { target: { value: "13800138000" } });
    expect(appleId.checkValidity()).toBe(true);
  });
});
