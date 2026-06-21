// CardPreview - the agent-card preview (mono JSON). Renders the A2A agent-card
// projection read through the adapter; it does NOT author or re-derive the card (the
// read-through mandate). The JSON is shown in the single mono CodeBlock surface.
import * as React from "react";
import { CodeBlock } from "../primitives/CodeBlock";

export interface CardPreviewProps {
  /** The agent-card JSON object (already projected by the adapter / card route). */
  card: unknown;
  /** The absolute card URL, shown as the block caption. */
  cardUrl?: string;
}

export function CardPreview({ card, cardUrl }: CardPreviewProps): React.ReactElement {
  const json = JSON.stringify(card, null, 2);
  return (
    <div data-testid="card-preview" className="flex flex-col gap-2xs">
      <CodeBlock code={json} caption={cardUrl ?? "agent-card.json"} />
    </div>
  );
}
