import type { PersistedEvent, Session, StreamEvent } from '@nano/shared/glm';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { LedgerRecord } from '@/lib/session-ledger';
import { TraceLabel } from '../components/trace-label';
import { getTraceRequestOptions } from '../data/trace-view-model';
import {
  InspectorTiming,
  MessageOverview,
  MessageSource,
  RequestOverview,
  RequestUsage,
  ToolOverview,
  ToolSchema,
} from './inspector-details';
import { getEventContent, InspectorEmpty, InspectorJson, TraceContent } from './trace-content';

interface TraceInspectorProps {
  record: LedgerRecord;
  events: readonly (PersistedEvent | StreamEvent)[];
  session: Session;
  onClose: () => void;
}

const MESSAGE_TABS = [
  ['overview', '概述'],
  ['preview', '预览'],
  ['raw', '原始内容'],
  ['source', '来源'],
] as const;

const TOOL_TABS = [
  ['overview', '概述'],
  ['input', '参数'],
  ['result', '结果'],
  ['schema', 'Schema'],
  ['timing', '计时'],
] as const;

const REQUEST_TABS = [
  ['overview', '概述'],
  ['options', '选项'],
  ['usage', '用量'],
  ['timing', '计时'],
] as const;

const TOOL_RESULT_TYPES = new Set([
  'agent.tool_result',
  'agent.mcp_tool_result',
  'user.tool_result',
  'user.custom_tool_result',
]);

/** 工具调用与结果使用协议中的 tool_use_id 配对，孤立结果使用自身载荷。 */
function findToolResult({ record, events }: Pick<TraceInspectorProps, 'record' | 'events'>) {
  if (TOOL_RESULT_TYPES.has(String(record.raw.type))) return record.raw;
  return events.find(
    (event) => TOOL_RESULT_TYPES.has(String(event.type)) && event.tool_use_id === record.key,
  );
}

function MessagePanels({ record }: { record: LedgerRecord }) {
  return (
    <>
      <TabsContent value="overview" className="trace-inspector-body">
        <MessageOverview record={record} />
      </TabsContent>
      <TabsContent value="preview" className="trace-inspector-body">
        <TraceContent value={getEventContent(record.raw)} />
      </TabsContent>
      <TabsContent value="raw" className="trace-inspector-body">
        <InspectorJson value={record.raw} />
      </TabsContent>
      <TabsContent value="source" className="trace-inspector-body">
        <MessageSource record={record} />
      </TabsContent>
    </>
  );
}

function ToolPanels({ record, events, session }: Omit<TraceInspectorProps, 'onClose'>) {
  const result = findToolResult({ record, events });
  return (
    <>
      <TabsContent value="overview" className="trace-inspector-body">
        <ToolOverview record={record} result={result} />
      </TabsContent>
      <TabsContent value="input" className="trace-inspector-body">
        <InspectorJson value={record.raw.input} />
      </TabsContent>
      <TabsContent value="result" className="trace-inspector-body">
        <TraceContent
          value={result ? getEventContent(result) : undefined}
          emptyMessage="尚未收到工具结果。"
        />
      </TabsContent>
      <TabsContent value="schema" className="trace-inspector-body">
        <ToolSchema record={record} session={session} />
      </TabsContent>
      <TabsContent value="timing" className="trace-inspector-body">
        <InspectorTiming record={record} />
      </TabsContent>
    </>
  );
}

function RequestPanels({ record, session }: Pick<TraceInspectorProps, 'record' | 'session'>) {
  const options = getTraceRequestOptions(record);
  return (
    <>
      <TabsContent value="overview" className="trace-inspector-body">
        <RequestOverview record={record} />
      </TabsContent>
      <TabsContent value="options" className="trace-inspector-body">
        {options === undefined || options === null ? (
          <InspectorEmpty>此请求事件未提供请求选项。</InspectorEmpty>
        ) : (
          <InspectorJson value={options} />
        )}
      </TabsContent>
      <TabsContent value="usage" className="trace-inspector-body">
        <RequestUsage record={record} session={session} />
      </TabsContent>
      <TabsContent value="timing" className="trace-inspector-body">
        <InspectorTiming record={record} />
      </TabsContent>
    </>
  );
}

function RecordInspector({ record, events, session, onClose }: TraceInspectorProps) {
  const tabs =
    record.kind === 'tool' ? TOOL_TABS : record.kind === 'span' ? REQUEST_TABS : MESSAGE_TABS;

  return (
    <aside className="trace-inspector" aria-label="轨迹详情">
      <div className="trace-inspector-header">
        <TraceLabel record={record} />
        <span className="trace-inspector-position">
          第 {record.turn} 轮{record.step > 0 ? ` · 第 ${record.step} 步` : ''}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="trace-inspector-close"
          aria-label="关闭轨迹详情"
          onClick={onClose}
        >
          <X data-icon="inline-start" aria-hidden />
        </Button>
      </div>
      <Tabs defaultValue="overview" className="trace-inspector-tabs">
        <TabsList className="trace-inspector-tab-list" aria-label="详情分类">
          {tabs.map(([value, label]) => (
            <TabsTrigger className="trace-inspector-tab" key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {record.kind === 'tool' ? (
          <ToolPanels record={record} events={events} session={session} />
        ) : record.kind === 'span' ? (
          <RequestPanels record={record} session={session} />
        ) : (
          <MessagePanels record={record} />
        )}
      </Tabs>
    </aside>
  );
}

/** 身份变化时重置详情标签页；同一条实时记录更新时保留用户正在查看的标签页。 */
export function TraceInspector(props: TraceInspectorProps) {
  return <RecordInspector key={props.record.key} {...props} />;
}
