/** 保留事件的完整内容。未知内容块仍展示原始数据，避免详情悄悄丢失载荷。 */
export function getEventContent(event: Record<string, unknown>): unknown {
  return (
    event.content ?? event.text ?? event.message ?? event.thinking ?? event.output ?? event.result
  );
}

export function InspectorEmpty({ children }: { children: string }) {
  return <p className="trace-inspector-empty">{children}</p>;
}

export function InspectorJson({ value }: { value: unknown }) {
  if (value === undefined || value === null) {
    return <InspectorEmpty>此事件未提供数据。</InspectorEmpty>;
  }

  if (typeof value === 'string') return <pre className="trace-inspector-code">{value}</pre>;

  const source = JSON.stringify(value, null, 2);
  return source === undefined ? (
    <InspectorEmpty>此事件未提供可序列化的 JSON 数据。</InspectorEmpty>
  ) : (
    <JsonCode source={source} />
  );
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function ContentBlock({ block, index }: { block: unknown; index: number }) {
  const value = asObject(block);
  if (!value) return <TraceContent value={block} />;

  if (typeof value.text === 'string') {
    return <p className="trace-inspector-text">{value.text}</p>;
  }

  const source = asObject(value.source);
  if (value.type === 'image' && source) {
    const { type, media_type: mediaType, data, url } = source;
    const imageUrl =
      type === 'base64' &&
      typeof mediaType === 'string' &&
      IMAGE_MEDIA_TYPES.has(mediaType) &&
      typeof data === 'string'
        ? `data:${mediaType};base64,${data}`
        : type === 'url' && typeof url === 'string' && /^https?:\/\//.test(url)
          ? url
          : undefined;

    if (imageUrl) {
      return (
        <img
          className="trace-inspector-image"
          src={imageUrl}
          alt={typeof value.alt === 'string' ? value.alt : `图片内容 ${index + 1}`}
        />
      );
    }
  }

  if (value.type === 'document' && source) {
    const text = source.text ?? source.data;
    if (source.type === 'text' && typeof text === 'string') {
      return (
        <div className="trace-inspector-document">
          {typeof value.title === 'string' ? <h4>{value.title}</h4> : null}
          {typeof value.context === 'string' ? (
            <p className="trace-inspector-text">{value.context}</p>
          ) : null}
          <p className="trace-inspector-text">{text}</p>
        </div>
      );
    }
  }

  return <InspectorJson value={block} />;
}

export function TraceContent({
  value,
  emptyMessage = '此事件没有可预览的内容。',
}: {
  value: unknown;
  emptyMessage?: string;
}) {
  if (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  ) {
    return <InspectorEmpty>{emptyMessage}</InspectorEmpty>;
  }

  if (typeof value === 'string') {
    return <p className="trace-inspector-text">{value}</p>;
  }

  if (Array.isArray(value)) {
    return (
      <div className="trace-inspector-content">
        {value.map((block, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 内容块没有独立身份，组件无本地状态，数组顺序由事件协议固定。
          <ContentBlock key={index} block={block} index={index} />
        ))}
      </div>
    );
  }

  return <InspectorJson value={value} />;
}

import { JsonCode } from './json-code';
