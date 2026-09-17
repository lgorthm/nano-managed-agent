import { TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/** 列表/详情页统一的请求失败提示 */
export function QueryError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>请求失败</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
