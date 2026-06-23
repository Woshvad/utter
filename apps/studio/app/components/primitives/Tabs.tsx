// Tabs - underline-rule tabs (no pills, no rounded). Wraps @radix-ui/react-tabs for
// the keyboard roving-focus + ARIA correctness, restyled to the token layer: the
// active tab is a 2px RED rule under the trigger (the action/selected triad role);
// everything else is ink-faint mono.
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
      <RadixTabs.List className="flex gap-[2px] border-b border-hairline">
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.value}
            value={item.value}
            className={[
              "relative -mb-px px-[16px] py-[13px] font-mono text-[13px] lowercase",
              "border-b-2 border-transparent text-ink-faint",
              // active = 2px RED underline rule (the selected/action triad role)
              "data-[state=active]:border-red data-[state=active]:text-ink",
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
