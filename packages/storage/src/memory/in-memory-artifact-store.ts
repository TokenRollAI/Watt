/**
 * ArtifactStore 的内存实现。内容不可变：同 id 重复 put 抛 conflict。
 * 内容做拷贝存储，防止调用方持有的 Uint8Array 被后续改动影响已存内容。
 */
import { conflict, notFound } from '../errors.js';
import type {
  Artifact,
  ArtifactMeta,
  ArtifactStore,
  PutArtifactInput,
} from '../artifact-store.js';
import { assertArtifactId } from '../artifact-store.js';

interface Cell {
  meta: ArtifactMeta;
  content: Uint8Array;
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly items = new Map<string, Cell>();

  async put(input: PutArtifactInput): Promise<ArtifactMeta> {
    const artifactId = assertArtifactId(input.artifactId);
    if (this.items.has(artifactId)) {
      throw conflict(`artifact already exists (immutable): ${artifactId}`);
    }
    const content = input.content.slice();
    const meta: ArtifactMeta = {
      artifactId,
      name: input.name,
      kind: input.kind,
      sizeBytes: content.byteLength,
      ...(input.url ? { url: input.url } : {}),
      createdAt: new Date().toISOString(),
    };
    this.items.set(artifactId, { meta, content });
    return { ...meta };
  }

  private cell(artifactId: string): Cell {
    const id = assertArtifactId(artifactId);
    const cell = this.items.get(id);
    if (!cell) throw notFound(`artifact not found: ${id}`);
    return cell;
  }

  async get(artifactId: string): Promise<Artifact> {
    const cell = this.cell(artifactId);
    return { meta: { ...cell.meta }, content: cell.content.slice() };
  }

  async head(artifactId: string): Promise<ArtifactMeta> {
    return { ...this.cell(artifactId).meta };
  }
}
