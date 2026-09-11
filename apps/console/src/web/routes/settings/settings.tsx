import { useQuery } from "@tanstack/react-query";
import { GLM_API_BASE } from "@nano/shared/glm";
import { listAgents } from "@/api/agents";
import { getIdentity } from "@/auth/identity";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export function SettingsPage() {
  const identityQuery = useQuery({ queryKey: ["identity"], queryFn: getIdentity, staleTime: Infinity });
  // 代理链路健康检查:经 worker 代理调 GLM 列表接口,能过说明 代理 + Key + Access 全通
  const healthQuery = useQuery({
    queryKey: ["health", "glm"],
    queryFn: () => listAgents({ limit: 1 }),
    retry: false,
  });

  const identity = identityQuery.data;

  return (
    <div className="space-y-4">
      <PageHeader title="Settings" description="登录身份与代理链路状态。" />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Cloudflare Access 身份</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {identity ? (
              <>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">名称</span>
                  <span>{identity.name ?? "—"}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">邮箱</span>
                  <span>{identity.email ?? "—"}</span>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">
                未获取到 Access 身份:本地开发没有 Access 登录页,属正常现象;线上出现请联系管理员检查 Access 配置。
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">GLM 代理链路</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">状态</span>
              {healthQuery.isPending ? (
                <Badge variant="secondary" className="font-normal">
                  检测中…
                </Badge>
              ) : healthQuery.isError ? (
                <Badge variant="destructive" className="font-normal">
                  异常
                </Badge>
              ) : (
                <Badge variant="secondary" className="bg-emerald-100 font-normal text-emerald-700">
                  正常
                </Badge>
              )}
            </div>
            {healthQuery.isError ? (
              <p className="text-destructive text-xs">{(healthQuery.error as Error).message}</p>
            ) : null}
            <Separator />
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground shrink-0">浏览器 → worker</span>
              <span className="font-mono text-xs">/glm/*</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground shrink-0">worker → GLM</span>
              <span className="min-w-0 break-all font-mono text-xs">{GLM_API_BASE}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
