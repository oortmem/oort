import { useState } from 'react';
import type { SpiralApi } from '@/components/oort/OortSpiral';

const SUGGESTIONS = ['Prefers window seats', 'Allergic to wool', 'Birthday is in May'];

/** Hero input dock: type a memory, it lands in the hot core of the spiral. */
export function HeroWish({ api }: { api: React.MutableRefObject<SpiralApi | null> }) {
  const [text, setText] = useState('');
  const send = (t: string, _source: 'typed' | 'suggestion') => {
    const v = t.trim();
    if (!v) return;
    api.current?.add(v.slice(0, 40));
    setText('');
    navigator.vibrate?.(8);
  };
  return (
    <div className="max-w-lg space-y-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(text, 'typed');
        }}
        className="flex gap-2 rounded-full border border-border bg-card/70 p-1.5 backdrop-blur focus-within:border-photon-glow/60"
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={40}
          placeholder="Give it something to remember…"
          aria-label="A memory to store"
          className="min-w-0 flex-1 bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
        />
        <button className="press shrink-0 rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background">
          Remember
        </button>
      </form>
      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => send(s, 'suggestion')}
            className="press rounded-full border border-border px-3 py-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            + {s}
          </button>
        ))}
      </div>
    </div>
  );
}
