import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  FormField,
  IconButton,
  Input,
  Menu,
  PasswordInput,
  Popover,
  Radio,
  RadioGroup,
  Select,
  Skeleton,
  SkipLink,
  Spinner,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Textarea,
  ToastProvider,
  UIProvider,
  useToast,
  HeartIcon,
  MoreIcon,
  buttonClass,
  initialsOf,
  Sheet,
} from './index';

const user = () => userEvent.setup();

async function a11y(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
}

describe('Button / IconButton', () => {
  it('is disabled and aria-busy while loading and announces the loading label', () => {
    render(
      <Button loading loadingLabel="Saving">
        Save
      </Button>,
    );
    const b = screen.getByRole('button');
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Saving')).toBeInTheDocument();
  });

  it('never submits a form by default (type=button)', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button>Plain</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('exposes class helper for link-styled buttons', () => {
    expect(buttonClass({ variant: 'secondary', size: 'lg', fullWidth: true })).toBe(
      'yl-btn yl-btn--secondary yl-btn--lg yl-btn--block',
    );
  });

  it('IconButton requires an accessible name and reflects toggle state', () => {
    render(<IconButton label="Like" icon={<HeartIcon />} pressed />);
    const b = screen.getByRole('button', { name: 'Like' });
    expect(b).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Forms', () => {
  it('FormField wires label, description and error to the control', () => {
    render(
      <FormField
        label="Email"
        description="We never share it"
        error="Invalid email"
        required
        requiredLabel="required"
      >
        <Input />
      </FormField>,
    );
    const input = screen.getByLabelText(/Email/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toBeRequired();
    const described = input
      .getAttribute('aria-describedby')!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['We never share it', 'Invalid email']);
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid email');
  });

  it('FormField keeps the alert region mounted but hidden without an error', () => {
    const { container } = render(
      <FormField label="Name">
        <Input />
      </FormField>,
    );
    expect(container.querySelector('.yl-field__error')).toHaveAttribute('hidden');
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid');
  });

  it('PasswordInput toggles visibility with an accessible toggle', async () => {
    render(
      <FormField label="Password">
        <PasswordInput showLabel="Show password" hideLabel="Hide password" />
      </FormField>,
    );
    const input = screen.getByLabelText('Password') as HTMLInputElement;
    expect(input.type).toBe('password');
    await user().click(screen.getByRole('button', { name: 'Show password' }));
    expect(input.type).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('Switch is a real checkbox with role=switch, operable by Space', async () => {
    const onChange = vi.fn();
    render(<Switch label="Focus mode" description="Fewer nudges" onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: /Focus mode/ });
    expect(sw).not.toBeChecked();
    sw.focus();
    await user().keyboard(' ');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(sw).toBeChecked();
    expect(sw).toHaveAccessibleDescription('Fewer nudges');
  });

  it('Checkbox and Select and Textarea render labelled controls', () => {
    render(
      <>
        <Checkbox label="Remember me" />
        <FormField label="Country">
          <Select>
            <option value="ng">Nigeria</option>
          </Select>
        </FormField>
        <FormField label="Bio">
          <Textarea />
        </FormField>
      </>,
    );
    expect(screen.getByRole('checkbox', { name: 'Remember me' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Country' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Bio' })).toBeInTheDocument();
  });

  it('RadioGroup is a labelled fieldset and reports selection', async () => {
    const Demo = () => {
      const [v, setV] = useState<string | undefined>('a');
      return (
        <RadioGroup legend="Audience" value={v} onValueChange={setV}>
          <Radio value="a" label="Public" />
          <Radio value="b" label="Friends" description="Only friends" />
        </RadioGroup>
      );
    };
    render(<Demo />);
    const group = screen.getByRole('group', { name: 'Audience' });
    expect(within(group).getByRole('radio', { name: 'Public' })).toBeChecked();
    await user().click(within(group).getByRole('radio', { name: /Friends/ }));
    expect(within(group).getByRole('radio', { name: /Friends/ })).toBeChecked();
    expect(within(group).getByRole('radio', { name: /Friends/ })).toHaveAccessibleDescription(
      'Only friends',
    );
  });

  it('Radio outside a RadioGroup fails loudly', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Radio value="x" label="x" />)).toThrow(/RadioGroup/);
    err.mockRestore();
  });
});

describe('Feedback and display', () => {
  it('Spinner is a status region with a label', () => {
    render(<Spinner label="Loading feed" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading feed');
  });

  it('Skeleton is hidden from assistive tech', () => {
    const { container } = render(<Skeleton width="md" />);
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('EmptyState and ErrorState expose headings; ErrorState has retry and reference', async () => {
    const retry = vi.fn();
    render(
      <>
        <EmptyState title="Nothing here" description="Follow people" />
        <ErrorState
          title="Oops"
          retryLabel="Try again"
          onRetry={retry}
          referenceLabel="Reference"
          requestId="req-1"
        />
      </>,
    );
    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Oops');
    expect(screen.getByText('req-1')).toBeInTheDocument();
    await user().click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
  });

  it('SkipLink targets the main landmark', () => {
    render(<SkipLink>Skip to content</SkipLink>);
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
  });

  it('Badge renders its content', () => {
    render(<Badge tone="success">Verified</Badge>);
    expect(screen.getByText('Verified')).toHaveClass('yl-badge--success');
  });

  it('Avatar shows initials, is labelled, and handles unicode names', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('  ')).toBe('?');
    expect(initialsOf('adé')).toBe('A');
    render(<Avatar name="Ada Lovelace" />);
    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toHaveTextContent('AL');
  });

  it('Avatar skips the photo entirely in low-bandwidth mode', () => {
    document.documentElement.setAttribute('data-bandwidth', 'low');
    const { container } = render(<Avatar name="Ada Lovelace" src="https://cdn.example/a.png" />);
    expect(container.querySelector('img')).toBeNull();
    document.documentElement.removeAttribute('data-bandwidth');
    const again = render(<Avatar name="Ada Lovelace" src="https://cdn.example/a.png" />);
    expect(again.container.querySelector('img')).not.toBeNull();
  });
});

describe('Tabs', () => {
  const Demo = () => (
    <Tabs defaultValue="a">
      <TabList label="Sections">
        <Tab value="a">One</Tab>
        <Tab value="b">Two</Tab>
        <Tab value="c">Three</Tab>
      </TabList>
      <TabPanel value="a">Panel A</TabPanel>
      <TabPanel value="b">Panel B</TabPanel>
      <TabPanel value="c">Panel C</TabPanel>
    </Tabs>
  );

  it('uses roving tabindex and links tabs to panels', () => {
    render(<Demo />);
    const [a, b] = screen.getAllByRole('tab');
    expect(a).toHaveAttribute('aria-selected', 'true');
    expect(a).toHaveAttribute('tabindex', '0');
    expect(b).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('One');
  });

  it('arrow keys, Home and End move focus and select (wrapping)', async () => {
    render(<Demo />);
    const u = user();
    screen.getAllByRole('tab')[0]!.focus();
    await u.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel B');
    await u.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Three' })).toHaveFocus();
    await u.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'One' })).toHaveFocus();
    await u.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Three' })).toHaveFocus();
    await u.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'One' })).toHaveFocus();
  });

  it('reverses arrow keys in right-to-left layouts', async () => {
    document.documentElement.setAttribute('dir', 'rtl');
    render(
      <div dir="rtl">
        <Demo />
      </div>,
    );
    screen.getAllByRole('tab')[0]!.focus();
    await user().keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveFocus();
    document.documentElement.removeAttribute('dir');
  });
});

describe('Dialog', () => {
  function Harness({ onClose = () => undefined }: { onClose?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        <div id="app-root">
          <a href="#x">Outside link</a>
        </div>
        <Dialog
          open={open}
          onClose={() => {
            setOpen(false);
            onClose();
          }}
          title="Confirm"
          description="Are you sure?"
          closeLabel="Close dialog"
          footer={<Button>OK</Button>}
        >
          <Input aria-label="Name" />
        </Dialog>
      </>
    );
  }

  it('is a labelled modal, moves focus in, traps Tab, closes on Escape and restores focus', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const u = user();
    const opener = screen.getByRole('button', { name: 'Open' });
    await u.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Confirm' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Are you sure?');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    expect(
      document.getElementById('app-root')?.parentElement?.hasAttribute('inert') ||
        document.body.children[0]!.hasAttribute('inert'),
    ).toBe(true);

    // Tab cycles within the dialog: input -> OK -> close -> input
    await u.tab();
    expect(screen.getByRole('button', { name: 'OK' })).toHaveFocus();
    await u.tab();
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    await u.tab();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    await u.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();

    await u.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    expect(document.body.children[0]!.hasAttribute('inert')).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });

  it('closes from the scrim but not when dismissible=false', async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open onClose={onClose} title="T" closeLabel="Close">
        <p>x</p>
      </Dialog>,
    );
    fireEvent.click(document.querySelector('.yl-dialog-scrim')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <Dialog open onClose={onClose} title="T" closeLabel="Close" dismissible={false}>
        <p>x</p>
      </Dialog>,
    );
    fireEvent.click(document.querySelector('.yl-dialog-scrim')!);
    await user().keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Sheet is a dialog variant', () => {
    render(
      <Sheet open onClose={() => undefined} title="Panel" closeLabel="Close">
        <p>x</p>
      </Sheet>,
    );
    expect(screen.getByRole('dialog', { name: 'Panel' })).toHaveClass('yl-dialog--sheet');
  });

  it('has no axe violations', async () => {
    render(
      <Dialog open onClose={() => undefined} title="Confirm" closeLabel="Close">
        <FormField label="Name">
          <Input />
        </FormField>
      </Dialog>,
    );
    expect(await a11y(document.body)).toEqual([]);
  });
});

describe('Menu', () => {
  const setup = (onSelect = vi.fn()) => {
    render(
      <Menu
        label="Actions"
        trigger={<IconButton label="More" icon={<MoreIcon />} />}
        items={[
          { id: 'a', label: 'Alpha', onSelect: () => onSelect('a') },
          { id: 'b', label: 'Beta', onSelect: () => onSelect('b'), disabled: true },
          { id: 'c', label: 'Gamma', onSelect: () => onSelect('c'), danger: true },
        ]}
      />,
    );
    return onSelect;
  };

  it('opens with aria-expanded, focuses the first item and skips disabled items with arrows', async () => {
    setup();
    const u = user();
    const trigger = screen.getByRole('button', { name: 'More' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await u.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu', { name: 'Actions' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
    await u.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Gamma' })).toHaveFocus();
    await u.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
    await u.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Gamma' })).toHaveFocus();
  });

  it('typeahead jumps to matching items', async () => {
    setup();
    const u = user();
    await u.click(screen.getByRole('button', { name: 'More' }));
    await u.keyboard('g');
    expect(screen.getByRole('menuitem', { name: 'Gamma' })).toHaveFocus();
  });

  it('Escape closes and returns focus to the trigger; selecting runs the action and closes', async () => {
    const onSelect = setup();
    const u = user();
    const trigger = screen.getByRole('button', { name: 'More' });
    await u.click(trigger);
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    await u.keyboard('{ArrowDown}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await u.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('a');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('does not run disabled items and closes on outside click', async () => {
    const onSelect = setup();
    const u = user();
    await u.click(screen.getByRole('button', { name: 'More' }));
    await u.click(screen.getByRole('menuitem', { name: 'Beta' }));
    expect(onSelect).not.toHaveBeenCalled();
    await u.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('supports menuitemradio with a checked state', async () => {
    render(
      <Menu
        label="Theme"
        trigger={<button>Theme</button>}
        items={[
          { id: 'l', label: 'Light', checked: true, onSelect: () => undefined },
          { id: 'd', label: 'Dark', checked: false, onSelect: () => undefined },
        ]}
      />,
    );
    await user().click(screen.getByRole('button', { name: 'Theme' }));
    expect(screen.getByRole('menuitemradio', { name: 'Light' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});

describe('Popover', () => {
  it('toggles aria-expanded, moves focus in, closes on Escape and restores focus', async () => {
    const onOpenChange = vi.fn();
    render(
      <Popover triggerContent="Why?" label="Explanation" onOpenChange={onOpenChange}>
        <button>Inside</button>
      </Popover>,
    );
    const u = user();
    const trigger = screen.getByRole('button', { name: 'Why?' });
    await u.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'Explanation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inside' })).toHaveFocus();
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});

describe('Toast', () => {
  afterEach(() => vi.useRealTimers());

  function Fire({ tone }: { tone?: 'danger' | 'success' }) {
    const t = useToast();
    return (
      <button
        onClick={() =>
          t.show({ title: 'Saved', description: 'Profile updated', ...(tone ? { tone } : {}) })
        }
      >
        fire
      </button>
    );
  }

  it('announces normal toasts politely and errors assertively, and can be dismissed', async () => {
    render(
      <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss">
        <Fire />
        <Fire tone="danger" />
      </ToastProvider>,
    );
    const u = user();
    const [normal, danger] = screen.getAllByRole('button', { name: 'fire' });
    await u.click(normal!);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Saved');
    expect(status).toHaveAttribute('aria-live', 'polite');
    await u.click(danger!);
    expect(screen.getByRole('alert')).toHaveTextContent('Saved');
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument();
    await u.click(within(status).getByRole('button', { name: 'Dismiss' }));
    expect(status).not.toHaveTextContent('Saved');
  });

  it('auto-dismisses after its duration', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <ToastProvider regionLabel="n" dismissLabel="x">
        <Fire />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'fire' }));
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    act(() => {
      vi.advanceTimersByTime(6100);
    });
    await waitFor(() => expect(screen.getByRole('status')).not.toHaveTextContent('Saved'));
  });

  it('requires a provider', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Fire />)).toThrow(/ToastProvider/);
    err.mockRestore();
  });
});

describe('UIProvider', () => {
  it('lets apps inject a router-aware Link', async () => {
    const { PostCard } = await import('./domain/post-card');
    const { postLabels, makePost } = await import('./test-utils');
    const Link = ({
      href,
      children,
      ...rest
    }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
      <a data-router="yes" href={href} {...rest}>
        {children}
      </a>
    );
    const { container } = render(
      <UIProvider Link={Link} locale="en">
        <PostCard post={makePost()} labels={postLabels} href="/post/p1" />
      </UIProvider>,
    );
    expect(container.querySelectorAll('[data-router="yes"]').length).toBeGreaterThan(0);
  });
});
