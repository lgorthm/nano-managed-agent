/**
 * File 资源类型。见 references/api/{upload-file,list-files,get-file}.md、
 * {download-file,delete-file}.md。上传供 Session/Deployment 挂载的托管文件;
 * 文件是独立资源,不随会话删除。
 */

export interface FileScope {
  type: 'session';
  /** 归属的 Session ID(sess_ 前缀) */
  id: string;
}

/** 注意与 DOM 的 File 重名:统一用 ManagedFile 指代 */
export interface ManagedFile {
  type: 'file';
  id: string;
  size_bytes: number;
  created_at: string;
  filename: string;
  mime_type: string;
  /** false 时下载接口返回错误(如平台生成的中间产物) */
  downloadable: boolean;
  scope?: FileScope;
}

/** ManagedFilePage:游标就是资源 ID 本身(before_id / after_id),不是 opaque page */
export interface ManagedFilePage {
  data: ManagedFile[];
  has_more: boolean;
  first_id?: string;
  last_id?: string;
}

export interface FileListQuery {
  /** 每页数量,1–1000,默认 20 */
  limit?: number;
  /** 返回此 File 之前的一页(向前翻页) */
  before_id?: string;
  /** 返回此 File 之后的一页(向后翻页) */
  after_id?: string;
  /** 按 Session scope 过滤,必须为 sess_ 前缀 */
  scope_id?: string;
}

export interface FileDeleted {
  id: string;
  type: 'file_deleted';
}
