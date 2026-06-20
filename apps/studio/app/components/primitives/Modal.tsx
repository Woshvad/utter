// Modal - the bordered + scrim dialog (NO blur, no soft shadow; elevation is a 1px
// hard border + the --scrim overlay). Wraps @radix-ui/react-dialog ONLY for the
// hard parts: focus-trap, ESC-to-close, and scroll lock. Every destructive action
// (takedown / delist / withdraw-bond / wallet outflow) opens this. Fully restyled
// to the token layer - Radix ships unstyled.
import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** The modal title (rendered as the Radix Dialog.Title for SR). */
  title: string;
  /** Optional supporting description line under the title. */
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Footer slot for the confirm/cancel actions. */
  footer?: React.ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: ModalProps): React.ReactElement {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        {/* scrim: flat --scrim, explicitly NO backdrop blur */}
        <Dialog.Overlay
          data-testid="modal-scrim"
          className="fixed inset-0 z-40"
          style={{ background: "var(--scrim)" }}
        />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 border border-hairline bg-raised p-lg outline-none"
          // hard border elevation, no soft shadow
        >
          <Dialog.Title className="text-heading font-display font-semibold tracking-tight text-ink lowercase">
            {title}
          </Dialog.Title>
          {description ? (
            <Dialog.Description className="mt-2xs text-body text-ink-muted">
              {description}
            </Dialog.Description>
          ) : (
            // Radix warns without a description; provide an SR-only fallback
            <Dialog.Description className="sr-only">{title}</Dialog.Description>
          )}
          <div className="mt-md text-body text-ink">{children}</div>
          {footer ? <div className="mt-lg flex justify-end gap-xs">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
