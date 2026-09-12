import { useQuery } from "@tanstack/react-query";
import { GLM_API_BASE } from "@nano/shared/glm";
import { listAgents } from "@/api/agents";
import { getIdentity } from "@/auth/identity";
import { PageHeader } from "@/components/page-header";
import { KeyValueRow, SectionCard } from "@/components/section-card";
import { StatusBadge } from "@/components/status-badges";
import { Separator } from "@/components/ui/separator";
import { useProvider } from "@/lib/provider";

export function SettingsPage() {
  const provider = useProvider();
  const identityQuery = useQuery({ queryKey: ["identity"], queryFn: getIdentity, staleTime: Infinity });
  // 代理链路健康检查:经 worker 代理调列表接口,能过说明 代理 + Key + Access 全通
  const healthQuery = useQuery({
    queryKey: ["health", provider],
    queryFn: () => listAgents({ limit: 1 }),
    retry: false,
  });

  const identity = identityQuery.data;

  return (
    <div className="space-y-4">
      <title>nano console — Settings</title>
      <PageHeader title="Settings" description="登录身份与代理链路状态。" />

      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="Cloudflare Access 身份">
          {identity ? (
            <div className="space-y-2.5">
              <KeyValueRow label="名称">{identity.name ?? "—"}</KeyValueRow>
              <KeyValueRow label="邮箱">
                <span className="text-xs">{identity.email ?? "—"}</span>
              </KeyValueRow>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm leading-relaxed">
              未获取到 Access 身份:本地开发没有 Access 登录页,属正常现象;线上出现请联系管理员检查 Access 配置。
            </p>
          )}
        </SectionCard>

        <SectionCard title="代理链路">
          <div className="space-y-2.5">
            <KeyValueRow label="后端">
              {provider === "nano" ? "nano(自建)" : "GLM(智谱)"}
            </KeyValueRow>
            <KeyValueRow label="状态">
              {healthQuery.isPending ? (
                <StatusBadge tint="tint-neutral">检测中</StatusBadge>
              ) : healthQuery.isError ? (
                <StatusBadge tint="tint-negative">异常</StatusBadge>
              ) : (
                <StatusBadge tint="tint-positive">正常</StatusBadge>
              )}
            </KeyValueRow>
            {healthQuery.isError ? (
              <p className="text-destructive text-xs break-all">{(healthQuery.error as Error).message}</p>
            ) : null}
            <Separator />
            <KeyValueRow label="浏览器 → worker">
              <span className="font-mono text-xs">{provider === "nano" ? "/nano/*" : "/glm/*"}</span>
            </KeyValueRow>
            <KeyValueRow label={provider === "nano" ? "worker → nano" : "worker → GLM"}>
              <span className="font-mono text-xs break-all">
                {provider === "nano" ? "NANO_API_BASE(worker 环境配置)" : GLM_API_BASE}
              </span>
            </KeyValueRow>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
