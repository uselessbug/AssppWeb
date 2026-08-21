import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import VersionHistory from '../../src/components/Search/VersionHistory';
import type { Account, Software } from '../../src/types';

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  listVersions: vi.fn(),
  startDownload: vi.fn(),
  toastDownloadError: vi.fn(),
  updateAccount: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const account: Account = {
  email: 'developer@example.test',
  password: 'test-password',
  appleId: 'developer@example.test',
  store: '143441',
  firstName: 'Example',
  lastName: 'Developer',
  passwordToken: 'test-token',
  directoryServicesIdentifier: '123456789',
  cookies: [],
  deviceIdentifier: '001122aabbcc',
};

const app: Software = {
  id: 123456,
  bundleID: 'com.example.utility',
  name: 'Example Utility',
  version: '3.4.5',
  price: 0,
  artistName: 'Example Developer',
  sellerName: 'Example Developer LLC',
  description: 'A test application.',
  averageUserRating: 4.8,
  userRatingCount: 42,
  artworkUrl: '',
  screenshotUrls: [],
  minimumOsVersion: '16.0',
  fileSizeBytes: '5242880',
  releaseDate: '2026-08-01T00:00:00Z',
  formattedPrice: 'Free',
  primaryGenreName: 'Utilities',
};

vi.mock('../../src/hooks/useAccounts', () => ({
  useAccounts: () => ({ accounts: [account], updateAccount: mocks.updateAccount }),
}));

vi.mock('../../src/hooks/useDownloadAction', () => ({
  useDownloadAction: () => ({
    startDownload: mocks.startDownload,
    toastDownloadError: mocks.toastDownloadError,
  }),
}));

vi.mock('../../src/apple/versionFinder', () => ({ listVersions: mocks.listVersions }));
vi.mock('../../src/apple/versionLookup', () => ({ getVersionMetadata: vi.fn() }));
vi.mock('../../src/store/toast', () => ({
  useToastStore: (selector: (state: { addToast: typeof mocks.addToast }) => unknown) =>
    selector({ addToast: mocks.addToast }),
}));

function renderVersionHistory() {
  return render(
    <MemoryRouter
      initialEntries={[{
        pathname: `/search/${app.id}/versions`,
        state: { app, country: 'US' },
      }]}
    >
      <Routes>
        <Route path="/search/:appId/versions" element={<VersionHistory />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('VersionHistory loading feedback', () => {
  beforeEach(() => {
    mocks.addToast.mockReset();
    mocks.listVersions.mockReset();
    mocks.startDownload.mockReset();
    mocks.toastDownloadError.mockReset();
    mocks.updateAccount.mockReset();
  });

  it('shows a centered spinner while version loading is pending', async () => {
    mocks.listVersions.mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    renderVersionHistory();

    const button = await screen.findByRole('button', {
      name: 'search.versions.load',
    });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() => expect(mocks.listVersions).toHaveBeenCalledOnce());
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveClass(
      'inline-flex',
      'items-center',
      'justify-center',
      'gap-2',
    );
    const spinner = button.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
    expect(spinner).toHaveClass('shrink-0', 'motion-reduce:animate-none');
  });
});
