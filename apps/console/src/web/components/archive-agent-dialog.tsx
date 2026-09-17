import { Archive } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** 危险操作确认:代替原生 confirm(),回车直接确认,Esc 取消 */
export function ArchiveAgentDialog({
  agentName,
  onConfirm,
  pending,
  error,
}: {
  agentName: string;
  onConfirm: () => void;
  pending: boolean;
  error: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Archive /> 归档
      </Button>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>归档 {agentName}?</DialogTitle>
          <DialogDescription>
            归档后配置只读,新会话不能再引用这个 Agent。已有会话不受影响。
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={pending} onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() => {
              onConfirm();
            }}
          >
            {pending ? '归档中…' : '确认归档'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
