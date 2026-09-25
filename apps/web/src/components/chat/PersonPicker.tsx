'use client';

import { useState, type KeyboardEvent } from 'react';
import { ApiError } from '@yapilapi/api-client';
import { Button, Checkbox, CloseIcon, FormField, IconButton, Input, Avatar } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { describeError } from '@/lib/errors';

export interface PickedPerson {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Choose people from your friends, or look someone up by username. Controlled: the parent owns the selection. */
export function PersonPicker({
  selected,
  onChange,
  excludeIds = [],
}: {
  selected: PickedPerson[];
  onChange: (next: PickedPerson[]) => void;
  excludeIds?: string[];
}) {
  const { t } = useI18n();
  const api = useApi();
  const { user } = useSession();
  const friends = useAsync((signal) => api.graph.friends({ limit: 50, signal }), [api]);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const has = (id: string) => selected.some((p) => p.id === id);
  const hidden = new Set([user.id, ...excludeIds]);
  const friendList = (friends.data?.items ?? []).filter((f) => !hidden.has(f.id));

  const toggle = (p: PickedPerson, on: boolean) =>
    onChange(
      on ? (has(p.id) ? selected : [...selected, p]) : selected.filter((s) => s.id !== p.id),
    );

  const lookup = async () => {
    const u = name.trim().replace(/^@/, '');
    if (!u || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const p = await api.profile.get(u);
      if (hidden.has(p.id))
        setProblem(
          p.id === user.id ? t('dm.self') : t('group.alreadyAdded', { name: p.displayName }),
        );
      else if (has(p.id)) setProblem(t('group.alreadyAdded', { name: p.displayName }));
      else {
        onChange([
          ...selected,
          { id: p.id, username: p.username, displayName: p.displayName, avatarUrl: p.avatarUrl },
        ]);
        setName('');
      }
    } catch (e) {
      setProblem(
        e instanceof ApiError && e.status === 404
          ? t('group.notFound')
          : describeError(e, t).message,
      );
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void lookup();
    }
  };

  return (
    <div className="picker">
      {friendList.length > 0 ? (
        <fieldset className="picker__friends">
          <legend className="picker__legend">{t('group.friends')}</legend>
          <ul className="picker__list">
            {friendList.map((f) => (
              <li key={f.id}>
                <Checkbox
                  label={
                    <span>
                      {f.displayName}{' '}
                      <span className="muted" dir="ltr">
                        @{f.username}
                      </span>
                    </span>
                  }
                  checked={has(f.id)}
                  onChange={(e) =>
                    toggle(
                      {
                        id: f.id,
                        username: f.username,
                        displayName: f.displayName,
                        avatarUrl: f.avatarUrl,
                      },
                      e.target.checked,
                    )
                  }
                />
              </li>
            ))}
          </ul>
        </fieldset>
      ) : friends.loading ? null : (
        <p className="muted">{t('group.noFriends')}</p>
      )}

      <div className="picker__lookup">
        <FormField label={t('group.addByUsername')} {...(problem ? { error: problem } : {})}>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setProblem(null);
            }}
            onKeyDown={onKey}
            dir="ltr"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={40}
            data-testid="picker-username"
          />
        </FormField>
        <Button
          type="button"
          variant="secondary"
          onClick={() => void lookup()}
          loading={busy}
          loadingLabel={t('common.working')}
          disabled={!name.trim()}
          data-testid="picker-add"
        >
          {t('group.add')}
        </Button>
      </div>

      <div className="picker__selected" aria-live="polite">
        <p className="picker__legend" id="picker-selected-h">
          {t('group.selected')}
        </p>
        {selected.length === 0 ? (
          <p className="muted">{t('group.none')}</p>
        ) : (
          <ul className="yl-chips" aria-labelledby="picker-selected-h">
            {selected.map((p) => (
              <li key={p.id} className="yl-chip">
                <Avatar name={p.displayName} src={p.avatarUrl} size="xs" decorative />
                <span>{p.displayName}</span>
                <IconButton
                  label={t('group.remove', { name: p.displayName })}
                  icon={<CloseIcon size={14} />}
                  size="sm"
                  onClick={() => toggle(p, false)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
