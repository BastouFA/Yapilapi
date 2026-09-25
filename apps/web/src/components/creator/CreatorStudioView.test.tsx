import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  CreatorMe,
  CreatorPayoutBalance,
  CreatorPlan,
  CreatorSubscriber,
  Partnership,
} from '@yapilapi/api-client';
import { fakeClient, fakeMe, renderWithProviders } from './test-utils';
import { CreatorStudioView } from './CreatorStudioView';

function notCreatorMe(): CreatorMe {
  return { creator: null, currentTermsVersion: '2027-01', verification: [], payoutAccount: null };
}

function creatorMe(overrides: Partial<NonNullable<CreatorMe['creator']>> = {}): CreatorMe {
  return {
    creator: {
      userId: 'u1',
      status: 'active',
      kycStatus: 'unverified',
      category: null,
      termsVersion: '2027-01',
      currentTermsVersion: '2027-01',
      termsAccepted: true,
      kycSubmittedAt: null,
      kycDecidedAt: null,
      kycNote: null,
      mode: 'creator',
      createdAt: new Date().toISOString(),
      ...overrides,
    },
    currentTermsVersion: '2027-01',
    verification: [],
    payoutAccount: null,
  };
}

function plan(overrides: Partial<CreatorPlan> = {}): CreatorPlan {
  return {
    id: 'p1',
    creatorId: 'u1',
    name: 'Supporter',
    description: '',
    priceCents: 500,
    currency: 'USD',
    interval: 'month',
    tier: 1,
    benefits: [],
    active: true,
    ...overrides,
  };
}

function subscriber(overrides: Partial<CreatorSubscriber> = {}): CreatorSubscriber {
  return {
    id: 's1',
    subscriberId: 'sub1',
    username: 'fan1',
    tier: 1,
    plan: 'Supporter',
    status: 'active',
    currentPeriodEnd: new Date().toISOString(),
    cancelAtPeriodEnd: false,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function partnership(overrides: Partial<Partnership> = {}): Partnership {
  return {
    id: 'pt1',
    creatorId: 'u1',
    businessId: 'biz1',
    yourSide: 'creator',
    status: 'proposed',
    title: 'Launch campaign',
    brief: 'Promote the new product',
    amountCents: 10000,
    currency: 'USD',
    termsVersion: 1,
    termsBy: 'creator',
    acceptedBy: { creator: false, business: false },
    disclosureRequired: true,
    disclosureLabel: 'Paid partnership',
    paymentStatus: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deliverables: [],
    events: [],
    ...overrides,
  };
}

describe('CreatorStudioView', () => {
  it('offers to join when not yet a creator', async () => {
    const join = vi.fn().mockResolvedValue(creatorMe().creator);
    const client = fakeClient({
      creator: { me: vi.fn().mockResolvedValue(notCreatorMe()), join },
    });
    renderWithProviders(<CreatorStudioView />, { client });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Become a creator' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Become a creator' }));
    await waitFor(() => expect(join).toHaveBeenCalled());
  });

  it('blocks teen accounts from joining', async () => {
    const client = fakeClient({
      creator: { me: vi.fn().mockResolvedValue(notCreatorMe()) },
    });
    renderWithProviders(<CreatorStudioView />, { client, me: fakeMe({ ageBand: 'teen' }) });

    await waitFor(() =>
      expect(
        screen.getByText('Creator accounts are only available to adults.'),
      ).toBeInTheDocument(),
    );
  });

  it('lists and creates plans', async () => {
    const createPlan = vi.fn().mockResolvedValue(plan({ id: 'p2', name: 'New tier' }));
    const client = fakeClient({
      creator: {
        me: vi.fn().mockResolvedValue(creatorMe()),
        plans: vi.fn().mockResolvedValue({ items: [plan()] }),
        createPlan,
      },
    });
    renderWithProviders(<CreatorStudioView />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'Plans' }));
    await waitFor(() => expect(screen.getByText('Supporter')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New tier' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create plan' }));
    await waitFor(() => expect(createPlan).toHaveBeenCalled());
  });

  it('removes a subscriber only after the confirmation dialog', async () => {
    const removeSubscriber = vi.fn().mockResolvedValue({});
    const client = fakeClient({
      creator: {
        me: vi.fn().mockResolvedValue(creatorMe()),
        subscribers: vi.fn().mockResolvedValue({ items: [subscriber()] }),
        removeSubscriber,
      },
    });
    renderWithProviders(<CreatorStudioView />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'Subscribers' }));
    await waitFor(() => expect(screen.getByText('fan1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Remove subscriber' }));
    expect(removeSubscriber).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove subscriber' })[1]!);
    await waitFor(() => expect(removeSubscriber).toHaveBeenCalledWith('s1'));
  });

  it('requests a payout once payouts are enabled', async () => {
    const requestPayout = vi.fn().mockResolvedValue({});
    const balance: CreatorPayoutBalance = {
      holdDays: 3,
      balances: [{ currency: 'USD', totalCents: 5000, availableCents: 4000, pendingCents: 1000 }],
      payoutAccount: { id: 'acct1', kycStatus: 'verified', payoutsEnabled: true },
    };
    const client = fakeClient({
      creator: {
        me: vi.fn().mockResolvedValue(creatorMe()),
        payoutBalance: vi.fn().mockResolvedValue(balance),
        payouts: vi.fn().mockResolvedValue({ items: [] }),
        requestPayout,
      },
    });
    renderWithProviders(<CreatorStudioView />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'Payouts' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Request payout' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Request payout' }));
    await waitFor(() => expect(requestPayout).toHaveBeenCalled());
  });

  it('accepts a proposed partnership only through the accept action', async () => {
    const acceptPartnership = vi.fn().mockResolvedValue(partnership({ status: 'accepted' }));
    const client = fakeClient({
      creator: {
        me: vi.fn().mockResolvedValue(creatorMe()),
        partnerships: vi.fn().mockResolvedValue({ items: [partnership()] }),
        partnership: vi.fn().mockResolvedValue(partnership()),
        acceptPartnership,
      },
    });
    renderWithProviders(<CreatorStudioView />, { client });

    fireEvent.click(await screen.findByRole('tab', { name: 'Partnerships' }));
    await waitFor(() => expect(screen.getByText('Launch campaign')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Launch campaign'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Accept current terms' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Accept current terms' }));
    await waitFor(() => expect(acceptPartnership).toHaveBeenCalledWith('pt1', 1));
  });
});
