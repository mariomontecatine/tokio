import { useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Expand } from './Expand';
import type { Translate } from './i18n';
import { asPasted, looksPasted, type Draft } from './pasted';

interface Props {
  draft: Draft;
  onChange: (draft: Draft) => void;
  placeholder: string;
  t: Translate;
  /** Cmd/Ctrl-Enter, so the field can be submitted without reaching for a button. */
  onSubmit?: () => void;
  rows?: number;
  autoFocus?: boolean;
}

/** The box grows with what you type, and stops before it eats the page. */
const MAX_TEXTAREA_PX = 240;

/**
 * One prompt field: the folded pastes, then the part you type.
 *
 * Shared between writing a prompt and editing one that is already queued,
 * because they are the same act — and because a paste that folded on the way in
 * and unfolded on the way back out would be worse than one that never folded.
 */
export function PromptField({ draft, onChange, placeholder, t, onSubmit, rows = 2, autoFocus }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  // No drag handle: the box sizes itself to its content, the way a chat input
  // does. A resize grip on a two-line field is a control nobody wants to use.
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [draft.typed]);

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const text = event.clipboardData.getData('text');
    if (!text || !looksPasted(text)) return;
    event.preventDefault();
    // A paste into an empty box leads; into text you have already written, it
    // follows. Either way the order on screen is the order that gets queued.
    const typedLeads = draft.pasted.length ? draft.typedLeads : draft.typed.trim().length > 0;
    onChange({ ...draft, pasted: [...draft.pasted, asPasted(text)], typedLeads });
  }

  function remove(id: string) {
    onChange({ ...draft, pasted: draft.pasted.filter((p) => p.id !== id) });
    setOpen((current) => (current === id ? null : current));
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (onSubmit && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSubmit();
  }

  return (
    <div className="compose-field">
      {draft.pasted.length > 0 && (
        <ul className="pastes">
          {draft.pasted.map((item) => (
            <li key={item.id} className="paste">
              <div className="paste-row">
                <button
                  type="button"
                  className="paste-open"
                  onClick={() => setOpen(open === item.id ? null : item.id)}
                  aria-expanded={open === item.id}
                  title={open === item.id ? t('compose.pasted.collapse') : t('compose.pasted.expand')}
                >
                  <span className="paste-glyph" aria-hidden="true" />
                  <span className="paste-name">{t('compose.pasted')}</span>
                  <span className="paste-meta">{t('compose.pasted.lines', { n: item.lines })}</span>
                </button>
                <button
                  type="button"
                  className="paste-remove"
                  onClick={() => remove(item.id)}
                  aria-label={t('compose.pasted.remove')}
                >
                  ×
                </button>
              </div>
              <Expand open={open === item.id}>
                <pre className="paste-preview">{item.text}</pre>
              </Expand>
            </li>
          ))}
        </ul>
      )}

      <textarea
        ref={textarea}
        value={draft.typed}
        onChange={(e) => onChange({ ...draft, typed: e.target.value })}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={rows}
        autoFocus={autoFocus}
        aria-label={placeholder}
      />
    </div>
  );
}
