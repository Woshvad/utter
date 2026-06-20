// Tabs - underline-rule tabs (no pills, no rounded). Wraps @radix-ui/react-tabs for
// the keyboard roving-focus + ARIA correctness, restyled to the token layer: the
// active tab is a 2px blue rule under the trigger; everything else is ink-muted.
import * as React from "react";
import * as RadixTabs from "@radix-ui/react-tabs";

export interface TabItem {
  value: string;
  label: string;
  content: React.ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
}

export function Tabs({
  items,
  defaultValue,
  value,
  onValueChange,
  className,
}: TabsProps): React.ReactElement {
  return (
    <RadixTabs.Root
      defaultValue={defaultValue ?? items[0]?.value}
      value={value}
      onValueChange={onValueChange}
      className={className}
    >
      <RadixTabs.List className="flex gap-lg border-b border-hairline">
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.value}
            value={item.value}
            className={[
              "relative -mb-px py-sm text-label font-display lowercase",
              "text-ink-muted data-[state=active]:text-ink",
              // active = 2px blue underline rule
              "data-[state=active]:border-b-2 data-[state=active]:border-blue",
              "outline-none focus-visible:ring-2 focus-visible:ring-blue",
            ].join(" ")}
          >
            {item.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((item) => (
        <RadixTabs.Content
          key={item.value}
          value={item.value}
          className="pt-md outline-none"
        >
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
