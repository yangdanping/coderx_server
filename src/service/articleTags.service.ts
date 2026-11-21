import type { TagService } from './tag/tag.service.js';

export async function resolveArticleTags(tags: Iterable<unknown>, tagService: Pick<TagService, 'getTagByName' | 'addTag'>) {
  const resolved = [];
  for (const name of tags) {
    const existing = await tagService.getTagByName(name);
    const id = existing ? existing.id : (await tagService.addTag(name)).insertId;
    resolved.push({ name, id });
  }
  return resolved;
}
