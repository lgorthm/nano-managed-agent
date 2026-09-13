/** mock 模型上游的共享类型(node 侧 server 与 workerd 侧 client 都引用) */

export interface MockModelChunk {
  content?: string;
  reasoning_content?: string;
  /** 下发本块前的延迟(中断 / 恢复类用例的时序控制) */
  delayMs?: number;
}

export interface MockModelScript {
  /**
   * 匹配标记:请求体 JSON 字符串包含该子串时本脚本才被消费,不匹配的留在
   * 队列——即使测试文件并行执行,脚本也不会被其他文件的请求抢占。
   * 自定义脚本务必携带;缺省脚本(队列无匹配时)由 server 内置。
   */
  match?: string;
  /** 非 2xx:直接返回 JSON 错误体(不流式) */
  status?: number;
  chunks: MockModelChunk[];
  usage?: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number };
  /** 建立连接后不下发任何块(模拟流挂起) */
  hang?: boolean;
}

/** mock 上游捕获的模型请求(上下文装配与凭据断言用) */
export interface CapturedModelRequest {
  url: string;
  authorization: string;
  body: {
    model: string;
    messages: Array<{ role: string; content: unknown }>;
    stream: boolean;
    stream_options?: unknown;
  };
}
