// Copyright (c) 2026 a7garden. MIT; see LICENSE.
import type { Extension } from '@codemirror/state';

export interface MarkdownInlinePreviewConfig {
  onLinkClick?: (url: string) => void;
}

export declare function markdownInlinePreview(config?: MarkdownInlinePreviewConfig): Extension;
