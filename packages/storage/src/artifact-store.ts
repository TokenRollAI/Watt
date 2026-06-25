/**
 * ArtifactStore：运行产物的内容与元数据（docs/architecture.md「Artifact Store」）。
 * Cloudflare 映射为 R2，本接口平台无关。
 *
 * 窄到 put / get / list：
 * - put 用调用方提供的 ArtifactId（由 newArtifactId 派生，校验前缀），重复 put
 *   同 id 抛 conflict（artifact 内容不可变；要新内容用新 id）。
 * - 内容以字节串（Uint8Array）承载，元数据携带 name / kind / 可选 url。
 */
import { ArtifactId } from '@watt/protocol';

export interface ArtifactMeta {
  artifactId: string;
  name: string;
  /** 产物类型，如 'markdown' / 'patch' / 'log' */
  kind: string;
  /** 字节大小（= content.byteLength），存一份便于不取内容即可知大小 */
  sizeBytes: number;
  /** 外部可访问 URL（R2 公开链接等），可选 */
  url?: string;
  createdAt: string;
}

export interface PutArtifactInput {
  artifactId: string;
  name: string;
  kind: string;
  content: Uint8Array;
  url?: string;
}

export interface Artifact {
  meta: ArtifactMeta;
  content: Uint8Array;
}

export interface ArtifactStore {
  /** 写入 artifact。artifactId 必须通过校验；重复同 id 抛 conflict。 */
  put(input: PutArtifactInput): Promise<ArtifactMeta>;
  /** 取内容 + 元数据。缺失抛 not_found。 */
  get(artifactId: string): Promise<Artifact>;
  /** 取元数据（不含内容）。缺失抛 not_found。 */
  head(artifactId: string): Promise<ArtifactMeta>;
}

export const assertArtifactId = (id: string): string => ArtifactId.parse(id);
