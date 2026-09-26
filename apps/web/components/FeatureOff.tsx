import { EmptyState } from '@yapilapi/design-system';

/** Full-page state for a feature that isn't switched on yet, with the page's own heading. */
export function FeatureOff({ name }: { name: string }) {
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{name}</h1>
      </div>
      <EmptyState title={`${name} isn't available yet`} body="It's being rolled out gradually." />
    </div>
  );
}
