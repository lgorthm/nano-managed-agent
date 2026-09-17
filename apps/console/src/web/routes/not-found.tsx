import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="font-mono text-6xl font-semibold tracking-tighter text-foreground/85">404</p>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">页面不存在</h1>
        <p className="text-muted-foreground max-w-72 text-pretty text-sm">
          这个地址在 nano console 里没有对应的资源,可能已被删除或从未存在。
        </p>
      </div>
      <Button asChild size="sm" variant="outline" className="mt-2">
        <Link to="/agents">
          <ArrowLeft /> 回到 Agents
        </Link>
      </Button>
    </div>
  );
}
