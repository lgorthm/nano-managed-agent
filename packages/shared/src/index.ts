/**
 * @nano/shared — API 类型与 schema 的唯一来源。
 * 资源协议按目录组织:api/ 放与资源无关的协议设施,agent/ 等放各资源的定义。
 */
export * from "./api/error";
export * from "./api/pagination";
export * from "./agent/schemas";
export * from "./agent/normalize";
export * from "./agent/merge";
export * from "./skill/schemas";
export * from "./skill/tree";
export * from "./skill/frontmatter";
export * from "./file/schemas";
export * from "./environment/schemas";
export * from "./environment/normalize";
export * from "./environment/merge";
export * from "./session/schemas";
export * from "./session/events";
export * from "./session/context";
export * from "./session/tools";
export * from "./session/resolve";
export * from "./session/mount-path";

export const API_VERSION = "v1";
