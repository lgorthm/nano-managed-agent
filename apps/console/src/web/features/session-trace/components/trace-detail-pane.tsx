import { type ComponentProps, useSyncExternalStore } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { TraceInspector } from '../inspector/trace-inspector';

const DESKTOP_QUERY = '(min-width: 64rem)';

function subscribeDesktop(onChange: () => void) {
  const media = window.matchMedia(DESKTOP_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function isDesktop() {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

/** A modal on small screens keeps keyboard focus inside the selected record's details. */
export function TraceDetailPane(props: ComponentProps<typeof TraceInspector>) {
  const desktop = useSyncExternalStore(subscribeDesktop, isDesktop);
  if (desktop) {
    return (
      <div className="trace-detail-pane">
        <TraceInspector {...props} />
      </div>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="session-detail-shell trace-mobile-inspector"
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.querySelector<HTMLElement>('.trace-list')?.focus();
        }}
      >
        <DialogTitle className="sr-only">轨迹详情</DialogTitle>
        <DialogDescription className="sr-only">
          查看选中记录的内容、来源和计时信息。
        </DialogDescription>
        <TraceInspector {...props} />
      </DialogContent>
    </Dialog>
  );
}
