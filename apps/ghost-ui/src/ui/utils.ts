import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Named text sizes must not be merged with independent text colors.
const merge = extendTailwindMerge({ extend: { theme: { text: ['micro', 'caption', 'ui', 'body', 'bodyLg', 'headingSm', 'heading', 'headingLg', 'mono'] } } });
export function cn(...inputs: ClassValue[]) { return merge(clsx(inputs)); }
