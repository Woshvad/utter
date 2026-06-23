// CardPreview - the agent-card preview. Two modes:
//
//   1. JSON mode (resource detail STU-03): given a `card` object, render the A2A
//      agent-card projection read through the adapter in the single mono CodeBlock
//      surface. It does NOT author or re-derive the card (the read-through mandate).
//   2. Visual mode (create aside): given `name`/`desc`, render the comp's visual
//      agent-card (Design/Utter.dc.html 346-356) - a 96px canvas thumb with a red
//      square + ink ring, then the name + mono description.
import * as React from "react";
import { CodeBlock } from "../primitives/CodeBlock";

export interface CardPreviewProps {
  /** The agent-card JSON object (already projected by the adapter / card route). */
  card?: unknown;
  /** The absolute card URL, shown as the block caption (JSON mode). */
  cardUrl?: string;
  /** Visual-mode card name (the create aside agent-card preview). */
  name?: string;
  /** Visual-mode card description. */
  desc?: string;
}

export function CardPreview({ card, cardUrl, name, desc }: CardPreviewProps): React.ReactElement {
  // Visual mode: render the comp's agent-card when given a name (create aside).
  if (name !== undefined) {
    return (
      <div data-testid="card-preview" className="border border-hairline bg-raised">
        <div className="relative h-[96px] overflow-hidden border-b border-hairline bg-canvas">
          <span
            aria-hidden="true"
            className="absolute"
            style={{ left: 20, top: 18, width: 48, height: 48, background: "var(--red)" }}
          />
          <span
            aria-hidden="true"
            className="absolute rounded-full"
            style={{ right: 24, top: 22, width: 46, height: 46, border: "3px solid var(--ink)" }}
          />
        </div>
        <div className="p-[14px]">
          <div className="mb-[4px] text-[15px] font-semibold text-ink">{name}</div>
          <div className="font-mono text-[12px] text-ink-muted">{desc}</div>
        </div>
      </div>
    );
  }

  // JSON mode: the mono CodeBlock projection (resource detail).
  const json = JSON.stringify(card, null, 2);
  return (
    <div data-testid="card-preview" className="flex flex-col gap-2xs">
      <CodeBlock code={json} caption={cardUrl ?? "agent-card.json"} />
    </div>
  );
}
