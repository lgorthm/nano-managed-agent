import { useQueryClient } from '@tanstack/react-query';
import { Server } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { type ApiProvider, setProvider, useProvider } from '@/lib/provider';

const PROVIDER_OPTIONS: { value: ApiProvider; label: string }[] = [
  { value: 'nano', label: 'nano API' },
  { value: 'glm', label: 'GLM API' },
];

/** sidebar 底部的后端切换;查询缓存没有 provider 维度,切换后全部置为失效重取 */
export function ProviderSelect() {
  const provider = useProvider();
  const queryClient = useQueryClient();
  return (
    <Select
      value={provider}
      onValueChange={(value) => {
        setProvider(value as ApiProvider);
        // 不用 clear():移除缓存不会重取已挂载的查询,页面会残留旧后端数据
        void queryClient.invalidateQueries();
      }}
    >
      <SelectTrigger size="sm" className="bg-card w-full" aria-label="切换后端 API">
        <Server className="text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" className="w-[var(--radix-select-trigger-width)] min-w-0">
        {PROVIDER_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
