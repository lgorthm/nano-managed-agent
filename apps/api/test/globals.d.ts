/** vitest 的 import.meta.glob 在 workers 测试环境中的最小声明(仅测试用) */
interface ImportMeta {
  glob(
    pattern: string,
    options?: { query?: string; import?: string; eager?: boolean },
  ): Record<string, unknown>;
}
