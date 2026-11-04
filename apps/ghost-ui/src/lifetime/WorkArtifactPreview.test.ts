import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { artifactSource, readVerifiedWorkArtifact } from './WorkArtifactPreview';
import type { Artifact, Response, Work } from './types';

const work: Pick<Work, 'id' | 'goal_id' | 'goal_revision' | 'execution_id'> = {
  id: 'work-1', goal_id: 'goal-1', goal_revision: 3, execution_id: 'attempt-1',
};
const original = '\ufeff# 결과\r\n<script>untouched source</script>\r\n';
const raw = Buffer.from(original);
const artifact: Artifact = {
  digest: createHash('sha256').update(raw).digest('hex'),
  locator: 'immutable/result.md', privacy: 'local_only', producing_attempt: work.execution_id!,
};

function verifiedResponse(dataOverrides: Record<string, unknown> = {}, responseOverrides: Partial<Response> = {}): Response {
  return {
    status: 'success', summary: 'verified', object_refs: [work.id, work.goal_id], artifacts: [artifact],
    next_actions: [], error_code: null, retry_class: 'same_id',
    data: { work_id: work.id, goal_revision: work.goal_revision, execution_id: work.execution_id,
      digest: artifact.digest, privacy: artifact.privacy, byte_length: raw.length, encoding: 'base64',
      data: raw.toString('base64'), ...dataOverrides },
    ...responseOverrides,
  };
}

describe('work artifact integrity', () => {
  it('requests the exact bound artifact and preserves original bytes with the Pi response shape', async () => {
    const request = vi.fn().mockResolvedValue(verifiedResponse());
    const bytes = await readVerifiedWorkArtifact({ request }, work, artifact);
    expect(request).toHaveBeenCalledExactlyOnceWith({
      method: 'work.artifact', work_id: work.id, execution_id: work.execution_id,
      digest: artifact.digest, locator: artifact.locator,
    });
    expect(Buffer.from(bytes)).toEqual(raw);
    expect(artifactSource(bytes)).toBe(original);
  });

  it('does not send a request for a different execution', async () => {
    const request = vi.fn();
    await expect(readVerifiedWorkArtifact({ request }, { ...work, execution_id: 'stale' }, artifact)).rejects.toThrow('확인하지 못했습니다');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects incorrect work, goal, revision, locator and privacy claims', async () => {
    const replies = [
      verifiedResponse({ work_id: 'other-work' }),
      verifiedResponse({ execution_id: 'stale' }),
      verifiedResponse({ goal_revision: work.goal_revision + 1 }),
      verifiedResponse({ goal_id: 'other-goal' }),
      verifiedResponse({}, { object_refs: [work.id, 'other-goal'] }),
      verifiedResponse({}, { artifacts: [{ ...artifact, locator: 'other/path.md' }] }),
      verifiedResponse({ privacy: 'public' }),
    ];
    for (const reply of replies) {
      const request = vi.fn().mockResolvedValue(reply);
      await expect(readVerifiedWorkArtifact({ request }, work, artifact)).rejects.toThrow('확인하지 못했습니다');
    }
  });

  it('rejects noncanonical base64, an incorrect byte count and same-size tampering', async () => {
    const tampered = Buffer.from(raw);
    tampered[0] ^= 0x01;
    for (const fields of [
      { data: raw.toString('base64') + ' ' },
      { byte_length: raw.length - 1 },
      { byte_length: 1_048_577 },
      { data: tampered.toString('base64') },
    ]) {
      const request = vi.fn().mockResolvedValue(verifiedResponse(fields));
      await expect(readVerifiedWorkArtifact({ request }, work, artifact)).rejects.toThrow('확인하지 못했습니다');
    }
  });

  it('reports a Host denial and treats invalid UTF-8 or NUL as binary', async () => {
    const request = vi.fn().mockResolvedValue(verifiedResponse({}, { status: 'error', summary: 'stale artifact' }));
    await expect(readVerifiedWorkArtifact({ request }, work, artifact)).rejects.toThrow('stale artifact');
    expect(artifactSource(Uint8Array.of(0xff))).toBeNull();
    expect(artifactSource(Uint8Array.of(0x00))).toBeNull();
  });
});
