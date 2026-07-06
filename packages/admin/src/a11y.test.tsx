/**
 * Accessibility smoke tests — runs axe-core (via vitest-axe) against
 * representative UI primitives and composites rendered in isolation.
 *
 * Deliberately scoped to components that render without the router/query
 * stack (Login only needs a QueryClientProvider) and skips the heavy
 * virtualized grid — jsdom + axe is slow, and the grid's a11y-relevant
 * pieces (buttons, checkboxes, dialogs) are all covered here as primitives.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { Database } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { configureAxe } from 'vitest-axe';
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Input,
  Label,
  Select,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from './components/ui';
import { Login } from './pages/Login';

// jsdom does not apply the app's CSS, so computed colors are meaningless —
// contrast is validated separately by the design-token palette checks.
// `region` expects full pages with landmarks; these are isolated components.
const axe = configureAxe({
  rules: {
    'color-contrast': { enabled: false },
    region: { enabled: false },
  },
});

describe('accessibility (axe)', () => {
  it('Button variants have no violations', async () => {
    const { container } = render(
      <div>
        <Button>Save</Button>
        <Button variant="destructive">Delete</Button>
        <Button variant="outline" disabled>
          Disabled
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close">
          <Database aria-hidden />
        </Button>
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('labeled form fields (Input, Textarea, Select) have no violations', async () => {
    const { container } = render(
      <form>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" placeholder="you@example.com" />
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" />
        <Label htmlFor="type">Type</Label>
        <Select id="type" defaultValue="text">
          <option value="text">text</option>
          <option value="number">number</option>
        </Select>
      </form>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Checkbox and Switch with accessible names have no violations', async () => {
    const { container } = render(
      <div>
        <Checkbox aria-label="Select row" />
        <Switch aria-label="Enabled" defaultChecked />
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('EmptyState has no violations', async () => {
    const { container } = render(
      <EmptyState
        icon={<Database aria-hidden />}
        title="No data objects yet"
        hint="Create your first object to get going."
        action={<Button>New Object</Button>}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Tabs composite has no violations', async () => {
    const { container } = render(
      <Tabs defaultValue="data">
        <TabsList>
          <TabsTrigger value="data">Data</TabsTrigger>
          <TabsTrigger value="schema">Schema</TabsTrigger>
        </TabsList>
        <TabsContent value="data">Data panel</TabsContent>
        <TabsContent value="schema">Schema panel</TabsContent>
      </Tabs>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('open Dialog has no violations', async () => {
    // Radix portals the dialog to document.body, so axe runs on body,
    // not the render container.
    render(
      <Dialog open onClose={() => {}} title="Edit Contact" description="Update the record.">
        <p>Body content</p>
      </Dialog>,
    );
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('Login page has no violations', async () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <Login />
      </QueryClientProvider>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
