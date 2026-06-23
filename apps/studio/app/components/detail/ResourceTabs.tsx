// ResourceTabs - the resource-detail tab strip (Overview / API / Agent card /
// Reputation / Pricing), underline-rule tabs via the Plan-02 Tabs primitive (which
// wraps Radix for keyboard roving-focus + ARIA). Each tab's content is passed in by
// the screen; ResourceTabs only arranges them. The playground is NOT a tab - the
// player is the always-visible hero above this strip (260623-726 comp).
import * as React from "react";
import { Tabs, type TabItem } from "../primitives/Tabs";

export interface ResourceTabsContent {
  overview: React.ReactNode;
  api: React.ReactNode;
  card: React.ReactNode;
  reputation: React.ReactNode;
  pricing: React.ReactNode;
}

export interface ResourceTabsProps {
  content: ResourceTabsContent;
  defaultValue?: string;
}

export function ResourceTabs({ content, defaultValue }: ResourceTabsProps): React.ReactElement {
  const items: TabItem[] = [
    { value: "overview", label: "overview", content: content.overview },
    { value: "api", label: "api", content: content.api },
    { value: "card", label: "agent card", content: content.card },
    { value: "reputation", label: "reputation", content: content.reputation },
    { value: "pricing", label: "pricing", content: content.pricing },
  ];
  return (
    <div data-testid="resource-tabs">
      <Tabs items={items} defaultValue={defaultValue ?? "overview"} />
    </div>
  );
}
