import { Check, Copy } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';

/** Copies `text`, then shows a check and announces "Copied" for a moment. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <>
      <button
        type="button"
        aria-label={label}
        onClick={async () => {
          try {
            await navigator.clipboard?.writeText(text);
          } catch {
            return; // no clipboard permission: the text is still there to select
          }
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1600);
        }}
        className="press inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {copied ? (
          <Check aria-hidden className="size-4 text-photon-glow" />
        ) : (
          <Copy aria-hidden className="size-4" />
        )}
      </button>
      <span role="status" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
    </>
  );
}

function Frame({
  caption,
  copy,
  copyLabel,
  children,
}: {
  caption: string;
  copy: string;
  copyLabel: string;
  children: React.ReactNode;
}) {
  return (
    <figure className="not-prose my-4 overflow-hidden rounded-xl border border-border bg-void">
      <div className="flex items-center justify-between gap-3 border-b border-border py-1 pl-4 pr-1">
        <figcaption className="truncate font-mono text-[11px] text-muted-foreground">
          {caption}
        </figcaption>
        <CopyButton text={copy} label={copyLabel} />
      </div>
      {children}
    </figure>
  );
}

const preClass =
  'overflow-x-auto px-4 py-3 font-mono text-[13px] leading-relaxed text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

/**
 * Shell commands, one per line, each shown after a `$` prompt. Lines starting with `#` are
 * comments. The copy button copies the commands only, never the prompt or the comments.
 */
export function Cmd({
  children,
  caption = 'Terminal',
  prompt = '$',
}: {
  children: string;
  caption?: string;
  /** `>` for a command typed into an agent, such as `/mcp`. */
  prompt?: string;
}) {
  const lines = children.trim().split('\n');
  const commands = lines.filter((l) => !l.startsWith('#')).join('\n');
  const many = lines.filter((l) => !l.startsWith('#')).length > 1;
  return (
    <Frame caption={caption} copy={commands} copyLabel={many ? 'Copy commands' : 'Copy command'}>
      <pre tabIndex={0} className={preClass}>
        <code>
          {lines.map((l, i) => (
            <Fragment key={i}>
              {l.startsWith('#') ? (
                <span className="text-muted-foreground">{l}</span>
              ) : (
                <>
                  <span aria-hidden className="select-none text-photon-glow">
                    {prompt}{' '}
                  </span>
                  {l}
                </>
              )}
              {i < lines.length - 1 ? '\n' : ''}
            </Fragment>
          ))}
        </code>
      </pre>
    </Frame>
  );
}

/** A file or a code sample, copied as is. `caption` is the file path or the language. */
export function Code({ children, caption }: { children: string; caption: string }) {
  const code = children.replace(/^\n/, '').trimEnd();
  return (
    <Frame caption={caption} copy={code} copyLabel={`Copy ${caption}`}>
      <pre tabIndex={0} className={preClass}>
        <code>{code}</code>
      </pre>
    </Frame>
  );
}
